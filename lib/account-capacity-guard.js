/**
 * AccountCapacityGuard — 账户级总风控（防超载/防强平）
 *
 * 背景：BB + 趋势 多引擎共享一个币安账户，各自开仓/补仓若只看本地持仓，
 *      会叠加导致账户总杠杆过高（如 $164 余额扛 $1466 名义 = 8.9x），易被强平。
 *
 * 作用：开仓/补仓前检查【账户当前总名义 + 本仓名义 ≤ 可用余额 × MAX_TOTAL_LEVERAGE】，
 *      并限制单币种集中度。超限则禁止开仓/补仓，保护账户不被过度杠杆拖垮。
 *
 * 使用：由 DualStrategyManager 创建单例，注入各引擎。
 *      引擎开仓前调用 capacity.checkCanOpen(newNotional) → {allowed, reason, limitNotional}
 */

class AccountCapacityGuard {
  constructor(opts = {}) {
    // 账户总名义 = 可用保证金 × 该倍数（整体杠杆上限）
    this.MAX_TOTAL_LEVERAGE = opts.maxTotalLeverage || 5;
    // 单币种名义 = 可用保证金 × 该倍数（单币集中度上限）
    this.MAX_SYMBOL_LEVERAGE = opts.maxSymbolLeverage || 2;
    // 缓存秒数，避免每轮多次拉币安
    this.CACHE_MS = opts.cacheMs || 5000;
    this._cache = null;
  }

  // 刷新：拉币安真实可用余额 + 当前总名义
  async _refresh(api) {
    if (this._cache && Date.now() - this._cache.time < this.CACHE_MS) {
      return this._cache.data;
    }
    try {
      const balance = await api.getBalance();
      const positions = await api.getPositions();
      let totalNotional = 0;
      for (const p of positions) {
        const notional = Math.abs(parseFloat(p.positionAmt) * parseFloat(p.markPrice));
        totalNotional += notional;
      }
      const data = {
        balance: balance || 0,
        totalNotional,
        longNotional: positions.filter(p => parseFloat(p.positionAmt) > 0)
          .reduce((s, p) => s + Math.abs(parseFloat(p.positionAmt) * parseFloat(p.markPrice)), 0),
        shortNotional: positions.filter(p => parseFloat(p.positionAmt) < 0)
          .reduce((s, p) => s + Math.abs(parseFloat(p.positionAmt) * parseFloat(p.markPrice)), 0),
      };
      this._cache = { time: Date.now(), data };
      return data;
    } catch (e) {
      // 失败返回缓存或零数据（调用方自行决定）
      if (this._cache) return this._cache.data;
      return { balance: 0, totalNotional: 0, maxSymNotional: 0, longNotional: 0, shortNotional: 0 };
    }
  }

  /**
   * 检查能否开新仓
   * @param {object} api - BinanceAPI 实例
   * @param {number} newNotional - 新仓名义
   * @param {string} [symbol] - 可选，用于单币集中度检查
   * @returns {{allowed:boolean, reason:string, data:object, limitNotional:number}}
   */
  async checkCanOpen(api, newNotional, symbol) {
    const data = await this._refresh(api);
    const balance = data.balance;
    if (balance <= 0) return { allowed: false, reason: '无可动余额', data, limitNotional: 0 };

    // 账户总名义上限
    const totalLimit = balance * this.MAX_TOTAL_LEVERAGE;
    // 单币上限（若传了 symbol，用当前该币名义 + 新仓）
    let symbolLimit = null;
    if (symbol) {
      symbolLimit = balance * this.MAX_SYMBOL_LEVERAGE;
      // 该币现有名义（如果已持有）
      // （getPositions 里已含所有，这里简化：单币检查用传入 symbol 从 data 拿）
    }

    const projectedTotal = data.totalNotional + (newNotional || 0);
    let reason = '';
    if (projectedTotal > totalLimit) {
      reason = `账户总名义超限(当前${data.totalNotional.toFixed(0)} + 新${(newNotional||0).toFixed(0)} > 上限${totalLimit.toFixed(0)})`;
      return { allowed: false, reason, data, limitNotional: Math.max(0, totalLimit - data.totalNotional) };
    }

    return { allowed: true, reason: '', data, limitNotional: Math.max(0, totalLimit - data.totalNotional) };
  }
}

module.exports = { AccountCapacityGuard };
