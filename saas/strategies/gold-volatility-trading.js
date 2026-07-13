/**
 * Gold Volatility Trading — 黄金波动率交易策略
 * 
 * 世界级策略参考:
 * - Straddle/Strangle — 波动率突破
 * - Keltner Channel Breakout — ATR通道突破
 * - Adaptive Position Sizing — 自适应仓位
 * - Time-of-Day Analysis — 时段分析（亚盘/欧盘/美盘）
 * 
 * 黄金特殊时段:
 * - 亚盘(00:00-08:00 UTC): 低波动，趋势弱
 * - 欧盘(08:00-13:00 UTC): 中等波动
 * - 美盘(13:00-21:00 UTC): 高波动，趋势强
 * - 美盘开盘(13:30 UTC)经常有数据行情
 */

class GoldVolatilityTrading {
  constructor(config = {}) {
    this.atrPeriod = config.atrPeriod || 14;
    this.keltnerPeriod = config.keltnerPeriod || 20;
    this.keltnerMult = config.keltnerMult || 1.5;
    this.volBreakoutMultiplier = config.volBreakoutMultiplier || 1.5;
  }

  /**
   * 分析波动率交易信号
   */
  analyze(klines, currentPrice) {
    if (!klines || klines.length < 40) {
      return { valid: false, reason: 'K线不足40根' };
    }

    const closes = klines.map(k => k.close);
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);
    const n = closes.length;

    // ═══ 1. Keltner Channel ═══
    const ema20 = this._ema(closes, this.keltnerPeriod);
    const atr = this._calcATR(highs, lows, closes, this.atrPeriod);
    const kcUpper = ema20 + this.keltnerMult * atr;
    const kcLower = ema20 - this.keltnerMult * atr;

    const kcBreakUp = currentPrice > kcUpper;
    const kcBreakDown = currentPrice < kcLower;

    // ═══ 2. ATR波动率分析 ═══
    const atrPct = currentPrice > 0 ? (atr / currentPrice * 100) : 0;

    // 历史ATR百分位
    const atrHistory = [];
    for (let i = this.atrPeriod + 1; i < n; i++) {
      const periodAtr = this._calcATR(highs.slice(0, i + 1), lows.slice(0, i + 1), closes.slice(0, i + 1), this.atrPeriod);
      atrHistory.push(periodAtr);
    }
    const atrPctHistory = atrHistory.map(a => currentPrice > 0 ? (a / currentPrice * 100) : 0);
    const atrPercentile = atrPctHistory.length > 0
      ? atrPctHistory.filter(v => v <= atrPct).length / atrPctHistory.length * 100
      : 50;

    // 波动率突破
    const recentATR = atrHistory.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const volExpansion = atr > recentATR * this.volBreakoutMultiplier;

    // ═══ 3. 时段分析 ═══
    const hour = new Date().getUTCHours();
    let session = 'asian';
    let sessionVolatility = 0.6;
    if (hour >= 8 && hour < 13) { session = 'european'; sessionVolatility = 0.8; }
    else if (hour >= 13 && hour < 21) { session = 'us'; sessionVolatility = 1.0; }
    else if (hour >= 21 || hour < 1) { session = 'transition'; sessionVolatility = 0.5; }

    // 美盘开盘效应（13:00-15:00 UTC 高波动）
    const isUSDOpen = hour >= 13 && hour < 15;

    // ═══ 4. 波动率均值回归 ═══
    // 高波动后回归概率高
    const highVolRegime = atrPercentile > 80;
    const lowVolRegime = atrPercentile < 20;

    // ═══ 5. 真实波幅突破 ═══
    const lastRange = highs[n - 1] - lows[n - 1];
    const avgRange = highs.slice(-20).reduce((a, h, i) => a + (h - lows[n - 20 + i]), 0) / 20;
    const rangeBreakout = lastRange > avgRange * 1.8;

    // ═══ 6. 收盘价位置（K线实体位置）═══
    const body = Math.abs(closes[n - 1] - klines[n - 1].open);
    const fullRange = highs[n - 1] - lows[n - 1];
    const bodyRatio = fullRange > 0 ? body / fullRange : 0.5;
    const isBullCandle = closes[n - 1] > klines[n - 1].open;

    // ═══ 综合评分 ═══
    let score = 0;
    const reasons = [];

    // Keltner Channel突破 (+30)
    if (kcBreakUp) { score += 30; reasons.push('KC_BREAK_UP'); }
    else if (kcBreakDown) { score -= 30; reasons.push('KC_BREAK_DOWN'); }

    // 波动率扩张 (+20)
    if (volExpansion) {
      const volScore = isBullCandle ? 20 : -20;
      score += volScore;
      reasons.push(`VOL_EXPANSION(${(atrPct).toFixed(2)}%)`);
    }

    // 时段因子 (+15)
    if (session === 'us' && isUSDOpen) { score += (isBullCandle ? 10 : -10); reasons.push('US_OPEN_BOOST'); }
    else if (session === 'asian') { reasons.push('ASIAN_SESSION_LOW_VOL'); }

    // 波动率均值回归 (+15)
    if (highVolRegime) { score += (isBullCandle ? -10 : 10); reasons.push(`HIGH_VOL_REGIME(pctile=${atrPercentile.toFixed(0)}%)`); }
    if (lowVolRegime) { reasons.push(`LOW_VOL_REGIME(pctile=${atrPercentile.toFixed(0)}%)`); }

    // 范围突破 (+10)
    if (rangeBreakout) {
      score += (isBullCandle ? 10 : -10);
      reasons.push(`RANGE_BREAKOUT(ratio=${(lastRange / avgRange).toFixed(2)})`);
    }

    // K线实体确认 (+10)
    if (bodyRatio > 0.7) {
      score += (isBullCandle ? 10 : -10);
      reasons.push(`STRONG_BODY(ratio=${(bodyRatio * 100).toFixed(0)}%)`);
    }

    // 归一化
    const normalized = Math.max(-100, Math.min(100, score));

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
        kcUpper, kcLower, ema20, kcBreakUp, kcBreakDown,
        atr, atrPct, atrPercentile,
        volExpansion, recentATR,
        session, sessionVolatility, isUSDOpen,
        highVolRegime, lowVolRegime,
        lastRange, avgRange, rangeBreakout,
        bodyRatio, isBullCandle,
      },
      source: 'gold-volatility-trading',
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

  _calcATR(highs, lows, closes, period) {
    const trs = [];
    for (let i = 1; i < highs.length; i++) {
      trs.push(Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      ));
    }
    if (trs.length < period) return 0;
    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  }

  getSummary() {
    return { name: 'GoldVolatilityTrading', description: 'Keltner突破+ATR波动率+时段分析+范围突破' };
  }
}

module.exports = { GoldVolatilityTrading };
