const {BinanceAPI}=require('../lib/common');
const {toArray}=require('./featurer');
const APIKEY=process.env.BINANCE_API_KEY,APISECRET=process.env.BINANCE_API_SECRET;
(async()=>{const api=new BinanceAPI(APIKEY,APISECRET);
const kl=await api.getKlines('ETHUSDT','15m',1500);
const c=toArray(kl).map(k=>+k[3]);
const win15=c.slice(150); // 持仓窗口
const mn=Math.min(...win15),mx=Math.max(...win15);
const entry=c[150];
console.log('开仓价',entry);
console.log('持仓窗口[150..] 最低',mn,'最高',mx);
console.log('从entry 最大涨%',((mx-entry)/entry*100).toFixed(2),'最大跌%',((entry-mn)/entry*100).toFixed(2));
})();
