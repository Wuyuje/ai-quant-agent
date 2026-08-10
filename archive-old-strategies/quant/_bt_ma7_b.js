const https=require('https');
const { TrendStrategy } = require('./trend-strategy');
const { toArray } = require('./featurer');
const KEYS=['AVAX','KAS','TIA','ADA','BTC','ETH','OP','SUI','LINK','DOGE'];
const TFEE=0.0005, LONG=5, SHORT=3, PR=0.15, SVM=0.70;
async function getK(sym,count){const out=[];const it=300000;let st=Date.now()-count*it;while(out.length<count){const kl=await new Promise(r=>{const ch=[];https.get('https://fapi.binance.com/fapi/v1/klines?symbol='+sym+'USDT&interval=5m&limit=1500&startTime='+st,x=>{x.on('data',d=>ch.push(d));x.on('end',()=>{try{const j=JSON.parse(Buffer.concat(ch).toString());r(Array.isArray(j)?j.map(k=>({open:+k[1],high:+k[2],low:+k[3],close:+k[4],volume:+k[5],openTime:k[0]})):null);}catch(e){r(null);}});}).on('error',()=>r(null));});if(!kl||!kl.length)break;out.push(...kl);st=kl[kl.length-1].openTime+it;if(kl.length<1500)break;}return out;}
function run(kl,cfg){
  const t=new TrendStrategy(); if(cfg.low)t.lowCut=cfg.low; if(cfg.high)t.highCut=cfg.high;
  const c=toArray(kl).map(k=>+k[3]);
  let pos=null,b=0,n=0,w=0;
  for(let i=300;i<c.length;i++){
    const win=toArray(kl.slice(0,i+1)),price=c[i],cl=toArray(win).map(k=>+k[3]);
    if(pos){
      const lev=pos.side==='LONG'?LONG:SHORT;
      const tp=t.takeProfit(pos,price,cl); let cr=null;
      if(tp.action==='CLOSE')cr='tp';
      else{const s2=t.stopLoss(pos,price,cl);if(s2.action==='CLOSE')cr='sl';}
      if(cr){const raw=pos.side==='LONG'?(price-pos.entryPrice)/pos.entryPrice*100:(pos.entryPrice-price)/pos.entryPrice*100;let cp=raw*lev*PR-TFEE*200*PR;if(cp>0)cp*=SVM;b+=cp;n++;if(cp>0)w++;pos=null;}
    } else { const sig=t.entrySignal(win,'FLAT'); if(sig.signal==='LONG'||sig.signal==='SHORT')pos={side:sig.signal,entryPrice:price}; }
  }
  return {ret:+b.toFixed(1),rate:n?Math.round(w/n*100):0,n:n};
}
async function main(){
  console.log('=== 放宽前后对比(30天·5min·含费+算力费30%) ===');
  for(const [label,cfg] of [['原版(0.30/0.70)',{}],['放宽(0.45/0.55)',{low:0.45,high:0.55}]]){
    let s=0,posN=0,tot=0,tr=0;
    for(const sy of KEYS){const kl=await getK(sy,8640);if(!kl||kl.length<400)continue;const r=run(kl,cfg);s+=r.ret;tot++;if(r.ret>0)posN++;tr+=r.n;}
    console.log('  '+label+': 均回报+'+(s/tot).toFixed(1)+'% | 正期望'+posN+'/'+tot+' | 总交易'+tr);
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
