// 多币回测: 新智能体(市场分类+趋势/网格) 看回报率/胜率
const { BinanceAPI } = require('../lib/common');
const { QuantBacktest } = require('./backtest');
const APIKEY=process.env.BINANCE_API_KEY,APISECRET=process.env.BINANCE_API_SECRET;
const COINS=['ETHUSDT','BCHUSDT','ARBUSDT','TURBOUSDT','INJUSDT','1000PEPEUSDT','LINKUSDT','SEIUSDT','WIFUSDT','SOLUSDT','BTCUSDT','DOGEUSDT','XRPUSDT','ADAUSDT','NEARUSDT'];
async function main(){
  const api=new BinanceAPI(APIKEY,APISECRET);
  const bt=new QuantBacktest();
  const rows=[];
  for(const sym of COINS){
    const kl=await api.getKlines(sym,'15m',1000).catch(()=>null); // ~10天
    if(!Array.isArray(kl)||kl.length<300){console.log(sym,'数据不足');continue;}
    const r=bt.run(kl);
    rows.push({sym:sym.replace('USDT',''),nT:r.nT,rate:r.rate,ret:+r.ret.toFixed(1)});
  }
  rows.sort((a,b)=>b.ret-a.ret);
  console.log('=== 新智能体回测 (15m·市场分类→趋势/网格·5x·费0.1%双边·1000根≈10天) ===');
  console.log('| 币种|交易|胜率%|净回报%|');
  for(const r of rows)console.log(`|${r.sym}|${r.nT}|${r.rate}|+${r.ret}|`);
  const posN=rows.filter(r=>r.ret>0).length;
  const totRet=rows.reduce((s,r)=>s+r.ret,0);
  const avgRate=rows.length?Math.round(rows.reduce((s,r)=>s+r.rate,0)/rows.length):0;
  console.log(`\n汇总: ${rows.length}币, 正期望${posN}, 平均净回报+${(totRet/rows.length).toFixed(1)}%, 平均胜率${avgRate}%`);
}
main();
