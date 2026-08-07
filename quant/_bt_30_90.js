// 规格对齐版双策略 30/90天回测 — 含手续费+普通用户算力费30%
const { BinanceAPI } = require('../lib/common');
const { FeatureEngineer, toArray } = require('./featurer');
const { MarketClassifier } = require('./market-classifier');
const { TrendFollowingStrategy } = require('./trend-strategy');
const { RangeGridStrategy } = require('./grid-strategy');
const APIKEY=process.env.BINANCE_API_KEY,APISECRET=process.env.BINANCE_API_SECRET;
const COINS=['ETHUSDT','BCHUSDT','OPUSDT','WIFUSDT','SEIUSDT','FILUSDT','TIAUSDT','BTCUSDT','DOTUSDT','STXUSDT','ALGOUSDT','ARBUSDT','INJUSDT','APTUSDT','TURBOUSDT','SOLUSDT','LINKUSDT','SUIUSDT','AAVEUSDT','NEARUSDT'];
const TFEE=0.0005, LEV=5, POS_RATIO=0.15, SVMULT=0.70; // 规格单品种15%仓位 // 普通用户盈利留70%(扣30%算力费)
// 市场分类→选策略 完整回测
function runStrategy(kl){
  const cls=new MarketClassifier(), trend=new TrendFollowingStrategy(), grid=new RangeGridStrategy(), fe=new FeatureEngineer();
  const arr=toArray(kl); const c=arr.map(k=>+k[3]);
  let pos=null,nT=0,nW=0,bal=0;
  for(let i=150;i<c.length;i++){
    const win=toArray(kl.slice(0,i+1)); const price=c[i];
    // 持仓管理
    if(pos){
      let cr=null;
      if(pos.strategy==='grid'){ const ge=grid.gridExit(pos,price,pos._rng); if(ge.action==='CLOSE')cr=ge.reason; }
      else if(pos.strategy==='trend'){ const ts=trend.trailingStop(pos,price,'UP'); if(ts.action==='CLOSE'||ts.action==='REVERSE')cr=ts.reason; else {const atr=fe.calcATR(win);const sl=trend.stopLoss(pos,price,atr);if(sl.action==='CLOSE')cr=sl.reason;} }
      if(cr){
        const raw=pos.side==='LONG'?(price-pos.entry)/pos.entry*100:(pos.entry-price)/pos.entry*100;
        let tradePnl=raw*LEV*POS_RATIO-TFEE*200*POS_RATIO;          // 扣手续费
        if(tradePnl>0)tradePnl*=SVMULT;          // 普通用户盈利扣30%算力费
        bal+=tradePnl; nT++; if(tradePnl>0)nW++; pos=null;
      }
    } else {
      const j=cls.judgeMarketState(win,0);
      const strat=cls.recommendedStrategy(j);
      if(strat==='grid'){ const sig=grid.generateSignal(win); if(sig.signal!=='NONE'&&sig.side)pos={side:sig.side,strategy:'grid',entry:price,_peak:price,_rng:null}; }
      else if(strat==='trend'){ const sig=trend.entrySignal(win,j.trendDir); if(sig.signal==='LONG'||sig.signal==='SHORT')pos={side:sig.signal,strategy:'trend',entry:price,_peak:price}; }
    }
  }
  return {nT,nW,rate:nT?Math.round(nW/nT*100):0,ret:+bal.toFixed(1)};
}
async function getK(api,s,it,limit){
  const out=[]; const kl=await api.getKlines(s,it,limit).catch(()=>null);
  return kl;
}
async function main(){
  const api=new BinanceAPI(APIKEY,APISECRET);
  for(const days of [30,90]){
    const it=days===30?'1h':'4h'; const limit=days===30?720:560; // 30天1h=720, 90天4h=540
    console.log(`\n═════ ${days}天回测 (${days===30?'1h':''} · 规格双策略·5x·费0.1%+普通用户扣30%算力费) ═════`);
    const rows=[];
    for(const sym of COINS){
      const kl=await getK(api,sym,it,limit);
      if(!Array.isArray(kl)||kl.length<200)continue;
      const r=runStrategy(kl);
      rows.push({sym:sym.replace('USDT',''),...r});
    }
    rows.sort((a,b)=>b.ret-a.ret);
    console.log('| 币种|交易|胜率%|净回报%(含费+算力费)|');
    for(const r of rows)console.log(`|${r.sym}|${r.nT}|${r.rate}|+${r.ret}|`);
    const posN=rows.filter(r=>r.ret>0).length;
    const totRet=rows.reduce((s,r)=>s+r.ret,0);
    const avgWr=rows.length?Math.round(rows.reduce((s,r)=>s+r.rate,0)/rows.length):0;
    console.log(`→ ${days}天: ${rows.length}币 正期望${posN} | 平均净回报+${(totRet/rows.length).toFixed(1)}% | 平均胜率${avgWr}%`);
  }
}
main();
