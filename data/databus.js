/**
 * DataBus - 统一数据总线
 * 职责：汇集所有市场数据源，供AI决策层消费
 */
const https = require('https');
const http = require('http');
const { RateLimiter, globalLimiter } = require('../saas/rate-limiter');
const WebSocket = require('ws');
const crypto = require('crypto');

class DataBus {
  constructor(config) {
    this.config = config;
    this.limiter = globalLimiter;
    this.marketData = {};       // 实时行情 {symbol: {price, volume24h, change24h, ...}}
    this.klines = {};           // K线数据 {symbol: [{open,high,low,close,volume,time},...]}
    this.depth = {};            // 深度数据
    this.fundingRates = {};     // 资金费率
    this.openInterest = {};     // 持仓量
    this.sentiment = null;      // 恐惧贪婪指数
    this.ws = null;
    this.wsAlive = false;
    this._wsLastMessage = Date.now();  // v13: WS最后消息时间
    this.listeners = new Map();
    // 修复：K线缓存定期清理，防止内存泄露
    this._klineCache = {};
    this._cacheCleanupInterval = setInterval(() => this._cleanupCache(), 5 * 60 * 1000); // 每5分钟清理一次
    this._log('DataBus initialized');
  }

  // 修复：清理过期的K线缓存
  _cleanupCache() {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5分钟过期
    let cleaned = 0;
    for (const key of Object.keys(this._klineCache)) {
      if (now - this._klineCache[key].time > maxAge) {
        delete this._klineCache[key];
        cleaned++;
      }
    }
    // 清理不再持仓的marketData
    const activeSymbols = new Set(Object.keys(this.klines));
    for (const sym of Object.keys(this.marketData)) {
      if (!activeSymbols.has(sym) && now - (this.marketData[sym].timestamp || 0) > 30 * 60 * 1000) {
        delete this.marketData[sym];
        delete this.klines[sym];
      }
    }
    if (cleaned > 0) this._log(`清理 ${cleaned} 个过期K线缓存`);
  }

  _log(msg) { console.log(`[DataBus] ${new Date().toISOString()} ${msg}`); }

  // ============ HTTP 请求工具 ============
  // v113.10: K线缓存已移到构造函数，定期自动清理
  
