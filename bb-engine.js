/**
 * BB Engine — 孙总布林带策略引擎 (独立版)
 * 
 * 核心策略：
 *   1. 50强流动性选币 + 浮盈±≤1% + 同时5个币种
 *   2. 5min布林带开仓，收盘价判定
 *   3. 插针过滤：只用收盘价，单K>3%作废，插针回归不执行
 *   4. 开仓准入(双路径): 趋势启动开仓(EMA早期+ADX上升+放量) | BB轨道开仓(带宽<85%+2根收窄+触轨)
 *   5. 分模式止盈: 轨道仓1.5%触发中轨止盈 | 趋势仓2.5%触发移动止盈+反向轨道兜底
 *   6. 补仓: 收口后间隔3根K线，40%/20% 两次（趋势仓/孤儿仓不补仓）
 *   7. 单K线价格变动≥3%全仓止损（不含杠杆，过滤正常波动）
 *   8. 总浮亏≥15%终极止损全平（对所有仓位生效，不要求补完）
 *   9. 特殊时间禁交易：资金费率前15min / 交割前1h / 布林带开口期间
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ════════════════════════════════════════
//  配置
// ════════════════════════════════════════
const CONFIG = {
  // 交易参数
  symbols: [],              // 运行时动态选币
  maxPositions: 5,          // 基础仓位数（运行时按资金量动态调整）
  topN: 50,                 // 前50强流动性
  floatProfitPct: 1.0,      // 浮盈±≤1%
  leverage: 3,              // 默认杠杆
  perPositionPct: 0.15,    // 单仓位占总资金15%（基础值）
  
  // v128: 资金分级仓位 — 余额多开7仓, 余额少开5仓
  //   < $200 → 5仓 (趋势3 + BB2), 单仓8-15%
  //   ≥ $200 → 7仓 (趋势4 + BB3), 单仓6-12%
  //   ≥ $500 → 7仓 (趋势4 + BB3), 单仓6-11%
  positionTiers: [
    { minBalance: 0,   maxPositions: 5, trendMax: 3, bbMax: 2, highVolPct: 0.08, midVolPct: 0.12, lowVolPct: 0.15 },
    { minBalance: 200, maxPositions: 7, trendMax: 4, bbMax: 3, highVolPct: 0.07, midVolPct: 0.10, lowVolPct: 0.12 },
    { minBalance: 500, maxPositions: 7, trendMax: 4, bbMax: 3, highVolPct: 0.06, midVolPct: 0.09, lowVolPct: 0.11 },
  ],
  
  // v122: 交易对黑名单 — 这些币种永不选入持仓
  // BANKUSDT: 2026-07-17 触发 3 次终极止损，单笔亏损 -$150+，拉入黑名单
  // v124 (2026-07-18): 加入 SymbolEngine 管理的所有合约品种，彻底隔离 BB 和其他引擎
  //   原因：SymbolEngine 用管理员 .env 的 Binance key 在同一账户开合约仓 (TSLAUSDT/NVDAUSDT/...)
  //   BB _syncPositions() 把这些仓当「孤儿仓位」接管，用 BB 轨道止盈逻辑去管这些非 BB 选的币
  //   结果：管理员 BB 历史里混入大量 TSLAUSDT/NVDAUSDT/AAPLUSDT/MSFTUSDT/METAUSDT/GOOGLUSDT/QQQUSDT
  //         /COPPERUSDT/NATGASUSDT/XAGUSDT/XAUUSDT/URNMUSDT/UVXYUSDT，ONDOUSDT 一笔亏损 -$115
  //   修复：把这些品种全部拉入黑名单，BB 永不接管、永不交易、永不补仓
  blacklist: [
    'BANKUSDT',   // 单笔巨亏 -$150（3次终极止损）
    'BTCUSDT',    // 波动率低，盈利空间小
    'BNBUSDT',    // 波动率低，盈利空间小
    // ── SymbolEngine 股票/ETF 合约（PERP） ──
    'TSLAUSDT', 'NVDAUSDT', 'AAPLUSDT', 'METAUSDT', 'MSFTUSDT',
    'GOOGLUSDT', 'SPYUSDT', 'QQQUSDT',
    // ── SymbolEngine 商品合约 ──
    'XAGUSDT', 'XAUUSDT', 'COPPERUSDT', 'NATGASUSDT',
    // ── SymbolEngine 债券合约 ──
    'UVXYUSDT', 'URNMUSDT',
  ],
  
  // v124: 允许 BB 接管的「白名单」前缀 — 只接管纯加密合约品种
  //   SymbolEngine 的股票/ETF/商品合约全部不在白名单里，即使新加品种也不会被误接管
  //   空数组 = 不启用白名单（退回 blacklist 模式）；非空 = 启用白名单
  orphanAllowPrefixes: [
    '*', // v126: 接管所有Binance持仓，不让任何仓位失去止盈止损保护
  ],
  
  // K线参数
  klineInterval: '5m',
  klineLimit: 200,           // 拉取200根5min K线
  bbPeriod: 20,              // 布林带周期20
  bbStd: 2.0,                // 2倍标准差
  
  // 开仓准入
  bandwidthPercentileLookback: 100,  // 100根K线带宽分位
  bandwidthOpenBlock: 90,             // >90%禁开
  bandwidthOpenAllow: 85,             // <85%解禁
  narrowCount: 2,                     // v128: 连续2根收窄（从3减为2，增加BB开仓机会）
  
  // 止盈
  profitTriggerPct: 1.5,    // v126: 浮盈≥1.5%触发止盈（轨道仓）
  trendProfitTriggerPct: 2.5, // v128: 趋势仓浮盈≥2.5%才触发（让利润跑）
  volumeSpikeRatio: 1.8,     // 放量倍数>1.8
  volumeMaPeriod: 20,        // 20周期均量
  atrPeriod: 14,             // ATR周期
  atrTrailMultiplier: 0.5,  // v126: 0.3→0.5 ATR跟踪（锁利更快）
  
  // v126: ADX趋势强度门槛
  adxThreshold: 20,          // v126: ADX>20才开仓（从25降低，增加开仓机会）
  
  // v126: ATR动态止损
  atrStopMultiplier: 1.5,    // 亏1.5ATR止损
  
  // 补仓 (v128: 从3次减为2次，降低风险放大)
  maxReplenish: 2,           // v128: 最多补2次（从3次减少）
  replenishInterval: 3,      // 收口后间隔3根K线
  replenishRatios: [0.40, 0.20], // v128: 40% 20%（从50/30/20减少）
  
  // 止损
  singleKLossPct: 3,        // v128: 单K价格变动≥3%止损（不含杠杆，原始价格波动）
  ultimateLossPct: 15,       // v128: 总浮亏≥15%终极止损（对所有仓位生效）
  
  // v126: ATR 波动率最低门槛 — 排除低波动币
  minAtrPct: 0.10,          // ATR/价格 < 0.10% 不开仓
  
  // 特殊时间
  fundingPauseMin: 15,      // 资金费率前15分钟暂停
  deliveryPauseMin: 60,     // 交割前1小时暂停
  
  // 运行
  scanIntervalMs: 30000,    // 30秒扫描一次
  stateFile: path.join(__dirname, 'data', 'bb-engine-state.json'),
  logFile: path.join(__dirname, 'logs', 'bb-engine.log'),
};

// ════════════════════════════════════════
//  Binance API 封装
// ════════════════════════════════════════
class BinanceAPI {
  constructor(apiKey, apiSecret) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseURL = 'https://fapi.binance.com';
  }

  _sign(queryString) {
    return crypto.createHmac('sha256', this.apiSecret).update(queryString).digest('hex');
  }

  _request(method, endpoint, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.apiKey || !this.apiSecret) {
        reject(new Error('No API key/secret'));
        return;
      }
      const timestamp = Date.now();
      const allParams = { ...params, timestamp, recvWindow: 10000 };
      const queryString = Object.entries(allParams)
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
      const signature = this._sign(queryString);
      const url = `${this.baseURL}${endpoint}?${queryString}&signature=${signature}`;

      const req = https.request(url, {
        method,
        headers: { 'X-MBX-APIKEY': this.apiKey },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.code) {
              reject(new Error(`Binance API Error ${result.code}: ${result.msg}`));
            } else {
              resolve(result);
            }
          } catch (e) {
            reject(new Error(`JSON parse error: ${data.substring(0, 200)}`));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('Timeout')));
      req.end();
    });
  }

  _get(endpoint) {
    return new Promise((resolve, reject) => {
      const url = `${this.baseURL}${endpoint}`;
      const req = https.get(url, { timeout: 10000 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`Parse error: ${data.substring(0, 100)}`)); }
        });
      });
      // 修复：处理 timeout 事件，超时后中断请求
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      req.on('error', reject);
    });
  }

  // 获取24h行情统计（用于选币排名）
  async getAllTickers() {
    return this._get('/fapi/v1/ticker/24hr');
  }

  // 获取K线
  async getKlines(symbol, interval, limit) {
    const data = await this._get(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    return data.map(k => ({
      time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  }

  // 获取资金费率
  async getFundingRate(symbol) {
    return this._get(`/fapi/v1/fundingRate?symbol=${symbol}&limit=1`);
  }

  // 获取下一次资金费率时间
  async getFundingInfo(symbol) {
    const info = await this._get(`/fapi/v1/premiumIndex?symbol=${symbol}`);
    return {
      nextFundingTime: info.nextFundingTime,
      lastFundingRate: parseFloat(info.lastFundingRate),
    };
  }

  // ═══ SAPI 请求（现货/转账/提现）═══
  async _sapiRequest(method, endpoint, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.apiKey || !this.apiSecret) {
        reject(new Error('No API key/secret'));
        return;
      }
      const allParams = { timestamp: Date.now(), recvWindow: 10000, ...params };
      const query = Object.entries(allParams).map(([k,v]) => `${k}=${v}`).join('&');
      const signature = crypto.createHmac('sha256', this.apiSecret).update(query).digest('hex');
      const fullQuery = `${query}&signature=${signature}`;
      const url = new URL(`https://api.binance.com${endpoint}?${fullQuery}`);
      const reqOpts = {
        method,
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers: { 'X-MBX-APIKEY': this.apiKey },
        timeout: 15000,
      };
      const timer = setTimeout(() => reject(new Error('SAPI request timeout')), 20000);
      const req = https.request(reqOpts, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          clearTimeout(timer);
          try {
            const parsed = JSON.parse(data);
            if (parsed.code && parsed.code < 0) reject(new Error(JSON.stringify(parsed)));
            else resolve(parsed);
          } catch (e) { reject(new Error(`SAPI parse error: ${data.slice(0, 200)}`)); }
        });
      });
      req.on('error', e => { clearTimeout(timer); reject(e); });
      req.end();
    });
  }

  /**
   * 从用户合约账户转 USDT 到指定 BSC 地址
   * 流程: 合约钱包 → 现货钱包 (internal) → 提现到 BSC 地址
   */
  async transferFeeToWallet(amountUsdt, toAddress) {
    const results = { internal: null, withdraw: null };
    const fixedAmount = Math.floor(amountUsdt * 100) / 100; // 保留2位
    if (fixedAmount < 1) return { success: false, error: 'Amount < $1 minimum' };

    // Step 1: 合约钱包 → 现货钱包 (futures → spot)
    let internalOk = false;
    try {
      results.internal = await this._sapiRequest('POST', '/sapi/v1/asset/transfer', {
        type: 'MAIN_UMFUTURE',   // USDT-M Futures → Spot
        asset: 'USDT',
        amount: String(fixedAmount),
      });
      internalOk = true;
    } catch (e) {
      // internal transfer 失败，尝试直接 withdraw
    }

    // Step 2: 等待到账
    if (internalOk) await new Promise(r => setTimeout(r, 2000));

    // Step 3: 现货钱包 → 提现到 BSC 地址
    try {
      results.withdraw = await this._sapiRequest('POST', '/sapi/v1/capital/withdraw/apply', {
        coin: 'USDT',
        network: 'BSC',
        address: toAddress,
        amount: String(fixedAmount),
      });
      return { success: true, amount: fixedAmount, results };
    } catch (e) {
      return { success: false, error: `Withdraw failed: ${e.message}`, results };
    }
  }

  // 获取余额
  async getBalance() {
    const result = await this._request('GET', '/fapi/v2/balance');
    const usdt = result.find(b => b.asset === 'USDT');
    return usdt ? parseFloat(usdt.availableBalance || usdt.balance) : 0;
  }

  // 获取持仓
  async getPositions() {
    const result = await this._request('GET', '/fapi/v2/positionRisk');
    return result.filter(p => parseFloat(p.positionAmt) !== 0);
  }

  // 查询已实现盈亏（用于检测强平亏损）
  async getIncome(startTime, endTime, incomeType = 'REALIZED_PNL') {
    return this._request('GET', '/fapi/v1/income', { startTime, endTime, incomeType });
  }

  // 设置杠杆
  async setLeverage(symbol, leverage) {
    try {
      return await this._request('POST', '/fapi/v1/leverage', { symbol, leverage });
    } catch (e) { /* ignore */ }
  }

  // v126: 自动设置保证金模式 — 稳的币全仓，波动大的逐仓
  async setMarginType(symbol, atrPct) {
    // v126: 根据余额+波动率自动配置保证金模式
    // 小余额(<$100) → 强制逐仓，防连环强平
    // 大余额 + 低波动(ATR≤0.30%) → 全仓，共享保证金
    // 任何余额 + 高波动(ATR>0.30%) → 逐仓，隔离风险
    const balance = this.balance || 0;
    let marginType;
    if (balance < 100) {
      marginType = 'ISOLATED'; // 小余额强制逐仓
    } else {
      marginType = atrPct > 0.30 ? 'ISOLATED' : 'CROSSED';
    }
    try {
      await this._request('POST', '/fapi/v1/marginType', { symbol, marginType });
      this._log(`📐 ${symbol} 保证金模式: ${marginType === 'ISOLATED' ? '逐仓' : '全仓'} (ATR=${atrPct.toFixed(3)}% 余额=$${balance.toFixed(0)})`);
    } catch (e) {
      // -4048: 已经是该模式，或持仓中无法切换，忽略
      if (!String(e.message || e).includes('-4048')) { /* ignore other errors */ }
    }
  }

  // 获取交易对精度
  async getExchangeInfo() {
    const info = await this._get('/fapi/v1/exchangeInfo');
    const precisionMap = {};
    for (const s of info.symbols) {
      const stepSize = s.filters.find(f => f.filterType === 'LOT_SIZE')?.stepSize || '0.001';
      precisionMap[s.symbol] = { stepSize, qtyPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision };
    }
    return precisionMap;
  }

  _fixQty(symbol, qty, precisionMap) {
    const info = precisionMap[symbol];
    if (!info) return parseFloat(qty.toFixed(3));
    const step = parseFloat(info.stepSize);
    if (step > 0) {
      // 用字符串避免浮点精度溢出 (5.52/0.01=551.9999 → 5.51 的 bug)
      // v107: 修复浮点数精度问题
      const scaled = qty / step;
      const rounded = (Math.abs(scaled - Math.round(scaled)) < 1e-9 ? Math.round(scaled) : Math.floor(scaled)) * step;
      const p = info.qtyPrecision ?? 3;
      return parseFloat(rounded.toFixed(p));
    }
    const p = info.qtyPrecision || 3;
    return parseFloat(qty.toFixed(p));
  }

  // 市价开多
  async marketLong(symbol, qty, leverage, precisionMap, atrPct) {
    try {
      qty = this._fixQty(symbol, qty, precisionMap);
      if (!qty || qty <= 0) return { success: false, error: 'qty too small' };
      if (atrPct) await this.setMarginType(symbol, atrPct);
      await this.setLeverage(symbol, leverage);
      let result = await this._request('POST', '/fapi/v1/order', {
        symbol, side: 'BUY', type: 'MARKET', quantity: qty,
      });
      return { success: true, orderId: result.orderId, qty };
    } catch (e) {
      // -4061: 双向持仓模式 → 加 positionSide=LONG 重试
      if (String(e.message || e).includes('-4061')) {
        try {
          const result2 = await this._request('POST', '/fapi/v1/order', {
            symbol, side: 'BUY', type: 'MARKET', quantity: qty, positionSide: 'LONG',
          });
          return { success: true, orderId: result2.orderId, qty };
        } catch (e2) {
          return { success: false, error: e2.message };
        }
      }
      return { success: false, error: e.message };
    }
  }

  // 市价开空
  async marketShort(symbol, qty, leverage, precisionMap, atrPct) {
    try {
      qty = this._fixQty(symbol, qty, precisionMap);
      if (!qty || qty <= 0) return { success: false, error: 'qty too small' };
      if (atrPct) await this.setMarginType(symbol, atrPct);
      await this.setLeverage(symbol, leverage);
      let result = await this._request('POST', '/fapi/v1/order', {
        symbol, side: 'SELL', type: 'MARKET', quantity: qty,
      });
      return { success: true, orderId: result.orderId, qty };
    } catch (e) {
      // -4061: 双向持仓模式 → 加 positionSide=SHORT 重试
      if (String(e.message || e).includes('-4061')) {
        try {
          const result2 = await this._request('POST', '/fapi/v1/order', {
            symbol, side: 'SELL', type: 'MARKET', quantity: qty, positionSide: 'SHORT',
          });
          return { success: true, orderId: result2.orderId, qty };
        } catch (e2) {
          return { success: false, error: e2.message };
        }
      }
      return { success: false, error: e.message };
    }
  }

  // 平多
  async closeLong(symbol, qty, precisionMap) {
    qty = this._fixQty(symbol, qty, precisionMap);
    if (!qty || qty <= 0) return { success: false, error: 'qty too small' };
    try {
      const result = await this._request('POST', '/fapi/v1/order', {
        symbol, side: 'SELL', type: 'MARKET', quantity: qty, reduceOnly: 'true',
      });
      return { success: true, orderId: result.orderId };
    } catch (e) {
      // -4061: 双向持仓模式 → 加 positionSide=LONG 重试
      if (String(e.message || e).includes('-4061')) {
        try {
          const result2 = await this._request('POST', '/fapi/v1/order', {
            symbol, side: 'SELL', type: 'MARKET', quantity: qty, positionSide: 'LONG',
          });
          return { success: true, orderId: result2.orderId };
        } catch (e2) {
          return { success: false, error: e2.message };
        }
      }
      // 仓位可能已不存在
      return { success: false, error: e.message };
    }
  }

  // 平空
  async closeShort(symbol, qty, precisionMap) {
    qty = this._fixQty(symbol, qty, precisionMap);
    if (!qty || qty <= 0) return { success: false, error: 'qty too small' };
    try {
      const result = await this._request('POST', '/fapi/v1/order', {
        symbol, side: 'BUY', type: 'MARKET', quantity: qty, reduceOnly: 'true',
      });
      return { success: true, orderId: result.orderId };
    } catch (e) {
      // -4061: 双向持仓模式 → 加 positionSide=SHORT 重试
      if (String(e.message || e).includes('-4061')) {
        try {
          const result2 = await this._request('POST', '/fapi/v1/order', {
            symbol, side: 'BUY', type: 'MARKET', quantity: qty, positionSide: 'SHORT',
          });
          return { success: true, orderId: result2.orderId };
        } catch (e2) {
          return { success: false, error: e2.message };
        }
      }
      // 仓位可能已不存在
      return { success: false, error: e.message };
    }
  }
}

