// 只读验证管理员binance API key(查询余额, 不产生任何交易)
// 手动加载 .env 设置 ENCRYPTION_KEY
const fs=require('fs');
const env=fs.readFileSync('.env','utf8')||'';
env.split('\n').forEach(l=>{ 
  l=l.trim(); if(!l||l.startsWith('#'))return; 
  const i=l.indexOf('='); if(i>0){process.env[l.slice(0,i).trim()]=l.slice(i+1).trim().replace(/^"|"$/g,'');}
});
if(!process.env.ENCRYPTION_KEY){console.log('❌ .env无ENCRYPTION_KEY, keys是明文/未加密');}
const { BinanceClient } = require('./saas/cex-user-trader.js');
const users = require('./data/saas-users.json');
function findAdmin(){ for(const k in users){ if(k.toLowerCase().startsWith('0xfa3b90c5')) return users[k]; } return null; }
const adm = findAdmin();
if(!adm){ console.log('❌ 未找到管理员'); process.exit(1); }
const client = new BinanceClient(adm.binanceApiKey, adm.binanceSecret);
client.getBalance().then(b=>{
  if(Array.isArray(b)){
    console.log('✅ API key 有效! 查询成功');
    const usdt = b.find(x=>x.asset==='USDT');
    const all = b.filter(x=>parseFloat(x.balance)>0);
    console.log('  非零资产:', all.length+'种');
    if(usdt) console.log('  USDT余额:', usdt.balance, '| 可用:', usdt.availableBalance);
    all.slice(0,8).forEach(x=>console.log('   '+x.asset, x.balance));
  } else console.log('  返回:', JSON.stringify(b).slice(0,300));
}).catch(e=>console.log('❌ 余额查询失败:', e.message.slice(0,240)));
