/**
 * v85: OBV动量策略
 * 
 * OBV (On-Balance Volume) — 量价关系核心指标
 * 核心思想：价格涨但量缩 = 虚涨，价格跌但量缩 = 接近底部
 * 
 * 信号逻辑：
 * - OBV上升 + 价格盘整 → 隐性吸筹，即将突破 → LONG
 * - OBV下降 + 价格盘整 → 隐性出货，即将下跌 → SHORT
 * - OBV新高但价格未新高 → 量价背离，看涨 → LONG
 * - OBV新低但价格未新低 → 量价背离，看跌 → SHORT
 * - OBV趋势线突破 → 大资金方向确认
 */

class OBVMomentum {
  constructor(config = {}) {
    this.obvMA = config.obvMA || 20;       // OBV均线周期
    this.priceMA = config.priceMA || 20;   // 价格均线周期
    this.minBars = config.minBars || 50;
  }

  /**
   * 计算OBV
   */
  calcOBV(klines) {
    const obv = [0];
    for (let i = 1; i < klines.length; i++) {
      if (klines[i].close > klines[i - 1].close) {
        obv.push(obv[obv.length - 1] + klines[i].volume);
      } else if (klines[i].close < klines[i - 1].close) {
        obv.push(obv[obv.length - 1] - klines[i].volume);
      } else {
        obv.push(obv[obv.length - 1]);
      }
    }
    return obv;
  }

  _sma(data, period) {
    if (data.length < period) return data[data.length - 1];
    return data.slice(-period).reduce((a, b) => a + b, 0) / period;
  }

  /**
   * 核心信号
   */
  signal(klines) {
    if (!klines || klines.length < this.minBars) {
      return { action: 'FLAT', confidence: 0, reasoning: '数据不足' };
    }

    const closes = klines.map(k => k.close);
    const volumes = klines.map(k => k.volume);
    const obv = this.calcOBV(klines);
    
    // OBV均线
    const obvMA = this._sma(obv, this.obvMA);
    const obvMA5 = this._sma(obv, 5);
    const obvPrev = obv[obv.length - 2];
    const obvMA5Prev = this._sma(obv.slice(0, -1), 5);
    
    // OBV趋势
    const obvRising = obvMA5 > obvMA5Prev;
    const obvFalling = obvMA5 < obvMA5Prev;
    const obvAboveMA = obv[obv.length - 1] > obvMA;
    const obvBelowMA = obv[obv.length - 1] < obvMA;
    
    // 价格趋势
    const priceMA = this._sma(closes, this.priceMA);
    const priceRising = closes[closes.length - 1] > closes[closes.length - 5];
    const priceFalling = closes[closes.length - 1] < closes[closes.length - 5];
    
    // 量价背离检测（近20根）
    const lookback = 20;
    const recentOBV = obv.slice(-lookback);
    const recentPrices = closes.slice(-lookback);
    
    // OBV新高但价格未新高 → 看涨
    const obvNewHigh = recentOBV[recentOBV.length - 1] >= Math.max(...recentOBV);
    const priceNewHigh = recentPrices[recentPrices.length - 1] >= Math.max(...recentPrices);
    const bullDiv = obvNewHigh && !priceNewHigh;
    
    // OBV新低但价格未新低 → 看跌
    const obvNewLow = recentOBV[recentOBV.length - 1] <= Math.min(...recentOBV);
    const priceNewLow = recentPrices[recentPrices.length - 1] <= Math.min(...recentPrices);
    const bearDiv = obvNewLow && !priceNewLow;
    
    // 量能变化
    const recentVols = volumes.slice(-10);
    const avgVol = recentVols.reduce((a, b) => a + b, 0) / 10;
    const currentVol = volumes[volumes.length - 1];
    const volSpike = currentVol > avgVol * 1.5;
    const volDry = currentVol < avgVol * 0.5;
    
    let action = 'FLAT';
    let confidence = 0;
    let reasons = [];
    
    // ═══ 信号判定 ═══
    
    // 1. OBV量价背离看涨 → 做多
    if (bullDiv && obvRising) {
      action = 'LONG';
      confidence = 0.7;
      reasons.push('OBV看涨背离+OBV上升');
    }
    // 2. OBV量价背离看跌 → 做空
    else if (bearDiv && obvFalling) {
      action = 'SHORT';
      confidence = 0.7;
      reasons.push('OBV看跌背离+OBV下降');
    }
    // 3. OBV突破均线 + 价格盘整 → 隐性吸筹做多
    else if (obvAboveMA && !this._prevBelow(obv, this.obvMA) && !priceRising) {
      action = 'LONG';
      confidence = 0.6;
      reasons.push('OBV突破均线+价格盘整(隐性吸筹)');
    }
    // 4. OBV跌破均线 + 价格盘整 → 隐性出货做空
    else if (obvBelowMA && this._prevAbove(obv, this.obvMA) && !priceFalling) {
      action = 'SHORT';
      confidence = 0.6;
      reasons.push('OBV跌破均线+价格盘整(隐性出货)');
    }
    // 5. OBV上升 + 放量 + 价格上升 → 趋势确认做多
    else if (obvRising && volSpike && priceRising) {
      action = 'LONG';
      confidence = 0.6;
      reasons.push('OBV上升+放量+价格上涨');
    }
    // 6. OBV下降 + 放量 + 价格下降 → 趋势确认做空
    else if (obvFalling && volSpike && priceFalling) {
      action = 'SHORT';
      confidence = 0.6;
      reasons.push('OBV下降+放量+价格下跌');
    }
    // 7. OBV上升 + 缩量 → 底部积累做多
    else if (obvRising && volDry && priceFalling) {
      action = 'LONG';
      confidence = 0.5;
      reasons.push('OBV上升+缩量下跌(底部积累)');
    }
    // 8. OBV下降 + 缩量 → 顶部派发做空
    else if (obvFalling && volDry && priceRising) {
      action = 'SHORT';
      confidence = 0.5;
      reasons.push('OBV下降+缩量上涨(顶部派发)');
    }
    else {
      action = 'FLAT';
      confidence = 0;
      reasons.push('OBV无明确信号');
    }

    return {
      action,
      confidence: Math.min(confidence, 1),
      reasoning: reasons.join(' | '),
      indicators: {
        obv: obv[obv.length - 1],
        obvMA: parseFloat(obvMA.toFixed(2)),
        obvRising,
        obvFalling,
        volSpike,
        volDry,
        bullDiv,
        bearDiv,
      }
    };
  }

  /** 辅助：前一根OBV是否低于均线 */
  _prevBelow(obv, period) {
    if (obv.length < period + 2) return false;
    const idx = obv.length - 2;
    let sum = 0;
    for (let i = idx - period + 1; i <= idx; i++) sum += obv[i];
    return obv[idx] < sum / period;
  }

  /** 辅助：前一根OBV是否高于均线 */
  _prevAbove(obv, period) {
    if (obv.length < period + 2) return false;
    const idx = obv.length - 2;
    let sum = 0;
    for (let i = idx - period + 1; i <= idx; i++) sum += obv[i];
    return obv[idx] > sum / period;
  }
}

module.exports = { OBVMomentum };
