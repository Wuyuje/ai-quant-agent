/**
 * 波动率自适应策略
 * 根据市场波动率动态调整交易参数
 */

class VolatilityAdaptive {
  constructor(config = {}) {
    this.lookbackPeriod = config.lookbackPeriod || 20; // 回看周期
    this.volatilityThresholds = config.volatilityThresholds || {
      low: 0.01,    // 低波动率阈值
      medium: 0.02, // 中波动率阈值
      high: 0.03,   // 高波动率阈值
      extreme: 0.05, // 极端波动率阈值
    };
    this.currentVolatility = 0;
    this.volatilityHistory = [];
    this.volatilityRegime = 'medium'; // 当前波动率体制
  }

  /**
   * 计算波动率
   * @param {Array} klines - K线数据
   * @returns {Object} 波动率分析
   */
  calculateVolatility(klines) {
    if (!klines || klines.length < this.lookbackPeriod + 1) {
      return { volatility: 0, regime: 'unknown', sufficient: false };
    }

    // 计算收益率
    const prices = klines.map(k => (k.high + k.low) / 2);
    const returns = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push((prices[i] - prices[i-1]) / prices[i-1]);
    }

    // 计算波动率（标准差）
    const recentReturns = returns.slice(-this.lookbackPeriod);
    const mean = recentReturns.reduce((sum, r) => sum + r, 0) / recentReturns.length;
    const variance = recentReturns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / recentReturns.length;
    const volatility = Math.sqrt(variance);

    // 更新历史
    this.volatilityHistory.push(volatility);
    if (this.volatilityHistory.length > 100) {
      this.volatilityHistory.shift();
    }

    // 判断波动率体制
    let regime = 'medium';
    if (volatility < this.volatilityThresholds.low) {
      regime = 'low';
    } else if (volatility < this.volatilityThresholds.medium) {
      regime = 'medium';
    } else if (volatility < this.volatilityThresholds.high) {
      regime = 'high';
    } else {
      regime = 'extreme';
    }

    this.currentVolatility = volatility;
    this.volatilityRegime = regime;

    // 计算波动率百分位
    const sortedHistory = [...this.volatilityHistory].sort((a, b) => a - b);
    const percentile = sortedHistory.indexOf(volatility) / sortedHistory.length;

