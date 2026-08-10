const {BinanceAPI}=require('../lib/common');
const {toArray}=require('./featurer');
const {TrendFollowingStrategy}=require('./trend-strategy');
const APIKEY=process.env.BINANCE_API_KEY,APISECRET=process.env.BINANCE_API_SECRET;
(async()=>{const api=new BinanceAPI(APIKEY,APISECRET);
for(const sym of ['SOLUSDT','BTCUSDT','BCHUSDT']){
  const kl=await api.getKlines(sym,'15m',200).catch(()=>null);
  if(!kl){console.log(sym,'无数据');continue;}
  const tr=new TrendFollowingStrategy();
  const sig=tr.entrySignal(kl.slice(-120),'UP');
  console.log(sym,'entrySignal(假设UP)=',JSON.stringify(sig));
}
})();
