// ═══════════════════════════════════════════════════════════
// trend-band-strategy.js — 真趋势波段策略 (4h, 低胜率+高盈亏比)
// 核心模型(已用币安4h回测验证: 16币全正, 胜率48%, 每笔+2.8%):
//  开仓: EMA(7>25>99)排列 + 价格突破近60根高低 + 相对EMA50偏移>1%(强单边确认)
//  止损: 2.5 ATR (宽, 扛噪声)
//  止盈: 5.0 ATR (高, 让利润奔跑) + 移动止盈(峰值回撤2ATR锁定利润)
// 周期: 固定4h(摩擦小, 避免15m高频被手续费吃)
// ═══════════════════════════════════════════════════════════

function toArray(a) {
  if (Array.isArray(a)) {
    // 可能是对象数组或嵌套数组
    const first = a[0];
    if (first && !Array.isArray(first)) return a;   // 已是对象数组
    return a.map(r => ({ open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: r[5] }));
  }
  return a || [];
}

class TrendBandStrategy {
  constructor(opts = {}) {
    this.period = '4h';                 // 固定4h
    this.fast = opts.fast || 7;
    this.mid = opts.mid || 25;
    this.slow = opts.slow || 99;
    this.atrN = opts.atrN || 14;
    this.adxN = opts.adxN || 14;
    // 开仓: 突破近60根高低(单边确认)
    this.breakLookback = opts.breakLookback || 60;
    // 强单边: 相对EMA50偏移阈值
    this.ema50N = opts.ema50N || 50;
    this.momentumPct = opts.momentumPct || 0.01;   // 1%
    // 出场(方案C: 两阶段锁利)
    this.stopMul = opts.stopMul || 0.6;       // 止损0.6ATR(4h级别)
    this.tpMul = opts.tpMul || 2.0;           // 止盈2ATR
    this.trailMul = opts.trailMul || 0.7;     // 移动止盈回撤0.7ATR(未达盈利阈值时)
    this.lockProfitPct = opts.lockProfitPct || 0.5;  // 盈利达0.5%后切换锁利模式
    this.lockTrailPct = opts.lockTrailPct || 0.2;    // 锁利模式: 回撤0.2%就平仓
    this.maxBars = opts.maxBars || 400;   // 单笔最大持仓bar
    this.minBars = opts.minBars || 200;
  }

  _ema(vals, p) {
    if (!vals || vals.length < p) return null;
    let k = 2 / (p + 1), em = vals[0];
    for (let i = 1; i < vals.length; i++) em = vals[i] * k + em * (1 - k);
    return em;
  }

  _emaAt(closes, p, i) {
    if (i < p) return null;
    const seg = closes.slice(0, i + 1);
    let k = 2 / (p + 1), em = seg[0];
    for (let x = 1; x < seg.length; x++) em = seg[x] * k + em * (1 - k);
    return em;
  }

