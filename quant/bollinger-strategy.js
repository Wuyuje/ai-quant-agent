// ═══════════════════════════════════════════════════════════
// 震荡策略引擎 · 布林带策略 (BollingerStrategy) — 按用户截图规格
// 5分钟K线: 带宽分位开仓准入 + 触轨开仓 + 双模式止盈 + 补仓 + 风控
// 规格七/八条款
// ═══════════════════════════════════════════════════════════
const { FeatureEngineer, toArray } = require('./featurer');

class BollingerStrategy {
  constructor(opts = {}) {
    this.period = 20;                 // 布林周期
    this.stdDev = 2;                  // 标准差倍数
    this.histLookback = 100;          // 带宽100根历史分位
    this.openBandPct = 0.90;          // 开仓准入: 带宽分位>90%禁开
    this.releaseBandPct = 0.85;       // 解禁: <85%
    this.shrinkBars = 3;              // 连续3根收窄
    this.tpTriggerPct = 2.0;          // 止盈触发: 浮盈≥2%资金
    this.volSpikeRatio = 1.8;         // 放量: 成交量>20均量×1.8
    this.atrTrail = 0.3;              // ATR跟踪止盈倍数
    this.lossKillPct = 20;            // 前置风控: 单K浮亏≥20%本金全平
    this.finalLossPct = 70;           // 终极风控: 3次补仓+浮亏70%强平
    this.maxAddRounds = 3;            // 补仓3次
    this.addPcts = [0.50, 0.30, 0.20]; // 补仓比例
    this.fe = new FeatureEngineer();
  }

  // 计算布林带 {mid, upper, lower, width, widthPercentile, shrinking}
  calcBands(arr) {
    const closes = arr.map(k => +k[3]);
    if (closes.length < this.period) return null;
    const seg = closes.slice(-this.period);
    const mid = seg.reduce((a,b)=>a+b,0)/this.period;
    const sd = Math.sqrt(seg.reduce((a,b)=>a+(b-mid)*(b-mid),0)/this.period);
    const upper = mid + this.stdDev*sd, lower = mid - this.stdDev*sd;
    const width = (upper - lower) / (mid || 1);
    // 当前带宽
    let curWidth = width;
    // 带宽100根历史分位
    let widthPct = 0.5;
    if (closes.length >= this.histLookback) {
      const histWidths = [];
      for (let i = this.histLookback; i < closes.length; i++) {
        const s = closes.slice(i-this.period, i);
        const m = s.reduce((a,b)=>a+b,0)/this.period;
        const sdv = Math.sqrt(s.reduce((a,b)=>a+(b-m)*(b-m),0)/this.period);
        histWidths.push((2*this.stdDev*sdv)/(m||1));
      }
      const above = histWidths.filter(w => w < curWidth).length;
      widthPct = histWidths.length ? above/histWidths.length : 0.5;
    }
    // 收窄判断: 最近 shrinkBars 根带宽连续递减
    const recentWidths = [];
    for (let i = Math.max(2, closes.length-this.shrinkBars); i < closes.length; i++) {
      const s = closes.slice(i-this.period, i);
      const m = s.reduce((a,b)=>a+b,0)/this.period;
      const sdv = Math.sqrt(s.reduce((a,b)=>a+(b-m)*(b-m),0)/this.period);
      recentWidths.push((2*this.stdDev*sdv)/(m||1));
    }
    let shrinking = recentWidths.length >= 2;
    for (let i = 1; i < recentWidths.length; i++) {
      if (recentWidths[i] >= recentWidths[i-1]) { shrinking = false; break; }
    }
    return { mid, upper, lower, width, widthPct, shrinking, curWidth };
  }

  // 开仓准入: 带宽分位 + 收窄解禁
  canOpen(arr) {
    const b = this.calcBands(arr);
    if (!b) return { allowed: false, reason: '布林数据不足' };
    // 禁开: 带宽分位>90%
    if (b.widthPct > this.openBandPct) return { allowed: false, reason: `带宽分位${(b.widthPct*100).toFixed(0)}%>90%开口禁开` };
    // 解禁: 分位<85% 且 连续3根收窄
    const released = b.widthPct < this.releaseBandPct && b.shrinking;
    if (!released) return { allowed: false, reason: `未解禁(分位${(b.widthPct*100).toFixed(0)}%${b.shrinking?',':'非'}收窄)` };
    return { allowed: true, reason: `解禁(分位${(b.widthPct*100).toFixed(0)}%<85%+收窄)`, bands: b };
  }

