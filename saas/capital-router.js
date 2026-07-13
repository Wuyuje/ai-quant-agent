/**
 * Capital Router v96 — 智能资金路由器
 * 
 * 功能:
 * 1. 自动在多市场间分配资金
 * 2. 各市场独立风险预算
 * 3. 动态再平衡 (根据绩效自动调整)
 * 4. 紧急回收 (所有市场亏损时自动回笼)
 * 
 * 分配模型:
 * - 基础分配: Crypto 40% / Gold 20% / Forex 20% / Index 15% / Cash 5%
 * - 动态调整: 根据各市场Sharpe ratio加权
 * - 最低保留: 永远保留5%现金
 * - 单市场上限: 不超过50%
 * - 相关性约束: 高相关市场合计不超过60%
 */

const fs = require('fs');
const path = require('path');

class CapitalRouter {
  constructor(totalBalance) {
    this.totalBalance = totalBalance || 100;
    this.baseAllocation = {
      crypto: 0.40,
      gold: 0.20,
      forex: 0.20,
      index: 0.15,
      cash: 0.05,
    };

    // 动态权重 (根据绩效调整)
    this.dynamicWeights = { ...this.baseAllocation };

    // 各市场实际分配
    this.allocation = {};
    for (const [market, pct] of Object.entries(this.baseAllocation)) {
      this.allocation[market] = {
        targetPct: pct,
        currentUsd: this.totalBalance * pct,
        maxPct: market === 'cash' ? 0.30 : 0.50,
        minPct: market === 'cash' ? 0.05 : 0.05,
        pnl: 0,
        winRate: 0,
        sharpe: 0,
        lastRebalance: Date.now(),
      };
    }

    // 约束
    this.constraints = {
      maxCorrelatedExposure: 0.60, // 高相关市场合计
      minCashReserve: 0.05,
      maxSingleDrawdown: 0.10, // 单市场最大回撤10%
      rebalanceThreshold: 0.05, // 偏离5%触发再平衡
      rebalanceCooldown: 3600000, // 最小1小时间隔
    };

    // 相关性矩阵
    this.correlations = {
      'crypto-index': 0.45,
      'crypto-gold': 0.25,
      'gold-forex': 0.30,
      'index-forex': 0.20,
    };

    this.logFile = path.join(__dirname, '..', 'logs', 'capital-router.log');
    this._log('CapitalRouter v96 初始化 — 总资金: $' + this.totalBalance.toFixed(2));
  }

  /**
   * 核心：获取某市场的可用资金额度
   */
  getBudget(market) {
    const alloc = this.allocation[market];
    if (!alloc) return 0;
    return alloc.currentUsd;
  }

  /**
   * 核心：获取某市场的单笔最大交易额
   */
  getMaxTradeSize(market) {
    const budget = this.getBudget(market);
    // 单笔不超过该市场预算的20%
    return Math.min(budget * 0.20, this.totalBalance * 0.10);
  }

