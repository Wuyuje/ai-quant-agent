/**
 * TradePairManager — 动态交易对管理 & 表现记录
 *
 * 作用：
 * 1. 交易对从数据文件读取/写入（不写死代码，可动态回测更新）
 * 2. 记录每只币实际交易表现（胜率/盈亏/回报率）作为以后选币参考
 * 3. 支持周期性回测更新交易对（记录回测依据）
 *
 * 数据文件：
 *   - data/trade-pairs.json        当前交易对 + 回测/选币依据
 *   - data/trade-perf.json         每只币实际交易表现累积
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PAIRS_FILE = path.join(DATA_DIR, 'trade-pairs.json');
const PERF_FILE  = path.join(DATA_DIR, 'trade-perf.json');

// 当前默认交易对(可由配置文件覆盖)
const DEFAULT_PAIRS = ['HFTUSDT','1000SATSUSDT','VICUSDT','BICOUSDT','PTBUSDT','BLESSUSDT','1000RATSUSDT','ARBUSDT'];

// 候选币池: 流动性好的USDT永续(供动态回测选币, 可扩充交易对至上限)
const CANDIDATE_UNIVERSE = [
  // 已在案 8 只
  'HFTUSDT','1000SATSUSDT','VICUSDT','BICOUSDT','PTBUSDT','BLESSUSDT','1000RATSUSDT','ARBUSDT',
  // 备选高流动性潜力币
  'SKYAIUSDT','VANRYUSDT','BANKUSDT','KOMAUSDT','HOMEUSDT','NEIROUSDT','1000PEPEUSDT','PEOPLEUSDT',
  'WIFUSDT','DOGEUSDT','PEPEUSDT','SHIBUSDT','XLMUSDT','ADAUSDT','TONUSDT','SUIUSDT',
  'AAVEUSDT','LINKUSDT','AVAXUSDT','SOLUSDT','INJUSDT','TIAUSDT','JUPUSDT','OPUSDT',
  'WAXUSDT','COTIUSDT','PENGUUSDT','SPELLUSDT','1000BONKUSDT','FLOKIUSDT','TURBOUSDT'
];
// 默认交易对上限(可由调用方覆盖)
const DEFAULT_MAX_PAIRS = 20;
const KLINE = { interval: '5m', limit: 200 };
function _fetchKlines(symbol, interval, limit) {
  return new Promise((resolve) => {
    const https = require('https');
    const url = 'https://fapi.binance.com/fapi/v1/klines?symbol=' + symbol + '&interval=' + (interval||'5m') + '&limit=' + (limit||200);
    https.get(url, (r) => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d).map(k => ({ c: parseFloat(k[4]) }))); } catch(e){ resolve(null); } });
    }).on('error', () => resolve(null));
  });
}
// 用真实K线回测某币: 按MA7拐头策略(上拐做多/下拐做空/反向平/8%止损/移止盈2%)计算净盈亏%
function backtestSymbol(symbol, opts) {
  return _fetchKlines(symbol, opts && opts.interval, opts && opts.limit).then((kl) => {
    if (!kl || kl.length < 120) return { symbol, ok: false, reason: 'K线不足' };
    const o = opts || {};
    const feeRate = (o.feeRate || 0.001);          // 手续费+滑点(0.1%每边, 含往返≈0.2%)
    const levL = o.longLev || 8, levS = o.shortLev || 3;
    // 只做"低买高卖做多 / 高卖低买做空"的当前趋势(不含其它止盈止损)
    const closes = kl.map(x => x.c);
    let pos = null, trades = 0, wins = 0, sumPct = 0;
    for (let i = 6; i < closes.length - 1; i++) {
      const curMA = (() => { const a = closes.slice(i - 5, i + 1); return a.reduce((x, y) => x + y, 0) / 7; })();
      const prevMA = (() => { const a = closes.slice(i - 6, i); return a.reduce((x, y) => x + y, 0) / 7; })();
      const price = closes[i + 1];
      if (pos) {
        const lev = pos.side === 'LONG' ? levL : levS;
        const pnl = (pos.side === 'LONG' ? (price - pos.open) / pos.open : (pos.open - price) / pos.open) * lev * 100;
        // 平仓: MA7反向拐头(低买高卖做多→拐头向下平; 高卖低买做空→拐头向上平)
        let close = (pos.side === 'LONG' && curMA < prevMA) || (pos.side === 'SHORT' && curMA > prevMA);
        if (close) {
          // 扣手续费(0.1%每边, 往返0.2%)
          const netPnl = pnl - feeRate * 100 * 2;
          trades++; if (netPnl > 0) wins++; sumPct += netPnl;
          pos = null;
        }
      } else {
        // 开仓: MA7上拐做多(低买) / 下拐做空(高卖)
        if (curMA > prevMA) pos = { side: 'LONG', open: price };
        else if (curMA < prevMA) pos = { side: 'SHORT', open: price };
      }
    }
    const ret = trades ? sumPct / trades : 0;
    return { symbol, ok: true, trades, wins, losses: trades - wins,
      winRate: trades ? +(wins / trades * 100).toFixed(1) : 0,
      totalPct: +sumPct.toFixed(2), avgReturnPerTrade: +ret.toFixed(2) };
  });
}

// 两步选币: 1)全市场按当前MA7趋势质量选Top20  2)含手续费回测这20只, 精选Top8作交易对
async function refreshPairs(opts) {
  const max = (opts && opts.maxPairs) || 8;        // 最终交易对 = Top8
  const prese = (opts && opts.preSelect) || 20;    // 第一步先选Top20趋势质量最高的
  const curPairs = getPairs().pairs || [];
  // 全市场流动性币池
  let pool = CANDIDATE_UNIVERSE.slice();
  try {
    const all = await getAllLiquidPairs({ minVolume: (opts && opts.minVolume) || 1e7 });
    if (all && all.length) pool = all;
  } catch(e) {}
  pool = [...new Set([...curPairs, ...pool])];
  // 第一步: 按趋势质量(trendQualityScore)选Top20
  const trendRows = [];
  for (const sym of pool.slice(0, 150)) {
    try { const sc = await trendQualityScore(sym); if (sc && sc.ok) trendRows.push({ symbol: sym, q: sc.q }); } catch(e) {}
  }
  trendRows.sort((a,b) => b.q - a.q);
  const top20 = trendRows.slice(0, prese).map(r => r.symbol);
  // 第二步: 对Top20做含手续费回测, 精选Top8(净回报率最高)
  const btRows = [];
  for (const sym of top20) {
    const bt = await backtestSymbol(sym, { feeRate: opts && opts.feeRate || 0.001 });
    if (bt && bt.ok && bt.trades >= 5) {   // 要求至少5笔有效交易
      btRows.push({ symbol: sym, netRetPer: bt.avgReturnPerTrade, bt });
    }
  }
  btRows.sort((a,b) => b.netRetPer - a.netRetPer);
  const best = btRows.slice(0, max);
  const newPairs = best.map(r => r.symbol);
  const changed = JSON.stringify(newPairs) !== JSON.stringify(curPairs);
  if (changed) updatePairs(newPairs, '两步选币: 全市场趋势质量Top'+prese+'→含手续费回测精选Top'+newPairs.length);
  return { pairs: newPairs, previous: curPairs, changed, ranked: best.map(r => ({ symbol: r.symbol, netRetPer: +(r.netRetPer||0).toFixed(2), ...(r.bt.ok ? { btWinRate: r.bt.winRate, btTrades: r.bt.trades } : {}) })) };
}

// 评估某币"当前MA7趋势质量": 趋势方向动量强+非横盘=高, 横盘/无趋势=低/拒
async function trendQualityScore(symbol) {
  const kl = await _fetchKlines(symbol, '5m', 120);
  if (!kl || kl.length < 80) return { ok:false };
  const closes = kl.map(x=>x.c);
  const ma = [];
  for (let i = 0; i + 7 <= closes.length; i++) ma.push(closes.slice(i,i+7).reduce((a,b)=>a+b,0)/7);
  if (ma.length < 40) return { ok:false };
  const n = ma.length;
  // 用近段MA7斜率方向一致性(持续同向=趋势强)
  const sl = [];
  for (let i = Math.max(0,n-16); i < n; i++) sl.push(ma[i]-ma[i-1]);
  const upCount = sl.filter(s=>s>0).length;
  const dnCount = sl.filter(s=>s<0).length;
  const total = sl.length || 1;
  const direction = upCount >= dnCount ? 'UP' : 'DOWN';
  const dominant = Math.max(upCount,dnCount)/total;   // 0.5=无趋势, 1=全同向
  // 波动/横盘判定: 近16根MA7范围不能太小(横盘)
  const recent = ma.slice(-16);
  const range = Math.max(...recent) - Math.min(...recent);
  const rangePct = range / (Math.abs(ma[n-1])||1) * 100;
  if (rangePct < 0.8) return { ok:false };           // 区间<0.8% 横盘, 不做
  // 趋势质量分: 方向一致性*幅度(0~1, 越高趋势越清晰)
  const q = dominant * (direction==='UP' ? 1 : 1);
  // 额外加分: 趋势幅度适中(太弱无意义)
  if (rangePct < 1.2) return { ok:false };           // 波动太弱仍拒
  return { ok:true, q, dir: direction };
}


function _read(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) {}
  return fallback;
}
function _write(file, data) {
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch(e) {}
}

// 读取当前交易对(含选币依据/上次回测时间)
function getPairs() {
  const d = _read(PAIRS_FILE, {});
  if (d.pairs && Array.isArray(d.pairs) && d.pairs.length > 0) return d;
  return { pairs: DEFAULT_PAIRS, updatedAt: Date.now(), note: '初始v2夹角回测选币', history: [] };
}

// 更新交易对 + 记录选币依据和历史
function updatePairs(pairs, basis) {
  const d = getPairs();
  const now = Date.now();
  if (!d.history) d.history = [];
  d.history.push({ time: now, pairs: [...pairs], basis: basis || '回测更新' });
  if (d.history.length > 50) d.history = d.history.slice(-50); // 保留最近50次
  d.pairs = pairs;
  d.updatedAt = now;
  _write(PAIRS_FILE, d);
  return d;
}

// 记录某只币的一笔实际交易表现
function recordTrade(symbol, wallet, side, pnlUsd, pnlPct, strategy) {
  const perf = _read(PERF_FILE, { coins: {} });
  if (!perf.coins[symbol]) perf.coins[symbol] = { count: 0, wins: 0, losses: 0, totalPnl: 0, avgPnlPct: [], lastTrade: 0 };
  const c = perf.coins[symbol];
  c.count++;
  if (pnlUsd > 0) c.wins++; else c.losses++;
  c.totalPnl += pnlUsd;
  c.lastTrade = Date.now();
  if (!c.perSymbolCount) c.perSymbolCount = {};
  if (!perf.coins[symbol].byStrategy) perf.coins[symbol].byStrategy = {};
  // 累计胜率/回报
  const rec = { time: Date.now(), wallet: wallet||'admin', side, pnlUsd, pnlPct };
  if (!perf.symbols) perf.symbols = {};
  if (!perf.symbols[symbol]) perf.symbols[symbol] = [];
  perf.symbols[symbol].push(rec);
  if (perf.symbols[symbol].length > 200) perf.symbols[symbol] = perf.symbols[symbol].slice(-200);
  _write(PERF_FILE, perf);
  return perf.coins[symbol];
}

// 获取每只币的表现(统计胜率/回报率)——选币参考
function getPerf() {
  const p = _read(PERF_FILE, { symbols: {} });
  const result = {};
  for (const [sym, records] of Object.entries(p.symbols || {})) {
    if (!Array.isArray(records) || records.length === 0) continue;
    const wins = records.filter(r => r.pnlUsd > 0).length;
    const totalPnl = records.reduce((s, r) => s + (r.pnlUsd || 0), 0);
    result[sym] = {
      count: records.length,
      winRate: Math.round(wins / records.length * 100),
      totalPnl: Math.round(totalPnl * 100) / 100,
      lastTime: records[records.length - 1].time,
    };
  }
  return result;
}

// 生成选币建议: 根据实际表现 + 回测, 排出表现好的币
function suggestPairs() {
  const perf = getPerf();
  const pairs = getPairs().pairs;
// 结合: 当前在途交易对的实测表现 + 回测推荐
  return { current: pairs, perf, suggested: Object.entries(perf).filter(([s,p]) => p.count >= 3 && p.totalPnl > 0).sort((a,b) => b[1].totalPnl - a[1].totalPnl).map(([s]) => s) };
}

// ── 全市场选币: 从币安全市场 USDT 永续里, 过滤出流动性足够的币(趋势可选币池) ──
let _allMarketCache = { coins: [], t: 0 };
function _fetchJSON(url) {
  return new Promise((resolve) => {
    const https = require('https');
    https.get(url, (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{ resolve(JSON.parse(d)); }catch(e){ resolve(null); } }); }).on('error', ()=>resolve(null));
  });
}
// 全市场USDT永续(带流动性过滤), 返回 [{symbol, quoteVolume}] 按成交额降序
async function getAllLiquidPairs(opts) {
  const minVol = (opts && opts.minVolume) || 1e7;          // 默认24h成交额≥1000万USDT
  const cacheMs = (opts && opts.cacheMs) || 30*60*1000;    // 缓存30分钟降API压力
  if (_allMarketCache.coins.length && Date.now() - _allMarketCache.t < cacheMs) return _allMarketCache.coins;
  const [info, tickers] = await Promise.all([
    _fetchJSON('https://fapi.binance.com/fapi/v1/exchangeInfo'),
    _fetchJSON('https://fapi.binance.com/fapi/v1/ticker/24hr'),
  ]);
  if (!info || !tickers) return CANDIDATE_UNIVERSE.slice(); // 失败回退候选池
  const usdtPerp = new Set();
  for (const s of (info.symbols || [])) {
    if (s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL' && s.status === 'TRADING') usdtPerp.add(s.symbol);
  }
  // 用24hr ticker 的 quoteVolume(成交额) 过滤流动性
  const volMap = {};
  for (const t of (tickers || [])) {
    if (t && t.symbol && usdtPerp.has(t.symbol)) volMap[t.symbol] = parseFloat(t.quoteVolume) || 0;
  }
  const coins = Object.entries(volMap)
    .filter(([sym, vol]) => vol >= minVol)
    .map(([sym, vol]) => ({ symbol: sym, quoteVolume: vol }))
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .map(x => x.symbol);
  _allMarketCache = { coins, t: Date.now() };
  return coins.length ? coins : CANDIDATE_UNIVERSE.slice();
}

module.exports = { getPairs, updatePairs, recordTrade, getPerf, suggestPairs, refreshPairs, backtestSymbol, trendQualityScore, getAllLiquidPairs, CANDIDATE_UNIVERSE, DEFAULT_PAIRS, DEFAULT_MAX_PAIRS };
