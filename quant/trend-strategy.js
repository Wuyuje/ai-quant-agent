// ═══════════════════════════════════════════════════════════
// 模块三·策略 3.2 趋势跟踪策略 (TrendFollowingStrategy)
// 趋势行情中顺势而为: 入场信号 + 移动止损(trailing stop) + 仓位
// 对应图片: 3.2 趋势跟踪策略
// ═══════════════════════════════════════════════════════════
const { Indicators } = require('../lib/common');
const { toArray } = require('./featurer');

class TrendFollowingStrategy {
  constructor(opts = {}) {
    // 参数
    this.emaShort = opts.emaShort || 7;
    this.emaLong = opts.emaLong || 25;
    this.adxMin = opts.adxMin || 18;          // 趋势强度门槛
    this.trailingPct = opts.trailingPct || 2.0; // 移动止损距离%(从最高价回落)
    this.stopLossPct = opts.stopLossPct || 3.0; // 初始止损%
    this.atrStopMulti = opts.atrStopMulti || 1.5; // ATR止损倍数
  }

  // 入场信号: 趋势明确 + 顺趋势回踩进场
  entrySignal(klines, trendDir) {
    if (!klines || klines.length < 60) return { signal: 'NONE', reason: 'K线不足' };
    const closes = toArray(klines).map(k => +k[3]);
    const emaS = Indicators.ema(closes, this.emaShort);
    const emaL = Indicators.ema(closes, this.emaLong);
    const adx = Indicators.adx(klines, 14) || 0;
    const last = closes[closes.length-1];

    // 必须顺趋势: 趋势UP做多, DOWN做空
    if (adx < this.adxMin) return { signal: 'NONE', reason: `ADX不足(${adx.toFixed(0)}<${this.adxMin})` };

    if (trendDir === 'UP') {
      // 多头: 价格在EMA_long上方 + 回踩EMA_short后重新转上(顺势低吸)
      const longSignal = last > emaL && emaS > emaL;
      if (longSignal) return { signal: 'LONG', reason: '趋势UP顺势做多', price: last };
    } else if (trendDir === 'DOWN') {
      // 空头: 价格在EMA_long下方 + 反弹EMA_short后重新转下(顺势高抛)
      const shortSignal = last < emaL && emaS < emaL;
      if (shortSignal) return { signal: 'SHORT', reason: '趋势DOWN顺势做空', price: last };
    }
    return { signal: 'NONE', reason: `趋势${trendDir}但未回踩到入场位` };
  }

  // 移动止损: 记录持仓期间最高价, 从最高回落 ≥ trailing% 平仓(锁利润)
  trailingStop(pos, price) {
    if (!pos._peak) pos._peak = pos.entryPrice;
    if (pos.side === 'LONG' && price > pos._peak) pos._peak = price;
    if (pos.side === 'SHORT' && price < pos._peak) pos._peak = price;
    const trav = pos.side === 'LONG'
      ? (pos._peak - price) / pos._peak * 100       // 多头: 从最高回落
      : (price - pos._peak) / pos._peak * 100;       // 空头: 从最低回升
    if (trav >= this.trailingPct) {
      return { action: 'CLOSE', reason: `移动止损(从${pos.side==='LONG'?'高':'低'}点${pos._peak.toFixed(4)}回落${trav.toFixed(1)}%≥${this.trailingPct}%)` };
    }
    return { action: 'HOLD', peak: pos._peak };
  }

  // 初始/ATR止损
  stopLoss(pos, price, atr) {
    const lossPct = pos.side === 'LONG'
      ? (pos.entryPrice - price) / pos.entryPrice * 100
      : (price - pos.entryPrice) / pos.entryPrice * 100;
    if (lossPct >= this.stopLossPct) return { action: 'CLOSE', reason: `初始止损(亏${lossPct.toFixed(1)}%≥${this.stopLossPct}%)` };
    // ATR止损兜底
    if (atr > 0 && pos.entryPrice > 0) {
      const atrDist = atr * this.atrStopMulti / pos.entryPrice * 100;
      if (lossPct >= atrDist) return { action: 'CLOSE', reason: `ATR止损(亏${lossPct.toFixed(1)}%≥${atrDist.toFixed(1)}%ATR)` };
    }
    return { action: 'HOLD' };
  }

  // 仓位大小 (按ATR: 波动大则仓位小)
  positionSize(balance, atrPct, leverage) {
    // 基础风险: 单笔最多亏2%本金 → 名义 = 2% / 止损距离
    const riskAmt = balance * 0.02;
    const stopDist = Math.max(this.stopLossPct, atrPct * this.atrStopMulti * 100 || this.stopLossPct);
    const notional = Math.min(balance * leverage, stopDist > 0 ? riskAmt / (stopDist / 100) : balance * leverage);
    return { notional: Math.max(20, notional), margin: Math.max(5, notional / leverage), leverage };
  }
}

module.exports = { TrendFollowingStrategy };
