// 趋势引擎专项回测 — 选优质趋势币(进趋势行情池)
const https=require('https');
const { MarketClassifier } = require('./market-classifier');
const { TrendFollowingStrategy } = require('./trend-strategy');
const { FeatureEngineer, toArray } = require('./featurer');
const APIKEY=process.env.BINANCE_API_KEY,APISECRET=process.env.BINANCE_API_SECRET;
const COINS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','BCHUSDT','DOTUSDT','NEARUSDT','TIAUSDT','SUIUSDT','APTUSDT','OPUSDT','ARBUSDT','SEIUSDT','INJUSDT','WIFUSDT','TURBOUSDT','1000PEPEUSDT','LTCUSDT','FILUSDT','STXUSDT','ALGOUSDT','PENDLEUSDT','SUIUSDT','KASUSDT','AAVEUSDT'];
const TFEE=0.0005, LEV=5, POS_RATIO=0.15, SVMULT=0.70;
async function getK(sym, interval, count){
  const out=[]; const itMs={ '1m':60000,'5m':300000,'15m':900000,'1h':3600000,'4h':14400000 }[interval]||3600000;
  let start=Date.now()-count*itMs;
  while(out.length<count){
    const kl=await new Promise(res=>{const ch=[];https.get('https://fapi.binance.com/fapi/v1/klines?symbol='+sym+'&interval='+interval+'&limit=1500&startTime='+start,r=>{r.on('data',d=>ch.push(d));r.on('end',()=>{try{const j=JSON.parse(Buffer.concat(ch).toString());res(Array.isArray(j)?j.map(k=>({time:k[0],open:k[1],high:k[2],low:k[3],close:+k[4],volume:k[5],openTime:k[0]})):null);}catch(e){res(null);}});}).on('error',()=>res(null));});
    if(!Array.isArray(kl)||!kl.length)break; out.push(...kl); start=kl[kl.length-1].openTime+itMs;
    if(kl.length<1500)break;
  }
  return out;
}
// 趋势策略回测: 方向用市场分类器(checkTrendDirection多周期MA), 入场+移动止损+逆势反手
function runTrend(kl){
  const cls=new MarketClassifier(), trend=new TrendFollowingStrategy(), fe=new FeatureEngineer();
  const c=toArray(kl).map(k=>+k[3]);
  let pos=null,nT=0,nW=0,bal=0;
  for(let i=150;i<c.length;i++){
    const win=toArray(kl.slice(0,i+1)), price=c[i];
    if(pos){
      const j=cls.checkTrendDirection(win);
      const ts=trend.trailingStop(pos,price,j.dir);  // 逆势反手
      let cr=null;
      if(ts.action==='CLOSE'||ts.action==='REVERSE')cr=ts.reason;
      else{const atr=fe.calcATR(win);const sl=trend.stopLoss(pos,price,atr);if(sl.action==='CLOSE')cr=sl.reason;}
      if(cr){const raw=pos.side==='LONG'?(price-pos.entry)/pos.entry*100:(pos.entry-price)/pos.entry*100;let tp=raw*LEV*POS_RATIO-TFEE*200*POS_RATIO;if(tp>0)tp*=SVMULT;bal+=tp;nT++;if(tp>0)nW++;pos=null;}
      // 逆势反手被trend函数返回REVERSE → 直接反向开仓
      if(pos && (ts.action==='REVERSE')){
        pos={side:pos.side==='LONG'?'SHORT':'LONG',entry:price,_peak:price};
      }
    } else {
      const j=cls.checkTrendDirection(win);
      const sig=trend.entrySignal(win,j.dir);
      if(sig.signal==='LONG'||sig.signal==='SHORT')pos={side:sig.signal,entry:price,_peak:price};
    }
  }
  return {nT,nW,rate:nT?Math.round(nW/nT*100):0,ret:+bal.toFixed(1)};
}
async function main(){
  const rows=[];
  for(const sym of COINS){
    const kl=await getK(sym,'1h',720); // 1h*720=30天
    if(!Array.isArray(kl)||kl.length<200){console.log(sym,'数据不足',Array.isArray(kl)?kl.length:'-');continue;}
    const r=runTrend(kl);
    if(r.nT>0||sym==='BTCUSDT'||sym==='ETHUSDT') rows.push({sym:sym.replace('USDT',''),...r});
  }
  rows.sort((a,b)=>b.ret-a.ret);
  console.log('=== 趋势引擎专项回测 (1h·多周期MA方向·移动止损+逆势反手·5x·费0.1%+算力费30%·~720根≈30天) ===');
  console.log('| 币种|交易|胜率%|净回报%|');
  for(const r of rows)console.log(`|${r.sym}|${r.nT}|${r.rate}|+${r.ret}|`);
  const good=rows.filter(r=>r.nT>=3&&r.ret>0).sort((a,b)=>b.ret-a.ret);
  console.log(`\n→ 优质趋势池(交易≥3+正回报): ${good.map(r=>r.sym+'(+'+r.ret+'%,'+r.rate+')').join(' ')||'无'}`);
}
main().catch(e=>{console.error('ERR',e);process.exit(1);});
