// 大道至简 v4 — 3x保守杠杆回测, 2500根15m(≈26天)更充足样本
const https=require('https');
const FEE=0.0005, LEV=3, LOOK=500, ITER=2500;
function getKPage(s,it,li,st){return new Promise(res=>{const ch=[];https.get('https://fapi.binance.com/fapi/v1/klines?symbol='+s+'&interval='+it+'&limit='+li+'&startTime='+st,r=>{r.on('data',d=>ch.push(d));r.on('end',()=>{try{res(JSON.parse(Buffer.concat(ch).toString()));}catch(e){res(null);}});}).on('error',()=>res(null));});}
async function getK(s,it,li){ // 分页拉li根
  const arr=[];const end=Date.now();
  let start=end-li*900000; // 15m每根900000ms
  while(arr.length<li){
    const page=await getKPage(s,it,1500,start);
    if(!Array.isArray(page)||!page.length)break;
    arr.push(...page);
    start=page[page.length-1][6]+900000;
  }
  return arr;
}
function cal(c){const ma=[];for(let i=0;i+7<=c.length;i++)ma.push(c.slice(i,i+7).reduce((a,b)=>a+b,0)/7);return ma;}
function pr(ma,nm){const look=Math.min(LOOK,nm);const h=ma.slice(-look);const mx=Math.max(...h),mn=Math.min(...h);const r=mx-mn;return r>0?(ma[nm-1]-mn)/r:0.5;}
async function bt(coin){
  const kl=await getK(coin,'15m',ITER);if(!Array.isArray(kl)||kl.length<600)return null;
  const c=kl.map(k=>+k[4]);const ma=cal(c);
  let pos=null,nT=0,nW=0,nL=0,ret=0;
  const oL=0.44,oH=0.56,tH=0.72,tL=0.28,tr=0.008;
  for(let i=600;i<ma.length;i++){
    const ratio=pr(ma,i);const range=(Math.max(...ma.slice(-LOOK))-Math.min(...ma.slice(-LOOK)));
    if(range<=0)continue;const turn=range*tr;const d1=ma[i]-ma[i-1],d2=ma[i-1]-ma[i-2],d3=ma[i-2]-ma[i-3];const p=c[i];
    if(!pos){
      const bu=d1>0&&d1>turn;const noA=!(d3<-turn&&d2<-turn&&d1>0);const be=d1<0&&d1<-turn;
      if(ratio<oL&&bu&&noA)pos={s:'L',o:p};else if(ratio>oH&&be)pos={s:'S',o:p};
    }else if(pos.s==='L'){ if(ratio>tH&&d1<-turn){const pn=(p-pos.o)/pos.o*LEV*100-FEE*100*2;ret+=pn;pn>0?nW++:nL++;nT++;pos=null;} }
    else { if(ratio<tL&&d1>turn){const pn=(pos.o-p)/pos.o*LEV*100-FEE*100*2;ret+=pn;pn>0?nW++:nL++;nT++;pos=null;} }
  }
  if(pos){const p=c[c.length-1];const pn=(pos.s==='L'?(p-pos.o):(pos.o-p))/pos.o*LEV*100-FEE*100*2;ret+=pn;pn>0?nW++:nL++;nT++;}
  return {coin:coin.replace('USDT',''),nT,nW,nL,rate:nT?Math.round(nW/nT*100):0,ret:+ret.toFixed(1)};
}
(async()=>{
  const ALL=['HFTUSDT','VICUSDT','BICOUSDT','BLESSUSDT','PTBUSDT','EPICUSDT','ADAUSDT','DOTUSDT','ARBUSDT','NEARUSDT','LINKUSDT','SOLUSDT','BTCUSDT','ETHUSDT','SUIUSDT','WIFUSDT','1000PEPEUSDT','TURBOUSDT','SEIUSDT','KASUSDT','OPUSDT','TIAUSDT','PENDLEUSDT','INJUSDT'];
  const rows=[];for(const coin of ALL){const r=await bt(coin);if(r)rows.push(r);}
  rows.sort((a,b)=>b.ret-a.ret);
  console.log('=== 大道至简 v4 3x保守回测 (15m 500根, MA7反转, 3x, 费0.1%双边, 2500根15m≈26天) ===');
  console.log('| 币|交易|胜率|净回报%|(胜/负)|');
  for(const r of rows)console.log(`|${r.coin}|${r.nT}|${r.rate}%|+${r.ret}|(${r.nW}/${r.nL})|`);
  const pos=rows.filter(r=>r.ret>0);const totT=rows.reduce((s,r)=>s+r.nT,0);const totR=rows.reduce((s,r)=>s+r.ret,0);
  console.log('\n汇总: 币'+rows.length,'正期望'+pos.length,'总交易'+totT,'总回报+'+totR.toFixed(1)+'%','均币+'+(totR/rows.length).toFixed(1)+'%');
})();
