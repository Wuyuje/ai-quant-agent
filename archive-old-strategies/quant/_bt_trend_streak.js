// 找历史趋势行情(近90天单边走强/走弱) + 回测趋势引擎看效果
const https=require('https');
const { TrendStrategy } = require('./trend-strategy');
const { toArray } = require('./featurer');
const COINS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','ARBUSDT','DOTUSDT','LINKUSDT','BCHUSDT','TIAUSDT','INJUSDT','WIFUSDT','1000PEPEUSDT','TURBOUSDT','SEIUSDT','SUIUSDT','APTUSDT','FILUSDT','PENDLEUSDT','STXUSDT','KASUSDT'];
const TFEE=0.0005, LEV=8, POS_RATIO=0.10, SVMULT=0.70;
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
// 判断该K线序列是否走出明确趋势(近90天单边)
function trendScore(kl){
  const c=toArray(kl).map(k=>+k[3]);
  if(c.length<200)return {trend:false,chg:0};
  const first=c[0],last=c[c.length-1];
  const chg=(last-first)/first*100;
  // 趋势强度: 用 90天区间内 线性/整体方向一致度 + MA60斜率
  const seg=c.slice(-200); // 近200根
  const ma60=seg.slice(-60).reduce((a,b)=>a+b,0)/60;
  const ma200=seg.slice(-200).reduce((a,b)=>a+b,0)/200;
  const dirConsistent = Math.abs(chg) > 20;  // 单边 ≥20%
  return { trend: dirConsistent, chg, up: chg>0, ma60, ma200, aligned: ma60>ma200 };
}
function runTrend(kl){
  const trend=new TrendStrategy();
  const c=toArray(kl).map(k=>+k[3]);
  let pos=null,nT=0,nW=0,bal=0;
  for(let i=150;i<c.length;i++){
    const win=cl(kl.slice(0,i+1)), price=c[i];
    if(pos){
      // 分批止盈 takeProfit → HALF/CLOSE
      const tp=trend.takeProfit(pos,price,win); let cr=null;
      if(tp.action==='HALF'){
        // 平一半锁利: 记一半盈利, 剩一半继续
        const raw=pos.side==='LONG'?(price-pos.entryPrice)/pos.entryPrice*100:(pos.entryPrice-price)/pos.entryPrice*100;
        let hp=raw*LEV*POS_RATIO*0.5 - TFEE*200*POS_RATIO; if(hp>0)hp*=SVMULT;
        bal+=hp; nT++; if(hp>0)nW++;
        pos._qtyLeft=0.5;
      } else if(tp.action==='CLOSE'){ cr=tp.reason; }
      else { const sl=trend.stopLoss(pos,price,cl(win).map(k=>+k[3]),win); if(sl.action==='CLOSE')cr=sl.reason; }
      if(cr){ const m=pos._qtyLeft||1; const raw=pos.side==='LONG'?(price-pos.entryPrice)/pos.entryPrice*100:(pos.entryPrice-price)/pos.entryPrice*100; let cp=raw*LEV*POS_RATIO*m-TFEE*200*POS_RATIO; if(cp>0)cp*=SVMULT; bal+=cp; nT++; if(cp>0)nW++; pos=null; }
    } else {
      const dir=trend.marketDirection(cl(win).map(k=>+k[3]));
      const sig=trend.entrySignal(win,dir);
      if(sig.signal==='LONG'||sig.signal==='SHORT')pos={side:sig.signal,entryPrice:price,_peak:price,_qtyLeft:1};
    }
  }
  return {nT,nW,rate:nT?Math.round(nW/nT*100):0,ret:+bal.toFixed(1)};
}
function cl(kl){return toArray(kl);}
async function main(){
  const api={}; // 未用
  // 4h 90天: 找出走趋势的
  console.log('=== 筛选: 近90天(4h×540) 明显单边趋势行情(±20%+) ===');
  const trendSet=[];
  for(const sym of COINS){
    const kl=await getK(sym,'4h',540);
    if(!Array.isArray(kl)||kl.length<200)continue;
    const ts=trendScore(kl);
    if(ts.trend) trendSet.push({sym:sym.replace('USDT',''),chg:+ts.chg.toFixed(1),up:ts.up});
    console.log(`  ${sym.replace('USDT','')}: 90天涨跌${ts.chg>=0?'+':''}${ts.chg.toFixed(1)}% ${ts.trend?'[有趋势]':''}`);
  }
  console.log('\n=== 在这些趋势行情上回测趋势引擎 ===');
  const rows=[];
  for(const t of trendSet){
    const kl=await getK(t.sym+'USDT','4h',540);
    if(!Array.isArray(kl)||kl.length<200)continue;
    const r=runTrend(kl);
    rows.push({sym:t.sym,chg:t.chg,up:t.up,...r});
  }
  rows.sort((a,b)=>b.ret-a.ret);
  console.log('| 币种|90天涨跌%|趋势方向|交易|胜率%|净回报%|');
  for(const r of rows)console.log(`|${r.sym}|${r.chg}|${r.up?'↑涨':'↓跌'}|${r.nT}|${r.rate}|+${r.ret}|`);
  const pos=rows.filter(r=>r.ret>0), neg=rows.filter(r=>r.ret<0);
  console.log(`\n→ 趋势行情下: ${rows.length}币中 正期望${pos.length}负${neg.length} | 均回报+${(rows.reduce((s,r)=>s+r.ret,0)/rows.length).toFixed(1)}%`);
}
main().catch(e=>{console.error('ERR',e);process.exit(1);});
