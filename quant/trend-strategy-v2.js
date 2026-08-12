// ═══════════════════════════════════════════════════════════
// 趋势策略 V2 — 按"阿奇AI"理论教学重写
// 核心框架: 趋势线给你方向, 突破给你入场时机, 成交量验证真伪
// 理论要点:
//   1) 趋势方向: 依次抬高的低点(上升) / 依次降低的高点(下降)
//   2) 趋势线: 连接多个抬高低/高点, 多点头验证有效
//   3) 突破: 真突破需 收盘站稳 + 放量 + 回踩确认 (至少2个)
//      假突破: 速度快/影线长/量一般/回原区间
//   4) 成交量: 量价齐升=健康; 涨缩量=衰竭; 底放量=资金进; 顶放量滞涨=出货
//   5) 止损: 按"逻辑失效处"(支撑/趋势线/突破点下方) + ATR 1.5倍辅助
//   6) 反转: 结构破坏(跌破前低/突破前高) + 背离(价格新高指标不新高) + 放量 共振
// ═══════════════════════════════════════════════════════════
const { FeatureEngineer, toArray } = require('./featurer');

class TrendStrategyV2 {
  constructor(opts = {}) {
    this.swingLen = opts.swingLen || 5;      // 分形/枢轴的左右柱子数(识别swing高低点)
    this.atrPeriod = 14;
    this.atrStopMult = 1.5;                  // 止损: ATR 1.5倍(理论推荐1.5~2)
    this.trendMinBars = 3;                   // 趋势需至少3个swing点确认
    this.volRatio = 1.5;                     // 突破放量: 成交量>20均量×1.5
    this.breakPct = 0.0015;                  // 收盘站稳突破阈值(0.15%)
    this.minSwingCount = 2;                  // 至少2个抬高低/降低高构成结构
    this.fe = new FeatureEngineer();
  }

  // 识别 swing 高低点(分形): k[i] 是左右 swingLen 根的最高/最低
  findPivots(closes) {
    const pivots = [];  // {idx, type:'high'|'low', price}
    const n = closes.length;
    for (let i = this.swingLen; i < n - this.swingLen; i++) {
      const isHigh = closes[i] === Math.max(...closes.slice(i - this.swingLen, i + this.swingLen + 1));
      const isLow  = closes[i] === Math.min(...closes.slice(i - this.swingLen, i + this.swingLen + 1));
      if (isHigh) pivots.push({ idx: i, type: 'high', price: closes[i] });
      if (isLow) pivots.push({ idx: i, type: 'low', price: closes[i] });
    }
    return pivots;
  }

  // 趋势结构: 上升=依次抬高的低点; 下降=依次降低的高点
  // 返回 {dir:'UP'|'DOWN'|'FLAT', trendlineSlope, lastLowIdx, lastHighIdx, higherLows, lowerHighs}
  detectStructure(closes) {
    const pivots = this.findPivots(closes);
    const lows = pivots.filter(p => p.type === 'low');
    const highs = pivots.filter(p => p.type === 'high');
    const last = lows.length ? lows[lows.length - 1] : null;
    const lastHigh = highs.length ? highs[highs.length - 1] : null;

    // 上升: 最近N个低点依次抬高
    const recentLows = lows.slice(-this.minSwingCount - 1);
    let higherLows = true;
    for (let i = 1; i < recentLows.length; i++) if (recentLows[i].price <= recentLows[i-1].price) { higherLows = false; break; }

    const recentHighs = highs.slice(-this.minSwingCount - 1);
    let lowerHighs = true;
    for (let i = 1; i < recentHighs.length; i++) if (recentHighs[i].price >= recentHighs[i-1].price) { lowerHighs = false; break; }

    if (higherLows && recentLows.length >= 2) return { dir: 'UP', trendlineSlope: 1, lastLowIdx: last ? last.idx : -1, lastLowPrice: last ? last.price : 0, lastHighIdx: lastHigh ? lastHigh.idx : -1, lastHighPrice: lastHigh ? lastHigh.price : 0, recentLows, lowerHighs: false };
    if (lowerHighs && recentHighs.length >= 2) return { dir: 'DOWN', trendlineSlope: -1, lastHighIdx: lastHigh ? lastHigh.idx : -1, lastHighPrice: lastHigh ? lastHigh.price : 0, lastLowIdx: last ? last.idx : -1, lastLowPrice: last ? last.price : 0, recentHighs, lowerHighs: true };
    return { dir: 'FLAT', trendlineSlope: 0, lastLowIdx: last ? last.idx : -1, lastLowPrice: last ? last.price : 0, lastHighIdx: lastHigh ? lastHigh.idx : -1, lastHighPrice: lastHigh ? lastHigh.price : 0 };
  }

