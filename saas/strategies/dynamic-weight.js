/**
 * v60: 动态权重引擎
 * 
 * 根据市场状态（趋势/震荡/极端波动）动态调整策略权重
 * 不再固定 grid:0.2 dca:0.2 mt:0.3 kelly:0.15 vol:0.15
 * 而是根据 ADX + 波动率体制 + 市场状态 自动调整
 */

class DynamicWeight {
  constructor(config = {}) {
    // 基础权重（作为回退）
    this.baseWeights = config.baseWeights || {
      multiTimeframe: 0.25,
      ml: 0.20,              // v60: ML预测权重
      neuralNet: 0.15,       // v63: 神经网络权重
      grid: 0.15,
      dca: 0.10,
      kelly: 0.08,
      volatility: 0.07,
    };

    // 市场状态 → 权重配置
    this.regimeWeights = {
      // 强趋势市：MA排列清晰，ADX>25
      strongTrend: {
        multiTimeframe: 0.25,
        ml: 0.20,        // ML在趋势中权重高
        neuralNet: 0.15, // NN在趋势中有效
        grid: 0.05,      // 网格在趋势中无用
        dca: 0.05,       // DCA在趋势中无用
        kelly: 0.15,
        volatility: 0.15,
      },
      // 弱趋势/震荡市：ADX<20，波动率低
      ranging: {
        multiTimeframe: 0.10,  // 趋势策略在震荡中无效
        ml: 0.15,
        neuralNet: 0.10, // NN在震荡中效果一般
        grid: 0.30,     // 网格在震荡中最优
        dca: 0.20,      // DCA在震荡中可用
        kelly: 0.05,
        volatility: 0.10,
      },
      // 高波动市：波动率高但无明确趋势
      highVol: {
        multiTimeframe: 0.10,
        ml: 0.15,        // ML仍可预测
        neuralNet: 0.10, // NN在高波动中不稳定
        grid: 0.10,
        dca: 0.05,
        kelly: 0.15,
        volatility: 0.35, // 波动率策略权重最高
      },
      // 极端波动/黑天鹅
      extreme: {
        multiTimeframe: 0.05,
        ml: 0.05,        // ML在极端时不可靠
        neuralNet: 0.05, // NN在极端时不可靠
        grid: 0.00,      // 网格完全关闭
        dca: 0.00,       // DCA关闭
        kelly: 0.20,
        volatility: 0.60, // 波动率策略主导
      },
      // 默认/中性
      neutral: {
        multiTimeframe: 0.20,
        ml: 0.18,
        neuralNet: 0.15,
        grid: 0.17,
        dca: 0.10,
        kelly: 0.10,
        volatility: 0.10,
      },
    };

    this.currentRegime = 'neutral';
    this.regimeConfidence = 0;
    this.weightHistory = [];
    this._regimeTransitionCount = 0;
    this._lastRegime = 'neutral';
    // v83: 策略表现追踪（自学习）
    this._strategyPerformance = {};  // strategyName → { wins, losses, totalPnl, count }
    this._performanceUpdated = false;
  }

  /**
   * 检测当前市场状态
   * @param {Object} indicators - DataBus指标
   * @param {Object} volatilityInfo - 波动率信息
   * @returns {Object} 市场状态
   */
  detectRegime(indicators, volatilityInfo) {
    const adx = indicators?.adx || 0;
    const atrPct = indicators?.atrPercent || 0;
    const bbWidth = indicators?.bb?.width || 0;
    const rsi = indicators?.rsi || 50;

    // 波动率体制（来自VolatilityAdaptive）
    const volRegime = volatilityInfo?.regime || 'medium';

    // ═══ 状态判定逻辑 ═══
    let regime = 'neutral';
    let confidence = 0;
    let reasons = [];

    // 1. 极端波动检测
    if (volRegime === 'extreme' || atrPct > 5 || bbWidth > 15) {
      regime = 'extreme';
      confidence = 0.9;
      reasons.push(`极端波动 volRegime=${volRegime} ATR=${atrPct.toFixed(1)}% BBW=${bbWidth.toFixed(1)}%`);
    }
    // 2. 强趋势检测
    else if (adx > 25 && volRegime !== 'extreme') {
      regime = 'strongTrend';
      confidence = Math.min(1, (adx - 20) / 30);
      reasons.push(`强趋势 ADX=${adx.toFixed(0)} volRegime=${volRegime}`);
    }
    // 3. 高波动但无趋势
    else if ((volRegime === 'high' || atrPct > 3) && adx < 20) {
      regime = 'highVol';
      confidence = 0.7;
      reasons.push(`高波动无趋势 ATR=${atrPct.toFixed(1)}% ADX=${adx.toFixed(0)}`);
    }
    // 4. 震荡市
    else if (adx < 20 && (volRegime === 'low' || volRegime === 'medium')) {
      regime = 'ranging';
      confidence = Math.min(1, (20 - adx) / 20);
      reasons.push(`震荡市 ADX=${adx.toFixed(0)} volRegime=${volRegime}`);
    }
    // 5. 中性
    else {
      regime = 'neutral';
      confidence = 0.5;
      reasons.push(`中性 ADX=${adx.toFixed(0)} ATR=${atrPct.toFixed(1)}%`);
    }

    // 记录状态转换
    if (regime !== this._lastRegime) {
      this._regimeTransitionCount++;
      this._lastRegime = regime;
    }

    this.currentRegime = regime;
    this.regimeConfidence = confidence;

    return { regime, confidence, reasons, adx, atrPct, volRegime, bbWidth, rsi };
  }

