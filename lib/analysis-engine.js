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
  const [k5, k15, k1h] = await Promise.all([
    getK(coin, '5m', 200), getK(coin, '15m', 100), getK(coin, '1h', 100),
  ]);
  if (!k5 || !k15 || !k1h || k5.length<60) return { coin, direction:'NONE', confidence:0, reason:'数据不足' };

  // ── 5m: MA7拐头 + 近期位置 ──
  const c5 = k5.map(x=>x.c);
  const ma5 = []; for(let i=0;i+7<=c5.length;i++) ma5.push(c5.slice(i,i+7).reduce((a,b)=>a+b,0)/7);
  const n5 = ma5.length;
  const m505 = ma5[n5-1], m4 = ma5[n5-2], m3 = ma5[n5-3];
  // 近位置(5m): 0低1高
  const h5=ma5.slice(-100); const r5=(Math.max(...h5)-Math.min(...h5))||1;
  const pos5=(ma5[n5-1]-Math.min(...h5))/r5;
  const turnUp5 = m505 > m4 && (m505-m4) > (m4-m3);   // MA7向上 + 加速(动量强, 真反转)
  const turnDn5 = m505 < m4 && (m4-m505) > (m3-m4);   // MA7向下 + 加速(动量强, 真反转)
  // 拐头幅度(相对价%) — 用于确认是"真拐头"不是微动
  const turnPct = Math.abs(m505-m4) / (Math.abs(ma5[n5-2])||1) * 100;

  // ── 15m: 趋势方向(EMA20/60) ──
  const c15 = k15.map(x=>x.c);
  const e20_15 = ema(c15,20), e60_15 = ema(c15,60);
  const trendUp15 = e20_15 > e60_15;
  const trendDn15 = e20_15 < e60_15;

  // ── 1h: 长周期方向(EMA20/60) 大局 ──
  const c1h = k1h.map(x=>x.c);
  const e20_1h = ema(c1h,20), e60_1h = ema(c1h,60);
  const trendUp1h = e20_1h > e60_1h;
  const trendDn1h = e20_1h < e60_1h;

  // 波动率(横盘过滤: ATR%小=横盘)
  const atr = atrPercent(k5);
  if (atr < 0.4) return { coin, direction:'NONE', confidence:0, reason:`横盘(波动${atr.toFixed(2)}%过小)` };

  // ── 全维技术指标计算 (大道: 各种技术指标验证) ──
  const rsi5 = rsi(c5, 14);                 // RSI(超卖<30做多偏, 超买>70做空偏)
  const dif = macdFull(c5);                 // MACD主线(做多需dif向上/为正, 做空需向下/为负)
  const bb = bollinger(c5, 20, 2);          // 布林带(做多需低位触下轨, 做空触上轨)
  const adxInfo = adxRaw(k5, 14); const adxVal = adxInfo.adx;   // ADX趋势强度(用真实h/l)
  const vol = volConfirm(k5);               // 量能(>1放量)
  // 方向共振打分(正=偏多, 负=偏空)
  const price=c5[c5.length-1];

  // ── 强主判定(多级别双确认+动量+全维指标, 方向绝不反, 杜绝假反弹) ──
  // 反转持续确认: MA7 已连续3根同向(真趋势启动, 非1根假反弹)
  const upStreak = ma5[n5-1]>ma5[n5-2] && ma5[n5-2]>ma5[n5-3] && ma5[n5-3]>ma5[n5-4];
  const dnStreak = ma5[n5-1]<ma5[n5-2] && ma5[n5-2]<ma5[n5-3] && ma5[n5-3]<ma5[n5-4];
  // ── 平衡方案(方向不反核心 + 次要指标2-3个确认即可) ──
  // 核心(必须): 底位反转做多/高位反转做空 + 双级别趋势方向一致
  // 次要指标(至少满足2个): RSI不极端逆 + MACD同向 + 布林位置 + ADX趋势 + 量能
  const coreLong  = pos5<0.45 && turnUp5 && turnPct>=0.07 && (trendUp15 && trendUp1h);   // 低位+反转加速+双级别向上(核心)
  const coreShort = pos5>0.55 && turnDn5 && turnPct>=0.07 && (trendDn15 && trendDn1h);   // 高位+反转加速+双级别向下(核心)
  // 次要指标打分(每满足1个+1)
  const secScoreLong = (rsi5<72?1:0) + (dif>=-0.3?1:0) + (price<=1.01*bb.mid?1:0) + (adxVal>=10?1:0) + (vol>=0.6?1:0);
  const secScoreShort= (rsi5>28?1:0) + (dif<=0.3?1:0) + (price>=0.99*bb.mid?1:0) + (adxVal>=10?1:0) + (vol>=0.6?1:0);
  if (coreLong && secScoreLong>=3) {
    return { coin, direction:'LONG', confidence:0.85, reason:`低买(位${Math.round(pos5*100)}%,双级别多,次指标${secScoreLong}/5,RSI${rsi5.toFixed(0)},ADX${adxVal.toFixed(0)},量${vol.toFixed(1)}=做多)` };
  }
  if (coreShort && secScoreShort>=3) {
    return { coin, direction:'SHORT', confidence:0.85, reason:`高卖(位${Math.round(pos5*100)}%,双级别空,次指标${secScoreShort}/5,RSI${rsi5.toFixed(0)},ADX${adxVal.toFixed(0)},量${vol.toFixed(1)}=做空)` };
  }
  return { coin, direction:'NONE', confidence:0, reason:`未达平衡反转(位${Math.round(pos5*100)}%,次指标${coreLong?secScoreLong:(coreShort?secScoreShort:'-')}/5,RSI${rsi5.toFixed(0)},ADX${adxVal.toFixed(0)},量${vol.toFixed(1)})` };
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
