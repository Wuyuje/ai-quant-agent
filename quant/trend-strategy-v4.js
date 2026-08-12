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

  // ═══ 入场(阿奇完整版): 突破要收盘站稳+放量+回踩确认, 不追突破 ═══
  // 截图: 刚破位冲上去追=亏钱; 真突破=收实体站稳+放量+回踩不破(3取2); 假突破(快/影线长/量一般/回原区间)不追
  entrySignal(klines) {
    const arr = toArray(klines); const closes = arr.map(k => +k[3]);
    if (closes.length < this.minBars) return { signal: 'NONE', reason: '数据不足' };
    const d = this.dir(closes);
    const v = this.vol(arr);
    const price = closes[closes.length - 1];
    const prev = closes.length > 1 ? closes[closes.length - 2] : price;

    // ─── 上升趋势: 顺势做多(突破收实体+放量 / 回踩抬高低点不破) ───
    if (d.dir === 'UP') {
      // 真突破: 收盘站稳前高之上 + 放量 (突破确认, 非影线刺穿)
      if (d.resistance > 0 && price > d.resistance && prev <= d.resistance && v.up) {
        return { signal: 'LONG', reason: `收盘站稳突破前高${(d.resistance).toFixed(4)}+放量`, supportLevel: d.support, resistanceLevel: d.resistance };
      }
      // 回踩确认: 价格回踩到抬高低点(支撑)不破 + 放量企稳 → 顺势低买(经典回踩再入场, 止损小)
      if (d.support > 0 && price >= d.support * 0.998 && price <= prev * 1.002 && v.up) {
        return { signal: 'LONG', reason: `回踩抬高低点${(d.support).toFixed(4)}不破放量企稳`, supportLevel: d.support, resistanceLevel: d.resistance };
      }
    }
    // ─── 下降趋势: 顺势做空(收盘站稳+放量 / 反弹阻力受阻) ───
    if (d.dir === 'DOWN') {
      if (d.support > 0 && price < d.support && prev >= d.support && v.up) {
        return { signal: 'SHORT', reason: `收盘站稳跌破前低${(d.support).toFixed(4)}+放量`, supportLevel: d.support, resistanceLevel: d.resistance };
      }
      if (d.resistance > 0 && price <= d.resistance * 1.002 && price >= prev * 0.998 && v.up) {
        return { signal: 'SHORT', reason: `反弹降低高点${(d.resistance).toFixed(4)}受阻(高卖)放量`, supportLevel: d.support, resistanceLevel: d.resistance };
      }
    }
    return { signal: 'NONE', reason: `方向${d.dir} 价${price.toFixed(4)} 量${v.ratio.toFixed(1)}x 等确认` };
  }

  // ═══ 止损(A奇完整版): 止损=逻辑破了 + ATR(距离≥正常波动) + 挂单 ═══
  // 截图: 支撑入场→止损放支撑下2-3%; 突破入场→止损放突破点下; ATR距离≥正常波动
  stopLoss(pos, klines) {
    const arr = toArray(klines); const closes = arr.map(k => +k[3]);
    const price = closes[closes.length - 1];
    const aVal = this.atr(arr);
    // ATR距离: 止损至少距入场 ≥1倍ATR(正常波动, 避免被震)
    const stopDist = Math.max(pos.entry * 0.02, aVal);   // 至少2% 或 1ATR(截图: ATR距离≥正常波动)
    // 多单: 跌破入场逻辑支撑(关键支撑下方) → 逻辑破了
    if (pos.side === 'LONG') {
      const logicStop = pos.supportLevel > 0 ? pos.supportLevel * 0.98 : (pos.entry - stopDist);   // 支撑下2%
      if (price < logicStop) return { action: 'CLOSE', reason: `逻辑止损:跌破支撑${logicStop.toFixed(4)}` };
      if (pos.entry - price > stopDist) return { action: 'CLOSE', reason: `ATR止损(回撤${(((pos.entry-price)/pos.entry)*100).toFixed(1)}%)` };
    } else {
      const logicStop = pos.resistanceLevel > 0 ? pos.resistanceLevel * 1.02 : (pos.entry + stopDist);   // 阻力上2%
      if (price > logicStop) return { action: 'CLOSE', reason: `逻辑止损:突破阻力${logicStop.toFixed(4)}` };
      if (price - pos.entry > stopDist) return { action: 'CLOSE', reason: `ATR止损(反弹${(((price-pos.entry)/pos.entry)*100).toFixed(1)}%)` };
    }
    return { action: 'HOLD' };
  }

  // ═══ 离场(A奇完整版): 结构破坏需两步确认 + 共振 ═══
  // 截图: 上升趋升跌破前更高低点(higher low)+反弹不过前高才结构变; 回调不是反转; 让利润跑
  //  1) 记录持仓期最高/最低(让利润跑)
  //  2) 跌破关键抬高低点(破位)
  //  3) 之后反弹不过前高(确认) → 才平
  takeProfit(pos, klines, prevCloses) {
    const arr = toArray(klines); const closes = arr.map(k => +k[3]);
    if (closes.length < this.minBars) return { action: 'HOLD' };
    const price = closes[closes.length - 1];
    const d = this.dir(closes);
    // 记录持仓极值
    if (pos.side === 'LONG') pos.highP = (pos.highP == null || price > pos.highP) ? price : pos.highP;
    else pos.lowP = (pos.lowP == null || price < pos.lowP) ? price : pos.lowP;

    if (pos.side === 'LONG') {
      // 破位: 跌破了关键抬高低点(higher low)
      const brokenLevel = d.support > 0 ? d.support : 0;
      if (brokenLevel > 0 && price < brokenLevel) {
        // 两步入确认: 跌破后标记破位, 且反弹不过前高 → 结构坏平多
        if (!pos._brokeLow) { pos._brokeLow = brokenLevel; pos._brokeBars = 0; return { action: 'HOLD' }; }
        pos._brokeBars = (pos._brokeBars || 0) + 1;
        // 破位后反弹不过前高(仍在结构下方/未收复) → 结构坏
        if (price < pos.highP && pos._brokeBars >= 2) {
          return { action: 'CLOSE', reason: `结构破坏(跌破${brokenLevel.toFixed(4)}+未收复前高${(pos.highP||price).toFixed(4)})平多` };
        }
      } else {
        pos._brokeLow = null; pos._brokeBars = 0;   // 收复/未破位, 继续持有
      }
    } else {
      const brokenLevel = d.resistance > 0 ? d.resistance : 0;
      if (brokenLevel > 0 && price > brokenLevel) {
        if (!pos._brokeHigh) { pos._brokeHigh = brokenLevel; pos._brokeBars = 0; return { action: 'HOLD' }; }
        pos._brokeBars = (pos._brokeBars || 0) + 1;
        if (price > pos.lowP && pos._brokeBars >= 2) {
          return { action: 'CLOSE', reason: `结构破坏(突破${brokenLevel.toFixed(4)}+未回踩前低${(pos.lowP||price).toFixed(4)})平空` };
        }
      } else {
        pos._brokeHigh = null; pos._brokeBars = 0;
      }
    }
    return { action: 'HOLD' };
  }

  positionSize(balance, side, nRatio = 0.15) {
    const lev = side === 'LONG' ? 5 : 3;
    return { notional: Math.max(20, balance * nRatio * lev), margin: Math.max(20, balance * nRatio * lev) / lev, leverage: lev };
  }
}

module.exports = { TrendStrategyV4 };
