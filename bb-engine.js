/**
 * BB Engine — 孙总布林带策略引擎 (独立版)
 * 
 * 核心策略：
 *   1. 50强流动性选币 + 浮盈±≤1% + 同时5个币种
 *   2. 5min布林带开仓，收盘价判定
 *   3. 插针过滤：只用收盘价，单K>3%作废，插针回归不执行
 *   4. 开仓准入：带宽分位>90%禁开，<85%+连续3根收窄才解禁
 *   5. 双模式止盈：浮盈≥2%触发，常态轨道止盈 + 放量ATR跟踪止盈
 *   6. 补仓：收口后间隔3根K线，50%/30%/20% 三次
 *   7. 单K线浮亏≥本金20%全仓止损
 *   8. 3次补完+总浮亏≥70%终极止损全平
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
  maxPositions: 5,          // 同时持仓5个币种
  topN: 50,                 // 前50强流动性
  floatProfitPct: 1.0,      // 浮盈±≤1%
  leverage: 3,              // 默认杠杆
  perPositionPct: 0.15,    // 单仓位占总资金15%
  
  // K线参数
  klineInterval: '5m',
  klineLimit: 200,           // 拉取200根5min K线
  bbPeriod: 20,              // 布林带周期20
  bbStd: 2.0,                // 2倍标准差
  
  // 开仓准入
  bandwidthPercentileLookback: 100,  // 100根K线带宽分位
  bandwidthOpenBlock: 90,             // >90%禁开
  bandwidthOpenAllow: 85,             // <85%解禁
  narrowCount: 3,                     // 连续3根收窄
  
  // 止盈
  profitTriggerPct: 2.0,    // 浮盈≥2%触发止盈
  volumeSpikeRatio: 1.8,     // 放量倍数>1.8
  volumeMaPeriod: 20,        // 20周期均量
  atrPeriod: 14,             // ATR周期
  atrTrailMultiplier: 0.3,  // 0.3 ATR跟踪
  
  // 补仓
  maxReplenish: 3,           // 最多补3次
  replenishInterval: 3,      // 收口后间隔3根K线
  replenishRatios: [0.50, 0.30, 0.20], // 50% 30% 20%
  
  // 止损
  singleKLossPct: 20,       // 单K浮亏≥本金20%止损
  ultimateLossPct: 70,       // 总浮亏≥70%终极止损
  
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
      https.get(url, { timeout: 10000 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`Parse error: ${data.substring(0, 100)}`)); }
        });
      }).on('error', reject);
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

  // 设置杠杆
  async setLeverage(symbol, leverage) {
    try {
      return await this._request('POST', '/fapi/v1/leverage', { symbol, leverage });
    } catch (e) { /* ignore */ }
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
      return Math.floor(qty / step) * step;
    }
    const p = info.qtyPrecision || 3;
    return parseFloat(qty.toFixed(p));
  }

  // 市价开多
  async marketLong(symbol, qty, leverage, precisionMap) {
    try {
      qty = this._fixQty(symbol, qty, precisionMap);
      if (!qty || qty <= 0) return { success: false, error: 'qty too small' };
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
  async marketShort(symbol, qty, leverage, precisionMap) {
    try {
      qty = this._fixQty(symbol, qty, precisionMap);
      if (!qty || qty <= 0) return { success: false, error: 'qty too small' };
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
    this.wallet = null;       // 钱包地址（UserBBEngine设置，用于服务费判断）
    this._feeState = null;   // 服务费状态
    this._log('BB Engine 初始化完成');
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
    const usdtPerps = allTickers.filter(t => 
      t.symbol.endsWith('USDT') && 
      parseFloat(t.quoteVolume) > 0 &&
      !t.symbol.includes('_')
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

    // (2) 开仓解禁：必须同时满足
    //    - 带宽分位 < 85%
    //    - 连续3根5min K线布林轨道间距持续收窄（收口）
    if (bwPercentile >= CONFIG.bandwidthOpenAllow) {
      return { allowed: false, reason: `带宽分位${bwPercentile.toFixed(0)}%≥85% — 未解禁`, bwPercentile };
    }

    const isNarrowing = Indicators.isNarrowing(klines, CONFIG.narrowCount);
    if (!isNarrowing) {
      return { allowed: false, reason: `布林带未连续${CONFIG.narrowCount}根收窄`, bwPercentile };
    }

    // (3) 开仓信号确认
    const bb = Indicators.bollinger(klines, CONFIG.bbPeriod, CONFIG.bbStd);
    if (!bb) {
      return { allowed: false, reason: '布林带数据不足' };
    }

    const lastClose = klines[klines.length - 1].close;
    
    // 开多：5min收盘价触及/跌破下轨
    if (lastClose <= bb.lower) {
      return { 
        allowed: true, 
        direction: 'LONG', 
        bb, 
        bwPercentile, 
        reason: `收盘价${lastClose.toFixed(6)}触及下轨${bb.lower.toFixed(6)}` 
      };
    }

    // 开空：5min收盘价触及/突破上轨
    if (lastClose >= bb.upper) {
      return { 
        allowed: true, 
        direction: 'SHORT', 
        bb, 
        bwPercentile, 
        reason: `收盘价${lastClose.toFixed(6)}触及上轨${bb.upper.toFixed(6)}` 
      };
    }

    return { allowed: false, reason: `收盘价${lastClose.toFixed(6)}在轨道内，未触发`, bwPercentile };
  }

  // ═══ 5. 双模式止盈 ═══
  checkTakeProfit(klines, pos) {
    const bb = Indicators.bollinger(klines, CONFIG.bbPeriod, CONFIG.bbStd);
    if (!bb) return { action: 'HOLD' };

    const lastK = klines[klines.length - 1];
    const close = lastK.close;  // 只用收盘价
    const pnlPct = this._calcPnlPct(pos, close);

    // 统一前提：持仓浮盈 ≥ 2% 才触发止盈
    if (pnlPct < CONFIG.profitTriggerPct) {
      return { action: 'HOLD', pnlPct, reason: `浮盈${pnlPct.toFixed(2)}%<2%` };
    }

    // 判断放量移动止盈触发条件
    const volMA = Indicators.volumeMA(klines, CONFIG.volumeMaPeriod);
    const volSpike = lastK.volume > volMA * CONFIG.volumeSpikeRatio;
    const expanding = Indicators.isExpanding(klines);

    if (volSpike && expanding) {
      // 放量移动止盈模式
      const atr = Indicators.atr(klines, CONFIG.atrPeriod);
      
      if (pos.side === 'LONG') {
        // 多单：阶段最低点 + 0.3ATR为止盈线，跌破全平
        const stageLow = this._getStageLow(klines, pos);
        const trailPrice = stageLow + atr * CONFIG.atrTrailMultiplier;
        pos.mode = 'ATR';
        pos.atrTrailPrice = trailPrice;
        if (close < trailPrice) {
          return { action: 'CLOSE', reason: `ATR跟踪止盈: 收盘${close.toFixed(6)}<止盈线${trailPrice.toFixed(6)}(低点${stageLow.toFixed(6)}+0.3ATR)`, pnlPct };
        }
        return { action: 'HOLD', reason: `ATR跟踪中: 止盈线${trailPrice.toFixed(6)} 收盘${close.toFixed(6)}`, pnlPct, mode: 'ATR' };
      } else {
        // 空单：阶段最高点 - 0.3ATR为止盈线，突破全平
        const stageHigh = this._getStageHigh(klines, pos);
        const trailPrice = stageHigh - atr * CONFIG.atrTrailMultiplier;
        pos.mode = 'ATR';
        pos.atrTrailPrice = trailPrice;
        if (close > trailPrice) {
          return { action: 'CLOSE', reason: `ATR跟踪止盈: 收盘${close.toFixed(6)}>止盈线${trailPrice.toFixed(6)}(高点${stageHigh.toFixed(6)}-0.3ATR)`, pnlPct };
        }
        return { action: 'HOLD', reason: `ATR跟踪中: 止盈线${trailPrice.toFixed(6)} 收盘${close.toFixed(6)}`, pnlPct, mode: 'ATR' };
      }
    }

    // 布林带收口后自动切回轨道止盈模式
    if (pos.mode === 'ATR' && Indicators.isContracting(klines)) {
      pos.mode = '轨道';
      this._log(`🔄 ${pos.symbol} 布林带收口，切回轨道止盈模式`);
    }

    // 常态轨道止盈
    if (pos.mode !== 'ATR') {
      pos.mode = '轨道';
      
      // ① 一级止盈：收盘价触碰布林中轨，满足盈利条件全仓平仓
      if (pos.side === 'LONG' && close >= bb.mid) {
        return { action: 'CLOSE', reason: `轨道止盈: 多单收盘${close.toFixed(6)}触碰中轨${bb.mid.toFixed(6)}`, pnlPct };
      }
      if (pos.side === 'SHORT' && close <= bb.mid) {
        return { action: 'CLOSE', reason: `轨道止盈: 空单收盘${close.toFixed(6)}触碰中轨${bb.mid.toFixed(6)}`, pnlPct };
      }

      // ② 二级兜底：未触发中轨止盈，等待反向轨道触碰止盈
      if (pos.side === 'LONG' && close >= bb.upper) {
        return { action: 'CLOSE', reason: `二级兜底: 多单收盘触碰上轨${bb.upper.toFixed(6)}`, pnlPct };
      }
      if (pos.side === 'SHORT' && close <= bb.lower) {
        return { action: 'CLOSE', reason: `二级兜底: 空单收盘触碰下轨${bb.lower.toFixed(6)}`, pnlPct };
      }

      return { action: 'HOLD', reason: `轨道止盈等待: 收盘${close.toFixed(6)} 中轨${bb.mid.toFixed(6)}`, pnlPct, mode: '轨道' };
    }

    return { action: 'HOLD', reason: `ATR跟踪中`, pnlPct, mode: 'ATR' };
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

  // ═══ 7. 单K线止损 ═══
  checkSingleKStopLoss(klines, pos) {
    // 单K线浮亏达到单笔本金20%，直接全仓止损
    const lastK = klines[klines.length - 1];
    const prevK = klines[klines.length - 2];
    if (!prevK) return { action: 'HOLD' };

    // 单K线浮亏 = 本金 × (这根K线的亏损比例)
    // 用收盘价计算
    let klineLossPct;
    if (pos.side === 'LONG') {
      klineLossPct = (prevK.close - lastK.close) / prevK.close * 100 * pos.leverage;
    } else {
      klineLossPct = (lastK.close - prevK.close) / prevK.close * 100 * pos.leverage;
    }

    if (klineLossPct >= CONFIG.singleKLossPct) {
      return { 
        action: 'CLOSE', 
        reason: `⚠️单K止损: 第${klines.length}根K线浮亏${klineLossPct.toFixed(1)}%≥本金${CONFIG.singleKLossPct}%`,
        klineLossPct 
      };
    }

    return { action: 'HOLD', klineLossPct };
  }

  // ═══ 8. 终极止损 ═══
  checkUltimateStopLoss(pos) {
    // 触发条件：3次补仓全部完成 + 总浮亏 ≥ 持仓金额70%
    if (pos.replenishCount < CONFIG.maxReplenish) {
      return { action: 'HOLD' };
    }

    const totalLossPct = this._calcTotalLossPct(pos);
    if (totalLossPct >= CONFIG.ultimateLossPct) {
      return { 
        action: 'CLOSE', 
        reason: `🚨终极止损: 3次补完+总浮亏${totalLossPct.toFixed(1)}%≥${CONFIG.ultimateLossPct}%`,
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

        // ── 7. 单K线止损 ──
        const slResult = this.checkSingleKStopLoss(klines, pos);
        if (slResult.action === 'CLOSE') {
          this._log(`🔴 ${symbol} ${slResult.reason}`);
          await this._closePosition(symbol, pos, slResult.reason);
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
    const positionCount = Object.keys(this.positions).length;
    if (positionCount >= CONFIG.maxPositions) {
      this._log(`📊 持仓${positionCount}/${CONFIG.maxPositions}已满，不开新仓`);
      this._saveState();
      return;
    }

    // 只扫描不在持仓中的候选币
    const symbolsToScan = candidateSymbols.filter(s => !this.positions[s]);
    
    for (const symbol of symbolsToScan) {
      if (Object.keys(this.positions).length >= CONFIG.maxPositions) break;

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
        await this._openPosition(symbol, openCheck.direction, klines);

      } catch (e) {
        // 打印错误，不再静默吞掉
        this._log(`❌ ${symbol} 开仓异常: ${e.message}`);
      }
    }

    this._saveState();
  }

  // ═══ 开仓执行 ═══
  async _openPosition(symbol, direction, klines) {
    const price = klines[klines.length - 1].close;
    
    // 余额不足时跳过开仓
    if (!this.balance || this.balance <= 0) {
      this._log(`⏭️ ${symbol} ${direction} 跳过开仓: 余额=$${(this.balance||0).toFixed(2)}`);
      return;
    }
    
    // 计算仓位大小
    const positionMargin = this.balance * CONFIG.perPositionPct;
    const notional = positionMargin * CONFIG.leverage;
    const qty = notional / price;

    let result;
    if (direction === 'LONG') {
      result = await this.api.marketLong(symbol, qty, CONFIG.leverage, this.precisionMap);
    } else {
      result = await this.api.marketShort(symbol, qty, CONFIG.leverage, this.precisionMap);
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
        mode: '轨道',
        atrTrailPrice: null,
        currentPrice: price,
      };
      this._log(`✅ ${symbol} ${direction} 开仓成功 qty=${result.qty || qty} price=${price} margin=$${positionMargin.toFixed(2)} lev=${CONFIG.leverage}x`);
      this._saveState();
    } else {
      this._log(`❌ ${symbol} ${direction} 开仓失败: ${result.error}`);
    }
  }

  // ═══ 服务费/生态费配置 ═══
  // 普通用户: 生态费10% + 服务费20% = 实得70%（仅盈利时收取）
  // 管理员: 0% 全免
  static FEE_CONFIG = {
    PLATFORM_FEE_RATE: 0.20,   // 20% 服务费
    ECO_FUND_RATE: 0.10,       // 10% 生态费
    USER_SHARE_RATE: 0.70,     // 70% 用户实得
    PLATFORM_WALLET: '0xb6DEb31484353AdDaA5b6A105A2B758Df11bC28A',  // 服务费钱包
    ECO_FUND_WALLET: '0xeF87e7fD5f0ADC5de82e84Dc9300002D9aC8bD82',  // 生态费钱包
    ADMIN_WALLETS: [
      '0xfa3b90c574469909d20848273c06752a22fde74a',
      '0xe6ddf0771c7610dba77eb5a07ba7771dd7f5e91e',
    ],
    FEE_THRESHOLD: 5,          // 累计费用≥$5才转账
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
      fs.writeFileSync(BBEngine.FEE_CONFIG.FEE_STATE_FILE, JSON.stringify(this._feeState, null, 2));
    } catch (e) { /* ignore */ }
  }

  async _collectServiceFee(symbol, pnlUsd) {
    if (pnlUsd <= 0) return;

    // 管理员豁免
    if (this._isAdmin()) {
      this._log(`💰 Admin ${symbol} +$${pnlUsd.toFixed(2)} — 全额到帐，免服务费`);
      return;
    }

    if (!this._feeState) this._loadFeeState();

    const { PLATFORM_FEE_RATE, ECO_FUND_RATE, USER_SHARE_RATE } = BBEngine.FEE_CONFIG;
    const platformFee = pnlUsd * PLATFORM_FEE_RATE;
    const ecoFund = pnlUsd * ECO_FUND_RATE;
    const userShare = pnlUsd * USER_SHARE_RATE;

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
      + ` | 生态费 $${ecoFund.toFixed(2)} (10%)`
      + ` | 服务费 $${platformFee.toFixed(2)} (20%)`
      + ` | 实得 $${userShare.toFixed(2)} (70%)`
    );

    this._saveFeeState();
    await this._tryBatchFeeTransfer(walletKey);
  }

  async _tryBatchFeeTransfer(walletKey) {
    const pending = this._feeState.pending[walletKey] || [];
    if (pending.length === 0) return;

    const totalPlatform = pending.reduce((s, r) => s + parseFloat(r.platformFee), 0);
    const totalEco = pending.reduce((s, r) => s + parseFloat(r.ecoFund), 0);
    const totalFee = totalPlatform + totalEco;

    if (totalFee < BBEngine.FEE_CONFIG.FEE_THRESHOLD) {
      this._log(`📊 ${walletKey.slice(0,10)} 累计费用 $${totalFee.toFixed(2)} < $${BBEngine.FEE_CONFIG.FEE_THRESHOLD} 阈值，继续积累`);
      return;
    }

    this._log(`💸 ${walletKey.slice(0,10)} 累计费用 $${totalFee.toFixed(2)} 达到阈值，开始批量转账`);

    const { PLATFORM_WALLET, ECO_FUND_WALLET } = BBEngine.FEE_CONFIG;

    // 转服务费
    let platformOk = false;
    try {
      this._log(`💸 ${walletKey.slice(0,10)} 转账 $${totalPlatform.toFixed(2)} 平台费 → ${PLATFORM_WALLET.slice(0,10)}...`);
      const platformResult = await this.api.transferFeeToWallet(totalPlatform, PLATFORM_WALLET);
      if (platformResult.success) {
        this._log(`✅ 平台费转账成功 $${totalPlatform.toFixed(2)} USDT`);
        platformOk = true;
      } else {
        this._log(`❌ 平台费转账失败: ${platformResult.error}`);
      }
    } catch (e) {
      this._log(`❌ 平台费转账异常: ${e.message}`);
    }

    // 等待内部转账到账
    await new Promise(r => setTimeout(r, 3000));

    // 转生态费
    let ecoOk = false;
    try {
      this._log(`💸 ${walletKey.slice(0,10)} 转账 $${totalEco.toFixed(2)} 生态基金 → ${ECO_FUND_WALLET.slice(0,10)}...`);
      const ecoResult = await this.api.transferFeeToWallet(totalEco, ECO_FUND_WALLET);
      if (ecoResult.success) {
        this._log(`✅ 生态基金转账成功 $${totalEco.toFixed(2)} USDT`);
        ecoOk = true;
      } else {
        this._log(`❌ 生态基金转账失败: ${ecoResult.error}`);
      }
    } catch (e) {
      this._log(`❌ 生态基金转账异常: ${e.message}`);
    }

    // 全部成功才从 pending 移除
    if (platformOk && ecoOk) {
      const removed = pending.splice(0, pending.length);
      for (const record of removed) {
        record.status = 'auto-collected';
        record.collectedAt = Date.now();
        if (!this._feeState.collected[walletKey]) this._feeState.collected[walletKey] = [];
        this._feeState.collected[walletKey].push(record);
      }
      this._log(`✅ ${walletKey.slice(0,10)} 批量费用转账完成，已收取 ${removed.length} 笔`);
    } else {
      this._log(`⚠️ ${walletKey.slice(0,10)} 部分转账失败，费用保留在 pending 中下次重试`);
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
      
      // ═══ 服务费/生态费自动提取（仅盈利时，普通用户）═══
      if (pnlUsd > 0) {
        await this._collectServiceFee(symbol, pnlUsd);
      }
      
      // 回调通知 manager 更新统计
      if (this.onPositionClosed) this.onPositionClosed(tradeRecord);
      
      delete this.positions[symbol];
      this._saveState();
    } else {
      this._log(`⚠️ ${symbol} 平仓失败: ${result.error} — 清除本地状态`);
      delete this.positions[symbol];
      this._saveState();
    }
  }

  // ═══ 补仓执行 ═══
  async _replenishPosition(symbol, pos, amountUsd) {
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

      // 同步远程持仓的当前价格
      for (const rp of remotePositions) {
        const symbol = rp.symbol;
        const amt = parseFloat(rp.positionAmt);
        const entry = parseFloat(rp.entryPrice);
        const markPrice = parseFloat(rp.markPrice);
        
        if (this.positions[symbol]) {
          // 更新当前价格
          this.positions[symbol].currentPrice = markPrice;
          // 如果远程qty和本地不一致，以远程为准
          if (Math.abs(Math.abs(amt) - this.positions[symbol].qty) > this.positions[symbol].qty * 0.01) {
            this._log(`🔄 ${symbol} 同步qty: 本地${this.positions[symbol].qty} → 远程${Math.abs(amt)}`);
            this.positions[symbol].qty = Math.abs(amt);
          }
        }
      }

      // 清除远程已不存在的本地持仓
      for (const symbol of Object.keys(this.positions)) {
        const exists = remotePositions.some(rp => rp.symbol === symbol && Math.abs(parseFloat(rp.positionAmt)) > 0);
        if (!exists) {
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
