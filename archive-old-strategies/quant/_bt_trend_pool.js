// 纯趋势策略充足回测(选趋势币池) — 更长窗口+更多信号
const { BinanceAPI } = require('../lib/common');
const { FeatureEngineer, toArray } = require('./featurer');
const { TrendFollowingStrategy } = require('./trend-strategy');
const APIKEY=process.env.BINANCE_API_KEY,APISECRET=process.env.BINANCE_API_SECRET;
const COINS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','BCHUSDT','DOTUSDT','NEARUSDT','TIAUSDT','SUIUSDT','APTUSDT','OPUSDT','ARBUSDT','SEIUSDT','INJUSDT','WIFUSDT','TURBOUSDT','1000PEPEUSDT','PENDLEUSDT','STXUSDT','KASUSDT','LTCUSDT','AAVEUSDT','TONUSDT','FILUSDT','ALGOUSDT'];
const TFEE=0.0005, LEV=5;
function btTrend(kl){
  const tr=new TrendFollowingStrategy(); const fe=new FeatureEngineer();
  const c=toArray(kl).map(k=>+k[3]);
  let bal=0,nT=0,nW=0,pos=null;
  for(let i=80;i<c.length;i++){
    const win=toArray(kl.slice(0,i+1)); const price=c[i];
    const emaS=fe.ema(win,7),emaL=fe.ema(win,25);
    const dir=emaS>emaL?'UP':(emaS<emaL?'DOWN':'FLAT');
    if(pos){
      const atr=fe.calcATR(win);
      const ts=tr.trailingStop(pos,price); let cr=null;
      if(ts.action==='CLOSE')cr=ts.reason; else {const sl=tr.stopLoss(pos,price,atr); if(sl.action==='CLOSE')cr=sl.reason;}
      if(cr){const raw=pos.side==='LONG'?(price-pos.entry)/pos.entry*100:(pos.entry-price)/pos.entry*100;const p=raw*LEV-TFEE*200;bal+=p;nT++;if(p>0)nW++;pos=null;}
    } else {
      const sig=tr.entrySignal(win,dir);
      if(sig.signal==='LONG'||sig.signal==='SHORT')pos={side:sig.signal,entry:price,_peak:price};
    }
  }
  return {nT,nW,rate:nT?Math.round(nW/nT*100):0,ret:+bal.toFixed(1)};
}
async function main(){
  const api=new BinanceAPI(APIKEY,APISECRET); const rows=[];
  for(const sym of COINS){
    const kl=await api.getKlines(sym,'1h',500).catch(()=>null);
    if(!Array.isArray(kl)||kl.length<400)continue;
    rows.push({sym:sym.replace('USDT',''),...btTrend(kl)});
  }
  rows.sort((a,b)=>b.ret-a.ret);
  console.log('=== 纯趋势策略回测 (1h·EMA+ADX+移动止损·5x·费0.1%·~500根≈20天) ===');
  console.log('| 币种|交易|胜率%|净回报%|');
  for(const r of rows)console.log(`|${r.sym}|${r.nT}|${r.rate}|+${r.ret}|`);
  const pos=rows.filter(r=>r.ret>0);
  console.log(`\n正期望(适合趋势): ${pos.map(r=>r.sym+'(+'+r.ret+'%)').join(' ')}`);
}
main();
