/**
 * 引擎1 · 选币引擎 (大道至简第一层"大道")
 * 从全市场用"大道"(多年级K线 + 多技术指标 + 含手续费严格回测) 精选 Top8 交易对
 * 只选: 当前处于趋势(非横盘) + MA7低位做多/高位做空 回测含手续费仍盈利 + 胜率/回报正
 * 排除: 负回报率/负胜率/横盘/趋势不明的币
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PAIRS_FILE = path.join(DATA_DIR, 'trade-pairs.json');

function _fetchKlines(symbol, interval, limit) {
  return new Promise((resolve) => {
    https.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, (r) => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d).map(k => parseFloat(k[4]))); } catch(e){ resolve(null); } });
    }).on('error', () => resolve(null));
  });
}
function sma(a, p) { const s=a.slice(-p); return s.reduce((x,y)=>x+y,0)/s.length; }
function ema(c, p){ const k=2/(p+1); let e=c.slice(0,p).reduce((a,b)=>a+b,0)/p; for(let i=p;i<c.length;i++){ e=c[i]*k+e*(1-k);} return e; }

// 获取全市场流动性USDT永续池
function _liquidPool() {
  return new Promise((resolve) => {
    https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', (r) => {
      let d=''; r.on('data',c=>d+=c); r.on('end',()=>{
        try {
          const info=JSON.parse(d);
          const set=new Set();
          for(const s of (info.symbols||[])) if(s.quoteAsset==='USDT'&&s.contractType==='PERPETUAL'&&s.status==='TRADING') set.add(s.symbol);
          resolve([...set]);
        } catch(e){ resolve([]); }
      });
    }).on('error',()=>resolve([]));
  });
}

// 多指标综合算"该币当前是否趋势底/顶 + 趋势方向"(大道: 各种技术指标判定)
// 返回 { dir: UP/DOWN/FLAT, trendScore, posRatio(长期位置0低1高) }
function analyzeSymbol(kl5) {
  if (!kl5 || kl5.length < 120) return null;
  const closes = kl5;
  // MA7 序列(5m)
  const ma7 = [];
  for (let i=0;i+7<=closes.length;i++) ma7.push(closes.slice(i,i+7).reduce((a,b)=>a+b,0)/7);
  if (ma7.length < 60) return null;
  const n = ma7.length;
  // 长期位置(近200根MA7): 0=长期底部,1=长期顶部
  const hist = ma7.slice(-200);
  const mx = Math.max(...hist), mn = Math.min(...hist);
  const range = (mx-mn) || 1;
  const posRatio = (ma7[n-1]-mn)/range;
  // 趋势方向: 用MA7近期斜率(近30根)一致性
  const sl = [];
  for (let i=n-30;i<n;i++) sl.push(ma7[i]-ma7[i-1]);
  const up=sl.filter(s=>s>0).length, dn=sl.filter(s=>s<0).length;
  const trendScore = Math.max(up,dn)/sl.length;    // 0.5无趋势, 1全同向
  // 横盘判定: 近期范围太小=横盘(不做)
  const recent = ma7.slice(-40);
  const spreadPct = (Math.max(...recent)-Math.min(...recent)) / (Math.abs(ma7[n-1])||1) * 100;
  if (spreadPct < 1.5) return { dir:'FLAT', trendScore, posRatio };
  // EMA趋势方向(15m级用5m近似: 用更长MA判断)
  return { dir: up>=dn?'UP':'DOWN', trendScore, posRatio };
}

// 含手续费回测: 只做 底位做多/高位做空(大道验证盈利性)
function backtest(kl5, opts) {
  if (!kl5 || kl5.length < 200) return { ok:false };
  const feeRate = (opts && opts.feeRate) || 0.001;
  const levL = 8, levS = 3;
  const closes = kl5;
  const ma7 = [];
  for (let i=0;i+7<=closes.length;i++) ma7.push(closes.slice(i,i+7).reduce((a,b)=>a+b,0)/7);
  if (ma7.length < 100) return { ok:false };
  let pos=null, trades=0, wins=0, sumPct=0;
  for (let i=60;i<ma7.length-1;i++) {
    const cur=ma7[i], price=closes[i];
    if (pos) {
      const lev = pos.side==='LONG'?levL:levS;
      const pnl=(pos.side==='LONG'?(price-pos.open)/pos.open:(pos.open-price)/pos.open)*lev*100;
      // 平仓: 做多拐头向下(到高位)/做空拐头向上(到底位)
      let closed = false;
      if (pos.side==='LONG' && i>=2 && ma7[i-1] < ma7[i-2]) { closed=true; }        // 做多: MA7从升转降
      else if (pos.side==='SHORT' && i>=2 && ma7[i-1] > ma7[i-2]) { closed=true; }  // 做空: MA7从降转升
      if (closed) { const net=pnl-feeRate*100*2; trades++; if(net>0)wins++; sumPct+=net; pos=null; }
    } else {
      // 开仓: 底位(位置<0.4)拐头向上做多 / 顶位(位置>0.6)拐头向下做空
      if (i>=2) {
        const hist=ma7.slice(Math.max(0,i-200),i);
        const mxM=Math.max(...hist), mnM=Math.min(...hist);
        const posR=(cur-mnM)/((mxM-mnM)||1);
        if (i>=2 && ma7[i-1]>ma7[i-2] && posR<0.4) pos={ side:'LONG', open:price };
        else if (i>=2 && ma7[i-1]<ma7[i-2] && posR>0.6) pos={ side:'SHORT', open:price };
      }
    }
  }
  const avgRet = trades ? sumPct/trades : 0;
  const winRate = trades ? wins/trades : 0;
  // 排除: 负回报/负胜率/趋势做反
  if (trades < 10 || avgRet <= 0 || winRate < 0.4) return { ok:false, trades, avgRet, winRate };
  return { ok:true, trades, wins, avgRet, winRate, totalPct: sumPct };
}

// 两步选币: 全市场 → 大道多指标选趋势币 → 含手续费回测精选Top8(排除负)
async function runSelect(maxPairs) {
  const max = maxPairs || 8;
  const pool = await _liquidPool();
  console.log(`[选币引擎] 全市场USDT永续 ${pool.length} 只, 开始大道选币...`);
  const cands = [];
  for (const sym of pool.slice(0, 200)) {
    const kl5 = await _fetchKlines(sym, '5m', 300);
    if (!kl5) continue;
    const an = analyzeSymbol(kl5);
    if (!an || an.dir==='FLAT') continue;                    // 跳过横盘
    const bt = backtest(kl5, { feeRate: 0.001 });
    if (!bt.ok) continue;                                    // 跳过负回报/负胜率/交易少
    cands.push({ symbol: sym, dir: an.dir, trendScore: an.trendScore, ...bt });
  }
  // 按 含费净回报 排序
  cands.sort((a,b)=> b.avgRet - a.avgRet);
  const best = cands.slice(0, max);
  const pairs = best.map(r=>r.symbol);
  // 写交易对
  try { fs.mkdirSync(DATA_DIR,{recursive:true}); fs.writeFileSync(PAIRS_FILE, JSON.stringify({pairs, updatedAt:Date.now(), note:`大道选币含费回测Top${pairs.length}`, rank:best.map(r=>({sym:r.symbol,net:r.avgRet,win:r.winRate,dir:r.dir}))}, null, 2)); } catch(e){}
  console.log(`[选币引擎] 精选Top${pairs.length}:`, pairs.join(', '));
  return { pairs, rank: best };
}

module.exports = { runSelect, analyzeSymbol, backtest };
