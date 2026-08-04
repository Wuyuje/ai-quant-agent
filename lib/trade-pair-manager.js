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
const DEFAULT_PAIRS = ['1000RATSUSDT','BLESSUSDT','VICUSDT','PTBUSDT','BICOUSDT','HFTUSDT','1000SATSUSDT','BANKUSDT'];

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

module.exports = { getPairs, updatePairs, recordTrade, getPerf, suggestPairs, DEFAULT_PAIRS };
