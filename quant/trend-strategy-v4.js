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

  // ═══ 成交量精髓(阿奇): 量价配合验证真伪 ═══
  // 返回: ratio(量比), up(放量突破), 供需背离(缩量涨/放量滞涨)
  vol(arr) {
    const a = toArray(arr); const v = a.map(k => +k[4]); const c = a.map(k => +k[3]);
    if (v.length < 21) return { ratio: 0, up: false, shrinkRising: false, stall: false };
    const avg = v.slice(-21, -1).reduce((x, y) => x + y, 0) / 20;
    const lastV = v[v.length - 1], lastC = c[c.length - 1], prevC = c[c.length - 2] || lastC;
    const ratio = avg > 0 ? lastV / avg : 0;
    const up = avg > 0 ? lastV > avg * this.volMult : false;
    // 量价配合: 缩量滞涨(量缩但价还涨) / 顶部放量滞涨(放量但价不涨)  → 动能衰竭
    const shrinkRising = lastV < avg * 0.8 && lastC > prevC;   // 缩量上涨=假涨/衰竭(截图: 上涨无量=假涨)
    const stall = lastV > avg * this.volMult && Math.abs(lastC - prevC) / (prevC || 1) < 0.001;  // 放量但价不动=滞涨(截图: 顶放量滞涨=出货)
    return { ratio, up, shrinkRising, stall };
  }

  // ═══ 支撑/阻力精髓(阿奇): 多次触碰的关键位更可靠, 突破后角色互换 ═══
  // 识别被至少2次触碰的支撑(抬高低点区)和阻力(降低高点区), 作为关键位
  keyLevels(closes) {
    const lows = [], highs = [];
    for (let i = this.swingLen; i < closes.length - this.swingLen; i++) {
      const win = closes.slice(i - this.swingLen, i + this.swingLen + 1);
      if (closes[i] === Math.min(...win)) lows.push(closes[i]);
      if (closes[i] === Math.max(...win)) highs.push(closes[i]);
    }
    // 支撑: 最近多次触碰的低点(抬高低点区下沿)
    const support = lows.length >= 2 ? Math.min(...lows.slice(-3)) : 0;
    const resistance = highs.length >= 2 ? Math.max(...highs.slice(-3)) : 0;
    return { support, resistance };
  }

  atr(arr) {
    const a = toArray(arr); const h = a.map(k => +k[2]), l = a.map(k => +k[3]), c = a.map(k => +k[3]);
    if (c.length < 2) return 0;
    const trs = [];
    for (let i = 1; i < c.length; i++) trs.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
    return trs.slice(-14).reduce((x, y) => x + y, 0) / Math.min(14, trs.length);
  }

  // ═══ 横盘检测(阿奇: 没有趋势就不画线/不做): 近N根无明确方向 or 窄幅区间反复 → 禁开仓 ═══
  isRange(closes, n = 40) {
    const win = closes.slice(-n);
    if (win.length < 20) return true;   // 数据不足, 当横盘
    const hi = Math.max(...win), lo = Math.min(...win);
    const rangePct = hi > 0 ? (hi - lo) / lo * 100 : 0;
    // 振幅<阈值(如<6%) 或 结构方向反复切换 → 横盘
    if (rangePct < 6) return true;      // 太窄=无波动/横盘
    // 结构方向频繁切换(最近抬高低点不全一致) → 横盘
    const d = this.dir(closes);
    if (d.dir === 'FLAT') return true;
    return false;
  }

  // ═══ 入场(阻力/支撑/量价精髓): 关键位突破回踩(角色互换)+放量确认 ═══
  // 截图: 关键位(多次触碰)放量突破/跌破=真变盘; 突破后回踩原阻力/前高不破(阻力变支撑)=经典确认; 缩量突破=假突破不追; 没有趋势(横盘)不做
  entrySignal(klines) {
    const arr = toArray(klines); const closes = arr.map(k => +k[3]);
    if (closes.length < this.minBars) return { signal: 'NONE', reason: '数据不足' };
    // ═══ 关键: 横盘禁入(大道至简, 没有趋势不做) ═══
    if (this.isRange(closes)) return { signal: 'NONE', reason: '横盘区间禁开仓(无明确趋势)' };
    const d = this.dir(closes);
    const kl = this.keyLevels(closes);   // 多次触碰关键位
    const v = this.vol(arr);
    const price = closes[closes.length - 1];
    const prev = closes[closes.length - 2] || price;
    // 关键位取较高可信度: 趋势结构位 或 多次触碰位

    if (d.dir === 'UP') {
      const res = d.resistance > 0 ? d.resistance : (kl.resistance || 0);
      const sup = d.support > 0 ? d.support : (kl.support || 0);
      // A. 放量突破关键阻力(真突破): 收盘站稳+放量, 且非缩量(缩量不追=假突破)
      if (res > 0 && price > res && prev <= res && v.up && !v.shrinkRising) {
        return { signal: 'LONG', reason: `放量突破关键阻力${(res).toFixed(4)}+量${v.ratio.toFixed(1)}x`, supportLevel: sup, resistanceLevel: res };
      }
      // B. 突破后回踩确认(角色互换, 最经典): 价格回踩到原阻力/抬高低点, 不破+放量企稳
      if (sup > 0 && price >= sup * 0.998 && v.up && !v.shrinkRising) {
        return { signal: 'LONG', reason: `回踩关键支撑${(sup).toFixed(4)}不破+量${v.ratio.toFixed(1)}x`, supportLevel: sup, resistanceLevel: res };
      }
    }
    if (d.dir === 'DOWN') {
      const sup = d.support > 0 ? d.support : (kl.support || 0);
      const res = d.resistance > 0 ? d.resistance : (kl.resistance || 0);
      if (sup > 0 && price < sup && prev >= sup && v.up && !v.shrinkRising) {
        return { signal: 'SHORT', reason: `放量跌破关键支撑${(sup).toFixed(4)}+量${v.ratio.toFixed(1)}x`, supportLevel: sup, resistanceLevel: res };
      }
      if (res > 0 && price <= res * 1.002 && v.up && !v.shrinkRising) {
        return { signal: 'SHORT', reason: `反弹关键阻力${(res).toFixed(4)}受阻+量${v.ratio.toFixed(1)}x`, supportLevel: sup, resistanceLevel: res };
      }
    }
    return { signal: 'NONE', reason: `方向${d.dir} 价${price.toFixed(4)} 量${v.ratio.toFixed(1)}x` };
  }

  // ═══ 止损(阿奇精简): 逻辑破即果断走 + ATR防空扫 + 控单笔亏损 ═══
  // 截图: 止损放逻辑失效处(支撑/突破点); ATR距离≥正常波动; 宁可轻仓不扛单; 止损挂单执行
  stopLoss(pos, klines) {
    const arr = toArray(klines); const closes = arr.map(k => +k[3]);
    const price = closes[closes.length - 1];
    const aVal = this.atr(arr) * this.atrMult;
    // 止损距离: 至少覆盖正常波动(1ATR) 且不超单笔亏损上限(3%, 换算控损)
    const stopDist = Math.max(aVal, pos.entry * 0.015);   // 至少1ATR 或 1.5%价幅
    if (pos.side === 'LONG') {
      // 突破/回踩入场 → 破了入场逻辑位(关键支撑下方)果断走
      const logicStop = pos.supportLevel > 0 ? pos.supportLevel * 0.985 : (pos.entry - stopDist);
      if (price < logicStop) return { action: 'CLOSE', reason: `止损:破关键支撑${logicStop.toFixed(4)}(逻辑破)` };
      // ATR兜底(不扛单): 回撤超1ATR就走
      if (pos.entry - price > stopDist) return { action: 'CLOSE', reason: `ATR止损回撤${(((pos.entry-price)/pos.entry)*100).toFixed(1)}%` };
    } else {
      const logicStop = pos.resistanceLevel > 0 ? pos.resistanceLevel * 1.015 : (pos.entry + stopDist);
      if (price > logicStop) return { action: 'CLOSE', reason: `止损:破关键阻力${logicStop.toFixed(4)}(逻辑破)` };
      if (price - pos.entry > stopDist) return { action: 'CLOSE', reason: `ATR止损反弹${(((price-pos.entry)/pos.entry)*100).toFixed(1)}%` };
    }
    return { action: 'HOLD' };
  }

  // ═══ 离场(阿奇精简): 盈利单让利润跑(量价/结构确认), 亏损单结构破就走 ═══
  takeProfit(pos, klines) {
    const arr = toArray(klines); const closes = arr.map(k => +k[3]);
    if (closes.length < this.minBars) return { action: 'HOLD' };
    const price = closes[closes.length - 1];
    const d = this.dir(closes);
    const v = this.vol(arr);
    const entry = pos.entry || price;
    const pnlPct = pos.side === 'LONG' ? (price - entry) / entry * 100 : (entry - price) / entry * 100;
    if (pos.side === 'LONG') pos.highP = (pos.highP == null || price > pos.highP) ? price : pos.highP;
    else pos.lowP = (pos.lowP == null || price < pos.lowP) ? price : pos.lowP;
    const broken = (pos.side === 'LONG') ? (d.dir !== 'UP' || (d.support > 0 && price < d.support)) : (d.dir !== 'DOWN' || (d.resistance > 0 && price > d.resistance));
    // 盈利单: 让利润跑, 量价背离(缩量涨/顶放量滞涨)或结构破坏+确认 才走
    if (pnlPct > 0) {
      if (pos.side === 'LONG' && (v.stall && v.ratio > 1)) return { action: 'CLOSE', reason: `顶部放量滞涨(量${v.ratio.toFixed(1)}x)平多+${pnlPct.toFixed(1)}%` };
      if (pos.side === 'LONG' && v.shrinkRising && price < pos.highP) return { action: 'CLOSE', reason: `缩量涨衰竭平多+${pnlPct.toFixed(1)}%` };
      if (broken && price < pos.highP && v.up && pnlPct > 2) return { action: 'CLOSE', reason: `结构破坏+放量平多+${pnlPct.toFixed(1)}%` };
      if (broken && price < (d.support || price) && pnlPct > 5) return { action: 'CLOSE', reason: `趋势破位锁利+${pnlPct.toFixed(1)}%` };
    } else {
      // 亏损单: 结构破就果断走(逻辑错, 配合止损), 不拖
      if (broken) return { action: 'CLOSE', reason: `结构破坏止损(亏${pnlPct.toFixed(1)}%)` };
    }
    return { action: 'HOLD' };
  }

  positionSize(balance, side, nRatio = 0.15) {
    const lev = side === 'LONG' ? 5 : 3;
    return { notional: Math.max(20, balance * nRatio * lev), margin: Math.max(20, balance * nRatio * lev) / lev, leverage: lev };
  }
}

module.exports = { TrendStrategyV4 };
