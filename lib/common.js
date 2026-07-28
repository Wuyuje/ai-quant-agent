/**
 * 通用模块 — BinanceAPI + Indicators
 * BB策略和趋势策略共用
 */

const crypto = require('crypto');
const https = require('https');
const path = require('path');

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

module.exports = { BinanceAPI, Indicators };