// ════════════════════════════════════════
//  技术指标计算
// ════════════════════════════════════════
class Indicators {
  // SMA
  static sma(values, period) {
    if (values.length < period) return null;
    const slice = values.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
  }

  // EMA（指数移动平均线）— 趋势过滤用
  static ema(klines, period = 20) {
    if (klines.length < period) return null;
    const closes = klines.map(k => k.close);
    const k = 2 / (period + 1);
    let ema = closes[0];
    for (let i = 1; i < closes.length; i++) {
      ema = closes[i] * k + ema * (1 - k);
    }
    return ema;
  }

  // v126: ADX 趋势强度指标
  static adx(klines, period = 14) {
    if (klines.length < period * 2) return 0;
    let plusDM = 0, minusDM = 0, tr = 0;
    for (let i = klines.length - period; i < klines.length; i++) {
      const up = klines[i].high - klines[i - 1].high;
      const down = klines[i - 1].low - klines[i].low;
      const high = klines[i].high;
      const low = klines[i].low;
      const prevClose = klines[i - 1].close;
      tr += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      if (up > down && up > 0) plusDM += up;
      else if (down > up && down > 0) minusDM += down;
    }
    if (tr === 0) return 0;
    const plusDI = plusDM / tr * 100;
    const minusDI = minusDM / tr * 100;
    const dx = Math.abs(plusDI - minusDI) / Math.max(plusDI + minusDI, 0.001) * 100;
    return dx;
  }

  // 标准差
  static std(values, period) {
    if (values.length < period) return 0;
    const slice = values.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    return Math.sqrt(variance);
  }

  // 布林带 (用收盘价)
  static bollinger(klines, period = 20, stdDev = 2.0) {
    if (klines.length < period) return null;
    const closes = klines.map(k => k.close);
    const mid = this.sma(closes, period);
    const sd = this.std(closes, period);
    const upper = mid + stdDev * sd;
    const lower = mid - stdDev * sd;
    const bandwidth = (upper - lower) / mid * 100; // 带宽百分比
    return { mid, upper, lower, bandwidth, std: sd };
  }

  // 布林带宽百分位 (100根历史)
  static bandwidthPercentile(klines, lookback = 100) {
    if (klines.length < lookback + 20) return null;
    const bandwidths = [];
    for (let i = klines.length - lookback; i < klines.length; i++) {
      if (i < 20) continue;
      const slice = klines.slice(0, i + 1);
      const bb = this.bollinger(slice, 20, 2.0);
      if (bb) bandwidths.push(bb.bandwidth);
    }
    if (bandwidths.length === 0) return null;
    const currentBB = this.bollinger(klines, 20, 2.0);
    if (!currentBB) return null;
    const currentBW = currentBB.bandwidth;
    let count = 0;
    for (const bw of bandwidths) {
      if (bw <= currentBW) count++;
    }
    return (count / bandwidths.length) * 100; // 0-100
  }

