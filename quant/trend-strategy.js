// ═══════════════════════════════════════════════════════════
// 模块三·策略 3.2 趋势跟踪策略 (TrendFollowingStrategy)
// 趋势行情中顺势而为: 入场信号 + 移动止损(trailing stop) + 仓位
// 对应图片: 3.2 趋势跟踪策略
// ═══════════════════════════════════════════════════════════
const { Indicators } = require('../lib/common');
const { toArray } = require('./featurer');

// 本地数组版EMA (数字数组)
function localEMA(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

// 本地数组版ADX (兼容 BinanceAPI 对象K线 → toArray)
function localADX(raw, period) {
  const k = toArray(raw);  // [o,h,l,c,v]
  if (!Array.isArray(k) || k.length < period * 2) return 0;
  let plusDM = 0, minusDM = 0, tr = 0;
  const start = k.length - period;
  for (let i = start; i < k.length; i++) {
    const up = +k[i][1] - +k[i-1][1];
    const down = +k[i-1][2] - +k[i][2];
    const h = +k[i][1], l = +k[i][2], pc = +k[i-1][3];
    tr += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    if (up > down && up > 0) plusDM += up;
    else if (down > up && down > 0) minusDM += down;
  }
  if (tr === 0) return 0;
  const plusDI = plusDM / tr * 100, minusDI = minusDM / tr * 100;
  return Math.abs(plusDI - minusDI) / Math.max(plusDI + minusDI, 0.001) * 100;
}

class TrendFollowingStrategy {
  constructor(opts = {}) {
    // 参数
    this.emaShort = opts.emaShort || 7;
    this.emaLong = opts.emaLong || 25;
    this.adxMin = opts.adxMin || 8;          // 趋势强度门槛
    this.trailingPct = opts.trailingPct || 2.0; // 移动止损距离%(从最高价回落)
    this.stopLossPct = opts.stopLossPct || 3.0; // 初始止损%
    this.atrStopMulti = opts.atrStopMulti || 1.5; // ATR止损倍数
  }

  // 入场信号: 趋势明确 + 顺趋势回踩进场
  entrySignal(klines, trendDir) {
    if (!klines || klines.length < 60) return { signal: 'NONE', reason: 'K线不足' };
    const closes = toArray(klines).map(k => +k[3]);
    const emaS = localEMA(closes, this.emaShort);
    const emaL = localEMA(closes, this.emaLong);
    const adx = localADX(klines, 14) || 0;
    const last = closes[closes.length-1];

    // 必须顺趋势: 趋势UP做多, DOWN做空
    if (adx < this.adxMin) return { signal: 'NONE', reason: `ADX不足(${adx.toFixed(0)}<${this.adxMin})` };

    if (trendDir === 'UP' && emaS > emaL) {
      return { signal: 'LONG', reason: '趋势UP顺势做多', price: last };
    } else if (trendDir === 'DOWN' && emaS < emaL) {
      return { signal: 'SHORT', reason: '趋势DOWN顺势做空', price: last };
    }
    return { signal: 'NONE', reason: `趋势${trendDir}未到入场位` };
  }

  // 移动止损 + 逆势反手 (规格: trail_stop + 逆势反手)
  // 从持仓最高/最低点回落 ≥ trailing% → 平仓; 若趋势已明显反转 → 反手
  trailingStop(pos, price, trendDir) {
    if (!pos._peak) pos._peak = pos.entryPrice;
    if (pos.side === 'LONG' && price > pos._peak) pos._peak = price;
    if (pos.side === 'SHORT' && price < pos._peak) pos._peak = price;
    const trav = pos.side === 'LONG'
      ? (pos._peak - price) / pos._peak * 100
      : (price - pos._peak) / pos._peak * 100;
    if (trav >= this.trailingPct) {
      // 逆势反手: 若当前趋势方向与持仓相反 → 平仓并反手
      const reversed = (pos.side === 'LONG' && trendDir === 'DOWN') || (pos.side === 'SHORT' && trendDir === 'UP');
      if (reversed) return { action: 'REVERSE', reason: `移动止损+逆势反手(从${pos.side==='LONG'?'高':'低'}点回落${trav.toFixed(1)}%,趋势反转)` };
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
