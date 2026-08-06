/**
 * 引擎2 · 开仓分析引擎 (大道第二层)
 * 对Top8交易对候选币做深度分析: 多时间级别看盘(5m/15m/1h) + 长周期K线 + 多技术指标
 * 判定: 趋势底位反转向上→做多(低买); 趋势高位反转向下→做空(高卖)
 * 只做趋势不做横盘; 方向绝不反
 * 输出: { coin, direction, confidence, 判定依据 }
 */
const https = require('https');

function getK(symbol, interval, limit) {
  return new Promise((resolve) => {
    https.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, (r) => {
      let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{ resolve(JSON.parse(d).map(k=>({c:parseFloat(k[4]),h:parseFloat(k[2]),l:parseFloat(k[3]),v:parseFloat(k[5])}))); }catch(e){ resolve(null); } });
    }).on('error',()=>resolve(null));
  });
}
function ema(c,p){ const k=2/(p+1); let e=c.slice(0,p).reduce((a,b)=>a+b,0)/p; for(let i=p;i<c.length;i++){ e=c[i]*k+e*(1-k);} return e; }
function sma(a,p){ const s=a.slice(-p); return s.reduce((x,y)=>x+y,0)/s.length; }

// ATR%(波动率)
function atrPercent(kl) {
  if (!kl || kl.length<15) return 0;
  let sum=0;
  for (let i=1;i<kl.length;i++){ const tr=Math.max(kl[i].h-kl[i].l, Math.abs(kl[i].h-kl[i-1].c), Math.abs(kl[i].l-kl[i-1].c)); sum+=tr; }
  const atr=sum/(kl.length-1);
  return atr/(Math.abs(kl[kl.length-1].c)||1)*100;
}

// ═══ 加入的全维技术指标(大道·数学计算) ═══
function rsi(closes, period=14){
  if(closes.length<period+1) return 50;
  let gain=0,loss=0;
  for(let i=closes.length-period;i<closes.length;i++){ const d=closes[i]-closes[i-1]; if(d>0)gain+=d; else loss-=d; }
  if(loss===0) return 100;
  const rs=gain/loss; return 100-100/(1+rs);
}
function macd(closes){ const e12=ema(closes,12), e26=ema(closes,26); const dif=e12-e26; const dea=ema(closes.slice(0,closes.length),9)*0; return {dif}; }
function macdFull(closes){ if(closes.length<40) return 0; const e12=ema(closes,12), e26=ema(closes,26); return e12-e26; }  // MACD主线DIF
function bollinger(closes, period=20, mult=2){ const s=closes.slice(-period); const mid=s.reduce((a,v)=>a+v,0)/period; const sd=Math.sqrt(s.reduce((a,v)=>a+(v-mid)*(v-mid),0)/period); return {upper:mid+mult*sd, lower:mid-mult*sd, mid}; }
function adxRaw(kl, period=14){
  // 需真实 high/low; 若传closes则用close近似(会偏低). 这里使用kl含h/l
  if(!kl||kl.length<period*2) return {adx:30,strong:true};
  let pdm=0,mdm=0,atr=0;
  for(let i=1;i<kl.length;i++){
    const up=kl[i].h-kl[i-1].h, dn=kl[i-1].l-kl[i].l;
    if(up>dn&&up>0)pdm+=up; else if(dn>up&&dn>0)mdm+=dn;
    atr+=Math.max(kl[i].h-kl[i].l, Math.abs(kl[i].h-kl[i-1].c), Math.abs(kl[i].l-kl[i-1].c));
  }
  if(atr===0) return {adx:30,strong:true};
  const pdi=pdm/atr*100, mdi=mdm/atr*100;
  const adx=(pdi+mdi)>0?Math.abs(pdi-mdi)/(pdi+mdi)*100:0;
  return {adx, strong:adx>=18};
}
function adx(closes, period=14){ const k=closes.map(c=>({h:c,l:c,c})); return adxRaw(k,period).adx; }
// 量能确认: 最近成交量/>前均量
function volConfirm(k5){ if(k5.length<30) return 1; const vols=k5.map(x=>x.v||0); const avg=vols.slice(-30,-5).reduce((a,b)=>a+b,0)/25; const last=vols[vols.length-1]; return avg>0? last/avg : 1; }

/**
 * 深度分析单币: 结合 5m(拐头)+15m(趋势)+1h(大局) 多时间级别 + 位置/指标
 * 返回: { coin, direction: LONG/SHORT/NONE, confidence, reason }
 * direction 正负判断必须严格: 底位反转向上→LONG; 高位反转向下→SHORT; 横盘/不明→NONE
 */
async function analyzeCoin(coin) {
  // 大道至简: 只做趋势
  // 做多: 底部(位置<0.4) + 趋势向上(MA7/EMA上升) → 开多
  // 做空: 顶部(位置>0.6) + 趋势向下 → 开空
  // 删除所有花哨技术指标(RSI/MACD/布林/ADX/量能等), 只看位置+趋势方向
  const [k5, k15] = await Promise.all([
    getK(coin, '5m', 100), getK(coin, '15m', 80),
  ]);
  if (!k5 || !k15 || k5.length<60) return { coin, direction:'NONE', confidence:0, reason:'数据不足' };
  // 5m MA7
  const c5 = k5.map(x=>x.c);
  const ma5 = []; for(let i=0;i+7<=c5.length;i++) ma5.push(c5.slice(i,i+7).reduce((a,b)=>a+b,0)/7);
  const n5 = ma5.length;
  const pos5 = (ma5[n5-1] - Math.min(...ma5.slice(-100))) / ((Math.max(...ma5.slice(-100))-Math.min(...ma5.slice(-100)))||1);  // 位置0低1高
  const maUp = ma5[n5-1] > ma5[n5-3];   // MA7近期趋势向上
  const maDn = ma5[n5-1] < ma5[n5-3];   // MA7近期趋势向下
  // 15m EMA趋势
  const c15 = k15.map(x=>x.c);
  const e20 = ema(c15,20), e60 = ema(c15,60);
  const trendUp = e20 > e60;
  const trendDn = e20 < e60;
  // 底部趋势向上开多: 位置低(<0.4) + MA7向上 + 15m趋势向上
  if (pos5 < 0.4 && maUp && trendUp) {
    return { coin, direction:'LONG', reason:`底部趋势向上开多(位${Math.round(pos5*100)}%,MA7+15m向上)` };
  }
  // 顶部趋势向下开空: 位置高(>0.6) + MA7向下 + 15m趋势向下
  if (pos5 > 0.6 && maDn && trendDn) {
    return { coin, direction:'SHORT', reason:`顶部趋势向下开空(位${Math.round(pos5*100)}%,MA7+15m向下)` };
  }
  return { coin, direction:'NONE', reason:`未达底部趋势向上/顶部趋势向下(位${Math.round(pos5*100)}%)` };
}

// 对一组候选币做分析, 返回可开仓方向列表
async function analyzeCandidates(coins) {
  const results = [];
  for (const coin of coins) {
    const r = await analyzeCoin(coin);
    if (r.direction !== 'NONE') results.push(r);
  }
  return results;
}

module.exports = { analyzeCoin, analyzeCandidates };
