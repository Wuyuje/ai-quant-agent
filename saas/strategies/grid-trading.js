/**
 * 网格交易策略
 * 适用于震荡市，在价格区间内低买高卖
 */

class GridTrading {
  constructor(config = {}) {
    this.gridSize = config.gridSize || 10; // 网格数量
    this.gridSpacing = config.gridSpacing || 0.02; // 网格间距2%
    this.upperPrice = config.upperPrice || 0;
    this.lowerPrice = config.lowerPrice || 0;
    this.positionSize = config.positionSize || 0.1; // 每格仓位10%
    this.gridLevels = [];
    this.currentGrid = -1;
  }

  /**
   * 分析市场是否适合网格交易
   * @param {Array} klines - K线数据
   * @returns {Object} 分析结果
   */
  analyze(klines) {
    if (!klines || klines.length < 50) {
      return { suitable: false, reason: 'K线数据不足' };
    }

    // 计算波动率
    const prices = klines.map(k => (k.high + k.low) / 2);
    const returns = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push((prices[i] - prices[i-1]) / prices[i-1]);
    }
    
    const volatility = Math.sqrt(returns.reduce((sum, r) => sum + r * r, 0) / returns.length);
    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    
    // 计算价格区间
    const high = Math.max(...klines.map(k => k.high));
    const low = Math.min(...klines.map(k => k.low));
    const priceRange = (high - low) / ((high + low) / 2);

    // 判断是否适合网格交易
    // 震荡市：波动率适中，价格在区间内
    const isRanging = volatility > 0.005 && volatility < 0.03 && priceRange < 0.15;
    const isTrending = Math.abs(avgReturn) > 0.001 || priceRange > 0.2;

    return {
      suitable: isRanging && !isTrending,
      reason: isTrending ? '趋势市场不适合网格' : (isRanging ? '震荡市场适合网格' : '波动率不适合'),
      volatility,
      priceRange,
      high,
      low,
      avgReturn,
    };
  }

  /**
   * 设置网格
   * @param {number} currentPrice - 当前价格
   * @param {number} high - 区间高点
   * @param {number} low - 区间低点
   */
  setupGrid(currentPrice, high, low) {
    this.upperPrice = high * 1.02; // 上方留2%余量
    this.lowerPrice = low * 0.98; // 下方留2%余量
    
    const gridSpacing = (this.upperPrice - this.lowerPrice) / this.gridSize;
    this.gridLevels = [];
    
    for (let i = 0; i <= this.gridSize; i++) {
      this.gridLevels.push(this.lowerPrice + i * gridSpacing);
    }
    
    // 找到当前价格所在的网格
    this.currentGrid = this.gridLevels.findIndex(level => level >= currentPrice);
    if (this.currentGrid === -1) this.currentGrid = this.gridLevels.length - 1;
    
    return {
      gridSize: this.gridLevels.length,
      upperPrice: this.upperPrice,
      lowerPrice: this.lowerPrice,
      currentGrid: this.currentGrid,
      gridSpacing: gridSpacing / currentPrice, // 相对间距
    };
  }

  /**
   * 生成交易信号
   * @param {number} currentPrice - 当前价格
   * @param {Object} position - 当前持仓
   * @returns {Object} 交易信号
   */
  generateSignal(currentPrice, position = null) {
    if (this.gridLevels.length === 0) {
      return { action: 'HOLD', reason: '网格未设置' };
    }

    const priceGrid = this.gridLevels.findIndex(level => level >= currentPrice);
    const prevGrid = this.currentGrid;

    // 价格突破网格
    if (priceGrid !== prevGrid) {
      // 价格下跌到下网格 → 买入
      if (priceGrid < prevGrid) {
        const buyLevel = this.gridLevels[priceGrid];
        const gridSize = this.gridLevels.length;
        const positionSize = this.positionSize * (1 + (gridSize - priceGrid) / gridSize); // 越低仓位越大
        
        return {
          action: 'BUY',
          price: buyLevel,
          size: positionSize,
          reason: `网格买入 ${priceGrid + 1}/${gridSize}`,
          gridLevel: priceGrid,
        };
      }
      
      // 价格上涨到上网格 → 卖出
      if (priceGrid > prevGrid) {
        const sellLevel = this.gridLevels[priceGrid];
        const gridSize = this.gridLevels.length;
        const positionSize = this.positionSize * (1 + priceGrid / gridSize); // 越高仓位越大
        
        return {
          action: 'SELL',
          price: sellLevel,
          size: positionSize,
          reason: `网格卖出 ${priceGrid + 1}/${gridSize}`,
          gridLevel: priceGrid,
        };
      }
    }

    // 持仓止盈止损（网格内的风险管理）
    if (position) {
      const entryPrice = position.entryPrice;
      const pnlPct = (currentPrice - entryPrice) / entryPrice * (position.side === 'LONG' ? 1 : -1);
      
      // 网格止盈：2%
      if (pnlPct >= 0.02) {
        return {
          action: 'CLOSE',
          reason: `网格止盈 ${(pnlPct * 100).toFixed(2)}%`,
        };
      }
      
      // 网格止损：-1%
      if (pnlPct <= -0.01) {
        return {
          action: 'CLOSE',
          reason: `网格止损 ${(pnlPct * 100).toFixed(2)}%`,
        };
      }
    }

    this.currentGrid = priceGrid;
    return { action: 'HOLD', reason: '价格在网格内' };
  }

  /**
   * 计算网格收益率
   * @param {number} trades - 交易次数
   * @returns {Object} 收益统计
   */
  calculateYield(trades) {
    const avgProfit = this.gridSpacing * 0.8; // 扣除手续费
    const avgTradesPerDay = trades / 30; // 30天数据
    
    return {
      avgProfitPerTrade: avgProfit,
      dailyYield: avgProfit * avgTradesPerDay,
      monthlyYield: avgProfit * trades,
      annualizedYield: avgProfit * trades * 12,
    };
  }
}

module.exports = { GridTrading };