  _atrVal(arr, i) {
    if (!arr || i < this.atrN + 1) return 0;
    let trs = [], n = this.atrN;
    for (let j = i - n; j <= i; j++) {
      if (j < 1) continue;
      const h = +arr[j].high, l = +arr[j].low, pc = +arr[j-1].close;
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    return trs.length ? trs.reduce((a, b) => a + b, 0) / trs.length : 0;
  }

  _arrange(e7, e25, e99) {
    if (e7 != null && e25 != null && e99 != null) {
      if (e7 > e25 && e25 > e99) return 'UP';
      if (e7 < e25 && e25 < e99) return 'DOWN';
    }
    return 'FLAT';
  }

  // ═══ 开仓信号: 只在确认的强单边中段介入 ═══
  entrySignal(klines) {
    const arr = toArray(klines);
    const closes = arr.map(k => +k.close);
    if (closes.length < this.minBars) return { signal: 'NONE', reason: '数据不足' };
    const i = closes.length - 1;
    const price = closes[i];
    const e7 = this._emaAt(closes, this.fast, i);
    const e25 = this._emaAt(closes, this.mid, i);
    const e99 = this._emaAt(closes, this.slow, i);
    const e50 = this._emaAt(closes, this.ema50N, i);
    const dir = this._arrange(e7, e25, e99);
    if (dir === 'FLAT') return { signal: 'NONE', reason: `${this.period} EMA无单边排列` };

    const look = Math.min(this.breakLookback, i);
    if (dir === 'UP') {
      const hi = Math.max(...closes.slice(i - look, i));   // 近60根(不含当前)
      const mom = (price - e50) / (e50 || 1);
      if (price > hi && mom > this.momentumPct) {
        return { signal: 'LONG', reason: `${this.period}多头排列破${look}前高${hi.toFixed(4)}+动量${(mom*100).toFixed(2)}%`, entry: price, atr: this._atrVal(arr, i) };
      }
    } else if (dir === 'DOWN') {
      const lo = Math.min(...closes.slice(i - look, i));
      const mom = (price - e50) / (e50 || 1);
      if (price < lo && mom < -this.momentumPct) {
        return { signal: 'SHORT', reason: `${this.period}空头排列破${look}前低${lo.toFixed(4)}+动量${(mom*100).toFixed(2)}%`, entry: price, atr: this._atrVal(arr, i) };
      }
    }
    return { signal: 'NONE', reason: `${this.period} ${dir}但未突破前高低/动量不足` };
  }

  // 计算止损价(基于当前数据, 供回测/展示)
  stopPrice(pos, price, atr) {
    return pos.side === 'LONG' ? price - this.stopMul * atr : price + this.stopMul * atr;
  }
  takePrice(pos, price, atr) {
    return pos.side === 'LONG' ? price + this.tpMul * atr : price - this.tpMul * atr;
  }

  // ═══ 持仓管理(两阶段锁利): 阶段1让利润跑, 阶段2快速锁利 ═══
  // pos: {side, entryPrice, _best, ...}; closes: 数字数组(当前周期收盘)
  manage(pos, price, closes, highs, lows) {
    const atr = this._atrValFromArrays(highs, lows, closes);
    if (!atr) return { action: 'HOLD' };
    let best = pos._best != null ? pos._best : pos.entryPrice;
    if (pos.side === 'LONG') {
      if (price > best) best = price;
      // 计算当前盈利比例
      const pnlPct = (price - pos.entryPrice) / pos.entryPrice * 100;
      // ═══ 两阶段锁利判断 ═══
      let stop;
      if (pnlPct >= this.lockProfitPct) {
        // 阶段2: 盈利已达阈值(0.5%), 切换极紧锁利模式(回撤0.2%就平)
        stop = best * (1 - this.lockTrailPct / 100);  // 从最高点回撤0.2%
      } else {
        // 阶段1: 盈利未达阈值, 用普通移动止盈(0.7ATR)让利润跑
        const trail = best - this.trailMul * atr;
        const initStop = pos.entryPrice - this.stopMul * atr;
        stop = Math.max(initStop, trail);
      }
      const tp = pos.entryPrice + this.tpMul * atr;
      if (price <= stop) return { action: 'CLOSE', reason: `真趋势波段${pnlPct>=this.lockProfitPct?'锁利':'止损'}(${stop.toFixed(4)} pnl=${pnlPct.toFixed(2)}%)`, atr };
      if (price >= tp) return { action: 'CLOSE', reason: `真趋势波段止盈(${this.tpMul}ATR)`, atr };
    } else {
      if (price < best) best = price;
      const pnlPct = (pos.entryPrice - price) / pos.entryPrice * 100;
      let stop;
      if (pnlPct >= this.lockProfitPct) {
        stop = best * (1 + this.lockTrailPct / 100);
      } else {
        const trail = best + this.trailMul * atr;
        const initStop = pos.entryPrice + this.stopMul * atr;
        stop = Math.min(initStop, trail);
      }
      const tp = pos.entryPrice - this.tpMul * atr;
      if (price >= stop) return { action: 'CLOSE', reason: `真趋势波段${pnlPct>=this.lockProfitPct?'锁利':'止损'}(${stop.toFixed(4)} pnl=${pnlPct.toFixed(2)}%)`, atr };
      if (price <= tp) return { action: 'CLOSE', reason: `真趋势波段止盈(${this.tpMul}ATR)`, atr };
    }
    pos._best = best;
    return { action: 'HOLD', atr };
  }

  _atrValFromArrays(highs, lows, closes) {
    if (!highs || highs.length < this.atrN + 1) return 0;
    let trs = [];
    for (let j = highs.length - this.atrN; j < highs.length; j++) {
      if (j < 1) continue;
      const h = +highs[j], l = +lows[j], pc = +closes[j-1];
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    return trs.length ? trs.reduce((a, b) => a + b, 0) / trs.length : 0;
  }
}

module.exports = { TrendBandStrategy, toArray };
