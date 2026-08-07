// 布林带策略专项回测 — 选优质币进震荡池
// 规格: 5min, 带宽分位开仓门禁, 收盘破轨开仓, 双模式止盈, 前置/终极风控, 插针过滤
const { BinanceAPI } = require('../lib/common');
const { FeatureEngineer, toArray } = require('./featurer');
const { BollingerStrategy } = require('./bollinger-strategy');
const https=require('https');
const APIKEY=process.env.BINANCE_API_KEY,APISECRET=process.env.BINANCE_API_SECRET;
const COINS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','BCHUSDT','DOTUSDT','NEARUSDT','TIAUSDT','SUIUSDT','APTUSDT','OPUSDT','ARBUSDT','SEIUSDT','INJUSDT','WIFUSDT','TURBOUSDT','1000PEPEUSDT','LTCUSDT','FILUSDT','STXUSDT'];
const TFEE=0.0005, LEV=3, POS_RATIO=0.15, SVMULT=0.70;
function runBoll(kl){
  const boll=new BollingerStrategy(), fe=new FeatureEngineer();
  const arr=toArray(kl), c=arr.map(k=>+k[3]);
  let pos=null, nT=0, nW=0, bal=0;
  for(let i=60;i<c.length;i++){
    const win=arr.slice(0,i+1), price=c[i];
    // 插针过滤: 单根K线涨跌±3% → 该K线信号作废
    const prev=c[i-1]; if(prev>0 && Math.abs(price-prev)/prev > 0.03) continue;
    if(pos){
      const tp=boll.checkTakeProfit(pos, win);
      if(tp.action==='CLOSE'){ const raw=pos.side==='LONG'?(price-pos.entryPrice)/pos.entryPrice*100:(pos.entryPrice-price)/pos.entryPrice*100; let pn=raw*LEV*POS_RATIO-TFEE*200*POS_RATIO; if(pn>0)pn*=SVMULT; bal+=pn; nT++; if(pn>0)nW++; pos=null; continue; }
      const hs=boll.checkHardStop(pos, win, this&&0);
      if(hs.stop){ const raw=pos.side==='LONG'?(price-pos.entryPrice)/pos.entryPrice*100:(pos.entryPrice-price)/pos.entryPrice*100; let pn=raw*LEV*POS_RATIO-TFEE*200*POS_RATIO; bal+=pn; nT++; pos=null; continue; }
    } else {
      const gate=boll.canOpen(win);
      if(!gate.allowed)continue;
      const es=boll.entrySignal(win,'FLAT',false);
      if(es.signal==='LONG'||es.signal==='SHORT')pos={side:es.signal,entryPrice:price,currentPrice:price,_addRound:0};
    }
  }
  return {nT,nW,rate:nT?Math.round(nW/nT*100):0,ret:+bal.toFixed(1)};
}
// 分页拉5minK线(突破1500限制)
async function getK5(sym, count){
  const out=[]; const itMs=300000;
  let start=Date.now()-count*itMs;
  while(out.length<count){
    const kl=await new Promise(res=>{const ch=[];https.get('https://fapi.binance.com/fapi/v1/klines?symbol='+sym+'&interval=5m&limit=1500&startTime='+start,r=>{r.on('data',d=>ch.push(d));r.on('end',()=>{try{const j=JSON.parse(Buffer.concat(ch).toString());res(Array.isArray(j)?j.map(k=>({time:k[0],open:k[1],high:k[2],low:k[3],close:+k[4],volume:k[5],openTime:k[0]})):null);}catch(e){res(null);}});}).on('error',()=>res(null));});
    if(!Array.isArray(kl)||!kl.length)break;
    out.push(...kl); start=kl[kl.length-1].openTime+itMs;
    if(kl.length<1500)break;
  }
  return out;
}
async function main(){
  console.log('[bt] main starting');
  const api=new BinanceAPI(APIKEY,APISECRET);
  const rows=[];
  for(const sym of COINS){
    console.log('[bt] fetch',sym);
    const kl=await getK5(sym, 2880); // 5min*2880 = 10天
    if(!Array.isArray(kl)||kl.length<300){console.log(sym,'数据不足',Array.isArray(kl)?kl.length:'-');continue;}
    const r=runBoll(kl);
    rows.push({sym:sym.replace('USDT',''),...r});
  }
  rows.sort((a,b)=>b.ret-a.ret);
  console.log('=== 布林带策略专项回测 (5min·带宽门禁+触轨开仓+双止盈+风控·3x·费0.1%+算力费30%·~2880根≈10天) ===');
  console.log('| 币种|交易|胜率%|净回报%|');
  for(const r of rows) if(r.nT>0) console.log(`|${r.sym}|${r.nT}|${r.rate}|+${r.ret}|`);
  const pos=rows.filter(r=>r.ret>0&&r.nT>=3).sort((a,b)=>b.ret-a.ret);
  console.log(`\n→ 优质震荡池(正期望+交易≥3): ${pos.map(r=>r.sym+'(+'+r.ret+'%,'+r.rate+')').join(' ')||'无'}`);
}
process.on('uncaughtException',e=>{console.error('UNCAUGHT:',e.stack);process.exit(1);});
main().catch(e=>{console.error('MAIN ERR:',e);process.exit(1);});