  /**
   * 获取当前市场状态的动态权重
   * @param {Object} regimeInfo - 来自detectRegime
   * @returns {Object} 策略权重
   */
  getWeights(regimeInfo) {
    const targetWeights = this.regimeWeights[regimeInfo?.regime || this.currentRegime] || this.baseWeights;
    
    // 平滑过渡：当前权重逐步向目标权重移动（避免突变）
    const smoothing = 0.3; // 30%向目标移动
    // v83: 用表现调整后的 baseWeights
    const currentWeights = this._performanceAdjustedWeights();
    const adjusted = {};
    
    for (const key of Object.keys(targetWeights)) {
      const current = currentWeights[key] || 0;
      const target = targetWeights[key];
      adjusted[key] = current * (1 - smoothing) + target * smoothing;
    }

    // 归一化
    const total = Object.values(adjusted).reduce((a, b) => a + b, 0);
    if (total > 0) {
      for (const key of Object.keys(adjusted)) {
        adjusted[key] /= total;
      }
    }

    // 记录历史
    this.weightHistory.push({ regime: this.currentRegime, weights: { ...adjusted }, timestamp: Date.now() });
    if (this.weightHistory.length > 100) this.weightHistory.shift();

    return adjusted;
  }

  /**
   * 综合入口：检测状态 + 获取权重
   * @param {Object} indicators - DataBus指标
   * @param {Object} volatilityInfo - 波动率信息
   * @returns {Object} { regime, weights, confidence }
   */
  evaluate(indicators, volatilityInfo) {
    const regimeInfo = this.detectRegime(indicators, volatilityInfo);
    const weights = this.getWeights(regimeInfo);
    
    return {
      regime: regimeInfo.regime,
      confidence: regimeInfo.confidence,
      weights,
      reasons: regimeInfo.reasons,
      transitionCount: this._regimeTransitionCount,
    };
  }

  /**
   * v83: 根据交易结果调整基础权重
   * @param {string} strategyName - 策略名
   * @param {number} pnl - 盈亏金额
   */
  recordStrategyResult(strategyName, pnl) {
    if (!this._strategyPerformance[strategyName]) {
      this._strategyPerformance[strategyName] = { wins: 0, losses: 0, totalPnl: 0, count: 0 };
    }
    const perf = this._strategyPerformance[strategyName];
    perf.count++;
    perf.totalPnl += pnl;
    if (pnl > 0) perf.wins++;
    else if (pnl < 0) perf.losses++;
    this._performanceUpdated = true;
  }

  /**
   * v83: 基于真实表现调整基础权重
   */
  _performanceAdjustedWeights() {
    if (!this._performanceUpdated) return this.baseWeights;
    
    const adjusted = { ...this.baseWeights };
    let totalScore = 0;
    const scores = {};
    
    for (const [name, perf] of Object.entries(this._strategyPerformance)) {
      if (perf.count < 3) continue;  // 至少3笔交易才调整
      const winRate = perf.wins / perf.count;
      const avgPnl = perf.totalPnl / perf.count;
      scores[name] = winRate * 0.6 + (avgPnl > 0 ? 0.4 : 0.2);
      totalScore += scores[name];
    }
    
    if (totalScore === 0) return this.baseWeights;
    
    // 按表现比例调整对应权重
    const nameMap = {
      'multiTimeframe': 'multiTimeframe',
      'ML': 'ml', 'ml': 'ml',
      'NeuralNet': 'neuralNet', 'neuralnet': 'neuralNet',
      'Grid': 'grid', 'grid': 'grid',
      'DCA': 'dca', 'dca': 'dca',
      'Kelly': 'kelly', 'kelly': 'kelly',
      'Volatility': 'volatility', 'volatility': 'volatility',
    };
    
    for (const [name, score] of Object.entries(scores)) {
      const key = nameMap[name];
      if (key && adjusted[key] !== undefined) {
        const factor = 0.8 + (score / totalScore) * 0.4;  // 0.8~1.2
        adjusted[key] *= factor;
      }
    }
    
    // 归一化
    const total = Object.values(adjusted).reduce((a, b) => a + b, 0);
    if (total > 0) {
      for (const key of Object.keys(adjusted)) adjusted[key] /= total;
    }
    
    return adjusted;
  }

  /**
   * 获取状态摘要
   */
  getStats() {
    return {
      currentRegime: this.currentRegime,
      regimeConfidence: this.regimeConfidence,
      transitionCount: this._regimeTransitionCount,
      historyLength: this.weightHistory.length,
    };
  }
}

module.exports = { DynamicWeight };
