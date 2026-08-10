/**
 * 统一信号池 v1.0
 * 量化机器人的唯一信号来源 — 管理员和所有普通用户平级共享
 *
 * 架构:
 *   策略引擎(所有品种) → SignalPool.collect() → SignalPool.getTop()
 *   管理员账户 → getTop() → 执行
 *   普通用户1  → getTop() → 执行
 *   普通用户N  → getTop() → 执行
 */
class SignalPool {
  constructor() {
    this._signals = [];      // 当前轮信号
    this._timestamp = 0;     // 信号时间
    this._lock = false;      // 写入锁
  }

  /**
   * 收集信号 — 每轮扫描后调用
   * @param {Array} signals - [{symbol, dir, strength, confidence, score, market, source}]
   */
  collect(signals) {
    if (!Array.isArray(signals)) return;
    this._signals = signals.filter(s => s.dir === 'LONG' || s.dir === 'SHORT');
    this._timestamp = Date.now();
  }

  /**
   * 获取信号 — 管理员和所有用户共用
   * @param {Object} opts - { excludeSet: Set(已持仓品种), blacklist: Set(不可交易品种), maxCount }
   * @returns {Array} 排序后的候选信号
   */
  getTop(opts = {}) {
    const { excludeSet = new Set(), blacklist = new Set(), maxCount = 15 } = opts;
    const now = Date.now();
    // 信号超过3分钟过期
    if (now - this._timestamp > 180000) return [];
    return this._signals
      .filter(s => !excludeSet.has(s.symbol))
      .filter(s => !blacklist.has(s.symbol))
      .sort((a, b) => b.strength - a.strength)
      .slice(0, maxCount);
  }

  /**
   * 获取所有信号(不过滤)
   */
  getAll() {
    const now = Date.now();
    if (now - this._timestamp > 180000) return [];
    return [...this._signals];
  }

  get timestamp() { return this._timestamp; }
  get count() { return this._signals.length; }
}

// 单例
const pool = new SignalPool();
module.exports = pool;
module.exports.SignalPool = SignalPool;
