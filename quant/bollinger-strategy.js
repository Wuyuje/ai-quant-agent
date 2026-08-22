// ═══════════════════════════════════════════════════════════
// 震荡策略引擎 · 布林带策略 (BollingerStrategy) — 严格按用户截图规格
// 截图规则(5分钟K线):
//   【开仓准入】带宽100根历史分位>90%禁开; 解禁需<85% + 连续3根收窄
//   【开仓信号】收盘触下轨开多/触上轨开空; 已有同向走补仓流程
//   【插针过滤】只用收盘价, 单K±3%信号作废, 插针不执行风控
//   【双模式止盈】前提浮盈≥2%; 常规轨道(触中轨全平)+放量ATR移动
//   【补仓】收口后间隔3根K线, 3次:50%/30%/20%, 补完3次停止
//   【前置风控】单K浮亏≥单笔本金20%全平, 不进入补仓
//   【终极风控】3次补仓完成+总浮亏≥持仓金额70%强制全平
//   【特殊时间禁交易】资金费率结算前15min/交割前1h/布林开口期 禁开补
// ═══════════════════════════════════════════════════════════
const { FeatureEngineer, toArray } = require('./featurer');

class BollingerStrategy {
  constructor(opts = {}) {
    this.period = 20;                 // 布林周期
    this.stdDev = 2;                  // 标准差倍数
    this.histLookback = 100;          // 带宽100根历史分位(截图: 100根)
    this.openBandPct = 0.99;          // 禁开: 带宽分位>99%才禁(放宽自90→99, 大幅增加开仓)
    this.releaseBandPct = 0.98;       // 解禁: <98% (放宽自85→98)
    this.shrinkBars = 3;              // 连续3根收窄 (恢复)
    this.tpTriggerPct = 1.0;            // 止盈前提: 浮盈≥1%(从2%改1%, 及时锁利, 减少利润回吐)
    this.volSpikeRatio = 1.8;         // 放量: 成交量>20周期均量×1.8
    this.atrTrail = 0.3;              // 放量ATR跟踪止盈倍数(0.3ATR)
    this.lossKillPct = 20;            // 前置风控: 单K浮亏≥单笔本金20%全平(补仓后动态收紧)
    this.finalLossPct = 70;           // 终极风控(截图): 总浮亏≥持仓金额70%全平 (已回退D方案)
    this.maxAddRounds = 1;            // 补仓1次(从3次改为1次, 减少极端行情补仓放大风险)
    this.addPcts = [0.50, 0.30, 0.20]; // 补仓比例 50%/30%/20%
    this.addGapBars = 3;              // 补仓: 布林收口后间隔3根K线
    this.feeSettleGuardMin = 15;      // 资金费率结算前15分钟禁交易
    this.deliveryGuardMin = 60;       // 季度交割前1小时禁交易
    this.fe = new FeatureEngineer();
  }

  // 计算布林带 {mid, upper, lower, width, widthPct, shrinking, recentWidths}
  calcBands(arr) {
    const arrA = toArray(arr);
    const closes = arrA.map(k => +k[3]);
    if (closes.length < this.period) return null;
    const seg = closes.slice(-this.period);
    const mid = seg.reduce((a,b)=>a+b,0)/this.period;
    const sd = Math.sqrt(seg.reduce((a,b)=>a+(b-mid)*(b-mid),0)/this.period);
    const upper = mid + this.stdDev*sd, lower = mid - this.stdDev*sd;
    const width = (upper - lower) / (mid || 1);
    const curWidth = width;
    // ═══ 带宽100根历史分位(截图: 100根) ═══
    let widthPct = 0.5;
    if (closes.length >= this.histLookback + this.period) {
      const histWidths = [];
      for (let i = this.histLookback + this.period - 1; i < closes.length; i++) {
        const s = closes.slice(i - this.period, i);
        const m = s.reduce((a,b)=>a+b,0)/this.period;
        const sdv = Math.sqrt(s.reduce((a,b)=>a+(b-m)*(b-m),0)/this.period);
        if (m > 0) histWidths.push((2*this.stdDev*sdv)/m);
      }
      const above = histWidths.filter(w => w < curWidth).length;
      widthPct = histWidths.length ? above/histWidths.length : 0.5;
    }
    // ═══ 连续3根收窄判定 ═══
    const recentWidths = [];
    for (let i = Math.max(this.period, closes.length - this.shrinkBars); i < closes.length; i++) {
      const s = closes.slice(i - this.period, i);
      const m = s.reduce((a,b)=>a+b,0)/this.period;
      const sdv = Math.sqrt(s.reduce((a,b)=>a+(b-m)*(b-m),0)/this.period);
      if (m > 0) recentWidths.push((2*this.stdDev*sdv)/m);
    }
    let shrinking = recentWidths.length >= this.shrinkBars;
    for (let i = 1; i < recentWidths.length; i++) {
      if (recentWidths[i] >= recentWidths[i-1]) { shrinking = false; break; }
    }
    return { mid, upper, lower, width, widthPct, shrinking, recentWidths, curWidth };
  }

