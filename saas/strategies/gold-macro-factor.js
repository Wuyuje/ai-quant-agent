/**
 * Gold Macro Factor — 黄金宏观因子策略
 * 
 * 黄金价格核心驱动因子:
 * 1. 美元指数(DXY)反向相关 — 美元弱=黄金强
 * 2. 实际利率 — 实际利率降=黄金涨
 * 3. VIX恐慌指数 — 恐慌升=黄金避险需求
 * 4. 地缘政治溢价
 * 
 * 实现方式:
 * - 通过BTC/USD作为美元流动性代理（Binance可获取）
 * - 通过VIX相关加密货币波动率推断
 * - 价格本身的宏观结构分析（月/周级别趋势）
 */

class GoldMacroFactor {
  constructor(config = {}) {
    this.lookback = config.lookback || 50;
    this.trendPeriod = config.trendPeriod || 20;
    this.volatilityRegimePeriod = config.volatilityRegimePeriod || 30;
  }

  /**
   * 分析宏观因子
   */
  analyze(klines, currentPrice, crossData = {}) {
    if (!klines || klines.length < 50) {
      return { valid: false, reason: 'K线不足50根' };
    }

    const closes = klines.map(k => k.close);
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);
    const volumes = klines.map(k => k.volume || 0);
    const n = closes.length;

    // ═══ 1. 趋势结构分析 ═══
    // 使用多EMA判断宏观趋势
    const ema10 = this._ema(closes, 10);
    const ema20 = this._ema(closes, 20);
    const ema50 = this._ema(closes, 50);

    // 趋势对齐：EMA10 > EMA20 > EMA50 = 强牛市结构
    const bullAlign = ema10 > ema20 && ema20 > ema50;
    const bearAlign = ema10 < ema20 && ema20 < ema50;
    const trendStrength = bullAlign ? 1 : bearAlign ? -1 : 0;

    // ═══ 2. 波动率体制分析 ═══
    const returns = [];
    for (let i = 1; i < n; i++) {
      returns.push(closes[i] / closes[i - 1] - 1);
    }
    const recentReturns = returns.slice(-this.volatilityRegimePeriod);
    const volMean = recentReturns.reduce((a, b) => a + b, 0) / recentReturns.length;
    const volStd = Math.sqrt(recentReturns.reduce((a, b) => a + Math.pow(b - volMean, 2), 0) / recentReturns.length);
    const annualizedVol = volStd * Math.sqrt(365 * 24); // 小时K线年化

    // 波动率体制判断
    let volRegime = 'normal';
    if (annualizedVol > 0.30) volRegime = 'high';
    else if (annualizedVol > 0.50) volRegime = 'extreme';
    else if (annualizedVol < 0.12) volRegime = 'low';

    // ═══ 3. 成交量分析 ═══
    const recentVol = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const prevVol = volumes.slice(-30, -10).reduce((a, b) => a + b, 0) / 20;
    const volRatio = prevVol > 0 ? recentVol / prevVol : 1;
    const highVolume = volRatio > 1.5;
    const lowVolume = volRatio < 0.5;

    // ═══ 4. 价格位置分析（相对近期高低点）═══
    const recentHigh = Math.max(...highs.slice(-this.lookback));
    const recentLow = Math.min(...lows.slice(-this.lookback));
    const priceRange = recentHigh - recentLow;
    const pricePosition = priceRange > 0 ? (currentPrice - recentLow) / priceRange : 0.5;

    // 接近高低点检测
    const nearHigh = pricePosition > 0.9;
    const nearLow = pricePosition < 0.1;

    // ═══ 5. 动量耗尽检测 ═══
    const roc5 = closes[n-1] / closes[Math.max(0, n-6)] - 1;
    const roc20 = closes[n-1] / closes[Math.max(0, n-21)] - 1;

