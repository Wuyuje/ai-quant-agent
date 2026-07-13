/**
 * Gold Momentum Strategy — 黄金动量趋势跟踪
 * 
 * 世界级策略参考:
 * - Turtle Trading (海龟交易法则) — Donchian通道突破 + ATR过滤
 * - Dual Thrust — 区间突破系统
 * - 趋势强度量化 — ADX + EMA交叉确认
 * 
 * 黄金特性:
 * - 强趋势性（受宏观事件驱动）
 * - 日内波动较大（美盘/亚盘时段差异）
 * - 避险属性（与美元负相关）
 */

class GoldMomentum {
  constructor(config = {}) {
    this.atrPeriod = config.atrPeriod || 14;
    this.adxPeriod = config.adxPeriod || 14;
    this.emaFast = config.emaFast || 21;
    this.emaSlow = config.emaSlow || 55;
    this.donchianPeriod = config.donchianPeriod || 20;
    this.adxThreshold = config.adxThreshold || 25; // ADX > 25 趋势有效
  }

  /**
   * 分析黄金动量
   */
  analyze(klines, currentPrice) {
    if (!klines || klines.length < 60) {
      return { valid: false, reason: 'K线不足60根' };
    }

    const closes = klines.map(k => k.close);
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);
    const n = closes.length;

    // ═══ 1. Donchian Channel 突破 ═══
    const dcHigh = Math.max(...highs.slice(-this.donchianPeriod));
    const dcLow = Math.min(...lows.slice(-this.donchianPeriod));
    const dcMid = (dcHigh + dcLow) / 2;
    const dcBreakUp = currentPrice > dcHigh;
    const dcBreakDown = currentPrice < dcLow;

    // ═══ 2. EMA交叉 ═══
    const emaFast = this._ema(closes, this.emaFast);
    const emaSlow = this._ema(closes, this.emaSlow);
    const emaFastPrev = this._ema(closes.slice(0, -1), this.emaFast);
    const emaSlowPrev = this._ema(closes.slice(0, -1), this.emaSlow);
    const emaGoldenCross = emaFast > emaSlow && emaFastPrev <= emaSlowPrev;
    const emaDeathCross = emaFast < emaSlow && emaFastPrev >= emaSlowPrev;
    const emaBullish = emaFast > emaSlow;
    const emaBearish = emaFast < emaSlow;

    // ═══ 3. ADX趋势强度 ═══
    const adxResult = this._calcADX(highs, lows, closes, this.adxPeriod);
    const strongTrend = adxResult.adx > this.adxThreshold;

    // ═══ 4. ATR波动率 ═══
    const atr = this._calcATR(highs, lows, closes, this.atrPeriod);
    const atrPct = currentPrice > 0 ? (atr / currentPrice * 100) : 0;

    // ═══ 5. RSI动量 ═══
    const rsi = this._calcRSI(closes, 14);

    // ═══ 6. 价格动量（ROC） ═══
    const roc5 = closes[n - 1] / closes[Math.max(0, n - 6)] - 1;
    const roc20 = closes[n - 1] / closes[Math.max(0, n - 21)] - 1;

    // ═══ 综合评分 ═══
    let score = 0;
    const reasons = [];

    // Donchian突破 (+30)
    if (dcBreakUp) { score += 30; reasons.push('DONCHIAN_BREAK_UP'); }
    if (dcBreakDown) { score -= 30; reasons.push('DONCHIAN_BREAK_DOWN'); }

    // EMA交叉 (+25)
    if (emaGoldenCross) { score += 25; reasons.push('EMA_GOLDEN_CROSS'); }
    else if (emaDeathCross) { score -= 25; reasons.push('EMA_DEATH_CROSS'); }
    else if (emaBullish) { score += 10; reasons.push('EMA_BULLISH'); }
    else if (emaBearish) { score -= 10; reasons.push('EMA_BEARISH'); }

