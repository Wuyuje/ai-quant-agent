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
  const turnUp5 = m505 > m4;      // MA7最新向上(可能底反转)
  const turnDn5 = m505 < m4;      // MA7最新向下(可能顶反转)

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

  // ── 综合判定 (大道: 多时间级别确认; 至简: 底位做多/高位做空) ──
  // 做空(高卖): 5m位置高位(pos5>0.6) + 5m MA7拐头向下 + 15m/1h趋势偏下或转下 → SHORT
  if (pos5 > 0.6 && turnDn5 && (trendDn15 || trendDn1h)) {
    return { coin, direction:'SHORT', confidence: 0.8, reason:`高位(${Math.round(pos5*100)}%)反转向下+15m/1h偏空=高卖做空` };
  }
  // 做多(低买): 5m位置低位(pos5<0.4) + 5m MA7拐头向上 + 15m/1h趋势偏上或转上 → LONG
  if (pos5 < 0.4 && turnUp5 && (trendUp15 || trendUp1h)) {
    return { coin, direction:'LONG', confidence: 0.8, reason:`低位(${Math.round(pos5*100)}%)反转向上+15m/1h偏多=低买做多` };
  }
  // 次强: 位置极端+拐头明确(虽趋势未全确认, 但位置极端给方向)
  if (pos5 < 0.25 && turnUp5) return { coin, direction:'LONG', confidence:0.65, reason:`极低位(${Math.round(pos5*100)}%)拐头向上=低买` };
  if (pos5 > 0.75 && turnDn5) return { coin, direction:'SHORT', confidence:0.65, reason:`极高位(${Math.round(pos5*100)}%)拐头向下=高卖` };
  return { coin, direction:'NONE', confidence:0, reason:`未达底/顶反转条件(位${Math.round(pos5*100)}%,波动${atr.toFixed(2)}%)` };
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
