// 大道至简 v4 回测 — 15m 500根定位 + MA7反转 低买高卖低卖
// 开仓: LOW位<44%拐上买 / 高速位>56%拐下卖
// 平仓: 平多需>72%拐下 / 平空需<28%拐上
const https=require('https');
const FEE=0.0005;           // taker单边，开平双边0.1%
const ITER=1000;            // 15m * 1000根 ≈ 10.4天
function getK(s,it,li,st){return new Promise(res=>{req('https://fapi.binance.com/fapi/v1/klines?symbol='+s+'&interval='+it+'&limit='+li+(st?'&startTime='+st:''),res);});}
function req(url,cb){const ch=[];https.get(url,r=>{r.on('data',d=>ch.push(d));r.on('end',()=>{try{cb(JSON.parse(Buffer.concat(ch).toString()));}catch(e){cb(null);}});}).on('error',()=>cb(null));}
function cal(c){
  const ma=[];for(let i=0;i+7<=c.length;i++){const v=c.slice(i,i+7).reduce((a,b)=>a+b,0)/7;ma.push(v);}
  return ma;
}
function posRatio(ma,nm,LOOK){const look=Math.min(LOOK,nm);const h=ma.slice(-look);const mx=Math.max(...h),mn=Math.min(...h);const r=mx-mn;return {ratio:(r>0?(ma[nm-1]-mn)/r:0.5),range:r,mx,mn};}
async function backtest(coin){
  const kl=await getK(coin,'15m',ITER);
  if(!Array.isArray(kl)||kl.length<600)return null;
  const c=kl.map(k=>+k[4]);
  const ma=cal(c);
  const LOOK=500;
  let pos=null;let nT=0,nW=0,nL=0,ret=0,maxDD=0;
  const oOpen=0.44,oHigh=0.56,tpHigh=0.72,tpLow=0.28,turnR=0.008;
  // 从第600根开始(保证500根历史+MA warmup)
  for(let i=600;i<ma.length;i++){
    // 需要有完整500根历史
    const {ratio,range}=posRatio(ma,i,LOOK);
    if(range<=0)continue;
    const turnMin=range*turnR;
    const d1=ma[i]-ma[i-1];
    const d2=ma[i-1]-ma[i-2];
    const d3=ma[i-2]-ma[i-3];
    const price=c[i];
    if(!pos){
      const bullish=d1>0&&d1>turnMin;
      const notAnti=!(d3<-turnMin&&d2<-turnMin&&d1>0);
      const bearish=d1<0&&d1<-turnMin;
      if(ratio<oOpen&&bullish&&notAnti){pos={s:'L',o:price};}
      else if(ratio>oHigh&&bearish){pos={s:'S',o:price};}
    } else if(pos.s==='L'){
      // 平多: >72%拐下
      const topTurn=d1< -turnMin;
      if(ratio>tpHigh&&topTurn){
        const pnl=(price-pos.o)/pos.o*8*100-FEE*100*2;ret+=pnl;pnl>0?nW++:nL++;nT++;maxDD=Math.max(maxDD,ret);pos=null;
      }
    } else if(pos.s==='S'){
      const botTurn=d1>turnMin;
      if(ratio<tpLow&&botTurn){
        const pnl=(pos.o-price)/pos.o*8*100-FEE*100*2;ret+=pnl;pnl>0?nW++:nL++;nT++;maxDD=Math.max(maxDD,ret);pos=null;
      }
    }
  }
  // 未平仓的按现价结算
  if(pos){
    const price=c[c.length-1];
    const pnl=(pos.s==='L'?(price-pos.o):(pos.o-price))/pos.o*8*100-FEE*100*2;ret+=pnl;pnl>0?nW++:nL++;nT++;
  }
  return {coin:coin.replace('USDT',''),nT,nW,nL,rate:nT?Math.round(nW/nT*100):0,ret:+ret.toFixed(1)};
}
(async()=>{
  const ALL=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','LTCUSDT','BCHUSDT','DOTUSDT','TONUSDT','NEARUSDT','APTUSDT','ARBUSDT','OPUSDT','SUIUSDT','PEPEUSDT','WIFUSDT','SHIBUSDT','1000PEPEUSDT','1000BONKUSDT','TURBOUSDT','HFTUSDT','VICUSDT','BICOUSDT','PTBUSDT','BLESSUSDT','KASUSDT','SEIUSDT','INJUSDT','STXUSDT','AAVEUSDT','MKRUSDT','MEMEUSDT','TIAUSDT','PENDLEUSDT','ARUSDT','EPICUSDT'];
  const rows=[];
  for(const coin of ALL){
    const r=await backtest(coin);if(r)rows.push(r);
  }
  rows.sort((a,b)=>b.ret-a.ret);
  console.log('=== 大道至简 v4 回测 (15m 500根定位, MA7反转, 8x, 费0.1%双边, 1000根15m≈10.4天) ===');
  console.log('| 币|交易|胜率|净回报%|(胜/负)|');
  for(const r of rows)console.log(`|${r.coin}|${r.nT}|${r.rate}%|+${r.ret}|(${r.nW}/${r.nL})|`);
  const posSum=rows.filter(r=>r.ret>0);const neg=rows.filter(r=>r.ret<=0);
  const totT=rows.reduce((s,r)=>s+r.nT,0);const totR=rows.reduce((s,r)=>s+r.ret,0);
  console.log('\n===== 汇总 =====');
  console.log('测试币种',rows.length,'| 正期望',posSum.length,'| 负期望',neg.length);
  console.log('总交易',totT,'| 总净回报 +'+totR.toFixed(1)+'% | 均币 +'+(totR/rows.length).toFixed(1)+'%');
  console.log('精选好币(正期望):',posSum.slice(0,10).map(r=>r.coin+' +'+r.ret+'%').join(', ')||'无');
})();
