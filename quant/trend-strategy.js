// ═══════════════════════════════════════════════════════════
// 趋势行情引擎 (TrendStrategy) v3 — 框架级改进
// 基于回测+专业分析重写: 少而准 + 过滤假信号 + 分批止盈吃趋势
// 核心改进:
//   1. 大级别趋势确认入场(4h多空排列 + 反方向不追)
//   2. 过滤: 成交量放量确认 + RSI不超买超卖(过滤假突破/插针)
//   3. 分批止盈: 到趋势目标先止盈50%, 剩余用宽松移动止损吃尾段
//   4. 止损: MA趋势反转 + ATR动态 + 硬止损三道
// todos: 降低成本(少开但开准)
// ═══════════════════════════════════════════════════════════
const { toArray } = require('./featurer');

function smaRaw(values, period) {
  if (!values || values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a,b)=>a+b,0)/period;
}
function rsiRaw(closes, period=14) {
  if (closes.length < period+1) return 50;
  let gain=0, loss=0;
  const seg=closes.slice(-period-1);
  for(let i=1;i<seg.length;i++){
    const d=seg[i]-seg[i-1];
    if(d>0)gain+=d; else loss-=d;
  }
  loss=loss||1e-9;
  const rs=gain/loss;
  return 100 - 100/(1+rs);
}

class TrendStrategy {
  constructor(opts = {}) {
    this.shortMA=5, this.midMA=10, this.bandMA=20, this.band30=30, this.longMA=60;
    this.stopLossPct = opts.stopLossPct || 1.8;    // 硬止损(收紧)
    this.candleSpikePct = 3.0;                      // 插针过滤
    this.volRatioMin = 1.2;                         // 成交量确认: 放量≥均量×1.2
    this.rsiHigh = 75;                              // RSI超买区(顶背离)
    this.rsiLow = 25;                               // RSI超卖区
    this.reversalBreak = 0.0;                       // MA60反向立即算反转(紧止损,不放大亏损)
    this.tpTargetMult = opts.tpTargetMult || 2.0;   // 目标(分批止盈)前移, 更快锁利
    this.maxAtrPct = opts.maxAtrPct || 3.0;         // 波动率过滤: ATR%>3%的剧烈波动币不做(避FIL/SUI这类大亏)
    this.trailMult = opts.trailMult || 1.2;         // 尾仓位移动止损ATR倍(收紧控制亏损)
    this.maxHoldBars = opts.maxHoldBars || 30;      // 最大持有K线数(减少套牢时间)
  }

  _maState(closes) {
    const ma5=smaRaw(closes,5),ma10=smaRaw(closes,10),ma20=smaRaw(closes,20),ma30=smaRaw(closes,30),ma60=smaRaw(closes,60);
    if (ma5==null||ma10==null||ma30==null||ma60==null) return null;
    const bullAligned = ma5>ma10 && ma10>ma30 && ma30>ma60;
    const bearAligned = ma5<ma10 && ma10<ma30 && ma30<ma60;
    const spread = Math.abs(ma5-ma60)/(ma60||1);
    const tangled = spread < 0.004;
    return { ma5,ma10,ma20,ma30,ma60,bullAligned,bearAligned,tangled,spread };
  }

  marketDirection(closes) {
    const s=this._maState(closes);
    if(!s) return 'FLAT';
    if(s.tangled) return 'FLAT';
    if(s.bullAligned) return 'UP';
    if(s.bearAligned) return 'DOWN';
    return s.ma20>s.ma60?'UP':'DOWN';
  }

