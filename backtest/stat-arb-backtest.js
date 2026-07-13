/**
 * v66: 统计套利/配对交易回测
 * 
 * 回测协整配对策略的历史表现
 * 1. 拉取多币种1h K线
 * 2. 滚动扫描协整对
 * 3. 模拟Z-score入场/平仓
 * 4. 输出每对统计 + 总体表现
 * 
 * 用法: node backtest/stat-arb-backtest.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
// v73: StatArbitrage已禁用

const CONFIG = {
  symbols: ['ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'LINKUSDT', 'AVAXUSDT'],
  interval: '1h',
  limit: 1500,
  initialCapital: 1000,
  dexCostPct: 0.0016,
  scanInterval: 24,     // 每24根K线扫描一次
  positionSizePct: 0.15, // 15%资金per pair
};

function fetch(url, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeout);
    https.get(url, { timeout }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', e => { clearTimeout(timer); reject(e); });
  });
}

async function fetchKlines(symbol, interval, limit) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  try {
    const data = await fetch(url);
    return data.map(k => ({ openTime: k[0] / 1000, open: k[1], high: k[2], low: k[3], close: k[4], volume: k[5] }));
  } catch (e) { console.error(`  ❌ ${symbol}: ${e.message}`); return []; }
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  v66 统计套利/配对交易回测');
  console.log('═══════════════════════════════════════════\n');

  // 1. 拉取K线
  console.log('📊 拉取历史K线...');
  const allKlines = {};
  for (const sym of CONFIG.symbols) {
    allKlines[sym] = await fetchKlines(sym, CONFIG.interval, CONFIG.limit);
    console.log(`  ${sym}: ${allKlines[sym].length} 根`);
  }

  const statArb = new StatArbitrage({
    lookbackWindow: 200,
    zScoreWindow: 60,
    entryThreshold: 2.0,
    exitThreshold: 0.5,
    stopLossThreshold: 4.0,
    minCorrelation: 0.5,
  });

  // 2. 回测
  console.log('\n═══ 回测中 ═══\n');
  const maxLen = Math.max(...Object.values(allKlines).map(k => k.length));
  const startIdx = 250;

  let capital = CONFIG.initialCapital;
  let peakCapital = capital;
  let maxDrawdown = 0;
  let totalPnl = 0;
  let wins = 0, losses = 0;
  let trades = [];
  let activePairs = []; // [{symbolA, symbolB, beta, entryZ, entrySpread, size, openTime}]
  let lastScan = 0;

  const pairStats = {}; // {pairKey: {trades, wins, pnl}}

  for (let i = startIdx; i < maxLen; i++) {
    // 构建价格历史
    const priceHistory = {};
    for (const sym of CONFIG.symbols) {
      const klines = allKlines[sym];
      if (klines.length <= i) continue;
      priceHistory[sym] = klines.slice(Math.max(0, i - 200), i + 1).map(k => parseFloat(k.close));
    }

    // 定期扫描协整对
    if (i - lastScan >= CONFIG.scanInterval) {
      lastScan = i;
      const pairs = statArb.scanPairs(priceHistory);
      if (pairs.length > 0 && i % 100 === 0) {
        console.log(`  [bar ${i}] 发现 ${pairs.length} 个协整对, 最佳: ${pairs[0].symbolA}/${pairs[0].symbolB} Z=${pairs[0].zScore.toFixed(2)}`);
      }
    }

    // 检查活跃仓位
    for (let j = activePairs.length - 1; j >= 0; j--) {
      const pos = activePairs[j];
      const priceA = priceHistory[pos.symbolA]?.[priceHistory[pos.symbolA].length - 1];
      const priceB = priceHistory[pos.symbolB]?.[priceHistory[pos.symbolB].length - 1];
      if (!priceA || !priceB) continue;

      const currentSpread = priceA - pos.beta * priceB;
      const spreadChange = currentSpread - pos.entrySpread;

      // 计算当前Z-score近似
      const zScore = pos.entryZ + (spreadChange / Math.abs(pos.entrySpread || 1)) * pos.entryZ;

      let shouldClose = false;
      let reason = '';
      let pnl = 0;

      if (Math.abs(zScore) > 4.0) {
        shouldClose = true; reason = `止损 Z=${zScore.toFixed(2)}`;
        pnl = -pos.size * 0.02; // 止损约2%
      } else if (Math.abs(zScore) < 0.5) {
        shouldClose = true; reason = `回归均值 Z=${zScore.toFixed(2)}`;
        // PnL = spread回归的利润
        const reversionPct = Math.abs(pos.entryZ - zScore) / Math.abs(pos.entryZ || 1);
        pnl = pos.size * reversionPct * 0.1 - pos.size * CONFIG.dexCostPct;
      } else if (i - pos.openBar > 168) { // 7天超时
        shouldClose = true; reason = '超时平仓';
        pnl = pos.size * 0.005 - pos.size * CONFIG.dexCostPct;
      }

      if (shouldClose) {
        capital += pnl;
        totalPnl += pnl;
        if (pnl > 0) wins++; else losses++;

        const pairKey = `${pos.symbolA}/${pos.symbolB}`;
        if (!pairStats[pairKey]) pairStats[pairKey] = { trades: 0, wins: 0, pnl: 0 };
        pairStats[pairKey].trades++;
        if (pnl > 0) pairStats[pairKey].wins++;
        pairStats[pairKey].pnl += pnl;

        trades.push({ pair: pairKey, entryZ: pos.entryZ, exitZ: zScore, pnl, reason, holdBars: i - pos.openBar });
        activePairs.splice(j, 1);

        if (capital > peakCapital) peakCapital = capital;
        const dd = peakCapital > 0 ? (peakCapital - capital) / peakCapital : 0;
        if (dd > maxDrawdown) maxDrawdown = dd;
      }
    }

    // 开新仓
    if (activePairs.length < 3) {
      const pairs = statArb._pairs || [];
      for (const pair of pairs) {
        if (activePairs.length >= 3) break;
        const alreadyOpen = activePairs.some(p =>
          (p.symbolA === pair.symbolA && p.symbolB === pair.symbolB) ||
          (p.symbolA === pair.symbolB && p.symbolB === pair.symbolA)
        );
        if (alreadyOpen) continue;

        const signal = statArb.generateSignal(pair);
        if (signal.action === 'LONG_SPREAD' || signal.action === 'SHORT_SPREAD') {
          const priceA = priceHistory[pair.symbolA]?.[priceHistory[pair.symbolA].length - 1];
          const priceB = priceHistory[pair.symbolB]?.[priceHistory[pair.symbolB].length - 1];
          if (!priceA || !priceB) continue;

          const size = capital * CONFIG.positionSizePct;
          activePairs.push({
            symbolA: pair.symbolA,
            symbolB: pair.symbolB,
            beta: pair.beta,
            entryZ: pair.zScore,
            entrySpread: priceA - pair.beta * priceB,
            size,
            openBar: i,
            direction: signal.direction,
          });
        }
      }
    }
  }

  // 强平
  for (const pos of activePairs) {
    const pnl = -pos.size * CONFIG.dexCostPct;
    capital += pnl; totalPnl += pnl; losses++;
    const pairKey = `${pos.symbolA}/${pos.symbolB}`;
    if (!pairStats[pairKey]) pairStats[pairKey] = { trades: 0, wins: 0, pnl: 0 };
    pairStats[pairKey].trades++; pairStats[pairKey].pnl += pnl;
    trades.push({ pair: pairKey, entryZ: pos.entryZ, exitZ: 0, pnl, reason: '回测结束强平' });
  }

  // 3. 统计
  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? wins / totalTrades * 100 : 0;
  const roi = ((capital - CONFIG.initialCapital) / CONFIG.initialCapital) * 100;

  console.log('\n═══ 回测结果 ═══\n');
  console.log(`  总交易: ${totalTrades} | 胜: ${wins} | 负: ${losses} | 胜率: ${winRate.toFixed(1)}%`);
  console.log(`  总PnL: $${totalPnl.toFixed(2)} | ROI: ${roi.toFixed(2)}% | 最大回撤: ${(maxDrawdown * 100).toFixed(1)}%`);
  console.log(`  最终资金: $${capital.toFixed(2)} (初始 $${CONFIG.initialCapital})`);

  console.log('\n═══ 配对表现 ═══\n');
  console.log('  配对                | 交易数 | 胜率   | PnL');
  console.log('  ────────────────────┼────────┼────────┼───────');
  const sortedPairs = Object.entries(pairStats).sort((a, b) => b[1].pnl - a[1].pnl);
  for (const [pair, stats] of sortedPairs) {
    const wr = stats.trades > 0 ? (stats.wins / stats.trades * 100).toFixed(1) : '0';
    console.log(`  ${pair.padEnd(20)} | ${String(stats.trades).padEnd(6)} | ${wr.padEnd(6)}% | $${stats.pnl.toFixed(2)}`);
  }

  const report = {
    timestamp: new Date().toISOString(),
    config: CONFIG,
    summary: { totalTrades, wins, losses, winRate, totalPnl, roi, maxDrawdown: maxDrawdown * 100, finalCapital: capital },
    pairStats,
    trades: trades.slice(-50),
  };
  const reportPath = path.join(__dirname, '..', 'data', 'stat-arb-backtest-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n📄 报告已保存: ${reportPath}`);

  return report;
}

module.exports = { fetchKlines, CONFIG };
if (require.main === module) {
  main().then(() => { console.log('\n✅ 统计套利回测完成'); process.exit(0); })
    .catch(e => { console.error('❌ 回测失败:', e); process.exit(1); });
}
