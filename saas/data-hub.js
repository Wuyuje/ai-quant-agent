/**
 * 数据收集中心 v1.0
 * 收集所有用户(含管理员)的交易结果，反馈给量化机器人智能进化
 *
 * 进化链:
 *   用户平仓 → DataHub.reportTrade() → 各策略模块学习
 *   - NeuralNet: 训练数据积累 → AutoTrainer定期重训
 *   - Ensemble: 策略权重调整(recordResult)
 *   - Brain: 交易记忆(recordTrade)
 *   - ExitManager: 止盈止损学习(recordResult)
 *   - PositionSizer: 仓位学习(recordTradeResult)
 *   - StrategyManager: 因子评分学习(recordTradeResult)
 */
class DataHub {
  constructor() {
    this._deps = null;
    this._tradeLog = [];  // 近期交易记录(自动清理)
    this._maxLogAge = 7 * 24 * 3600000; // 7天自动过期
    this._maxLogSize = 5000; // 最多5000条
    this._stats = {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      totalPnl: 0,
      byUser: {},  // {wallet: {trades, wins, losses, pnl}}
      bySymbol: {}, // {symbol: {trades, wins, losses, pnl}}
      byStrategy: {}, // {strategyName: {trades, wins, losses, pnl}}
    };
  }

  /**
   * 注入策略模块依赖
   */
  setDeps(deps) {
    this._deps = deps;
  }

  /**
   * 报告交易结果 — 所有用户平仓后调用
   * @param {Object} trade - {wallet, symbol, side, entryPrice, exitPrice, pnl, pnlPct, leverage, holdHours, strategy, confidence, reason, timestamp}
   */
  reportTrade(trade) {
    try {
      const { wallet, symbol, pnl, pnlPct, leverage, holdHours, strategy, confidence, reason } = trade;
      const isWin = pnl > 0;
      const ts = Date.now();

      // 1. 记录到交易日志(自动清理远旧数据)
      this._tradeLog.push({ ...trade, timestamp: ts });
      this._cleanupOld();

      // 2. 统计
      this._stats.totalTrades++;
      this._stats.totalPnl += pnl;
      if (isWin) this._stats.wins++; else this._stats.losses++;
      if (!this._stats.byUser[wallet]) this._stats.byUser[wallet] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
      this._stats.byUser[wallet].trades++;
      this._stats.byUser[wallet].pnl += pnl;
      if (isWin) this._stats.byUser[wallet].wins++; else this._stats.byUser[wallet].losses++;
      if (!this._stats.bySymbol[symbol]) this._stats.bySymbol[symbol] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
      this._stats.bySymbol[symbol].trades++;
      this._stats.bySymbol[symbol].pnl += pnl;
      if (isWin) this._stats.bySymbol[symbol].wins++; else this._stats.bySymbol[symbol].losses++;
      const stratKey = strategy || reason || 'unknown';
      if (!this._stats.byStrategy[stratKey]) this._stats.byStrategy[stratKey] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
      this._stats.byStrategy[stratKey].trades++;
      this._stats.byStrategy[stratKey].pnl += pnl;
      if (isWin) this._stats.byStrategy[stratKey].wins++; else this._stats.byStrategy[stratKey].losses++;

      // 3. 反馈给各策略模块学习
      const d = this._deps;
      if (!d) return;

      // NeuralNet训练数据
      if (d.neuralNet || d.autoTrainer) {
        const label = isWin ? 1 : -1;
        const features = trade.features || [];
        if (d.neuralNet && features.length > 0) {
          try { d.neuralNet.train(features, label, 0.01); } catch (e) {}
        }
      }

      // Ensemble策略权重调整
      if (d.strategyManager?.strategies?.ensemble) {
        try { d.strategyManager.strategies.ensemble.recordResult(trade.strategyName || 'multiConfirm', pnl); } catch (e) {}
      }

      // Brain交易记忆
      if (d.brain) {
        try { d.brain.recordTrade(symbol, pnlPct || (pnl / (trade.entryPrice * trade.qty || 1)) * 100, isWin); } catch (e) {}
      }

      // AdaptiveExit止盈止损学习
      if (d.exitManager) {
        try { d.exitManager.recordResult((pnlPct || 0)); } catch (e) {}
      }

      // PositionSizer仓位学习
      if (d.positionSizer) {
        try { d.positionSizer.recordTradeResult(pnl); } catch (e) {}
      }

      // StrategyManager因子评分学习
      if (d.strategyManager && typeof d.strategyManager.recordTradeResult === 'function') {
        try {
          const actualDir = trade.side === 'LONG' ? 1 : -1;
          d.strategyManager.recordTradeResult(pnl, trade.score || 0, actualDir, trade.factorScores || {});
        } catch (e) {}
      }
    } catch (e) { /* 静默 */ }
  }

  /**
   * 清理过期交易记录 — v113.5: 修复缺失的方法定义
   */
  _cleanupOld() {
    const now = Date.now();
    // 按时间过期
    this._tradeLog = this._tradeLog.filter(t => (now - (t.timestamp || 0)) < this._maxLogAge);
    // 按数量上限
    if (this._tradeLog.length > this._maxLogSize) {
      this._tradeLog = this._tradeLog.slice(-this._maxLogSize);
    }
  }

  /**
   * 获取统计
   */
  getStats() {
    return {
      ...this._stats,
      winRate: this._stats.totalTrades > 0 ? (this._stats.wins / this._stats.totalTrades * 100).toFixed(1) + '%' : 'N/A',
      avgPnl: this._stats.totalTrades > 0 ? (this._stats.totalPnl / this._stats.totalTrades).toFixed(4) : 0,
      recentTrades: this._tradeLog.slice(-20),
    };
  }

  /**
   * 获取某品种历史胜率
   */
  getSymbolStats(symbol) {
    return this._stats.bySymbol[symbol] || null;
  }

  /**
   * 获取某用户统计
   */
  getUserStats(wallet) {
    return this._stats.byUser[wallet] || null;
  }
}

const hub = new DataHub();
module.exports = hub;
module.exports.DataHub = DataHub;
