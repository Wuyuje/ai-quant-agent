/**
 * v85: ATR趋势跟踪策略
 * 
 * 基于ATR的趋势跟踪——高波动率趋势市场中最有效的策略
 * 核心思想：趋势方向+ATR通道突破+波动率过滤
 * 
 * 信号逻辑：
 * - 价格突破ATR上轨 + ADX>25 → LONG (趋势突破)
 * - 价格跌破ATR下轨 + ADX>25 → SHORT (趋势突破)
 * - ATR收窄后突破 → 高概率信号 (挤压突破)
 * - ATR放大+方向一致 → 趋势加速
 */

class ATRTrend {
  constructor(config = {}) {
    this.atrPeriod = config.atrPeriod || 14;
    this.atrMult = config.atrMult || 2.0;  // ATR通道倍数
    this.squeezeThreshold = config.squeezeThreshold || 0.5;  // ATR收窄阈值(%)
    this.minBars = config.minBars || 50;
  }

  _calcATR(klines, period) {
    if (klines.length < period + 1) return { atr: 0, trs: [] };
    const trs = [];
    for (let i = 1; i < klines.length; i++) {
      const h = klines[i].high;
      const l = klines[i].low;
      const pc = klines[i - 1].close;
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    // Wilder smoothing
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trs.length; i++) {
      atr = (atr * (period - 1) + trs[i]) / period;
    }
    return { atr, trs };
  }

  _calcADX(klines, period = 14) {
    if (klines.length < period * 2) return 20;
    const plusDMs = [], minusDMs = [], trs = [];
    for (let i = 1; i < klines.length; i++) {
      const upMove = klines[i].high - klines[i - 1].high;
      const downMove = klines[i - 1].low - klines[i].low;
      plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
      minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
      trs.push(Math.max(klines[i].high - klines[i].low,
        Math.abs(klines[i].high - klines[i - 1].close),
        Math.abs(klines[i].low - klines[i - 1].close)));
    }
    // Smoothed
    let plusDM = plusDMs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let minusDM = minusDMs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let tr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const dxs = [];
    for (let i = period; i < trs.length; i++) {
      plusDM = (plusDM * (period - 1) + plusDMs[i]) / period;
      minusDM = (minusDM * (period - 1) + minusDMs[i]) / period;
      tr = (tr * (period - 1) + trs[i]) / period;
      const diPlus = tr > 0 ? (plusDM / tr) * 100 : 0;
      const diMinus = tr > 0 ? (minusDM / tr) * 100 : 0;
      const dx = (diPlus + diMinus) > 0 ? Math.abs(diPlus - diMinus) / (diPlus + diMinus) * 100 : 0;
      dxs.push(dx);
    }
    return dxs.length > 0 ? dxs.slice(-period).reduce((a, b) => a + b, 0) / period : 20;
  }

  /**
   * 检测ATR挤压（波动率收窄后即将突破）
   */
  detectSqueeze(atrValues, currentPrice) {
    if (atrValues.length < 20) return false;
    const recent = atrValues.slice(-20);
    const currentATR = recent[recent.length - 1] / currentPrice * 100;
    const avgATR = recent.reduce((a, b) => a + b, 0) / 20 / currentPrice * 100;
    const minATR = Math.min(...recent) / currentPrice * 100;
    
    // 当前ATR是近20根中最低的25% → 挤压
    return currentATR < avgATR * 0.6 && currentATR < this.squeezeThreshold;
  }

