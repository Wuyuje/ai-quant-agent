// 单独回测趋势策略(多5x/空3x, 止损放宽拿趋势) — 上涨趋势币验证做多
const https=require('https');
const { TrendStrategy } = require('./trend-strategy');
const { toArray } = require('./featurer');
const COINS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','BCHUSDT','TIAUSDT','INJUSDT','WIFUSDT','TURBOUSDT','SEIUSDT','SUIUSDT','APTUSDT','AAVEUSDT','HFTUSDT','BICOUSDT','PTBUSDT','1000PEPEUSDT'];
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
  for(let i=150;i<c.length;i++){
    const win=toArray(kl.slice(0,i+1)), price=c[i];
    if(pos){
      const lev=pos.side==='LONG'?LONG_LEV:SHORT_LEV;
      const tp=trend.takeProfit(pos,price,win); let cr=null;
      if(tp.action==='HALF'){const raw=pos.side==='LONG'?(price-pos.entryPrice)/pos.entryPrice*100:(pos.entryPrice-price)/pos.entryPrice*100;let hp=raw*lev*POS_RATIO*0.5-TFEE*200*POS_RATIO;if(hp>0)hp*=SVMULT;bal+=hp;nT++;if(hp>0)nW++;pos._qtyLeft=0.5;}
      else if(tp.action==='CLOSE')cr=tp.reason;
      else{const sl=trend.stopLoss(pos,price,toArray(win).map(k=>+k[3]),win);if(sl.action==='CLOSE')cr=sl.reason;}
      if(cr){const m=pos._qtyLeft||1;const raw=pos.side==='LONG'?(price-pos.entryPrice)/pos.entryPrice*100:(pos.entryPrice-price)/pos.entryPrice*100;let cp=raw*lev*POS_RATIO*m-TFEE*200*POS_RATIO;if(cp>0)cp*=SVMULT;bal+=cp;nT++;if(cp>0)nW++;pos=null;}
    } else {
      const dir=trend.marketDirection(toArray(win).map(k=>+k[3]));
      const sig=trend.entrySignal(win,dir);
      if(sig.signal==='LONG'||sig.signal==='SHORT')pos={side:sig.signal,entryPrice:price,_peak:price,_qtyLeft:1};
    }
  }
  return {nT,nW,rate:nT?Math.round(nW/nT*100):0,ret:+bal.toFixed(1)};
}
async function main(){
  console.log('=== 1. 筛选: 近90天(1h)上涨趋势币(+15%) ===');
  const up=[];
  for(const sym of COINS){ const kl=await getK(sym,'1h',1500); if(!Array.isArray(kl)||kl.length<300)continue; const c=toArray(kl).map(k=>+k[3]); const chg=(c[c.length-1]-c[0])/c[0]*100; if(chg>15)up.push({sym:sym.replace('USDT',''),chg:+chg.toFixed(1)}); }
  console.log('上涨≥15%:', up.map(u=>u.sym+'(+'+u.chg+'%)').join(' ')||'无');
  console.log('\n=== 2. 趋势策略(多5x/空3x, 止损放宽拿趋势, 含费+算力费) ===');
  const rows=[];
  for(const u of up){ const kl=await getK(u.sym+'USDT','1h',1500); if(!Array.isArray(kl)||kl.length<300)continue; const r=runTrend(kl); rows.push({sym:u.sym,chg:u.chg,...r}); }
  rows.sort((a,b)=>b.ret-a.ret);
  console.log('| 币种|90天涨%|交易|胜率%|净回报%|');
  for(const r of rows)console.log(`|${r.sym}|+${r.chg}|${r.nT}|${r.rate}|+${r.ret}|`);
  const posN=rows.filter(r=>r.ret>0).length;
  const avg=rows.length?rows.reduce((s,r)=>s+r.ret,0)/rows.length:0;
  console.log(`→ ${rows.length}上涨币 正期望${posN} | 均回报+${avg.toFixed(1)}%`);
}
main().catch(e=>{console.error('ERR',e.message);process.exit(1);});