  /**
   * 动态再平衡 — 根据绩效调整各市场权重
   */
  async rebalance(marketPerformance) {
    // marketPerformance: { crypto: { sharpe: 2.5, pnl: 5.2, drawdown: -3.1 }, ... }
    const now = Date.now();
    
    for (const [market, perf] of Object.entries(marketPerformance)) {
      if (!this.allocation[market]) continue;
      const alloc = this.allocation[market];

      // 计算调整因子
      const sharpeFactor = Math.max(0, (perf.sharpe || 0) / 3); // Sharpe > 3 → 满分
      const pnlFactor = Math.max(0, 1 + (perf.pnl || 0) / 100);
      const ddPenalty = Math.abs(perf.drawdown || 0) > this.constraints.maxSingleDrawdown ? 0.5 : 1;

      // 新权重 = 基础权重 × (Sharpe因子 × PnL因子 × 回撤惩罚)
      const newWeight = this.baseAllocation[market] * sharpeFactor * pnlFactor * ddPenalty;
      this.dynamicWeights[market] = Math.max(0.05, Math.min(0.50, newWeight));

      // 记录绩效
      alloc.sharpe = perf.sharpe || 0;
      alloc.pnl = perf.pnl || 0;
      alloc.winRate = perf.winRate || 0;
    }

    // 归一化
    const totalWeight = Object.values(this.dynamicWeights).reduce((s, w) => s + w, 0);
    for (const market of Object.keys(this.dynamicWeights)) {
      this.dynamicWeights[market] /= totalWeight;
    }

    // 应用相关性约束
    this._applyCorrelationConstraints();

    // 计算新的金额分配
    for (const [market, weight] of Object.entries(this.dynamicWeights)) {
      if (!this.allocation[market]) continue;
      const targetPct = weight;
      
      // 检查是否需要调整
      const currentPct = this.allocation[market].currentUsd / this.totalBalance;
      const deviation = Math.abs(currentPct - targetPct);

      if (deviation > this.constraints.rebalanceThreshold && now - this.allocation[market].lastRebalance > this.constraints.rebalanceCooldown) {
        const oldUsd = this.allocation[market].currentUsd;
        this.allocation[market].currentUsd = this.totalBalance * targetPct;
        this.allocation[market].targetPct = targetPct;
        this.allocation[market].lastRebalance = now;

        const diff = this.allocation[market].currentUsd - oldUsd;
        this._log(`⚖️ 再平衡 ${market}: $${oldUsd.toFixed(2)} → $${this.allocation[market].currentUsd.toFixed(2)} (${diff > 0 ? '+' : ''}$${diff.toFixed(2)})`);
      }
    }

    this._log(`📊 权重: ${JSON.stringify(Object.fromEntries(Object.entries(this.dynamicWeights).map(([k,v]) => [k, (v*100).toFixed(1)+'%'])))}`);
  }

  /**
   * 相关性约束: 高相关市场合计不超过60%
   */
  _applyCorrelationConstraints() {
    for (const [pair, corr] of Object.entries(this.correlations)) {
      if (Math.abs(corr) < 0.3) continue; // 只管高相关

      const [m1, m2] = pair.split('-');
      const combined = (this.dynamicWeights[m1] || 0) + (this.dynamicWeights[m2] || 0);

      if (combined > this.constraints.maxCorrelatedExposure) {
        const excess = combined - this.constraints.maxCorrelatedExposure;
        // 按权重比例缩减
        const w1 = this.dynamicWeights[m1] || 0;
        const w2 = this.dynamicWeights[m2] || 0;
        const total = w1 + w2;

        if (total > 0) {
          this.dynamicWeights[m1] -= excess * (w1 / total);
          this.dynamicWeights[m2] -= excess * (w2 / total);
          this._log(`🛡️ 相关性约束: ${pair}(corr=${corr.toFixed(2)}) 超限 → 缩减${(excess*100).toFixed(1)}%`);
        }
      }
    }
  }

  /**
   * 紧急回收 — 当某市场亏损超限时回收资金
   */
  emergencyRecall(market) {
    const alloc = this.allocation[market];
    if (!alloc) return;

    const recalled = alloc.currentUsd * 0.50; // 回收50%
    alloc.currentUsd -= recalled;
    this.allocation.cash.currentUsd += recalled;

    this._log(`🚨 紧急回收 ${market}: -$${recalled.toFixed(2)} → 现金储备`);
  }

  /**
   * 记录交易PnL并更新
   */
  recordPnL(market, pnl) {
    if (!this.allocation[market]) return;
    this.allocation[market].pnl += pnl;
    this.totalBalance += pnl;

    // 如果市场严重亏损，触发紧急回收
    if (this.allocation[market].pnl < -this.totalBalance * this.constraints.maxSingleDrawdown) {
      this.emergencyRecall(market);
    }
  }

  /**
   * 获取报告
   */
  getReport() {
    const report = {
      totalBalance: this.totalBalance,
      allocation: {},
      weights: this.dynamicWeights,
    };

    for (const [market, alloc] of Object.entries(this.allocation)) {
      report.allocation[market] = {
        budget: alloc.currentUsd.toFixed(2),
        pct: (alloc.currentUsd / this.totalBalance * 100).toFixed(1) + '%',
        pnl: alloc.pnl.toFixed(2),
        sharpe: alloc.sharpe,
      };
    }

    return report;
  }

  _log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    try {
      const dir = path.dirname(this.logFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.logFile, line + '\n');
    } catch (e) {}
  }
}

module.exports = CapitalRouter;
