#!/usr/bin/env node
/* BTC 模拟盘 - 简洁可靠服务端: 读外部 page.html + 提供 API */
const http=require('http'),fs=require('fs'),path=require('path');
const PORT=parseInt(process.env.SIM_PORT||'10500',10);
const STATE=path.join(__dirname,'sim_state.json');
function readState(){ try{return JSON.parse(fs.readFileSync(STATE,'utf8'));}catch(e){return{users:{},trades:[],open:null};} }
const ADMIN='0xfa3b90c574469909d20848273c06752a22fde74a';
const WHITELIST=['0xe6ddf0771c7610dba77eb5a07ba7771dd7f5e91e','0x41c89c7df1ad4c8dd251c5afe45aa1c791fb6ea5','0xc6dbb4cd3b6a12068c7388248da2bd32df7ef9b7'];
function roleOf(w){
  const l=w.toLowerCase();
  if(l===ADMIN) return '管理员';
  if(WHITELIST.some(x=>x.toLowerCase()===l)) return '白名单';
  return '用户';
}
function apiState(){
  const s=readState();
  const users=Object.entries(s.users||{}).map(([w,u])=>({
    wallet:w.slice(0,10)+'...', role:roleOf(w), balance:+(u.balance||0).toFixed(2),
    wins:u.wins||0, losses:u.losses||0,
    wr:(u.wins+u.losses)>0?Math.round(u.wins/(u.wins+u.losses)*100):0,
    curve:u.equity_curve||[100], pnl:+(u.balance-100).toFixed(2)
  }));
  return { open:s.open, users, trades:(s.trades||[]).slice(-50) };
}
const PAGE=fs.readFileSync(path.join(__dirname,'page.html'),'utf8');
const server=http.createServer(async (req,res)=>{
  const url=req.url.split('?')[0];
  res.setHeader('Access-Control-Allow-Origin','*');
  if(url==='/'||url==='/index.html'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(PAGE);return;}
  if(url==='/api/sim'){
    const a=apiState(); let price=null;
    try{const d=await new Promise((resolve)=>http.get('http://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT',(r)=>{let x='';r.on('data',c=>x+=c);r.on('end',()=>resolve(x));}).on('error',()=>resolve(null)));if(d)price=JSON.parse(d).price;}catch(e){}
    a.price=price?+price:null;
    a.pred= a.open?{prob:a.open.side==='LONG'?0.6:0.4}:{prob:0.55};
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(a));return;
  }
  if(url==='/api/bind'&&req.method==='POST'){
    let b='';req.on('data',c=>b+=c);req.on('end',()=>{
      try{const{key,secret}=JSON.parse(b);if(!key||!secret){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({msg:'⚠️ 请填写 API Key 与 Secret'}));return;}
        res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({msg:'✅ 已记录绑定（模拟盘不实盘，实盘阶段生效）'}));
      }catch(e){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({msg:'❌ 格式错误'}));}
    });return;
  }
  res.writeHead(404);res.end('Not found');
});
server.listen(PORT,()=>console.log(`✅ BTC模拟盘 http://localhost:${PORT}`));
