const fs=require('fs');
const env=fs.readFileSync('.env','utf8')||'';
env.split('\n').forEach(l=>{l=l.trim();if(!l||l.startsWith('#'))return;const i=l.indexOf('=');if(i>0)process.env[l.slice(0,i).trim()]=l.slice(i+1).trim().replace(/^"|"$/g,'');});
const { BinanceClient } = require('./saas/cex-user-trader.js');
const users = require('./data/saas-users.json');
let adm; for(const k in users){ if(k.toLowerCase().startsWith('0xfa3b90c5')){adm=users[k];break;} }
const client = new BinanceClient(adm.binanceApiKey, adm.binanceSecret);
(async()=>{
  try{
    const pos = await client.getRealPosition('BTCUSDT');
    console.log('BTCUSDT当前持仓:', pos?JSON.stringify({side:pos.side,qty:pos.qty,pnl:pos.pnl}):'无');
  }catch(e){ console.log('查持仓失败:',e.message.slice(0,150)); }
})();
