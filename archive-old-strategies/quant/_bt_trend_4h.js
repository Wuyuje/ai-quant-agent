// 趋势引擎(MA策略)专项回测 — 4h波段周期(规格三: 波段中线用4h/日线 MA20+MA60)
const https=require('https');
const { TrendStrategy } = require('./trend-strategy');
const { toArray } = require('./featurer');
const COINS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','ARBUSDT','AVAXUSDT','DOTUSDT','APTUSDT','LINKUSDT','BCHUSDT','NEARUSDT','SUIUSDT','OPUSDT','INJUSDT','TURBOUSDT','SEIUSDT','FILUSDT','ADAUSDT','BNBUSDT','LTCUSDT'];
const TFEE=0.0005, LEV=5, POS_RATIO=0.15, SVMULT=0.70;
async function getK(sym, interval, count){
  const out=[]; const itMs={ '15m':900000,'1h':3600000,'4h':14400000 }[interval]||14400000;
  let start=Date.now()-count*itMs;
  while(out.length<count){
    const kl=await new Promise(res=>{const ch=[];https.get('https://fapi.binance.com/fapi/v1/klines?symbol='+sym+'&interval='+interval+'&limit=1500&startTime='+start,r=>{r.on('data',d=>ch.push(d));r.on('end',()=>{try{const j=JSON.parse(Buffer.concat(ch).toString());res(Array.isArray(j)?j.map(k=>({time:k[0],open:k[1],high:k[2],low:k[3],close:+k[4],volume:k[5],openTime:k[0]})):null);}catch(e){res(null);}});}).on('error',()=>res(null));});
    if(!Array.isArray(kl)||!kl.length)break; out.push(...kl); start=kl[kl.length-1].openTime+itMs;
    if(kl.length<1500)break;
  }
  return out;
}
function runTrend(kl){
  const trend=new TrendStrategy();
  const c=toArray(kl).map(k=>+k[3]);
  let pos=null,nT=0,nW=0,bal=0;
  for(let i=150;i<c.length;i++){
    const win=toArray(kl.slice(0,i+1)), price=c[i];
    if(pos){
      const ts=trend.trailingStop(pos,price);
      let cr=null;
      if(ts.action==='CLOSE')cr=ts.reason;
      else{const sl=trend.stopLoss(pos,price,toArray(win).map(k=>+k[3]));if(sl.action==='CLOSE')cr=sl.reason;}
      if(cr){const raw=pos.side==='LONG'?(price-pos.entryPrice)/pos.entryPrice*100:(pos.entryPrice-price)/pos.entryPrice*100;let tp=raw*LEV*POS_RATIO-TFEE*200*POS_RATIO;if(tp>0)tp*=SVMULT;bal+=tp;nT++;if(tp>0)nW++;pos=null;}
    } else {
      const dir=trend.marketDirection(toArray(win).map(k=>+k[3]));
      const sig=trend.entrySignal(win,dir);
      if(sig.signal==='LONG'||sig.signal==='SHORT')pos={side:sig.signal,entryPrice:price,_peak:price};
    }
  }
  return {nT,nW,rate:nT?Math.round(nW/nT*100):0,ret:+bal.toFixed(1),avg:nT?(bal/nT).toFixed(2):0};
}
async function main(){
  const rows=[];
  for(const sym of COINS){
    const kl=await getK(sym,'4h',540); // 4h*540=90天
    if(!Array.isArray(kl)||kl.length<200)continue;
    const r=runTrend(kl);
    if(r.nT>0||['BTCUSDT','ETHUSDT','SOLUSDT'].includes(sym))rows.push({sym:sym.replace('USDT',''),...r});
  }
  rows.sort((a,b)=>b.ret-a.ret);
  console.log('=== 趋势引擎(MA策略)·4h波段回测 (含费0.1%+普通用户算力费30%·5x·~540根≈90天) ===');
  console.log('| 币种|交易|胜率%|净回报%|均笔%|');
  for(const r of rows)console.log(`|${r.sym}|${r.nT}|${r.rate}|+${r.ret}|${r.avg}|`);
  const pos=rows.filter(r=>r.nT>=3&&r.ret>0), neg=rows.filter(r=>r.ret<0);
  console.log(`\n→ 趋势池优质(交易≥3+正回报): ${pos.length?pos.map(r=>r.sym+'(+'+r.ret+'%,胜'+r.rate+'%)').join(' '):'无'}`);
  console.log(`→ 汇总: ${rows.length}币 正${pos.length}负${neg.length} | 均回报+${(rows.reduce((s,r)=>s+r.ret,0)/rows.length).toFixed(1)}% 均胜率${Math.round(rows.reduce((s,r)=>s+r.rate,0)/rows.length)}%`);
}
main().catch(e=>{console.error('ERR',e);process.exit(1);});