  // 开仓信号: 收盘触下轨开多 / 触上轨开空 (只用收盘价, 插针无效)
  entrySignal(arr, trendDir, existingSame) {
    const b = this.calcBands(arr);
    if (!b) return { signal: 'NONE', reason: '布林不足' };
    const price = +toArray(arr)[arr.length-1][3];   // 收盘价
    // 插针过滤在外部做(单K±3%跳过)
    if (existingSame) {
      return { signal: 'ADD', reason: '已有同向持仓,走补仓', bands: b };  // 触发补仓流程
    }
    // 开多: 收盘破下轨
    if (price <= b.lower) return { signal: 'LONG', reason: `收盘破下轨开多(收${price.toFixed(4)}≤下轨${b.lower.toFixed(4)})`, bands: b };
    // 开空: 收盘破上轨
    if (price >= b.upper) return { signal: 'SHORT', reason: `收盘破上轨开空(收${price.toFixed(4)}≥上轨${b.upper.toFixed(4)})`, bands: b };
    return { signal: 'NONE', reason: `收盘在轨道内(下${b.lower.toFixed(4)}~上${b.upper.toFixed(4)})` };
  }

  // 放量检测
  volumeSpike(arr) {
    const vols = toArray(arr).map(k => +k[4]);
    if (vols.length < 21) return { spike: false };
    const avg = vols.slice(-21, -1).reduce((a,b)=>a+b,0)/20;
    const last = vols[vols.length-1];
    const b = this.calcBands(arr);
    const expanding = b ? (b.recentWidths && b.recentWidths.length>=2 && b.curWidth > b.recentWidths[0]) : false;
    const spike = last > avg * this.volSpikeRatio;
    return { spike: spike && expanding, volRatio: avg>0?last/avg:1 };
  }

  // 双模式止盈: 浮盈≥2%后 → 常态轨道止盈 或 放量ATR移动止盈
  checkTakeProfit(pos, arr) {
    if (!pos) return { action: 'HOLD' };
    const price = +toArray(arr)[arr.length-1][3];
    const b = this.calcBands(arr);
    if (!b) return { action: 'HOLD' };
    const entry = pos.entryPrice;
    const pnlPct = pos.side === 'LONG' ? (price-entry)/entry*100 : (entry-price)/entry*100;
    // 放量模式 → ATR移动止盈
    const vs = this.volumeSpike(arr);
    if (vs.spike) {
      pos._volMode = true;
    }
    if (pos._volMode) {
      // ATR跟踪止盈
      const atr = this.fe.calcATR(toArray(arr));
      const atrLine = pos.side === 'LONG' ? (pos._low || price) + atr*this.atrTrail : (pos._high || price) - atr*this.atrTrail;
      if (pos.side === 'LONG') { pos._low = pos._low ? Math.min(pos._low, price) : price; if (price < atrLine) return { action:'CLOSE', reason:`放量ATR止盈(跌破${atrLine.toFixed(4)})` }; }
      if (pos.side === 'SHORT') { pos._high = pos._high ? Math.max(pos._high, price) : price; if (price > atrLine) return { action:'CLOSE', reason:`放量ATR止盈(突破${atrLine.toFixed(4)})` }; }
      return { action: 'HOLD' };
    }
    // 常态轨道止盈: 浮盈≥2%才触发
    if (pnlPct < this.tpTriggerPct) return { action: 'HOLD' };
    // 一级: 收盘触中轨 → 平
    if (pos.side === 'LONG' && price >= b.mid) return { action:'CLOSE', reason:`轨道止盈(收触中轨+${pnlPct.toFixed(1)}%)` };
    if (pos.side === 'SHORT' && price <= b.mid) return { action:'CLOSE', reason:`轨道止盈(收触中轨+${pnlPct.toFixed(1)}%)` };
    // 二级: 等反向轨道
    if (pos.side === 'LONG' && price >= b.upper) return { action:'CLOSE', reason:`反向轨道止盈(触上轨+${pnlPct.toFixed(1)}%)` };
    if (pos.side === 'SHORT' && price <= b.lower) return { action:'CLOSE', reason:`反向轨道止盈(触下轨+${pnlPct.toFixed(0)}%)` };
    return { action: 'HOLD' };
  }

  // 前置风控: 单K浮亏≥20%单笔本金 → 全平
  checkHardStop(pos, arr, positionEquity) {
    const price = +toArray(arr)[arr.length-1][3];
    const entry = pos.entryPrice;
    const kPnl = pos.side === 'LONG' ? (price-entry)/entry : (entry-price)/entry;
    // 相对单笔本金的浮亏%
    const lossOnEquity = Math.abs(kPnl) * 100;  // ≈ 若满仓
    if (lossOnEquity >= this.lossKillPct) return { stop: true, reason: `前置风控单K浮亏${lossOnEquity.toFixed(0)}%≥20%全平` };
    return { stop: false };
  }
}

module.exports = { BollingerStrategy };
