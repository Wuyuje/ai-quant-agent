/**
 * SharedMarket — 共享行情缓存（百万用户框架核心组件）
 *
 * 作用：所有用户的公开行情（24h ticker、K线、exchangeInfo）只向币安拉一次，
 *       其他用户/引擎共用缓存，大幅减少 API 调用，避免百万用户时被限流/封IP。
 *
 * 原则：
 *   - 只缓存**公开/非用户私有**的行情数据
 *   - 签名/私有 API（下单、余额、持仓、划转）仍走各用户自己的 BinanceAPI，完全隔离
 *   - 每次真实拉取都走 ipLimiter（全局IP限速），防止IP被封
 *
 * 用法：由 DualStrategyManager 创建单例，注入各引擎的 this.api
 *   const shared = new SharedMarket();
 *   engine.api.getKlines = (s,i,l) => shared.getKlines(s,i,l);  // 可选注入
 *
 * 回退：若共享缓存异常，调用方应回落到自己的 BinanceAPI（引擎层保底）
 */

const os = require('os');
const path = require('path');
const https = require('https');
let ipLimiter = null;
try { ({ ipLimiter } = require('./api-rate-limiter')); } catch (e) { ipLimiter = null; }

class SharedMarket {
  constructor(opts = {}) {
    this._tickers = null;
    this._tickersTime = 0;
    this._klineCache = {};       // `${symbol}_${interval}_${limit}` → { data, time }
    this._precisionMap = null;
    this._precisionTime = 0;
    // TTL 可调；扫描间隔 60s，ticker 缓存 15s 足够(避免选币数据过旧)
    this.TICKER_TTL = opts.tickerTTL || 15000;
    this.KLINE_TTL = opts.klineTTL || 30000;      // 30秒 K线缓存(信号仍准)
    this.PRECISION_TTL = opts.precisionTTL || 3600000; // 1小时
    this._stats = { ticker: 0, kline: 0, exchange: 0, dedup: 0 };
    this._inflight = {}; // single-flight 去重: key → Promise
  }

  // single-flight：同一时刻多个 key 相同调用只拉一次真实数据，其余共用 result
  _singleFlight(key, fn) {
    if (this._inflight[key]) return this._inflight[key];
    const p = fn().catch(e => {
      // 失败后清掉标记，允许下次重试
      delete this._inflight[key];
      throw e;
    });
    // 无论成功失败都清掉标记（成功后下次会走缓存）
    this._inflight[key] = p;
    p.finally(() => { delete this._inflight[key]; }).catch(() => {});
    return p;
  }

  // 通用 GET（带 IP 限速，防止封 IP）
  _get(endpoint) {
    return new Promise((resolve, reject) => {
      const doReq = () => {
        const url = `https://fapi.binance.com${endpoint}`;
        const req = https.get(url, { timeout: 10000 }, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(new Error(`Parse error: ${data.substring(0, 120)}`)); }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('request timeout')); });
      };
      // 有 limiter 则等待排队，控制 IP 总请求率
      if (ipLimiter && typeof ipLimiter.wait === 'function') {
        ipLimiter.wait().then(doReq).catch(doReq);
      } else {
        doReq();
      }
    });
  }

  /**
   * 24h ticker —— 所有引擎选币共用一份
   */
  /**
   * 24h ticker —— 所有引擎选币共用一份
   * single-flight：缓存过期时只发起一个真实请求，其他并发调用共用同一结果
   */
  getAllTickers() {
    return this._singleFlight('ticker', () => this._fetchTickers());
  }

  _fetchTickers() {
    return new Promise(async (resolve, reject) => {
      try {
        const now = Date.now();
        if (this._tickers && now - this._tickersTime < this.TICKER_TTL) {
          this._stats.dedup++;
          return resolve(this._tickers);
        }
        const data = await this._get('/fapi/v1/ticker/24hr');
        if (Array.isArray(data) && data.length > 0) {
          this._tickers = data;
          this._tickersTime = now;
          this._stats.ticker++;
        }
        resolve(this._tickers || data);
      } catch (e) {
        if (this._tickers) resolve(this._tickers); // 失败返回旧缓存
        else reject(e);
      }
    });
  }

  /**
   * K线 —— 不同用户可能监控同一 symbol，共用同一份 K线
   */
  async getKlines(symbol, interval, limit) {
    const key = `${symbol}_${interval}_${limit}`;
    return this._singleFlight('k_' + key, () => this._fetchKlines(symbol, interval, limit, key));
  }

  _fetchKlines(symbol, interval, limit, key) {
    return new Promise(async (resolve, reject) => {
      try {
        const now = Date.now();
        const cached = this._klineCache[key];
        if (cached && now - cached.time < this.KLINE_TTL) {
          this._stats.dedup++;
          return resolve(cached.data);
        }
        const data = await this._get(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
        if (!Array.isArray(data)) throw new Error('klines data invalid');
        const parsed = data.map(k => ({
          time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
          low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
        }));
        this._klineCache[key] = { data: parsed, time: now };
        this._stats.kline++;
        resolve(parsed);
      } catch (e) {
        if (this._klineCache[key]) resolve(this._klineCache[key].data);
        else reject(e);
      }
    });
  }

  /**
   * exchangeInfo 精度表 —— 所有用户共用（1小时缓存）
   */
  async getExchangeInfo() {
    const now = Date.now();
    if (this._precisionMap && now - this._precisionTime < this.PRECISION_TTL) {
      this._stats.dedup++;
      return this._precisionMap;
    }
    try {
      const info = await this._get('/fapi/v1/exchangeInfo');
      if (!info || !info.symbols || !Array.isArray(info.symbols)) throw new Error('exchangeInfo invalid');
      const precisionMap = {};
      for (const s of info.symbols) {
        const stepSize = s.filters.find(f => f.filterType === 'LOT_SIZE')?.stepSize || '0.001';
        precisionMap[s.symbol] = { stepSize, qtyPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision };
      }
      this._precisionMap = precisionMap;
      this._precisionTime = now;
      this._stats.exchange++;
      return precisionMap;
    } catch (e) {
      if (this._precisionMap) return this._precisionMap;
      throw e;
    }
  }

  /** 清空缓存（调试/换行情环境时用） */
  clear() {
    this._tickers = null;
    this._tickersTime = 0;
    this._klineCache = {};
    this._precisionMap = null;
    this._precisionTime = 0;
  }

  /** 缓存命中统计 */
  getStats() { return { ...this._stats }; }
}

module.exports = { SharedMarket };