    return {
      volatility,
      regime,
      percentile,
      sufficient: true,
      historyLength: this.volatilityHistory.length,
      averageVolatility: this.volatilityHistory.length > 0 ? this.volatilityHistory.reduce((a, b) => a + b, 0) / this.volatilityHistory.length : 0,
    };
  }

  /**
   * 根据波动率调整参数
   * @param {Object} baseParams - 基础参数
   * @returns {Object} 调整后的参数
   */
  adaptParameters(baseParams) {
    const volatility = this.currentVolatility;
    const regime = this.volatilityRegime;

    let adjusted = { ...baseParams };

    // 根据波动率体制调整
    switch (regime) {
      case 'low':
        // 低波动率：可以更激进
        adjusted.positionSize = baseParams.positionSize * 1.3;
        adjusted.stopLoss = baseParams.stopLoss * 0.8;
        adjusted.takeProfit = baseParams.takeProfit * 0.9;
        adjusted.holdingPeriod = baseParams.holdingPeriod * 1.2;
        break;

      case 'medium':
        // 中波动率：保持基础参数
        break;

      case 'high':
        // 高波动率：更保守
        adjusted.positionSize = baseParams.positionSize * 0.7;
        adjusted.stopLoss = baseParams.stopLoss * 1.2;
        adjusted.takeProfit = baseParams.takeProfit * 1.1;
        adjusted.holdingPeriod = baseParams.holdingPeriod * 0.8;
        break;

      case 'extreme':
        // 极端波动率：最保守
        adjusted.positionSize = baseParams.positionSize * 0.5;
        adjusted.stopLoss = baseParams.stopLoss * 1.5;
        adjusted.takeProfit = baseParams.takeProfit * 1.3;
        adjusted.holdingPeriod = baseParams.holdingPeriod * 0.6;
        break;
    }

    // 基于ATR调整止损
    if (baseParams.atr) {
      const atrMultiplier = this.getATRMultiplier(regime);
      adjusted.stopLossDistance = baseParams.atr * atrMultiplier;
    }

    // 基于波动率百分位调整
    const percentile = this.getVolatilityPercentile();
    if (percentile > 0.8) {
      // 波动率在80%百分位以上，降低仓位
      adjusted.positionSize *= 0.8;
    } else if (percentile < 0.2) {
      // 波动率在20%百分位以下，增加仓位
      adjusted.positionSize *= 1.2;
    }

    return {
      original: baseParams,
      adjusted,
      regime,
      volatility,
      percentile,
      adjustments: this.getAdjustmentFactors(baseParams, adjusted),
    };
  }

  /**
   * 获取ATR乘数
   * @param {string} regime - 波动率体制
   * @returns {number} ATR乘数
   */
  getATRMultiplier(regime) {
    const multipliers = {
      low: 1.5,
      medium: 2.0,
      high: 2.5,
      extreme: 3.0,
    };
    return multipliers[regime] || 2.0;
  }

  /**
   * 获取波动率百分位
   * @returns {number} 百分位 (0-1)
   */
  getVolatilityPercentile() {
    if (this.volatilityHistory.length < 10) return 0.5;
    
    const sorted = [...this.volatilityHistory].sort((a, b) => a - b);
    const currentIndex = sorted.findIndex(v => v >= this.currentVolatility);
    if (currentIndex < 0 || sorted.length === 0) return 0.5;
    return currentIndex / sorted.length;
  }

  /**
   * 检查波动率异常
   * @returns {Object} 异常检查结果
   */
  checkAnomaly() {
    if (this.volatilityHistory.length < 20) {
      return { isAnomaly: false, reason: '历史数据不足' };
    }

    const recent = this.volatilityHistory.slice(-5);
    const historical = this.volatilityHistory.slice(0, -5);
    
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const historicalAvg = historical.reduce((a, b) => a + b, 0) / historical.length;
    const historicalStd = Math.sqrt(
      historical.reduce((sum, v) => sum + Math.pow(v - historicalAvg, 2), 0) / historical.length
    );

    // 检测异常：最近5个波动率平均值超过历史平均值2个标准差
    const zScore = (recentAvg - historicalAvg) / (historicalStd || 0.001);
    const isAnomaly = Math.abs(zScore) > 2;

    return {
      isAnomaly,
      zScore,
      recentAvg,
      historicalAvg,
      historicalStd,
      reason: isAnomaly ? `波动率异常 z=${zScore.toFixed(2)}` : '正常',
    };
  }

  /**
   * 获取波动率体制建议
   * @returns {Object} 交易建议
   */
  getRegimeAdvice() {
    const advice = {
      low: {
        strategy: '趋势跟踪',
        positionSize: '增加',
        stopLoss: '收紧',
        takeProfit: '降低',
        holdingPeriod: '延长',
        suitableStrategies: ['趋势跟踪', '突破交易'],
      },
      medium: {
        strategy: '均衡',
        positionSize: '标准',
        stopLoss: '标准',
        takeProfit: '标准',
        holdingPeriod: '标准',
        suitableStrategies: ['趋势跟踪', '均值回归', '网格交易'],
      },
      high: {
        strategy: '防守',
        positionSize: '减少',
        stopLoss: '放宽',
        takeProfit: '提高',
        holdingPeriod: '缩短',
        suitableStrategies: ['均值回归', '波动率交易'],
      },
      extreme: {
        strategy: '观望',
        positionSize: '最小',
        stopLoss: '最宽',
        takeProfit: '最高',
        holdingPeriod: '最短',
        suitableStrategies: ['仅观望', '极端反转'],
      },
    };

    return advice[this.volatilityRegime] || advice.medium;
  }

  /**
   * 计算调整因子
   * @param {Object} original - 原始参数
   * @param {Object} adjusted - 调整后参数
   * @returns {Object} 调整因子
   */
  getAdjustmentFactors(original, adjusted) {
    const factors = {};
    for (const key in original) {
      if (original[key] && adjusted[key]) {
        factors[key] = adjusted[key] / original[key];
      }
    }
    return factors;
  }

  /**
   * 波动率突破检测
   * @param {number} currentPrice - 当前价格
   * @param {Array} klines - K线数据
   * @returns {Object} 突破检测
   */
  detectBreakout(currentPrice, klines) {
    if (!klines || klines.length < 20) {
      return { isBreakout: false, reason: '数据不足' };
    }

    const prices = klines.map(k => (k.high + k.low) / 2);
    const sma20 = prices.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const std20 = Math.sqrt(
      prices.slice(-20).reduce((sum, p) => sum + Math.pow(p - sma20, 2), 0) / 20
    );

    const upperBand = sma20 + 2 * std20;
    const lowerBand = sma20 - 2 * std20;

    const isUpperBreakout = currentPrice > upperBand;
    const isLowerBreakout = currentPrice < lowerBand;

    return {
      isBreakout: isUpperBreakout || isLowerBreakout,
      direction: isUpperBreakout ? 'up' : (isLowerBreakout ? 'down' : 'none'),
      upperBand,
      lowerBand,
      sma20,
      std20,
      zScore: (currentPrice - sma20) / (std20 || 0.001),
    };
  }
}

module.exports = { VolatilityAdaptive };