  // ATR
  static atr(klines, period = 14) {
    if (klines.length < period + 1) return 0;
    const trs = [];
    for (let i = 1; i < klines.length; i++) {
      const k = klines[i];
      const prev = klines[i - 1];
      const tr = Math.max(
        k.high - k.low,
        Math.abs(k.high - prev.close),
        Math.abs(k.low - prev.close)
      );
      trs.push(tr);
    }
    const slice = trs.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
  }

  // 成交量均线
  static volumeMA(klines, period = 20) {
    if (klines.length < period) return 0;
    const slice = klines.slice(-period);
    return slice.reduce((a, b) => a + b.volume, 0) / period;
  }

  // 判断连续3根布林带收窄
  static isNarrowing(klines, count = 3) {
    if (klines.length < 20 + count) return false;
    const bandwidths = [];
    for (let i = klines.length - count; i < klines.length; i++) {
      const slice = klines.slice(0, i + 1);
      const bb = this.bollinger(slice, 20, 2.0);
      if (bb) bandwidths.push(bb.bandwidth);
    }
    if (bandwidths.length < count) return false;
    // 每根都比前一根窄
    for (let i = 1; i < bandwidths.length; i++) {
      if (bandwidths[i] >= bandwidths[i - 1]) return false;
    }
    return true;
  }

  // 判断布林带是否在收口 (最新带宽 < 上一根)
  static isContracting(klines) {
    if (klines.length < 22) return false;
    const currentBB = this.bollinger(klines, 20, 2.0);
    const prevBB = this.bollinger(klines.slice(0, -1), 20, 2.0);
    if (!currentBB || !prevBB) return false;
    return currentBB.bandwidth < prevBB.bandwidth;
  }

  // 判断布林带是否在开口 (最新带宽 > 上一根)
  static isExpanding(klines) {
    if (klines.length < 22) return false;
    const currentBB = this.bollinger(klines, 20, 2.0);
    const prevBB = this.bollinger(klines.slice(0, -1), 20, 2.0);
    if (!currentBB || !prevBB) return false;
    return currentBB.bandwidth > prevBB.bandwidth;
  }
}

// ════════════════════════════════════════
//  BB Engine 主引擎
// ════════════════════════════════════════
class BBEngine {
  constructor(apiKey, apiSecret) {
    this.api = new BinanceAPI(apiKey, apiSecret);
    this.positions = {};        // { symbol: { side, qty, entryPrice, margin, replenishCount, lastNarrowTime, klinesSinceNarrow, mode: '轨道'|'ATR', atrTrailPrice, peakProfit } }
    this.precisionMap = null;
    this.balance = 0;
    this.tickers = [];
    this.running = false;
    this.wallet = null;       // 钱包地址（UserBBEngine设置，用于算力费判断）
    this._feeState = null;   // 算力费状态
  }

  // v128: 根据余额获取当前资金档位
  getPositionTier() {
    const tiers = CONFIG.positionTiers;
    let tier = tiers[0]; // 默认最低档
    for (const t of tiers) {
      if (this.balance >= t.minBalance) tier = t;
    }
    return tier;
  }

  // v128: 获取趋势仓最大数量
  getTrendMax() {
    return this.getPositionTier().trendMax;
  }

  // v128: 获取BB仓最大数量
  getBbMax() {
    return this.getPositionTier().bbMax;
  }

  // v128: 统计当前趋势仓和BB仓数量
  countPositionsByMode() {
    let trend = 0, bb = 0;
    for (const s in this.positions) {
      if (this.positions[s].mode === '趋势') trend++;
      else bb++;
    }
    return { trend, bb, total: trend + bb };
  }

  // v128: 获取动态最大仓位
  getDynamicMaxPositions() {
    return this.getPositionTier().maxPositions;
  }