    // ADX趋势强度 (+20)
    if (strongTrend) {
      const adxBonus = Math.min(20, (adxResult.adx - this.adxThreshold) * 0.8);
      score += (adxResult.plusDI > adxResult.minusDI ? 1 : -1) * adxBonus;
      reasons.push(`ADX_STRONG(${adxResult.adx.toFixed(1)})`);
    } else {
      reasons.push(`ADX_WEAK(${adxResult.adx.toFixed(1)})`);
    }

    // RSI (+15)
    if (rsi > 70) { score -= (rsi - 70) * 0.5; reasons.push(`RSI_OVERBOUGHT(${rsi.toFixed(1)})`); }
    else if (rsi < 30) { score += (30 - rsi) * 0.5; reasons.push(`RSI_OVERSOLD(${rsi.toFixed(1)})`); }
    else if (rsi > 55) { score += 5; reasons.push(`RSI_BULL(${rsi.toFixed(1)})`); }
    else if (rsi < 45) { score -= 5; reasons.push(`RSI_BEAR(${rsi.toFixed(1)})`); }

    // ROC动量 (+10)
    if (roc5 > 0.005) { score += 10; reasons.push(`ROC5_BULL(${(roc5*100).toFixed(2)}%)`); }
    else if (roc5 < -0.005) { score -= 10; reasons.push(`ROC5_BEAR(${(roc5*100).toFixed(2)}%)`); }

    // 归一化到 -100 ~ 100
    const normalized = Math.max(-100, Math.min(100, score));

    // 信号判定
    let action = 'HOLD';
    if (normalized > 35) action = 'BUY';
    else if (normalized < -35) action = 'SELL';

    // 置信度
    const confidence = Math.min(1, Math.abs(normalized) / 80);

    return {
      valid: true,
      action,
      score: normalized,
      confidence,
      reasons,
      indicators: {
        dcHigh, dcLow, dcMid, dcBreakUp, dcBreakDown,
        emaFast, emaSlow, emaBullish, emaBearish,
        adx: adxResult.adx, plusDI: adxResult.plusDI, minusDI: adxResult.minusDI,
        atr, atrPct,
        rsi,
        roc5, roc20,
      },
      source: 'gold-momentum',
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
    const rs = gains / losses;
    return 100 - 100 / (1 + rs);
  }

  _calcADX(highs, lows, closes, period) {
    const n = highs.length;
    if (n < period * 2) return { adx: 0, plusDI: 0, minusDI: 0 };

    const tr = [], plusDM = [], minusDM = [];
    for (let i = 1; i < n; i++) {
      tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
      const up = highs[i] - highs[i-1];
      const down = lows[i-1] - lows[i];
      plusDM.push(up > down && up > 0 ? up : 0);
      minusDM.push(down > up && down > 0 ? down : 0);
    }

    const smooth = (arr, p) => {
      const s = [arr.slice(0, p).reduce((a, b) => a + b, 0)];
      for (let i = p; i < arr.length; i++) s.push(s[s.length-1] - s[s.length-1]/p + arr[i]);
      return s;
    };

    const sTR = smooth(tr, period), sPDM = smooth(plusDM, period), sMDM = smooth(minusDM, period);
    const dxArr = [];
    for (let i = 0; i < sTR.length; i++) {
      const pdi = sTR[i] ? sPDM[i] / sTR[i] * 100 : 0;
      const mdi = sTR[i] ? sMDM[i] / sTR[i] * 100 : 0;
      dxArr.push(pdi + mdi > 0 ? Math.abs(pdi - mdi) / (pdi + mdi) * 100 : 0);
    }

    const lastPDI = sTR.length ? sPDM[sTR.length-1] / sTR[sTR.length-1] * 100 : 0;
    const lastMDI = sTR.length ? sMDM[sTR.length-1] / sTR[sTR.length-1] * 100 : 0;
    let adx = 0;
    if (dxArr.length >= period) adx = dxArr.slice(-period).reduce((a, b) => a + b, 0) / period;

    return { adx, plusDI: lastPDI, minusDI: lastMDI };
  }

  getSummary() {
    return { name: 'GoldMomentum', description: 'Donchian突破+EMA交叉+ADX趋势+RSI动量' };
  }
}

module.exports = { GoldMomentum };
