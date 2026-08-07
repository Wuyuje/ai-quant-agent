const https=require('https');
// 与引擎一致的16币高波动池
const POOL=['HFTUSDT','VICUSDT','BICOUSDT','BLESSUSDT','1000RATSUSDT','COTIUSDT','PTBUSDT','1000PEPEUSDT','1000BONKUSDT','TURBOUSDT','NEIROUSDT','SPELLUSDT','FLOKIUSDT','PENGUUSDT','KOMAUSDT','SKYAIUSDT'];
const N=20, T=0.5, FEE=0.001, LEV=3, ITER=1440;
function getK(s,it,li){return new Promise(res=>{req('https://fapi.binance.com/fapi/v1/klines?symbol='+s+'&interval='+it+'&limit='+li,res);});}
function req(url,cb){const chunks=[];https.get(url,r=>{r.on('data',d=>chunks.push(d));r.on('end',()=>{try{cb(JSON.parse(Buffer.concat(chunks).toString()));}catch(e){cb(null);}});}).on('error',()=>cb(null));}
function computeBB(cl){let mid=0,sd=0;const c=cl.slice(-N);mid=c.reduce((a,b)=>a+b,0)/N;sd=Math.sqrt(c.reduce((a,b)=>a+(b-mid)*(b-mid),0)/N)||1e-9;const cur=cl[cl.length-1],prev=cl[cl.length-2];return{bb:(cur-mid)/sd,prevBB:(prev-mid)/sd};}
(async()=>{
  let sumR=0,totTrades=0,winT=0,losT=0;
  const rows=[];
  for(const coin of POOL){
    const kl=await getK(coin,'1m',ITER); if(!Array.isArray(kl)){console.log('⚠️'+coin+' 非数组:',JSON.stringify(kl).slice(0,60));continue;} if(kl.length<N+10){continue;}
    const close=kl.map(k=>+k[4]);
    let pos=null,returns=0,win=0,los=0;
    for(let i=N*2;i<close.length;i++){
      const seg=close.slice(0,i+1);
      const b=computeBB(seg);
      if(!pos && b.bb<-T){pos={side:'L',open:close[i]};}
      else if(!pos && b.bb>T){pos={side:'S',open:close[i]};}
      else if(pos && pos.side==='L' && b.bb>T){const pnl=(close[i]-pos.open)/pos.open*LEV*100-FEE*100*2;returns+=pnl;pnl>0?win++:los++;pos=null;}
      else if(pos && pos.side==='S' && b.bb<-T){const pnl=(pos.open-close[i])/pos.open*LEV*100-FEE*100*2;returns+=pnl;pnl>0?win++:los++;
;pos=null;}
    }
    if(returns!==0||win||los){
      rows.push({coin,returns:+returns.toFixed(1),trades:win+los,win,los,rate:win+los?Math.round(win/(win+los)*100):0});
      sumR+=returns;totTrades+=win+los;winT+=win;losT+=los;
    }
  }
  rows.sort((a,b)=>b.returns-a.returns);
  let md='币|交易|胜率%|净回报%|盈亏\n';
  for(const r of rows) md+=r.coin.replace('USDT','')+'|'+r.trades+'|'+r.rate+'|+'+r.returns+'|('+r.win+'胜/'+r.los+'负)\n';
  console.log('| 币 | 交易 | 胜率 | 净回报% | (胜/负) |');
  console.log('|----|----|----|----|----|');
  for(const r of rows) console.log('|'+r.coin.replace('USDT','')+'|'+r.trades+'|'+r.rate+'%|+'+r.returns+'|('+r.win+'/'+r.los+')|');
  console.log('\n===== 汇总 =====');
  console.log('总交易 '+totTrades+' 笔 | 总胜率 '+(totTrades?Math.round(winT/totTrades*100):0)+'% ('+winT+'胜/'+losT+'负) | 总净回报 +'+sumR.toFixed(1)+'% | 均笔 +'+(totTrades?(sumR/totTrades).toFixed(2):0)+'%');
  console.log('(N20 T0.5, 3x杠杆, 费0.1%双边, 1440根1分钟≈1天, 引擎当前16币高波动池)');
})();