  _atr(arr, period=14) {
    const k=toArray(arr);
    if(k.length<period+1)return 0;
    let sum=0;
    for(let i=k.length-period;i<k.length;i++){
      const h=+k[i][1],l=+k[i][2],pc=+k[i-1][3];
      sum+=Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc));
    }
    return sum/period;
  }
  _volumeOk(arr) {
    const vols=toArray(arr).map(k=>+k[4]);
    if(vols.length<21)return true;
    const avg=vols.slice(-21,-1).reduce((a,b)=>a+b,0)/20;
    const last=vols[vols.length-1];
    return avg>0 ? last/avg >= this.volRatioMin : true;
  }

  // ═══ 入场(少而准): 大级别趋势 → 成交量确认 → RSI不极端 → 突破/回踩 ═══
  entrySignal(klines, marketDir) {
    const arr=toArray(klines);
    if(arr.length<80)return {signal:'NONE',reason:'数据不足'};
    const closes=arr.map(k=>+k[3]);
    const price=closes[closes.length-1];
    // 插针过滤
    const pc=closes.length>1?closes[closes.length-2]:0;
    if(pc>0 && Math.abs(price-pc)/pc*100>this.candleSpikePct)return {signal:'NONE',reason:'插针过滤'};
    const s=this._maState(closes);
    if(!s)return {signal:'NONE',reason:'均线不足'};
    const rsi=rsiRaw(closes,14);
    const volOk=this._volumeOk(arr);
    if(!volOk)return {signal:'NONE',reason:'无量确认'};
    // 波动率过滤: 只做走势流畅的趋势币(ATR%过大=剧烈波动, 趋势策略吃亏)
    const priceC=closes[closes.length-1]||1;
    const atrPct=this._atr(arr)/priceC*100;
    if(atrPct>this.maxAtrPct)return {signal:'NONE',reason:`波动率过滤(ATR${atrPct.toFixed(1)}%>${this.maxAtrPct}%,剧烈波动不做)`};

    // 做多: 上涨趋势(非空头) + 金叉/突破 + RSI未超买(避免追高)
    if(marketDir!=='DOWN' && !s.bearAligned){
      const prevC=closes.slice(0,-1), pma5=smaRaw(prevC,5), pma20=smaRaw(prevC,20);
      const golden = pma5!=null&&pma20!=null&&pma5<=pma20&&s.ma5>s.ma20;
      if(golden && rsi<this.rsiHigh) return {signal:'LONG',reason:`金叉且放量RSI${rsi.toFixed(0)}做多`,price};
      // 突破MA20(顺趋势站上)
      const prevMa20=smaRaw(prevC,20);
      if(prevMa20!=null && prevC[prevC.length-1]<=prevMa20 && price>s.ma20 && s.ma20>s.ma60 && rsi<this.rsiHigh)
        return {signal:'LONG',reason:`突破MA20顺趋势做多(RSI${rsi.toFixed(0)})`,price};
    }
    // 做空: 下跌趋势(非多头) + 死叉/跌破 + RSI未超卖(避免杀跌)
    if(marketDir!=='UP' && !s.bullAligned){
      const prevC=closes.slice(0,-1), pma5=smaRaw(prevC,5), pma20=smaRaw(prevC,20);
      const dead = pma5!=null&&pma20!=null&&pma5>=pma20&&s.ma5<s.ma20;
      if(dead && rsi>this.rsiLow) return {signal:'SHORT',reason:`死叉且放量RSI${rsi.toFixed(0)}做空`,price};
      const prevMa20=smaRaw(prevC,20);
      if(prevMa20!=null && prevC[prevC.length-1]>=prevMa20 && price<s.ma20 && s.ma20<s.ma60 && rsi>this.rsiLow)
        return {signal:'SHORT',reason:`跌破MA20顺趋势做空(RSI${rsi.toFixed(0)})`,price};
      const pma30=smaRaw(prevC,30);
      if(pma30!=null && prevC[prevC.length-1]>=pma30 && price<=s.ma30 && s.ma30<s.ma60 && s.ma5<s.ma20 && rsi>this.rsiLow)
        return {signal:'SHORT',reason:`反弹MA30滞涨做空(RSI${rsi.toFixed(0)})`,price};
    }
    return {signal:'NONE',reason:`方向${marketDir}未到确认位`};
  }

  // ═══ 止损(紧, 目标单笔亏损≤5%): 硬止损 + ATR绝对止损 + MA60反转 ═══
  stopLoss(pos, price, closes, arr) {
    const s=this._maState(closes);
    const entry=pos.entryPrice||price;
    const lossPct=pos.side==='LONG'?(entry-price)/entry*100:(price-entry)/entry*100;
    // ① 硬止损(收紧1.8%)
    if(lossPct>=this.stopLossPct)return {action:'CLOSE',reason:`硬止损(${lossPct.toFixed(1)}%≥${this.stopLossPct}%)`};
    // ② ATR绝对止损: 浮亏超过 ATR×N(按价格算) 立即平(防大亏)
    const atr=arr?this._atr(arr):0;
    if(atr>0){
      const allowATR = 2.5;  // 允许回撤≤2.5×ATR; 超过即止损
      const move = pos.side==='LONG'?(entry-price):(price-entry);
      if(move > atr*allowATR)return {action:'CLOSE',reason:`ATR止损(反向${(move/atr).toFixed(1)}ATR,防大亏)`};
    }
    // ③ MA60反转立即离场(0%即触发)
    if(s){
      if(pos.side==='LONG' && price < s.ma60)return {action:'CLOSE',reason:`跌破MA60离场`};
      if(pos.side==='SHORT' && price > s.ma60)return {action:'CLOSE',reason:`升破MA60离场`};
    }
    return {action:'HOLD'};
  }

  // ═══ 分批止盈: 到目标先止盈一半, 剩余移动止损吃尾段 ═══
  takeProfit(pos, price, arr) {
    const atr=this._atr(arr);
    const s=this._maState(toArray(arr).map(k=>+k[3]));
    if(!s)return {action:'HOLD'};
    const entry=pos.entryPrice;
    const pnlPct=pos.side==='LONG'?(price-entry)/entry*100:(entry-price)/entry*100;
    // ① 阶段1止盈: 趋势目标(顺方向 N×ATR) → 先平一半锁利
    const targetDist = atr * this.tpTargetMult;
    if(pos.side==='LONG' && price>=entry+targetDist && !pos._halfDone){
      pos._halfDone=true;
      return {action:'HALF',reason:`阶段止盈(到目标+${pnlPct.toFixed(1)}%,平半锁利)`};
    }
    if(pos.side==='SHORT' && price<=entry-targetDist && !pos._halfDone){
      pos._halfDone=true;
      return {action:'HALF',reason:`阶段止盈(到目标+${pnlPct.toFixed(1)}%,平半锁利)`};
    }
    // ② 剩余仓位: 用宽松移动止损吃趋势尾段(避开次要回调)
    if(pos._halfDone){
      // ATR动态跟踪(从持仓极值回撤)
      if(pos.side==='LONG'&&price>pos._peak)pos._peak=price;
      if(pos.side==='SHORT'&& (pos._peak==null||price<pos._peak))pos._peak=price;
      const peak=pos._peak||entry;
      const trailLine=pos.side==='LONG'?peak-atr*this.trailMult : peak+atr*this.trailMult;
      if(pos.side==='LONG' && price<trailLine)return {action:'CLOSE',reason:`尾段移动止盈(回撤吃完剩余)`};
      if(pos.side==='SHORT' && price>trailLine)return {action:'CLOSE',reason:`尾段移动止盈(回升吃剩余)`};
    }
    // ③ 趋势反转变盘(MA60反向) 全部离场
    if(pos.side==='LONG' && price<s.ma60)return {action:'CLOSE',reason:`跌破MA60趋势反转全平`};
    if(pos.side==='SHORT' && price>s.ma60)return {action:'CLOSE',reason:`升破MA60趋势反转全平`};
    return {action:'HOLD'};
  }

  // 兼容: 简单移动止损(非分批时兜底)
  trailingStop(pos, price, arr) {
    return this.takeProfit(pos, price, arr);
  }

  positionSize(balance, notionalRatio=0.15*3) {
    return { notional: Math.max(20,balance*notionalRatio), margin: Math.max(20,balance*notionalRatio)/3, leverage:3 };
  }
}

module.exports = { TrendStrategy };
