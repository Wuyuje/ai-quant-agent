// 大道至简 v4 30天回测 — 含全部费用(手续费+普通用户算力费)
// 开仓: 15m MA7 500根定位, 低位<44%拐上做多低买 / 高位>56%拐下做空高卖
// 平仓: 平多@>72%拐下 / 平空@<28%拐上
// 费用: 手续费 taker 单边0.05% ×2=0.1%名义双边(每笔)
//       算力费: 普通用户盈利按 PLATFORM0.20+ECO0.10=0.30 扣 → 盈利×0.70留用户
// 杠杆5x
const https=require('https');
const TFEE=0.0005;   // 单边
const LEV=5;
const SVMULT=0.70;    // 普通用户盈利留存率(扣30%算力费)
const LOOK=500, ITER=2880;  // 2880根15m = 30天
function gk(s,it,li,st){return new Promise(r=>{const c=[];https.get('https://fapi.binance.com/fapi/v1/klines?symbol='+s+'&interval='+it+'&limit='+li+(st?'&startTime='+st:''),x=>{x.on('data',d=>c.push(d));x.on('end',()=>{try{r(JSON.parse(Buffer.concat(c).toString()));}catch(e){r(null);}});}).on('error',()=>r(null));});}
async function getK(s,it,li){const arr=[];const end=Date.now();let st=end-li*900000;while(arr.length<li){const p=await gk(s,it,1500,st);if(!Array.isArray(p)||!p.length)break;arr.push(...p);st=p[p.length-1][6]+900000;}return arr;}
function cal(c){const m=[];for(let i=0;i+7<=c.length;i++)m.push(c.slice(i,i+7).reduce((a,b)=>a+b,0)/7);return m;}
function pr(ma,nm){const look=Math.min(LOOK,nm);const h=ma.slice(-look);const mx=Math.max(...h),mn=Math.min(...h);return mx-mn>0?(ma[nm-1]-mn)/(mx-mn):0.5;}
async function bt(coin){
  const kl=await getK(coin,'15m',ITER);if(!Array.isArray(kl)||kl.length<600)return null;
  const c=kl.map(k=>+k[4]);const ma=cal(c);
  let pos=null,nT=0,nW=0,nL=0,ret=0,maxDD=0,equity=100;
  const oL=0.44,oH=0.56,tH=0.72,tL=0.28,tr=0.008;
  for(let i=600;i<ma.length;i++){
    const ratio=pr(ma,i);const look=Math.min(LOOK,i);const h=ma.slice(-look);const rg=Math.max(...h)-Math.min(...h);
    if(rg<=0)continue;const turn=rg*tr;const d1=ma[i]-ma[i-1],d2=ma[i-1]-ma[i-2],d3=ma[i-2]-ma[i-3];const p=c[i];
    if(!pos){
      const bu=d1>0&&d1>turn;const noA=!(d3<-turn&&d2<-turn&&d1>0);const be=d1<0&&d1<-turn;
      if(ratio<oL&&bu&&noA)pos={s:'L',o:p};else if(ratio>oH&&be)pos={s:'S',o:p};
    }else if(pos.s==='L'&&ratio>tH&&d1< -turn){
      const raw=(p-pos.o)/pos.o*100; // 不含杠杆
      const tradePnl=raw*LEV - TFEE*100*LEV; // 手续费按名义杠杆
      const net=tradePnl>0?tradePnl*SVMULT:tradePnl; // 普通用户: 盈利扣30%算力费
      equity+=net;ret+=net;net>0?nW++:nL++;nT++;pos=null;
    }else if(pos.s==='S'&&ratio<tL&&d1>turn){
      const raw=(pos.o-p)/pos.o*100;
      const tradePnl=raw*LEV - TFEE*100*LEV;
      const net=tradePnl>0?tradePnl*SVMULT:tradePnl;
      equity+=net;ret+=net;net>0?nW++:nL++;nT++;pos=null;
    }
  }
  if(pos){const p=c[c.length-1];const raw=(pos.s==='L'?(p-pos.o):(pos.o-p))/pos.o*100;const tradePnl=raw*LEV-TFEE*100*LEV;const net=tradePnl>0?tradePnl*SVMULT:tradePnl;ret+=net;net>0?nW++:nL++;nT++;}
  const retPct=ret; // 相对保证金的累计%(每笔满仓5x名义)
  return {coin:coin.replace('USDT',''),nT,nW,nL,rate:nT?Math.round(nW/nT*100):0,ret:+retPct.toFixed(1),avg:nT?(retPct/nT).toFixed(2):0};
}
(async()=>{
  const ALL=['1000PEPEUSDT','SEIUSDT','ETHUSDT','ARBUSDT','PENDLEUSDT','TURBOUSDT','WIFUSDT','SOLUSDT','BTCUSDT','LINKUSDT','NEARUSDT','OPUSDT','SUIUSDT','INJUSDT','TIAUSDT','KASUSDT','DOTUSDT','AAVEUSDT','APTUSDT','STXUSDT','BCHUSDT','LTCUSDT','XRPUSDT','DOGEUSDT'];
  const rows=[];for(const c of ALL){const r=await bt(c);if(r)rows.push(r);}
  rows.sort((a,b)=>b.ret-a.ret);
  console.log('=== 大道至简 v4·30天回测 (15m·500根定位·MA7反转·5x·含费0.1%双边+普通用户算力费30%扣除) ===');
  console.log('| 币|交易|胜率%|累计净回报%|均笔%|');
  for(const r of rows)console.log(`|${r.coin}|${r.nT}|${r.rate}|+${r.ret}|${r.avg}|`);
  const pos=rows.filter(r=>r.ret>0);const neg=rows.filter(r=>r.ret<=0);
  const totT=rows.reduce((s,r)=>s+r.nT,0);const totR=rows.reduce((s,r)=>s+r.ret,0);
  const avgAll=nT=>rows.length?rows.reduce((s,r)=>s+r.rate,0)/rows.length:0;
  console.log('\n===== 30天汇总(普通用户含全部费用) =====');
  console.log('币种',rows.length,'| 正期望',pos.length,'负期望',neg.length);
  console.log('总交易',totT,'| 全币累计回报 +'+totR.toFixed(1)+'% | 均币 +'+(totR/rows.length).toFixed(1)+'% | 均胜率 '+avgAll().toFixed(0)+'%');
})();
