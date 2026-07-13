/**
 * v85: 策略投票制融合层 (Strategy Ensemble)
 * 
 * 替代单一MA交叉判断，使用多策略加权投票
 * 每个策略独立输出信号+置信度，融合层按权重和阈值决定最终行动
 * 
 * 核心逻辑：
 * 1. 每个策略输出: action(LONG/SHORT/FLAT) + confidence(0-1)
 * 2. 按策略权重加权，计算多空总分
 * 3. 多空一致度 >= threshold 才出信号
 * 4. 结合市场体制(Regime)动态调整权重
 * 
 * 信号质量保证：
 * - ≥4/6策略同方向 → 强信号
 * - 3/6 → 中等信号（需高置信度）
 * - ≤2/6 → 不交易
 */

const { RSIReversal } = require('./rsi-reversal');
const { MACDMomentum } = require('./macd-momentum');
const { ATRTrend } = require('./atr-trend');
const { OBVMomentum } = require('./obv-momentum');
const { MultiConfirm } = require('./multi-confirm');
// v91: MultiTimeframe 移除（无signal()接口，与Ensemble不兼容）

class StrategyEnsemble {
  constructor(config = {}) {
    // 初始化所有策略
    this.strategies = {
      rsiReversal: new RSIReversal(config.rsi || {}),
      macdMomentum: new MACDMomentum(config.macd || {}),
      atrTrend: new ATRTrend(config.atr || {}),
      obvMomentum: new OBVMomentum(config.obv || {}),
      multiConfirm: new MultiConfirm(config.multiConfirm || {}),
    };

    // v91: 重新分配权重（移除multiTimeframe）
    this.weights = config.weights || {
      rsiReversal: 0.20,
      macdMomentum: 0.20,
      atrTrend: 0.25,
      obvMomentum: 0.15,
      multiConfirm: 0.20,
    };

    // 阈值配置
    this.minVotes = config.minVotes || 3;       // 至少3个策略同方向
    this.minConfidence = config.minConfidence || 0.4;  // 单策略最低置信度
    this.strongThreshold = config.strongThreshold || 4;  // 4+ = 强信号

    // 策略表现追踪
    this._performance = {};
    for (const name of Object.keys(this.strategies)) {
      this._performance[name] = { wins: 0, losses: 0, totalPnl: 0, count: 0, recentWinRate: 0.5 };
    }

    // 最近信号历史（用于自适应）
    this._recentSignals = [];
    this._maxRecentSignals = 50;
  }

  /**
   * 核心：融合所有策略，输出最终信号
   * @param {Array} klines - K线数据 (需要足够长，200+根)
   * @param {Object} marketData - 额外市场数据 (可选: orderbook, funding, etc.)
   * @returns {Object} 最终融合信号
   */
  evaluate(klines, marketData = {}) {
    if (!klines || klines.length < 50) {
      return { action: 'FLAT', confidence: 0, reasoning: '数据不足', votes: {} };
    }

    // 收集所有策略信号
    const signals = {};
    for (const [name, strategy] of Object.entries(this.strategies)) {
      try {
        signals[name] = strategy.signal(klines);
      } catch (e) {
        signals[name] = { action: 'FLAT', confidence: 0, reasoning: `错误: ${e.message}` };
      }
    }

    // 加权投票
    let longScore = 0, shortScore = 0;
    let longVotes = 0, shortVotes = 0, flatVotes = 0;
    let longReasons = [], shortReasons = [];
    const totalWeight = Object.values(this.weights).reduce((a, b) => a + b, 0);

    const voteDetails = {};

    for (const [name, sig] of Object.entries(signals)) {
      const weight = (this.weights[name] || 0) / totalWeight;
      const conf = sig.confidence || 0;
      const perfAdjust = this._getPerformanceAdjustment(name);
      const adjustedWeight = weight * perfAdjust;

      voteDetails[name] = {
        action: sig.action,
        confidence: parseFloat(conf.toFixed(3)),
        weight: parseFloat(adjustedWeight.toFixed(3)),
        reasoning: sig.reasoning,
      };

      if (sig.action === 'LONG' && conf >= this.minConfidence) {
        longScore += adjustedWeight * conf;
        longVotes++;
        longReasons.push(`${name}(${(conf * 100).toFixed(0)}%)`);
      } else if (sig.action === 'SHORT' && conf >= this.minConfidence) {
        shortScore += adjustedWeight * conf;
        shortVotes++;
        shortReasons.push(`${name}(${(conf * 100).toFixed(0)}%)`);
      } else {
        flatVotes++;
      }
    }

    // ═══ 融合判定 ═══
    let action = 'FLAT';
    let confidence = 0;
    let strength = 'none';
    let reasons = [];

    const totalVotes = longVotes + shortVotes + flatVotes;

    if (longVotes >= this.minVotes && longVotes > shortVotes) {
      action = 'LONG';
      confidence = Math.min(longScore / longVotes, 1);
      strength = longVotes >= this.strongThreshold ? 'strong' : 'medium';
      reasons = [`${longVotes}/${totalVotes}策略看多`, `平均置信${(confidence * 100).toFixed(0)}%`, ...longReasons];
    } else if (shortVotes >= this.minVotes && shortVotes > longVotes) {
      action = 'SHORT';
      confidence = Math.min(shortScore / shortVotes, 1);
      strength = shortVotes >= this.strongThreshold ? 'strong' : 'medium';
      reasons = [`${shortVotes}/${totalVotes}策略看空`, `平均置信${(confidence * 100).toFixed(0)}%`, ...shortReasons];
    } else {
      action = 'FLAT';
      confidence = 0;
      strength = 'none';
      reasons = [`多空分歧 L${longVotes}/S${shortVotes}/F${flatVotes} 未达${this.minVotes}阈值`];
    }

    // 强信号加成
    if (strength === 'strong') {
      confidence = Math.min(confidence * 1.15, 1);
    }

    // v107: 保留策略分歧度 — 高置信度少数派不被忽略
    const allVotes = Object.values(signals);
    const maxConfidenceVote = allVotes.reduce((max, v) => {
      if (v.action !== 'FLAT' && v.confidence > max.confidence) {
        return { action: v.action, confidence: v.confidence, strategy: Object.keys(signals).find(k => signals[k] === v) };
      }
      return max;
    }, { action: 'FLAT', confidence: 0, strategy: null });

    // 记录信号
    this._recentSignals.push({ action, confidence, strength, longVotes, shortVotes, timestamp: Date.now() });
    if (this._recentSignals.length > this._maxRecentSignals) this._recentSignals.shift();

    return {
      action,
      confidence: parseFloat(confidence.toFixed(4)),
      strength,
      reasoning: reasons.join(' | '),
      votes: voteDetails,
      longVotes,
      shortVotes,
      flatVotes,
      strategyCount: Object.keys(this.strategies).length,
      // v107: 分歧度信息 — 帮助上层决策不被多数票淹没高置信度少数派
      divergence: {
        maxConfidenceVote: maxConfidenceVote.confidence > 0.7 ? maxConfidenceVote : null,
        agreementRatio: action !== 'FLAT' ? (action === 'LONG' ? longVotes : shortVotes) / Math.max(totalVotes, 1) : 0,
        conflictLevel: Math.min(longVotes, shortVotes) / Math.max(Math.max(longVotes, shortVotes), 1),
      },
    };
  }

