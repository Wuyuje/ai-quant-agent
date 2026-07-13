/**
 * 凯利公式仓位管理
 * 根据胜率和赔率计算最优仓位
 */

class KellyPosition {
  constructor(config = {}) {
    this.maxPositionPct = config.maxPositionPct || 0.25; // 最大仓位25%
    this.minPositionPct = config.minPositionPct || 0.05; // 最小仓位5%
    this.maxRiskPerTrade = config.maxRiskPerTrade || 0.02; // 单笔最大风险2%
    this.kellyFraction = config.kellyFraction || 0.5; // 半凯利，更保守
    this.maxDrawdown = config.maxDrawdown || 0.10; // 最大回撤10%
    this.currentDrawdown = 0;
    this.peakEquity = 0;
  }

  /**
   * 计算凯利最优仓位
   * @param {number} winRate - 胜率 (0-1)
   * @param {number} avgWin - 平均盈利
   * @param {number} avgLoss - 平均亏损
   * @returns {Object} 仓位建议
   */
  calculateKelly(winRate, avgWin, avgLoss) {
    if (winRate <= 0 || winRate >= 1 || avgWin <= 0 || avgLoss <= 0) {
      return { kellyPct: 0, reason: '无效参数' };
    }

    // 凯利公式: f* = (bp - q) / b
    // b = avgWin / avgLoss (赔率)
    // p = winRate (胜率)
    // q = 1 - p (败率)
    const b = avgWin / avgLoss;
    if (!isFinite(b) || b <= 0) return { kellyPct: 0, reason: '赔率无效' };
    const p = winRate;
    const q = 1 - p;
    
    let kellyPct = (b * p - q) / b;
    // v50-fix: 防止 NaN/Infinity
    if (!isFinite(kellyPct)) kellyPct = 0;
    
    // 应用半凯利（更保守）
    const halfKelly = kellyPct * this.kellyFraction;
    
    // 限制在最小最大仓位之间
    const boundedKelly = Math.max(this.minPositionPct, Math.min(this.maxPositionPct, halfKelly));

    return {
      kellyPct: halfKelly,
      boundedKelly,
      b,
      p,
      q,
      reason: kellyPct > 0 ? '正期望' : '负期望',
    };
  }

  /**
   * 动态仓位调整
   * @param {number} baseKelly - 基础凯利仓位
   * @param {Object} marketCondition - 市场状态
   * @returns {Object} 调整后的仓位
   */
  adjustForMarket(baseKelly, marketCondition) {
    let adjusted = baseKelly;
    let factors = [];

    // 波动率调整
    if (marketCondition.volatility > 0.03) {
      // 高波动率降低仓位
      adjusted *= 0.7;
      factors.push('高波动率70%');
    } else if (marketCondition.volatility < 0.01) {
      // 低波动率增加仓位
      adjusted *= 1.2;
      factors.push('低波动率120%');
    }

    // 趋势强度调整
    if (marketCondition.trendStrength > 2) {
      // 强趋势增加仓位
      adjusted *= 1.3;
      factors.push('强趋势130%');
    } else if (marketCondition.trendStrength < 0.5) {
      // 弱趋势降低仓位
      adjusted *= 0.8;
      factors.push('弱趋势80%');
    }

    // RSI调整
    if (marketCondition.rsi > 70 || marketCondition.rsi < 30) {
      // 极端RSI降低仓位
      adjusted *= 0.6;
      factors.push('极端RSI60%');
    }

    // 相关性调整
    if (marketCondition.correlation > 0.8) {
      // 高相关性降低仓位
      adjusted *= 0.8;
      factors.push('高相关性80%');
    }

    // 重新限制范围
    adjusted = Math.max(this.minPositionPct, Math.min(this.maxPositionPct, adjusted));

    return {
      adjustedKelly: adjusted,
      factors,
      original: baseKelly,
    };
  }

