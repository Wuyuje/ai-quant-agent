// 大道至简 v4 — 按真实资金模型回测(每笔用当前余额的 marginPct×杠杆 = notionalPct)
// 收敛后精选币池: 用30天回测多次成交高胜率者
// 资金模型: 单账户每笔 margin=BAL*marginPct(10%), notional=margin*5x=50%BAL
// 累计收益用复合利: 每笔盈亏加到余额, 下一笔以新余额的10%开
// 包含: 手续费0.1%双边名义 + 普通用户算力费(盈利×0.70)
const https=require('https');
const TFEE=0.0005, LEV=5, MARGIN_PCT=0.10, SVMULT=0.70, LOOK=500;
// 收敛币池(30天多次交易+高胜率+单笔正)
const POOL=['ETHUSDT','1000PEPEUSDT','BCHUSDT','ARBUSDT','LINKUSDT','TURBOUSDT','SEIUSDT','INJUSDT','WIFUSDT','SOLUSDT'];
function gk(s,it,li,st){return new Promise(r=>{const c=[];https.get('https://fapi.binance.com/fapi/v1/klines?symbol='+s+'&interval='+it+'&limit='+li+(st?'&startTime='+st:''),x=>{x.on('data',d=>c.push(d));x.on('end',()=>{try{r(JSON.parse(Buffer.concat(c).toString()));}catch(e){r(null);}});}).on('error',()=>r(null));});}
async function getK(s,it,li){const arr=[];const end=Date.now();let st=end-li*900000;while(arr.length<li){const p=await gk(s,it,1500,st);if(!Array.isArray(p)||!p.length)break;arr.push(...p);st=p[p.length-1][6]+900000;}return arr;}
function cal(c){const m=[];for(let i=0;i+7<=c.length;i++)m.push(c.slice(i,i+7).reduce((a,b)=>a+b,0)/7);return m;}
function pr(ma,nm){const look=Math.min(LOOK,nm);const h=ma.slice(-look);const mx=Math.max(...h),mn=Math.min(...h);return mx-mn>0?(ma[nm-1]-mn)/(mx-mn):0.5;}
// 单个币在给定K线上跑出交易序列(record trades), 再按资金模型回放
async function getTrades(coin,ITER){
  const kl=await getK(coin,'15m',ITER);if(!Array.isArray(kl)||kl.length<600)return null;
  const c=kl.map(k=>+k[4]);const ma=cal(c);
  const trades=[];
  let pos=null;const oL=0.44,oH=0.56,tH=0.72,tL=0.28,tr=0.008;
  for(let i=600;i<ma.length;i++){
    const ratio=pr(ma,i);const h=ma.slice(-Math.min(LOOK,i));const rg=Math.max(...h)-Math.min(...h);
    if(rg<=0)continue;const turn=rg*tr,d1=ma[i]-ma[i-1],d2=ma[i-1]-ma[i-2],d3=ma[i-2]-ma[i-3];const p=c[i];
    if(!pos){const bu=d1>0&&d1>turn,noA=!(d3<-turn&&d2<-turn&&d1>0),be=d1<0&&d1<-turn;
      if(ratio<oL&&bu&&noA)pos={s:'L',o:p};else if(ratio>oH&&be)pos={s:'S',o:p};}
    else if(pos.s==='L'&&ratio>tH&&d1<-turn){trades.push((p-pos.o)/pos.o);pos=null;}
    else if(pos.s==='S'&&ratio<tL&&d1>turn){trades.push((pos.o-p)/pos.o);pos=null;}
  }
  if(pos){trades.push((pos.s==='L'?c[c.length-1]-pos.o:pos.o-c[c.length-1])/pos.o);}
  return {coin:coin.replace('USDT',''),trades};
}
function replay(trades,startBal){
  let bal=startBal,nT=0,nW=0;
  for(const raw of trades){
    const notional=bal*MARGIN_PCT*LEV;         // 名义=10%资金×5x=50%余额
    let pnlD=raw*notional;                      // 币价变动收益
    let fee=notional*TFEE*2;                    // 双边手续费
    let tradePnl=pnlD-fee;
    if(tradePnl>0)tradePnl*=SVMULT;             // 普通用户盈利扣30%算力费
    bal+=tradePnl;nT++;if(tradePnl>0)nW++;
  }
  return {bal,ret:(bal-startBal)/startBal*100,nT,nW,rate:nT?Math.round(nW/nT*100):0};
}
(async()=>{
  for(const days of [30,90]){
    const ITER=days*96; // 15m一天96根
    console.log('\n═════════ '+days+'天回测 (收敛池8币, 每笔10%资金×5x, 5x杠杆, 含手续费+普通用户算力费30%) ═════════');
    const data=[];
    for(const c of POOL){const d=await getTrades(c,ITER);if(d)data.push(d);}
    // 每个币独立账户$1000回放
    let totalRet=0;console.log('| 币|交易|胜率|期末资金|净回报|均笔%|');
    const perCoin=[];
    for(const c of data){
      const r=replay(c.trades,1000);perCoin.push({coin:c.coin,...r,avg:r.nT?(r.ret/r.nT):0});
      console.log(`|${c.coin}|${r.nT}|${r.rate}%|\$${r.bal.toFixed(0)}|+${r.ret.toFixed(1)}%|${(r.nT?(r.ret/r.nT):0).toFixed(2)}|`);
    }
    const pos=perCoin.filter(x=>x.ret>0);
    const avgRet=perCoin.reduce((s,x)=>s+x.ret,0)/perCoin.length;
    const totalT=perCoin.reduce((s,x)=>s+x.nT,0);
    console.log(`→ ${days}天: ${perCoin.length}币中${pos.length}正期望 | 平均净回报+${avgRet.toFixed(1)}% | 总交易${totalT}笔`);
    totalRet=avgRet;
  }
})();
