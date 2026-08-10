// 分别测 趋势策略 和 网格策略 各币表现(不限市场分类, 看币适配哪种)
// 用 2500根15m(≈26天) 让信号充足, 只统计≥5笔
const { BinanceAPI } = require('../lib/common');
const { FeatureEngineer, toArray } = require('./featurer');
const { MarketClassifier } = require('./market-classifier');
const { TrendFollowingStrategy } = require('./trend-strategy');
const { RangeGridStrategy } = require('./grid-strategy');
const APIKEY=process.env.BINANCE_API_KEY,APISECRET=process.env.BINANCE_API_SECRET;
const COINS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','BCHUSDT','DOTUSDT','NEARUSDT','TIAUSDT','SUIUSDT','APTUSDT','OPUSDT','ARBUSDT','SEIUSDT','INJUSDT','WIFUSDT','TURBOUSDT','1000PEPEUSDT','PENDLEUSDT','STXUSDT','KASUSDT','LTCUSDT','AAVEUSDT','TONUSDT','FILUSDT','ALGOUSDT'];
const TFEE=0.0005, LEV=5;
// 纯趋势策略回测
function btTrend(kl){
  const tr=new TrendFollowingStrategy(); const fe=new FeatureEngineer();
  const c=toArray(kl).map(k=>+k[3]); let bal=0,nT=0,nW=0; let pos=null;
  for(let i=120;i<c.length;i++){
    const win=toArray(kl.slice(0,i+1)); const price=c[i];
    // 方向(简化为EMA7vs25)
    const emaS=fe.ema(win,7),emaL=fe.ema(win,25);
    const dir=emaS>emaL?'UP':((emaS<emaL)?'DOWN':'FLAT');
    if(pos){
      const atr=fe.calcATR(win);
      const ts=tr.trailingStop(pos,price); let cr=null;
      if(ts.action==='CLOSE')cr=ts.reason; else {const sl=tr.stopLoss(pos,price,atr);if(sl.action==='CLOSE')cr=sl.reason;}
      if(cr){const raw=pos.side==='LONG'?(price-pos.entry)/pos.entry*100:(pos.entry-price)/pos.entry*100;const p=raw*LEV-TFEE*200;bal+=p;nT++;p>0?nW++:0;pos=null;}
    } else {
      const sig=tr.entrySignal(win,dir);
      if(sig.signal!=='NONE')pos={side:sig.signal,entry:price,_peak:price};
    }
  }
  return {nT,nW,rate:nT?Math.round(nW/nT*100):0,ret:+bal.toFixed(1)};
}
function btGrid(kl){
  const gr=new RangeGridStrategy(); const fe=new FeatureEngineer();
  const c=toArray(kl).map(k=>+k[3]); let bal=0,nT=0,nW=0; let pos=null;
  for(let i=120;i<c.length;i++){
    const win=toArray(kl.slice(0,i+1)); const price=c[i];
    if(pos){ const ge=gr.gridExit(pos,price,pos._rng); if(ge.action==='CLOSE'){const raw=pos.side==='LONG'?(price-pos.entry)/pos.entry*100:(pos.entry-price)/pos.entry*100;const p=raw*LEV-TFEE*200;bal+=p;nT++;p>0?nW++:0;pos=null;} }
    else { const sig=gr.generateSignal(win); if(sig.signal!=='NONE'&&sig.side)pos={side:sig.side,entry:price,_peak:price,_rng:gr.computeRange(win)}; }
  }
  return {nT,nW,rate:nT?Math.round(nW/nT*100):0,ret:+bal.toFixed(1)};
}
async function main(){
  const api=new BinanceAPI(APIKEY,APISECRET); const rows=[];
  for(const sym of COINS){
    const kl=await api.getKlines(sym,'15m',1500).catch(()=>null);
    if(!Array.isArray(kl)||kl.length<600)continue;
    const t=btTrend(kl), g=btGrid(kl);
    rows.push({sym:sym.replace('USDT',''),t,g});
  }
  console.log('=== 双策略分别回测 (15m·~1500根≈15天·5x·费0.1%) 信号≥5才算有效 ===');
  console.log('| 币种| 趋势交易|趋势胜率|趋势回报 | 网格交易|网格胜率|网格回报| 更适配 |');
  for(const r of rows){
    const tag = r.t.ret > r.g.ret ? '趋势' : '网格';
    const vt = r.t.nT>=5?`${r.t.nT}/${r.t.rate}%/+${r.t.ret}%`:'(少)';
    const vg = r.g.nT>=5?`${r.g.nT}/${r.g.rate}%/+${r.g.ret}%`:'(少)';
    console.log(`|${r.sym}| ${vt} | ${vg} |${tag}|`);
  }
}
main();
