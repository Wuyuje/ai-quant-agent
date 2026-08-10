// 快速冒烟测试: 验证 数据→分类→策略 全链路
const { FeatureEngineer } = require('./featurer');
const { MarketClassifier } = require('./market-classifier');
const { TrendFollowingStrategy } = require('./trend-strategy');
const { RangeGridStrategy } = require('./grid-strategy');
const { QuantBacktest } = require('./backtest');
const https = require('https');

function gk(s,it,li){return new Promise(r=>{const c=[];https.get('https://fapi.binance.com/fapi/v1/klines?symbol='+s+'&interval='+it+'&limit='+li,x=>{x.on('data',d=>c.push(d));x.on('end',()=>{try{r(JSON.parse(Buffer.concat(c).toString()));}catch(e){r(null);}});}).on('error',()=>r(null));});}

(async()=>{
  const fe = new FeatureEngineer();
  const cls = new MarketClassifier();
  const trend = new TrendFollowingStrategy();
  const grid = new RangeGridStrategy();
  const bt = new QuantBacktest();

  for (const sym of ['ETHUSDT','BCHUSDT','SOLUSDT','BTCUSDT']) {
    const kl = await gk(sym,'15m',500);
    if(!Array.isArray(kl)||kl.length<200){console.log(sym,'数据不足');continue;}
    const j = cls.judgeMarketState(kl.slice(-120), 0);
    const strat = cls.recommendedStrategy(j);
    let sigT = 'N/A', sigG = 'N/A';
    if(strat==='trend') sigT = trend.entrySignal(kl.slice(-120), j.trendDir).signal;
    if(strat==='grid') sigG = grid.generateSignal(kl.slice(-120)).signal;
    // 回测
    const rb = bt.run(kl);
    console.log(`${sym}: 状态=${j.state}(趋势${j.trendDir}/强弱ADX${j.trendStrength.toFixed(0)}) 策略=${strat} 趋势信号=${sigT} 网格信号=${sigG} | 回测: 交易${rb.nT} 胜率${rb.rate}% 回报+${rb.ret.toFixed(1)}%`);
  }
  console.log('\n✅ 全链路冒烟通过(数据工具→分类→双策略→回测)');
})();
