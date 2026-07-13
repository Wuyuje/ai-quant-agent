/**
 * v85: RSI反转策略
 * 
 * 与MA交叉互补——MA是趋势跟踪，RSI是均值回归
 * 在超卖/超买区域反转时入场，趋势确认时加仓
 * 核心优势：在震荡市中MA交叉频繁假信号时，RSI反转更稳定
 * 
 * 信号逻辑：
 * - RSI<30 + MACD金叉 → LONG (超卖反转)
 * - RSI>70 + MACD死叉 → SHORT (超买反转)
 * - RSI背离 → 强反转信号
 * - 趋势中RSI回踩30/70 → 顺势入场
 */

class RSIReversal {
  constructor(config = {}) {
    this.rsiPeriod = config.rsiPeriod || 14;
    this.oversold = config.oversold || 30;
    this.overbought = config.overbought || 70;
    this.strongOversold = config.strongOversold || 20;
    this.strongOverbought = config.strongOverbought || 80;
    this.minBars = config.minBars || 50;
  }

  /**
   * 计算RSI (Wilder's smoothing)
   */
  calcRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    const changes = [];
    for (let i = 1; i < closes.length; i++) {
      changes.push(closes[i] - closes[i - 1]);
    }
    let gains = 0, losses = 0;
    for (let i = 0; i < period; i++) {
      if (changes[i] > 0) gains += changes[i];
      else losses += Math.abs(changes[i]);
    }
    let avgGain = gains / period;
    let avgLoss = losses / period || 0.0001;
    // Wilder smoothing
    for (let i = period; i < changes.length; i++) {
      avgGain = (avgGain * (period - 1) + (changes[i] > 0 ? changes[i] : 0)) / period;
      avgLoss = (avgLoss * (period - 1) + (changes[i] < 0 ? Math.abs(changes[i]) : 0)) / period;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  /**
   * 计算MACD
   */
  calcMACD(closes, fast = 12, slow = 26, signal = 9) {
    if (closes.length < slow + signal) return { macd: 0, signal: 0, histogram: 0 };
    const emaFast = this._ema(closes, fast);
    const emaSlow = this._ema(closes, slow);
    const macdLine = [];
    for (let i = 0; i < emaFast.length; i++) {
      const idx = i + (closes.length - emaFast.length);
      if (idx < closes.length && i < emaSlow.length) {
        macdLine.push(emaFast[i] - emaSlow[idx - (closes.length - emaSlow.length)]);
      }
    }
    if (macdLine.length < signal) return { macd: 0, signal: 0, histogram: 0 };
    const signalLine = this._ema(macdLine, signal);
    const macd = macdLine[macdLine.length - 1];
    const sig = signalLine[signalLine.length - 1] || 0;
    return { macd, signal: sig, histogram: macd - sig };
  }

  _ema(data, period) {
    if (data.length < period) return data;
    const k = 2 / (period + 1);
    const ema = [data.slice(0, period).reduce((a, b) => a + b, 0) / period];
    for (let i = period; i < data.length; i++) {
      ema.push(data[i] * k + ema[ema.length - 1] * (1 - k));
    }
    return ema;
  }

  /**
   * 检测RSI背离
   * 价格新低但RSI不新低 → 看涨背离
   * 价格新高但RSI不新高 → 看跌背离
   */
  detectDivergence(closes, rsiValues) {
    if (closes.length < 30 || rsiValues.length < 30) return { bullDiv: false, bearDiv: false };
    
    const lookback = 30;
    const recentCloses = closes.slice(-lookback);
    const recentRSI = rsiValues.slice(-lookback);
    
    // 找最近两个低点
    let lowest1 = Infinity, lowest2 = Infinity;
    let lowest1Idx = 0, lowest2Idx = 0;
    for (let i = 0; i < lookback; i++) {
      if (recentCloses[i] < lowest1) {
        lowest2 = lowest1; lowest2Idx = lowest1Idx;
        lowest1 = recentCloses[i]; lowest1Idx = i;
      } else if (recentCloses[i] < lowest2) {
        lowest2 = recentCloses[i]; lowest2Idx = i;
      }
    }
    
    // 找最近两个高点
    let highest1 = -Infinity, highest2 = -Infinity;
    let highest1Idx = 0, highest2Idx = 0;
    for (let i = 0; i < lookback; i++) {
      if (recentCloses[i] > highest1) {
        highest2 = highest1; highest2Idx = highest1Idx;
        highest1 = recentCloses[i]; highest1Idx = i;
      } else if (recentCloses[i] > highest2) {
        highest2 = recentCloses[i]; highest2Idx = i;
      }
    }
    
    // 看涨背离: 价格新低 但 RSI未新低
    const bullDiv = lowest1 < lowest2 && recentRSI[lowest1Idx] > recentRSI[lowest2Idx];
    // 看跌背离: 价格新高 但 RSI未新高
    const bearDiv = highest1 > highest2 && recentRSI[highest1Idx] < recentRSI[highest2Idx];
    
    return { bullDiv, bearDiv };
  }

  /**
   * 核心：生成信号
   * @param {Array} klines - K线数据 [{open, high, low, close, volume}]
   * @returns {Object} { action, confidence, reasoning }
   */
  signal(klines) {
    if (!klines || klines.length < this.minBars) {
      return { action: 'FLAT', confidence: 0, reasoning: '数据不足' };
    }

    const closes = klines.map(k => k.close);
    const rsi = this.calcRSI(closes, this.rsiPeriod);
    const rsiPrev = this.calcRSI(closes.slice(0, -1), this.rsiPeriod);
    const macd = this.calcMACD(closes);
    
    // 计算RSI历史用于背离检测
    const rsiHistory = [];
    for (let i = 26 + 14; i <= closes.length; i++) {
      rsiHistory.push(this.calcRSI(closes.slice(0, i), this.rsiPeriod));
    }
    const { bullDiv, bearDiv } = this.detectDivergence(closes, rsiHistory);
    
    // EMA趋势
    const ema20 = this._ema(closes, 20);
    const ema50 = this._ema(closes, 50);
    const trendUp = ema20[ema20.length - 1] > ema50[ema50.length - 1];
    const trendDown = ema20[ema20.length - 1] < ema50[ema50.length - 1];
    
    const currentPrice = closes[closes.length - 1];
    let action = 'FLAT';
    let confidence = 0;
    let reasons = [];
    
    // ═══ 信号判定 ═══
    
    // 1. 超卖反转 + MACD金叉 → 强做多
    if (rsi < this.oversold && macd.histogram > 0 && macd.macd > macd.signal) {
      action = 'LONG';
      confidence = 0.7;
      reasons.push(`RSI超卖${rsi.toFixed(1)}+MACD金叉`);
    }
    // 2. 超买反转 + MACD死叉 → 强做空
    else if (rsi > this.overbought && macd.histogram < 0 && macd.macd < macd.signal) {
      action = 'SHORT';
      confidence = 0.7;
      reasons.push(`RSI超买${rsi.toFixed(1)}+MACD死叉`);
    }
    // 3. 看涨背离 → 做多
    else if (bullDiv && rsi < 40) {
      action = 'LONG';
      confidence = 0.65;
      reasons.push(`RSI看涨背离+RSI=${rsi.toFixed(1)}`);
    }
    // 4. 看跌背离 → 做空
    else if (bearDiv && rsi > 60) {
      action = 'SHORT';
      confidence = 0.65;
      reasons.push(`RSI看跌背离+RSI=${rsi.toFixed(1)}`);
    }
    // 5. 极度超卖(20以下) → 做多
    else if (rsi < this.strongOversold) {
      action = 'LONG';
      confidence = 0.6;
      reasons.push(`RSI极度超卖${rsi.toFixed(1)}`);
    }
    // 6. 极度超买(80以上) → 做空
    else if (rsi > this.strongOverbought) {
      action = 'SHORT';
      confidence = 0.6;
      reasons.push(`RSI极度超买${rsi.toFixed(1)}`);
    }
    // 7. 趋势中RSI回踩 → 顺势
    else if (trendUp && rsi < 40 && rsi > rsiPrev) {
      action = 'LONG';
      confidence = 0.5;
      reasons.push(`上升趋势中RSI回踩${rsi.toFixed(1)}反弹`);
    }
    else if (trendDown && rsi > 60 && rsi < rsiPrev) {
      action = 'SHORT';
      confidence = 0.5;
      reasons.push(`下降趋势中RSI回弹${rsi.toFixed(1)}回落`);
    }
    // 8. RSI中性区域 → 不交易
    else {
      action = 'FLAT';
      confidence = 0;
      reasons.push(`RSI中性${rsi.toFixed(1)}无明确信号`);
    }

    return {
      action,
      confidence: Math.min(confidence, 1),
      reasoning: reasons.join(' | '),
      indicators: {
        rsi: parseFloat(rsi.toFixed(2)),
        macd: parseFloat(macd.macd.toFixed(6)),
        macdHist: parseFloat(macd.histogram.toFixed(6)),
        bullDiv,
        bearDiv,
        trendUp,
        trendDown,
      }
    };
  }
}

module.exports = { RSIReversal };
