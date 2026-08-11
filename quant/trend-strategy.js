// ═══════════════════════════════════════════════════════════
// 大道至简·趋势行情引擎 (TrendStrategy v7) — 纯MA7 + 位置 + 拐头
// 用户精确规则(5分钟级别, 只用MA7线):
// 做多(低买): MA7在趋势最低位(跌无可跌) → MA7突然拐头向上 → 买入
//  持有: 大趋势没变+MA7趋势没大改变就一直拿(中途震荡不平,不破最低点)
//  止盈: 涨到最高点涨不上, MA7拐头向下 → 平仓(必须到最高点,绝不被震出)
// 做空(高卖): MA7上行到高位 → MA7突然拐头向下 → 做空
//  持有: 拿住下行趋势, 中途震荡不平
//  止盈: 跌到跌无可跌, MA7拐头向上 → 平仓(必须到最低点)
// 铁律: 开仓绝不开反(位置必须低买/高卖); 止盈绝不被震出(到最高/最低才平)
// ═══════════════════════════════════════════════════════════
const { toArray } = require('./featurer');

// MA(SMA)简单均线(仅MA7)
function sma7(closes) {
  if (!closes || closes.length < 7) return null;
  return closes.slice(-7).reduce((a,b)=>a+b,0)/7;
}

class TrendStrategy {
  constructor(opts = {}) {
    this.lookback = opts.lookback || 288;    // 位置区间: 近288根5min≈1天(判断低位/高位)
    this.lowCut = opts.lowCut || 0.60;        // 做多: MA7低位区(<60%放宽)
    this.highCut = opts.highCut || 0.40;      // 做空: MA7高位区(>40%放宽)
    this.turnAbs = opts.turnAbs || 0.00008;   // 拐头幅度(略降,更多启动能触发)
    this.stopLossPct = opts.stopLossPct || 4.0; // 硬止损兜底(防极端)
this.trailPct = opts.trailPct || 3.0;         // 移动止损: 从最高/最低回撤3%才平(拿满趋势不中途震)
  }

  // ═══ 核心: MA7位置 + 拐头判定 ═══
  _genMA7(closes) {
    const ma = [];
    for (let i = 6; i < closes.length; i++) ma.push(closes.slice(i-6,i+1).reduce((a,b)=>a+b,0)/7);
    return ma;
  }

  // 位置(0~1): 当前MA7在近lookback根区间的位置
  _posRatio(closes) {
    const ma = this._genMA7(closes);
    if (!ma.length) return null;
    const curMA = ma[ma.length-1];
    const look = Math.min(this.lookback, ma.length);
    const hist = ma.slice(-look);
    const hi = Math.max(...hist), lo = Math.min(...hist);
    const range = hi - lo;
    if (range <= 0) return { pos: 0.5, curMA, hi, lo };
    return { pos: (curMA - lo)/range, curMA, hi, lo };
  }

  // 拐头: 最新一根MA7的方向(上拐/下拐) + 幅度
  _turn(ma) {
    if (ma.length < 2) return { dir: 0, d: 0, prevD: 0, prevPrevD: 0 };
    const last = ma[ma.length-1], prev = ma[ma.length-2], pp = ma[ma.length-3];
    const d1 = (last - prev)/ (prev||1);       // 最近变化率
    const d2 = (pp ? (prev - pp)/(pp||1) : 0); // 前段
    return { dir: d1>0?1:(d1<0?-1:0), d1, d2 };
  }

  // ═══ 跟随大盘方向判定: 用多周期均线排列(MA5/MA20/MA60)判断该币当前趋势方向 ═══
  // 多头排列(MA5>MA20>MA60)=UP上涨; 空头排列(MA5<MA20<MA60)=DOWN下跌; 缠绕=FLAT横盘(不交易)
  marketDirection(closes) {
    if (!closes || closes.length < 60) return 'FLAT';
    const ma5=this._sma(closes,5), ma20=this._sma(closes,20), ma60=this._sma(closes,60);
    if (ma5==null||ma20==null||ma60==null) return 'FLAT';
    const bull = ma5>ma20 && ma20>ma60;   // 多头排列=上涨
    const bear = ma5<ma20 && ma20<ma60;   // 空头排列=下跌
    if (bull) return 'UP';
    if (bear) return 'DOWN';
    return 'FLAT';  // 缠绕=横盘, 不交易
  }
  _sma(v,p){ if(v.length<p)return null; return v.slice(-p).reduce((a,b)=>a+b,0)/p; }

