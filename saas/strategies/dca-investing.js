/**
 * DCA定投策略
 * 长期持有，定期定额投资，降低平均成本
 */

class DCAInvesting {
  constructor(config = {}) {
    this.interval = config.interval || 24 * 60 * 60 * 1000; // 默认每天
    this.amountPerInterval = config.amountPerInterval || 100; // 每次$100
    this.maxPositions = config.maxPositions || 10; // 最多10次定投
    this.priceDropThreshold = config.priceDropThreshold || -0.05; // 价格下跌5%加仓
    this.priceRiseThreshold = config.priceRiseThreshold || 0.10; // 价格上涨10%减仓
    this.dcaHistory = [];
    this.lastInvestTime = 0;
  }

  /**
   * 分析市场是否适合DCA
   * @param {Array} klines - K线数据
   * @param {number} currentPrice - 当前价格
   * @returns {Object} 分析结果
   */
  analyze(klines, currentPrice) {
    if (!klines || klines.length < 100) {
      return { suitable: false, reason: 'K线数据不足' };
    }

    // 计算长期趋势
    const prices = klines.map(k => (k.high + k.low) / 2);
    const sma50 = this._calculateSMA(prices, 50);
    const sma200 = this._calculateSMA(prices, 200);
    
    // 计算波动率
    const returns = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push((prices[i] - prices[i-1]) / prices[i-1]);
    }
    const volatility = Math.sqrt(returns.reduce((sum, r) => sum + r * r, 0) / returns.length);

    // 计算相对强弱
    const rsi = this._calculateRSI(prices, 14);

    // 判断是否适合DCA
    // 长期上涨趋势 + 波动率适中 + 不在超买区
    const isLongTermUp = sma50 > sma200;
    const isVolatilityOk = volatility < 0.05;
    const isNotOverbought = rsi < 70;

    return {
      suitable: isLongTermUp && isVolatilityOk && isNotOverbought,
      reason: !isLongTermUp ? '长期趋势下跌' : (!isVolatilityOk ? '波动率太高' : (!isNotOverbought ? 'RSI超买' : '适合DCA')),
      sma50,
      sma200,
      volatility,
      rsi,
      currentPrice,
    };
  }

  /**
   * 生成定投信号
   * @param {number} currentPrice - 当前价格
   * @param {Object} position - 当前持仓
   * @returns {Object} 定投信号
   */
  generateSignal(currentPrice, position = null) {
    const now = Date.now();
    const timeSinceLastInvest = now - this.lastInvestTime;
    const priceChange = position ? (currentPrice - position.avgPrice) / position.avgPrice : 0;

    // 检查是否到定投时间
    const isTimeToInvest = timeSinceLastInvest >= this.interval;
    
    // 检查是否需要调整仓位
    const shouldAddPosition = priceChange <= this.priceDropThreshold;
    const shouldReducePosition = priceChange >= this.priceRiseThreshold;
    
    // 检查是否达到最大定投次数
    const isMaxPositions = this.dcaHistory.length >= this.maxPositions;

    // 生成信号
    if (isTimeToInvest && !isMaxPositions) {
      // 定投时间到了
      let amount = this.amountPerInterval;
      
      // 价格下跌加倍定投
      if (shouldAddPosition) {
        amount *= 2;
        return {
          action: 'BUY',
          amount,
          reason: `DCA定投 + 价格下跌加倍 ${(priceChange * 100).toFixed(2)}%`,
        };
      }
      
      // 价格上涨减少定投
      if (shouldReducePosition) {
        amount *= 0.5;
        return {
          action: 'BUY',
          amount,
          reason: `DCA定投 + 价格上涨减半 ${(priceChange * 100).toFixed(2)}%`,
        };
      }
      
      // 正常定投
      return {
        action: 'BUY',
        amount,
        reason: `DCA定投 ${this.dcaHistory.length + 1}/${this.maxPositions}`,
      };
    }

    // 止盈：长期持有收益达到目标
    if (position && priceChange >= 0.20) {
      return {
        action: 'CLOSE',
        reason: `DCA止盈 ${(priceChange * 100).toFixed(2)}%`,
      };
    }

    // 止损：长期持有亏损过大（DCA不轻易止损，但要控制风险）
    if (position && priceChange <= -0.15) {
      return {
        action: 'CLOSE',
        reason: `DCA止损 ${(priceChange * 100).toFixed(2)}%`,
      };
    }

    return { action: 'HOLD', reason: 'DCA等待' };
  }

  /**
   * 计算DCA成本
   * @returns {Object} 成本统计
   */
  calculateCost() {
    if (this.dcaHistory.length === 0) {
      return { totalInvested: 0, avgPrice: 0, positionSize: 0 };
    }

    const totalInvested = this.dcaHistory.reduce((sum, inv) => sum + inv.amount, 0);
    if (totalInvested <= 0) return { totalInvested: 0, avgPrice: 0, positionSize: 0 };
    const avgPrice = this.dcaHistory.reduce((sum, inv) => sum + inv.price * inv.amount, 0) / totalInvested;
    const positionSize = this.dcaHistory.length;

    return {
      totalInvested,
      avgPrice,
      positionSize,
    };
  }

  /**
   * 计算DCA收益率
   * @param {number} currentPrice - 当前价格
   * @returns {Object} 收益统计
   */
  calculateYield(currentPrice) {
    const cost = this.calculateCost();
    if (cost.totalInvested === 0) {
      return { totalInvested: 0, currentValue: 0, yield: 0, annualizedYield: 0 };
    }

    const currentValue = (cost.totalInvested / cost.avgPrice) * currentPrice;
    const yieldPct = (currentValue - cost.totalInvested) / cost.totalInvested;
    
    // 计算年化（假设30天数据）
    const days = 30;
    const annualizedYield = yieldPct * (365 / days);

    return {
      totalInvested: cost.totalInvested,
      currentValue,
      yield: yieldPct,
      annualizedYield,
      avgPrice: cost.avgPrice,
    };
  }

  /**
   * 记录定投
   * @param {number} price - 定投价格
   * @param {number} amount - 定投金额
   */
  recordInvestment(price, amount) {
    this.dcaHistory.push({
      price,
      amount,
      timestamp: Date.now(),
    });
    this.lastInvestTime = Date.now();
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
}

module.exports = { DCAInvesting };