  // 成交量验证: 返回量价信号
  volumeCheck(arr) {
    const a = toArray(arr);
    const closes = a.map(k => +k[3]), vols = a.map(k => +k[4]);
    if (vols.length < 21) return {};
    const avg = vols.slice(-21, -1).reduce((x, y) => x + y, 0) / 20;
    const lastVol = vols[vols.length - 1];
    const lastClose = closes[closes.length - 1], prevClose = closes[closes.length - 2] || lastClose;
    const rising = lastClose > prevClose;
    const volUp = lastVol > avg * this.volRatio;
    return { volRatio: avg > 0 ? lastVol / avg : 1, rising, volUp, avg };
  }

  // 入场: 基于趋势结构 + 突破(收盘站稳+放量) + 回踩确认
  entrySignal(klines) {
    const arr = toArray(klines);
    const closes = arr.map(k => +k[3]);
    if (closes.length < 60) return { signal: 'NONE', reason: '数据不足' };
    const structure = this.detectStructure(closes);
    const vol = this.volumeCheck(arr);
    const price = closes[closes.length - 1];
    const prevHigh = structure.lastHighPrice || price;
    const prevLow = structure.lastLowPrice || price;

    // 做多(上升趋势):
    //   - 突破近期高点 + 收盘站稳(>prevHigh+breakPct) + 放量 → 强做多
    //   - 或 回踩趋势低点不破(prevLow支撑有效) + 放量 → 做多
    if (structure.dir === 'UP') {
      const breakUp = price > prevHigh + prevHigh * this.breakPct && vol.volUp;
      const pullbackHold = price >= prevLow * 0.998 && vol.volUp && vol.rising;
      if (breakUp) return { signal: 'LONG', reason: `放量突破新高(${price.toFixed(4)}>${prevHigh.toFixed(4)})+量${vol.volRatio.toFixed(1)}x` };
      if (pullbackHold) return { signal: 'LONG', reason: `回踩支撑(低点${prevLow.toFixed(4)})放量企稳` };
    }
    // 做空(下降趋势):
    //   - 跌破近期低点 + 收盘站稳 + 放量 → 强做空
    //   - 或 反弹到趋势高点受阻 + 放量 → 做空
    if (structure.dir === 'DOWN') {
      const breakDown = price < prevLow - prevLow * this.breakPct && vol.volUp;
      const reboundReject = price <= prevHigh * 1.002 && vol.volUp && !vol.rising;
      if (breakDown) return { signal: 'SHORT', reason: `放量跌破新低(${price.toFixed(4)}<${prevLow.toFixed(4)})+量${vol.volRatio.toFixed(1)}x` };
      if (reboundReject) return { signal: 'SHORT', reason: `反弹受阻(高点${prevHigh.toFixed(4)})放量` };
    }
    return { signal: 'NONE', reason: `趋势${structure.dir} 价${price.toFixed(4)} 量${vol.volRatio ? vol.volRatio.toFixed(1) + 'x' : '-'}` };
  }

