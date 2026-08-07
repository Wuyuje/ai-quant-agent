// 大道至简趋势引擎回测 — 同时测上涨+下跌趋势币
const https=require('https');
const { TrendStrategy } = require('./trend-strategy');
const { toArray } = require('./featurer');
const COINS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','BCHUSDT','TIAUSDT','INJUSDT','WIFUSDT','TURBOUSDT','SEIUSDT','SUIUSDT','APTUSDT','AAVEUSDT','HFTUSDT','BICOUSDT','PTBUSDT','1000PEPEUSDT','FILUSDT','DOTUSDT','ARBUSDT'];
const TFEE=0.0005, LONG_LEV=5, SHORT_LEV=3, POS_RATIO=0.15, SVMULT=0.70;
async function getK(sym,interval,count){
  const out=[]; const itMs={ '15m':900000,'1h':3600000,'4h':14400000 }[interval]||3600000;
  let start=Date.now()-count*itMs;
  while(out.length<count){
    const kl=await new Promise(res=>{const ch=[];https.get('https://fapi.binance.com/fapi/v1/klines?symbol='+sym+'&interval='+interval+'&limit=1500&startTime='+start,r=>{r.on('data',d=>ch.push(d));r.on('end',()=>{try{const j=JSON.parse(Buffer.concat(ch).toString());res(Array.isArray(j)?j.map(k=>({open:+k[1],high:+k[2],low:+k[3],close:+k[4],volume:+k[5],openTime:k[0]})):null);}catch(e){res(null);}});}).on('error',()=>res(null));});
    if(!Array.isArray(kl)||!kl.length)break; out.push(...kl); start=kl[kl.length-1].openTime+itMs; if(kl.length<1500)break;
  }
  return out;
}
function runTrend(kl){
  const trend=new TrendStrategy();
  const c=toArray(kl).map(k=>+k[3]);
  let pos=null,nT=0,nW=0,bal=0;
  for(let i=80;i<c.length;i++){
    const win=toArray(kl.slice(0,i+1)), price=c[i];
    if(pos){
      const lev=pos.side==='LONG'?LONG_LEV:SHORT_LEV;
      const tp=trend.takeProfit(pos,price,toArray(win).map(k=>+k[3])); let cr=null;
      if(tp.action==='CLOSE')cr=tp.reason;
      else{const sl=trend.stopLoss(pos,price,toArray(win).map(k=>+k[3]));if(sl.action==='CLOSE')cr=sl.reason;}
      if(cr){const raw=pos.side==='LONG'?(price-pos.entryPrice)/pos.entryPrice*100:(pos.entryPrice-price)/pos.entryPrice*100;let cp=raw*lev*POS_RATIO*0.5-TFEE*200*POS_RATIO;if(cp>0)cp*=SVMULT;bal+=cp;nT++;if(cp>0)nW++;pos=null;}
    } else {
      const dir=trend.marketDirection(toArray(win).map(k=>+k[3]));
      const sig=trend.entrySignal(win,dir);
      if(sig.signal==='LONG'||sig.signal==='SHORT')pos={side:sig.signal,entryPrice:price,_peak:price};
    }
  }
  return {nT,nW,rate:nT?Math.round(nW/nT*100):0,ret:+bal.toFixed(1)};
}
async function main(){
  console.log('═══ 大道至简趋势引擎 · 90天 1h (多5x/空3x·含费+算力费) ═══');
  console.log('| 币种|90天涨跌%|交易|胜率%|净回报%| 方向特征 |');
  const rows=[];
  for(const sym of COINS){
    const kl=await getK(sym,'1h',1500);
    if(!Array.isArray(kl)||kl.length<300)continue;
    const c=toArray(kl).map(k=>+k[3]); const chg=(c[c.length-1]-c[0])/c[0]*100;
    const r=runTrend(kl);
    const dirLbl=chg>10?'涨':chg<-10?'跌':'震荡';
    rows.push({sym:sym.replace('USDT',''),chg:+chg.toFixed(1),dirLbl,...r});
  }
  rows.sort((a,b)=>b.ret-a.ret);
  for(const r of rows)console.log(`|${r.sym}|${r.chg>=0?'+':''}${r.chg}|${r.nT}|${r.rate}|+${r.ret}| ${r.dirLbl}|`);
  const posN=rows.filter(r=>r.ret>0).length;
  const upPos=rows.filter(r=>r.dirLbl==='涨'&&r.ret>0).length;
  const dnPos=rows.filter(r=>r.dirLbl==='跌'&&r.ret>0).length;
  const avg=rows.length?rows.reduce((s,r)=>s+r.ret,0)/rows.length:0;
  const wr=rows.length?Math.round(rows.reduce((s,r)=>s+r.rate,0)/rows.length):0;
  console.log(`\n→ ${rows.length}币 正期望${posN}(涨币中${upPos}涨正, 跌币中${dnPos}跌正) | 均回报+${avg.toFixed(1)}% 均胜率${wr}%`);
}
main().catch(e=>{console.error('ERR',e.message);process.exit(1);});
