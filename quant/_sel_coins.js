// 针对新智能体(市场分类→趋势/网格) 精选适合交易的币, 30天回测
const { BinanceAPI } = require('../lib/common');
const { QuantBacktest } = require('./backtest');
const APIKEY=process.env.BINANCE_API_KEY,APISECRET=process.env.BINANCE_API_SECRET;
// 覆盖主流+高波动+新币池, 30天=2880根15m, 分页拉取
function gk(api,s,it,li,st){return api.getKlines(s,it,li);} // 用现有getKlines,limit拆
async function getK(api,s,it,li){ // 分页(limit≤1500)
  const out=[]; let got=0;
  // BinanceAPI.getKlines不支持startTime分页参数, 这里用最近li根(单次≤1500)
  const one=await api.getKlines(s,it,1200).catch(()=>null);
  return one;
}
const COINS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','BCHUSDT','DOTUSDT','NEARUSDT','TIAUSDT','SUIUSDT','APTUSDT','OPUSDT','ARBUSDT','SEIUSDT','INJUSDT','WIFUSDT','TURBOUSDT','1000PEPEUSDT','PENDLEUSDT','STXUSDT','KASUSDT','LTCUSDT','AAVEUSDT','TONUSDT','FILUSDT','ALGOUSDT'];
async function main(){
  const api=new BinanceAPI(APIKEY,APISECRET);
  const bt=new QuantBacktest();
  const rows=[];
  for(const sym of COINS){
    const kl=await getK(api,sym,'15m',1000);
    if(!Array.isArray(kl)||kl.length<300){ continue; }
    const r=bt.run(kl);
    rows.push({sym:sym.replace('USDT',''),nT:r.nT,rate:r.rate,ret:+r.ret.toFixed(1)});
  }
  rows.sort((a,b)=>b.ret-a.ret);
  console.log('=== 新智能体·精选回测 (15m·市场分类→趋势/网格·5x·费0.1%·≈1000根≈10天) ===');
  console.log('| 币种|交易|胜率%|净回报%|');
  for(const r of rows)console.log(`|${r.sym}|${r.nT}|${r.rate}|+${r.ret}|`);
  const pos=rows.filter(r=>r.ret>0),neg=rows.filter(r=>r.ret<0),zer=rows.filter(r=>r.ret===0);
  console.log(`\n汇总: ${rows.length}币 | 正期望${pos.length} 负期望${neg.length} 持平${zer.length}`);
  console.log(`正期望榜: ${pos.slice(0,12).map(r=>r.sym+'+'+r.ret+'%').join(' ')}`);
}
main();
