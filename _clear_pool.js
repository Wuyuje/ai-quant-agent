process.env.ENCRYPTION_KEY='b71383dce992fca07d5de7f77c0e2262d5c6b3dab2e1905edb25caf264c9636b';
const {decrypt}=require('./core/crypto-utils');
const users=JSON.parse(require('fs').readFileSync('data/saas-users.json','utf8'));
const {BinanceAPI}=require('./lib/common');
const POOL=new Set(['APTUSDT','FILUSDT','STXUSDT','TIAUSDT','1000PEPEUSDT','INJUSDT','LINKUSDT','SUIUSDT','ARBUSDT','AVAXUSDT','KASUSDT','ADAUSDT','BTCUSDT']);
const ADM=['0xfa3b90c574469909d20848273c06752a22fde74a','0x41c89c7df1ad4c8dd251c5afe45aa1c791fb6ea5','0xc6dbb4cd3b6a12068c7388248da2bd32df7ef9b7'];
async function clearBad(api,label){
  const pm=await api.getExchangeInfo().catch(()=>null);
  const acc=await api._request('GET','/fapi/v2/positionRisk').catch(()=>null);
  const real=Array.isArray(acc)?acc.filter(p=>p.symbol&&p.positionAmt&&Math.abs(+p.positionAmt)>0):[];
  for(const p of real){
    if(POOL.has(p.symbol)){console.log('  '+label,'保留(池内)',p.symbol);continue;}
    const qty=Math.abs(+p.positionAmt),side=+p.positionAmt>0?'LONG':'SHORT';
    const r=side==='LONG'?await api.closeLong(p.symbol,qty,pm):await api.closeShort(p.symbol,qty,pm);
    console.log('  '+label,'平'+p.symbol.split('USDT')[0],(+p.positionAmt>0?'多':'空'),r.success?'✅平':'❌'+(r.error||''));
  }
}
(async()=>{
  for(const [w,u] of Object.entries(users)){
    if(!u.binanceApiKey&&!u.binanceSecret&&u.isAdmin!==true)continue;
    let api=null;
    if(u.binanceApiKey&&u.binanceSecret){try{api=new BinanceAPI(decrypt(u.binanceApiKey),decrypt(u.binanceSecret));}catch(e){}}
    else if(ADM.includes(w.toLowerCase())){api=new BinanceAPI(process.env.BINANCE_API_KEY,process.env.BINANCE_API_SECRET);}
    if(!api)continue;
    console.log('— '+w.slice(0,12)+' —');
    await clearBad(api,w.slice(0,12));
  }
})();
