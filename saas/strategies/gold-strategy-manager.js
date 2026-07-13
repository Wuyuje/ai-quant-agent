/**
 * Gold Strategy Manager — 黄金现货策略管理器
 * 
 * 融合4个世界级策略:
 * 1. GoldMomentum         — Donchian+EMA+ADX动量趋势 (权重0.30)
 * 2. GoldMeanReversion    — Bollinger+RSI背离+Z-Score均值回归 (权重0.25)
 * 3. GoldMacroFactor      — 趋势结构+波动率体制+宏观代理 (权重0.25)
 * 4. GoldVolatilityTrading — Keltner突破+时段分析+波动率交易 (权重0.20)
 * 
 * 黄金交易逻辑:
 * - 趋势行情 → Momentum主导
 * - 震荡行情 → MeanReversion主导
 * - 极端行情 → VolatilityTrading主导
 * - 趋势切换 → MacroFactor先行判断
 */

const { GoldMomentum } = require('./gold-momentum');
const { GoldMeanReversion } = require('./gold-mean-reversion');
const { GoldMacroFactor } = require('./gold-macro-factor');
const { GoldVolatilityTrading } = require('./gold-volatility-trading');

class GoldStrategyManager {
  constructor(config = {}) {
    this.momentum = new GoldMomentum(config.momentum || {});
    this.meanReversion = new GoldMeanReversion(config.meanReversion || {});
    this.macroFactor = new GoldMacroFactor(config.macroFactor || {});
    this.volatilityTrading = new GoldVolatilityTrading(config.volatilityTrading || {});

    // 基础权重
    this.weights = {
      momentum: 0.30,
      meanReversion: 0.25,
      macroFactor: 0.25,
      volatilityTrading: 0.20,
    };

    // 交易状态
    this.lastSignal = null;
    this.tradeCount = 0;
    this.winCount = 0;
    this._cycleCount = 0;
  }

  /**
   * 全策略融合分析
   */
  async analyze(marketData) {
    const { klines, currentPrice, symbol = 'PAXGUSDT', crossData = {} } = marketData;
    this._cycleCount++;

    // ═══ 1. 逐策略分析 ═══
    const momentumResult = this.momentum.analyze(klines, currentPrice);
    const meanRevResult = this.meanReversion.analyze(klines, currentPrice);
    const macroResult = this.macroFactor.analyze(klines, currentPrice, crossData);
    const volResult = this.volatilityTrading.analyze(klines, currentPrice);

    // ═══ 2. 自适应权重（根据市场状态调整）═══
    const adaptiveWeights = this._calculateAdaptiveWeights({
      momentum: momentumResult,
      meanReversion: meanRevResult,
      macro: macroResult,
      volatility: volResult,
    });

    // ═══ 3. 综合评分 ═══
    const compositeScore = this._calculateCompositeScore({
      momentum: momentumResult,
      meanReversion: meanRevResult,
      macro: macroResult,
      volatility: volResult,
      weights: adaptiveWeights,
    });

    // ═══ 4. 生成最终信号 ═══
    const finalSignal = this._generateFinalSignal(compositeScore, {
      momentum: momentumResult,
      meanReversion: meanRevResult,
      macro: macroResult,
      volatility: volResult,
    });

    return {
      symbol,
      timestamp: Date.now(),
      compositeScore,
      finalSignal,
      analysis: {
        momentum: momentumResult,
        meanReversion: meanRevResult,
        macro: macroResult,
        volatility: volResult,
        adaptiveWeights,
      },
    };
  }

  /**
   * 自适应权重 — 根据市场状态调整策略权重
   */
  _calculateAdaptiveWeights(signals) {
    const w = { ...this.weights };

    // 如果动量信号强（趋势行情），增加动量权重
    if (signals.momentum.valid && Math.abs(signals.momentum.score) > 40) {
      w.momentum = 0.40;
      w.meanReversion = 0.15; // 降低均值回归（趋势中回归策略弱）
      w.macroFactor = 0.25;
      w.volatilityTrading = 0.20;
    }
    // 如果均值回归信号强（震荡行情），增加回归权重
    else if (signals.meanReversion.valid && Math.abs(signals.meanReversion.score) > 40) {
      w.meanReversion = 0.35;
      w.momentum = 0.20;
      w.macroFactor = 0.25;
      w.volatilityTrading = 0.20;
    }
    // 如果波动率高，增加波动率策略权重
    if (signals.volatility.valid && signals.volatility.indicators?.volExpansion) {
      w.volatilityTrading = 0.30;
      w.momentum = Math.max(0.20, w.momentum - 0.10);
    }

    // 归一化
    const total = Object.values(w).reduce((a, b) => a + b, 0);
    for (const k of Object.keys(w)) w[k] /= total;

    return w;
  }

