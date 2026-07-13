/**
 * Gold Mean Reversion — 黄金均值回归策略
 * 
 * 世界级策略参考:
 * - Bollinger Band Reversion — 布林带回归
 * - RSI Divergence — RSI背离捕捉
 * - Z-Score Mean Reversion — 统计均值回归
 * - Williams %R — 超买超卖指标
 * 
 * 黄金特性:
 * - 长期均值回归特性（偏离均线后回归概率高）
 * - 适合区间震荡行情
 * - 与动量策略互补（趋势弱时生效）
 */

class GoldMeanReversion {
  constructor(config = {}) {
    this.bbPeriod = config.bbPeriod || 20;
    this.bbStd = config.bbStd || 2.0;
    this.rsiPeriod = config.rsiPeriod || 14;
    this.zscorePeriod = config.zscorePeriod || 20;
    this.williamsPeriod = config.williamsPeriod || 14;
  }

  /**
   * 分析黄金均值回归信号
   */
  analyze(klines, currentPrice) {
    if (!klines || klines.length < 40) {
      return { valid: false, reason: 'K线不足40根' };
    }

    const closes = klines.map(k => k.close);
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);
    const n = closes.length;

    // ═══ 1. Bollinger Bands ═══
    const sma20 = closes.slice(-this.bbPeriod).reduce((a, b) => a + b, 0) / this.bbPeriod;
    const variance = closes.slice(-this.bbPeriod).reduce((a, b) => a + Math.pow(b - sma20, 2), 0) / this.bbPeriod;
    const std = Math.sqrt(variance);
    const bbUpper = sma20 + this.bbStd * std;
    const bbLower = sma20 - this.bbStd * std;
    const bbWidth = bbUpper > 0 ? (bbUpper - bbLower) / sma20 * 100 : 0;
    const bbPosition = (currentPrice - bbLower) / Math.max(bbUpper - bbLower, 0.01); // 0=下轨, 1=上轨

    // BB回归信号
    const bbSell = currentPrice > bbUpper; // 价格在上轨之上 → 卖
    const bbBuy = currentPrice < bbLower; // 价格在下轨之下 → 买
    const bbWidthNarrow = bbWidth < 1.5; // 布林带收窄 → 变盘预警

    // ═══ 2. RSI背离检测 ═══
    const rsi = this._calcRSI(closes, this.rsiPeriod);
    const rsiPrev5 = this._calcRSI(closes.slice(0, -5), this.rsiPeriod);

    // 价格创新高但RSI没新高 → 顶背离(卖出信号)
    const priceHigherHigh = closes[n-1] > closes[n-6] && closes[n-6] > closes[n-11];
    const rsiLowerHigh = rsi < rsiPrev5 && rsiPrev5 > 65;
    const bearishDiv = priceHigherHigh && rsiLowerHigh;

    // 价格创新低但RSI没新低 → 底背离(买入信号)
    const priceLowerLow = closes[n-1] < closes[n-6] && closes[n-6] < closes[n-11];
    const rsiHigherLow = rsi > rsiPrev5 && rsiPrev5 < 35;
    const bullishDiv = priceLowerLow && rsiHigherLow;

    // ═══ 3. Z-Score ═══
    const sma = closes.slice(-this.zscorePeriod).reduce((a, b) => a + b, 0) / this.zscorePeriod;
    const stdDev = Math.sqrt(closes.slice(-this.zscorePeriod).reduce((a, b) => a + Math.pow(b - sma, 2), 0) / this.zscorePeriod);
    const zscore = stdDev > 0 ? (currentPrice - sma) / stdDev : 0;

    // ═══ 4. Williams %R ═══
    const wr = this._williamsR(highs, lows, closes, this.williamsPeriod);

    // ═══ 5. 均线距离 ═══
    const sma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / Math.min(50, closes.length);
    const sma200 = closes.slice(-200).reduce((a, b) => a + b, 0) / Math.min(200, closes.length);
    const distFromSMA20 = (currentPrice / sma20 - 1) * 100;
    const distFromSMA50 = (currentPrice / sma50 - 1) * 100;

