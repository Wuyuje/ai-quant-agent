// ═══════════════════════════════════════════════════════════
// 大道至简·对称趋势引擎 (TrendStrategy v5)
// 理念: 上涨=低点高点有序推进(低买高卖), 下跌=镜像(高卖低买) —— 完全对称
// 核心: 少准单(宁缺毋滥) + 结构拿整波 + 破结构离场
//   做多: 底部突破前高(低买) → 回踩不破前低 → 拿住 → 破前低/顶部反转离场
//   做空: 顶部跌破前低(高卖) → 反弹不破前高 → 拿住 → 破前高/底部反转离场
// 对称, 吃上涨和下跌两向的钱
// ═══════════════════════════════════════════════════════════
const { toArray } = require('./featurer');

class TrendStrategy {
  constructor(opts = {}) {
    // 结构参数(大周期, 少而准)
    this.swingPeriod = opts.swingPeriod || 8;   // 摆动点周期(大一点→信号少而准)
    this.confirmBars = opts.confirmBars || 6;   // 突破/跌破确认根数
    this.lowBuyPct = opts.lowBuyPct || 1.2;     // 回踩前低低买容差%
    this.holdBreakPct = opts.holdBreakPct || 0.3; // 破结构判定(跌破前低/升破前高容差)
    this.trailPct = opts.trailPct || 5.0;        // 移动止盈(从趋势极值回落%)
    this.stopLossPct = opts.stopLossPct || 5.0;  // 硬止损
    this.minTrendPct = opts.minTrendPct || 8;    // 最少方向幅度(过滤横盘)
  }

  // ═══ 结构摆动点(swing) — 大道至简核心 ═══
  _swings(closes, period) {
    const p=period||this.swingPeriod;
    // 用高点低点数组更稳
    const highs=[], lows=[];
    for(let i=p;i<closes.length-p;i++){
      let isH=true, isL=true;
      for(let j=i-p;j<=i+p;j++){ if(j===i)continue; if(closes[j]>=closes[i]){isH=false;} if(closes[j]<=closes[i]){isL=false;} }
      if(isH) highs.push({i,v:closes[i]});
      if(isL) lows.push({i,v:closes[i]});
    }
    // 最近两个摆动点(在当前位置之前)
    let H1=null,H2=null,L1=null,L2=null;
    const cur=closes.length-1;
    for(let k=highs.length-1;k>=0;k--){ if(highs[k].i<=cur-2){ if(!H1)H1=highs[k]; else if(!H2){H2=highs[k];break;} } }
    for(let k=lows.length-1;k>=0;k--){ if(lows[k].i<=cur-2){ if(!L1)L1=lows[k]; else if(!L2){L2=lows[k];break;} } }
    return { H1,H2,L1,L2 };
  }

  // ── 判定对称方向: 结构有序推进 ──
  // 上涨: 最近低点>前低(低点抬高) 且 最近高点≥前高
  // 下跌: 最近高点<前高(高点降低) 且 最近低点≤前低
  marketDirection(closes) {
    const s=this._swings(closes);
    if(!s.H1||!s.H2||!s.L1||!s.L2) return 'FLAT';
    const up = s.L1.v>s.L2.v && s.H1.v>=s.H2.v;     // 低点抬升+高点高企 = 上涨
    const down = s.H1.v<s.H2.v && s.L1.v<=s.L2.v;   // 高点走低+低点走低 = 下跌
    // 确认有足够空间(排除横盘)
    const range=(Math.max(...closes.slice(-s.swingPeriod*4))-Math.min(...closes.slice(-s.swingPeriod*4)));
    const pct=range/(closes[closes.length-1]||1)*100;
    if(pct<this.minTrendPct) return 'FLAT';
    if(up) return 'UP'; if(down) return 'DOWN'; return 'FLAT';
  }

