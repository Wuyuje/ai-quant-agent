/**
 * v85: MACD动量策略
 * 
 * 经典MACD + 动量确认，趋势跟踪型策略
 * 与RSI反转互补：RSI抓反转，MACD抓趋势延续
 * 
 * 信号逻辑：
 * - MACD零轴上方金叉 + 柱状图放大 → LONG
 * - MACD零轴下方死叉 + 柱状图放大 → SHORT
 * - MACD零轴穿越 → 强趋势信号
 * - 柱状图背离 → 趋势衰竭警告
 */

class MACDMomentum {
  constructor(config = {}) {
    this.fastPeriod = config.fastPeriod || 12;
    this.slowPeriod = config.slowPeriod || 26;
    this.signalPeriod = config.signalPeriod || 9;
    this.minBars = config.minBars || 50;
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
   * 计算MACD全量数据（含历史，用于趋势分析）
   */
  calcMACDHistory(closes) {
    if (closes.length < this.slowPeriod + this.signalPeriod) {
      return { macdLine: [], signalLine: [], histogram: [] };
    }
    const emaFast = this._ema(closes, this.fastPeriod);
    const emaSlow = this._ema(closes, this.slowPeriod);
    
    // 对齐长度
    const diff = closes.length - emaSlow.length;
    const macdLine = [];
    for (let i = 0; i < emaSlow.length; i++) {
      macdLine.push(emaFast[i + diff] - emaSlow[i]);
    }
    
    const signalLine = this._ema(macdLine, this.signalPeriod);
    const histogram = [];
    const offset = macdLine.length - signalLine.length;
    for (let i = 0; i < signalLine.length; i++) {
      histogram.push(macdLine[i + offset] - signalLine[i]);
    }
    
    return { macdLine, signalLine, histogram };
  }

  /**
   * 核心信号
   */
  signal(klines) {
    if (!klines || klines.length < this.minBars) {
      return { action: 'FLAT', confidence: 0, reasoning: '数据不足' };
    }

    const closes = klines.map(k => k.close);
    const { macdLine, signalLine, histogram } = this.calcMACDHistory(closes);
    
    if (macdLine.length < 5 || histogram.length < 3) {
      return { action: 'FLAT', confidence: 0, reasoning: 'MACD数据不足' };
    }
    
    const macd = macdLine[macdLine.length - 1];
    const macdPrev = macdLine[macdLine.length - 2];
    const sig = signalLine[signalLine.length - 1];
    const sigPrev = signalLine[signalLine.length - 2];
    const hist = histogram[histogram.length - 1];
    const histPrev = histogram[histogram.length - 2];
    const histPrev2 = histogram[histogram.length - 3];
    
    // 柱状图趋势
    const histGrowing = Math.abs(hist) > Math.abs(histPrev);
    const histShrinking = Math.abs(hist) < Math.abs(histPrev) && Math.abs(histPrev) < Math.abs(histPrev2);
    
    // 零轴位置
    const aboveZero = macd > 0;
    const belowZero = macd < 0;
    
    // 金叉/死叉
    const goldenCross = macdPrev <= sigPrev && macd > sig;
    const deathCross = macdPrev >= sigPrev && macd < sig;
    
    // 近5根柱状图的斜率
    const recentHist = histogram.slice(-5);
    const histSlope = (recentHist[recentHist.length - 1] - recentHist[0]) / 4;
    
    let action = 'FLAT';
    let confidence = 0;
    let reasons = [];
    
    // ═══ 信号判定 ═══
    
    // 1. 零轴上方金叉 + 柱状图放大 → 强做多
    if (goldenCross && aboveZero && histGrowing) {
      action = 'LONG';
      confidence = 0.75;
      reasons.push('MACD零轴上金叉+柱状图放大');
    }
    // 2. 零轴下方死叉 + 柱状图放大 → 强做空
    else if (deathCross && belowZero && histGrowing) {
      action = 'SHORT';
      confidence = 0.75;
      reasons.push('MACD零轴下死叉+柱状图放大');
    }
    // 3. 零轴穿越（MACD从负转正）→ 做多
    else if (macdPrev < 0 && macd >= 0) {
      action = 'LONG';
      confidence = 0.65;
      reasons.push('MACD零轴穿越向上');
    }
    // 4. 零轴穿越（MACD从正转负）→ 做空
    else if (macdPrev > 0 && macd <= 0) {
      action = 'SHORT';
      confidence = 0.65;
      reasons.push('MACD零轴穿越向下');
    }
    // 5. 普通金叉 + 上升斜率 → 做多
    else if (goldenCross && histSlope > 0) {
      action = 'LONG';
      confidence = 0.55;
      reasons.push('MACD金叉+柱状图上升');
    }
    // 6. 普通死叉 + 下降斜率 → 做空
    else if (deathCross && histSlope < 0) {
      action = 'SHORT';
      confidence = 0.55;
      reasons.push('MACD死叉+柱状图下降');
    }
    // 7. 柱状图背离（价格新高但柱状图萎缩）→ 做空
    else if (histShrinking && hist > 0) {
      // 检查价格是否在新高
      const recentPrices = closes.slice(-10);
      const priceRising = recentPrices[recentPrices.length - 1] > recentPrices[0];
      if (priceRising) {
        action = 'SHORT';
        confidence = 0.5;
        reasons.push('MACD柱状图背离(顶背离)');
      }
    }
    // 8. 柱状图背离（价格新低但柱状图萎缩）→ 做多
    else if (histShrinking && hist < 0) {
      const recentPrices = closes.slice(-10);
      const priceFalling = recentPrices[recentPrices.length - 1] < recentPrices[0];
      if (priceFalling) {
        action = 'LONG';
        confidence = 0.5;
        reasons.push('MACD柱状图背离(底背离)');
      }
    }
    // 9. 柱状图持续放大 + 方向一致 → 趋势延续
    else if (histGrowing && hist > 0 && histSlope > 0) {
      action = 'LONG';
      confidence = 0.4;
      reasons.push('MACD多头动量延续');
    }
    else if (histGrowing && hist < 0 && histSlope < 0) {
      action = 'SHORT';
      confidence = 0.4;
      reasons.push('MACD空头动量延续');
    }
    else {
      action = 'FLAT';
      confidence = 0;
      reasons.push('MACD无明确方向');
    }

    return {
      action,
      confidence: Math.min(confidence, 1),
      reasoning: reasons.join(' | '),
      indicators: {
        macd: parseFloat(macd.toFixed(6)),
        signal: parseFloat(sig.toFixed(6)),
        histogram: parseFloat(hist.toFixed(6)),
        histGrowing,
        histShrinking,
        aboveZero,
        goldenCross,
        deathCross,
      }
    };
  }
}

module.exports = { MACDMomentum };
