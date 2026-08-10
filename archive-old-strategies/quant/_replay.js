// 复盘: 逐笔分析典型币交易, 找出亏损根因
const { BinanceAPI } = require('../lib/common');
const { FeatureEngineer, toArray } = require('./featurer');
const { MarketClassifier } = require('./market-classifier');
const { TrendFollowingStrategy } = require('./trend-strategy');
const { RangeGridStrategy } = require('./grid-strategy');
const APIKEY=process.env.BINANCE_API_KEY,APISECRET=process.env.BINANCE_API_SECRET;
const TFEE=0.0005, LEV=5, POS_RATIO=0.15, SVMULT=0.70;
function replay(kl){
  const cls=new MarketClassifier(), trend=new TrendFollowingStrategy(), grid=new RangeGridStrategy(), fe=new FeatureEngineer();
  const arr=toArray(kl); const c=arr.map(k=>+k[3]);
  const trades=[]; let pos=null;
  for(let i=150;i<c.length;i++){
    const win=toArray(kl.slice(0,i+1)); const price=c[i];
    if(pos){
      let cr=null;
      if(pos.strategy==='grid'){const ge=grid.gridExit(pos,price,pos._rng);if(ge.action==='CLOSE')cr=ge.reason;}
      else if(pos.strategy==='trend'){const ts=trend.trailingStop(pos,price,'UP');if(ts.action==='CLOSE'||ts.action==='REVERSE')cr=ts.reason;else{const atr=fe.calcATR(win);const sl=trend.stopLoss(pos,price,atr);if(sl.action==='CLOSE')cr=sl.reason;}}
      if(cr){
        const raw=pos.side==='LONG'?(price-pos.entry)/pos.entry*100:(pos.entry-price)/pos.entry*100;
        let tp=raw*LEV*POS_RATIO-TFEE*200*POS_RATIO; if(tp>0)tp*=SVMULT;
        trades.push({t:i,side:pos.side,strat:pos.strategy,raw:+raw.toFixed(2),pnl:+tp.toFixed(2),reason:cr});
        pos=null;
      }
    } else {
      const j=cls.judgeMarketState(win,0); const strat=cls.recommendedStrategy(j);
      if(strat==='grid'){const sig=grid.generateSignal(win);if(sig.signal!=='NONE'&&sig.side)pos={side:sig.side,strategy:'grid',entry:price,_peak:price,_rng:null};}
      else if(strat==='trend'){const sig=trend.entrySignal(win,j.trendDir);if(sig.signal==='LONG'||sig.signal==='SHORT')pos={side:sig.signal,strategy:'trend',entry:price,_peak:price};}
    }
  }
  return trades;
}
async function main(){
  const api=new BinanceAPI(APIKEY,APISECRET);
  for(const sym of ['INJUSDT','NEARUSDT','ETHUSDT','ALGOUSDT']){
    const kl=await api.getKlines(sym,'4h',560).catch(()=>null);
    if(!kl){console.log(sym,'无数据');continue;}
    const tr=replay(kl);
    const wins=tr.filter(t=>t.pnl>0), losses=tr.filter(t=>t.pnl<0);
    const avgW=wins.length?wins.reduce((s,t)=>s+t.pnl,0)/wins.length:0;
    const avgL=losses.length?losses.reduce((s,t)=>s+t.pnl,0)/losses.length:0;
    const avgRawW=wins.length?wins.reduce((s,t)=>s+t.raw,0)/wins.length:0;
    const avgRawL=losses.length?losses.reduce((s,t)=>s+t.raw,0)/losses.length:0;
    const gridT=tr.filter(t=>t.strat==='grid'), trendT=tr.filter(t=>t.strat==='trend');
    console.log(`\n=== ${sym} 复盘 (${tr.length}笔) 胜${wins.length}负${losses.length} ===`);
    console.log(`  均盈利+${avgW.toFixed(2)}% | 均亏损${avgL.toFixed(2)}% | 盈亏比=${(Math.abs(avgW/avgL)).toFixed(2)}`);
    console.log(`  平均胜单raw+${avgRawW.toFixed(1)}% | 平均负单raw${avgRawL.toFixed(1)}%`);
    console.log(`  网格${gridT.length}笔(胜${gridT.filter(t=>t.pnl>0).length}) | 趋势${trendT.length}笔(胜${trendT.filter(t=>t.pnl>0).length})`);
    // 打印亏损最大5笔的原因
    const worst=[...losses].sort((a,b)=>a.pnl-b.pnl).slice(0,4);
    console.log('  最亏: ',worst.map(t=>`${t.side}${t.strat} raw${t.raw}% ${t.reason.slice(0,25)}`).join(' | '));
  }
}
main();
