/**
 * v66: 期权/Greeks Delta对冲回测
 * 
 * 模拟ATM straddle + delta hedge策略
 * 1. 拉取K线，计算实现波动率
 * 2. 每周期开ATM straddle（call+put）
 * 3. 追踪delta，超过阈值时对冲
 * 4. 到期结算gamma scalping vs theta decay
 * 
 * 用法: node backtest/options-greeks-backtest.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { OptionsGreeks } = require('../saas/strategies/options-greeks');

const CONFIG = {
  symbols: ['BTCUSDT', 'ETHUSDT'],
  interval: '1h',
  limit: 1500,
  initialCapital: 1000,
  expiryBars: 168,       // 7天 = 168根1h K线
  hedgeThreshold: 0.15,  // |delta| > 0.15 时对冲
  hedgeCostPct: 0.0005,  // 0.05% 对冲交易成本
  straddleNotional: 200, // 每个straddle面值
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

// 计算实现波动率（年化）
function realizedVol(closes, period = 20) {
  if (closes.length < period + 1) return 0.5;
  const returns = [];
  for (let i = closes.length - period; i < closes.length; i++) {
    if (closes[i - 1] > 0) returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const mean = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length > 0 ? returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length : 0;
  const hourlyVol = Math.sqrt(variance);
  return hourlyVol * Math.sqrt(24 * 365); // 年化
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  v66 期权/Greeks Delta对冲回测');
  console.log('═══════════════════════════════════════════\n');

  console.log('📊 拉取历史K线...');
  const allKlines = {};
  for (const sym of CONFIG.symbols) {
    allKlines[sym] = await fetchKlines(sym, CONFIG.interval, CONFIG.limit);
    console.log(`  ${sym}: ${allKlines[sym].length} 根`);
  }

  const og = new OptionsGreeks({ riskFreeRate: 0.05, hedgeThreshold: CONFIG.hedgeThreshold });

  console.log('\n═══ 回测中 ═══\n');
  const perSymbol = {};

  for (const sym of CONFIG.symbols) {
    const klines = allKlines[sym];
    let straddleCount = 0;
    let hedgeCount = 0;
    let gammaScalpingPnl = 0;
    let thetaDecay = 0;
    let hedgeCost = 0;
    let netPnl = 0;
    let totalDeltaBefore = 0;
    let totalDeltaAfter = 0;
    let hedgeEvents = 0;

    let currentStraddle = null; // {entryBar, strike, expiryBar, entryPrice, gamma, theta}

    for (let i = 60; i < klines.length; i++) {
      const k = klines[i];
      const spotPrice = parseFloat(k.close);
      const closes = klines.slice(0, i + 1).map(k => parseFloat(k.close));
      const rv = realizedVol(closes, 20);
      const barsToExpiry = currentStraddle ? (currentStraddle.expiryBar - i) : 0;
      const T = barsToExpiry > 0 ? barsToExpiry / (24 * 365) : 0.001;

      // 开新straddle
      if (!currentStraddle && i + CONFIG.expiryBars < klines.length) {
        const strike = spotPrice; // ATM
        const callGreeks = og.calculateGreeks('call', spotPrice, strike, T, 0.05, rv);
        const putGreeks = og.calculateGreeks('put', spotPrice, strike, T, 0.05, rv);
        const callPrice = og.priceOption('call', spotPrice, strike, T, 0.05, rv);
        const putPrice = og.priceOption('put', spotPrice, strike, T, 0.05, rv);

        currentStraddle = {
          entryBar: i,
          strike,
          expiryBar: i + CONFIG.expiryBars,
          entryPrice: spotPrice,
          entryVol: rv,
          callPrice, putPrice,
          straddleCost: callPrice + putPrice,
          gamma: callGreeks.gamma + putGreeks.gamma,
          theta: callGreeks.theta + putGreeks.theta,
          hedgePnl: 0,
          deltaHistory: [],
        };
        straddleCount++;
        og.clearPositions();
        og.addPosition({ type: 'call', S: spotPrice, K: strike, T, r: 0.05, sigma: rv, quantity: 1, side: 'long' });
        og.addPosition({ type: 'put', S: spotPrice, K: strike, T, r: 0.05, sigma: rv, quantity: 1, side: 'long' });
      }

      // 检查delta对冲
      if (currentStraddle) {
        const portfolio = og.portfolioGreeks(og._portfolio || []);
        const currentDelta = portfolio.delta || 0;
        totalDeltaBefore += Math.abs(currentDelta);

        if (Math.abs(currentDelta) > CONFIG.hedgeThreshold) {
          // 对冲：卖出/买入标的
          const hedgeQty = -currentDelta; // 反向对冲
          const hedgeValue = Math.abs(hedgeQty) * spotPrice;
          const cost = hedgeValue * CONFIG.hedgeCostPct;
          hedgeCost += cost;
          gammaScalpingPnl += Math.abs(hedgeQty) * spotPrice * 0.001; // 简化：每次对冲捕获价差
          hedgeCount++;
          hedgeEvents++;
          totalDeltaAfter += 0.01; // 对冲后delta接近0
        } else {
          totalDeltaAfter += Math.abs(currentDelta);
        }

        currentStraddle.hedgePnl += gammaScalpingPnl;
      }

      // 到期结算
      if (currentStraddle && i >= currentStraddle.expiryBar) {
        const spotAtExpiry = spotPrice;
        const strike = currentStraddle.strike;
        // Straddle到期价值 = |S - K|
        const intrinsicValue = Math.abs(spotAtExpiry - strike);
        const straddlePnL = intrinsicValue - currentStraddle.straddleCost;

        // Theta decay = straddle cost (时间价值全部损耗)
        thetaDecay += currentStraddle.straddleCost - intrinsicValue > 0 ? currentStraddle.straddleCost - intrinsicValue : 0;

        netPnl += straddlePnL + currentStraddle.hedgePnl - hedgeCost;
        currentStraddle = null;
      }
    }

    // 强平最后未到期straddle
    if (currentStraddle) {
      const lastPrice = parseFloat(klines[klines.length - 1].close);
      const intrinsic = Math.abs(lastPrice - currentStraddle.strike);
      const straddlePnL = intrinsic - currentStraddle.straddleCost;
      netPnl += straddlePnL + currentStraddle.hedgePnl - hedgeCost;
    }

    const hedgeEff = hedgeEvents > 0 && totalDeltaBefore !== 0 ? (1 - totalDeltaAfter / totalDeltaBefore) * 100 : 0;
    perSymbol[sym] = {
      straddles: straddleCount,
      hedges: hedgeCount,
      gammaScalpingPnl,
      thetaDecay,
      hedgeCost,
      netPnl,
      hedgeEffectiveness: hedgeEff,
    };

    console.log(`  ${sym}: ${straddleCount}个straddle | ${hedgeCount}次对冲 | Gamma PnL $${gammaScalpingPnl.toFixed(2)} | Theta -$${thetaDecay.toFixed(2)} | 对冲成本 $${hedgeCost.toFixed(2)} | 净PnL $${netPnl.toFixed(2)} | 对冲效率 ${hedgeEff.toFixed(1)}%`);
  }

  const totalNetPnl = Object.values(perSymbol).reduce((a, b) => a + b.netPnl, 0);
  const totalStraddles = Object.values(perSymbol).reduce((a, b) => a + b.straddles, 0);
  const totalHedges = Object.values(perSymbol).reduce((a, b) => a + b.hedges, 0);
  const totalGamma = Object.values(perSymbol).reduce((a, b) => a + b.gammaScalpingPnl, 0);
  const totalTheta = Object.values(perSymbol).reduce((a, b) => a + b.thetaDecay, 0);

  console.log('\n═══ 总结 ═══\n');
  console.log(`  Straddle总数: ${totalStraddles}`);
  console.log(`  对冲次数: ${totalHedges}`);
  console.log(`  Gamma Scalping PnL: $${totalGamma.toFixed(2)}`);
  console.log(`  Theta Decay: -$${totalTheta.toFixed(2)}`);
  console.log(`  净PnL (gamma - theta): $${(totalGamma - totalTheta).toFixed(2)}`);
  console.log(`  总净PnL: $${totalNetPnl.toFixed(2)}`);

  const report = {
    timestamp: new Date().toISOString(),
    config: CONFIG,
    summary: { totalStraddles, totalHedges, gammaScalpingPnl: totalGamma, thetaDecay: totalTheta, netPnl: totalNetPnl },
    perSymbol,
  };
  const reportPath = path.join(__dirname, '..', 'data', 'options-greeks-backtest-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n📄 报告已保存: ${reportPath}`);

  return report;
}

module.exports = { fetchKlines, CONFIG, realizedVol };
if (require.main === module) {
  main().then(() => { console.log('\n✅ 期权Greeks回测完成'); process.exit(0); })
    .catch(e => { console.error('❌ 回测失败:', e); process.exit(1); });
}
