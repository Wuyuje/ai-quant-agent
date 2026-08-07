// 平掉布林引擎非精选3只币(BLESS/SKYAI/PTB)的老仓位(币安真实平仓+清本地状态)
const fs=require('fs'), path=require('path');
const { decrypt } = require('./core/crypto-utils');
const { BinanceAPI } = require('./lib/common');
const DATA=path.join(__dirname,'data');
const KEEP=['BLESSUSDT','SKYAIUSDT','PTBUSDT'];
const adminApiKey=process.env.BINANCE_API_KEY||'';
const adminApiSecret=process.env.BINANCE_API_SECRET||'';
const ADMIN=['0xfa3b90c574469909d20848273c06752a22fde74a'];
let users={};
try{users=JSON.parse(fs.readFileSync(path.join(DATA,'saas-users.json'),'utf8'));}catch(e){}

(async()=>{
  let total=0, ok=0, fail=0;
  for(const file of fs.readdirSync(DATA)){
    if(!file.startsWith('bb-scalp-')||!file.endsWith('.json'))continue;
    const wallet=file.replace('bb-scalp-','').replace('.json','');
    let st={};
    try{st=JSON.parse(fs.readFileSync(path.join(DATA,file),'utf8'));}catch(e){continue;}
    const pos=st.positions||{};
    const toClose=Object.keys(pos).filter(s=>!KEEP.includes(s));
    if(!toClose.length){console.log('  '+wallet.slice(0,10)+' 无非3只仓,跳过');continue;}
    // 取key
    let apiKey,apiSecret;
    const wl=wallet.toLowerCase();
    if(ADMIN.includes(wl)){ apiKey=adminApiKey; apiSecret=adminApiSecret; }
    else { // 按前缀匹配(状态文件名=wallet前10字符)
      let u=null; const pref=wl.slice(0,10);
      for(const [k,v] of Object.entries(users)){ if(k.toLowerCase().startsWith(pref)&&k.toLowerCase().startsWith('0x')){ u=v; break; } }
      if(!u||!u.binanceApiKey||!u.binanceSecret){ console.log('  '+wallet.slice(0,10)+' 无key,跳过'); continue; }
      apiKey=decrypt(u.binanceApiKey); apiSecret=decrypt(u.binanceSecret);
    }
    const api=new BinanceAPI(apiKey,apiSecret);
    const pm=await api.getExchangeInfo().catch(()=>null);
    for(const sym of toClose){
      total++;
      const p=pos[sym];
      try{
        const r= p.side==='LONG'? await api.closeLong(sym,p.qty,pm) : await api.closeShort(sym,p.qty,pm);
        if(r.success){ delete pos[sym]; ok++; console.log('  ✅ '+wallet.slice(0,10)+' '+sym.slice(0,8)+' '+p.side+' 平仓成功'); }
        else { fail++; console.log('  ⚠️ '+wallet.slice(0,10)+' '+sym.slice(0,8)+' 平仓失败:'+r.error); }
      }catch(e){ fail++; console.log('  ⚠️ '+wallet.slice(0,10)+' '+sym.slice(0,8)+' 异常:'+e.message.slice(0,40)); }
    }
    st.positions=pos;
    fs.writeFileSync(path.join(DATA,file),JSON.stringify(st,null,2));
  }
  console.log('\n===== 汇总 =====');
  console.log('待平 '+total+' | 成功 '+ok+' | 失败 '+fail);
})();
