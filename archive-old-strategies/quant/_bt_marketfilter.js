// 大盘过滤回测: 对比 无过滤 vs 有过滤(下跌市整体空仓)
const { BinanceAPI } = require('../lib/common');
const { FeatureEngineer, toArray } = require('./featurer');
const { MarketClassifier } = require('./market-classifier');
const { TrendFollowingStrategy } = require('./trend-strategy');
const { RangeGridStrategy } = require('./grid-strategy');
const APIKEY=process.env.BINANCE_API_KEY,APISECRET=process.env.BINANCE_API_SECRET;
const COINS=['ETHUSDT','BCHUSDT','OPUSDT','WIFUSDT','SEIUSDT','FILUSDT','TIAUSDT','BTCUSDT','DOTUSDT','STXUSDT','ALGOUSDT','ARBUSDT','INJUSDT','APTUSDT','TURBOUSDT','SOLUSDT','LINKUSDT','SUIUSDT','AAVEUSDT','NEARUSDT'];
const TFEE=0.0005, LEV=5, POS_RATIO=0.15, SVMULT=0.70;
// BTC大盘方向(用BTC的MA30位置+动量)
function btcRegime(btcArr, i){
  const closes=toArray(btcArr).map(k=>+k[3]);
  const seg=closes.slice(Math.max(0,i-30),i);
  if(seg.length<20)return 'RISK';
  const ma30v=seg.reduce((a,b)=>a+b,0)/seg.length;
  const last=closes[Math.min(i-1,closes.length-1)];
  const last6=closes[Math.max(0,i-6)], last30=closes[Math.max(0,i-30)];
  const mom=(last-last6)/(last6||1)*100;
  const pos300=(last-ma30v)/ma30v*100;
  if(pos300<-0.5 && mom<-0.1) return 'RISK';      // BTC明显走弱→风险/空仓
  if(pos300>0.5 && mom>0.1) return 'RISK';          // 过热狂涨也谨慎
  return 'OK';                                      // 平稳→可交易
}
function run(kl, btcArr, useFilter){
  const cls=new MarketClassifier(), trend=new TrendFollowingStrategy(), grid=new RangeGridStrategy(), fe=new FeatureEngineer();
  const arr=toArray(kl), c=arr.map(k=>+k[3]);
  let pos=null,nT=0,nW=0,bal=0;
  for(let i=150;i<c.length;i++){
    const win=toArray(kl.slice(0,i+1)), price=c[i];
    if(pos){
      let cr=null;
      if(pos.strategy==='grid'){const ge=grid.gridExit(pos,price,pos._rng);if(ge.action==='CLOSE')cr=ge.reason;}
      else if(pos.strategy==='trend'){const ts=trend.trailingStop(pos,price,'UP');if(ts.action==='CLOSE'||ts.action==='REVERSE')cr=ts.reason;else{const atr=fe.calcATR(win);const sl=trend.stopLoss(pos,price,atr);if(sl.action==='CLOSE')cr=sl.reason;}}
      if(cr){const raw=pos.side==='LONG'?(price-pos.entry)/pos.entry*100:(pos.entry-price)/pos.entry*100;let tp=raw*LEV*POS_RATIO-TFEE*200*POS_RATIO;if(tp>0)tp*=SVMULT;bal+=tp;nT++;if(tp>0)nW++;pos=null;}
    } else {
      // 大盘过滤: RISK市不开新仓
      if(useFilter && btcRegime(btcArr,i)==='RISK')continue;
      const j=cls.judgeMarketState(win,0), strat=cls.recommendedStrategy(j);
      if(strat==='grid'){const sig=grid.generateSignal(win,j.trendDir);if(sig.signal!=='NONE'&&sig.side)pos={side:sig.side,strategy:'grid',entry:price,_peak:price,_rng:null};}
      else if(strat==='trend'){const sig=trend.entrySignal(win,j.trendDir);if(sig.signal==='LONG'||sig.signal==='SHORT')pos={side:sig.signal,strategy:'trend',entry:price,_peak:price};}
    }
  }
  return {nT,nW,rate:nT?Math.round(nW/nT*100):0,ret:+bal.toFixed(1)};
}
async function main(){
  const api=new BinanceAPI(APIKEY,APISECRET);
  const btc=await api.getKlines('BTCUSDT','4h',700).catch(()=>null);
  for(const days of [30,90]){
    const it=days===30?'1h':'4h', limit=days===30?720:560;
    console.log(`\n═════ ${days}天 大盘过滤对比 (含费+算力费30%) ═════`);
    let r0=0,r1=0,p0=0,p1=0;
    for(const sym of COINS){
      const kl=await api.getKlines(sym,it,limit).catch(()=>null);
      if(!Array.isArray(kl)||kl.length<200)continue;
      // 用BTC4h同样本映射: 简化, 直接用BTC+当前样本的BTC判断
      const a=run(kl,btc||[],false), b=run(kl,btc||[],true);
      r0+=a.ret; r1+=b.ret; if(a.ret>0)p0++; if(b.ret>0)p1++;
      if(sym==='ETHUSDT'||sym==='BTCUSDT'||sym==='SOLUSDT'||sym==='TIAUSDT')
        console.log(`  ${sym.replace('USDT','')}: 无过滤${a.ret>0?'+':''}${a.ret}% / 有过滤${b.ret>0?'+':''}${b.ret}%`);
    }
    console.log(`→ ${days}天: 无过滤均${(r0/COINS.length).toFixed(1)}%(正${p0}) | 有过滤均${(r1/COINS.length).toFixed(1)}%(正${p1})`);
  }
}
main();
