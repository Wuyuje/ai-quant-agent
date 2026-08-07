// ═══════════════════════════════════════════════════════════
// 趋势行情引擎 (TrendStrategy) v4 — 大道至简·高低点结构
// 原理: 趋势 = 高点低点有序推进 (大道至简)
//   - 上涨: 前高>前高, 前低>前低 (回调不破前低做多, 拿住整波)
//   - 下跌: 前高<前高, 前低<前低 (反弹不破前高做空, 拿住整波)
// 对称: 低买高卖做多 / 高卖低买做空
// ═══════════════════════════════════════════════════════════
const { toArray } = require('./featurer');

class TrendStrategy {
  constructor(opts = {}) {
    this.stopLossPct = opts.stopLossPct || 6.0;       // 硬止损(早前改宽)
    this.pivotPeriod = opts.pivotPeriod || 5;          // 摆动点确认周期(左右各5根)
    this.inhalePct = opts.inhalePct || 1.5;            // 反转确认幅度(从摆动低/高点偏离%)
    this.trailingPct = opts.trailingPct || 4.0;        // 移动止盈: 从趋势极值回落% (拿住趋势)
    this.chanBreakPct = opts.chanBreakPct || 0.5;      // 结构破坏判定(破前低/前高)
  }

  // ═══ 找摆动高低点(swing high/low) — 大道至简的核心 ═══
  _pivots(closes, period) {
    const p = period || this.pivotPeriod;
    const highs=[], lows=[];
    for (let i=p;i<closes.length-p;i++){
      const seg=closes.slice(i-p,i+p+1);
      const cur=closes[i];
      const mx=Math.max(...seg), mn=Math.min(...seg);
      if(cur===mx && cur>closes[i-1]) highs.push({i, v:cur});   // 摆动高点
      if(cur===mn && cur<closes[i-1]) lows.push({i, v:cur});     // 摆动低点
    }
    return { highs, lows };
  }
  // 最近摆动高低点(相对当前位置)
  _getSwing(arr) {
    const closes=arr.map(k=>+k[3]);
    if(closes.length<this.pivotPeriod*3) return null;
    const p=this._pivots(closes, this.pivotPeriod);
    const price=closes[closes.length-1];
    // 最近的低点(在当前位置之前最近确认的)
    let lastLow=null, secondLow=null, lastHigh=null, secondHigh=null;
    for(let k=p.lows.length-1;k>=0;k--){ if(p.lows[k].i<=closes.length-2) { if(!lastLow){lastLow=p.lows[k].v;} else if(!secondLow){secondLow=p.lows[k].v;break;} } }
    for(let k=p.highs.length-1;k>=0;k--){ if(p.highs[k].i<=closes.length-2) { if(!lastHigh){lastHigh=p.highs[k].v;} else if(!secondHigh){secondHigh=p.highs[k].v;break;} } }
    return { lastLow, secondLow, lastHigh, secondHigh, price };
  }

  // ═══ 市场方向: 高低点结构(前高>前高&前低>前低=UP; 反之DOWN) ═══
  marketDirection(closes) {
    const s=this._getSwing(closes.map(v=>typeof v==='number'?{3:v}:v));
    if(!s||!s.lastLow||!s.secondLow||!s.lastHigh||!s.secondHigh) return 'FLAT';
    if(s.lastLow>s.secondLow && s.lastHigh>s.secondHigh) return 'UP';    // 前低抬升+前高抬升
    if(s.lastLow<s.secondLow && s.lastHigh<s.secondHigh) return 'DOWN';  // 前低走低+前高走低
    return 'FLAT';
  }

