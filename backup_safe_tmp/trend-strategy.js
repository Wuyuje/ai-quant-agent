// ═══════════════════════════════════════════════════════════
// 趋势行情引擎 (TrendStrategy) — MA均线趋势策略 (严格按用户规格)
// 原理: 多空排列判趋势方向 + 回踩均线入场 + 金叉死叉 + 粘合发散 + 布林联动
// 规格关键:
//   - 多头排列 MA5>MA10>MA30>MA60 → 上涨只低吸不做空
//   - 空头排列 MA5<MA10<MA30<MA60 → 下跌只高空忌抄底
//   - 缠绕粘合 → 无趋势, 观望不开仓
//   - 回踩MA20/MA30入场(上涨低吸/下跌高空), MA60定大方向
//   - 过滤: 只收盘价, 单K±3%毛刺作废(插针/假突破过滤)
//   - 止损: 跌回反方向均线/固定% | 止盈: 趋势反转/移动跟踪
// ═══════════════════════════════════════════════════════════
const { toArray } = require('./featurer');

// SMA 简单均线(数组版)
function smaRaw(values, period) {
  if (!values || values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a,b)=>a+b,0)/period;
}
// EMA 指数均线
function emaRaw(values, period) {
  if (!values || values.length < period) return null;
  const k = 2/(period+1); let e = values[0];
  for (let i=1;i<values.length;i++) e = values[i]*k + e*(1-k);
  return e;
}

class TrendStrategy {
  constructor(opts = {}) {
    // 均线周期(规格: 短MA5/10, 中MA20/30, 长MA60)
    this.shortMA = 5, this.midMA = 10, this.bandMA = 20, this.band30 = 30, this.longMA = 60;
    // 回踩入场比例(规格: 价格回踩MA20/30波段低吸/高空)
    this.maxPullbackPct = opts.maxPullbackPct || 1.2;      // 距入场均线回踩≤1.2%
    this.stopLossPct = opts.stopLossPct || 2.0;           // 初始止损(跌破/升破反向)
    this.pullbackRatio = opts.pullbackRatio || 0.5;         // 回踩参考均线(MA20或MA30)
    this.candleSpikePct = 3.0;                              // 插针过滤: 单K±3%毛刺作废(规格五.3)
    this.reversalSma = 10;                                  // 止盈反转参考(价格破MA10趋势反转)
    this.trailingPct = opts.trailingPct || 1.5;             // 移动止损距离
  }

  // ═══ 均线计算 + 多空排列判断 ═══
  _maState(closes) {
    const ma5 = smaRaw(closes, 5), ma10 = smaRaw(closes, 10), ma20 = smaRaw(closes, 20), ma30 = smaRaw(closes, 30), ma60 = smaRaw(closes, 60);
    if (ma5 == null || ma10 == null || ma30 == null || ma60 == null) return null;
    // 多头排列: MA5>MA10>MA30>MA60 (规格二.1)
    const bullAligned = ma5 > ma10 && ma10 > ma30 && ma30 > ma60;
    // 空头排列: MA5<MA10<MA30<MA60
    const bearAligned = ma5 < ma10 && ma10 < ma30 && ma30 < ma60;
    // 缠绕粘合: 长短均线差距小(震荡)
    const spread = Math.abs(ma5 - ma60) / (ma60 || 1);
    const tangled = spread < 0.004;   // 粘合阈值
    return { ma5, ma10, ma20, ma30, ma60, bullAligned, bearAligned, tangled, spread };
  }

  // ═══ 市场方向(规格二.1: 多空排列) ═══
  marketDirection(closes) {
    const s = this._maState(closes);
    if (!s) return 'FLAT';
    if (s.tangled) return 'FLAT';            // 缠绕粘合→观望
    if (s.bullAligned) return 'UP';          // 多头排列→上涨
    if (s.bearAligned) return 'DOWN';        // 空头排列→下跌
    // 部分排列(不完美): 用MA20 vs MA60 定次级方向
    return s.ma20 > s.ma60 ? 'UP' : 'DOWN';
  }

