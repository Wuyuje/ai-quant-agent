// 平掉普通用户所有持仓(布林+大道), 管理员保留
const fs=require('fs'),path=require('path');
const { decrypt } = require('./core/crypto-utils');
const { BinanceAPI } = require('./lib/common');
const DATA=path.join(__dirname,'data');
const ADMIN_PREFIX=['0x41c89c7d','0xc6dbb4cd','0xfa3b90c5'];
let users={};
try{users=JSON.parse(fs.readFileSync(path.join(DATA,'saas-users.json'),'utf8'));}catch(e){}
function isAdmin(w){return ADMIN_PREFIX.some(p=>w.toLowerCase().startsWith(p));}
function findUser(wl){const pref=wl.slice(0,10);for(const[k,v]of Object.entries(users)){if(k.toLowerCase().startsWith(pref)&&k.toLowerCase().startsWith('0x'))return v;}return null;}
(async()=>{
  const targets={};
  // 布林引擎 + 大道至简, 收集普通用户待平仓
  for(const f of fs.readdirSync(DATA)){
    if(!f.endsWith('.json')||!f.startsWith('bb-scalp-')&&!f.startsWith('a-strategy-'))continue;
    const w=f.replace(/^(bb-scalp-|a-strategy-)/,'').replace('.json','');
    if(isAdmin(w)||!w.includes('0x')||w==='sim-state'||w==='monitor'||w.length<10)continue;
    if(w in targets)continue;
    const u=findUser(w);
    if(!u||!u.binanceApiKey||!u.binanceSecret){console.log('  '+w.slice(0,10)+' 无key,跳过');continue;}
    targets[w]=u;
  }
  for(const [w,u] of Object.entries(targets)){
    const api=new BinanceAPI(decrypt(u.binanceApiKey),decrypt(u.binanceSecret));
    const pm=await api.getExchangeInfo().catch(()=>null);
    let acc=null;try{acc=await api._request('GET','/fapi/v2/positionRisk');}catch(e){console.log('  '+w.slice(0,10)+' 查仓失败:'+e.message.slice(0,40));continue;}
    const real=(Array.isArray(acc)?acc.filter(p=>p.symbol&&p.positionAmt&&Math.abs(+p.positionAmt)>0):[]);
    console.log('\n  '+w.slice(0,10)+' 币安实仓: '+ (real.map(p=>p.symbol+':'+(+p.positionAmt>0?'多':'空')).join(', ')||'无'));
    for(const p of real){
      const sym=p.symbol; const qty=Math.abs(+p.positionAmt); const side=+p.positionAmt>0?'LONG':'SHORT';
      try{
        const r=side==='LONG'?await api.closeLong(sym,qty,pm):await api.closeShort(sym,qty,pm);
        if(r.success)console.log('    ✅ 平 '+sym+' '+(side==='LONG'?'多':'空')+' 成功');
        else console.log('    ⚠️ 平 '+sym+' 失败:'+r.error);
      }catch(e){console.log('    ⚠️ 平 '+sym+' 异常:'+e.message.slice(0,40));}
    }
    // 清本地持仓(普通用户全清)
    for(const f of ['bb-scalp-'+w+'.json','a-strategy-'+w+'.json']){
      const p=path.join(DATA,f);
      if(fs.existsSync(p)){try{const st=JSON.parse(fs.readFileSync(p));st.positions={};fs.writeFileSync(p,JSON.stringify(st,null,2));}catch(e){}}
    }
  }
})();