    // 快速上涨后减速 = 顶部信号
    const momentumExhaust = roc5 > 0.02 && roc20 > 0.05 && Math.abs(roc5) < Math.abs(roc20) * 0.5;
    // 快速下跌后减速 = 底部信号
    const momentumBottom = roc5 < -0.02 && roc20 < -0.05 && Math.abs(roc5) < Math.abs(roc20) * 0.5;

    // ═══ 6. 跨市场代理数据 ═══
    // 如果有DXY/VIX数据，可以使用
    const btcTrend = crossData.btcTrend || 0; // BTC上升=美元可能弱=利好黄金
    const vixLevel = crossData.vixLevel || 0;

    // ═══ 综合评分 ═══
    let score = 0;
    const reasons = [];

    // 趋势结构 (+25)
    if (bullAlign) { score += 25; reasons.push('BULL_TREND_STRUCT'); }
    else if (bearAlign) { score -= 25; reasons.push('BEAR_TREND_STRUCT'); }
    else { reasons.push('NEUTRAL_TREND'); }

    // 波动率体制 (+15)
    if (volRegime === 'low') { score += 10; reasons.push(`VOL_LOW(${(annualizedVol*100).toFixed(1)}%)`); }
    else if (volRegime === 'high') { score -= 10; reasons.push(`VOL_HIGH(${(annualizedVol*100).toFixed(1)}%)`); }
    else if (volRegime === 'extreme') { reasons.push(`VOL_EXTREME(${(annualizedVol*100).toFixed(1)}%)`); }

    // 成交量 (+15)
    if (highVolume && trendStrength > 0) { score += 15; reasons.push(`VOL_CONFIRM_UP(ratio=${volRatio.toFixed(2)})`); }
    else if (highVolume && trendStrength < 0) { score -= 15; reasons.push(`VOL_CONFIRM_DOWN(ratio=${volRatio.toFixed(2)})`); }
    else if (lowVolume) { reasons.push(`VOL_LOW(ratio=${volRatio.toFixed(2)})`); }

    // 价格位置 (+20)
    if (nearLow && trendStrength >= 0) { score += 20; reasons.push(`NEAR_SUPPORT(pos=${(pricePosition*100).toFixed(0)}%)`); }
    else if (nearHigh && trendStrength <= 0) { score -= 20; reasons.push(`NEAR_RESISTANCE(pos=${(pricePosition*100).toFixed(0)}%)`); }

    // 动量耗尽 (+15)
    if (momentumExhaust) { score -= 15; reasons.push('MOMENTUM_EXHAUST_TOP'); }
    if (momentumBottom) { score += 15; reasons.push('MOMENTUM_BOTTOM'); }

    // 跨市场 (+10)
    if (btcTrend > 0) { score += 5; reasons.push('BTC_POSITIVE_PROXY'); }
    if (vixLevel > 25) { score += 10; reasons.push(`VIX_HIGH(${vixLevel.toFixed(0)})`); }

    // 归一化
    const normalized = Math.max(-100, Math.min(100, score));

    let action = 'HOLD';
    if (normalized > 25) action = 'BUY';
    else if (normalized < -25) action = 'SELL';

    const confidence = Math.min(1, Math.abs(normalized) / 65);

    return {
      valid: true,
      action,
      score: normalized,
      confidence,
      reasons,
      indicators: {
        ema10, ema20, ema50,
        bullAlign, bearAlign, trendStrength,
        volRegime, annualizedVol,
        volRatio, highVolume, lowVolume,
        pricePosition, nearHigh, nearLow,
        recentHigh, recentLow,
        roc5, roc20,
        momentumExhaust, momentumBottom,
      },
      source: 'gold-macro-factor',
    };
  }

  _ema(data, period) {
    if (data.length < period) return data[data.length - 1];
    const k = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < data.length; i++) {
      ema = data[i] * k + ema * (1 - k);
    }
    return ema;
  }

  getSummary() {
    return { name: 'GoldMacroFactor', description: '趋势结构+波动率体制+成交量+宏观代理' };
  }
}

module.exports = { GoldMacroFactor };
