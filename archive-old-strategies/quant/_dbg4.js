const {BinanceAPI}=require('../lib/common');
const {toArray}=require('./featurer');
const {RangeGridStrategy}=require('./grid-strategy');
const APIKEY=process.env.BINANCE_API_KEY,APISECRET=process.env.BINANCE_API_SECRET;
(async()=>{const api=new BinanceAPI(APIKEY,APISECRET);
const kl=await api.getKlines('ETHUSDT','15m',1500);
const gr=new RangeGridStrategy();
const c=toArray(kl).map(k=>+k[3]);
let pos={side:'LONG',entry:c[150],_peak:c[150],_rng:null};
// 模拟从151开始管理持仓, 打印pnl和gridExit
let lastPrint=0;
for(let i=151;i<c.length;i++){
  const pnl=(c[i]-pos.entry)/pos.entry*100;
  const ge=gr.gridExit(pos,c[i],{}); // rng空
  if(Math.abs(pnl)>=0.7 && i-lastPrint>200){ console.log('@'+i,'价'+c[i].toFixed(0),'pnl%'+pnl.toFixed(2),'gridExit=',ge.action,ge.reason||''); lastPrint=i; }
}
console.log('完成: 最后gridExit测...');
const ge2=gr.gridExit(pos,c[c.length-1],{});
console.log('最后价'+c[c.length-1].toFixed(0),'pnl%'+((c[c.length-1]-pos.entry)/pos.entry*100).toFixed(2),'→',ge2.action);
})();
