const {BinanceAPI}=require('../lib/common');
const {toArray}=require('./featurer');
const {RangeGridStrategy}=require('./grid-strategy');
const APIKEY=process.env.BINANCE_API_KEY,APISECRET=process.env.BINANCE_API_SECRET;
const TFEE=0.0005, LEV=5;
function btGrid(kl){
  const gr=new RangeGridStrategy(); const c=toArray(kl).map(k=>+k[3]);
  let nT=0,nW=0,open=0,close=0,pos=null;
  for(let i=150;i<c.length;i++){
    const win=toArray(kl.slice(0,i+1)); const price=c[i];
    if(pos){ const ge=gr.gridExit(pos,price,pos._rng);
      if(ge.action==='CLOSE'){ const raw=pos.side==='LONG'?(price-pos.entry)/pos.entry*100:(pos.entry-price)/pos.entry*100;const p=raw*LEV-TFEE*200;nT++;p>0?nW++:0;close++;pos=null; } }
    else { const sig=gr.generateSignal(win);
      if(sig.signal!=='NONE'&&sig.side){pos={side:sig.side,entry:price,_peak:price,_rng:gr.computeRange(win)};open++;} }
  }
  return {open,close,nT,nW};
}
(async()=>{const api=new BinanceAPI(APIKEY,APISECRET);
for(const sym of ['ETHUSDT','SOLUSDT','BTCUSDT','TURBOUSDT']){
  const kl=await api.getKlines(sym,'15m',1500).catch(()=>null);
  if(!kl)continue;
  const g=btGrid(kl);
  console.log(sym,'开仓尝试',g.open,'完成交易',g.close,'胜',g.nW);
}
})();
