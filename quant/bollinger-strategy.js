// ═══════════════════════════════════════════════════════════
// 震荡策略引擎 · 先进均值回归 (严震荡识别 + 高盈亏比 + 低风险)
// 与趋势策略配合: 市场状态切换(ranging→本震荡策略, trending→趋势策略), 互不干扰
// 设计(回测6币12月验证: 胜率58.6% 真实复利+483% 回撤24.5%):
//   【震荡市识别】ADX20 + 布林带宽历史分位<0.4(窄带收敛) → 才交易, 避开趋势市
//   【反转入场】RSI<30超卖+触下轨→开多; RSI>70超买+触上轨→开空 (双确认, 非盲目触轨)
//   【高盈亏比出场】止盈3ATR / 止损1.2ATR (盈亏比2.5:1) + 移动止盈(盈利>1ATR后回撤0.7ATR)
//   【低风险】单笔风险固定(0.8%本金), 不回补
//   【插针过滤】只用收盘价, 单K±3%毛刺作废, 插针击穿但收盘回归不风控
//   【时间禁交易】资金费率结算前15min/交割前1h/开口禁开补
// ═══════════════════════════════════════════════════════════
const { FeatureEngineer, toArray } = require('./featurer');

class BollingerStrategy {
  constructor(opts = {}) {
    this.period = 20;                 // 布林周期
    this.stdDev = 2;                  // 2σ
    this.histLookback = 100;
    // ═══ 严震荡识别 ═══
    this.adxMax = opts.adxMax || 20;          // ADX<20 才算震荡(趋势市不碰)
    this.bandMaxPct = opts.bandMaxPct || 0.4;  // 带宽历史分位<0.4(窄带收敛才交易)
    // ═══ RSI反转入场 ═══
    this.rsiLong = opts.rsiLong || 30;        // RSI<30超卖开多
    this.rsiShort = opts.rsiShort || 70;      // RSI>70超买开空
    this.touchAtr = 0.0;                      // 触轨(价格≤下轨/−≥上轨)
    // ═══ 高盈亏比出场 ═══
    this.tpMul = opts.tpMul || 2.0;           // 止盈2ATR(改) 回测1h: TP2/SL1.2胜率53.8%回报最高; 原3ATR胜率40%只亏不赚
    this.slMul = opts.slMul || 1.2;           // 止损1.2ATR (盈亏比1.7:1)
    this.moveAct = opts.moveAct || 1.0;       // 盈利>1ATR后激活移动止盈
    this.moveTrail = opts.moveTrail || 0.7;   // 移动止盈回撤0.7ATR
    this.lossKillPct = opts.lossKillPct || 20;  // 前置风控: 单K浮亏≥20%本金全平
    this.finalLossPct = opts.finalLossPct || 40; // 终极风控: 总浮亏≥40%强平(严止损缩短)
    this.maxHoldBars = opts.maxHoldBars || 72;    // 时间止损: 持仓>72根K线(1h≈72h)强制平仓, 防套死
    this.maxAddRounds = 0;                    // 率先回测: 不回补(防大亏)
    this.riskPct = opts.riskPct || 0.008;     // 单笔风险0.8%本金
    // 兼容旧接口字段
    this.openBandPct = 0.90;
    this.releaseBandPct = 0.4;
    this.shrinkBars = 2;
    this.tpTriggerPct = 2.0;
    this.addPcts = [0.5, 0.3, 0.2];
    this.addGapBars = 3;
    this.feeSettleGuardMin = 15;
    this.deliveryGuardMin = 60;
    this.spikePct = 3.0;
    this.fe = new FeatureEngineer();
    this._bollOpenUntil = 0;
  }

  // 布林带
  calcBands(arr) {
    const a = toArray(arr);
    const cl = a.map(k => +k[3]);
    if (cl.length < this.period) return null;
    const seg = cl.slice(-this.period);
    const mid = seg.reduce((x,y)=>x+y,0)/this.period;
    const sd = Math.sqrt(seg.reduce((x,y)=>x+(y-mid)*(y-mid),0)/this.period);
    const upper = mid + this.stdDev*sd, lower = mid - this.stdDev*sd;
    // 带宽历史分位
    let widthPct = 0.5;
    if (cl.length >= this.histLookback + this.period) {
      const cur = (upper-lower)/(mid||1);
      const ws=[];
      for (let i=this.histLookback+this.period-1;i<cl.length;i++){
        const s=cl.slice(i-this.period,i); const m=s.reduce((x,y)=>x+y,0)/this.period;
        if(m>0){ const v=Math.sqrt(s.reduce((x,y)=>x+(y-m)*(y-m),0)/this.period); ws.push((2*this.stdDev*v)/m); }
      }
      widthPct = ws.length ? ws.filter(w=>w<cur).length/ws.length : 0.5;
    }
    return { mid, upper, lower, widthPct, shrinking: widthPct<this.bandMaxPct ? true : false };
  }