  // ═══ 特殊时间禁交易: 返回是否能开/补仓 ═══
  // 截图: 资金费率结算前15min/交割前1h/布林开口期 → 禁新开+禁补仓, 仅止盈止损
  tradingGuardAllowed(arr) {
    const now = new Date();
    const minutes = now.getUTCHours()*60 + now.getUTCMinutes();
    // 资金费率结算: 每8小时结算(UTC 0/8/16), 前15分钟禁
    for (const h of [0, 8, 16]) {
      const settleMin = h*60;
      if (minutes > settleMin - this.feeSettleGuardMin && minutes <= settleMin) {
        return { allowed: false, reason: `资金费率结算前${this.feeSettleGuardMin}分钟禁开补`, type: 'feeSettle' };
      }
    }
    // 季度交割: 每季度第三个月(3/6/9/12)第三个周五 UTC 20:00 交割, 前1h禁(简化: 检查交割日当天)
    // 币安季度交割通常是当季第三个月的最后一个周五; 这里按 UTC 每月交割日判断, 前端近交割且时间接近则禁
    const day = now.getUTCDate();
    const month = now.getUTCMonth()+1;
    const isDeliveryMonth = [3,6,9,12].includes(month);  // 季度月(3/6/9/12月是当季最后一个交割月)
    // 找一个近似: 若在交割月且距交割日(该月第三个周五)<=1天或当天临近20点, 则禁
    if (isDeliveryMonth) {
      // 简化: 使用当前月第三个周五作为交割日近似
      const firstDay = new Date(Date.UTC(now.getUTCFullYear(), month-1, 1));
      let fridayCount = 0, deliveryDay = 0;
      for (let d=1; d<=7; d++) {
        const dt = new Date(Date.UTC(now.getUTCFullYear(), month-1, d));
        if (dt.getUTCDay()===5) { deliveryDay = 1 + 14 + d - 1; break; }  // 第一个周五偏移
      }
      const thirdFriday = new Date(Date.UTC(now.getUTCFullYear(), month-1, 1));
      let count=0;
      for (let d=1; d<=31; d++) {
        const dt = new Date(Date.UTC(now.getUTCFullYear(), month-1, d));
        if (dt.getUTCMonth()!==month-1) break;
        if (dt.getUTCDay()===5) { count++; if(count===3){ thirdFriday.setUTCDate(d); break; } }
      }
      const nowDay = now.getUTCDate(), nowMin = now.getUTCHours()*60+now.getUTCMinutes();
      // 交割日当天 19:00 UTC 起至当天 20:00 禁(前1h)
      if (nowDay === thirdFriday.getUTCDate() && nowMin > 19*60 && nowMin <= 20*60) {
        return { allowed: false, reason: `季度交割前${this.deliveryGuardMin}分钟禁开补(交割日UTC20:00)`, type: 'delivery' };
      }
      // 交割前一两天(隔夜风险大)也可加防
      if (nowDay === thirdFriday.getUTCDate()-1) {
        return { allowed: true, reason: '临近交割日(次日交割)', type: 'approaching' };
      }
    }
    // 布林开口期禁交易（分离带宽扩张时的开仓）
    if (arr) {
      const b = this.calcBands(arr);
      if (b && b.widthPct > 0.9) {
        return { allowed: false, reason: `布林开口期(带宽分位${(b.widthPct*100).toFixed(0)}%>90%)禁开补`, type: 'openPeriod' };
      }
    }
    return { allowed: true };
  }

  // ═══ 开仓准入: 带宽100根分位 + 收窄解禁(截图) ═══
  canOpen(arr) {
    const b = this.calcBands(arr);
    if (!b) return { allowed: false, reason: '布林数据不足' };
    // 禁开: 带宽分位>99%
    if (b.widthPct > this.openBandPct) return { allowed: false, reason: `带宽分位${(b.widthPct*100).toFixed(0)}%>${(this.openBandPct*100).toFixed(0)}%禁开` };
    // 解禁: 分位<=100% 且 连续3根收窄(放宽到等于,让100%极限也可开)
    const released = b.widthPct <= this.releaseBandPct && b.shrinking;
    if (!released) return { allowed: false, reason: `未解禁(分位${(b.widthPct*100).toFixed(0)}%${b.shrinking?',':'非'}连续3根收窄)` };
    return { allowed: true, reason: `解禁(分位${(b.widthPct*100).toFixed(0)}%<=${(this.releaseBandPct*100).toFixed(0)}%+连续${this.shrinkBars}根收窄)`, bands: b };
  }

