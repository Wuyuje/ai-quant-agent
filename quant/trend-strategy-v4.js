// ═══════════════════════════════════════════════════════════
// 趋势策略 V4 — 阿奇理论 · 大周期独立趋势引擎
// 用途: 单独的趋势引擎, 用大周期(1h/4h), 不影响震荡布林带引擎
// 理论(阿奇AI):
//   趋势线给方向 → 突破给时机 → 成交量验证真伪
//   上升=依次抬高低点; 下降=依次降低高点(需多点确认)
//   真突破: 收盘站稳+放量+回踩不破(至少2个)
//   止损: 逻辑失效处(支撑/趋势线下方) + ATR; 别被正常波动扫掉
//   平仓: 结构破坏(转反)才走, 让利润跑, 回调/反弹不是反转
// 周期: 默认1h(可4h). 只在强趋势时交易, 其余横盘空仓(大道至简)
// ═══════════════════════════════════════════════════════════
const { FeatureEngineer, toArray } = require('./featurer');

class TrendStrategyV4 {
  constructor(opts = {}) {
    this.swingLen = opts.swingLen || 3;       // swing高低点窗(3根)
    this.confirmLows = opts.confirmLows || 3; // 趋势确认需3个抬高低点(截图: 第三点确认)
    this.volMult = opts.volMult || 1.3;       // 突破放量阈值(>20均量×1.3)
    this.atrMult = opts.atrMult || 2.0;       // 止损ATR倍数(2倍, 大周期防扫)
    this.minBars = opts.minBars || 80;        // 最少K线(1h需80根≈80h)
    this.fe = new FeatureEngineer();
  }

  // ═══ 方向: 依次抬高最低点(UP) / 依次降低最高点(DOWN), 需多点确认 ═══
  dir(closes) {
    const lows = [], highs = [];
    for (let i = this.swingLen; i < closes.length - this.swingLen; i++) {
      const win = closes.slice(i - this.swingLen, i + this.swingLen + 1);
      if (closes[i] === Math.min(...win)) lows.push({ i, p: closes[i] });
      if (closes[i] === Math.max(...win)) highs.push({ i, p: closes[i] });
    }
    // 上升: 最近3个低点依次抬高
    if (lows.length >= this.confirmLows) {
      const a = lows[lows.length - 3], b = lows[lows.length - 2], c = lows[lows.length - 1];
      if (b.p > a.p && c.p > b.p) return { dir: 'UP', support: c.p, resistance: highs.length ? highs[highs.length - 1].p : 0 };
    }
    if (highs.length >= this.confirmLows) {
      const a = highs[highs.length - 3], b = highs[highs.length - 2], c = highs[highs.length - 1];
      if (b.p < a.p && c.p < b.p) return { dir: 'DOWN', resistance: c.p, support: lows.length ? lows[lows.length - 1].p : 0 };
    }
    return { dir: 'FLAT', support: 0, resistance: 0 };
  }

  vol(arr) {
    const a = toArray(arr); const v = a.map(k => +k[4]);
    if (v.length < 21) return { ratio: 0, up: false };
    const avg = v.slice(-21, -1).reduce((x, y) => x + y, 0) / 20;
    return { ratio: avg > 0 ? v[v.length - 1] / avg : 0, up: avg > 0 ? v[v.length - 1] > avg * this.volMult : false };
  }

  atr(arr) {
    const a = toArray(arr); const h = a.map(k => +k[2]), l = a.map(k => +k[3]), c = a.map(k => +k[3]);
    if (c.length < 2) return 0;
    const trs = [];
    for (let i = 1; i < c.length; i++) trs.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
    return trs.slice(-14).reduce((x, y) => x + y, 0) / Math.min(14, trs.length);
  }

  // ═══ 入场(大周期): 强趋势 + 放量突破/回踩不破 ═══
  entrySignal(klines) {
    const arr = toArray(klines); const closes = arr.map(k => +k[3]);
    if (closes.length < this.minBars) return { signal: 'NONE', reason: '数据不足' };
    const d = this.dir(closes);
    const v = this.vol(arr);
    const price = closes[closes.length - 1];
    // 上升强趋势: 放量突破前高(顺势追突破) 或 回踩抬高低点不破(顺趋势低买)
    if (d.dir === 'UP' && d.resistance > 0 && price > d.resistance && v.up) {
      return { signal: 'LONG', reason: `放量突破前高${(d.resistance).toFixed(4)}顺上升趋势`, supportLevel: d.support, resistanceLevel: d.resistance };
    }
    if (d.dir === 'UP' && d.support > 0 && price <= d.support * 1.002 && v.up) {
      return { signal: 'LONG', reason: `回踩抬高低点${(d.support).toFixed(4)}不破顺趋势低买`, supportLevel: d.support, resistanceLevel: d.resistance };
    }
    if (d.dir === 'DOWN' && d.support > 0 && price < d.support && v.up) {
      return { signal: 'SHORT', reason: `放量跌破前低${(d.support).toFixed(4)}顺下降趋势`, supportLevel: d.support, resistanceLevel: d.resistance };
    }
    if (d.dir === 'DOWN' && d.resistance > 0 && price >= d.resistance * 0.998 && v.up) {
      return { signal: 'SHORT', reason: `反弹降低高点${(d.resistance).toFixed(4)}受阻顺趋势高卖`, supportLevel: d.support, resistanceLevel: d.resistance };
    }
    return { signal: 'NONE', reason: `大周期方向${d.dir} 等入场` };
  }