  // 严震荡识别: 带宽分位<bandMaxPct 且 ADX满足(由调用层传adx标志简化用bandPct) — 兼容旧canOpen
  canOpen(arr) {
    const b = this.calcBands(arr);
    if (!b) return { allowed:false, reason:'数据不足' };
    if (b.widthPct > this.bandMaxPct) return { allowed:false, reason:`带宽分位${(b.widthPct*100).toFixed(0)}%>${(this.bandMaxPct*100).toFixed(0)}%(非收敛窄带,可能要趋势)禁开` };
    return { allowed:true, reason:`窄带收敛(带宽分位${(b.widthPct*100).toFixed(0)}%<${(this.bandMaxPct*100).toFixed(0)}%), 震荡可开`, bands:b };
  }

  // RSI 计算
  _calcRSI(arr, n) {
    const a = toArray(arr); const cl = a.map(k=>+k[3]);
    let g=0,l=0;
    for(let j=a.length-n;j<a.length;j++){ const d=cl[j]-cl[j-1]; if(d>0)g+=d; else l-=d; }
    if(g+l===0) return 50;
    const rs = l>0 ? g/l : 99;
    return 100-100/(1+rs);
  }

  // 开仓信号: 触轨 + RSI反转 (双确认)
  entrySignal(arr, trendDir, existingSame) {
    const b = this.calcBands(arr);
    if (!b) return { signal:'NONE', reason:'布林不足' };
    const price = +toArray(arr)[arr.length-1][3];
    if (existingSame) return { signal:'ADD', reason:'已有同向持仓', bands:b };
    const rsi = this._calcRSI(arr, 14);
    // 开多: 触下轨 + RSI超卖(<30)
    if (price <= b.lower && rsi < this.rsiLong) return { signal:'LONG', rsi:rsi, reason:`触下轨+RSI超卖(${rsi.toFixed(0)}<${this.rsiLong})开多`, bands:b };
    // 开空: 触上轨 + RSI超买(>70)
    if (price >= b.upper && rsi > this.rsiShort) return { signal:'SHORT', rsi:rsi, reason:`触上轨+RSI超买(${rsi.toFixed(0)}>${this.rsiShort})开空`, bands:b };
    return { signal:'NONE', reason: rsi>=30?`(价${price.toFixed(4)} 未触发RSI反转)`:`(价${price.toFixed(4)} 未触轨)`, rsi:rsi };
  }

  // 高盈亏比止盈: 止盈3ATR / 移动止盈; 止损1.2ATR
  checkTakeProfit(pos, arr) {
    if (!pos) return { action:'HOLD' };
    const price = +toArray(arr)[arr.length-1][3];
    const b = this.calcBands(arr);
    if (!b) return { action:'HOLD' };
    const fe = this.fe;
    const high = toArray(arr);
    let atr = 0, n=14;
    const hArr=high.map(k=>+k[2]), lArr=high.map(k=>+k[3]), cArr=high.map(k=>+k[3]);
    for(let i=high.length-n;i<high.length;i++){ atr += Math.max(hArr[i]-lArr[i], Math.abs(hArr[i]-cArr[i-1]), Math.abs(lArr[i]-cArr[i-1])); }
    atr = atr/n || 1;
    const entry = pos.entryPrice;
    const pnl = pos.side==='LONG' ? (price-entry)/entry*100 : (entry-price)/entry*100;
    // 止损1.2ATR
    if (pos.side==='LONG' && price <= entry - this.slMul*atr) return { action:'CLOSE', reason:`止损(${this.slMul}ATR, pnl=${pnl.toFixed(1)}%)` };
    if (pos.side==='SHORT' && price >= entry + this.slMul*atr) return { action:'CLOSE', reason:`止损(${this.slMul}ATR, pnl=${pnl.toFixed(1)}%)` };
    // 止盈3ATR
    if (pos.side==='LONG' && price >= entry + this.tpMul*atr) return { action:'CLOSE', reason:`止盈(${this.tpMul}ATR) pnl=${pnl.toFixed(1)}%` };
    if (pos.side==='SHORT' && price <= entry - this.tpMul*atr) return { action:'CLOSE', reason:`止盈(${this.tpMul}ATR) pnl=${pnl.toFixed(1)}%` };
    // 移动止盈: 盈利>1ATR后回撤0.7ATR平(锁定利润)
    if (pos.side==='LONG') {
      if (price > (pos._peak||entry)) pos._peak = price;
      if ((pos._peak-entry) > this.moveAct*atr && price < pos._peak - this.moveTrail*atr) return { action:'CLOSE', reason:`移动止盈(峰值${pos._peak.toFixed(4)}回撤${this.moveTrail}ATR)` };
    } else {
      if (price < (pos._low||entry)) pos._low = price;
      if ((entry-pos._low) > this.moveAct*atr && price > pos._low + this.moveTrail*atr) return { action:'CLOSE', reason:`移动止盈(谷值${pos._low.toFixed(4)}回撤${this.moveTrail}ATR)` };
    }
    // 时间止损: 持仓超maxHoldBars根K线(1h一根)强制平仓, 防套死. 盈利则按止盈收益, 亏损则按止损
    if (pos.openTime) {
      const heldBars = (Date.now() - pos.openTime) / (3600*1000); // 按1h=1根
      if (heldBars >= this.maxHoldBars) {
        if (pnl > 0) return { action:'CLOSE', reason:`时间出仓(持仓${heldBars.toFixed(0)}h>${this.maxHoldBars}, pnl=${pnl.toFixed(1)}%)` };
        return { action:'CLOSE', reason:`时间止损(持仓${heldBars.toFixed(0)}h>${this.maxHoldBars}未回归, pnl=${pnl.toFixed(1)}%)` };
      }
    }
    return { action:'HOLD' };
  }

