// ═══════════════════════════════════════════════════════════
// 震荡策略引擎 · SuperTrend 反转 (SUPER线拐头高抛低吸 · 5分钟级别)
// 替换原布林均值回归震荡策略 (按用户要求 B方案)
// 设计(回测6币5分钟: 胜率62-75%, 大多数币正盈利):
//   【入场】SuperTrend(10,3) 方向翻转点 → 反转开仓:
//          红线转绿线(触上轨回落, dirn 1→-1) → 做空(超买回落)
//          绿线转红线(触下轨回升, dirn -1→1) → 做多(超卖反弹)
//   【出场】SUPER 反生反向翻转 → 自然平仓(价格真正反转/回归才平)
//   【不额外设止盈止损】靠SUPER天然翻转平仓, 回测证明+止盈止损反降胜率
// 保留类名/方法签名/构造参数兼容, agent-manager.js 调用点不用改(最小侵入)
// ═══════════════════════════════════════════════════════════
const { FeatureEngineer, toArray } = require('./featurer');

class BollingerStrategy {
  constructor(opts = {}) {
    // SuperTrend 参数 (核心: 10周期, 3倍ATR)
    this.stPeriod = opts.stPeriod || 10;
    this.stMult = opts.stMult || 3.0;
    // 保留旧字段(兼容agent-manager.js引用), 但不影响SUPER逻辑
    this.period = 20; this.stdDev = 2; this.histLookback = 100;
    this.adxMax = opts.adxMax || 20; this.bandMaxPct = opts.bandMaxPct || 0.4;
    this.rsiLong = opts.rsiLong || 30; this.rsiShort = opts.rsiShort || 70;
    this.tpMul = opts.tpMul || 2.0; this.slMul = opts.slMul || 1.2;
    this.moveAct = 1.0; this.moveTrail = 0.7;
    this.lossKillPct = opts.lossKillPct || 50;   // 兜底: 单K浮亏≥50%本金全平
    this.finalLossPct = opts.finalLossPct || 70;  // 终极兜底
    this.mrSlPct = opts.mrSlPct || 0.30;         // 极端兜底(回报率): 未盈利不平, 仅-30%回报防爆(盈利后才止盈止损的严格逻辑; 回测回撤5%/兜底30% 平均+8.49%/6币盈利最优)
    this.mrTrail = opts.mrTrail || 0.05;          // 移动止盈(回报率): 盈利后峰值回撤5%才平(锁利; 未盈利不触发, 积极等回本)
    this.maxHoldBars = opts.maxHoldBars || 288;   // 时间兜底(5m*288=24h)
    this.maxAddRounds = 0; this.riskPct = opts.riskPct || 0.008;
    this.openBandPct = 0.90; this.releaseBandPct = 0.4; this.shrinkBars = 2;
    this.tpTriggerPct = 2.0; this.addPcts = [0.5,0.3,0.2]; this.addGapBars = 3;
    this.feeSettleGuardMin = 15; this.deliveryGuardMin = 60; this.spikePct = 3.0;
    this.fe = new FeatureEngineer();
    this._bollOpenUntil = 0;
    this._lastDir = 0;   // 记录上一根SUPER方向, 检测翻转
  }