  // 持仓止损: 按逻辑失效处(支撑/趋势线/突破点) + ATR 1.5倍
  stopLoss(pos, arr) {
    const a = toArray(arr);
    const closes = a.map(k => +k[3]);
    const price = closes[closes.length - 1];
    const atr = (this.fe && this.fe.calcATR) ? this.fe.calcATR(a) : (this._atr ? this._atr(a) : 0);
    // ATR止损线: 入场逻辑失效处
    const stopDist = atr * this.atrStopMult;
    if (pos.side === 'LONG') {
      // 跌破 入场逻辑价位(前低/趋势线) - ATR缓冲 → 逻辑破了
      const logicLevel = pos.supportLevel || (pos.entryPrice - stopDist);
      if (price < logicLevel) return { action: 'CLOSE', reason: `逻辑止损: 跌破支撑/趋势线(${logicLevel.toFixed(4)})[ATR ${atr ? atr.toFixed(4) : '-'}]` };
    } else {
      const logicLevel = pos.resistanceLevel || (pos.entryPrice + stopDist);
      if (price > logicLevel) return { action: 'CLOSE', reason: `逻辑止损: 突破阻力/趋势线(${logicLevel.toFixed(4)})[ATR ${atr ? atr.toFixed(4) : '-'}]` };
    }
    // ATR硬止损兜底(防极端)
    if (pos.side === 'LONG' && price < pos.entryPrice - stopDist) return { action: 'CLOSE', reason: `ATR止损(${stopDist.toFixed(4)})` };
    if (pos.side === 'SHORT' && price > pos.entryPrice + stopDist) return { action: 'CLOSE', reason: `ATR止损(${stopDist.toFixed(4)})` };
    return { action: 'HOLD' };
  }

  // 反转/止盈: 结构破坏 + 背离 + 量 共振
  takeProfit(pos, klines) {
    const arr = toArray(klines);
    const closes = arr.map(k => +k[3]);
    if (closes.length < 60) return { action: 'HOLD' };
    const structure = this.detectStructure(closes);
    const vol = this.volumeCheck(arr);
    const price = closes[closes.length - 1];
    const entry = pos.entryPrice;
    const pnlPct = pos.side === 'LONG' ? (price - entry) / entry * 100 : (entry - price) / entry * 100;

    // 结构破坏(反转信号): 上升趋势跌破前低 / 下降趋势突破前高
    if (pos.side === 'LONG' && structure.dir === 'DOWN') {
      // 趋势结构已转下降(结构破坏)
      if (vol.volUp) return { action: 'CLOSE', reason: `结构破坏+放量(${vol.volRatio.toFixed(1)}x)平多${pnlPct.toFixed(1)}%` };
      if (pnlPct > 0 && price < (structure.lastHighPrice || 0)) return { action: 'CLOSE', reason: `结构破坏平多${pnlPct.toFixed(1)}%` };
    }
    if (pos.side === 'SHORT' && structure.dir === 'UP') {
      if (vol.volUp) return { action: 'CLOSE', reason: `结构破坏+放量(${vol.volRatio.toFixed(1)}x)平空${pnlPct.toFixed(1)}%` };
      if (pnlPct > 0 && price > (structure.lastLowPrice || 0)) return { action: 'CLOSE', reason: `结构破坏平空${pnlPct.toFixed(1)}%` };
    }
    // 量价背离止盈: 上涨缩量(动能衰竭) / 顶部放量滞涨
    if (pos.side === 'LONG' && pnlPct > 0 && vol.volume && !vol.volUp && vol.avg && price < closes[closes.length-2]) {
      return { action: 'CLOSE', reason: `顶量滞涨/缩量衰竭平多${pnlPct.toFixed(1)}%` };
    }
    if (pos.side === 'SHORT' && pnlPct > 0 && vol.volUp && vol.avg && price > closes[closes.length-2]) {
      // 空单: 反弹放量(空头动/衰竭) 注意
    }
    return { action: 'HOLD' };
  }

  _atr(arr) {
    const a = toArray(arr);
    const highs = a.map(k => +k[2]), lows = a.map(k => +k[3]), closes = a.map(k => +k[3]);
    if (closes.length < 2) return 0;
    const trs = [];
    for (let i = 1; i < closes.length; i++) {
      trs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
    }
    return trs.slice(-this.atrPeriod).reduce((a,b)=>a+b,0)/Math.min(this.atrPeriod, trs.length);
  }

  positionSize(balance, side, nRatio = 0.15) {
    const lev = side === 'LONG' ? 5 : 3;
    return { notional: Math.max(20, balance * nRatio * lev), margin: Math.max(20, balance * nRatio * lev) / lev, leverage: lev };
  }
}

module.exports = { TrendStrategyV2 };