  // ═══ 止损: 逻辑失效处 + ATR(大周期防扫) ═══
  stopLoss(pos, klines) {
    const arr = toArray(klines); const closes = arr.map(k => +k[3]);
    const price = closes[closes.length - 1];
    const a = this.atr(arr) * this.atrMult;
    // 多单: 跌破抬高低点(支撑) - ATR缓冲 → 逻辑破
    if (pos.side === 'LONG') {
      const stop = (pos.supportLevel > 0 ? pos.supportLevel : pos.entry - a) - a * 0.3;
      if (price < stop) return { action: 'CLOSE', reason: `跌破支撑${stop.toFixed(4)}逻辑止损` };
      // ATR兜底(最大回撤)
      if ((pos.entry - price) > a * 1.2) return { action: 'CLOSE', reason: `ATR止损(${((pos.entry-price)/(pos.entry||1)*100).toFixed(1)}%)` };
    } else {
      const stop = (pos.resistanceLevel > 0 ? pos.resistanceLevel : pos.entry + a) + a * 0.3;
      if (price > stop) return { action: 'CLOSE', reason: `突破阻力${stop.toFixed(4)}逻辑止损` };
      if ((price - pos.entry) > a * 1.2) return { action: 'CLOSE', reason: `ATR止损(${((price-pos.entry)/(pos.entry||1)*100).toFixed(1)}%)` };
    }
    return { action: 'HOLD' };
  }

  // ═══ 平仓: 让利润跑 + 移动止盈保护(大道至简精髓) ═══
  // 截图: 回调/反弹不是反转, 别被震出; 但也要锁利润, 跌破关键结构位才走
  takeProfit(pos, klines) {
    const arr = toArray(klines); const closes = arr.map(k => +k[3]);
    if (closes.length < this.minBars) return { action: 'HOLD' };
    const price = closes[closes.length - 1];
    const d = this.dir(closes);
    // 追踪: 记录开仓后最高/最低(让利润跑)
    if (pos.side === 'LONG') { pos.highP = (pos.highP == null || price > pos.highP) ? price : pos.highP; pos.highI = price >= pos.highP ? (pos.highI || 0) + 1 : (pos.highI || 0); }
    else { pos.lowP = (pos.lowP == null || price < pos.lowP) ? price : pos.lowP; pos.lowI = price <= pos.lowP ? (pos.lowI || 0) + 1 : (pos.lowI || 0); }
    // 大周期结构明确转反 → 必平
    if (pos.side === 'LONG' && d.dir === 'DOWN') return { action: 'CLOSE', reason: `上升结构破坏转降平多` };
    if (pos.side === 'SHORT' && d.dir === 'UP') return { action: 'CLOSE', reason: `下降结构破坏转涨平空` };
    // 动态移动止盈: 用当前结构位做保护(让利润跑但锁住)
    if (pos.side === 'LONG') {
      // 止盈线随上涨结构抬高: 用当前最近抬高低点
      const trail = pos.highP && pos.highP > pos.entry ? (pos.highP - (pos.highP - pos.entry) * 0.5) : pos.entry;
      const structStop = d.support > 0 ? d.support : trail;
      const stopLine = Math.max(trail, structStop);
      if (price < stopLine) return { action: 'CLOSE', reason: `移动止盈(高点${(pos.highP||price).toFixed(4)}回撤锁利${stopLine.toFixed(4)})` };
    } else {
      const trail = pos.lowP && pos.lowP < pos.entry ? (pos.lowP + (pos.entry - pos.lowP) * 0.5) : pos.entry;
      const structStop = d.resistance > 0 ? d.resistance : trail;
      const stopLine = Math.min(trail, structStop);
      if (price > stopLine) return { action: 'CLOSE', reason: `移动止盈(低点${(pos.lowP||price).toFixed(4)}反弹锁利${stopLine.toFixed(4)})` };
    }
    return { action: 'HOLD' };
  }

  positionSize(balance, side, nRatio = 0.15) {
    const lev = side === 'LONG' ? 5 : 3;
    return { notional: Math.max(20, balance * nRatio * lev), margin: Math.max(20, balance * nRatio * lev) / lev, leverage: lev };
  }
}

module.exports = { TrendStrategyV4 };