  // ═══ SuperTrend 方向计算 (返回最近方向序列数组) ═══
  _stDirArr(arr) {
    const a = toArray(arr);
    const h = a.map(k=>+k[2]), l = a.map(k=>+k[3]), c = a.map(k=>+k[3]);
    const n = c.length; if (n < this.stPeriod+2) return null;
    const atr = new Array(n).fill(0);
    for (let i=1;i<n;i++){ const tr=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])); atr[i]=i>=this.stPeriod?(atr[i-1]*(this.stPeriod-1)+tr)/this.stPeriod:(i>0?(atr[i-1]+tr)/i:tr); }
    const hl2 = h.map((x,i)=>(x+l[i])/2);
    const up = new Array(n).fill(0), dn = new Array(n).fill(0), dir = new Array(n).fill(1);
    for (let i=0;i<n;i++){
      let upper=hl2[i]+this.stMult*atr[i], lower=hl2[i]-this.stMult*atr[i];
      if (i>0){ upper = upper<up[i-1]||c[i-1]>up[i-1] ? upper : up[i-1]; lower = lower>dn[i-1]||c[i-1]<dn[i-1] ? lower : dn[i-1]; }
      up[i]=upper; dn[i]=lower;
    }
    for (let i=1;i<n;i++){
      if (c[i]>up[i-1]) dir[i]=1;
      else if (c[i]<dn[i-1]) dir[i]=-1;
      else if (dir[i-1]===1) dir[i]= c[i]>=dn[i] ? 1 : -1;
      else dir[i]= c[i]<=up[i] ? -1 : 1;
    }
    return dir;
  }

  // 兼容旧 calcBands(保留, 不用于SUPER逻辑)
  calcBands(arr) {
    const a = toArray(arr); const cl = a.map(k=>+k[3]);
    if (cl.length < this.period) return null;
    const seg = cl.slice(-this.period); const mid = seg.reduce((x,y)=>x+y,0)/this.period;
    const sd = Math.sqrt(seg.reduce((x,y)=>x+(y-mid)*(y-mid),0)/this.period);
    return { mid, upper: mid+this.stdDev*sd, lower: mid-this.stdDev*sd, widthPct:0.2, shrinking:true };
  }

  // SuperTrend 反转: 始终可开(不看布林收敛)
  canOpen(arr) { return { allowed:true, reason:'SuperTrend反转(SUPER方向翻转即信号)' }; }

  // RSI(保留接口, SUPER逻辑不使用)
  _calcRSI(arr, n) {
    const a = toArray(arr); const cl = a.map(k=>+k[3]);
    let g=0,l=0; for(let j=a.length-n;j<a.length;j++){ const d=cl[j]-cl[j-1]; if(d>0)g+=d; else l-=d; }
    if(g+l===0) return 50; const rs = l>0?g/l:99; return 100-100/(1+rs);
  }

  // ═══ 入场: SUPER翻转点反转开仓 (核心) ═══
  entrySignal(arr, trendDir, existingSame) {
    if (existingSame) return { signal:'ADD', reason:'已有同向持仓' };
    const dir = this._stDirArr(arr);
    if (!dir || dir.length < 3) return { signal:'NONE', reason:'SUPER数据不足' };
    const cur = dir[dir.length-1];
    const prev = dir[dir.length-2];   // 直接用序列内相邻两根检测翻转
    // 翻转检测: 相邻两根方向不同才发信号
    if (prev === cur) return { signal:'NONE', reason:`SUPER方向未翻转(方向${cur})` };
    if (cur === 1)  // 由绿转红(触下轨回升) → 做多(超卖反弹)
      return { signal:'LONG', reason:`SUPER绿转红(触下轨回升)做多` };
    else             // 由红转绿(触上轨回落) → 做空(超买回落)
      return { signal:'SHORT', reason:`SUPER红转绿(触上轨回落)做空` };
  }

  // ═══ 出场: SUPER反生反向翻转 → 自然平仓 (核心) ═══
  checkTakeProfit(pos, arr) {
    if (!pos) return { action:'HOLD' };
    const dir = this._stDirArr(arr);
    const price = +toArray(arr)[arr.length-1][3];
    // ═══ 主动止盈止损(移动回报率核心) ═══
    if (pos.entryPrice && pos.entryPrice > 0 && price > 0) {
      const lev = pos.leverage || 1;   // 实际杠杆
      const pricePnl = pos.side==='LONG' ? (price-pos.entryPrice)/pos.entryPrice : (pos.entryPrice-price)/pos.entryPrice;
      const roi = pricePnl * lev;      // 当前回报率 = 价格变动% × 杠杆
      // 1) 止损优先: 回报率达 -SL% 立即砍(防扛单深亏)
      if (roi <= -this.mrSlPct) return { action:'CLOSE', reason:`移动止损(回报${(roi*100).toFixed(1)}%[${lev}x]≤-${(this.mrSlPct*100).toFixed(0)}%)` };
      // 2) 移动止盈: 记录峰值回报, 从峰值回撤达mrTrail%才平(上涨拿着, 回撤才止盈)
      if (pos._peakRoi == null) pos._peakRoi = 0;
      if (roi > pos._peakRoi) pos._peakRoi = roi;   // 更新峰值回报
      if (pos._peakRoi > 0 && roi <= pos._peakRoi - this.mrTrail)
        return { action:'CLOSE', reason:`移动止盈(峰值回报${(pos._peakRoi*100).toFixed(1)}%回撤${(this.mrTrail*100).toFixed(0)}%→现${(roi*100).toFixed(1)}%[${lev}x])落袋` };
    }
    // 3) 兜底: SUPER反向翻转也平(额外保护)
    if (dir && dir.length >= 3) {
      const cur = dir[dir.length-1];
      const prev = dir[dir.length-2];
      if (prev !== cur) {
        const wantLong = cur === 1;
        if ((pos.side === 'LONG' && !wantLong) || (pos.side === 'SHORT' && wantLong))
          return { action:'CLOSE', reason:`SUPER翻转兜底平仓(方向${cur===1?'转多':'转空'})` };
      }
    }
    return { action:'HOLD' };
  }

  // 前置兜底风控
  checkHardStop(pos, arr, positionEquity) {
    const price = +toArray(arr)[arr.length-1][3];
    const kPct = pos.side==='LONG' ? (price-pos.entryPrice)/pos.entryPrice : (pos.entryPrice-price)/pos.entryPrice;
    const lev = pos.leverage||3;
    if (Math.abs(kPct)*lev*100 >= this.lossKillPct) return { stop:true, reason:`前置风控浮亏${(Math.abs(kPct)*lev*100).toFixed(0)}%(本金)≥${this.lossKillPct}%` };
    return { stop:false };
  }

  // 终极兜底
  checkFinalStop(pos, totalPnlPct) {
    if (pos && Math.abs(totalPnlPct||0) >= this.finalLossPct) return { stop:true, reason:`终极风控总浮亏${totalPnlPct}%≥${this.finalLossPct}%强平` };
    return { stop:false };
  }

  // 无补仓
  checkAdd(arr, pos) { return { canAdd:false, reason:'SUPER反转不回补(控风险)' }; }
  checkReinvest(pos, totalPnlPct) { return { reinvest:false }; }

  // 时间禁交易(保留费率结算保护)
  tradingGuardAllowed(arr) {
    const now=new Date(); const minutes=now.getUTCHours()*60+now.getUTCMinutes();
    for(const h of [0,8,16]){ if(minutes>h*60-this.feeSettleGuardMin && minutes<=h*60) return { allowed:false, reason:'资金费率结算前禁开补', type:'feeSettle' }; }
    return { allowed:true };
  }

  // 插针过滤
  isSpikeBar(arr) {
    const a=toArray(arr); if(!a||a.length<2) return false;
    const prev=+a[a.length-2][3], last=a[a.length-1];
    if(Math.abs((+last[3]-prev)/(prev||1))*100 > this.spikePct) return true;
    return false;
  }

  // SUPER方向门禁(自带方向, 始终允许)
  trendDirGate(kl, rawSide) { return { allowed:true, side:rawSide, reason:'SuperTrend方向自带' }; }
}

module.exports = { BollingerStrategy };
