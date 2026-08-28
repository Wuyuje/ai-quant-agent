// ═══════════════════════════════════════════════════════════
// 震荡策略引擎 · 布林带策略 (严格按用户截图规格重写, 5分钟级别)
// 截图规格(孙总):
//  【选币】前50强流动性; 前十浮盈±≤1%; 同时开5币, 平后自动补足
//  【特殊时间禁】资金费率结算前15min/交割前1h/布林开口禁开补(收口15分后才允新开)
//  【插针过滤】只收盘价; 单K±3%毛刺作废; 插针击穿但收盘回归不风控
//  【开仓准入】5min带宽100根分位>90%禁开; <85%+连续3根收窄解禁; 触下轨开多/触上轨开空; 同向不新开走补仓
//  【双模式止盈】浮盈≥2%; 常态轨道(触中轨全平/二级反向轨兜底) + 放量ATR移动(量>均量1.8,0.3ATR)
//  【补仓】收口后间隔3根, 3次:50%/30%/20%, 补完停
//  【前置风控】单K浮亏≥单笔本金20%全平, 不补仓
//  【终极风控】3次补仓完成+总浮亏≥持仓金额70%强平
//  【复利循环】浮盈≥100%时, 50%入利润保护金, 50%继续新周期
// ═══════════════════════════════════════════════════════════
const { FeatureEngineer, toArray } = require('./featurer');