  // ═══ 入场: 低买(MA7低位拐上) / 高卖(MA7高位拐下) ═══
  entrySignal(klines, marketDir) {
    const arr = toArray(klines);
    const closes = arr.map(k=>+k[3]);
    if (closes.length < this.lookback) return { signal:'NONE', reason:'数据不足' };
    // 插针过滤(单K±3%不作数)
    const pc = closes.length>1?closes[closes.length-2]:0, price=closes[closes.length-1];
    if (pc>0 && Math.abs(price-pc)/pc*100>3) return { signal:'NONE', reason:'插针跳过' };
    const posInfo = this._posRatio(closes);
    if (!posInfo) return { signal:'NONE', reason:'MA7不足' };
    const ma = this._genMA7(closes);
    const turn = this._turn(ma);
    const { pos, curMA } = posInfo;
    const turnAbs = this.turnAbs;
    // ═══ 跟随大盘方向过滤: 只顺势开仓, 不逆势 ═══
    const dir = this.marketDirection(closes);   // 该币多空排列方向
    // 做多需在UP/FLAT(至少非DOWN下跌趋势); 若明确DOWN趋势→禁做多(不抄底)
    if (dir === 'DOWN' && pos < this.lowCut) return { signal:'NONE', reason:`下跌趋势禁抄底做多(方向${dir})` };
    // 做空需在DOWN/FLAT; 若明确UP趋势→禁做空
    if (dir === 'UP' && pos > this.highCut) return { signal:'NONE', reason:`上涨趋势禁追空(方向${dir})` };

    // 做多·低买: 低位区 + 拐头向上 + 不逆势(非DOWN趋势)
    if (pos < this.lowCut && turn.dir === 1 && turn.d1 > turnAbs && turn.d2 < turnAbs && dir !== 'DOWN') {
      return { signal:'LONG', reason:`低买(MA7位${(pos*100).toFixed(0)}%底区,拐头向上)`, price };
    }
    // 做空·高卖: MA7在高位区(>highCut, 涨不上去了) + 最新拐头向下(突然反转)
    if (pos > this.highCut && turn.dir === -1 && turn.d1 < -turnAbs && turn.d2 > -turnAbs && dir !== 'UP') {
      return { signal:'SHORT', reason:`高卖(MA7位${(pos*100).toFixed(0)}%顶区,拐头向下)`, price };
    }
    return { signal:'NONE', reason:`位${(pos*100).toFixed(0)}% 拐=${turn.dir>=0?'上':'下'}(${pos<this.lowCut?'近底':(pos>this.highCut?'近顶':'中')})` };
  }

  // ═══ 止盈: 必须到最高/最低才平(绝不被震荡震出) ═══
  // 做多: 涨到最高点(MA7高位区) + MA7拐头向下 → 平(中途震荡不平)
  // 做空: 跌到最低点(MA7低位区) + MA7拐头向上 → 平
  takeProfit(pos, price, closes) {
    if (!closes || closes.length < 40) return { action:'HOLD' };
    const posInfo = this._posRatio(closes);
    if (!posInfo) return { action:'HOLD' };
    const ma = this._genMA7(closes);
    const turn = this._turn(ma);
    const { pos: posRatio } = posInfo;
    const turnAbs = this.turnAbs;

    const entry = pos.entryPrice || price || 0;
    const pnlPct = pos.side === 'LONG' ? (price - entry)/entry*100 : (entry - price)/entry*100;

    // 追踪持仓期间MA7极值: 做多记录曾到的最低位(_maLow), 做空记录曾到的最高位(_maHigh)
    if (pos.side === 'LONG') {
      pos._maLow = (pos._maLow==null || posRatio<pos._maLow) ? posRatio : pos._maLow;
    } else {
      pos._maHigh = (pos._maHigh==null || posRatio>pos._maHigh) ? posRatio : pos._maHigh;
    }

    if (pos.side === 'LONG') {
      // 平多: 从底位起(_maLow<0.35) + 到顶位(>0.72) + 拐头下 + 实际盈利
      if (pos._maLow != null && pos._maLow < 0.35 && posRatio > 0.72 && turn.dir === -1 && turn.d1 < -turnAbs && pnlPct > 0) {
        return { action:'CLOSE', reason:`到顶止盈(从底${(pos._maLow*100).toFixed(0)}%升到顶${(posRatio*100).toFixed(0)}%+拐头下+实盈${pnlPct.toFixed(1)}%,吃满上涨)` };
      }
    } else if (pos.side === 'SHORT') {
      // 平空: 从高位起(_maHigh>0.65) + 到底位(<0.28) + 拐头上 + 实际盈利
      if (pos._maHigh != null && pos._maHigh > 0.65 && posRatio < 0.28 && turn.dir === 1 && turn.d1 > turnAbs && pnlPct > 0) {
        return { action:'CLOSE', reason:`到底止盈(从顶${(pos._maHigh*100).toFixed(0)}%跌到底${(posRatio*100).toFixed(0)}%+拐头上+实盈${pnlPct.toFixed(1)}%,吃满下跌)` };
      }
    }
    return { action:'HOLD' };
  }

  // 硬止损兜底(极端保护, 正常由止盈逻辑管理)
  stopLoss(pos, price, closes) {
    const e = pos.entryPrice || price;
    const lossPct = pos.side==='LONG'?(e-price)/e*100:(price-e)/e*100;
    if (lossPct >= this.stopLossPct) return { action:'CLOSE', reason:`硬止损(${lossPct.toFixed(1)}%≥${this.stopLossPct}%)` };
    return { action:'HOLD' };
  }
  trailingStop(pos, price, closes) { return this.takeProfit(pos, price, closes); }

  positionSize(balance, side='LONG', nRatio=0.15) {
    const lev = side==='LONG'?5:3;
    return { notional:Math.max(20, balance*nRatio*lev), margin:Math.max(20, balance*nRatio*lev)/lev, leverage:lev };
  }
}

module.exports = { TrendStrategy };
