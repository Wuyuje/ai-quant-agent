// 震荡池币回测: 布林带策略, 5min(30天) + 1h(3个月)
const https=require('https');
const { BollingerStrategy } = require('./bollinger-strategy');
const { toArray } = require('./featurer');
const POOL=['APT','FIL','STX','TIA','1000PEPE','INJ','LINK','SUI','ARB'];
const TFEE=0.0005, LEV=3, PR=0.15, SVM=0.70;
async function getK(sym,interval,count){
  const ms={ '5m':300000,'1h':3600000 }[interval]||300000;
  const out=[]; let st=Date.now()-count*ms;
  while(out.length<count){
    const kl=await new Promise(r=>{const ch=[];https.get('https://fapi.binance.com/fapi/v1/klines?symbol='+sym+'USDT&interval='+interval+'&limit=1500&startTime='+st,x=>{x.on('data',d=>ch.push(d));x.on('end',()=>{try{const j=JSON.parse(Buffer.concat(ch).toString());r(Array.isArray(j)?j.map(k=>({open:+k[1],high:+k[2],low:+k[3],close:+k[4],volume:+k[5],openTime:k[0]})):null);}catch(e){r(null);}});}).on('error',()=>r(null));});
    if(!Array.isArray(kl)||!kl.length)break; out.push(...kl); st=kl[kl.length-1].openTime+ms; if(kl.length<1500)break;
  }
  return out;
}
function run(kl){
  const b=new BollingerStrategy();
  const c=toArray(kl).map(k=>+k[3]);
  let pos=null,ret=0,n=0,w=0;
  for(let i=60;i<c.length;i++){
    const win=toArray(kl.slice(0,i+1)),price=c[i];
    const prev=c[i-1]; if(prev>0&&Math.abs(price-prev)/prev>0.03){continue;} // 插针
    if(pos){
      const tp=b.checkTakeProfit(pos,win); let cr=null;
      if(tp.action==='CLOSE')cr='tp';
      else{const hs=b.checkHardStop(pos,win,0);if(hs.stop)cr='sl';}
      if(cr){const raw=pos.side==='LONG'?(price-pos.entryPrice)/pos.entryPrice*100:(pos.entryPrice-price)/pos.entryPrice*100;let cp=raw*LEV*PR-TFEE*200*PR;if(cp>0)cp*=SVM;ret+=cp;n++;if(cp>0)w++;pos=null;}
    } else {
      const g=b.canOpen(win);
      if(g.allowed){const es=b.entrySignal(win,'FLAT',false);if(es.signal==='LONG'||es.signal==='SHORT')pos={side:es.signal,entryPrice:price};}
    }
  }
  return {ret:+ret.toFixed(1),rate:n?Math.round(w/n*100):0,n:n};
}
async function main(){
  console.log('=== 震荡池 布林带策略 回测 ===');
  for(const [label,interval,count] of [['5min·30天','5m',8640],['1h·3个月','1h',2160]]){
    console.log('\n--- '+label+' ---');
    let sr=0,posN=0,totT=0;
    for(const sy of POOL){
      const kl=await getK(sy,interval,count);
      if(!kl||kl.length<200){console.log('  '+sy,'数据不足');continue;}
      const r=run(kl);
      const c=toArray(kl).map(k=>+k[3]); const chg=(c[c.length-1]-c[0])/c[0]*100;
      console.log('  '+sy+' 区间'+((chg>=0?'+':'')+chg.toFixed(1))+'% 交易'+r.n+' 胜率'+r.rate+'% 净回报+'+r.ret+'%');
      if(r.n>0){sr+=r.ret;posN++;totT+=r.n;}
    }
    console.log('  汇总: 参与币'+posN+' 均回报+'+(posN?(sr/posN).toFixed(1):0)+'% 总交易'+totT);
  }
}
main().catch(e=>{console.error(e.message);process.exit(1);});
