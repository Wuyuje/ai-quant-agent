// 清除所有用户币安真实持仓(布林+大道全部) — 全账户
const fs=require('fs'),path=require('path');
const { decrypt } = require('./core/crypto-utils');
const { BinanceAPI } = require('./lib/common');
const DATA=path.join(__dirname,'data');
const ADMIN=['0xfa3b90c574469909d20848273c06752a22fde74a','0xe6ddf0771c7610dba77eb5a07ba7771dd7f5e91e','0x41c89c7df1ad4c8dd251c5afe45aa1c791fb6ea5','0xc6dbb4cd3b6a12068c7388248da2bd32df7ef9b7'];
let users={};
try{users=JSON.parse(fs.readFileSync(path.join(DATA,'saas-users.json'),'utf8'));}catch(e){}
function findUser(wl){for(const[k,v]of Object.entries(users)){if(k.toLowerCase()===wl.toLowerCase()||k.toLowerCase().startsWith(wl.slice(0,10)))return v;}return null;}
async function closeAll(api,w){
  const pm=await api.getExchangeInfo().catch(()=>null);
  let acc=null;try{acc=await api._request('GET','/fapi/v2/positionRisk');}catch(e){console.log(w+' 查仓失败:'+e.message.slice(0,40));return;}
  const real=Array.isArray(acc)?acc.filter(p=>p.symbol&&p.positionAmt&&Math.abs(+p.positionAmt)>0):[];
  if(!real.length){console.log(w+' 无实仓 ✅');return;}
  for(const p of real){
    const sym=p.symbol,qty=Math.abs(+p.positionAmt),side=+p.positionAmt>0?'LONG':'SHORT';
    try{const r=side==='LONG'?await api.closeLong(sym,qty,pm):await api.closeShort(sym,qty,pm);
      if(r.success)console.log('  ✅ '+w+' 平 '+sym+' '+(side==='LONG'?'多':'空')+' 成功');
      else console.log('  ⚠️ '+w+' 平 '+sym+' 失败:'+r.error);}
    catch(e){console.log('  ⚠️ '+w+' 平 '+sym+' 异常:'+e.message.slice(0,40));}
  }
}
(async()=>{
  // 管理员(统一key) + 普通用户
  const adminApi=new BinanceAPI(process.env.BINANCE_API_KEY,process.env.BINANCE_API_SECRET);
  for(const a of ADMIN){ console.log('管理员 '+a.slice(0,10)); await closeAll(adminApi,a.slice(0,10)); }
  // 普通用户
  for(const[k,u]of Object.entries(users)){
    if(!u.binanceApiKey||!u.binanceSecret)continue;
    const w=k.slice(0,10);
    // 跳过已处理的管理员
    if(ADMIN.some(a=>a.toLowerCase().startsWith(w)))continue;
    console.log('普通 '+w);
    const api=new BinanceAPI(decrypt(u.binanceApiKey),decrypt(u.binanceSecret));
    await closeAll(api,w);
  }
  console.log('\n完成。');
})();