class BollingerStrategy {
  constructor(opts = {}) {
    this.period = 20;                 // 布林周期
    this.stdDev = 2;                  // 标准差倍数(2σ)
    this.histLookback = 100;          // 带宽100根历史分位(截图四-1)
    this.openBandPct = 0.90;          // 禁开: 带宽分位>90%(截图四-1)
    this.releaseBandPct = 0.85;       // 解禁: <85%(截图四-2)
    this.shrinkBars = 3;              // 连续3根收窄(截图四-2)
    this.tpTriggerPct = 2.0;          // 止盈前提: 浮盈≥2%(截图五)
    this.volSpikeRatio = 1.8;         // 放量: 成交量>20周期均量×1.8(截图五-2)
    this.atrTrail = 0.3;              // 放量ATR跟踪止盈0.3ATR(截图五-2)
    this.lossKillPct = 20;            // 前置风控: 单K浮亏≥单笔本金20%全平(截图七)
    this.finalLossPct = 70;           // 终极风控: 总浮亏≥持仓金额70%强平(截图八)
    this.maxAddRounds = 3;            // 补仓3次(截图六)
    this.touchAtr = 0.0;              // 严格触轨: 5min收盘价触下轨开多/触上轨开空(截图四-3)
    this.addPcts = [0.50, 0.30, 0.20]; // 补仓比例 50%/30%/20%(截图六)
    this.addGapBars = 3;              // 补仓: 收口后间隔3根K线(截图六)
    this.feeSettleGuardMin = 15;      // 资金费率结算前15分钟禁交易(截图二-1)
    this.deliveryGuardMin = 60;       // 季度交割前1小时禁交易(截图二-2)
    this.openPeriodCooldownMs = opts.openPeriodCooldownMs || (15*60*1000);  // 收口后15分钟冷却(截图二-3)
    this.spikePct = 3.0;              // 单K±3%毛刺作废(截图三-2)
    this.reinvestPct = 0.50;          // 复利: 浮盈100%时50%入利润保护金(截图九)
    this.maxOpenCoins = 5;            // 同时开5个币(截图一-3)
    this.fe = new FeatureEngineer();
    this._bollOpenUntil = 0;
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
    // ═══ 带宽100根历史分位(截图一): 当前带宽在近100根中的分位 ═══
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
    // ═══ 连续3根收窄判定(截图四-2) ═══
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

  // ═══ 特殊时间禁交易(截图二): 资金费率结算前15min/交割前1h/布林开口禁开补(收口15分后) 禁新开/补, 仅止盈止损 ═══
  tradingGuardAllowed(arr) {
    const now = new Date();
    const minutes = now.getUTCHours()*60 + now.getUTCMinutes();
    // ① 资金费率结算前15分钟禁(截图二-1): 每8小时结算(UTC 0/8/16)
    for (const h of [0, 8, 16]) {
      if (minutes > h*60 - this.feeSettleGuardMin && minutes <= h*60) {
        return { allowed: false, reason: `资金费率结算前${this.feeSettleGuardMin}分钟禁开补`, type: 'feeSettle' };
      }
    }
    // ② 季度交割前1小时禁(截图二-2): 季度第三个月(3/6/9/12)第三个周五 UTC 20:00
    const month = now.getUTCMonth()+1;
    if ([3,6,9,12].includes(month)) {
      const thirdFri = this._thirdFridayUTC(now.getUTCFullYear(), month);
      const nowDay = now.getUTCDate(), nowMin = now.getUTCHours()*60 + now.getUTCMinutes();
      if (nowDay === thirdFri && nowMin > 19*60 && nowMin <= 20*60) {
        return { allowed: false, reason: `季度交割前${this.deliveryGuardMin}分钟禁开补`, type: 'delivery' };
      }
    }
    // ③ 布林开口禁开补 + 收口15分后(截图二-3)
    if (arr) {
      const b = this.calcBands(arr);
      if (b && b.widthPct > 0.9) {
        this._bollOpenUntil = Date.now() + this.openPeriodCooldownMs;  // 记录收口冷却
        return { allowed: false, reason: `布林开口(带宽分位${(b.widthPct*100).toFixed(0)}%>90%)禁开补`, type: 'openPeriod' };
      }
      if (this._bollOpenUntil && Date.now() < this._bollOpenUntil) {
        return { allowed: false, reason: `布林刚收口(冷却${Math.ceil((this._bollOpenUntil-Date.now())/60000)}分<15分)禁新开`, type: 'openCooldown' };
      }
    }
    return { allowed: true };
  }

  _thirdFridayUTC(year, month) {
    let count = 0, df = 1;
    for (let d = 1; d <= 31; d++) {
      const dt = new Date(Date.UTC(year, month-1, d));
      if (dt.getUTCMonth() !== month-1) break;
      if (dt.getUTCDay() === 5) { count++; if (count === 3) { df = d; break; } }
    }
    return df;
  }

  // ═══ 插针过滤(截图三): 返回是否毛刺K线(单K±3%), + 插针击穿但收盘回归不风控 ═══
  isSpikeBar(arr) {
    const arrA = toArray(arr);
    if (!arrA || arrA.length < 2) return false;
    const last = arrA[arrA.length-1];
    const prevClose = +arrA[arrA.length-2][3];
    const open = +last[1], close = +last[3], high = +last[2], low = +last[3];
    // 单K涨跌幅±3%毛刺(截图三-2)
    const bodyPct = Math.abs(close - prevClose) / (prevClose || 1) * 100;
    if (bodyPct > this.spikePct) return true;
    // 插针: 最高/最低瞬时穿刺但收盘回归(截图三-3) - 用实体小但影线大判断
    const range = (high - low) / (prevClose || 1) * 100;
    const body = Math.abs(close - open) / (prevClose || 1) * 100;
    if (range > this.spikePct && body < range * 0.3) return true;  // 大影线小实体=插针
    return false;
  }

  // ═══ 开仓准入(截图四): 带宽分位>90%禁开; <85%+连续3根收窄解禁 ═══
  canOpen(arr) {
    const b = this.calcBands(arr);
    if (!b) return { allowed: false, reason: '布林数据不足' };
    // 禁开: 带宽分位>90%
    if (b.widthPct > this.openBandPct) return { allowed: false, reason: `带宽分位${(b.widthPct*100).toFixed(0)}%>${(this.openBandPct*100).toFixed(0)}%禁开` };
    // 解禁: <85% 且 连续3根收窄
    if (b.widthPct > this.releaseBandPct) return { allowed: false, reason: `未解禁(带宽分位${(b.widthPct*100).toFixed(0)}%>${(this.releaseBandPct*100).toFixed(0)}%)` };
    if (!b.shrinking) return { allowed: false, reason: '未连续3根收窄(未收口解禁)' };
    return { allowed: true, reason: `解禁(带宽分位${(b.widthPct*100).toFixed(0)}%<${(this.releaseBandPct*100).toFixed(0)}%+3根收窄)`, bands: b };
  }

  // ═══ 开仓信号(截图四-3): 5min收盘触下轨开多/触上轨开空; 已有同向持仓走补仓(不新开) ═══
  entrySignal(arr, trendDir, existingSame) {
    const b = this.calcBands(arr);
    if (!b) return { signal: 'NONE', reason: '布林不足' };
    const price = +toArray(arr)[arr.length-1][3];
    if (existingSame) return { signal: 'ADD', reason: '已有同向持仓走补仓流程', bands: b };  // 截图四-3: 同向不新开走补仓
    // 严格触轨: 触/跌破下轨开多, 触/突破上轨开空(截图四-3)
    if (price <= b.lower) return { signal: 'LONG', reason: `5min收盘触/跌破下轨开多(收${price.toFixed(6)}<=下轨${b.lower.toFixed(6)})`, bands: b };
    if (price >= b.upper) return { signal: 'SHORT', reason: `5min收盘触/突破上轨开空(收${price.toFixed(6)}>=上轨${b.upper.toFixed(6)})`, bands: b };
    return { signal: 'NONE', reason: `收盘在轨道内(未触轨, 下轨${b.lower.toFixed(6)}/上轨${b.upper.toFixed(6)})` };
  }

  // ═══ 放量识别(截图五-2): 成交量>20周期均量×1.8 且 带宽扩张 ═══
  volumeSpike(arr) {
    const arrA = toArray(arr);
    if (!arrA || arrA.length < 21) return { spike: false };
    const vols = arrA.map(k => +k[5]);
    const curVol = vols[vols.length-1] || 0;
    const avgVol = vols.slice(-21, -1).reduce((a,b)=>a+b,0)/20;
    const spike = avgVol > 0 && curVol / avgVol > this.volSpikeRatio;
    return { spike };
  }

  // ═══ 双模式止盈(截图五): 前提浮盈≥2%; 常态轨道(触中轨/反向轨) + 放量ATR移动 ═══
  checkTakeProfit(pos, arr) {
    if (!pos) return { action: 'HOLD' };
    const price = +toArray(arr)[arr.length-1][3];
    const b = this.calcBands(arr);
    if (!b) return { action: 'HOLD' };
    const entry = pos.entryPrice;
    const pnlPct = pos.side === 'LONG' ? (price-entry)/entry*100 : (entry-price)/entry*100;
    // 布林收口 → 关闭放量ATR移动止盈, 切回常态轨道(截图五-2)
    if (pos._volMode && b.shrinking) pos._volMode = false;
    // 放量移动止盈模式(截图五-2)
    const vs = this.volumeSpike(arr);
    if (vs.spike) pos._volMode = true;
    // ═══ 双模式统一前提: 浮盈≥2%(截图五) ═══
    if (pos._volMode && pnlPct >= this.tpTriggerPct) {
      const atr = this.fe.calcATR(toArray(arr));
      // 多单: 阶段最低点+0.3ATR为止盈线, 跌破全平
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
    // 常态轨道止盈前提: 浮盈≥2%(截图五)
    if (pnlPct < this.tpTriggerPct) return { action: 'HOLD' };
    // 一级: 收盘触中轨 → 全平(截图五-1-①)
    if (pos.side === 'LONG' && price >= b.mid) return { action:'CLOSE', reason:`轨道止盈一级(收触中轨+${pnlPct.toFixed(1)}%)` };
    if (pos.side === 'SHORT' && price <= b.mid) return { action:'CLOSE', reason:`轨道止盈一级(收触中轨+${pnlPct.toFixed(1)}%)` };
    // 二级兜底: 未触中轨, 反向轨道触碰止盈(截图五-1-②)
    if (pos.side === 'LONG' && price >= b.upper) return { action:'CLOSE', reason:`轨道二级止盈(收触上轨+${pnlPct.toFixed(1)}%)` };
    if (pos.side === 'SHORT' && price <= b.lower) return { action:'CLOSE', reason:`轨道二级止盈(收触下轨+${pnlPct.toFixed(1)}%)` };
    return { action: 'HOLD' };
  }

  // ═══ 补仓判断(截图六): 收口后间隔3根K线, 3次:50%/30%/20%, 补完停 ═══
  checkAdd(arr, pos) {
    if (!pos || pos._addRound >= this.maxAddRounds) return { canAdd: false, reason: '已补满3次' };
    const b = this.calcBands(arr);
    if (!b || !b.shrinking) return { canAdd: false, reason: '未现布林收口,等待' };
    // 收口后间隔3根K线(时间约束由调用层结合K线序号判断)
    const nextPct = this.addPcts[pos._addRound] || 0;
    return { canAdd: true, pct: nextPct, round: pos._addRound, reason: `第${pos._addRound+1}次补仓(收口后3根)持仓${(nextPct*100).toFixed(0)}%` };
  }

  // ═══ 前置风控(截图七): 单K浮亏≥单笔本金20%全平, 不进入补仓流程; 动态按补仓收紧 ═══
  checkHardStop(pos, arr, positionEquity) {
    const price = +toArray(arr)[arr.length-1][3];
    const entry = pos.entryPrice;
    const kPct = pos.side === 'LONG' ? (price-entry)/entry : (entry-price)/entry;
    // 单笔本金口径浮亏: 价格变动×杠杆(全仓)
    const leverage = pos.leverage || 3;
    const lossOnEquity = Math.abs(kPct) * leverage * 100;
    const addRound = pos._addRound || 0;
    // 截图七: 单K浮亏≥本金20%全平; 补仓后动态收紧
    const dynThreshold = this._dynamicLossKill(addRound);
    if (lossOnEquity >= dynThreshold) return { stop: true, reason: `前置风控浮亏${lossOnEquity.toFixed(0)}%(本金)≥${dynThreshold}%全平(不补仓)` };
    return { stop: false };
  }

  _dynamicLossKill(addRound) {
    // 补仓0次=20%, 1次=15%, 2次=10%, 3次=8% (截图七: 单K20%, 补仓后收紧)
    return Math.max(8, 20 - (addRound || 0) * 5);
  }

  // ═══ 终极风控(截图八): 3次补仓完成 + 总浮亏≥持仓金额70% → 强平 ═══
  checkFinalStop(pos, totalPnlPct) {
    if (!pos) return { stop: false };
    const fullyPadded = (pos._addRound || 0) >= this.maxAddRounds;  // 3次补仓完成
    if (fullyPadded && Math.abs(totalPnlPct || 0) >= this.finalLossPct) {
      return { stop: true, reason: `终极风控: 3次补仓完成+总浮亏${totalPnlPct}%≥70%强平` };
    }
    return { stop: false };
  }

  // ═══ 复利循环(截图九): 浮盈≥100%时, 50%入利润保护金, 50%继续新周期 ═══
  checkReinvest(pos, totalPnlPct) {
    if (!pos) return { reinvest: false };
    if ((totalPnlPct || 0) >= 100) {  // 浮盈≥持仓金额100%
      return { reinvest: true, protectPct: this.reinvestPct, reason: `浮盈${totalPnlPct}%≥100%, ${this.reinvestPct*100}%入利润保护金, ${(1-this.reinvestPct)*100}%继续新周期` };
    }
    return { reinvest: false };
  }

  // ═══ 趋势方向门禁(与趋势策略配合): 4h大趋势顺势力才允许布林开仓, 防逆势抄底/摸顶 ═══
  // openBollinger: 布林在震荡市顺势, 趋势方向由4h EMA判断, 避免在趋势市中逆势
  // ═══ 多层周期确认(截图四-3 + 纯BB策略原始实现): 5min触轨开仓 + RSI超卖/超买作为多层周期权限确认 ═══
  // 开多(5min触下轨): 需RSI<35超卖确认(多层周期多单权限) → 允多
  // 开空(5min触上轨): 需RSI>65超买确认(多层周期空单权限) → 允空
  // 即: 用RSI强弱指标做多层周期方向确认, 只有超卖/超买极致位才给权限(与纯BB策略一致)
  trendDirGate(kl, rawSide, maxSpreadPct = 3) {
    try {
      const arr = toArray(kl);
      if (!arr || arr.length < 15) return { allowed: false, side: null, reason: '数据不足' };
      // 用传入K线(5min)计算RSI(14) 作为多层周期确认
      const closes = arr.map(k => +k[3]);
      const i = closes.length - 1;
      let gains = 0, losses = 0;
      const n = 14;
      if (i > n) {
        for (let j = i - n + 1; j <= i; j++) {
          const d = closes[j] - closes[j-1];
          if (d > 0) gains += d; else losses -= d;
        }
      }
      const rsi = (gains + losses) === 0 ? 50 : 100 - 100 / (1 + (losses > 0 ? gains/losses : 99));
      // 开多: 需RSI超卖(<35) 确认多层周期多单权限
      if (rawSide === 'LONG' && rsi < 35) return { allowed: true, side: 'LONG', rsi: +rsi.toFixed(0), reason: `5min触下轨 + RSI超卖(${rsi.toFixed(0)}<35)多层周期多单权限` };
      // 开空: 需RSI超买(>65) 确认多层周期空单权限
      if (rawSide === 'SHORT' && rsi > 65) return { allowed: true, side: 'SHORT', rsi: +rsi.toFixed(0), reason: `5min触上轨 + RSI超买(${rsi.toFixed(0)}>65)多层周期空单权限` };
      // 无权限(RSI未到超卖/超买): 不开
      const wantTxt = rawSide === 'LONG' ? `5min触下轨但RSI=${rsi.toFixed(0)}未超卖<35(无多单权限)` : `5min触上轨但RSI=${rsi.toFixed(0)}未超买>65(无空单权限)`;
      return { allowed: false, side: null, rsi: +rsi.toFixed(0), reason: wantTxt };
    } catch (e) { return { allowed: false, side: null, reason: '异常' }; }
  }
}

module.exports = { BollingerStrategy };
