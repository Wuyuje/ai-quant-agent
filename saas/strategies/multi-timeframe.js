/**
 * 多时间框架分析
 * 1小时 + 4小时 + 12小时，三重确认提高胜率
 * v69: 从5m/1h/4h改为1h/4h/12h，减少噪音
 */

class MultiTimeframe {
  constructor() {
    this.timeframes = ['1h', '4h', '12h'];
    this.weights = {
      '1h': 0.3,   // 30%
      '4h': 0.4,   // 40%
      '12h': 0.3,  // 30%
    };
  }

  /**
   * 分析多时间框架
   * @param {Object} klinesByTimeframe - 各时间框架的K线数据
   * @returns {Object} 分析结果
   */
  analyze(klinesByTimeframe) {
    const results = {};
    
    for (const tf of this.timeframes) {
      const klines = klinesByTimeframe[tf];
      if (!klines || klines.length < 50) {
        results[tf] = { valid: false, reason: '数据不足' };
        continue;
      }

      // 计算指标
      const prices = klines.map(k => (k.high + k.low) / 2);
      const ma7 = this._calculateSMA(prices, 7);
      const ma21 = this._calculateSMA(prices, 21);
      const ma55 = this._calculateSMA(prices, 55);
      const rsi = this._calculateRSI(prices, 14);
      const atr = this._calculateATR(klines, 14);
      const currentPrice = prices[prices.length - 1];

      // 判断趋势
      const isUptrend = ma7 > ma21 && ma21 > ma55;
      const isDowntrend = ma7 < ma21 && ma21 < ma55;
      const isRanging = !isUptrend && !isDowntrend;

      // 判断强度
      const ma7Slope = (ma7 - prices[prices.length - 5]) / prices[prices.length - 5] * 100;
      const trendStrength = Math.abs(ma7Slope);

      results[tf] = {
        valid: true,
        currentPrice,
        ma7,
        ma21,
        ma55,
        rsi,
        atr,
        atrPct: atr / currentPrice,
        isUptrend,
        isDowntrend,
        isRanging,
        trendStrength,
        ma7Slope,
      };
    }

    return results;
  }

  /**
   * 生成多时间框架信号
   * @param {Object} analysis - 分析结果
   * @returns {Object} 综合信号
   */
  generateSignal(analysis) {
    let bullishScore = 0;
    let bearishScore = 0;
    let totalWeight = 0;
    let reasons = [];

    for (const tf of this.timeframes) {
      const result = analysis[tf];
      if (!result.valid) continue;

      const weight = this.weights[tf];
      totalWeight += weight;

      // 趋势方向
      if (result.isUptrend) {
        bullishScore += weight;
        reasons.push(`${tf}上升趋势`);
      } else if (result.isDowntrend) {
        bearishScore += weight;
        reasons.push(`${tf}下降趋势`);
      }

      // RSI
      if (result.rsi < 30) {
        bullishScore += weight * 0.5;
        reasons.push(`${tf}RSI超卖`);
      } else if (result.rsi > 70) {
        bearishScore += weight * 0.5;
        reasons.push(`${tf}RSI超买`);
      }

      // 趋势强度
      if (result.trendStrength > 1) {
        if (result.ma7Slope > 0) {
          bullishScore += weight * 0.3;
        } else {
          bearishScore += weight * 0.3;
        }
      }
    }

    // 归一化
    if (totalWeight > 0) {
      bullishScore /= totalWeight;
      bearishScore /= totalWeight;
    }

    // 生成信号
    const netScore = bullishScore - bearishScore;
    
    if (netScore > 0.3) {
      return {
        action: 'BUY',
        strength: netScore,
        reason: `多时间框架看涨: ${reasons.join(', ')}`,
        bullishScore,
        bearishScore,
      };
    } else if (netScore < -0.3) {
      return {
        action: 'SELL',
        strength: Math.abs(netScore),
        reason: `多时间框架看跌: ${reasons.join(', ')}`,
        bullishScore,
        bearishScore,
      };
    } else {
      return {
        action: 'HOLD',
        strength: 0,
        reason: `多时间框架中性: ${reasons.join(', ') || '无明确方向'}`,
        bullishScore,
        bearishScore,
      };
    }
  }

  /**
   * 检查时间框架一致性
   * @param {Object} analysis - 分析结果
   * @returns {Object} 一致性检查
   */
  checkConsistency(analysis) {
    const trends = [];
    
    for (const tf of this.timeframes) {
      const result = analysis[tf];
      if (!result.valid) continue;
      
      if (result.isUptrend) trends.push('up');
      else if (result.isDowntrend) trends.push('down');
      else trends.push('range');
    }

    // 检查一致性
    const allUp = trends.every(t => t === 'up');
    const allDown = trends.every(t => t === 'down');
    const mixed = !allUp && !allDown;

    return {
      consistent: allUp || allDown,
      direction: allUp ? 'up' : (allDown ? 'down' : 'mixed'),
      trends,
      confidence: allUp || allDown ? 0.8 : 0.4,
    };
  }

  /**
   * 获取最佳时间框架
   * @param {Object} analysis - 分析结果
   * @returns {Object} 最佳时间框架
   */
  getBestTimeframe(analysis) {
    let bestTf = null;
    let bestStrength = 0;

    for (const tf of this.timeframes) {
      const result = analysis[tf];
      if (!result.valid) continue;
      
      if (result.trendStrength > bestStrength) {
        bestStrength = result.trendStrength;
        bestTf = tf;
      }
    }

    return {
      timeframe: bestTf,
      strength: bestStrength,
      result: bestTf ? analysis[bestTf] : null,
    };
  }

  // 辅助函数
  _calculateSMA(data, period) {
    if (data.length < period) return data[data.length - 1];
    const slice = data.slice(-period);
    return slice.reduce((sum, val) => sum + val, 0) / period;
  }

  _calculateRSI(data, period) {
    if (data.length < period + 1) return 50;
    
    const changes = [];
    for (let i = 1; i < data.length; i++) {
      changes.push(data[i] - data[i-1]);
    }
    
    const recentChanges = changes.slice(-period);
    const gains = recentChanges.filter(c => c > 0);
    const losses = recentChanges.filter(c => c < 0).map(c => Math.abs(c));
    
    const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0.0001;
    
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  _calculateATR(klines, period) {
    if (klines.length < period + 1) return 0;
    
    const trs = [];
    for (let i = 1; i < klines.length; i++) {
      const high = klines[i].high;
      const low = klines[i].low;
      const prevClose = klines[i-1].close;
      
      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trs.push(tr);
    }
    
    const recentTrs = trs.slice(-period);
    return recentTrs.reduce((sum, tr) => sum + tr, 0) / period;
  }
}

module.exports = { MultiTimeframe };
