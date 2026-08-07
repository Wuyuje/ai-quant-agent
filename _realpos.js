const fs=require('fs'),path=require('path');
const { decrypt } = require('./core/crypto-utils');
const { BinanceAPI } = require('./lib/common');
const DATA=path.join(__dirname,'data');
const KEEP=['BLESSUSDT','SKYAIUSDT','PTBUSDT'];
const ADMIN=['0xfa3b90c574469909d20848273c06752a22fde74a'];
let users={};
try{users=JSON.parse(fs.readFileSync(path.join(DATA,'saas-users.json'),'utf8'));}catch(e){}
(async()=>{
  for(const file of fs.readdirSync(DATA)){
    if(!file.startsWith('bb-scalp-')||!file.endsWith('.json'))continue;
    const wallet=file.replace('bb-scalp-','').replace('.json','');
    const wl=wallet.toLowerCase();
    let apiKey,apiSecret;
    if(ADMIN.includes(wl)){ apiKey=process.env.BINANCE_API_KEY; apiSecret=process.env.BINANCE_API_SECRET; }
    else { let u=null;const pref=wl.slice(0,10);for(const[k,v]of Object.entries(users)){if(k.toLowerCase().startsWith(pref)&&k.toLowerCase().startsWith('0x')){u=v;break;}}
      apiKey=decrypt(u?.binanceApiKey);apiSecret=decrypt(u?.binanceSecret); }
    if(!apiKey){console.log(wallet.slice(0,10),'无key');continue;}
    const api=new BinanceAPI(apiKey,apiSecret);
    try{
      const acc=await api._request('GET','/fapi/v2/positionRisk');
      const pos=Array.isArray(acc)?acc.filter(p=>p.positionAmt&&Math.abs(+p.positionAmt)>0):[];
      for(const p of pos) console.log(`${wallet.slice(0,10)} ${p.symbol} amt=${p.positionAmt} side=${+p.positionAmt>0?'LONG':'SHORT'}`);
      if(!pos.length) console.log(`${wallet.slice(0,10)} 无实仓`);
    }catch(e){ console.log(`${wallet.slice(0,10)} 查询失败:${e.message.slice(0,50)}`); }
  }
})();