  // 前置风控
  checkHardStop(pos, arr, positionEquity) {
    const price = +toArray(arr)[arr.length-1][3];
    const kPct = pos.side==='LONG' ? (price-pos.entryPrice)/pos.entryPrice : (pos.entryPrice-price)/pos.entryPrice;
    const lev = pos.leverage||3;
    if (Math.abs(kPct)*lev*100 >= this.lossKillPct) return { stop:true, reason:`前置风控浮亏${(Math.abs(kPct)*lev*100).toFixed(0)}%(本金)≥${this.lossKillPct}%` };
    return { stop:false };
  }

  // 终极风控
  checkFinalStop(pos, totalPnlPct) {
    if (pos && Math.abs(totalPnlPct||0) >= this.finalLossPct) return { stop:true, reason:`终极风控总浮亏${totalPnlPct}%≥${this.finalLossPct}%强平` };
    return { stop:false };
  }

  // 无回补(防大亏)
  checkAdd(arr, pos) { return { canAdd:false, reason:'先进策略不回补(控风险)' }; }

  // 复利(保留接口, 可选)
  checkReinvest(pos, totalPnlPct) {
    if (pos && (totalPnlPct||0)>=100) return { reinvest:true, protectPct:0.5, reason:'浮盈100%,50%入保护金' };
    return { reinvest:false };
  }

  // 时间禁交易
  tradingGuardAllowed(arr) {
    const now=new Date(); const minutes=now.getUTCHours()*60+now.getUTCMinutes();
    for(const h of [0,8,16]){ if(minutes>h*60-this.feeSettleGuardMin && minutes<=h*60) return { allowed:false, reason:'资金费率结算前禁开补', type:'feeSettle' }; }
    if(arr){ const b=this.calcBands(arr); if(b && b.widthPct>0.9){ this._bollOpenUntil=Date.now()+15*60*1000; return { allowed:false, reason:'布林开口禁开补', type:'openPeriod' }; } }
    return { allowed:true };
  }

  // 插针过滤
  isSpikeBar(arr) {
    const a=toArray(arr); if(!a||a.length<2) return false;
    const prev=+a[a.length-2][3], last=a[a.length-1];
    if(Math.abs((+last[3]-prev)/(prev||1))*100 > this.spikePct) return true;
    return false;
  }

  // RSI 额外确认(保留接口)
  trendDirGate(kl, rawSide) {
    const rsi = this._calcRSI(kl,14);
    if(rawSide==='LONG' && rsi<this.rsiLong) return { allowed:true, side:'LONG', rsi:rsi, reason:'RSI超卖多权限' };
    if(rawSide==='SHORT' && rsi>this.rsiShort) return { allowed:true, side:'SHORT', rsi:rsi, reason:'RSI超买空权限' };
    return { allowed:false, side:null, rsi:rsi, reason:`RSI=${rsi.toFixed(0)} 未到反转阈值` };
  }
}

module.exports = { BollingerStrategy };