  // ═══ 入场(大道至简: 低买高卖/高卖低买) ═══
  entrySignal(klines, marketDir) {
    const s=this._getSwing(klines);
    if(!s) return {signal:'NONE',reason:'摆动点不足'};
    const price=s.price;
    const pc=toArray(klines).map(k=>+k[3]); const prev=pc.length>1?pc[pc.length-2]:0;
    // 插针过滤(单K±3%毛刺不作数)
    if(prev>0 && Math.abs(price-prev)/prev*100>3) return {signal:'NONE',reason:'插针跳过'};
    if(marketDir==='UP'){
      // 上涨趋势: 回调不破前低 → 低买回踩价接近前低(低买)
      if(s.lastLow && s.secondLow && price>=s.lastLow*(1-0.01) && price<=s.lastLow*(1+0.02)){
        return {signal:'LONG',reason:`大道至简低买(回踩前低${s.lastLow.toFixed(4)},未破前低${s.secondLow.toFixed(4)})`,price};
      }
      // 上涨启动: 从底部突破放量反弹(低点反转)
      if(s.lastHigh && price>s.lastHigh && s.lastLow>s.secondLow){
        return {signal:'LONG',reason:`上涨启动(突破摆动高,前低抬升)`,price};
      }
    } else if(marketDir==='DOWN'){
      // 下跌趋势: 反弹不破前高 → 高卖(反弹价接近前高)
      if(s.lastHigh && s.secondHigh && price<=s.lastHigh*(1+0.01) && price>=s.lastHigh*(1-0.02)){
        return {signal:'SHORT',reason:`大道至简高卖(反弹前高${s.lastHigh.toFixed(4)},未破前高${s.secondHigh.toFixed(4)})`,price};
      }
      // 下跌启动: 从顶部跌破(高点反转)
      if(s.lastLow && price<s.lastLow && s.lastHigh<s.secondHigh){
        return {signal:'SHORT',reason:`下跌启动(跌破摆动低,前高走低)`,price};
      }
    }
    return {signal:'NONE',reason:`结构${marketDir}未到低买/高卖点`};
  }

  // ═══ 持有(大道至简: 不破结构就一直拿住吃整波) ═══
  // 做多: 只要不破前低(结构)就一直持有; 破前低=趋势破坏离场
  // 做空: 只要不破前高就一直持有; 破前高=离场
  holdCheck(pos, price, closes) {
    const s=this._getSwing(closes.map(v=>typeof v==='number'?{3:v}:v));
    if(!s) return {action:'HOLD'};
    if(pos.side==='LONG'){
      // 破前低→离场(结构破坏); 高于前高→继续新高(拿住)
      if(s.lastLow && price<s.lastLow) return {action:'CLOSE',reason:`破前低结构破坏(跌穿${s.lastLow.toFixed(4)})离场`};
    } else {
      if(s.lastHigh && price>s.lastHigh) return {action:'CLOSE',reason:`破前高结构破坏(突破${s.lastHigh.toFixed(4)})离场`};
    }
    return {action:'HOLD'};
  }

  // 移动止盈(拿住趋势, 从极值大幅回落才平)
  trailingStop(pos, price) {
    if(pos.side==='LONG'&&price>pos._peak) pos._peak=price;
    if(pos.side==='SHORT'&& (pos._peak==null||price<pos._peak)) pos._peak=price;
    const peak=pos._peak||pos.entryPrice;
    const trav=pos.side==='LONG'?(peak-price)/peak*100:(price-peak)/peak*100;
    if(trav>=this.trailingPct) return {action:'CLOSE',reason:`移动止盈(从${pos.side==='LONG'?'高':'低'}点${peak.toFixed(4)}回落${trav.toFixed(1)}%)`,peak:peak};
    return {action:'HOLD',peak};
  }

  stopLoss(pos, price, closes) {
    const s=this._getSwing(closes.map(v=>typeof v==='number'?{3:v}:v));
    const entry=pos.entryPrice||price;
    const lossPct=pos.side==='LONG'?(entry-price)/entry*100:(price-entry)/entry*100;
    if(lossPct>=this.stopLossPct) return {action:'CLOSE',reason:`硬止损(${lossPct.toFixed(1)}%)`};
    return {action:'HOLD'};
  }

  takeProfit(pos, price, closes) {
    const hc=this.holdCheck(pos,price,closes);
    if(hc.action==='CLOSE') return {action:'CLOSE',reason:hc.reason};
    return this.trailingStop(pos,price);
  }

  positionSize(balance, side='LONG', notionalRatio=0.15) {
    const lev=side==='LONG'?5:3;
    return { notional:Math.max(20,balance*notionalRatio*lev), margin:Math.max(20,balance*notionalRatio*lev)/lev, leverage:lev };
  }
}

module.exports = { TrendStrategy };
