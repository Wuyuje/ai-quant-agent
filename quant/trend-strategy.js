// ═══════════════════════════════════════════════════════════
// 大道至简·摆动高低点趋势引擎 (TrendStrategy v6)
// 用户认可用摆动高低点捕捉趋势. 本版强化"有序推进"结构确认:
//   上涨: 连续≥3个低点逐级抬高 + 高点逐级抬高 (真实上涨结构)
//   下跌: 连续≥3个高点逐级走低 + 低点逐级走低 (真实下跌结构, 镜像对称)
// 入场: 只在完整结构形成后的"突破/回踩确认点"低买/高卖
// 持有: 不破最后低点(多)/高点(空)就拿住整波; 破则离场
// 少而准: 结构过滤掉大量假信号, 每币只做几次大趋势
// ═══════════════════════════════════════════════════════════
const { toArray } = require('./featurer');

class TrendStrategy {
  constructor(opts = {}) {
    this.swingPeriod = opts.swingPeriod || 6;   // 摆动点周期
    this.needBars = opts.needBars || 3;         // 需≥3个有序摆动点(放宽但保真)
    this.buyPct = opts.buyPct || 1.0;           // 回踩容差
    this.breakPct = opts.breakPct || 0.5;       // 结构破坏容差
    this.trailPct = opts.trailPct || 6.0;       // 移动止盈(吃大波段)
    this.stopLossPct = opts.stopLossPct || 6.0;
    this.minRunPct = opts.minRunPct || 7;       // 结构最小幅度(放宽让更多真趋势进入)
  }

  // ═══ 摆动高低点序列 ═══
  _swingSeq(closes) {
    const p=this.swingPeriod;
    const highs=[], lows=[];
    for(let i=p;i<closes.length-p;i++){
      let h=true,l=true;
      for(let j=i-p;j<=i+p;j++){ if(j===i)continue; if(closes[j]>=closes[i])h=false; if(closes[j]<=closes[i])l=false; }
      if(h&&closes[i]>closes[i-1]) highs.push({v:closes[i],i});
      if(l&&closes[i]<closes[i-1]) lows.push({v:closes[i],i});
    }
    return { highs, lows };
  }

  // ═══ 有序推进结构判定(核心) ═══
  // 上涨: 最近 needBars 个低点逐级抬高 且 高点逐级抬高
  // 下跌: 镜像
  _structure(closes) {
    const {highs,lows}=this._swingSeq(closes);
    const price=closes[closes.length-1];
    if(lows.length<this.needBars || highs.length<this.needBars) return null;
    const lastNLow=lows.slice(-this.needBars).map(x=>x.v);
    const lastNHigh=highs.slice(-this.needBars).map(x=>x.v);
    const lowUp = lastNLow.every((v,i)=> i===0 || lastNLow[i]>lastNLow[i-1]);  // 低点逐级抬高
    const highUp = lastNHigh.every((v,i)=> i===0 || lastNHigh[i]>lastNHigh[i-1]); // 高点逐级抬高
    const lowDown = lastNLow.every((v,i)=> i===0 || lastNLow[i]<lastNLow[i-1]);  // 低点逐级走低
    const highDown = lastNHigh.every((v,i)=> i===0 || lastNHigh[i]<lastNHigh[i-1]); // 高点逐级走低
    const range=(Math.max(...closes.slice(-this.needBars*this.swingPeriod*2))-Math.min(...closes.slice(-this.needBars*this.swingPeriod*2)))/price*100;
    const lastLow=lows[lows.length-1], lastHigh=highs[highs.length-1];
    if(lowUp && highUp && range>=this.minRunPct) return {dir:'UP', lastLow,lastHigh, price, lows:lastNLow, highs:lastNHigh};
    if(lowDown && highDown && range>=this.minRunPct) return {dir:'DOWN', lastLow,lastHigh, price, lows:lastNLow, highs:lastNHigh};
    return null;
  }

  marketDirection(closes) {
    const st=this._structure(closes);
    return st?st.dir:'FLAT';
  }

