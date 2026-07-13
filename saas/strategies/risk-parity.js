/**
 * v60: 风险平价引擎 (Risk Parity)
 * 
 * 核心思想：不按金额分配仓位，而是按风险分配
 * 波动率高的币 → 小仓位
 * 波动率低的币 → 大仓位
 * 使每个持仓对总组合的风险贡献相等
 */

class RiskParity {
  constructor(config = {}) {
    this.targetVolatility = config.targetVolatility || 0.15;  // 目标年化波动率15%
    this.maxPositionPct = config.maxPositionPct || 0.30;       // 单个持仓最大30%
    this.minPositionPct = config.minPositionPct || 0.05;       // 单个持仓最小5%
    this.maxLeverage = config.maxLeverage || 1;                 // 最大杠杆
    this.lookback = config.lookback || 20;                      // 波动率回看周期
    this.correlationWindow = config.correlationWindow || 30;    // 相关性窗口
    
    // 历史数据用于计算相关性
    this._priceHistory = {};  // {symbol: [prices]}
    this._maxHistory = 100;
  }

  /**
   * 更新价格历史
   * @param {string} symbol - 交易对
   * @param {number} price - 当前价格
   */
  updatePrice(symbol, price) {
    if (!this._priceHistory[symbol]) this._priceHistory[symbol] = [];
    this._priceHistory[symbol].push(price);
    if (this._priceHistory[symbol].length > this._maxHistory) {
      this._priceHistory[symbol].shift();
    }
  }

  /**
   * 计算风险平价仓位
   * @param {Array} candidates - 候选交易 [{symbol, atrPct, score, side}]
   * @param {number} totalCapital - 总资金
   * @param {Array} existingPositions - 现有持仓 [{symbol, amount, side}]
   * @returns {Object} 仓位分配
   */
  allocate(candidates, totalCapital, existingPositions = []) {
    if (!candidates || candidates.length === 0) {
      return { positions: [], totalRisk: 0, reason: '无候选' };
    }

    // ═══ 1. 计算每个候选的年化波动率 ═══
    const volatilities = {};
    for (const c of candidates) {
      // ATR百分比 → 日波动率 → 年化
      const dailyVol = (c.atrPct || 2) / 100 / 2;  // ATR ≈ 2*std
      const annualVol = dailyVol * Math.sqrt(365);
      volatilities[c.symbol] = Math.max(0.05, annualVol); // 最小5%年化
    }

    // ═══ 2. 计算相关性矩阵 ═══
    const correlationMatrix = this._calcCorrelationMatrix(candidates.map(c => c.symbol));

    // ═══ 3. 风险平价权重计算 ═══
    // 基础权重：1/vol 标准化
    const invVol = {};
    let totalInvVol = 0;
    for (const sym of Object.keys(volatilities)) {
      invVol[sym] = 1 / volatilities[sym];
      totalInvVol += invVol[sym];
    }

    // 初始权重
    const weights = {};
    for (const sym of Object.keys(invVol)) {
      weights[sym] = invVol[sym] / totalInvVol;
    }

    // ═══ 4. 相关性调整 ═══
    // 如果两个币高度正相关，降低权重（避免集中风险）
    const adjustedWeights = this._adjustForCorrelation(weights, correlationMatrix, candidates);

    // ═══ 5. 现有持仓扣减 ═══
    const availableCapital = this._calcAvailableCapital(totalCapital, existingPositions);

    // ═══ 6. 仓位金额计算 ═══
    const positions = [];
    let totalAllocated = 0;
    let totalRisk = 0;

    for (const c of candidates) {
      const w = adjustedWeights[c.symbol] || 0;
      const allocation = Math.min(
        availableCapital * this.maxPositionPct,  // 单仓上限
        availableCapital * w                      // 风险平价权重
      );
      
      const finalAllocation = Math.max(
        Math.min(allocation, availableCapital - totalAllocated),
        0
      );

      if (finalAllocation < totalCapital * this.minPositionPct) continue;

      // 计算该仓位的风险贡献
      const positionRisk = finalAllocation * volatilities[c.symbol];

      positions.push({
        symbol: c.symbol,
        side: c.side,
        amount: finalAllocation,
        weight: finalAllocation / totalCapital,
        volatility: volatilities[c.symbol],
        riskContribution: positionRisk,
        score: c.score,
      });

      totalAllocated += finalAllocation;
      totalRisk += positionRisk;
    }

    // ═══ 7. 杠杆调整 ═══
    // 如果总风险低于目标，可以适度加杠杆
    const portfolioVol = this._calcPortfolioVol(positions, correlationMatrix);
    let leverage = 1;
    if (portfolioVol > 0 && portfolioVol < this.targetVolatility) {
      leverage = Math.min(this.maxLeverage, this.targetVolatility / portfolioVol);
    }

    // 应用杠杆
    if (leverage > 1) {
      for (const p of positions) {
        p.amount *= leverage;
        p.weight *= leverage;
      }
    }

    return {
      positions,
      totalAllocated,
      availableCapital,
      portfolioVolatility: portfolioVol,
      leverage,
      totalRisk,
      correlationMatrix,
      weights: adjustedWeights,
    };
  }

