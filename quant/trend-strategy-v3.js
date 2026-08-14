// ═══════════════════════════════════════════════════════════
// 趋势策略 V3 — 大道至简 (严格按阿奇AI理论精髓)
//
//   "道可道，非常道。名可名，非常名。":
//     趋势不能被机械公式完全刻死, 要抓住"本质"而非"表象"
//   "大道至简":
//     趋势线给方向 → 突破/回踩给时机 → 成交量验证真伪
//     止损放逻辑失效处
//
//   精髓(极简三问):
//   [1] 现在什么方向?  → 依次抬高的低点=涨(只做多), 依次降低的高点=跌(只做空)
//   [2] 什么时机进?   → 顺着方向: 回踩支撑/阻力不破 或 放量突破新高/新低
//   [3] 错了怎么办?  → 跌破前低/前高(结构破坏)=逻辑错, 立即止损
//
//   不叠加复杂指标, 只有: 结构方向 + 突破/回踩 + 量 + 逻辑止损
// ═══════════════════════════════════════════════════════════
const { FeatureEngineer, toArray } = require('./featurer');

class TrendStrategyV3 {
  constructor(opts = {}) {
    this.swingLen = opts.swingLen || 3;        // 极简: 3根确认swing点
    this.volMult = opts.volMult || 1.3;        // 极简: 突破放量>20均量×1.3
    this.atrMult = opts.atrMult || 1.5;        // 止损ATR倍数(逻辑失效缓冲)
    this.fe = new FeatureEngineer();
  }

  // ═══ 第一问: 现在什么方向? (大道至简: 强趋势需多点确认) ═══
  // 上升=至少3个依次抬高的低点(截图: 第三个点确认有效性); 下降=至少3个降低高点
  // 横盘(结构不清晰/未确认) → FLAT 不做
  dir(closes) {
    const lows = [], highs = [];
    for (let i = this.swingLen; i < closes.length - this.swingLen; i++) {
      const win = closes.slice(i - this.swingLen, i + this.swingLen + 1);
      if (closes[i] === Math.min(...win)) lows.push({ i, p: closes[i] });
      if (closes[i] === Math.max(...win)) highs.push({ i, p: closes[i] });
    }
    // 上升: 最近3个低点依次抬高(第三个点确认有效性)
    if (lows.length >= 3) {
      const a = lows[lows.length - 3], b = lows[lows.length - 2], c = lows[lows.length - 1];
      if (b.p > a.p && c.p > b.p) return { dir: 'UP', support: c.p, resistance: highs.length ? highs[highs.length - 1].p : 0, confirm: c.p };
    }
    // 下降: 最近3个高点依次降低
    if (highs.length >= 3) {
      const a = highs[highs.length - 3], b = highs[highs.length - 2], c = highs[highs.length - 1];
      if (b.p < a.p && c.p < b.p) return { dir: 'DOWN', resistance: c.p, support: lows.length ? lows[lows.length - 1].p : 0, confirm: c.p };
    }
    return { dir: 'FLAT', support: 0, resistance: 0, confirm: 0 };
  }

  // ═══ 量(验证真伪) ═══
  vol(arr) {
    const a = toArray(arr); const v = a.map(k => +k[4]);
    if (v.length < 21) return { ratio: 0, up: false };
    const avg = v.slice(-21, -1).reduce((x, y) => x + y, 0) / 20;
    return { ratio: avg > 0 ? v[v.length - 1] / avg : 0, up: avg > 0 ? v[v.length - 1] > avg * this.volMult : false };
  }

  // ═══ ATR(止损缓冲) ═══
  atr(arr) {
    const a = toArray(arr); const h = a.map(k => +k[2]), l = a.map(k => +k[3]), c = a.map(k => +k[3]);
    if (c.length < 2) return 0;
    const trs = [];
    for (let i = 1; i < c.length; i++) trs.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
    return trs.slice(-14).reduce((x, y) => x + y, 0) / Math.min(14, trs.length);
  }

  // ═══ 核心: 大道至简入场 — 只做放量突破(截图: 突破给时机+放量验证真伪) ═══
  // 弱化回踩(横盘假信号多), 聚焦: 趋势成立 + 放量突破关键位
  entrySignal(klines) {
    const arr = toArray(klines); const closes = arr.map(k => +k[3]);
    if (closes.length < 60) return { signal: 'NONE', reason: '数据不足' };
    const d = this.dir(closes);
    const v = this.vol(arr);
    const price = closes[closes.length - 1];

    // 上升趋势(低点抬高结构成立) + 放量突破近期高点 → 顺趋势做多
    if (d.dir === 'UP' && d.resistance > 0) {
      if (price > d.resistance && v.up) {
        return { signal: 'LONG', reason: `放量突破前高${d.resistance.toFixed(4)}(量${v.ratio.toFixed(1)}x)顺趋势做多`, supportLevel: d.support, resistanceLevel: d.resistance };
      }
    }
    // 下降趋势(高点降低结构成立) + 放量跌破近期低点 → 顺趋势做空
    if (d.dir === 'DOWN' && d.support > 0) {
      if (price < d.support && v.up) {
        return { signal: 'SHORT', reason: `放量跌破前低${d.support.toFixed(4)}(量${v.ratio.toFixed(1)}x)顺趋势做空`, supportLevel: d.support, resistanceLevel: d.resistance };
      }
    }
    return { signal: 'NONE', reason: `方向${d.dir} 价${price.toFixed(4)} 量${v.ratio.toFixed(1)}x 等突破` };
  }

  // ═══ 止损: 逻辑失效处 + ATR兜底(大道至简, 别无限扛) ═══
  stopLoss(pos, klines) {
    const arr = toArray(klines); const closes = arr.map(k => +k[3]);
    const price = closes[closes.length - 1];
    const a = this.atr(arr) * this.atrMult;
    // ATR硬止损兜底(防横盘/反向扛单): 反向超1.5ATR就砍, 不让单笔大亏
    if (pos.side === 'LONG' && (pos.entry - price) > a) return { action: 'CLOSE', reason: `ATR止损(${price.toFixed(4)}距开仓${((pos.entry-price)/(pos.entry||1)*100).toFixed(1)}%)` };
    if (pos.side === 'SHORT' && (price - pos.entry) > a) return { action: 'CLOSE', reason: `ATR止损(${price.toFixed(4)}距开仓${((price-pos.entry)/(pos.entry||1)*100).toFixed(1)}%)` };
    return { action: 'HOLD' };
  }

  // ═══ 平仓: 趋势结构明确转反才走(大道至简: 回调/反弹不是反转, 别被震出) ═══
  takeProfit(pos, klines) {
    const arr = toArray(klines); const closes = arr.map(k => +k[3]);
    if (closes.length < 40) return { action: 'HOLD' };
    const price = closes[closes.length - 1];
    // 结构彻底转反(方向变了)才平, 中途回调/反弹不平
    const d = this.dir(closes);
    if (pos.side === 'LONG' && d.dir === 'DOWN') return { action: 'CLOSE', reason: `上升结构破坏转降平多` };
    if (pos.side === 'SHORT' && d.dir === 'UP') return { action: 'CLOSE', reason: `下降结构破坏转涨平空` };
    return { action: 'HOLD' };
  }

  positionSize(balance, side, nRatio = 0.15) {
    const lev = side === 'LONG' ? 5 : 3;
    return { notional: Math.max(20, balance * nRatio * lev), margin: Math.max(20, balance * nRatio * lev) / lev, leverage: lev };
  }
}

module.exports = { TrendStrategyV3 };