  _log(msg) {
    const ts = new Date().toISOString();
    const line = `[BB-Engine] ${ts} ${msg}`;
    console.log(line);
    // 写日志文件
    try {
      const dir = path.dirname(CONFIG.logFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(CONFIG.logFile, line + '\n');
    } catch (e) { /* ignore */ }
  }

  // ═══ 1. 选币 ═══
  async selectSymbols() {
    this._log('📊 开始选币...');
    
    // 获取所有合约交易对24h行情
    const allTickers = await this.api.getAllTickers();
    
    // 过滤：只保留 USDT 永续合约，排除交割合约
    // v122: 同时排除黑名单币种
    const blacklistSet = new Set(CONFIG.blacklist || []);
    const usdtPerps = allTickers.filter(t => 
      t.symbol.endsWith('USDT') && 
      parseFloat(t.quoteVolume) > 0 &&
      !t.symbol.includes('_') &&
      !blacklistSet.has(t.symbol)  // v122: 黑名单过滤
    );

    // 按成交额排序，取前50强
    usdtPerps.sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
    const top50 = usdtPerps.slice(0, CONFIG.topN).map(t => ({
      symbol: t.symbol,
      volume: parseFloat(t.quoteVolume),
      price: parseFloat(t.lastPrice),
      changePct: parseFloat(t.priceChangePercent),
    }));

    this._log(`✅ 前50强选币完成，Top5: ${top50.slice(0, 5).map(t => t.symbol).join(', ')}`);

    // 检查当前持仓中的币种，如果有浮盈±≤1%的，优先保留
    const floatProfitSymbols = [];
    for (const [sym, pos] of Object.entries(this.positions)) {
      const pnlPct = this._calcPnlPct(pos, pos.currentPrice || pos.entryPrice);
      if (Math.abs(pnlPct) <= CONFIG.floatProfitPct) {
        floatProfitSymbols.push(sym);
        this._log(`📌 ${sym} 浮盈${pnlPct.toFixed(2)}% (±≤1%) — 优先保留`);
      }
    }

    return { top50, floatProfitSymbols };
  }

  // ═══ 2. 特殊时间检查 ═══
  async checkSpecialTime(symbol) {
    const now = Date.now();

    // (1) 资金费率结算前15分钟
    try {
      const fundingInfo = await this.api.getFundingInfo(symbol);
      const nextFunding = fundingInfo.nextFundingTime;
      const minToFunding = (nextFunding - now) / 60000;
      if (minToFunding <= CONFIG.fundingPauseMin && minToFunding > 0) {
        return { blocked: true, reason: `资金费率结算前${minToFunding.toFixed(0)}分钟` };
      }
    } catch (e) { /* 忽略，不阻塞 */ }

    // (2) 季度合约交割日前1小时
    // Binance永续合约不交割，但如果交易对是交割合约则检查
    if (symbol.includes('_')) {
      // 交割合约逻辑暂时跳过（我们只做永续）
      return { blocked: true, reason: '交割合约不支持' };
    }

    // (3) 布林带开口暂停 — 在开仓准入中检查，这里只返回不阻塞止盈止损
    return { blocked: false };
  }

  // ═══ 3. 插针过滤 ═══
  checkPinBar(klines) {
    if (klines.length < 2) return { valid: true };
    
    const lastK = klines[klines.length - 1];
    
    // 单根K线涨跌幅超过±3%判定为异动毛刺K线
    const changePct = Math.abs((lastK.close - lastK.open) / lastK.open * 100);
    if (changePct > 3) {
      return { valid: false, reason: `毛刺K线(涨跌${changePct.toFixed(1)}%>3%)` };
    }

    return { valid: true, close: lastK.close };
  }

  // ═══ 4. 开仓准入检查 ═══
  checkOpenCondition(klines) {
    // (1) 禁开仓条件：带宽100根K线历史分位 > 90%
    const bwPercentile = Indicators.bandwidthPercentile(klines, CONFIG.bandwidthPercentileLookback);
    if (bwPercentile === null) {
      return { allowed: false, reason: '带宽分位数据不足' };
    }
    
    if (bwPercentile > CONFIG.bandwidthOpenBlock) {
      return { allowed: false, reason: `带宽分位${bwPercentile.toFixed(0)}%>90% — 禁开仓`, bwPercentile };
    }

    // v126: ADX趋势强度过滤 — ADX>20才开仓
    const adx = Indicators.adx(klines, 14);

    // v127: ATR 波动率过滤（基本风险过滤，两条开仓路径都要过）
    const atr = Indicators.atr(klines, CONFIG.atrPeriod);
    const lastClose = klines[klines.length - 1].close;
    const lastK = klines[klines.length - 1];
    const atrPct = atr / lastClose * 100;
    if (atrPct < CONFIG.minAtrPct) {
      return { allowed: false, reason: `ATR波动率${atrPct.toFixed(3)}%<${CONFIG.minAtrPct}% — 低波动不开仓`, bwPercentile };
    }

    // (3) 布林带 + EMA
    const bb = Indicators.bollinger(klines, CONFIG.bbPeriod, CONFIG.bbStd);
    if (!bb) {
      return { allowed: false, reason: '布林带数据不足' };
    }
    const ema20 = Indicators.ema(klines, 20);
    const ema60 = Indicators.ema(klines, 60);
    if (!ema20 || !ema60) {
      return { allowed: false, reason: 'EMA 数据不足', bwPercentile };
    }
    const isUptrend = ema20 > ema60;
    const isDowntrend = ema20 < ema60;

    // ═══ v127: 趋势启动开仓路径（独立于BB轨道开仓）═══
    // 趋势启动开仓不需要带宽收窄、不需要ADX>20，只要ADX>15且上升中 + EMA早期排列 + 放量
    // 判断"刚启动": EMA20/60已交叉 + EMA间距小(趋势早期) + ADX>15+上升中 + 放量
    const emaGapPct = Math.abs(ema20 - ema60) / ema60 * 100;
    const isEarlyTrend = emaGapPct < 2.0; // v128: EMA刚拉开不到2%=趋势早期(0.8太窄)
    const adxRising = adx > 15 && adx < 40; // ADX>15有趋势但<40没到后期
    const volMA = Indicators.volumeMA(klines, CONFIG.volumeMaPeriod);
    const volSpike = lastK.volume > volMA * 1.3; // 放量1.3倍
    // ADX上升中: 近3根ADX在升
    const prevAdx1 = Indicators.adx(klines.slice(0, -1), 14);
    const prevAdx2 = Indicators.adx(klines.slice(0, -2), 14);
    const adxGoingUp = prevAdx1 && prevAdx2 && adx > prevAdx1 && prevAdx1 > prevAdx2;

    // 趋势启动做多: EMA多头排列 + 趋势早期 + ADX>15且上升 + 放量
    if (isUptrend && isEarlyTrend && adxRising && adxGoingUp && volSpike) {
      return {
        allowed: true,
        direction: 'LONG',
        bb,
        bwPercentile,
        mode: '趋势',
        reason: `趋势启动做多: EMA多头排列+间距${emaGapPct.toFixed(2)}%(早期) + ADX=${adx.toFixed(1)}↑ + 放量`
      };
    }
    // 趋势启动做空: EMA空头排列 + 趋势早期 + ADX>15且上升 + 放量
    if (isDowntrend && isEarlyTrend && adxRising && adxGoingUp && volSpike) {
      return {
        allowed: true,
        direction: 'SHORT',
        bb,
        bwPercentile,
        mode: '趋势',
        reason: `趋势启动做空: EMA空头排列+间距${emaGapPct.toFixed(2)}%(早期) + ADX=${adx.toFixed(1)}↑ + 放量`
      };
    }

    // ═══ BB轨道开仓路径（原B策略逻辑）═══
    // 需要: ADX>20 + 带宽分位<85% + 连续3根收窄 + 触轨 + EMA顺向
    if (adx < CONFIG.adxThreshold) {
      return { allowed: false, reason: `ADX=${adx.toFixed(1)}<${CONFIG.adxThreshold} — BB轨道开仓趋势不够强`, bwPercentile };
    }

    // (2) BB开仓解禁：带宽分位 < 85% + 连续3根收窄
    if (bwPercentile >= CONFIG.bandwidthOpenAllow) {
      return { allowed: false, reason: `带宽分位${bwPercentile.toFixed(0)}%≥85% — BB未解禁`, bwPercentile };
    }

    const isNarrowing = Indicators.isNarrowing(klines, CONFIG.narrowCount);
    if (!isNarrowing) {
      return { allowed: false, reason: `布林带未连续${CONFIG.narrowCount}根收窄`, bwPercentile };
    }
    
    // 开多：5min收盘价触及/跌破下轨 + EMA多头排列
    if (lastClose <= bb.lower) {
      if (!isUptrend) {
        return { allowed: false, reason: `收盘触下轨但EMA空头排列(EMA20=${ema20.toFixed(6)}<EMA60=${ema60.toFixed(6)}) — 逆势不开多`, bwPercentile };
      }
      return { 
        allowed: true, 
        direction: 'LONG', 
        bb, 
        bwPercentile, 
        reason: `收盘价${lastClose.toFixed(6)}触及下轨${bb.lower.toFixed(6)} + EMA多头排列` 
      };
    }

    // 开空：5min收盘价触及/突破上轨 + EMA空头排列
    if (lastClose >= bb.upper) {
      if (!isDowntrend) {
        return { allowed: false, reason: `收盘触上轨但EMA多头排列(EMA20=${ema20.toFixed(6)}>EMA60=${ema60.toFixed(6)}) — 逆势不开空`, bwPercentile };
      }
      return { 
        allowed: true, 
        direction: 'SHORT', 
        bb, 
        bwPercentile, 
        reason: `收盘价${lastClose.toFixed(6)}触及上轨${bb.upper.toFixed(6)} + EMA空头排列` 
      };
    }

    return { allowed: false, reason: `收盘价${lastClose.toFixed(6)}在轨道内，未触发`, bwPercentile };
  }

  // ═══ 5. 止盈 — 简洁版 ═══
  checkTakeProfit(klines, pos) {
    const bb = Indicators.bollinger(klines, CONFIG.bbPeriod, CONFIG.bbStd);
    if (!bb) return { action: 'HOLD' };

    const lastK = klines[klines.length - 1];
    const close = lastK.close;
    const pnlPct = this._calcPnlPct(pos, close);

    // v128: 趋势仓和轨道仓用不同止盈触发门槛
    const triggerPct = pos.mode === '趋势' ? CONFIG.trendProfitTriggerPct : CONFIG.profitTriggerPct;

    // 浮盈≥触发门槛才触发止盈
    if (pnlPct < triggerPct) {
      return { action: 'HOLD', pnlPct, reason: `浮盈${pnlPct.toFixed(2)}%<${triggerPct}%` };
    }

    // v128: 移动止盈 — 浮盈超触发门槛后，从峰值回撤0.5%就锁利
    if (!pos._peakPnlPct || pnlPct > pos._peakPnlPct) pos._peakPnlPct = pnlPct;
    const drawdown = pos._peakPnlPct - pnlPct;
    if (pos._peakPnlPct > triggerPct + 0.5 && drawdown >= 0.5) {
      return { action: 'CLOSE', reason: `移动止盈: 峰值${pos._peakPnlPct.toFixed(2)}%回撤${drawdown.toFixed(2)}%`, pnlPct };
    }

    // v127: 趋势仓止盈 — 只用移动止盈+反向轨道兑底，不用中轨止盈
    // 趋势仓开仓时价格在轨道中间，中轨止盈会导致开仓即平仓
    if (pos.mode === '趋势') {
      // 二级兜底：趋势走到反向轨道才止盈
      if (pos.side === 'LONG' && close >= bb.upper) {
        return { action: 'CLOSE', reason: `趋势止盈: 多单收盘触碰上轨${bb.upper.toFixed(6)}`, pnlPct };
      }
      if (pos.side === 'SHORT' && close <= bb.lower) {
        return { action: 'CLOSE', reason: `趋势止盈: 空单收盘触碰下轨${bb.lower.toFixed(6)}`, pnlPct };
      }
      return { action: 'HOLD', pnlPct, reason: `趋势止盈等待: 收盘${close.toFixed(6)} 上轨${bb.upper.toFixed(6)} 下轨${bb.lower.toFixed(6)}` };
    }

    // BB轨道仓止盈：收盘触中轨全平
    if (pos.side === 'LONG' && close >= bb.mid) {
      return { action: 'CLOSE', reason: `轨道止盈: 多单收盘${close.toFixed(6)}触碰中轨${bb.mid.toFixed(6)}`, pnlPct };
    }
    if (pos.side === 'SHORT' && close <= bb.mid) {
      return { action: 'CLOSE', reason: `轨道止盈: 空单收盘${close.toFixed(6)}触碰中轨${bb.mid.toFixed(6)}`, pnlPct };
    }

    // ② 二级兜底：未触发中轨止盈，价格到反向轨道也平仓
    if (pos.side === 'LONG' && close >= bb.upper) {
      return { action: 'CLOSE', reason: `二级兜底: 多单收盘触碰上轨${bb.upper.toFixed(6)}`, pnlPct };
    }
    if (pos.side === 'SHORT' && close <= bb.lower) {
      return { action: 'CLOSE', reason: `二级兜底: 空单收盘触碰下轨${bb.lower.toFixed(6)}`, pnlPct };
    }

    return { action: 'HOLD', pnlPct, reason: `止盈等待: 收盘${close.toFixed(6)} 中轨${bb.mid.toFixed(6)}` };
  }

  _getStageLow(klines, pos) {
    // 从开仓时间开始的最低收盘价
    const idx = klines.findIndex(k => k.time >= pos.openTime);
    const start = idx >= 0 ? idx : 0;
    let low = Infinity;
    for (let i = start; i < klines.length; i++) {
      if (klines[i].close < low) low = klines[i].close;
    }
    return low === Infinity ? pos.entryPrice : low;
  }

  _getStageHigh(klines, pos) {
    const idx = klines.findIndex(k => k.time >= pos.openTime);
    const start = idx >= 0 ? idx : 0;
    let high = -Infinity;
    for (let i = start; i < klines.length; i++) {
      if (klines[i].close > high) high = klines[i].close;
    }
    return high === -Infinity ? pos.entryPrice : high;
  }

  // ═══ 6. 补仓检查 ═══
  async checkReplenish(klines, pos) {
    // 已补完3次，不再补仓
    if (pos.replenishCount >= CONFIG.maxReplenish) {
      return { action: 'HOLD', reason: '已补完3次' };
    }

    // ═══ v123 硬性防御：孤儿仓位永不补仓 ═══
    // 孤儿仓位是手动/其他系统开的，BB 不应该补仓放大风险
    if (pos._orphan) {
      return { action: 'HOLD', reason: '孤儿仓位不补仓（v123 安全防御）' };
    }

    // v127: 趋势仓不补仓 — 趋势仓用移动止盈管理，不适用收口补仓逻辑
    if (pos.mode === '趋势') {
      return { action: 'HOLD', reason: '趋势仓不补仓（v127）' };
    }

    // 补仓前提：布林带收口后间隔3根K线
    if (!pos.lastNarrowTime) {
      // 第一次补仓：需要检测到收口
      if (Indicators.isContracting(klines)) {
        pos.lastNarrowTime = Date.now();
        pos.klinesSinceNarrow = 0;
        this._log(`📌 ${pos.symbol} 检测到布林带收口，开始计数K线`);
      }
      return { action: 'HOLD', reason: '等待布林带收口' };
    }

    // 计算自收口以来的K线数
    pos.klinesSinceNarrow = (pos.klinesSinceNarrow || 0) + 1;
    
    if (pos.klinesSinceNarrow < CONFIG.replenishInterval) {
      return { action: 'HOLD', reason: `收口后${pos.klinesSinceNarrow}/${CONFIG.replenishInterval}根K线` };
    }

    // 间隔3根K线到了，执行补仓
    const ratio = CONFIG.replenishRatios[pos.replenishCount];
    const replenishAmount = pos.margin * ratio;
    pos.replenishCount++;
    pos.klinesSinceNarrow = 0;  // 重置计数，等下次收口
    pos.lastNarrowTime = null;   // 清除，等下次收口触发

    return { 
      action: 'REPLENISH', 
      amount: replenishAmount, 
      count: pos.replenishCount,
      reason: `第${pos.replenishCount}次补仓 ${ratio * 100}%=$${replenishAmount.toFixed(2)}` 
    };
  }

  // ═══ v128: 趋势反转止损 + 反向开仓 ═══
  // 统一用 EMA20/60（和开仓一致），不再用 EMA25/99
  // 做多后 EMA20<EMA60 + 3根收盘价都在EMA20下方 → 止损 + 反向做空
  // 做空后 EMA20>EMA60 + 3根收盘价都在EMA20上方 → 止损 + 反向做多
  checkTrendReversal(klines, pos) {
    if (klines.length < 60) return { action: 'HOLD' };
    
    const ema20 = Indicators.ema(klines, 20);
    const ema60 = Indicators.ema(klines, 60);
    if (!ema20 || !ema60) return { action: 'HOLD' };
    
    // 最近3根K线收盘价
    const last3Closes = klines.slice(-3).map(k => k.close);
    
    // 做多持仓：趋势转空（EMA20<EMA60 + 3根收盘价都在EMA20下方）
    if (pos.side === 'LONG' && ema20 < ema60) {
      const allBelow = last3Closes.every(c => c < ema20);
      if (allBelow) {
        const pnlPct = this._calcPnlPct(pos, last3Closes[2]);
        return {
          action: 'CLOSE',
          reason: `趋势反转止损: 做多但EMA20(${ema20.toFixed(6)})<EMA60(${ema60.toFixed(6)}) + 3根收盘价都在EMA20下方 (PnL=${pnlPct.toFixed(2)}%)`,
          reverseDirection: 'SHORT',
        };
      }
    }
    
    // 做空持仓：趋势转多（EMA20>EMA60 + 3根收盘价都在EMA20上方）
    if (pos.side === 'SHORT' && ema20 > ema60) {
      const allAbove = last3Closes.every(c => c > ema20);
      if (allAbove) {
        const pnlPct = this._calcPnlPct(pos, last3Closes[2]);
        return {
          action: 'CLOSE',
          reason: `趋势反转止损: 做空但EMA20(${ema20.toFixed(6)})>EMA60(${ema60.toFixed(6)}) + 3根收盘价都在EMA20上方 (PnL=${pnlPct.toFixed(2)}%)`,
          reverseDirection: 'LONG',
        };
      }
    }
    
    return { action: 'HOLD' };
  }

  // ═══ v126: ATR动态止损 ═══
  checkAtrStopLoss(klines, pos) {
    const atr = Indicators.atr(klines, CONFIG.atrPeriod);
    const lastClose = klines[klines.length - 1].close;
    const atrPct = atr / lastClose * 100;
    const stopPct = atrPct * CONFIG.atrStopMultiplier; // 1.5 ATR
    
    const pnlPct = this._calcPnlPct(pos, lastClose);
    if (pnlPct <= -stopPct) {
      return { action: 'CLOSE', reason: `ATR止损: 浮亏${pnlPct.toFixed(2)}%≤-${stopPct.toFixed(2)}%(1.5ATR=${atrPct.toFixed(3)}%)` };
    }
    return { action: 'HOLD' };
  }

  // ═══ 7. 单K线止损 (v128: 不含杠杆，看原始价格波动) ═══
  checkSingleKStopLoss(klines, pos) {
    // v128: singleKLossPct=3% 是原始价格波动，不是杠杆后浮亏
    // 之前: 价格跌1% × 3倍杠杆 = 3% → 触发止损（太敏感，频繁插针打掉）
    // 现在: 价格跌3% 才触发止损（过滤正常波动，只在真正暴跌时止损）
    const lastK = klines[klines.length - 1];
    const prevK = klines[klines.length - 2];
    if (!prevK) return { action: 'HOLD' };

    // 单K线原始价格变动百分比（不含杠杆）
    let klineLossPct;
    if (pos.side === 'LONG') {
      klineLossPct = (prevK.close - lastK.close) / prevK.close * 100;
    } else {
      klineLossPct = (lastK.close - prevK.close) / prevK.close * 100;
    }

    if (klineLossPct >= CONFIG.singleKLossPct) {
      return { 
        action: 'CLOSE', 
        reason: `⚠️单K止损: 单根K线价格变动${klineLossPct.toFixed(1)}%≥${CONFIG.singleKLossPct}%`,
        klineLossPct 
      };
    }

    return { action: 'HOLD', klineLossPct };
  }

  // ═══ 8. 终极止损 ═══
  // v128: 终极止损对所有仓位生效，不再要求3次补完
  // 趋势仓不补仓、孤儿仓不补仓，但都需要终极止损兜底
  checkUltimateStopLoss(pos) {
    const totalLossPct = this._calcTotalLossPct(pos);
    if (totalLossPct >= CONFIG.ultimateLossPct) {
      return { 
        action: 'CLOSE', 
        reason: `🚨终极止损: 总浮亏${totalLossPct.toFixed(1)}%≥${CONFIG.ultimateLossPct}%`,
        totalLossPct 
      };
    }

    return { action: 'HOLD', totalLossPct };
  }

  // ═══ 盈亏计算 ═══
  _calcPnlPct(pos, currentPrice) {
    // 浮盈百分比（相对于本金）
    if (pos.side === 'LONG') {
      return (currentPrice - pos.entryPrice) / pos.entryPrice * 100 * pos.leverage;
    } else {
      return (pos.entryPrice - currentPrice) / pos.entryPrice * 100 * pos.leverage;
    }
  }

  _calcTotalLossPct(pos) {
    // 总浮亏 = (开仓价 - 当前价) / 开仓价 × 杠杆 × 100 (做多)
    // 或 (当前价 - 开仓价) / 开仓价 × 杠杆 × 100 (做空)
    const currentPrice = pos.currentPrice || pos.entryPrice;
    let lossPct;
    if (pos.side === 'LONG') {
      lossPct = (pos.entryPrice - currentPrice) / pos.entryPrice * 100 * pos.leverage;
    } else {
      lossPct = (currentPrice - pos.entryPrice) / pos.entryPrice * 100 * pos.leverage;
    }
    return Math.max(0, lossPct);
  }

  _calcPnlUsd(pos, currentPrice) {
    if (pos.side === 'LONG') {
      return (currentPrice - pos.entryPrice) * pos.qty;
    } else {
      return (pos.entryPrice - currentPrice) * pos.qty;
    }
  }

  // ═══ 主循环 ═══
  async start() {
    this.running = true;
    this._log('🚀 BB Engine 启动');

    // 加载状态
    this._loadState();

    // 获取交易对精度
    try {
      this.precisionMap = await this.api.getExchangeInfo();
      this._log(`✅ 获取交易对精度: ${Object.keys(this.precisionMap).length}个`);
    } catch (e) {
      this._log(`⚠️ 获取交易对精度失败: ${e.message}`);
      this.precisionMap = {};
    }

    // 获取余额
    this.balance = await this.api.getBalance();
    this._log(`💰 当前余额: $${this.balance.toFixed(2)}`);

    // 同步已有持仓
    await this._syncPositions();

    // 开始循环
    this._loop();
  }

  async _loop() {
    while (this.running) {
      try {
        await this._scan();
      } catch (e) {
        this._log(`❌ 扫描异常: ${e.message}`);
      }
      await this._sleep(CONFIG.scanIntervalMs);
    }
  }

  async _scan() {
    // ── 1. 选币 ──
    const { top50 } = await this.selectSymbols();
    const candidateSymbols = top50.map(t => t.symbol);

    // 修复：每10轮重新获取精度，防止精度表为空或新币种上线
    this._cycleCount = (this._cycleCount || 0) + 1;
    if (this._cycleCount % 10 === 0 || Object.keys(this.precisionMap || {}).length === 0) {
      try {
        this.precisionMap = await this.api.getExchangeInfo();
        this._log(`✅ 重新获取交易对精度: ${Object.keys(this.precisionMap).length}个`);
      } catch (e) {
        this._log(`⚠️ 重新获取精度失败: ${e.message}`);
      }
    }

    // ── 2. 同步已有持仓 ──
    await this._syncPositions();

    // ── 3. 管理现有持仓（止盈、止损、补仓）──
    const activePositionSymbols = Object.keys(this.positions);
    
    for (const symbol of activePositionSymbols) {
      const pos = this.positions[symbol];
      
      try {
        // 拉取5min K线
        const klines = await this.api.getKlines(symbol, CONFIG.klineInterval, CONFIG.klineLimit);
        if (klines.length < 60) continue;

        // 插针过滤：检查最新K线是否为毛刺
        const pinCheck = this.checkPinBar(klines);
        if (!pinCheck.valid) {
          this._log(`⚪ ${symbol} ${pinCheck.reason} — 该K线信号作废`);
          continue;
        }

        const lastClose = klines[klines.length - 1].close;
        pos.currentPrice = lastClose;

        // ── v126: ATR动态止损（最先检查，亏1.5ATR就跑）──
        const atrStopResult = this.checkAtrStopLoss(klines, pos);
        if (atrStopResult.action === 'CLOSE') {
          this._log(`🔴 ${symbol} ${atrStopResult.reason}`);
          await this._closePosition(symbol, pos, atrStopResult.reason);
          continue;
        }

        // ── 7. 单K线止损 ──
        const slResult = this.checkSingleKStopLoss(klines, pos);
        if (slResult.action === 'CLOSE') {
          this._log(`🔴 ${symbol} ${slResult.reason}`);
          await this._closePosition(symbol, pos, slResult.reason);
          continue;
        }

        // ── v126: 趋势反转止损 + 立即反向开仓 ──
        const reversalResult = this.checkTrendReversal(klines, pos);
        if (reversalResult.action === 'CLOSE') {
          this._log(`🔄 ${symbol} ${reversalResult.reason}`);
          await this._closePosition(symbol, pos, reversalResult.reason);
          // 止损后立即检查反向开仓
          if (reversalResult.reverseDirection) {
            this._log(`🔄 ${symbol} 趋势反转，尝试反向开仓 ${reversalResult.reverseDirection}`);
            const bb = Indicators.bollinger(klines, CONFIG.bbPeriod, CONFIG.bbStd);
            const ema20r = Indicators.ema(klines, 20);
            const ema60r = Indicators.ema(klines, 60);
            if (bb && ema20r && ema60r) {
              const canReverseLong = reversalResult.reverseDirection === 'LONG' && lastClose <= bb.lower && ema20r > ema60r;
              const canReverseShort = reversalResult.reverseDirection === 'SHORT' && lastClose >= bb.upper && ema20r < ema60r;
              if (canReverseLong || canReverseShort) {
                const revDir = canReverseLong ? 'LONG' : 'SHORT';
                this._log(`🟢 ${symbol} 反向开仓信号: ${revDir} (触轨+EMA顺向)`);
                await this._openPosition(symbol, revDir, klines);
              } else {
                this._log(`⏭️ ${symbol} 反向开仓条件不满足（未触轨或EMA不顺向），等待下次信号`);
              }
            }
          }
          continue;
        }

        // ── 8. 终极止损 ──
        const ultimateResult = this.checkUltimateStopLoss(pos);
        if (ultimateResult.action === 'CLOSE') {
          this._log(`🔴 ${symbol} ${ultimateResult.reason}`);
          await this._closePosition(symbol, pos, ultimateResult.reason);
          continue;
        }

        // ── 特殊时间检查（只禁止开仓/补仓，不禁止止盈止损）──
        const specialTime = await this.checkSpecialTime(symbol);
        const specialTimeBlocked = specialTime.blocked;

        // ── 5. 止盈检查 ──
        const tpResult = this.checkTakeProfit(klines, pos);
        if (tpResult.action === 'CLOSE') {
          this._log(`✅ ${symbol} ${tpResult.reason}`);
          await this._closePosition(symbol, pos, tpResult.reason);
          continue;
        }

        // ── 6. 补仓检查（特殊时间禁止补仓）──
        if (!specialTimeBlocked) {
          const repResult = await this.checkReplenish(klines, pos);
          if (repResult.action === 'REPLENISH') {
            this._log(`📈 ${symbol} ${repResult.reason}`);
            await this._replenishPosition(symbol, pos, repResult.amount);
            continue;
          }
        } else {
          this._log(`⏸️ ${symbol} ${specialTime.reason} — 暂停补仓`);
        }

        // 记录状态
        const pnlPct = this._calcPnlPct(pos, lastClose);
        const pnlUsd = this._calcPnlUsd(pos, lastClose);
        this._log(`📊 ${symbol} ${pos.side} qty=${pos.qty} entry=${pos.entryPrice} close=${lastClose} PnL=${pnlPct.toFixed(2)}%($${pnlUsd.toFixed(2)}) 补仓=${pos.replenishCount}/3 模式=${pos.mode || '轨道'}`);

      } catch (e) {
        this._log(`⚠️ ${symbol} 管理异常: ${e.message}`);
      }
    }

    // ── 4. 开仓新币种 ──
    // v128: 动态仓位限制 — 根据余额档位决定5仓或7仓
    const tier = this.getPositionTier();
    const maxPos = tier.maxPositions;
    const { trend: trendCount, bb: bbCount, total: positionCount } = this.countPositionsByMode();
    if (positionCount >= maxPos) {
      this._log(`📊 持仓${positionCount}/${maxPos}已满（趋势${trendCount}/${tier.trendMax} BB${bbCount}/${tier.bbMax}），不开新仓`);
      this._saveState();
      return;
    }

    // 只扫描不在持仓中的候选币
    const symbolsToScan = candidateSymbols.filter(s => !this.positions[s]);
    
    for (const symbol of symbolsToScan) {
      if (this.countPositionsByMode().total >= maxPos) break;

      try {
        // 特殊时间检查
        const specialTime = await this.checkSpecialTime(symbol);
        if (specialTime.blocked) {
          this._log(`⏸️ ${symbol} ${specialTime.reason} — 禁止开仓`);
          continue;
        }

        // 拉取5min K线
        const klines = await this.api.getKlines(symbol, CONFIG.klineInterval, CONFIG.klineLimit);
        if (klines.length < 120) continue;

        // 插针过滤
        const pinCheck = this.checkPinBar(klines);
        if (!pinCheck.valid) {
          this._log(`⚪ ${symbol} ${pinCheck.reason} — 信号作废`);
          continue;
        }

        // 开仓准入检查
        const openCheck = this.checkOpenCondition(klines);
        if (!openCheck.allowed) {
          // 静默跳过，不刷屏
          continue;
        }

        // 执行开仓
        this._log(`🟢 ${symbol} ${openCheck.direction} 信号: ${openCheck.reason} | 带宽分位=${openCheck.bwPercentile?.toFixed(0)}%`);
        await this._openPosition(symbol, openCheck.direction, klines, openCheck.mode || '轨道');

      } catch (e) {
        // 打印错误，不再静默吞掉
        this._log(`❌ ${symbol} 开仓异常: ${e.message}`);
      }
    }

    this._saveState();
  }

  // ═══ 开仓执行 ═══
  async _openPosition(symbol, direction, klines, mode = '轨道') {
    const price = klines[klines.length - 1].close;
    
    // v122: 黑名单币种禁止开仓
    const blacklistSet = new Set(CONFIG.blacklist || []);
    if (blacklistSet.has(symbol)) {
      this._log(`🚫 ${symbol} ${direction} 跳过开仓: 黑名单币种`);
      return;
    }
    
    // 修复：算力费暂停时不开新仓（余额不足或未授权）
    if (this.gatesFeePaused) {
      this._log(`⏸️ ${symbol} ${direction} 跳过开仓: 算力费暂停(余额不足或未授权)，保留持仓监控`);
      return;
    }
    
    // 余额不足时跳过开仓
    if (!this.balance || this.balance <= 0) {
      this._log(`⏭️ ${symbol} ${direction} 跳过开仓: 余额=$${(this.balance||0).toFixed(2)}`);
      return;
    }
    
    // v128: 动态仓位检查 — 根据资金档位+mode分名额
    const tier = this.getPositionTier();
    const { trend: trendCount, bb: bbCount, total: currentCount } = this.countPositionsByMode();
    if (currentCount >= tier.maxPositions) {
      this._log(`📊 ${symbol} ${direction} 跳过开仓: 持仓${currentCount}/${tier.maxPositions}已满`);
      return;
    }
    // v128: mode分名额检查
    if (mode === '趋势' && trendCount >= tier.trendMax) {
      this._log(`📊 ${symbol} ${direction} 跳过开仓: 趋势仓${trendCount}/${tier.trendMax}已满`);
      return;
    }
    if (mode === '轨道' && bbCount >= tier.bbMax) {
      this._log(`📊 ${symbol} ${direction} 跳过开仓: BB仓${bbCount}/${tier.bbMax}已满`);
      return;
    }
    
    // v128: 仓位大小 — 根据资金档位+波动率自动配比
    const atr = Indicators.atr(klines, CONFIG.atrPeriod);
    const atrPct = atr / price * 100;
    let positionPct;
    if (atrPct > 0.5) positionPct = tier.highVolPct;
    else if (atrPct > 0.2) positionPct = tier.midVolPct;
    else positionPct = tier.lowVolPct;
    
    const positionMargin = this.balance * positionPct;
    const notional = positionMargin * CONFIG.leverage;
    const qty = notional / price;

    let result;
    if (direction === 'LONG') {
      result = await this.api.marketLong(symbol, qty, CONFIG.leverage, this.precisionMap, atrPct);
    } else {
      result = await this.api.marketShort(symbol, qty, CONFIG.leverage, this.precisionMap, atrPct);
    }

    if (result.success) {
      this.positions[symbol] = {
        symbol,
        side: direction,
        qty: result.qty || qty,
        entryPrice: price,
        margin: positionMargin,
        leverage: CONFIG.leverage,
        openTime: klines[klines.length - 1].time,
        replenishCount: 0,
        lastNarrowTime: null,
        klinesSinceNarrow: 0,
        mode: mode,
        atrTrailPrice: null,
        currentPrice: price,
      };
      this._log(`✅ ${symbol} ${direction} 开仓成功 qty=${result.qty || qty} price=${price} margin=$${positionMargin.toFixed(2)} lev=${CONFIG.leverage}x`);
      this._saveState();
    } else {
      this._log(`❌ ${symbol} ${direction} 开仓失败: ${result.error}`);
    }
  }

  // ═══ 算力费/算力费配置 ═══
  // 普通用户: 算力费10% + 算力费20% = 实得70%（仅盈利时收取）
  // 管理员: 0% 全免
  static FEE_CONFIG = {
    PLATFORM_FEE_RATE: 0.20,   // 20% 算力费
    ECO_FUND_RATE: 0.10,       // 10% 算力费
    USER_SHARE_RATE: 0.70,     // 70% 用户实得
    PLATFORM_WALLET: '0xb6DEb31484353AdDaA5b6A105A2B758Df11bC28A',  // 服务费钱包
    ECO_FUND_WALLET: '0xeF87e7fD5f0ADC5de82e84Dc9300002D9aC8bD82',  // 生态费钱包
    ADMIN_WALLETS: [
      '0xfa3b90c574469909d20848273c06752a22fde74a',
      '0xe6ddf0771c7610dba77eb5a07ba7771dd7f5e91e',
      '0x41c89c7df1ad4c8dd251c5afe45aa1c791fb6ea5',  // 白名单用户，免算力费
    ],
    FEE_THRESHOLD: 5,          // v122: 累计费用≥$5才转账（高于$5才自动转给管理员）
    FEE_STATE_FILE: path.join(__dirname, 'data', 'bb-fee-state.json'),
  };

  _isAdmin() {
    if (!this.wallet) return true; // 无wallet默认管理员
    return BBEngine.FEE_CONFIG.ADMIN_WALLETS.includes(this.wallet.toLowerCase());
  }

  _loadFeeState() {
    try {
      if (fs.existsSync(BBEngine.FEE_CONFIG.FEE_STATE_FILE)) {
        this._feeState = JSON.parse(fs.readFileSync(BBEngine.FEE_CONFIG.FEE_STATE_FILE, 'utf8'));
      } else {
        this._feeState = { pending: {}, collected: {}, totalPlatformFee: 0, totalEcoFund: 0 };
      }
    } catch (e) {
      this._feeState = { pending: {}, collected: {}, totalPlatformFee: 0, totalEcoFund: 0 };
    }
  }

  _saveFeeState() {
    try {
      const dir = path.dirname(BBEngine.FEE_CONFIG.FEE_STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // 修复并发写入覆盖：先读取最新文件内容，合并后写入
      let latest = { pending: {}, collected: {}, totalPlatformFee: 0, totalEcoFund: 0 };
      try {
        if (fs.existsSync(BBEngine.FEE_CONFIG.FEE_STATE_FILE)) {
          latest = JSON.parse(fs.readFileSync(BBEngine.FEE_CONFIG.FEE_STATE_FILE, 'utf8'));
        }
      } catch(e) { /* 文件损坏，用默认值 */ }
      // 合并：以磁盘上的collected为准，以内存中的pending为准（因为pending可能刚被修改）
      // 但只合并本用户的wallet key，不覆盖其他用户的数据
      const myWalletKey = this.wallet || 'admin';
      // 保留磁盘上其他用户的数据，用内存中本用户的数据覆盖
      if (!latest.pending) latest.pending = {};
      if (!latest.collected) latest.collected = {};
      // 用内存中本用户的pending覆盖磁盘上的
      if (this._feeState.pending[myWalletKey] !== undefined) {
        latest.pending[myWalletKey] = this._feeState.pending[myWalletKey];
      }
      if (this._feeState.collected[myWalletKey] !== undefined) {
        latest.collected[myWalletKey] = this._feeState.collected[myWalletKey];
      }
      // 全局统计重新计算
      latest.totalPlatformFee = this._feeState.totalPlatformFee || 0;
      latest.totalEcoFund = this._feeState.totalEcoFund || 0;
      // 原子写入：先写临时文件再 rename
      const tmpFile = BBEngine.FEE_CONFIG.FEE_STATE_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(latest, null, 2));
      fs.renameSync(tmpFile, BBEngine.FEE_CONFIG.FEE_STATE_FILE);
      // 同步内存状态
      this._feeState = latest;
    } catch (e) { /* ignore */ }
  }

  async _collectServiceFee(symbol, pnlUsd) {
    if (pnlUsd <= 0) return;

    // 管理员豁免
    if (this._isAdmin()) {
      this._log(`💰 Admin ${symbol} +$${pnlUsd.toFixed(2)} — 全额到帐，免算力费`);
      return;
    }

    if (!this._feeState) this._loadFeeState();

    const { PLATFORM_FEE_RATE, ECO_FUND_RATE, USER_SHARE_RATE } = BBEngine.FEE_CONFIG;
    const platformFee = pnlUsd * PLATFORM_FEE_RATE;
    const ecoFund = pnlUsd * ECO_FUND_RATE;
    const userShare = pnlUsd * USER_SHARE_RATE;
    const totalFee = platformFee + ecoFund; // v125 修复: 之前漏定义导致 'totalFee is not defined' 异常，阻断链上自动扣费

    const walletKey = this.wallet || 'unknown';
    if (!this._feeState.pending[walletKey]) this._feeState.pending[walletKey] = [];
    this._feeState.pending[walletKey].push({
      symbol,
      pnlUsdt: pnlUsd.toFixed(4),
      platformFee: platformFee.toFixed(4),
      ecoFund: ecoFund.toFixed(4),
      userShare: userShare.toFixed(4),
      timestamp: Date.now(),
      status: 'pending',
    });
    this._feeState.totalPlatformFee = (this._feeState.totalPlatformFee || 0) + platformFee;
    this._feeState.totalEcoFund = (this._feeState.totalEcoFund || 0) + ecoFund;

    this._log(
      `💰 费用 ${walletKey.slice(0,10)} | ${symbol}`
      + ` | 盈利 $${pnlUsd.toFixed(2)}`
      + ` | 算力费 $${ecoFund.toFixed(2)} (10%)`
      + ` | 算力费 $${platformFee.toFixed(2)} (20%)`
      + ` | 实得 $${userShare.toFixed(2)} (70%)`
    );

    this._saveFeeState();

    // ═══ v124: 立即扣减仪表盘记账余额（实时反映） ═══
    // 之前: pending 累积到 $5 才扣 gatesFeeBalance → 仪表盘余额不实时
    // 现在: 每次盈利立即扣减, 仪表盘余额立即反映算力费扣减
    //      链上转账成功时只更新 gatesFeeCollected, 不再重复扣余额
    if (this.userDB) {
      const existing = this.userDB.get(walletKey.toLowerCase()) || {};
      const oldBalance = existing.gatesFeeBalance || 0;
      const newBalance = Math.max(0, oldBalance - totalFee);
      const newPending = (existing.gatesFeePending || 0) + totalFee; // 累积待转账金额
      this.userDB.set(walletKey.toLowerCase(), {
        ...existing,
        gatesFeeBalance: newBalance,
        gatesFeeLow: newBalance < 5,
        gatesFeePending: newPending, // 用于 _tryBatchFeeTransfer 时清零
        gatesFeeApproved: true,
      });
      this._log(`📉 ${walletKey.slice(0,10)} 仪表盘余额: $${oldBalance.toFixed(2)} → $${newBalance.toFixed(2)} (扣减待转账 $${totalFee.toFixed(2)})`);
    }

    await this._tryBatchFeeTransfer(walletKey);
  }

  async _tryBatchFeeTransfer(walletKey) {
    const pending = this._feeState.pending[walletKey] || [];
    if (pending.length === 0) return;

    // 修复：跳过已收算力费的记录，避免重复扣取
    const totalPlatform = pending.reduce((s, r) => r.platformCollected ? s : s + parseFloat(r.platformFee), 0);
    const totalEco = pending.reduce((s, r) => s + parseFloat(r.ecoFund), 0);
    const totalFee = totalPlatform + totalEco;

    if (totalFee < BBEngine.FEE_CONFIG.FEE_THRESHOLD) {
      this._log(`📊 ${walletKey.slice(0,10)} 累计费用 $${totalFee.toFixed(2)} < $${BBEngine.FEE_CONFIG.FEE_THRESHOLD} 阈值，继续积累`);
      return;
    }

    // 如果算力费已全部收过，只收算力费
    if (totalPlatform === 0 && totalEco > 0) {
      this._log(`💸 ${walletKey.slice(0,10)} 仅收算力费 $${totalEco.toFixed(2)} (算力费已收过)`);
    } else {
      this._log(`💸 ${walletKey.slice(0,10)} 累计费用 $${totalFee.toFixed(2)} (算力费$${totalPlatform.toFixed(2)}+算力费$${totalEco.toFixed(2)}) 达到阈值，BSC链上扣费`);
    }

    // ═══ 自动扣费模式：从Trader钱包直接transfer USDT（不需用户授权） ═══
    // 用户充值到Trader钱包，系统自动从Trader钱包转出算力费到平台/生态钱包
    const { PLATFORM_WALLET, ECO_FUND_WALLET } = BBEngine.FEE_CONFIG;

    this._log(`💸 ${walletKey.slice(0,10)} 累计费用 $${totalFee.toFixed(2)} 达到阈值，Trader钱包自动扣费`);

    let platformOk = false, ecoOk = false;
    try {
      const { ethers } = require('ethers');
      const BSC_RPC = 'https://bsc-rpc.publicnode.com';
      const USDT_ADDR = '0x55d398326f99059fF775485246999027B3197955';
      const traderPrivateKey = process.env.TRADER_PRIVATE_KEY;
      if (!traderPrivateKey) {
        this._log(`❌ ${walletKey.slice(0,10)} TRADER_PRIVATE_KEY 未配置，无法自动扣费`);
        return;
      }
      const provider = new ethers.JsonRpcProvider(BSC_RPC);
      const traderWallet = new ethers.Wallet(traderPrivateKey, provider);
      const usdtContract = new ethers.Contract(USDT_ADDR, [
        'function transfer(address to, uint256 amount) returns (bool)',
        'function balanceOf(address) view returns (uint256)',
      ], traderWallet);

      // v125: BSC 节点要求显式 gasPrice=5 Gwei（不支持 EIP-1559）
      const GAS_PRICE = ethers.parseUnits('5', 'gwei');

      // 检查Trader钱包USDT余额是否足够
      const traderBal = await usdtContract.balanceOf(traderWallet.address);
      const totalFeeWei = ethers.parseUnits(totalFee.toFixed(6), 18);
      if (BigInt(traderBal) < totalFeeWei) {
        this._log(`❌ ${walletKey.slice(0,10)} Trader钱包USDT不足 ($${Number(traderBal)/1e18})，需要 $${totalFee.toFixed(2)}`);
        return;
      }

      // Step 1: 转算力费到平台钱包（跳过已收算力费=0的情况）
      if (totalPlatform > 0) {
        try {
          const platformWei = ethers.parseUnits(totalPlatform.toFixed(6), 18);
          this._log(`💸 ${walletKey.slice(0,10)} 服务费 $${totalPlatform.toFixed(2)} → ${PLATFORM_WALLET.slice(0,10)}...`);
          const tx1 = await usdtContract.transfer(PLATFORM_WALLET, platformWei, { gasPrice: GAS_PRICE });
          await tx1.wait();
          this._log(`✅ 服务费链上转账成功 $${totalPlatform.toFixed(2)} USDT tx=${tx1.hash.slice(0,16)}...`);
          platformOk = true;
        } catch (e) {
          this._log(`❌ 服务费链上转账失败: ${e.message.slice(0,200)}`);
        }
      } else {
        // 算力费已收过，直接标记为true，只收算力费
        platformOk = true;
      }

      // Step 2: 转算力费到算力费钱包（仅当算力费已成功，避免部分成功后重复扣算力费）
      if (platformOk) {
        try {
          const ecoWei = ethers.parseUnits(totalEco.toFixed(6), 18);
          this._log(`💸 ${walletKey.slice(0,10)} 生态费 $${totalEco.toFixed(2)} → ${ECO_FUND_WALLET.slice(0,10)}...`);
          const tx2 = await usdtContract.transfer(ECO_FUND_WALLET, ecoWei, { gasPrice: GAS_PRICE });
          await tx2.wait();
          this._log(`✅ 生态费链上转账成功 $${totalEco.toFixed(2)} USDT tx=${tx2.hash.slice(0,16)}...`);
          ecoOk = true;
        } catch (e) {
          this._log(`❌ 生态费链上转账失败: ${e.message.slice(0,200)}`);
        }
      }

      // ═══ v124: 链上转账成功 — 只更新 gatesFeeCollected, 不再扣 gatesFeeBalance ═══
      // 余额已在 _collectServiceFee 时实时扣减, 这里只标记为已转账 collected
      // 同时清零 gatesFeePending (累积待转账金额归零)
      if (platformOk && ecoOk && this.userDB) {
        const existing = this.userDB.get(walletKey.toLowerCase()) || {};
        const collected = (existing.gatesFeeCollected || 0) + totalFee;
        // 重新计算 pending (清零本次转账部分)
        const currentPending = Math.max(0, (existing.gatesFeePending || 0) - totalFee);
        this.userDB.set(walletKey.toLowerCase(), {
          ...existing,
          gatesFeeCollected: collected,
          gatesFeePending: currentPending,
          gatesFeeApproved: true, // 自动扣费模式，永远视为已授权
        });
        this._log(`✅ ${walletKey.slice(0,10)} 链上转账成功 $${totalFee.toFixed(2)} | 累计已转 $${collected.toFixed(2)} | 剩余待转 $${currentPending.toFixed(2)}`);
      }

    } catch (e) {
      this._log(`❌ ${walletKey.slice(0,10)} 算力费链上扣费异常: ${e.message.slice(0,200)}`);
    }

    // ═══ 按实际成功情况从 pending 移除已完成的记录 ═══
    // 修复：之前部分成功也保留全部pending → 重复扣费
    // 现在：算力费+算力费都成功 → 移除全部
    //       只有算力费成功 → 从pending记录中减去已收的算力费，保留算力费部分
    //       都失败 → 保留全部pending
    if (platformOk && ecoOk) {
      const removed = pending.splice(0, pending.length);
      for (const record of removed) {
        record.status = 'auto-collected';
        record.collectedAt = Date.now();
        if (!this._feeState.collected[walletKey]) this._feeState.collected[walletKey] = [];
        this._feeState.collected[walletKey].push(record);
      }
      this._log(`✅ ${walletKey.slice(0,10)} 批量费用链上转账完成，已收取 ${removed.length} 笔`);
    } else if (platformOk && !ecoOk) {
      // 算力费已成功，算力费失败 → 标记pending中已收算力费，下次只收算力费
      for (const record of pending) {
        record.platformCollected = true;
        record.platformCollectedAt = Date.now();
      }
      this._log(`⚠️ ${walletKey.slice(0,10)} 算力费已收但算力费失败，下次只收算力费 ${pending.length} 笔`);
    } else {
      this._log(`⚠️ ${walletKey.slice(0,10)} 转账失败，费用保留在 pending 中下次重试`);
    }
    this._saveFeeState();
  }

  // ═══ 平仓执行 ═══
  async _closePosition(symbol, pos, reason) {
    let result;
    if (pos.side === 'LONG') {
      result = await this.api.closeLong(symbol, pos.qty, this.precisionMap);
    } else {
      result = await this.api.closeShort(symbol, pos.qty, this.precisionMap);
    }

    if (result.success) {
      const pnlUsd = this._calcPnlUsd(pos, pos.currentPrice || pos.entryPrice);
      const pnlPct = this._calcPnlPct(pos, pos.currentPrice || pos.entryPrice);
      this._log(`✅ ${symbol} 平仓完成 ${reason} | PnL=$${pnlUsd.toFixed(2)}`);
      
      // 记录交易历史
      const tradeRecord = {
        symbol,
        side: pos.side,
        qty: pos.qty,
        entryPrice: pos.entryPrice,
        closePrice: pos.currentPrice || pos.entryPrice,
        leverage: pos.leverage,
        margin: pos.margin,
        pnlUsd: parseFloat(pnlUsd.toFixed(4)),
        pnlPct: parseFloat(pnlPct.toFixed(2)),
        reason,
        openTime: pos.openTime,
        closeTime: Date.now(),
        replenishCount: pos.replenishCount || 0,
        mode: pos.mode || '轨道',
        wallet: this.wallet || 'admin',
      };
      
      // 写入交易历史文件
      this._recordTrade(tradeRecord);
      
      // ═══ 算力费/算力费自动提取（仅盈利时，普通用户）═══
      if (pnlUsd > 0) {
        await this._collectServiceFee(symbol, pnlUsd);
      }
      
      // 回调通知 manager 更新统计
      if (this.onPositionClosed) this.onPositionClosed(tradeRecord);
      
      // v122: 记录平仓成功时间，供 _syncPositions 跳过强平误判
      // （必须在 delete 之前保存，否则丢失）
      this._lastCloseSuccess = this._lastCloseSuccess || {};
      this._lastCloseSuccess[symbol] = Date.now();
      
      delete this.positions[symbol];
      this._saveState();
    } else {
      // 修复：平仓失败时保留本地仓位，等下一轮同步后重试
      // 之前直接删除本地仓位 → 远程仓位失去监控 → 持续亏损
      this._log(`⚠️ ${symbol} 平仓失败: ${result.error} — 保留本地仓位，下一轮重试`);
      // 修复：记录平仓尝试时间，供 _syncPositions 判断是否是刚失败的平仓
      if (this.positions[symbol]) this.positions[symbol].lastCloseAttempt = Date.now();
      // 不删除 this.positions[symbol]，让 _syncPositions 下一轮确认远程状态
    }
  }

  // ═══ 补仓执行 ═══
  async _replenishPosition(symbol, pos, amountUsd) {
    // 修复：算力费暂停时不补仓（余额不足或未授权）
    if (this.gatesFeePaused) {
      this._log(`⏸️ ${symbol} 跳过补仓: 算力费暂停，保留持仓监控`);
      return;
    }
    // 修复：补仓前检查余额
    if (this.balance < amountUsd) {
      this._log(`❌ ${symbol} 补仓失败: 余额不足 $${this.balance.toFixed(2)} < 需要$${amountUsd.toFixed(2)}`);
      return;
    }
    const price = pos.currentPrice || pos.entryPrice;
    const addNotional = amountUsd * pos.leverage;
    const addQty = addNotional / price;

    let result;
    if (pos.side === 'LONG') {
      result = await this.api.marketLong(symbol, addQty, pos.leverage, this.precisionMap);
    } else {
      result = await this.api.marketShort(symbol, addQty, pos.leverage, this.precisionMap);
    }

    if (result.success) {
      // 更新持仓：加权平均入场价
      const oldNotional = pos.qty * pos.entryPrice;
      const newQty = result.qty || addQty;
      const newNotional = newQty * price;
      const totalQty = pos.qty + newQty;
      pos.entryPrice = (oldNotional + newNotional) / totalQty;
      pos.qty = totalQty;
      pos.margin += amountUsd;
      this._log(`✅ ${symbol} 第${pos.replenishCount}次补仓成功 +${newQty} @ ${price} | 总仓位=${totalQty} 均价=${pos.entryPrice}`);
      this._saveState();
    } else {
      this._log(`❌ ${symbol} 补仓失败: ${result.error}`);
    }
  }

  // ═══ 同步Binance持仓到本地 ═══
  async _syncPositions() {
    try {
      const remotePositions = await this.api.getPositions();
      this.balance = await this.api.getBalance();

      // 同步远程持仓的当前价格 + 接管孤儿仓位
      for (const rp of remotePositions) {
        const symbol = rp.symbol;
        const amt = parseFloat(rp.positionAmt);
        const entry = parseFloat(rp.entryPrice);
        const markPrice = parseFloat(rp.markPrice);
        const leverage = parseInt(rp.leverage) || CONFIG.leverage;
        
        if (this.positions[symbol]) {
          // 更新当前价格
          this.positions[symbol].currentPrice = markPrice;
          // 如果远程qty和本地不一致，以远程为准
          if (Math.abs(Math.abs(amt) - this.positions[symbol].qty) > this.positions[symbol].qty * 0.01) {
            this._log(`🔄 ${symbol} 同步qty: 本地${this.positions[symbol].qty} → 远程${Math.abs(amt)}`);
            this.positions[symbol].qty = Math.abs(amt);
          }
        } else {
          // v126: 接管白名单内的孤儿仓位（让 BB 止盈止损保护资金）
          const orphanAllow = CONFIG.orphanAllowPrefixes || [];
          const prefix = symbol.replace('USDT', '');
          const isAllowed = orphanAllow.includes('*') || orphanAllow.some(p => prefix.startsWith(p));
          
          if (isAllowed && Math.abs(amt) > 0) {
            // 接管孤儿仓位，用 BB 止盈止损管理，标记为 orphan 不补仓
            this.positions[symbol] = {
              symbol,
              side: amt > 0 ? 'LONG' : 'SHORT',
              qty: Math.abs(amt),
              entryPrice: entry,
              currentPrice: markPrice,
              margin: Math.abs(amt) * entry / leverage,
              leverage,
              replenishCount: 2, // v128: 标记已补完，不补仓
              mode: '轨道',
              openTime: Date.now(),
              _orphan: true, // 标记为孤儿仓位
            };
            this._log(`📌 ${symbol} 接管孤儿仓位 ${amt > 0 ? 'LONG' : 'SHORT'} qty=${Math.abs(amt)} — BB 管理止盈止损，不补仓`);
          } else {
            // 非白名单品种不接管
            this._log(`⏭️ ${symbol} 远程有仓但非BB开的，不管（其他引擎/手动仓位）`);
          }
        }
      }

      // 清除远程已不存在的本地持仓
      // 修复：如果刚平仓失败（本地保留了仓位），给60秒宽限期再清除，避免与平仓重试矛盾
      const now = Date.now();
      for (const symbol of Object.keys(this.positions)) {
        const exists = remotePositions.some(rp => rp.symbol === symbol && Math.abs(parseFloat(rp.positionAmt)) > 0);
        if (!exists) {
          const lastCloseAttempt = this.positions[symbol]?.lastCloseAttempt || 0;
          if (lastCloseAttempt && now - lastCloseAttempt < 60 * 1000) {
            this._log(`⏳ ${symbol} 远程已无持仓，但平仓刚尝试过(<60秒)，可能是平仓成功了，清除本地状态`);
          }
          // v122: 如果刚刚平仓成功（5分钟内），不再触发强平误判
          const lastSuccess = this._lastCloseSuccess?.[symbol] || 0;
          if (lastSuccess && now - lastSuccess < 5 * 60 * 1000) {
            this._log(`✅ ${symbol} 远程已无持仓，本引擎刚平仓成功 — 跳过强平检测`);
            delete this.positions[symbol];
            this._saveState();
            continue;
          }

          // ═══ v122: 修正强平检测逻辑 ═══
          // 原逻辑 bug: 只要 income 非零就记为强平，导致 CEXUserTrader 平仓后的仓位也被误判为强平
          // 新逻辑: 只有 PnL < 0 才算强平（Binance 不会强平盈利仓位）
          //         PnL > 0 说明是另一个策略止盈平仓了，本引擎不应该重复记录
          const pos = this.positions[symbol];
          if (pos && !pos._forceCloseRecorded) {
            try {
              // 查最近 5 分钟的已实现盈亏
              const incomeStart = Math.max(pos.openTime || (now - 600000), now - 600000);
              const incomes = await this.api.getIncome(incomeStart, now);
              const symbolIncomes = (Array.isArray(incomes) ? incomes : []).filter(i => i.symbol === symbol);
              const totalPnl = symbolIncomes.reduce((s, i) => s + parseFloat(i.income || 0), 0);
              
              if (symbolIncomes.length > 0 && totalPnl < 0) {
                // v122: 只有 PnL < 0 才是真正的强平/止损
                const avgClosePrice = pos.currentPrice || 0;
                this._log(`🔴 ${symbol} 检测到强平亏损: ${symbolIncomes.length}笔 PnL=$${totalPnl.toFixed(4)} — 记录到交易历史`);
                const forcedTrade = {
                  symbol,
                  side: pos.side,
                  qty: pos.qty,
                  entryPrice: pos.entryPrice,
                  closePrice: avgClosePrice,
                  leverage: pos.leverage,
                  margin: pos.margin,
                  pnlUsd: parseFloat(totalPnl.toFixed(4)),
                  pnlPct: pos.margin > 0 ? parseFloat(((totalPnl / pos.margin) * 100).toFixed(2)) : 0,
                  reason: '⚠️ 引擎停机期间Binance强平',
                  openTime: pos.openTime || 0,
                  closeTime: symbolIncomes[symbolIncomes.length - 1]?.time || now,
                  replenishCount: pos.replenishCount || 0,
                  mode: pos.mode || '轨道',
                  wallet: this.wallet || 'admin',
                  _forcedClose: true,
                };
                this._recordTrade(forcedTrade);
                if (this.onPositionClosed) this.onPositionClosed(forcedTrade);
              } else if (symbolIncomes.length > 0 && totalPnl > 0) {
                // v122: PnL > 0 说明另一个策略止盈平仓了，本引擎不要重复记录
                this._log(`✅ ${symbol} 远程仓位消失但有正盈亏 $${totalPnl.toFixed(2)} — 另一个策略已止盈，不重复记录`);
              }
            } catch (e) {
              this._log(`⚠️ ${symbol} 强平亏损查询失败: ${e.message}`);
            }
          }

          this._log(`🧹 ${symbol} 远程已无持仓，清除本地状态`);
          delete this.positions[symbol];
        }
      }
    } catch (e) {
      this._log(`⚠️ 同步持仓异常: ${e.message}`);
    }
  }

  // ═══ 交易历史记录 ═══
  _recordTrade(trade) {
    try {
      const dir = path.join(__dirname, 'data');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      
      // v122: 去重 — 用 symbol+closeTime+wallet 作为唯一 key，5秒内同 key 不重复记录
      const dedupKey = `${trade.symbol}_${trade.closeTime}_${(trade.wallet || 'admin').toLowerCase()}`;
      this._lastRecordedTrades = this._lastRecordedTrades || {};
      const now = Date.now();
      // 清理超过 60 秒的旧记录
      for (const k of Object.keys(this._lastRecordedTrades)) {
        if (now - this._lastRecordedTrades[k] > 60 * 1000) delete this._lastRecordedTrades[k];
      }
      if (this._lastRecordedTrades[dedupKey]) {
        this._log(`⏭️ 跳过重复交易记录: ${trade.symbol} closeTime=${trade.closeTime}`);
        return;
      }
      this._lastRecordedTrades[dedupKey] = now;
      
      // 1. 全局交易历史（兼容旧API）
      const tradeFile = path.join(dir, 'bb-trade-history.json');
      let history = [];
      if (fs.existsSync(tradeFile)) {
        history = JSON.parse(fs.readFileSync(tradeFile, 'utf8'));
      }
      history.push(trade);
      if (history.length > 500) history = history.slice(-500);
      fs.writeFileSync(tradeFile, JSON.stringify(history, null, 2));
      
      // 2. 按用户分文件存储
      const walletKey = (trade.wallet || 'admin').toLowerCase();
      const userTradeFile = path.join(dir, `bb-trades-${walletKey}.json`);
      let userHistory = [];
      if (fs.existsSync(userTradeFile)) {
        userHistory = JSON.parse(fs.readFileSync(userTradeFile, 'utf8'));
      }
      userHistory.push(trade);
      if (userHistory.length > 500) userHistory = userHistory.slice(-500);
      fs.writeFileSync(userTradeFile, JSON.stringify(userHistory, null, 2));
      
      this._log(`📝 交易历史已记录: ${trade.symbol} ${trade.side} PnL=$${trade.pnlUsd} | 用户=${walletKey.slice(0, 10)}...`);
    } catch (e) {
      this._log(`⚠️ 交易历史保存失败: ${e.message}`);
    }
  }

  // ═══ 状态持久化 ═══
  _saveState() {
    try {
      const dir = path.dirname(CONFIG.stateFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CONFIG.stateFile, JSON.stringify({
        positions: this.positions,
        savedAt: Date.now(),
      }, null, 2));
    } catch (e) {
      this._log(`⚠️ 状态保存失败: ${e.message}`);
    }
  }

  _loadState() {
    try {
      if (fs.existsSync(CONFIG.stateFile)) {
        const data = JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
        this.positions = data.positions || {};
        this._log(`📂 加载状态: ${Object.keys(this.positions).length}个持仓`);
      }
    } catch (e) {
      this._log(`⚠️ 状态加载失败: ${e.message}`);
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  stop() {
    this.running = false;
    this._log('🛑 BB Engine 停止');
  }
}

module.exports = { BBEngine, BinanceAPI, Indicators, CONFIG };