  /**
   * 根据历史表现调整策略权重
   */
  _getPerformanceAdjustment(name) {
    const perf = this._performance[name];
    if (!perf || perf.count < 5) return 1.0; // 不够5笔不调整

    const winRate = perf.wins / perf.count;
    const avgPnl = perf.totalPnl / perf.count;
    
    // 胜率 > 50% → 加权，< 30% → 降权
    if (winRate > 0.6) return 1.3;
    if (winRate > 0.5) return 1.1;
    if (winRate < 0.3) return 0.5;
    if (winRate < 0.4) return 0.8;
    return 1.0;
  }

  /**
   * 记录交易结果，用于自学习
   */
  recordResult(strategyName, pnl) {
    if (!this._performance[strategyName]) return;
    const perf = this._performance[strategyName];
    perf.count++;
    perf.totalPnl += pnl;
    if (pnl > 0) perf.wins++; else perf.losses++;
    perf.recentWinRate = perf.wins / perf.count;
  }

  /**
   * 根据市场体制调整权重
   */
  adjustForRegime(regime) {
    const adjustments = {
      strongTrend: {
        rsiReversal: 0.7,    // 趋势中RSI反转信号少且不可靠
        macdMomentum: 1.3,   // MACD趋势跟踪加权
        atrTrend: 1.4,       // ATR趋势突破加权
        obvMomentum: 0.9,
        multiConfirm: 1.2,   // 多维度确认在趋势中有效
        multiTimeframe: 1.1,
      },
      ranging: {
        rsiReversal: 1.4,    // 震荡中RSI反转最有效
        macdMomentum: 0.7,   // MACD在震荡中假信号多
        atrTrend: 0.6,       // ATR突破在震荡中无效
        obvMomentum: 1.1,
        multiConfirm: 1.2,
        multiTimeframe: 0.8,
      },
      highVol: {
        rsiReversal: 0.8,
        macdMomentum: 1.0,
        atrTrend: 1.3,       // 高波动中ATR信号最可靠
        obvMomentum: 0.9,
        multiConfirm: 1.1,
        multiTimeframe: 1.0,
      },
      neutral: {
        rsiReversal: 1.0,
        macdMomentum: 1.0,
        atrTrend: 1.0,
        obvMomentum: 1.0,
        multiConfirm: 1.0,
        multiTimeframe: 1.0,
      },
    };

    const adj = adjustments[regime] || adjustments.neutral;
    
    for (const [name, factor] of Object.entries(adj)) {
      this.weights[name] = (this.weights[name] || 0.15) * factor;
    }

    // 归一化
    const total = Object.values(this.weights).reduce((a, b) => a + b, 0);
    for (const name of Object.keys(this.weights)) {
      this.weights[name] /= total;
    }
  }

  /**
   * 获取状态摘要
   */
  getStats() {
    return {
      strategyCount: Object.keys(this.strategies).length,
      weights: { ...this.weights },
      performance: { ...this._performance },
      recentSignals: this._recentSignals.length,
    };
  }
}

module.exports = { StrategyEnsemble };