  // ── 对称入场: 低买(做多) / 高卖(做空) ──
  entrySignal(klines, marketDir) {
    const arr=toArray(klines); const closes=arr.map(k=>+k[3]);
    if(closes.length<this.swingPeriod*4) return {signal:'NONE',reason:'数据不足'};
    const price=closes[closes.length-1];
    const s=this._swings(closes);
    // 插针过滤
    const pc=closes.length>1?closes[closes.length-2]:0;
    if(pc>0 && Math.abs(price-pc)/pc*100>3) return {signal:'NONE',reason:'插针'};

    if(marketDir==='UP' && s.L1 && s.L2){
      // 做多·低买: 趋势向上时, 回调回踩前低上方(接近前低不破) → 低买
      const retrace = price>=s.L1.v*(1-this.lowBuyPct/100) && price<=s.L1.v*(1+this.lowBuyPct/100);
      if(retrace) return {signal:'LONG', reason:`低买(回踩前低${s.L1.v.toFixed(4)},低点抬升${s.L2.v.toFixed(4)}→${s.L1.v.toFixed(4)})`, price};
      // 突破前高(上涨启动) → 低买后突破确认
      if(s.H1 && price>s.H1.v*(1+0.01)) return {signal:'LONG', reason:`突破前高启动做多(价${price.toFixed(4)})`, price};
    }
    if(marketDir==='DOWN' && s.H1 && s.H2){
      // 做空·高卖: 趋势向下时, 反弹回前高下方(接近前高不破) → 高卖
      const rebound = price<=s.H1.v*(1+this.lowBuyPct/100) && price>=s.H1.v*(1-this.lowBuyPct/100);
      if(rebound) return {signal:'SHORT', reason:`高卖(反弹前高${s.H1.v.toFixed(4)},高点走低${s.H2.v.toFixed(4)}→${s.H1.v.toFixed(4)})`, price};
      // 跌破前低(下跌启动)
      if(s.L1 && price<s.L1.v*(1-0.01)) return {signal:'SHORT', reason:`跌破前低启动做空(价${price.toFixed(4)})`, price};
    }
    return {signal:'NONE',reason:`结构${marketDir}无对称入场点`};
  }

  // ── 对称持有: 不破结构就拿住整波(吃上涨/下跌趋势的钱) ──
  takeProfit(pos, price, closes) {
    const s=this._swings(closes);
    if(pos.side==='LONG'&&price>pos._peak) pos._peak=price;
    if(pos.side==='SHORT'&& (pos._peak==null||price<pos._peak)) pos._peak=price;
    const peak=pos._peak||pos.entryPrice;
    if(!s) return {action:'HOLD'};
    // 结构破坏离场: 做多破前低 / 做空破前高(趋势结束)
    if(pos.side==='LONG'){
      if(s.L1 && price<s.L1.v*(1-this.holdBreakPct/100)) return {action:'CLOSE',reason:`破前低趋势结束(低点${s.L1.v.toFixed(4)}跌破,平多)`};
    } else {
      if(s.H1 && price>s.H1.v*(1+this.holdBreakPct/100)) return {action:'CLOSE',reason:`破前高趋势结束(高点${s.H1.v.toFixed(4)}升破,平空)`};
    }
    // 对称移动止盈(从趋势极值回落)
    const trav=pos.side==='LONG'?(peak-price)/peak*100:(price-peak)/peak*100;
    if(trav>=this.trailPct) return {action:'CLOSE',reason:`移动止盈(从${pos.side==='LONG'?'趋势高':'趋势低'}点${peak.toFixed(4)}回落${trav.toFixed(1)}%,拿够了)`};
    return {action:'HOLD',peak};
  }

  // ── 硬止损兜底 ──
  stopLoss(pos, price, closes) {
    const entry=pos.entryPrice||price;
    const lossPct=pos.side==='LONG'?(entry-price)/entry*100:(price-entry)/entry*100;
    if(lossPct>=this.stopLossPct) return {action:'CLOSE',reason:`硬止损(${lossPct.toFixed(1)}%≥${this.stopLossPct}%)`};
    return {action:'HOLD'};
  }

  positionSize(balance, side='LONG', nRatio=0.15) {
    const lev=side==='LONG'?5:3;
    return { notional:Math.max(20,balance*nRatio*lev), margin:Math.max(20,balance*nRatio*lev)/lev, leverage:lev };
  }
}

module.exports = { TrendStrategy };
