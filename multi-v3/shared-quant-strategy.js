// ═══════════════════════════════════════════════════════
// 共享量化策略 — MultiEngine 百万用户框架的信号源
// 核心: 一套共享选币池(趋势池+震荡池) + 共享行情(dataBus.klines)
//       用最新双策略(严格MA7趋势 + 布林震荡)判信号, 产出共享多币信号池
//       所有用户在共享信号池上执行(不每用户重复算信号)
// ═══════════════════════════════════════════════════════
const { TrendStrategy } = require('../quant/trend-strategy');        // 最新严格MA7趋势
const { BollingerStrategy } = require('../quant/bollinger-strategy'); // 最新布林震荡

class SharedQuantStrategy {
  constructor(opts = {}) {
    this.dataBus = opts.dataBus || null;
    this.TREND_POOL = opts.trendPool || [];
    this.BOLLINGER_POOL = opts.bollPool || [];
    this.trend = new TrendStrategy();
    this.boll = new BollingerStrategy();
    this.COIN_POOL = [...new Set([...this.TREND_POOL, ...this.BOLLINGER_POOL])];
    this._signalCache = {};
    this._cacheTime = 0;
    this._cacheKey = '';
    this.cacheMs = opts.cacheMs || 15000;   // 共享信号缓存(15秒), 大幅减少重复计算
    this._log = opts.logFn || (() => {});
  }

  // 注入/刷新币池(与动态选币同步)
  setPools(trendPool, bollPool) {
    if (Array.isArray(trendPool)) this.TREND_POOL = trendPool;
    if (Array.isArray(bollPool)) this.BOLLINGER_POOL = bollPool;
    this.COIN_POOL = [...new Set([...this.TREND_POOL, ...this.BOLLINGER_POOL])];
    this._signalCache = {};
    this._cacheTime = 0;
    this._cacheKey = '';
  }

  // 从 dataBus 拿某币K线(5m, 池内币由DataBus负责拉取)
  async _klines(symbol) {
    if (!this.dataBus) return null;
    let kl = this.dataBus.klines?.[symbol];
    if (kl && kl.length >= 40) return kl;
    // fallback: 尝试主动拉一次(共享,不每用户)
    try { await this.dataBus.fetchKlines(symbol, '5m', 300); } catch (e) {}
    kl = this.dataBus.klines?.[symbol];
    return (kl && kl.length >= 40) ? kl : null;
  }

  // ═══ 核心: 计算共享多币信号池 ═══
  // 返回 { [symbol]: {direction:'long'|'short', signal:0..1, strategy, ts, reason} }
  getSignals() {
    // 缓存新鲜直接返回
    const key = this.COIN_POOL.join(',');
    if (this._cacheKey === key && this._cacheTime && Date.now() - this._cacheTime < this.cacheMs) {
      return this._signalCache;
    }
    return this._signalsRaw;   // 若正在异步计算则返回上次结果(防并发重复)
  }

  // 异步扫描(供 MultiEngine 循环调用, 计算后缓存)
  async scanSignals() {
    const key = this.COIN_POOL.join(',');
    // 缓存新鲜
    if (this._cacheKey === key && this._cacheTime && Date.now() - this._cacheTime < this.cacheMs) {
      return this._signalCache;
    }
    const now = Date.now();
    const signals = {};
    for (const symbol of this.COIN_POOL) {
      const kl = await this._klines(symbol).catch(() => null);
      if (!kl) continue;
      const inTrend = this.TREND_POOL.includes(symbol);
      const inBoll = this.BOLLINGER_POOL.includes(symbol);
      // 最新严格MA7趋势信号
      if (inTrend) {
        try {
          const sig = this.trend.entrySignal(kl, 'FLAT');
          if (sig.signal === 'LONG' || sig.signal === 'SHORT') {
            signals[symbol] = {
              direction: sig.signal === 'LONG' ? 'long' : 'short',
              signal: 0.75, confidence: 0.75, strategy: 'trend', ts: now, reason: sig.reason || '',
            };
          }
        } catch (e) {}
      }
      // 最新布林震荡信号
      if (inBoll && !signals[symbol]) {
        try {
          const gate = this.boll.canOpen(kl);
          if (gate.allowed) {
            const es = this.boll.entrySignal(kl, 'FLAT', false);
            if (es.signal === 'LONG' || es.signal === 'SHORT') {
              signals[symbol] = {
                direction: es.signal === 'LONG' ? 'long' : 'short',
                signal: 0.7, confidence: 0.7, strategy: 'bollinger', ts: now, reason: es.reason || '',
              };
            }
          }
        } catch (e) {}
      }
    }
    this._signalCache = signals;
    this._cacheKey = key;
    this._cacheTime = now;
    this._signalsRaw = signals;
    return signals;
  }

  getTrendPool() { return this.TREND_POOL; }
  getBollPool() { return this.BOLLINGER_POOL; }
}

module.exports = { SharedQuantStrategy };