  /**
   * 计算相关性矩阵
   * @param {Array} symbols - 交易对列表
   * @returns {Object} 相关性矩阵 {sym1: {sym2: corr}}
   */
  _calcCorrelationMatrix(symbols) {
    const matrix = {};
    
    for (const s1 of symbols) {
      matrix[s1] = {};
      for (const s2 of symbols) {
        if (s1 === s2) {
          matrix[s1][s2] = 1;
        } else if (matrix[s2]?.[s1] !== undefined) {
          matrix[s1][s2] = matrix[s2][s1]; // 对称
        } else {
          matrix[s1][s2] = this._calcCorrelation(s1, s2);
        }
      }
    }
    
    return matrix;
  }

  /**
   * 计算两个币种的相关性
   */
  _calcCorrelation(sym1, sym2) {
    const prices1 = this._priceHistory[sym1];
    const prices2 = this._priceHistory[sym2];
    
    if (!prices1 || !prices2 || prices1.length < 10 || prices2.length < 10) {
      return 0.5; // 默认中等相关
    }

    // 取共同长度
    const len = Math.min(prices1.length, prices2.length);
    const p1 = prices1.slice(-len);
    const p2 = prices2.slice(-len);

    // 转收益率
    const r1 = [], r2 = [];
    for (let i = 1; i < len; i++) {
      r1.push((p1[i] - p1[i - 1]) / p1[i - 1]);
      r2.push((p2[i] - p2[i - 1]) / p2[i - 1]);
    }

    // 皮尔逊相关系数
    const mean1 = r1.reduce((a, b) => a + b, 0) / r1.length;
    const mean2 = r2.reduce((a, b) => a + b, 0) / r2.length;
    let cov = 0, var1 = 0, var2 = 0;
    for (let i = 0; i < r1.length; i++) {
      cov += (r1[i] - mean1) * (r2[i] - mean2);
      var1 += Math.pow(r1[i] - mean1, 2);
      var2 += Math.pow(r2[i] - mean2, 2);
    }
    
    const denom = Math.sqrt(var1 * var2);
    return denom > 0 ? cov / denom : 0.5;
  }

  /**
   * 相关性调整权重
   * 高相关的币种降低权重
   */
  _adjustForCorrelation(weights, corrMatrix, candidates) {
    const adjusted = { ...weights };
    
    for (const c1 of candidates) {
      let corrPenalty = 0;
      for (const c2 of candidates) {
        if (c1.symbol === c2.symbol) continue;
        const corr = corrMatrix[c1.symbol]?.[c2.symbol] || 0;
        // 正相关惩罚，负相关奖励
        if (corr > 0.5) {
          corrPenalty += corr * weights[c2.symbol] * 0.3;
        }
      }
      adjusted[c1.symbol] = Math.max(0.02, weights[c1.symbol] - corrPenalty);
    }

    // 归一化
    const total = Object.values(adjusted).reduce((a, b) => a + b, 0);
    if (total > 0) {
      for (const k of Object.keys(adjusted)) {
        adjusted[k] /= total;
      }
    }
    
    return adjusted;
  }

  /**
   * 计算可用资金
   */
  _calcAvailableCapital(totalCapital, existingPositions) {
    const used = existingPositions.reduce((sum, p) => sum + (p.amount || 0), 0);
    return Math.max(0, totalCapital - used);
  }

  /**
   * 计算组合波动率
   */
  _calcPortfolioVol(positions, corrMatrix) {
    if (positions.length === 0) return 0;
    
    let totalVar = 0;
    for (let i = 0; i < positions.length; i++) {
      for (let j = 0; j < positions.length; j++) {
        const wi = positions[i].weight;
        const wj = positions[j].weight;
        const vi = positions[i].volatility;
        const vj = positions[j].volatility;
        const corr = corrMatrix[positions[i].symbol]?.[positions[j].symbol] || 0.5;
        totalVar += wi * wj * vi * vj * corr;
      }
    }
    return Math.sqrt(Math.max(0, totalVar));
  }

  /**
   * 获取风险报告
   */
  getRiskReport(positions, totalCapital) {
    const totalExposure = positions.reduce((sum, p) => sum + p.amount, 0);
    const exposurePct = totalExposure / totalCapital;
    const maxSingleExposure = Math.max(...positions.map(p => p.weight), 0);
    const avgVolatility = positions.length > 0 
      ? positions.reduce((sum, p) => sum + p.volatility, 0) / positions.length 
      : 0;

    return {
      totalExposure,
      exposurePct,
      maxSingleExposure,
      avgVolatility,
      diversificationRatio: this._calcDiversificationRatio(positions),
    };
  }

  /**
   * 分散化比率 = 加权平均波动率 / 组合波动率
   * > 1 说明分散化有效
   */
  _calcDiversificationRatio(positions) {
    if (positions.length === 0) return 1;
    const weightedAvgVol = positions.reduce((sum, p) => sum + p.weight * p.volatility, 0);
    // 简化：假设平均相关性0.5
    const portfolioVol = weightedAvgVol * Math.sqrt(1 / positions.length + 0.5 * (1 - 1 / positions.length));
    return portfolioVol > 0 ? weightedAvgVol / portfolioVol : 1;
  }
}

module.exports = { RiskParity };