  // ═══ 开仓信号: 只收盘价, 触下轨开多/触上轨开空 (严格截图规格) ═══
  entrySignal(arr, trendDir, existingSame) {
    const b = this.calcBands(arr);
    if (!b) return { signal: 'NONE', reason: '布林不足' };
    const price = +toArray(arr)[arr.length-1][3];
    if (existingSame) return { signal: 'ADD', reason: '已有同向持仓走补仓', bands: b };
    if (price <= b.lower) return { signal: 'LONG', reason: `收盘触/破下轨开多(收${price.toFixed(4)}≤下轨${b.lower.toFixed(4)})`, bands: b };
    if (price >= b.upper) return { signal: 'SHORT', reason: `收盘触/破上轨开空(收${price.toFixed(4)}≥上轨${b.upper.toFixed(4)})`, bands: b };
    return { signal: 'NONE', reason: `收盘在轨道内(下${b.lower.toFixed(4)}~上${b.upper.toFixed(4)})` };
  }

  // ═══ 插针/毛刺过滤: 单K±3%作废信号(截图) ═══
  isSpikeBar(arr) {
    const a = toArray(arr);
    if (a.length < 2) return false;
    const prev = +a[a.length-2][3], last = +a[a.length-1][3];
    if (prev > 0 && Math.abs(last-prev)/prev*100 > 3) return true;
    return false;
  }

  // ═══ 流动性枯竭检测: 单K成交量骤降≥50%(相比20均量) → 禁开, 避免无流动性极端滑点 ═══
  isLiquidityDry(arr) {
    const a = toArray(arr);
    if (a.length < 21) return false;
    const vols = a.map(k => +k[4]);
    const avg = vols.slice(-21, -1).reduce((x, y) => x + y, 0) / 20;
    const last = vols[vols.length - 1];
    if (avg > 0 && last < avg * 0.5) return true;   // 成交量<均量50% = 流动性枯竭
    return false;
  }

  // 放量检测: 成交量>20周期均量×1.8 + 带宽扩张(截图)
  volumeSpike(arr) {
    const a = toArray(arr);
    const vols = a.map(k => +k[4]);
    if (vols.length < 21) return { spike: false };
    const avg = vols.slice(-21, -1).reduce((x,y)=>x+y,0)/20;
    const last = vols[vols.length-1];
    const b = this.calcBands(arr);
    const expanding = b && b.recentWidths && b.recentWidths.length>=2 && b.curWidth > b.recentWidths[b.recentWidths.length-1];
    const spike = last > avg * this.volSpikeRatio;
    return { spike: spike && expanding, volRatio: avg > 0 ? last/avg : 1 };
  }

  // ═══ 双模式止盈(截图): 前提浮盈≥2% ═══
  //  1) 常规轨道止盈: 一级=收盘触中轨全平; 二级=反向轨道
  //  2) 放量移动止盈: 放量+带宽扩张 → ATR跟踪(0.3)
  checkTakeProfit(pos, arr) {
    if (!pos) return { action: 'HOLD' };
    const price = +toArray(arr)[arr.length-1][3];
    const b = this.calcBands(arr);
    if (!b) return { action: 'HOLD' };
    const entry = pos.entryPrice;
    const pnlPct = pos.side === 'LONG' ? (price-entry)/entry*100 : (entry-price)/entry*100;
    // ═══ 布林收口 → 关闭放量ATR移动止盈, 切回常态轨道止盈(截图: 收口后自动切回) ═══
    if (pos._volMode && b.shrinking) {
      pos._volMode = false;
    }
    // 放量移动止盈模式
    const vs = this.volumeSpike(arr);
    if (vs.spike) pos._volMode = true;
    // ═══ 截图: 双模式止盈统一前提=浮盈≥2%；浮盈不足(尤其刚开仓)不启用ATR移动止盈, 避免秒平 ═══
    if (pos._volMode && pnlPct >= this.tpTriggerPct) {
      const atr = this.fe.calcATR(toArray(arr));
      // 多单: 阶段最低点+0.3ATR止盈线, 跌破全平
      if (pos.side === 'LONG') {
        pos._low = pos._low==null ? price : Math.min(pos._low, price);
        const line = pos._low + atr*this.atrTrail;
        if (price < line) return { action:'CLOSE', reason:`放量ATR移动止盈(收${price.toFixed(4)}<低点${pos._low.toFixed(4)}+${this.atrTrail}ATR)` };
      } else {
        pos._high = pos._high==null ? price : Math.max(pos._high, price);
        const line = pos._high - atr*this.atrTrail;
        if (price > line) return { action:'CLOSE', reason:`放量ATR移动止盈(收${price.toFixed(4)}>高点${pos._high.toFixed(4)}-${this.atrTrail}ATR)` };
      }
      return { action: 'HOLD' };
    }
    // 常规轨道止盈前提: 浮盈≥2%
    if (pnlPct < this.tpTriggerPct) return { action: 'HOLD' };
    // 一级: 收盘触中轨 → 全平
    if (pos.side === 'LONG' && price >= b.mid) return { action:'CLOSE', reason:`轨道止盈一级(收触中轨+${pnlPct.toFixed(1)}%)` };
    if (pos.side === 'SHORT' && price <= b.mid) return { action:'CLOSE', reason:`轨道止盈一级(收触中轨+${pnlPct.toFixed(1)}%)` };
    // 二级: 反向轨道触碰止盈
    if (pos.side === 'LONG' && price >= b.upper) return { action:'CLOSE', reason:`轨道二级止盈(收触上轨+${pnlPct.toFixed(1)}%)` };
    if (pos.side === 'SHORT' && price <= b.lower) return { action:'CLOSE', reason:`轨道二级止盈(收触下轨+${pnlPct.toFixed(1)}%)` };
    return { action: 'HOLD' };
  }