  // ═══ 对称入场: 低买做多 / 高卖做空 ═══
  entrySignal(klines, marketDir) {
    const arr=toArray(klines); const closes=arr.map(k=>+k[3]);
    const price=closes[closes.length-1];
    const st=this._structure(closes);
    if(!st) return {signal:'NONE',reason:'无完整趋势结构'};
    const pc=closes.length>1?closes[closes.length-2]:0;
    if(pc>0&&Math.abs(price-pc)/pc*100>3) return {signal:'NONE',reason:'插针'};

    if(st.dir==='UP'){
      // 做多·低买: 趋势上涨完整结构, 回调回踩最近低点附近(不破) → 低买
      const back=price<=st.lastLow.v*(1+this.buyPct/100) && price>=st.lastLow.v*(1-this.breakPct/100);
      if(back) return {signal:'LONG',reason:`低买(结构:${st.lows.join('>')}低点抬高,回踩${st.lastLow.v.toFixed(4)})`,price};
      // 突破最近高点 → 启动/加速做多
      if(price>st.lastHigh.v*(1+0.005)) return {signal:'LONG',reason:`突破高点追涨(结构上涨确认)`,price};
    }
    if(st.dir==='DOWN'){
      // 做空·高卖: 下跌结构, 反弹至前高下方(容差放宽到1.5%)或跌破低点 → 高卖
      const reb=price<=st.lastHigh.v*(1+0.015) && price>=st.lastHigh.v*(1-0.008);
      if(reb) return {signal:'SHORT',reason:`高卖(结构:${st.highs.join('<')}高点走低,反弹${st.lastHigh.v.toFixed(4)})`,price};
      if(price<st.lastLow.v*(1-0.003)) return {signal:'SHORT',reason:`跌破低点追跌(结构下跌确认)`,price};
    }
    return {signal:'NONE',reason:`结构${st.dir}无对称入场点`};
  }

  // ═══ 对称持有: 不破结构最后点就拿住整个趋势 ═══
  takeProfit(pos, price, closes) {
    const st=this._structure(closes);
    if(pos.side==='LONG'&&price>pos._peak)pos._peak=price;
    if(pos.side==='SHORT'&& (pos._peak==null||price<pos._peak))pos._peak=price;
    const peak=pos._peak||pos.entryPrice;
    // 破结构: 做多破最近低点 / 做空破最近高点 → 趋势结束离场
    if(st){
      if(pos.side==='LONG' && price<st.lastLow.v*(1-this.breakPct/100)) return {action:'CLOSE',reason:`破结构低点(${st.lastLow.v.toFixed(4)})平多`};
      if(pos.side==='SHORT' && price>st.lastHigh.v*(1+this.breakPct/100)) return {action:'CLOSE',reason:`破结构高点(${st.lastHigh.v.toFixed(4)})平空`};
    }
    // 移动止盈(从趋势极值回落阈值)
    const trav=pos.side==='LONG'?(peak-price)/peak*100:(price-peak)/peak*100;
    if(trav>=this.trailPct) return {action:'CLOSE',reason:`移动止盈(从${pos.side==='LONG'?'高':'低'}点回落${trav.toFixed(1)}%)`};
    return {action:'HOLD',peak};
  }

  // 硬止损兜底
  stopLoss(pos, price, closes) {
    const e=pos.entryPrice||price;
    const lossPct=pos.side==='LONG'?(e-price)/e*100:(price-e)/e*100;
    if(lossPct>=this.stopLossPct) return {action:'CLOSE',reason:`硬止损(${lossPct.toFixed(1)}%)`};
    return {action:'HOLD'};
  }

  positionSize(balance, side='LONG', nRatio=0.15) {
    const lev=side==='LONG'?5:3;
    return { notional:Math.max(20,balance*nRatio*lev), margin:Math.max(20,balance*nRatio*lev)/lev, leverage:lev };
  }
}

module.exports = { TrendStrategy };
