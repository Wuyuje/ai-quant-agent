// 布林高抛低吸回测(当前引擎参数N20 T0.5) 1分钟级别
const https=require('https');
function getK(s,it,li){return new Promise(res=>{https.get('https://fapi.binance.com/fapi/v1/klines?symbol='+s+'&interval='+it+'&limit='+li,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d).map(k=>parseFloat(k[4])))}catch(e){res(null)}})}).on('error',()=>res(null))})}
const FEE=0.001;
async function run(coin){
  const k=await getK(coin,'1m',1440); // 1天
  if(!k)return {coin,t:0,p:0};
  let pos=null,trades=0,wins=0,sum=0,maxPnL=-999,minPnL=999;
  for(let i=21;i<k.length-1;i++){
    const closes=k.slice(i-20,i+1);
    const mid=closes.reduce((a,b)=>a+b,0)/20;
    const sd=Math.sqrt(closes.reduce((a,v)=>a+(v-mid)*(v-mid),0)/20)||0.00001;
    const bb=(closes[20]-mid)/sd, prevBB=(closes[19]-mid)/sd;
    const price=k[i+1];
    if(pos){
      if(prevBB>=0.5&&bb<0.5){ // 下穿上轨平
        const pnl=(price-pos.open)/pos.open*3*100-FEE*100*2;
        trades++; if(pnl>0)wins++; sum+=pnl; if(pnl>maxPnL)maxPnL=pnl; if(pnl<minPnL)minPnL=pnl; pos=null;
      }
    } else {
      if(prevBB<=-0.5&&bb>-0.5)pos={open:price}; // 上穿下轨买
    }
  }
  return {coin,t:trades,w:trades?(wins/trades*100).toFixed(0):0,p:sum.toFixed(1),mx:maxPnL>0?maxPnL.toFixed(1):'-',mn:minPnL<999?minPnL.toFixed(1):'-'};
}
(async()=>{
  const coins=['BTCUSDT','ETHUSDT','SOLUSDT','DOGEUSDT','SUIUSDT','HFTUSDT','VICUSDT','COTIUSDT','AVAXUSDT','1000RATSUSDT','BICOUSDT','XRPUSDT','LINKUSDT','ADAUSDT','BLESSUSDT','PTBUSDT'];
  let totT=0,totP=0;
  console.log('=== 布林高抛低吸回测(N20 T0.5, 1440根1分钟≈1天, 含费0.1%, 3x) ===');
  for(const c of coins){
    const r=await run(c);
    if(r.t>0){totT+=r.t;totP+=parseFloat(r.p);console.log('  '+r.coin.padEnd(12)+' 交易'+r.t+' 胜率'+r.w+'% 净'+r.p+'% 最大盈'+r.mx+'% 最大亏'+r.mn+'%');}
  }
  console.log('\n总交易'+totT+' 总净回报'+totP.toFixed(1)+'% 均笔'+(totT?(totP/totT).toFixed(2):0)+'%');
})();
