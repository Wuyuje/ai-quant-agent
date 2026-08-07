const https=require('https');
const POOL=['SKYAIUSDT','BLESSUSDT','COTIUSDT','SPELLUSDT','1000RATSUSDT','PTBUSDT','1000PEPEUSDT','TURBOUSDT','NEIROUSDT','PENGUUSDT','1000BONKUSDT','KOMAUSDT','VICUSDT','BICOUSDT','HFTUSDT'];
const N=20,T=0.5,FEE=0.001,LEV=3,ITER=4320;
function getK(s,it,li){return new Promise(res=>{req('https://fapi.binance.com/fapi/v1/klines?symbol='+s+'&interval='+it+'&limit='+li,res);});}
function req(url,cb){const ch=[];https.get(url,r=>{r.on('data',d=>ch.push(d));r.on('end',()=>{try{cb(JSON.parse(Buffer.concat(ch).toString()));}catch(e){cb(null);}});}).on('error',()=>cb(null));}
function bb(cl){const c=cl.slice(-N);const m=c.reduce((a,b)=>a+b,0)/N;const s=Math.sqrt(c.reduce((a,b)=>a+(b-m)*(b-m),0)/N)||1e-9;return{bb:(cl[cl.length-1]-m)/s,prev:(cl[cl.length-2]-m)/s};}
(async()=>{
  const rows=[];
  for(const coin of POOL){
    const kl=await getK(coin,'1m',ITER); if(!Array.isArray(kl)||kl.length<N+100){console.log('⚠️'+coin+' 数据不足');continue;}
    const close=kl.map(k=>+k[4]);
    let pos=null,ret=0,w=0,l=0;
    for(let i=N*2;i<close.length;i++){
      const seg=close.slice(0,i+1);const b=bb(seg);
      if(!pos&&b.bb<-T){pos={s:'L',o:close[i]};}
      else if(!pos&&b.bb>T){pos={s:'S',o:close[i]};}
      else if(pos&&pos.s==='L'&&b.bb>T){const p=(close[i]-pos.o)/pos.o*LEV*100-FEE*100*2;ret+=p;p>0?w++:l++;pos=null;}
      else if(pos&&pos.s==='S'&&b.bb<-T){const p=(pos.o-close[i])/pos.o*LEV*100-FEE*100*2;ret+=p;p>0?w++:l++;pos=null;}
    }
    rows.push({coin:coin.replace('USDT',''),trade:w+l,rate:w+l?Math.round(w/(w+l)*100):0,ret:+ret.toFixed(1)});
  }
  rows.sort((a,b)=>b.ret-a.ret);
  console.log('=== 3天(4320根1分钟≈3天)布林回测, N20 T0.5 3x 费0.1% ===');
  console.log('| 币|交易|胜率|净回报%|');
  for(const r of rows) console.log(`|${r.coin}|${r.trade}|${r.rate}%|+${r.ret}|`);
  const top=rows[0]; const good=rows.filter(r=>r.ret>0);
  console.log('\n正期望:',good.map(g=>g.coin+'('+g.ret+'%)').join(', ')||'无');
  console.log('最推荐3只:', rows.slice(0,3).map(r=>r.coin+' +'+r.ret+'%').join(', '));
})();
