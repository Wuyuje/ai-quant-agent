/**
 * v63: 资金费率套利策略 — 低风险稳定收益
 * 
 * 原理：
 *   Binance 永续合约每8小时结算一次资金费率（funding rate）
 *   当费率为正 → 多头付给空头
 *   当费率为负 → 空头付给多头
 *   
 *   策略：现货买入 + 永续合约做空（等额对冲），收取资金费率
 *   - 价格波动风险 = 0（完全对冲）
 *   - 每8小时收取 funding rate
 *   - 年化收益 = funding rate × 3次/天 × 365天
 * 
 * 用法：node backtest/funding-arb.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  minFundingRate: 0.0001,
  minAnnualReturn: 0.05,
  maxLeverage: 1,
  positionSizePct: 0.95,
  rebalanceThreshold: 0.02,
  symbols: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT',
            'LINKUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'MATICUSDT', 'LTCUSDT'],
  initialCapital: 10000,
};

function fetch(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeout);
    https.get(url, { timeout }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', e => { clearTimeout(timer); reject(e); });
  });
}

async function fetchFundingRates() {
  const data = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex');
  return data.map(d => ({
    symbol: d.symbol,
    markPrice: parseFloat(d.markPrice),
    indexPrice: parseFloat(d.indexPrice),
    lastFundingRate: parseFloat(d.lastFundingRate),
    nextFundingTime: d.nextFundingTime,
  }));
}

async function fetchFundingHistory(symbol, limit = 500) {
  try {
    const data = await fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=${limit}`);
    return data.map(d => ({
      symbol: d.symbol,
      fundingRate: parseFloat(d.fundingRate),
      fundingTime: d.fundingTime,
      markPrice: parseFloat(d.markPrice),
    }));
  } catch (e) { return []; }
}

async function analyzeFundingOpportunities() {
  console.log('\n📊 获取所有永续合约资金费率...\n');
  const fundingData = await fetchFundingRates();
  if (!fundingData.length) { console.log('❌ 无法获取资金费率数据'); return []; }

  const filtered = fundingData.filter(d => CONFIG.symbols.includes(d.symbol));
  const positive = filtered.filter(d => d.lastFundingRate > 0).sort((a, b) => b.lastFundingRate - a.lastFundingRate);
  const negative = filtered.filter(d => d.lastFundingRate < 0).sort((a, b) => a.lastFundingRate - b.lastFundingRate);

  console.log('═══ 正费率（做多现货 + 做空合约 = 收费率）═══\n');
  console.log('  币种       | 资金费率   | 年化收益   | 标记价格     | 下次结算');
  console.log('  ───────────┼────────────┼────────────┼──────────────┼─────────────────');

  const opportunities = [];
  for (const d of positive) {
    const annualReturn = d.lastFundingRate * 3 * 365 * 100;
    const nextTime = new Date(d.nextFundingTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const flag = annualReturn > 20 ? '🔥' : annualReturn > 10 ? '✅' : annualReturn > 5 ? '🟡' : '⚪';
    console.log(`  ${d.symbol.padEnd(10)} | ${(d.lastFundingRate * 100).toFixed(4).padEnd(8)}% | ${annualReturn.toFixed(2).padEnd(8)}% | $${d.markPrice.toFixed(4).padEnd(12)} | ${nextTime} ${flag}`);
    if (d.lastFundingRate >= CONFIG.minFundingRate && annualReturn >= CONFIG.minAnnualReturn * 100) {
      opportunities.push({ symbol: d.symbol, type: 'positive', fundingRate: d.lastFundingRate, annualReturn, markPrice: d.markPrice, strategy: '现货做多 + 合约做空', action: 'BUY_SPOT + SHORT_PERP' });
    }
  }

  console.log('\n═══ 负费率（合约做多 + 借币做空现货 = 收费率）═══\n');
  console.log('  币种       | 资金费率   | 年化收益   | 标记价格     | 下次结算');
  console.log('  ───────────┼────────────┼────────────┼──────────────┼─────────────────');
  for (const d of negative.slice(0, 10)) {
    const annualReturn = Math.abs(d.lastFundingRate) * 3 * 365 * 100;
    const nextTime = new Date(d.nextFundingTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    console.log(`  ${d.symbol.padEnd(10)} | ${(d.lastFundingRate * 100).toFixed(4).padEnd(8)}% | ${annualReturn.toFixed(2).padEnd(8)}% | $${d.markPrice.toFixed(4).padEnd(12)} | ${nextTime}`);
    if (Math.abs(d.lastFundingRate) >= CONFIG.minFundingRate && annualReturn >= CONFIG.minAnnualReturn * 100) {
      opportunities.push({ symbol: d.symbol, type: 'negative', fundingRate: d.lastFundingRate, annualReturn, markPrice: d.markPrice, strategy: '合约做多 + 借币做空现货', action: 'LONG_PERP + SHORT_SPOT_MARGIN' });
    }
  }
  return opportunities;
}

async function backtestFundingArb() {
  console.log('\n═══ 历史资金费率回测（最近500次结算 ≈ 167天）═══\n');
  const results = [];

  for (const symbol of CONFIG.symbols) {
    const history = await fetchFundingHistory(symbol, 500);
    if (history.length < 10) continue;

    let totalFundingPnl = 0;
    let positiveCount = 0, negativeCount = 0, skipCount = 0;
    let capital = CONFIG.initialCapital;
    let peakCapital = capital;
    let maxDrawdown = 0;

    const fundingRates = history.map(h => h.fundingRate);
    const avgRate = fundingRates.length > 0 ? fundingRates.reduce((a, b) => a + b, 0) / fundingRates.length : 0;
    const positiveRates = fundingRates.filter(r => r > 0);
    const negativeRates = fundingRates.filter(r => r < 0);
    const avgPositive = positiveRates.length > 0 ? positiveRates.reduce((a, b) => a + b, 0) / positiveRates.length : 0;
    const avgNegative = negativeRates.length > 0 ? negativeRates.reduce((a, b) => a + b, 0) / negativeRates.length : 0;

    // 模拟：费率 >= min 时入场收fee，< min 时空仓
    const collectedRates = [];
    for (const h of history) {
      if (Math.abs(h.fundingRate) >= CONFIG.minFundingRate) {
        const fee = capital * h.fundingRate; // 正费率时收费率（做空方收）
        totalFundingPnl += fee;
        capital += fee;
        collectedRates.push(h.fundingRate);
        if (h.fundingRate > 0) positiveCount++; else negativeCount++;
      } else {
        skipCount++;
      }
      if (capital > peakCapital) peakCapital = capital;
      const dd = peakCapital > 0 ? (peakCapital - capital) / peakCapital : 0;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    const days = history.length * 8 / 24;
    const roi = CONFIG.initialCapital > 0 ? ((capital - CONFIG.initialCapital) / CONFIG.initialCapital) * 100 : 0;
    const annualROI = days > 0 ? roi / days * 365 : 0;
    const collectionRate = history.length > 0 ? (positiveCount + negativeCount) / history.length : 0;

    results.push({
      symbol,
      totalSettlements: history.length,
      collectedSettlements: positiveCount + negativeCount,
      skipCount,
      collectionRate: collectionRate * 100,
      avgRate: avgRate * 100,
      avgPositive: avgPositive * 100,
      avgNegative: avgNegative * 100,
      totalFundingPnl,
      roi,
      annualROI,
      maxDrawdown: maxDrawdown * 100,
      finalCapital: capital,
      days,
    });

    console.log(`  ${symbol.padEnd(10)} | 结算${history.length}次 | 收取${positiveCount + negativeCount}次 (${(collectionRate * 100).toFixed(0)}%) | 平均费率${(avgRate * 100).toFixed(4)}% | ROI=${roi.toFixed(2).padEnd(7)}% | 年化=${annualROI.toFixed(1).padEnd(6)}% | 回撤=${(maxDrawdown * 100).toFixed(2)}%`);
  }

  // 排序
  results.sort((a, b) => b.annualROI - a.annualROI);

  console.log('\n═══ 套利排名（按年化收益）═══\n');
  console.log('  排名 | 币种     | 年化ROI  | 总ROI   | 回撤   | 平均费率  | 收取率');
  console.log('  ────┼──────────┼──────────┼─────────┼────────┼───────────┼──────');
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const flag = r.annualROI > 20 ? '🔥' : r.annualROI > 10 ? '✅' : r.annualROI > 5 ? '🟡' : '⚪';
    console.log(`  ${String(i + 1).padEnd(4)} | ${r.symbol.padEnd(8)} | ${r.annualROI.toFixed(1).padEnd(8)}% | ${r.roi.toFixed(2).padEnd(7)}% | ${r.maxDrawdown.toFixed(2).padEnd(6)}% | ${r.avgRate.toFixed(4).padEnd(9)}% | ${(r.collectionRate).toFixed(0)}% ${flag}`);
  }

  // 组合策略回测：等权多币种
  console.log('\n═══ 组合套利策略（等权多币种）═══\n');
  const eligible = results.filter(r => r.annualROI > 0);
  if (eligible.length > 0) {
    const comboROI = eligible.reduce((a, b) => a + b.roi, 0) / eligible.length;
    const comboAnnual = eligible.reduce((a, b) => a + b.annualROI, 0) / eligible.length;
    const comboDD = Math.max(...eligible.map(r => r.maxDrawdown));
    console.log(`  策略: 等权分配 ${eligible.length} 个币种`);
    console.log(`  年化收益: ${comboAnnual.toFixed(2)}%`);
    console.log(`  总ROI（${eligible[0].days.toFixed(0)}天）: ${comboROI.toFixed(2)}%`);
    console.log(`  最大回撤: ${comboDD.toFixed(2)}%`);
    console.log(`  夏普比率（估算）: ${(comboAnnual / Math.max(0.1, comboDD)).toFixed(2)}`);
    console.log(`  风险等级: 🟢 极低（1x对冲，零价格风险）`);
  }

  return results;
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  v63 资金费率套利策略引擎');
  console.log('  💰 低风险稳定收益 — 永续合约费率收割');
  console.log('═══════════════════════════════════════════');

  // 1. 当前费率机会扫描
  const opportunities = await analyzeFundingOpportunities();

  if (opportunities.length > 0) {
    console.log(`\n\n═══ 🎯 当前套利机会 ${opportunities.length} 个 ═══\n`);
    for (const opp of opportunities) {
      console.log(`  ${opp.symbol} | ${opp.strategy} | 年化 ${opp.annualReturn.toFixed(1)}% | 费率 ${(opp.fundingRate * 100).toFixed(4)}%`);
    }
  } else {
    console.log('\n  ⚠️ 当前无满足条件的套利机会');
  }

  // 2. 历史回测
  const backtestResults = await backtestFundingArb();

  // 3. 保存报告
  const report = {
    timestamp: new Date().toISOString(),
    currentOpportunities: opportunities,
    backtestResults,
    config: CONFIG,
  };

  const reportPath = path.join(__dirname, '..', 'data', 'funding-arb-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n📄 报告已保存: ${reportPath}`);

  console.log('\n✅ 资金费率套利分析完成');
  process.exit(0);
}

main().catch(e => { console.error('❌ 失败:', e); process.exit(1); });