    // ═══ 综合评分 ═══
    let score = 0;
    const reasons = [];

    // Bollinger Band (+30)
    if (bbBuy) { score += 30; reasons.push(`BB_OVERSOLD(pos=${bbPosition.toFixed(2)})`); }
    else if (bbSell) { score -= 30; reasons.push(`BB_OVERBOUGHT(pos=${bbPosition.toFixed(2)})`); }
    else if (bbPosition < 0.2) { score += 15; reasons.push(`BB_LOW(pos=${bbPosition.toFixed(2)})`); }
    else if (bbPosition > 0.8) { score -= 15; reasons.push(`BB_HIGH(pos=${bbPosition.toFixed(2)})`); }

    // RSI背离 (+25)
    if (bullishDiv) { score += 25; reasons.push('BULLISH_RSI_DIVERGENCE'); }
    else if (bearishDiv) { score -= 25; reasons.push('BEARISH_RSI_DIVERGENCE'); }

    // RSI超买超卖 (+15)
    if (rsi < 25) { score += 15; reasons.push(`RSI_OVERSOLD(${rsi.toFixed(1)})`); }
    else if (rsi > 75) { score -= 15; reasons.push(`RSI_OVERBOUGHT(${rsi.toFixed(1)})`); }
    else if (rsi < 40) { score += 5; reasons.push(`RSI_LOW(${rsi.toFixed(1)})`); }
    else if (rsi > 60) { score -= 5; reasons.push(`RSI_HIGH(${rsi.toFixed(1)})`); }

    // Z-Score (+20)
    if (zscore < -2) { score += 20; reasons.push(`ZSCORE_LOW(${zscore.toFixed(2)})`); }
    else if (zscore > 2) { score -= 20; reasons.push(`ZSCORE_HIGH(${zscore.toFixed(2)})`); }
    else if (zscore < -1) { score += 10; reasons.push(`ZSCORE_NEG(${zscore.toFixed(2)})`); }
    else if (zscore > 1) { score -= 10; reasons.push(`ZSCORE_POS(${zscore.toFixed(2)})`); }

    // Williams %R (+10)
    if (wr < -80) { score += 10; reasons.push(`WR_OVERSOLD(${wr.toFixed(1)})`); }
    else if (wr > -20) { score -= 10; reasons.push(`WR_OVERBOUGHT(${wr.toFixed(1)})`); }

    // 布林带宽度预警
    if (bbWidthNarrow) { reasons.push(`BB_NARROW(${bbWidth.toFixed(2)}%)`); }

    // 归一化到 -100 ~ 100
    const normalized = Math.max(-100, Math.min(100, score));

    // 信号
    let action = 'HOLD';
    if (normalized > 30) action = 'BUY';
    else if (normalized < -30) action = 'SELL';

    const confidence = Math.min(1, Math.abs(normalized) / 70);

    return {
      valid: true,
      action,
      score: normalized,
      confidence,
      reasons,
      indicators: {
        bbUpper, bbLower, sma20, bbWidth, bbPosition,
        rsi, rsiPrev5,
        bearishDiv, bullishDiv,
        zscore, sma, stdDev,
        wr,
        sma50, sma200,
        distFromSMA20, distFromSMA50,
      },
      source: 'gold-mean-reversion',
    };
  }

  _calcRSI(closes, period) {
    let gains = 0, losses = 0;
    const n = closes.length;
    for (let i = n - period; i < n; i++) {
      if (i > 0) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) gains += diff;
        else losses -= diff;
      }
    }
    if (losses === 0) return 100;
    return 100 - 100 / (1 + gains / losses);
  }

  _williamsR(highs, lows, closes, period) {
    const n = closes.length;
    const recentHighs = highs.slice(-period);
    const recentLows = lows.slice(-period);
    const hh = Math.max(...recentHighs);
    const ll = Math.min(...recentLows);
    const close = closes[n - 1];
    return hh === ll ? -50 : (hh - close) / (hh - ll) * -100;
  }

  getSummary() {
    return { name: 'GoldMeanReversion', description: 'Bollinger回归+RSI背离+Z-Score+Williams%R' };
  }
}

module.exports = { GoldMeanReversion };
