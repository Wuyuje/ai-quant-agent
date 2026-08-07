const {BinanceAPI}=require('../lib/common');
const {toArray}=require('./featurer');
const {RangeGridStrategy}=require('./grid-strategy');
const APIKEY=process.env.BINANCE_API_KEY,APISECRET=process.env.BINANCE_API_SECRET;
(async()=>{const api=new BinanceAPI(APIKEY,APISECRET);
const kl=await api.getKlines('ETHUSDT','15m',1500);
const gr=new RangeGridStrategy();
const c=toArray(kl).map(k=>+k[3]);
let pos=null,open=0;
for(let i=150;i<c.length;i++){
  const price=c[i];
  if(pos){
    try{ const ge=gr.gridExit(pos,price,pos._rng);
      if(ge.action==='CLOSE'){ console.log(' 平仓@',i,'价',price,'原因',ge.reason); pos=null; } }catch(e){console.log('gridExit err',e.message);pos=null;}
  } else {
    try{ const win=toArray(kl.slice(0,i+1)); const sig=gr.generateSignal(win);
      if(sig.signal!=='NONE'&&sig.side){ pos={side:sig.side,entry:price,_peak:price,_rng:gr.computeRange(win)}; open++; console.log(' 开仓@',i,'价',price,sig.signal); }
    }catch(e){console.log('gen err@'+i,e.message);pos=null;}
  }
}
console.log('总开',open);
})();