  _fetch(url, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      const timer = setTimeout(() => reject(new Error('timeout')), timeout);
      mod.get(url, { timeout }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { clearTimeout(timer); resolve(JSON.parse(data)); });
      }).on('error', e => { clearTimeout(timer); reject(e); });
    });
  }

  // ============ Binance REST 数据 ============
  async fetchTicker(symbol) {
    const url = `${this.config.binance.futuresBase}/fapi/v1/ticker/24hr?symbol=${symbol}`;
    const d = await this._fetch(url);
    const result = {
      price: parseFloat(d.lastPrice),
      change24h: parseFloat(d.priceChangePercent),
      volume24h: parseFloat(d.quoteVolume),
      high24h: parseFloat(d.highPrice),
      low24h: parseFloat(d.lowPrice),
      markPrice: null,
      indexPrice: null,
      timestamp: Date.now()
    };
    this.marketData[symbol] = { ...(this.marketData[symbol] || {}), ...result };
    return result;
  }

  async fetchKlines(symbol, interval = '5m', limit = 100) {
    // v113.10: 30秒内重复请求用缓存
    const cacheKey = `${symbol}_${interval}_${limit}`;
    const cached = this._klineCache[cacheKey];
    if (cached && Date.now() - cached.time < 30000) {
      this.klines[symbol] = cached.data;
      return cached.data;
    }
    // 限速
    await this.limiter.acquire(1);
    const url = `${this.config.binance.futuresBase}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const d = await this._fetch(url);
    const klines = d.map(k => ({
      time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      trades: parseInt(k[8])
    }));
    this.klines[symbol] = klines;
    this._klineCache[cacheKey] = { data: klines, time: Date.now() };
    return klines;
  }

  async fetchFundingRate(symbol) {
    const url = `${this.config.binance.futuresBase}/fapi/v1/fundingRate?symbol=${symbol}&limit=1`;
    const d = await this._fetch(url);
    const rate = d.length > 0 ? parseFloat(d[0].fundingRate) : 0;
    this.fundingRates[symbol] = { rate, timestamp: Date.now() };
    return rate;
  }

  async fetchOpenInterest(symbol) {
    const url = `${this.config.binance.futuresBase}/fapi/v1/openInterest?symbol=${symbol}`;
    const d = await this._fetch(url);
    const oi = parseFloat(d.openInterest);
    this.openInterest[symbol] = { oi, timestamp: Date.now() };
    return oi;
  }

  async fetchLongShortRatio(symbol, period = '5m') {
    const url = `${this.config.binance.futuresBase}/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=${period}&limit=1`;
    const d = await this._fetch(url);
    if (d.length > 0) {
      return { longRatio: parseFloat(d[0].longAccount), shortRatio: parseFloat(d[0].shortAccount), timestamp: Date.now() };
    }
    return { longRatio: 0.5, shortRatio: 0.5, timestamp: Date.now() };
  }

  // ============ 情绪数据 ============
  async fetchFearGreedIndex() {
    try {
      const d = await this._fetch('https://api.alternative.me/fng/?limit=1');
      if (d && d.data && d.data[0]) {
        this.sentiment = {
          value: parseInt(d.data[0].value),
          classification: d.data[0].value_classification,
          timestamp: Date.now()
        };
        return this.sentiment;
      }
    } catch (e) {
      this._log(`FearGreed fetch failed: ${e.message}`);
    }
    return this.sentiment || { value: 50, classification: 'Neutral', timestamp: Date.now() };
  }

  // ============ 计算技术指标 ============
  calculateIndicators(symbol) {
    const klines = this.klines[symbol];
    if (!klines || klines.length < 55) return null;

    const closes = klines.map(k => k.close);
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);
    const volumes = klines.map(k => k.volume);
    const currentPrice = closes[closes.length - 1];

    const ma7 = this._sma(closes, 7);
    const ma25 = this._sma(closes, 25);
    const ma29 = this._sma(closes, 29);
    const ma99 = this._sma(closes, 99);
    const rsi = this._rsi(closes, 14);
    const atr = this._atr(highs, lows, 14);
    const atrPercent = (atr / currentPrice * 100);
    const bb = this._bollingerBands(closes, 20, 2);
    const volSma = this._sma(volumes, 20);
    const currentVol = volumes[volumes.length - 1];
    const volRatio = volSma > 0 ? currentVol / volSma : 1;
    const adxData = this._calcADX(highs, lows, closes, 14);

    // BB pctB
    const pctB = bb.upper !== bb.lower ? (currentPrice - bb.lower) / (bb.upper - bb.lower) : 0.5;

    return {
      symbol,
      price: currentPrice,
      ma7, ma25, ma29, ma99,
      rsi,
      atr, atrPercent,
      adx: adxData.adx,
      plusDI: adxData.plusDI,
      minusDI: adxData.minusDI,
      bb: { upper: bb.upper, middle: bb.middle, lower: bb.lower, pctB, width: (bb.upper - bb.lower) / currentPrice * 100 },
      volume: { current: currentVol, avg: volSma, ratio: volRatio },
      timestamp: Date.now()
    };
  }

  _calcADX(highs, lows, closes, period = 14) {
    if (closes.length < period * 2) return { adx: 0, plusDI: 0, minusDI: 0 };
    const tr = [], plusDM = [], minusDM = [];
    for (let i = 1; i < highs.length; i++) {
      tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
      const up = highs[i] - highs[i - 1], down = lows[i - 1] - lows[i];
      plusDM.push(up > down && up > 0 ? up : 0);
      minusDM.push(down > up && down > 0 ? down : 0);
    }
    const smooth = (arr, p) => {
      const s = [arr.slice(0, p).reduce((a, b) => a + b, 0)];
      for (let i = p; i < arr.length; i++) s.push(s[s.length - 1] - s[s.length - 1] / p + arr[i]);
      return s;
    };
    const sTR = smooth(tr, period), sPDM = smooth(plusDM, period), sMDM = smooth(minusDM, period);
    const pdiArr = [], mdiArr = [], dxArr = [];
    for (let i = 0; i < sTR.length; i++) {
      const pdi = sTR[i] ? sPDM[i] / sTR[i] * 100 : 0;
      const mdi = sTR[i] ? sMDM[i] / sTR[i] * 100 : 0;
      pdiArr.push(pdi); mdiArr.push(mdi);
      dxArr.push(pdi + mdi ? Math.abs(pdi - mdi) / (pdi + mdi) * 100 : 0);
    }
    let adx = 0;
    if (dxArr.length >= period) adx = dxArr.slice(-period).reduce((a, b) => a + b, 0) / period;
    return { adx, plusDI: pdiArr[pdiArr.length - 1] || 0, minusDI: mdiArr[mdiArr.length - 1] || 0 };
  }

  // ============ WebSocket 实时数据 ============
  connectWS(symbols) {
    // v14: 先清理旧 WS，防止 close 事件触发自动重连
    if (this.ws) {
      this._wsManualClose = true;
      try { this.ws.removeAllListeners(); this.ws.close(); } catch(e) { /* cleanup */ }
      this.ws = null;
    }
    this._wsManualClose = false;

    // v18: Binance 单连接限制 200 streams，分批连接
    const BATCH_SIZE = 100; // 100 streams = 50 symbols per batch
    const batches = [];
    for (let i = 0; i < symbols.length; i += BATCH_SIZE / 2) {
      batches.push(symbols.slice(i, i + BATCH_SIZE / 2));
    }
    this._wsBatches = batches;
    this._wsBatchIdx = 0;
    this._wsReconnectCount = 0;
    this._connectBatch();
  }

  _connectBatch() {
    if (this._wsBatchIdx >= this._wsBatches.length) {
      this._log(`WS: all ${this._wsBatches.length} batches connected`);
      this._wsBatchIdx = 0;
      return;
    }
    const batch = this._wsBatches[this._wsBatchIdx];
    const streams = [];
    batch.forEach(s => {
      const sl = s.toLowerCase();
      streams.push(`${sl}@miniTicker`);
      streams.push(`${sl}@kline_1h`);
    });
    const url = `${this.config.binance.wsBase}/stream?streams=${streams.join('/')}`;
    this._log(`WS batch ${this._wsBatchIdx + 1}/${this._wsBatches.length}: ${batch.length} symbols (${streams.length} streams)...`);

    const ws = new WebSocket(url);
    let settled = false;

    ws.on('open', () => {
      if (settled) return;
      settled = true;
      this._log(`WS batch ${this._wsBatchIdx + 1} connected`);
      this.wsAlive = true;
      this._wsLastMessage = Date.now();
      this._wsReconnectCount = 0;
      // 连接下一批
      this._wsBatchIdx++;
      setTimeout(() => this._connectBatch(), 500);
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        const stream = msg.stream;
        const payload = msg.data;

        if (stream.includes('@miniTicker')) {
          const symbol = payload.s;
          if (!this.marketData[symbol]) this.marketData[symbol] = {};
          this.marketData[symbol].price = parseFloat(payload.c);
          this.marketData[symbol].volume24h = parseFloat(payload.q);
          this.marketData[symbol].high24h = parseFloat(payload.h);
          this.marketData[symbol].low24h = parseFloat(payload.l);
          this.marketData[symbol].timestamp = Date.now();
        }

        if (stream.includes('@kline_1h')) {
          const k = payload.k;
          const symbol = k.s;
          const kline = {
            time: k.t,
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.c),
            volume: parseFloat(k.v),
            trades: k.n
          };
          if (!this.klines[symbol]) this.klines[symbol] = [];
          const arr = this.klines[symbol];
          if (arr.length > 0 && arr[arr.length - 1].time === kline.time) {
            arr[arr.length - 1] = kline;
          } else if (arr.length > 0 && kline.time > arr[arr.length - 1].time) {
            arr.push(kline);
            if (arr.length > 100) arr.shift();
          }
        }

        this._wsLastMessage = Date.now();
        this.emit('data', { stream, payload });
      } catch (e) { /* ignore parse errors */ }
    });

    ws.on('close', () => {
      this.wsAlive = false;
      // v18: 无论 settled 状态，断线必须重连（永不死机核心）
      if (!this._wsManualClose) {
        this._wsReconnectCount++;
        if (this._wsReconnectCount > 10) {
          this._log(`WS batch ${this._wsBatchIdx + 1} failed 10x, 跳到下一批`);
          this._wsBatchIdx++;
          this._wsReconnectCount = 0;
        } else {
          this._log(`WS batch ${this._wsBatchIdx + 1} 断线, 重连 ${this._wsReconnectCount}/10`);
        }
        // v18: 永远重连，不放弃
        setTimeout(() => this._connectBatch(), 3000);
      }
    });

    ws.on('error', (err) => {
      this._log(`WS batch ${this._wsBatchIdx + 1} error: ${err.message.slice(0,50)}`);
      // error 后紧跟 close，由 close handler 重连
    });

    // 保存当前批次的 ws 引用（用于外部检查）
    this.ws = ws;
  }

  // ============ 事件系统 ============
  on(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(cb);
  }
  emit(event, data) {
    const cbs = this.listeners.get(event) || [];
    cbs.forEach(cb => { try { cb(data); } catch(e) { console.error(`[DataBus] event callback error (${event}): ${e.message}`); } });
  }

  // ============ 获取完整市场快照（AI消费用） ============
  async getMarketSnapshot(symbol) {
    // 如果没有数据或过期，先拉取
    const md = this.marketData[symbol];
    if (!md || Date.now() - (md.timestamp || 0) > 30000) {
      await this.fetchTicker(symbol);
    }
    if (!this.klines[symbol] || this.klines[symbol].length < 30) {
      // v113.70: 必须用1h K线 — 5m ATR太小导致吊灯止损严重偏移
      // 开仓用1h ATR=1.82%, 止损监控用5m ATR=0.53% → 止损线紧了3.4倍
      await this.fetchKlines(symbol, '1h', 150);
    }

    const indicators = this.calculateIndicators(symbol);

    // 资金费率/持仓量/多空比：缓存5分钟，避免频繁调用触发限速
    const now = Date.now();
    const fr = this.fundingRates[symbol];
    const funding = (fr && now - fr.timestamp < 300000) ? fr.rate : await this.fetchFundingRate(symbol);
    const oi = this.openInterest[symbol];
    const oiValue = (oi && now - oi.timestamp < 300000) ? oi.oi : await this.fetchOpenInterest(symbol);
    const ls = await this.fetchLongShortRatio(symbol);
    const sentiment = await this.fetchFearGreedIndex();

    return {
      symbol,
      ticker: this.marketData[symbol],
      indicators,
      funding,
      openInterest: oiValue,
      longShortRatio: ls,
      sentiment,
      timestamp: Date.now()
    };
  }

  // ============ 技术指标计算工具函数 ============
  _sma(arr, period) {
    if (arr.length < period) return arr[arr.length - 1] || 0;
    const slice = arr.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
  }

  _rsi(arr, period = 14) {
    if (arr.length < period + 1) return 50;
    const changes = [];
    for (let i = arr.length - period; i < arr.length; i++) {
      changes.push(arr[i] - arr[i - 1]);
    }
    const gains = changes.filter(c => c > 0);
    const losses = changes.filter(c => c < 0).map(c => Math.abs(c));
    const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  _atr(highs, lows, period = 14) {
    if (highs.length < 2) return 0;
    const trs = [];
    for (let i = Math.max(1, highs.length - period); i < highs.length; i++) {
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - highs[i - 1]),
        Math.abs(lows[i] - lows[i - 1])
      );
      trs.push(tr);
    }
    return trs.reduce((a, b) => a + b, 0) / trs.length;
  }

  _bollingerBands(arr, period = 20, stdDev = 2) {
    const slice = arr.slice(-period);
    const sma = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((acc, val) => acc + Math.pow(val - sma, 2), 0) / slice.length;
    const std = Math.sqrt(variance);
    return { upper: sma + std * stdDev, middle: sma, lower: sma - std * stdDev };
  }

  // v74: HTTP获取所有symbol的ticker价格（WS fallback）
  async fetchAllTickers(symbols) {
    try {
      // v74: 逐个获取价格，避免URL过长
      // v113.13.5: 走rate-limiter避免封禁
      for (const sym of symbols) {
        const url = `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${sym}`;
        try {
          await this.limiter.acquire(1);
          const data = await this._fetch(url, 3000);
          if (data && data.price) {
            if (!this.marketData[sym]) this.marketData[sym] = {};
            this.marketData[sym].price = parseFloat(data.price);
            this.marketData[sym].timestamp = Date.now();
          }
        } catch(e) {}
      }
      this._log(`HTTP Tickers: ${symbols.length} symbols updated`);
    } catch(e) { this._log(`HTTP Tickers error: ${e.message}`); }
  }

  // v18: WS 自动重连守护 — 每 60 秒检查，挂了就全部重连
  startHealthGuard(symbols) {
    this._healthGuardSymbols = symbols;
    if (this._healthGuardTimer) clearInterval(this._healthGuardTimer);
    this._healthGuardTimer = setInterval(() => {
      const lastMsg = this._wsLastMessage || 0;
      const deadSec = (Date.now() - lastMsg) / 1000;
      if (deadSec > 60) {
        this._log(`⚠️ WS 健康守护: ${deadSec.toFixed(0)}s 无消息，强制重连所有 batch...`);
        this.wsAlive = false;
        if (this._healthGuardSymbols && this._healthGuardSymbols.length > 0) {
          this.connectWS(this._healthGuardSymbols);
        }
      }
    }, 60000);
    this._log('WS 健康守护已启动 (60s 检查间隔)');
  }

  stopHealthGuard() {
    if (this._healthGuardTimer) { clearInterval(this._healthGuardTimer); this._healthGuardTimer = null; }
  }

  disconnect() {
    this._wsManualClose = true;
    if (this.ws) { try { this.ws.removeAllListeners(); this.ws.close(); } catch(e) { /* cleanup */ } this.ws = null; }
    // 修复：清理缓存定时器
    if (this._cacheCleanupInterval) { clearInterval(this._cacheCleanupInterval); this._cacheCleanupInterval = null; }
    this._log('Disconnected');
  }

  /**
   * v108.2: 获取最新市场数据（供 MultiEngine v3 百万用户框架使用）
   * 返回 BTCUSDT 的实时数据，格式兼容 _getMockMarketData
   */
  getLatestData() {
    const btc = this.marketData['BTCUSDT'];
    if (!btc || !btc.price) return null;

    const klines = this.klines['BTCUSDT'] || [];
    const prices = klines.map(k => k.close);
    const volumes = klines.map(k => k.volume);

    return {
      price: btc.price,
      prices: prices.length >= 10 ? prices : Array.from({ length: 100 }, (_, i) => btc.price * (1 + Math.sin(i / 10) * 0.001)),
      volumes: volumes.length >= 10 ? volumes : Array.from({ length: 100 }, () => 1000 + Math.random() * 3000),
      timestamp: Date.now(),
      change24h: btc.change24h || 0,
      volume24h: btc.volume24h || 0,
    };
  }
}

module.exports = DataBus;