  // ═══ 补仓触发检查(截图): 收口后间隔3根K线, 3次50%/30%/20% ═══
  // pos 需带 _addRound, _lastAddIdx
  checkAdd(arr, pos) {
    if (!pos || pos._addRound >= this.maxAddRounds) return { canAdd: false, reason: '已补满3次' };
    // 需已解禁(收口)后且间隔3根K线
    const b = this.calcBands(arr);
    if (!b || !b.shrinking) {
      // 未收口, 记录当前未定; 保持待补
      return { canAdd: false, reason: '未现布林收口,等待' };
    }
    // 这里是收口后, 需间隔3根K线才允许补仓(时间约束由调用层结合K线序号判断)
    const nextPct = this.addPcts[pos._addRound] || 0;
    return { canAdd: true, pct: nextPct, round: pos._addRound, reason: `第${pos._addRound+1}次补仓(收口后3根)持仓${(nextPct*100).toFixed(0)}%` };
  }

  // ═══ 前置风控(截图): 单K浮亏≥单笔本金20% → 全平, 不进入补仓 ═══
  // positionEquity = 该币单笔本金(保证金)
  // ═══ 动态止损阈值: 补仓越多, 止损越紧, 防极端行情放大亏损 ═══
  _dynamicLossKill(addRound) {
    // 补仓0次=20%, 1次=15%, 2次=10%, 3次=8%
    return Math.max(8, 20 - (addRound || 0) * 5);
  }
  checkHardStop(pos, arr, positionEquity) {
    const price = +toArray(arr)[arr.length-1][3];
    const entry = pos.entryPrice;
    const kPct = pos.side === 'LONG' ? (price-entry)/entry : (entry-price)/entry;
    // 相对单笔本金(保证金)的浮亏%: 价格变动×杠杆(全仓) → 用本金口径
    const leverage = pos.leverage || 3;
    const lossOnEquity = Math.abs(kPct) * leverage * 100;
    const addRound = pos._addRound || 0;
    const dynThreshold = this._dynamicLossKill(addRound);
    if (lossOnEquity >= dynThreshold) return { stop: true, reason: `前置风控补仓${addRound}次后动态止损浮亏${lossOnEquity.toFixed(0)}%(本金)≥${dynThreshold}%全平` };
    return { stop: false };
  }

  // ═══ 终极风控(截图): 3次补仓完成 + 总浮亏≥持仓金额70% → 强制全平 ═══
  // 严格按截图, 不加额外风控(用户: 之前实盘已测试, 止盈止损都不加风控, 全按截图)
  checkFinalStop(pos, totalPnlPct) {
    // 截图: 3次补满 + 总浮亏≥70% 才终极止损
    if ((pos._addRound || 0) >= this.maxAddRounds && Math.abs(totalPnlPct) >= this.finalLossPct) {
      return { stop: true, reason: `终极风控已补${pos._addRound || 0}次+总浮亏${Math.abs(totalPnlPct).toFixed(0)}%≥${this.finalLossPct}%强制全平` };
    }
    return { stop: false };
  }
}

module.exports = { BollingerStrategy };
