// ═══════════════════════════════════════════════════════════
// 趋势策略 — EMA(7,25,99) 黄金均线组 (按用户截图改)
// 周期: 5分钟K线, 杠杆8x
// 逻辑:
//   方向: EMA7>EMA25>EMA99 = 多头排列(顺趋势只做多)
//         EMA7<EMA25<EMA99 = 空头排列(顺趋势只做空)
//   入场: 多头排列 + 突破前期高点 / 回踩EMA25不破 → 做多
//        空头排列 + 跌破前期低点 / 反弹EMA25受阻 → 做空
//   止盈: 均线排列转反(趋势结束) 或 跌破/突破关键均线(EMA25/99) 让利润跑
//   止损: 跌破EMA99(逻辑失效) + ATR辅助, 不扛单
// 方式: 顺多均线排列趋势, 不逆势, 5分钟金叉/多头排列启动
// ═══════════════════════════════════════════════════════════
const { toArray } = require('./featurer');

class TrendStrategy {
  constructor(opts = {}) {
    this.fast = opts.fast || 7;      // EMA快线
    this.mid = opts.mid || 25;       // EMA中
    this.slow = opts.slow || 99;     // EMA慢
    this.atrMult = opts.atrMult || 2;    // 止损ATR倍数
    this.stopLossPct = opts.stopLossPct || 8.0;  // 硬止损兜底(8x杠杆放宽)
    this.trailPct = opts.trailPct || 5.0;       // 移动止盈(让利润跑)
    this.minBars = opts.minBars || 120;          // 最少K线(5m, 需EMA99所以≥120)
  }

  // EMA 计算
  _ema(closes, p) {
    if (!closes || closes.length < p) return null;
    const k = 2 / (p + 1);
    let e = closes[closes.length - p];
    for (let i = closes.length - p + 1; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
    return e;
  }

  // 均线排列方向: 多头排列=UP, 空头排列=DOWN, 缠绕=FLAT
  _arrange(e7, e25, e99) {
    if (e7 == null || e25 == null || e99 == null) return 'FLAT';
    if (e7 > e25 && e25 > e99) return 'UP';      // 多头: EMA7>EMA25>EMA99
    if (e7 < e25 && e25 < e99) return 'DOWN';    // 空头
    return 'FLAT';
  }

  // 近周期高低点(算突破位/回踩位)
  _pivots(closes, n) {
    const win = closes.slice(-n);
    return { hi: Math.max(...win), lo: Math.min(...win) };
  }

  // ═══ 入场: 顺多/空均线排列趋势 ═══
  entrySignal(klines, marketDir) {
    const arr = toArray(klines);
    const closes = arr.map(k => +k[3]);
    if (closes.length < this.minBars) return { signal: 'NONE', reason: '数据不足' };
    const price = closes[closes.length - 1];
    const e7 = this._ema(closes, this.fast);
    const e25 = this._ema(closes, this.mid);
    const e99 = this._ema(closes, this.slow);
    const dir = this._arrange(e7, e25, e99);
    const pv = this._pivots(closes, 30);   // 近30根高低点
    // 多头排列(EMA7>25>99): 只做多——突破前期高点 或 回踩EMA25不破
    if (dir === 'UP') {
      const breakout = price > pv.hi;                       // 突破近期高点
      const pullbackHold = price >= e25 * 0.998;            // EMA25支撑不破
      if (breakout) return { signal: 'LONG', reason: `多头排列(EMA7>25>99)突破前高${pv.hi.toFixed(4)}`, entry: price };
      if (pullbackHold) return { signal: 'LONG', reason: `多头排列回踩EMA25(${e25.toFixed(4)})不破顺势做多`, entry: price };
    }
    // 空头排列: 只做空——跌破前低 或 反弹EMA25受阻
    if (dir === 'DOWN') {
      const breakdown = price < pv.lo;
      const reboundReject = price <= e25 * 1.002;
      if (breakdown) return { signal: 'SHORT', reason: `空头排列(EMA7<25<99)跌破前低${pv.lo.toFixed(4)}`, entry: price };
      if (reboundReject) return { signal: 'SHORT', reason: `空头排列反弹EMA25受阻顺势做空`, entry: price };
    }
    return { signal: 'NONE', reason: `EMA排列=${dir} 价${price.toFixed(4)}` };
  }

  // ═══ 止损: 跌破EMA99(逻辑失效) / 硬止损 ═══ (签名: pos, price, closes数字数组)
  stopLoss(pos, price, closes) {
    const e99 = this._ema(closes, this.slow);
    // 多单: 跌破EMA99 → 多头逻辑彻底破, 止损
    if (pos.side === 'LONG') {
      if (e99 && price < e99) return { action: 'CLOSE', reason: `跌破EMA99(${e99.toFixed(4)})逻辑失效止损` };
      if (pos.entry && (pos.entry - price) / pos.entry * 100 >= this.stopLossPct) return { action:'CLOSE', reason:`硬止损${(((pos.entry-price)/pos.entry)*100).toFixed(1)}%` };
    } else {
      if (e99 && price > e99) return { action: 'CLOSE', reason: `突破EMA99(${e99.toFixed(4)})逻辑失效止损` };
      if (pos.entry && (price - pos.entry) / pos.entry * 100 >= this.stopLossPct) return { action:'CLOSE', reason:`硬止损${(((price-pos.entry)/pos.entry)*100).toFixed(1)}%` };
    }
    return { action: 'HOLD' };
  }

  // ═══ 止盈: 均线排列转反(趋势结束) 或 回落到关键均线 → 让利润跑 ═══
  takeProfit(pos, price, closes) {
    if (!closes || closes.length < 40) return { action: 'HOLD' };
    const arr = closes;
    const e7 = this._ema(arr, this.fast);
    const e25 = this._ema(arr, this.mid);
    const e99 = this._ema(arr, this.slow);
    const dir = this._arrange(e7, e25, e99);
    const entry = pos.entryPrice || price;

    // 多头持仓: 多头排列破坏(转空/缠绕) 或 跌破EMA25 → 平(趋势结束,让利润跑后落袋)
    if (pos.side === 'LONG') {
      if (dir === 'DOWN') return { action: 'CLOSE', reason: `均线转空头排列(趋势结束)平多` };
      if (e25 && price < e25 && e7) return { action: 'CLOSE', reason: `跌破EMA25(${e25.toFixed(4)})平多锁利` };
    } else {
      if (dir === 'UP') return { action: 'CLOSE', reason: `均线转多头排列(趋势结束)平空` };
      if (e25 && price > e25 && e7) return { action: 'CLOSE', reason: `突破EMA25(${e25.toFixed(4)})平空锁利` };
    }
    return { action: 'HOLD' };
  }

  // 仓位: 8x杠杆(图2)
  positionSize(balance, side, nRatio = 0.15) {
    const lev = 3;   // 3x(EMA回测亏损, 从8x降3x控风险)
    return { notional: Math.max(20, balance * nRatio * lev), margin: Math.max(20, balance * nRatio * lev) / lev, leverage: lev };
  }
}

module.exports = { TrendStrategy };