  /**
   * 综合评分
   */
  _calculateCompositeScore(signals) {
    let score = 0;
    let totalWeight = 0;
    const reasons = [];
    const w = signals.weights;

    // 动量
    if (signals.momentum.valid && signals.momentum.action !== 'HOLD') {
      const s = signals.momentum.action === 'BUY' ? signals.momentum.score : -signals.momentum.score;
      const normalized = s / 100;
      score += normalized * w.momentum;
      totalWeight += w.momentum;
      reasons.push(`Momentum: ${signals.momentum.action} score=${signals.momentum.score.toFixed(1)} w=${(w.momentum*100).toFixed(0)}%`);
    }

    // 均值回归
    if (signals.meanReversion.valid && signals.meanReversion.action !== 'HOLD') {
      const s = signals.meanReversion.action === 'BUY' ? signals.meanReversion.score : -signals.meanReversion.score;
      const normalized = s / 100;
      score += normalized * w.meanReversion;
      totalWeight += w.meanReversion;
      reasons.push(`MeanRev: ${signals.meanReversion.action} score=${signals.meanReversion.score.toFixed(1)} w=${(w.meanReversion*100).toFixed(0)}%`);
    }

    // 宏观因子
    if (signals.macro.valid && signals.macro.action !== 'HOLD') {
      const s = signals.macro.action === 'BUY' ? signals.macro.score : -signals.macro.score;
      const normalized = s / 100;
      score += normalized * w.macroFactor;
      totalWeight += w.macroFactor;
      reasons.push(`Macro: ${signals.macro.action} score=${signals.macro.score.toFixed(1)} w=${(w.macroFactor*100).toFixed(0)}%`);
    }

    // 波动率交易
    if (signals.volatility.valid && signals.volatility.action !== 'HOLD') {
      const s = signals.volatility.action === 'BUY' ? signals.volatility.score : -signals.volatility.score;
      const normalized = s / 100;
      score += normalized * w.volatilityTrading;
      totalWeight += w.volatilityTrading;
      reasons.push(`Vol: ${signals.volatility.action} score=${signals.volatility.score.toFixed(1)} w=${(w.volatilityTrading*100).toFixed(0)}%`);
    }

    // 一致性加成
    const actions = [signals.momentum, signals.meanReversion, signals.macro, signals.volatility]
      .filter(s => s.valid && s.action !== 'HOLD')
      .map(s => s.action);
    const buyCount = actions.filter(a => a === 'BUY').length;
    const sellCount = actions.filter(a => a === 'SELL').length;

    if (buyCount >= 3) { score *= 1.2; reasons.push('STRONG_CONSENSUS_BUY(+20%)'); }
    else if (sellCount >= 3) { score *= 1.2; reasons.push('STRONG_CONSENSUS_SELL(+20%)'); }
    else if (buyCount >= 2 && sellCount === 0) { score *= 1.1; reasons.push('CONSENSUS_BUY(+10%)'); }
    else if (sellCount >= 2 && buyCount === 0) { score *= 1.1; reasons.push('CONSENSUS_SELL(+10%)'); }

    // 矛盾惩罚
    if (buyCount > 0 && sellCount > 0) { score *= 0.8; reasons.push('CONFLICT(-20%)'); }

    if (totalWeight > 0) score /= totalWeight;

    const normalized = Math.max(-1, Math.min(1, score));

    return {
      score: normalized,
      reasons,
      totalWeight,
      consensus: { buy: buyCount, sell: sellCount, hold: 4 - buyCount - sellCount },
    };
  }

  /**
   * 生成最终信号
   */
  _generateFinalSignal(compositeScore, allSignals) {
    const { score, reasons } = compositeScore;

    const thresholds = {
      strong: 0.20,
      moderate: 0.10,
      weak: 0.05,
    };

    let action = 'HOLD';
    let strength = 'none';
    let confidence = 0;
    const signalReasons = [...reasons];

    if (score > thresholds.strong) {
      action = 'BUY';
      strength = 'strong';
      confidence = 0.85;
      signalReasons.push('🟢 强烈买入信号');
    } else if (score > thresholds.moderate) {
      action = 'BUY';
      strength = 'moderate';
      confidence = 0.65;
      signalReasons.push('🟡 中等买入信号');
    } else if (score > thresholds.weak) {
      action = 'BUY';
      strength = 'weak';
      confidence = 0.45;
      signalReasons.push('🔵 弱买入信号');
    } else if (score < -thresholds.strong) {
      action = 'SELL';
      strength = 'strong';
      confidence = 0.85;
      signalReasons.push('🔴 强烈卖出信号');
    } else if (score < -thresholds.moderate) {
      action = 'SELL';
      strength = 'moderate';
      confidence = 0.65;
      signalReasons.push('🟠 中等卖出信号');
    } else if (score < -thresholds.weak) {
      action = 'SELL';
      strength = 'weak';
      confidence = 0.45;
      signalReasons.push('⚪ 弱卖出信号');
    } else {
      signalReasons.push('无明确信号，观望');
    }

    this.lastSignal = { action, strength, confidence, score, timestamp: Date.now() };

    return {
      action,
      strength,
      confidence,
      score,
      reasons: signalReasons,
      timestamp: Date.now(),
    };
  }

  /**
   * 记录交易结果
   */
  recordTrade(pnl) {
    this.tradeCount++;
    if (pnl > 0) this.winCount++;
  }

  getStats() {
    return {
      tradeCount: this.tradeCount,
      winCount: this.winCount,
      winRate: this.tradeCount > 0 ? (this.winCount / this.tradeCount * 100).toFixed(1) + '%' : 'N/A',
      lastSignal: this.lastSignal,
      cycleCount: this._cycleCount,
    };
  }

  getAllSummaries() {
    return {
      momentum: this.momentum.getSummary(),
      meanReversion: this.meanReversion.getSummary(),
      macroFactor: this.macroFactor.getSummary(),
      volatilityTrading: this.volatilityTrading.getSummary(),
    };
  }
}

module.exports = { GoldStrategyManager };