  /**
   * 核心信号
   */
  signal(klines) {
    if (!klines || klines.length < this.minBars) {
      return { action: 'FLAT', confidence: 0, reasoning: '数据不足' };
    }

    const { atr, trs } = this._calcATR(klines, this.atrPeriod);
    const adx = this._calcADX(klines);
    const closes = klines.map(k => k.close);
    const currentPrice = closes[closes.length - 1];
    
    // ATR通道
    const upperBand = currentPrice + atr * this.atrMult;
    const lowerBand = currentPrice - atr * this.atrMult;
    
    // 使用前一根K线的收盘价和通道判断突破
    const prevClose = closes[closes.length - 2];
    const prevUpper = prevClose + atr * this.atrMult;
    const prevLower = prevClose - atr * this.atrMult;
    
    // ATR趋势
    const atrPct = (atr / currentPrice) * 100;
    const atrValues = trs.slice(-20);
    const atrGrowing = atrValues.length >= 3 && 
      atrValues[atrValues.length - 1] > atrValues[atrValues.length - 3];
    
    // 挤压检测
    const squeeze = this.detectSqueeze(trs, currentPrice);
    
    // EMA趋势方向
    const ema20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const ema50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
    const trendUp = ema20 > ema50;
    const trendDown = ema20 < ema50;
    
    let action = 'FLAT';
    let confidence = 0;
    let reasons = [];
    
    // ═══ 信号判定 ═══
    
    // 1. ATR上轨突破 + ADX强趋势 → 做多
    if (prevClose <= prevUpper && currentPrice > prevUpper && adx > 25) {
      action = 'LONG';
      confidence = 0.7;
      reasons.push(`ATR上轨突破 ADX=${adx.toFixed(0)}`);
    }
    // 2. ATR下轨突破 + ADX强趋势 → 做空
    else if (prevClose >= prevLower && currentPrice < prevLower && adx > 25) {
      action = 'SHORT';
      confidence = 0.7;
      reasons.push(`ATR下轨突破 ADX=${adx.toFixed(0)}`);
    }
    // 3. 挤压突破 + 上轨突破 → 强做多
    else if (squeeze && currentPrice > prevUpper) {
      action = 'LONG';
      confidence = 0.8;
      reasons.push('ATR挤压突破做多');
    }
    // 4. 挤压突破 + 下轨突破 → 强做空
    else if (squeeze && currentPrice < prevLower) {
      action = 'SHORT';
      confidence = 0.8;
      reasons.push('ATR挤压突破做空');
    }
    // 5. 趋势方向 + ATR放大 + 价格在通道上半部 → 做多
    else if (trendUp && atrGrowing && currentPrice > (upperBand + lowerBand) / 2 && adx > 20) {
      action = 'LONG';
      confidence = 0.55;
      reasons.push(`上升趋势+ATR放大 ADX=${adx.toFixed(0)}`);
    }
    // 6. 趋势方向 + ATR放大 + 价格在通道下半部 → 做空
    else if (trendDown && atrGrowing && currentPrice < (upperBand + lowerBand) / 2 && adx > 20) {
      action = 'SHORT';
      confidence = 0.55;
      reasons.push(`下降趋势+ATR放大 ADX=${adx.toFixed(0)}`);
    }
    // 7. 强ADX + 趋势一致 → 跟随
    else if (adx > 30 && trendUp) {
      action = 'LONG';
      confidence = 0.45;
      reasons.push(`强趋势ADX=${adx.toFixed(0)}向上`);
    }
    else if (adx > 30 && trendDown) {
      action = 'SHORT';
      confidence = 0.45;
      reasons.push(`强趋势ADX=${adx.toFixed(0)}向下`);
    }
    else {
      action = 'FLAT';
      confidence = 0;
      reasons.push(`ATR=${atrPct.toFixed(2)}% ADX=${adx.toFixed(0)} 无信号`);
    }

    return {
      action,
      confidence: Math.min(confidence, 1),
      reasoning: reasons.join(' | '),
      indicators: {
        atr: parseFloat(atr.toFixed(6)),
        atrPct: parseFloat(atrPct.toFixed(4)),
        adx: parseFloat(adx.toFixed(2)),
        squeeze,
        atrGrowing,
        trendUp,
        trendDown,
      }
    };
  }
}

module.exports = { ATRTrend };