  /**
   * 计算实际仓位金额
   * @param {number} totalCapital - 总资金
   * @param {number} kellyPct - 凯利仓位百分比
   * @param {number} entryPrice - 入场价格
   * @param {number} stopLoss - 止损价格
   * @returns {Object} 仓位计算
   */
  calculatePositionSize(totalCapital, kellyPct, entryPrice, stopLoss) {
    // 基于风险计算仓位
    const riskPerShare = Math.abs(entryPrice - stopLoss);
    if (riskPerShare <= 0 || entryPrice <= 0) {
      return { positionSize: 0, reason: '止损距离为0' };
    }
    const riskPct = riskPerShare / entryPrice;
    if (riskPct <= 0) return { positionSize: 0, reason: '风险比例为0' };
    
    // 最大风险金额
    const maxRiskAmount = totalCapital * this.maxRiskPerTrade;
    
    // 基于风险的仓位大小
    const riskBasedSize = maxRiskAmount / riskPct;
    
    // 基于凯利的仓位大小
    const kellyBasedSize = totalCapital * kellyPct;
    
    // 取较小值（更保守）
    const positionSize = Math.min(riskBasedSize, kellyBasedSize);
    
    // 不能超过最大仓位
    const maxSize = totalCapital * this.maxPositionPct;
    const finalSize = Math.min(positionSize, maxSize);

    return {
      positionSize: finalSize,
      riskBasedSize,
      kellyBasedSize,
      riskPerShare,
      riskPct,
      maxRiskAmount,
      limited: positionSize > maxSize,
    };
  }

  /**
   * 更新回撤状态
   * @param {number} currentEquity - 当前净值
   */
  updateDrawdown(currentEquity) {
    if (!isFinite(currentEquity) || currentEquity <= 0) return { shouldReduce: false, drawdown: 0, reductionFactor: 1 };
    if (currentEquity > this.peakEquity) {
      this.peakEquity = currentEquity;
    }
    
    if (this.peakEquity <= 0) return { shouldReduce: false, drawdown: 0, reductionFactor: 1 };
    this.currentDrawdown = (this.peakEquity - currentEquity) / this.peakEquity;
    if (!isFinite(this.currentDrawdown)) this.currentDrawdown = 0;
    
    // 回撤超过限制时降低仓位
    if (this.currentDrawdown > this.maxDrawdown) {
      return {
        shouldReduce: true,
        drawdown: this.currentDrawdown,
        reductionFactor: 0.5,
      };
    }

    return {
      shouldReduce: false,
      drawdown: this.currentDrawdown,
      reductionFactor: 1,
    };
  }

  /**
   * 讨论仓位
   * @param {Object} position1 - 仓位1
   * @param {Object} position2 - 仓位2
   * @returns {Object} 相关性
   */
  calculateCorrelation(position1, position2) {
    // 简化的相关性计算
    // 实际应用中需要更多历史数据
    const returns1 = position1.returns || [];
    const returns2 = position2.returns || [];
    
    if (returns1.length < 10 || returns2.length < 10) {
      return { correlation: 0, insufficient: true };
    }

    const n = Math.min(returns1.length, returns2.length);
    const r1 = returns1.slice(-n);
    const r2 = returns2.slice(-n);
    
    const mean1 = r1.reduce((a, b) => a + b, 0) / n;
    const mean2 = r2.reduce((a, b) => a + b, 0) / n;
    
    let covariance = 0;
    let variance1 = 0;
    let variance2 = 0;
    
    for (let i = 0; i < n; i++) {
      const diff1 = r1[i] - mean1;
      const diff2 = r2[i] - mean2;
      covariance += diff1 * diff2;
      variance1 += diff1 * diff1;
      variance2 += diff2 * diff2;
    }
    
    const correlation = covariance / Math.sqrt(variance1 * variance2);
    
    return {
      correlation,
      sufficient: true,
      sampleSize: n,
    };
  }

  /**
   * 组合仓位优化
   * @param {Array} positions - 仓位列表
   * @param {number} totalCapital - 总资金
   * @returns {Object} 优化后的仓位
   */
  optimizePortfolio(positions, totalCapital) {
    if (positions.length === 0) {
      return { optimized: [], totalAllocation: 0 };
    }

    // 计算每个仓位的凯利值
    const kellyValues = positions.map(pos => {
      const kelly = this.calculateKelly(
        pos.winRate,
        pos.avgWin,
        pos.avgLoss
      );
      return { ...pos, kellyPct: kelly.boundedKelly };
    });

    // 按凯利值排序
    kellyValues.sort((a, b) => b.kellyPct - a.kellyPct);

    // 分配资金
    let remaining = totalCapital;
    const optimized = [];

    for (const pos of kellyValues) {
      const allocation = Math.min(
        remaining,
        totalCapital * pos.kellyPct
      );
      
      if (allocation >= totalCapital * this.minPositionPct) {
        optimized.push({
          ...pos,
          allocation,
          allocationPct: allocation / totalCapital,
        });
        remaining -= allocation;
      }
    }

    return {
      optimized,
      totalAllocation: totalCapital - remaining,
      utilization: (totalCapital - remaining) / totalCapital,
    };
  }
}

module.exports = { KellyPosition };
