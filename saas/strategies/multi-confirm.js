/**
 * v85: MultiConfirm 多维度确认策略
 * 
 * 不是简单的多时间框架，而是多维度信号一致性确认
 * 6个维度各自独立判断，只有 ≥4个维度一致才出信号
 * 核心优势：过滤假信号，大幅提高胜率（代价是交易频率降低）
 * 
 * 6个维度：
 * 1. 价格趋势 (EMA 20/50/200)
 * 2. 动量 (RSI + Stochastic)
 * 3. 波动率 (Bollinger Bands + ATR)
 * 4. 成交量 (OBV + Volume Ratio)
 * 5. 市场结构 (Higher Highs/Lower Lows)
 * 6. 趋势强度 (ADX + DI)
 */

class MultiConfirm {
  constructor(config = {}) {
    this.minBars = config.minBars || 200;  // 需要200根K线算MA200
    this.threshold = config.threshold || 4;  // 至少4/6维度一致
    this.strongThreshold = config.strongThreshold || 5;  // 5/6 = 强信号
  }

  _sma(data, period) {
    if (data.length < period) return data[data.length - 1] || 0;
    return data.slice(-period).reduce((a, b) => a + b, 0) / period;
  }

  _ema(data, period) {
    if (data.length < period) return data[data.length - 1] || 0;
    const k = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < data.length; i++) {
      ema = data[i] * k + ema * (1 - k);
    }
    return ema;
  }

  /**
   * 维度1: 价格趋势
   */
  _priceTrend(closes) {
    const ema20 = this._ema(closes, 20);
    const ema50 = this._ema(closes, 50);
    const ema200 = this._ema(closes, 200);
    const price = closes[closes.length - 1];
    
    let score = 0;
    let reasons = [];
    
    if (ema20 > ema50 && ema50 > ema200) { score = 1; reasons.push('EMA多头排列'); }
    else if (ema20 < ema50 && ema50 < ema200) { score = -1; reasons.push('EMA空头排列'); }
    else if (price > ema20 && ema20 > ema50) { score = 0.5; reasons.push('短期偏多'); }
    else if (price < ema20 && ema20 < ema50) { score = -0.5; reasons.push('短期偏空'); }
    
    return { score, reasons };
  }

  /**
   * 维度2: 动量
   */
  _momentum(closes) {
    // RSI
    const rsi = this._calcRSI(closes, 14);
    // Stochastic
    const stoch = this._calcStochastic(closes, 14, 3);
    
    let score = 0;
    let reasons = [];
    
    if (rsi < 30 && stoch < 20) { score = 1; reasons.push(`RSI=${rsi.toFixed(0)}超卖+Stoch=${stoch.toFixed(0)}`); }
    else if (rsi > 70 && stoch > 80) { score = -1; reasons.push(`RSI=${rsi.toFixed(0)}超买+Stoch=${stoch.toFixed(0)}`); }
    else if (rsi > 50 && stoch > 50) { score = 0.5; reasons.push(`RSI=${rsi.toFixed(0)}偏多`); }
    else if (rsi < 50 && stoch < 50) { score = -0.5; reasons.push(`RSI=${rsi.toFixed(0)}偏空`); }
    
    return { score, reasons, rsi, stoch };
  }

  /**
   * 维度3: 波动率
   */
  _volatility(closes) {
    const bb = this._calcBB(closes, 20, 2);
    const price = closes[closes.length - 1];
    
    let score = 0;
    let reasons = [];
    
    if (price < bb.lower) { score = 1; reasons.push('价格低于BB下轨'); }
    else if (price > bb.upper) { score = -1; reasons.push('价格高于BB上轨'); }
    else if (price < bb.mid) { score = 0.3; reasons.push('价格在BB下半部'); }
    else if (price > bb.mid) { score = -0.3; reasons.push('价格在BB上半部'); }
    
    return { score, reasons, bb };
  }

  /**
   * 维度4: 成交量
   */
  _volumeDim(klines) {
    const volumes = klines.map(k => k.volume);
    const closes = klines.map(k => k.close);
    const obv = this._calcOBV(closes, volumes);
    const obvMA = this._sma(obv, 20);
    const volMA = this._sma(volumes, 20);
    const currentVol = volumes[volumes.length - 1];
    const volRatio = volMA > 0 ? currentVol / volMA : 1;
    
    let score = 0;
    let reasons = [];
    
    const obvUp = obv[obv.length - 1] > obvMA;
    const obvDown = obv[obv.length - 1] < obvMA;
    
    if (obvUp && volRatio > 1.2) { score = 1; reasons.push('OBV上升+放量'); }
    else if (obvDown && volRatio > 1.2) { score = -1; reasons.push('OBV下降+放量'); }
    else if (obvUp) { score = 0.5; reasons.push('OBV上升'); }
    else if (obvDown) { score = -0.5; reasons.push('OBV下降'); }
    
    return { score, reasons };
  }

  /**
   * 维度5: 市场结构 (HH/HL 或 LH/LL)
   */
  _marketStructure(klines) {
    if (klines.length < 30) return { score: 0, reasons: ['数据不足'] };
    
    const highs = klines.slice(-30).map(k => k.high);
    const lows = klines.slice(-30).map(k => k.low);
    
    // 找局部高低点（每5根取一个）
    const swingHighs = [];
    const swingLows = [];
    for (let i = 2; i < highs.length - 2; i++) {
      if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2]) {
        swingHighs.push(highs[i]);
      }
      if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2]) {
        swingLows.push(lows[i]);
      }
    }
    
    let score = 0;
    let reasons = [];
    
    if (swingHighs.length >= 2 && swingLows.length >= 2) {
      const hh = swingHighs[swingHighs.length - 1] > swingHighs[swingHighs.length - 2];
      const hl = swingLows[swingLows.length - 1] > swingLows[swingLows.length - 2];
      const lh = swingHighs[swingHighs.length - 1] < swingHighs[swingHighs.length - 2];
      const ll = swingLows[swingLows.length - 1] < swingLows[swingLows.length - 2];
      
      if (hh && hl) { score = 1; reasons.push('上升结构(HH+HL)'); }
      else if (lh && ll) { score = -1; reasons.push('下降结构(LH+LL)'); }
    }
    
    return { score, reasons };
  }

  /**
   * 维度6: 趋势强度 (ADX)
   */
  _trendStrength(klines) {
    if (klines.length < 30) return { score: 0, reasons: ['数据不足'], adx: 20 };
    
    // 简化ADX计算
    const period = 14;
    const plusDMs = [], minusDMs = [], trs = [];
    for (let i = 1; i < klines.length; i++) {
      const up = klines[i].high - klines[i-1].high;
      const down = klines[i-1].low - klines[i].low;
      plusDMs.push(up > down && up > 0 ? up : 0);
      minusDMs.push(down > up && down > 0 ? down : 0);
      trs.push(Math.max(klines[i].high - klines[i].low,
        Math.abs(klines[i].high - klines[i-1].close),
        Math.abs(klines[i].low - klines[i-1].close)));
    }
    
    let plusDM = plusDMs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let minusDM = minusDMs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let tr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    
    let lastDI = 0;
    for (let i = period; i < trs.length; i++) {
      plusDM = (plusDM * (period - 1) + plusDMs[i]) / period;
      minusDM = (minusDM * (period - 1) + minusDMs[i]) / period;
      tr = (tr * (period - 1) + trs[i]) / period;
      const diP = tr > 0 ? (plusDM / tr) * 100 : 0;
      const diM = tr > 0 ? (minusDM / tr) * 100 : 0;
      lastDI = diP - diM;
    }
    
    const adx = Math.abs(lastDI);
    
    let score = 0;
    let reasons = [];
    
    if (adx > 25 && lastDI > 0) { score = 1; reasons.push(`ADX=${adx.toFixed(0)}强趋势向上`); }
    else if (adx > 25 && lastDI < 0) { score = -1; reasons.push(`ADX=${adx.toFixed(0)}强趋势向下`); }
    else if (adx > 15 && lastDI > 0) { score = 0.3; reasons.push(`ADX=${adx.toFixed(0)}弱趋势向上`); }
    else if (adx > 15 && lastDI < 0) { score = -0.3; reasons.push(`ADX=${adx.toFixed(0)}弱趋势向下`); }
    else { reasons.push(`ADX=${adx.toFixed(0)}无趋势`); }
    
    return { score, reasons, adx };
  }

  _calcRSI(closes, period) {
    if (closes.length < period + 1) return 50;
    const changes = [];
    for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i-1]);
    let gains = 0, losses = 0;
    for (let i = 0; i < period; i++) {
      if (changes[i] > 0) gains += changes[i]; else losses += Math.abs(changes[i]);
    }
    let avgG = gains / period, avgL = (losses / period) || 0.0001;
    for (let i = period; i < changes.length; i++) {
      avgG = (avgG * (period - 1) + (changes[i] > 0 ? changes[i] : 0)) / period;
      avgL = (avgL * (period - 1) + (changes[i] < 0 ? Math.abs(changes[i]) : 0)) / period;
    }
    return avgL === 0 ? 100 : 100 - (100 / (1 + avgG / avgL));
  }

  _calcStochastic(closes, kPeriod, dPeriod) {
    if (closes.length < kPeriod) return 50;
    const recent = closes.slice(-kPeriod);
    const highest = Math.max(...recent);
    const lowest = Math.min(...recent);
    const current = closes[closes.length - 1];
    return highest === lowest ? 50 : ((current - lowest) / (highest - lowest)) * 100;
  }

  _calcBB(closes, period, mult) {
    if (closes.length < period) {
      const mid = closes[closes.length - 1];
      return { upper: mid, mid, lower: mid, width: 0 };
    }
    const mid = this._sma(closes, period);
    const variance = closes.slice(-period).reduce((s, c) => s + Math.pow(c - mid, 2), 0) / period;
    const std = Math.sqrt(variance);
    return { upper: mid + mult * std, mid, lower: mid - mult * std, width: mid > 0 ? (2 * mult * std / mid * 100) : 0 };
  }

  _calcOBV(closes, volumes) {
    const obv = [0];
    for (let i = 1; i < closes.length; i++) {
      obv.push(obv[obv.length - 1] + (closes[i] > closes[i-1] ? volumes[i] : closes[i] < closes[i-1] ? -volumes[i] : 0));
    }
    return obv;
  }

  /**
   * 核心信号：6维度投票
   */
  signal(klines) {
    if (!klines || klines.length < this.minBars) {
      return { action: 'FLAT', confidence: 0, reasoning: '数据不足(需200根K线)' };
    }

    const closes = klines.map(k => k.close);
    
    // 6维度独立评分
    const d1 = this._priceTrend(closes);
    const d2 = this._momentum(closes);
    const d3 = this._volatility(closes);
    const d4 = this._volumeDim(klines);
    const d5 = this._marketStructure(klines);
    const d6 = this._trendStrength(klines);
    
    const dims = [
      { name: '价格趋势', ...d1 },
      { name: '动量', ...d2 },
      { name: '波动率', ...d3 },
      { name: '成交量', ...d4 },
      { name: '市场结构', ...d5 },
      { name: '趋势强度', ...d6 },
    ];
    
    // 投票
    let bullVotes = 0, bearVotes = 0, totalStrength = 0;
    let bullReasons = [], bearReasons = [];
    
    for (const dim of dims) {
      if (dim.score > 0.2) {
        bullVotes++;
        totalStrength += dim.score;
        bullReasons.push(...dim.reasons);
      } else if (dim.score < -0.2) {
        bearVotes++;
        totalStrength += Math.abs(dim.score);
        bearReasons.push(...dim.reasons);
      }
    }
    
    let action = 'FLAT';
    let confidence = 0;
    let reasons = [];
    
    if (bullVotes >= this.threshold && bullVotes > bearVotes) {
      action = 'LONG';
      confidence = bullVotes >= this.strongThreshold ? 0.85 : 0.65;
      reasons = [`${bullVotes}/6维度看多`, ...bullReasons];
    } else if (bearVotes >= this.threshold && bearVotes > bullVotes) {
      action = 'SHORT';
      confidence = bearVotes >= this.strongThreshold ? 0.85 : 0.65;
      reasons = [`${bearVotes}/6维度看空`, ...bearReasons];
    } else {
      action = 'FLAT';
      confidence = 0;
      reasons = [`多空分歧 ${bullVotes}多/${bearVotes}空 未达${this.threshold}阈值`];
    }

    return {
      action,
      confidence: Math.min(confidence, 1),
      reasoning: reasons.join(' | '),
      indicators: {
        bullVotes,
        bearVotes,
        dimensions: dims.map(d => ({ name: d.name, score: parseFloat(d.score.toFixed(2)) })),
        adx: d6.adx,
        rsi: d2.rsi,
      }
    };
  }
}

module.exports = { MultiConfirm };
