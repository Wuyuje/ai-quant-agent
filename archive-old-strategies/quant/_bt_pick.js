// v6摆动趋势引擎 全面回测选币(保准确, 适配度最高)
const https=require('https');
const { TrendStrategy } = require('./trend-strategy');
const { toArray } = require('./featurer');
// 广泛候选池
const COINS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','BCHUSDT','DOTUSDT','NEARUSDT','TIAUSDT','SUIUSDT','APTUSDT','OPUSDT','ARBUSDT','SEIUSDT','INJUSDT','WIFUSDT','TURBOUSDT','1000PEPEUSDT','LTCUSDT','FILUSDT','STXUSDT','ALGOUSDT','PENDLEUSDT','KASUSDT','AAVEUSDT','TONUSDT','HFTUSDT','BICOUSDT','PTBUSDT'];
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
  let pos=null,nT=0,nW=0,bal=0,longN=0,shortN=0,longW=0,shortW=0,longRet=0,shortRet=0;
  for(let i=80;i<c.length;i++){
    const win=toArray(kl.slice(0,i+1)), price=c[i];
    if(pos){
      const lev=pos.side==='LONG'?LONG_LEV:SHORT_LEV;
      const tp=trend.takeProfit(pos,price,toArray(win).map(k=>+k[3])); let cr=null;
      if(tp.action==='CLOSE')cr=tp.reason;
      else{const sl=trend.stopLoss(pos,price,toArray(win).map(k=>+k[3]));if(sl.action==='CLOSE')cr=sl.reason;}
      if(cr){const raw=pos.side==='LONG'?(price-pos.entryPrice)/pos.entryPrice*100:(pos.entryPrice-price)/pos.entryPrice*100;let cp=raw*lev*POS_RATIO-TFEE*200*POS_RATIO;if(cp>0)cp*=SVMULT;bal+=cp;nT++;if(cp>0)nW++;
        if(pos.side==='LONG'){longN++;longRet+=cp;if(cp>0)longW++;}else{shortN++;shortRet+=cp;if(cp>0)shortW++;} pos=null;}
    } else {
      const dir=trend.marketDirection(toArray(win).map(k=>+k[3]));
      const sig=trend.entrySignal(win,dir);
      if(sig.signal==='LONG'||sig.signal==='SHORT')pos={side:sig.signal,entryPrice:price,_peak:price};
    }
  }
  return {nT,nW,rate:nT?Math.round(nW/nT*100):0,ret:+bal.toFixed(1),longN,shortN,longRet:+longRet.toFixed(1),shortRet:+shortRet.toFixed(1),longW,shortW,longRate:longN?Math.round(longW/longN*100):0,shortRate:shortN?Math.round(shortW/shortN*100):0};
}
async function main(){
  const rows=[];
  // 15天(更快) + 30天 都在1h
  for(const sym of COINS){
    const kl=await getK(sym,'1h',1500); // 90天
    if(!Array.isArray(kl)||kl.length<200)continue;
    const r=runTrend(kl);
    const c=toArray(kl).map(k=>+k[3]);const chg=(c[c.length-1]-c[0])/c[0]*100;
    rows.push({sym:sym.replace('USDT',''),chg:+chg.toFixed(1),...r});
  }
  rows.sort((a,b)=>b.ret-a.ret);
  console.log('═══ v6摆动趋势引擎 · 90天(1h) 全币回测·多5x空3x·含费+算力费 ═══');
  console.log('| 币种|90天涨跌%|交易|胜率%|净回报%|多(胜率)|空(胜率)|多回报|空回报|');
  for(const r of rows){
    if(r.nT<2)continue;
    console.log(`|${r.sym}|${r.chg>=0?'+':''}${r.chg}|${r.nT}|${r.rate}|+${r.ret}|${r.longN}(${r.longRate}%)|${r.shortN}(${r.shortRate}%)|+${r.longRet}|${r.shortRet}|`);
  }
  const good=rows.filter(r=>r.nT>=2&&r.ret>0&&r.rate>=40);
  const all=rows.filter(r=>r.nT>=2);
  console.log(`\n→ 优质趋势池(交易≥2+正回报+胜率≥40%): ${good.length?good.map(r=>r.sym+'(+'+r.ret+'%,胜'+r.rate+'%)').join(' '):'无'}`);
  console.log(`→ 参与交易${all.length}币 正期望${rows.filter(r=>r.ret>0).length}`);
}
main().catch(e=>{console.error('ERR',e.message);process.exit(1);});
