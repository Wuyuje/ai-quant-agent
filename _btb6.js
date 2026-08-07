const https=require('https');
const POOL=['SKYAIUSDT','BLESSUSDT','COTIUSDT','SPELLUSDT','1000RATSUSDT','PTBUSDT','1000PEPEUSDT','TURBOUSDT','NEIROUSDT','PENGUUSDT','1000BONKUSDT','KOMAUSDT','VICUSDT','BICOUSDT','HFTUSDT'];
const N=20,T=0.5,FEE=0.001,LEV=3;
function req(url){return new Promise(res=>{const ch=[];https.get(url,r=>{r.on('data',d=>ch.push(d));r.on('end',()=>{try{res(JSON.parse(Buffer.concat(ch).toString()));}catch(e){res(null);}});}).on('error',()=>res(null));});}
async function getK(s,days){
  const arr=[];
  for(let d=0;d<days;d++){
    const start=Date.parse('2026-08-04T00:00:00Z')+d*86400000+(- (Date.now()-Date.parse('2026-08-07T00:00:00Z'))); // placeholder unused
  }
  // 用最近时间分页: 三次, 每次1440根, 间隔1天
  const end=Date.now();
  for(let d=0;d<days;d++){
    const startTime=end-(days-d)*86400000;
    const u=`https://fapi.binance.com/fapi/v1/klines?symbol=${s}&interval=1m&startTime=${startTime}&limit=1440`;
    const kl=await req(u);
    if(Array.isArray(kl)) arr.push(...kl);
  }
  return arr;
}
function bb(cl){const c=cl.slice(-N);const m=c.reduce((a,b)=>a+b,0)/N;const s=Math.sqrt(c.reduce((a,b)=>a+(b-m)*(b-m),0)/N)||1e-9;return{bb:(cl[cl.length-1]-m)/s,prev:(cl[cl.length-2]-m)/s};}
(async()=>{
  const rows=[];
  for(const coin of POOL){
    const kl=await getK(coin,3);
    if(!Array.isArray(kl)||kl.length<200){console.log('⚠️'+coin+' 数据不足 '+ (Array.isArray(kl)?kl.length:'非数组'));continue;}
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
  console.log('=== 3天布林回测 N20 T0.5 3x 费0.1% ===');
  console.log('| 币|交易|胜率|净回报%|');
  for(const r of rows) console.log(`|${r.coin}|${r.trade}|${r.rate}%|+${r.ret}|`);
  console.log('\n推荐3只:', rows.slice(0,3).map(r=>r.coin+' +'+r.ret+'%').join(', '));
})();
