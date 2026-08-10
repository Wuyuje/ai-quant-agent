// 趋势引擎(借鉴版)单独专项回测 — 多周期+多时长 看胜率/回报率
const https=require('https');
const { TrendStrategy } = require('./trend-strategy');
const { toArray } = require('./featurer');
const COINS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','ARBUSDT','DOTUSDT','LINKUSDT','BCHUSDT','TIAUSDT','INJUSDT','WIFUSDT','1000PEPEUSDT','TURBOUSDT','SEIUSDT','SUIUSDT','APTUSDT','FILUSDT','AVAXUSDT','LTCUSDT','STXUSDT'];
const TFEE=0.0005, LEV=8, POS_RATIO=0.10, SVMULT=0.70;
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
      const tp=trend.takeProfit(pos,price,win); let cr=null;
      if(tp.action==='HALF'){const raw=pos.side==='LONG'?(price-pos.entryPrice)/pos.entryPrice*100:(pos.entryPrice-price)/pos.entryPrice*100;let hp=raw*LEV*POS_RATIO*0.5-TFEE*200*POS_RATIO;if(hp>0)hp*=SVMULT;bal+=hp;nT++;if(hp>0)nW++;pos._qtyLeft=0.5;}
      else if(tp.action==='CLOSE')cr=tp.reason;
      else{const sl=trend.stopLoss(pos,price,toArray(win).map(k=>+k[3]),win);if(sl.action==='CLOSE')cr=sl.reason;}
      if(cr){const m=pos._qtyLeft||1;const raw=pos.side==='LONG'?(price-pos.entryPrice)/pos.entryPrice*100:(pos.entryPrice-price)/pos.entryPrice*100;let cp=raw*LEV*POS_RATIO*m-TFEE*200*POS_RATIO;if(cp>0)cp*=SVMULT;bal+=cp;nT++;if(cp>0)nW++;pos=null;}
    } else {
      const dir=trend.marketDirection(toArray(win).map(k=>+k[3]));
      const sig=trend.entrySignal(win,dir);
      if(sig.signal==='LONG'||sig.signal==='SHORT')pos={side:sig.signal,entryPrice:price,_peak:price,_qtyLeft:1};
    }
  }
  return {nT,nW,rate:nT?Math.round(nW/nT*100):0,ret:+bal.toFixed(1)};
}
async function main(){
  const api={};
  for(const [label,interval,count] of [['30天·15min', '15m', 2880], ['30天·1h', '1h', 720], ['90天·1h(缩短计算)', '1h', 1500]]){
    // 控制计算量: 15m的2880根/20币较慢, 用长超时
    if(count>1500 && label.includes('90')) count=1500;
    console.log(`\n═════ 趋势引擎专项 · ${label} (${interval}·5x8?·含费0.1%+算力费30%·8x) ═════`);
    const rows=[];
    for(const sym of COINS){
      const kl=await getK(sym,interval,count);
      if(!Array.isArray(kl)||kl.length<200)continue;
      const r=runTrend(kl);
      if(r.nT>0||['BTCUSDT','ETHUSDT','SOLUSDT'].includes(sym))rows.push({sym:sym.replace('USDT',''),...r});
    }
    rows.sort((a,b)=>b.ret-a.ret);
    console.log('| 币种|交易|胜率%|净回报%|');
    for(const r of rows)console.log(`|${r.sym}|${r.nT}|${r.rate}|+${r.ret}|`);
    const posN=rows.filter(r=>r.ret>0).length;
    const avg=rows.length?rows.reduce((s,r)=>s+r.ret,0)/rows.length:0;
    const wr=rows.length?Math.round(rows.reduce((s,r)=>s+r.rate,0)/rows.length):0;
    console.log(`→ ${rows.length}币 正期望${posN} | 均回报+${avg.toFixed(1)}% 均胜率${wr}%`);
  }
}
main().catch(e=>{console.error('ERR',e.message);process.exit(1);});