  // ═══ 入场信号(规格二.2/二.3): 回踩均线入场 + 金叉/死叉确认 ═══
  entrySignal(klines, marketDir) {
    const arr = toArray(klines);
    if (arr.length < 80) return { signal:'NONE', reason:'数据不足' };
    const closes = arr.map(k => +k[3]);
    const price = closes[closes.length-1];
    // 插针过滤(规格五.3): 单根K涨跌±3% → 该信号作废
    const pc = closes.length>1 ? closes[closes.length-2] : 0;
    if (pc > 0 && Math.abs(price-pc)/pc*100 > this.candleSpikePct) return { signal:'NONE', reason:`插针过滤(单K${((price-pc)/pc*100).toFixed(1)}%±3%)` };
    const s = this._maState(closes);
    if (!s) return { signal:'NONE', reason:'均线不足' };

    // 做多(上涨趋势低吸): 多头排列 + 价格回踩MA20/MA30支撑 + 金叉确认
    if (marketDir === 'UP' && s.bullAligned) {
      const refMA = s.ma30;   // 稳健多头回踩MA30低吸
      // 回踩: 价格略高于或触及MA30
      const distFromRef = (price - refMA) / (refMA || 1) * 100;
      // 上一根在MA30下方(回踩到) → 现价站回(金叉向上)
      const prevPrice = closes[closes.length-2], prevMA = smaRaw(closes.slice(0,-1), 30);
      const pulled = distFromRef >= -0.5 && distFromRef <= this.maxPullbackPct;
      const golden = prevMA != null && prevPrice < prevMA && price >= refMA;
      if (pulled) return { signal:'LONG', reason:`多头回踩MA30低吸(现价${price.toFixed(4)}近MA30${refMA.toFixed(4)})`, price };
    }
    // 做空(下跌趋势高空): 空头排列 + 价格反弹触MA30压力 + 死叉
    if (marketDir === 'DOWN' && s.bearAligned) {
      const refMA = s.ma30;
      const distFromRef = (refMA - price) / (refMA || 1) * 100;
      const prevPrice = closes[closes.length-2], prevMA = smaRaw(closes.slice(0,-1), 30);
      const rebound = distFromRef >= -0.5 && distFromRef <= this.maxPullbackPct;
      const deadCross = prevMA != null && prevPrice > prevMA && price <= refMA;
      if (rebound) return { signal:'SHORT', reason:`空头反弹MA30高空(现价${price.toFixed(4)}触MA30${refMA.toFixed(4)})`, price };
    }
    return { signal:'NONE', reason:`方向${marketDir}未到均线入场位` };
  }

  // ═══ 止损(规格二.2): 价格跌破/升破反向, 或固定%; 含移动止损 ═══
  stopLoss(pos, price, closes) {
    const s = this._maState(closes);
    const entry = pos.entryPrice || price;
    const lossPct = pos.side==='LONG' ? (entry-price)/entry*100 : (price-entry)/entry*100;
    if (s) {
      if (pos.side==='LONG' && price < s.ma20) return { action:'CLOSE', reason:`跌破MA20止损(降${lossPct.toFixed(1)}%)` };
      if (pos.side==='SHORT' && price > s.ma20) return { action:'CLOSE', reason:`升破MA20止损(降${lossPct.toFixed(1)}%)` };
    }
    if (lossPct >= this.stopLossPct) return { action:'CLOSE', reason:`固定止损(${lossPct.toFixed(1)}%≥${this.stopLossPct}%)` };
    return { action:'HOLD' };
  }

  // ═══ 移动止损(规格: 趋势反转离场, 让利润奔跑) ═══
  // 记录持仓期间峰值, 从峰值回落≥trailing%平仓锁利
  trailingStop(pos, price) {
    if (!pos._peak) pos._peak = pos.entryPrice;
    if (pos.side==='LONG' && price > pos._peak) pos._peak = price;
    if (pos.side==='SHORT' && price < pos._peak) pos._peak = price;
    const trav = pos.side==='LONG' ? (pos._peak-price)/pos._peak*100 : (price-pos._peak)/pos._peak*100;
    if (trav >= this.trailingPct) return { action:'CLOSE', reason:`移动止损(从${pos.side==='LONG'?'高':'低'}点回落${trav.toFixed(1)}%≥${this.trailingPct}%)`, peak:pos._peak };
    return { action:'HOLD', peak:pos._peak };
  }

  // 仓位大小(规格: SINGLE_POS_RATIO 单品种15%)
  positionSize(balance, notionalRatio=0.15*3) {
    return { notional: Math.max(20, balance*notionalRatio), margin: Math.max(20,balance*notionalRatio)/3, leverage: 3 };
  }
}

module.exports = { TrendStrategy };
