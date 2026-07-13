/**
 * v66: 链上MEV策略回测
 * 
 * 模拟三明治/抢先交易策略历史表现
 * 1. 拉取K线模拟链上大额交易
 * 2. 检测可三明治的机会
 * 3. 模拟前买后卖利润 vs gas成本
 * 
 * 用法: node backtest/mev-backtest.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
// v73: MevBot已禁用

const CONFIG = {
  symbols: ['BNBUSDT', 'CAKEUSDT', 'ETHUSDT'],
  interval: '5m',
  limit: 1500,
  initialCapital: 1000,
  gasCostBnb: 0.0015,       // 每笔三明治gas成本
  bnbPriceUsd: 600,          // BNB近似价格
  maxSlippagePct: 0.03,      // 最大滑点3%
  minProfitThreshold: 0.0001, // 最小利润阈值 BNB
  largeTradeThreshold: 3,    // 成交量超过均值3倍视为大额交易
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
    return data.map(k => ({ openTime: k[0] / 1000, open: k[1], high: k[2], low: k[3], close: k[4], volume: parseFloat(k[5]) }));
  } catch (e) { console.error(`  ❌ ${symbol}: ${e.message}`); return []; }
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  v66 链上MEV策略回测');
  console.log('═══════════════════════════════════════════\n');

  console.log('📊 拉取历史K线 (5分钟级)...');
  const allKlines = {};
  for (const sym of CONFIG.symbols) {
    allKlines[sym] = await fetchKlines(sym, CONFIG.interval, CONFIG.limit);
    console.log(`  ${sym}: ${allKlines[sym].length} 根`);
  }

  const mevBot = new MevBot({
    rpcUrl: 'https://bsc-dataseed.binance.org',
    minProfit: CONFIG.minProfitThreshold,
    gasCost: CONFIG.gasCostBnb,
    maxSlippagePct: CONFIG.maxSlippagePct,
    sandwichEnabled: false, // 回测中模拟计算，不实际执行
  });

  console.log('\n═══ 回测中 ═══\n');
  const perSymbol = {};

  for (const sym of CONFIG.symbols) {
    const klines = allKlines[sym];
    let opportunities = 0;
    let executed = 0;
    let totalProfit = 0;
    let totalGas = 0;
    let wins = 0, losses = 0;
    let trades = [];
    let capital = CONFIG.initialCapital;

    // 计算平均成交量
    const volumes = klines.map(k => k.volume);
    const avgVol = volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0;

    for (let i = 50; i < klines.length; i++) {
      const k = klines[i];
      const price = parseFloat(k.close);
      const vol = k.volume;

      // 检测大额交易 (成交量超过均值N倍)
      const isLargeTrade = vol > avgVol * CONFIG.largeTradeThreshold;
      if (!isLargeTrade) continue;

      opportunities++;

      // 模拟三明治交易
      // 前买：在大额交易前买入
      const frontRunAmount = Math.min(capital * 0.20, 500); // 20%仓位或最多$500
      const volRatio = avgVol > 0 ? vol / avgVol : 1;
      // 价格影响：成交量倍数 × 0.3%基础冲击
      const priceImpact = Math.min(volRatio * 0.003, CONFIG.maxSlippagePct);
      const expectedMove = priceImpact;

      // 前买价格
      const buyPrice = price;
      // 大额交易后价格
      const afterPrice = price * (1 + expectedMove);
      // 后卖价格（扣除0.1%滑点）
      const sellPrice = afterPrice * (1 - 0.001);

      // 利润计算
      const tokenAmount = buyPrice > 0 ? frontRunAmount / buyPrice : 0;
      const grossProfitUsd = tokenAmount * (sellPrice - buyPrice);
      const gasCostUsd = CONFIG.gasCostBnb * 2 * CONFIG.bnbPriceUsd; // 前买+后卖两次gas
      const netProfitUsd = grossProfitUsd - gasCostUsd;

      // 盈利性检查
      if (netProfitUsd > 0) {
        executed++;
        capital += netProfitUsd;
        totalProfit += netProfitUsd;
        totalGas += gasCostUsd;
        if (netProfitUsd > 0) wins++; else losses++;

        trades.push({
          bar: i,
          price,
          volume: vol,
          volRatio: vol / avgVol,
          expectedMove: expectedMove * 100,
          frontRunAmount,
          netProfit: netProfitUsd,
          gasCost: gasCostUsd,
        });
      } else {
        losses++;
      }
    }

    const roi = ((capital - CONFIG.initialCapital) / CONFIG.initialCapital) * 100;
    const winRate = executed > 0 ? (wins / executed * 100) : 0;
    const avgProfit = executed > 0 ? (totalProfit / executed) : 0;

    perSymbol[sym] = {
      opportunities,
      executed,
      winRate,
      totalProfit,
      totalGas,
      avgProfit,
      roi,
      finalCapital: capital,
    };

    console.log(`  ${sym}: 机会${opportunities} | 执行${executed} | 胜率${winRate.toFixed(1)}% | 总利润$${totalProfit.toFixed(2)} | Gas$${totalGas.toFixed(2)} | ROI${roi.toFixed(2)}%`);
  }

  const totalOpps = Object.values(perSymbol).reduce((a, b) => a + b.opportunities, 0);
  const totalExec = Object.values(perSymbol).reduce((a, b) => a + b.executed, 0);
  const totalProfit = Object.values(perSymbol).reduce((a, b) => a + b.totalProfit, 0);
  const totalGas = Object.values(perSymbol).reduce((a, b) => a + b.totalGas, 0);

  console.log('\n═══ 总结 ═══\n');
  console.log(`  总机会: ${totalOpps}`);
  console.log(`  总执行: ${totalExec}`);
  console.log(`  执行率: ${totalOpps > 0 ? (totalExec / totalOpps * 100).toFixed(1) : 0}%`);
  console.log(`  总利润: $${totalProfit.toFixed(2)}`);
  console.log(`  总Gas: $${totalGas.toFixed(2)}`);
  console.log(`  净利润: $${(totalProfit - totalGas).toFixed(2)}`);

  const report = {
    timestamp: new Date().toISOString(),
    config: CONFIG,
    summary: {
      totalOpportunities: totalOpps,
      totalExecuted: totalExec,
      executionRate: totalOpps > 0 ? totalExec / totalOpps * 100 : 0,
      totalProfit,
      totalGas,
      netProfit: totalProfit - totalGas,
    },
    perSymbol,
  };
  const reportPath = path.join(__dirname, '..', 'data', 'mev-backtest-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n📄 报告已保存: ${reportPath}`);

  return report;
}

module.exports = { fetchKlines, CONFIG };
if (require.main === module) {
  main().then(() => { console.log('\n✅ MEV回测完成'); process.exit(0); })
    .catch(e => { console.error('❌ 回测失败:', e); process.exit(1); });
}
