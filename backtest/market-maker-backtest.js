/**
 * v66: 限价单做市策略回测
 * 
 * 模拟做市策略历史表现
 * 1. 拉取K线，合成订单簿
 * 2. 生成报价 → 模拟成交
 * 3. 追踪库存PnL + 价差捕获
 * 
 * 用法: node backtest/market-maker-backtest.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { MarketMaker } = require('../saas/strategies/market-maker');

const CONFIG = {
  symbols: ['ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT'],
  interval: '1h',
  limit: 1500,
  initialCapital: 1000,
  fillProbability: 0.30,   // 30%概率成交
  baseSpreadPct: 0.08,
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
  console.log('  v66 限价单做市策略回测');
  console.log('═══════════════════════════════════════════\n');

  console.log('📊 拉取历史K线...');
  const allKlines = {};
  for (const sym of CONFIG.symbols) {
    allKlines[sym] = await fetchKlines(sym, CONFIG.interval, CONFIG.limit);
    console.log(`  ${sym}: ${allKlines[sym].length} 根`);
  }

  const mm = new MarketMaker({
    baseSpreadPct: CONFIG.baseSpreadPct,
    maxInventory: 5000,
    orderSize: 100,
    makerFeeRate: 0.0002,
  });

  console.log('\n═══ 回测中 ═══\n');
  const maxLen = Math.max(...Object.values(allKlines).map(k => k.length));
  const perSymbol = {};

  for (const sym of CONFIG.symbols) {
    const klines = allKlines[sym];
    let symFills = 0, symRealizedPnl = 0, symFees = 0;
    let maxInv = 0;
    // 独立库存追踪
    let inventory = 0;        // 持有数量（正=多头, 负=空头）
    let avgEntryPrice = 0;
    let realizedPnl = 0;
    let feesPaid = 0;
    let quoteCount = 0;
    let totalQuotes = 0;

    for (let i = 60; i < klines.length; i++) {
      const k = klines[i];
      const midPrice = parseFloat(k.close);
      const high = parseFloat(k.high);
      const low = parseFloat(k.low);

      // 计算波动率
      const closes = klines.slice(Math.max(0, i - 20), i + 1).map(k => parseFloat(k.close));
      let vol = 0.5;
      if (closes.length >= 10) {
        const returns = [];
        for (let j = 1; j < closes.length; j++) returns.push(closes[j - 1] > 0 ? (closes[j] - closes[j - 1]) / closes[j - 1] : 0);
        const mean = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
        vol = returns.length > 0 ? Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length) * 100 : 0.5;
      }

      // 库存价值
      const inventoryValue = Math.abs(inventory) * midPrice;
      maxInv = Math.max(maxInv, inventoryValue);

      // 库存管理：如果库存过大，偏移报价以减仓
      const maxInvLimit = 2000; // $2000最大库存
      let inventorySkew = 0;
      if (inventoryValue > maxInvLimit * 0.5) {
        inventorySkew = maxInvLimit > 0 ? (inventoryValue / maxInvLimit - 0.5) * 0.002 : 0;
      }

      // 合成订单簿
      const halfSpread = midPrice * (CONFIG.baseSpreadPct / 100) / 2;
      const bidPrice = midPrice * (1 - halfSpread) - inventorySkew * midPrice;
      const askPrice = midPrice * (1 + halfSpread) - inventorySkew * midPrice;
      const quoteSize = 0.1; // 每次报价数量
      totalQuotes++;

      // 模拟成交: 库存过多时只单边成交（减仓方向）
      const fillProb = CONFIG.fillProbability * (1 + vol / 20);

      // Bid成交 (买入)
      if (Math.random() < fillProb && low <= bidPrice && inventoryValue < maxInvLimit) {
        const fillQty = quoteSize;
        // 更新库存
        if (inventory >= 0) {
          // 加多头
          avgEntryPrice = (inventory + fillQty) > 0 ? (avgEntryPrice * inventory + bidPrice * fillQty) / (inventory + fillQty) : bidPrice;
        } else {
          // 减空头
          realizedPnl += (avgEntryPrice - bidPrice) * fillQty;
        }
        inventory += fillQty;
        feesPaid += bidPrice * fillQty * 0.0002; // maker fee
        symFills++;
      }

      // Ask成交 (卖出)
      if (Math.random() < fillProb && high >= askPrice && inventory > -maxInvLimit / midPrice) {
        const fillQty = quoteSize;
        if (inventory > 0) {
          // 减多头
          realizedPnl += (askPrice - avgEntryPrice) * fillQty;
        } else {
          // 加空头
          avgEntryPrice = (avgEntryPrice * Math.abs(inventory) + askPrice * fillQty) / (Math.abs(inventory) + fillQty);
        }
        inventory -= fillQty;
        feesPaid += askPrice * fillQty * 0.0002;
        symFills++;
      }

      // 定期强制平仓：每48根K线如果库存不为零，以midPrice平50%
      if (i % 48 === 0 && Math.abs(inventory) > 0.01) {
        const closeQty = inventory * 0.5;
        if (inventory > 0) {
          realizedPnl += (midPrice - avgEntryPrice) * closeQty;
        } else {
          realizedPnl += (avgEntryPrice - midPrice) * Math.abs(closeQty);
        }
        inventory -= closeQty;
        feesPaid += Math.abs(closeQty) * midPrice * 0.0005; // taker fee
      }
    }

    // 最后强制平仓
    if (Math.abs(inventory) > 0.01) {
      const lastPrice = parseFloat(klines[klines.length - 1].close);
      if (inventory > 0) {
        realizedPnl += (lastPrice - avgEntryPrice) * inventory;
      } else {
        realizedPnl += (avgEntryPrice - lastPrice) * Math.abs(inventory);
      }
      feesPaid += Math.abs(inventory) * lastPrice * 0.0005;
      inventory = 0;
    }

    const netPnl = realizedPnl - feesPaid;
    perSymbol[sym] = {
      fills: symFills,
      realizedPnl,
      feesPaid,
      netPnl,
      maxInventory: maxInv,
      captureRate: totalQuotes > 0 ? (symFills / totalQuotes * 100) : 0,
    };
    console.log(`  ${sym}: ${symFills}笔成交 | 已实现$${realizedPnl.toFixed(2)} | 手续费$${feesPaid.toFixed(2)} | 净PnL$${netPnl.toFixed(2)} | 最大库存$${maxInv.toFixed(0)}`);
  }

  const totalFills = Object.values(perSymbol).reduce((a, b) => a + b.fills, 0);
  const totalRealized = Object.values(perSymbol).reduce((a, b) => a + b.realizedPnl, 0);
  const totalFees = Object.values(perSymbol).reduce((a, b) => a + b.feesPaid, 0);
  const totalNet = totalRealized - totalFees;
  console.log('\n═══ 总结 ═══\n');
  console.log(`  总成交: ${totalFills}`);
  console.log(`  已实现PnL: $${totalRealized.toFixed(2)}`);
  console.log(`  手续费: $${totalFees.toFixed(2)}`);
  console.log(`  净PnL: $${totalNet.toFixed(2)}`);

  const report = {
    timestamp: new Date().toISOString(),
    config: CONFIG,
    summary: { totalFills, realizedPnl: totalRealized, feesPaid: totalFees, netPnl: totalNet },
    perSymbol,
  };
  const reportPath = path.join(__dirname, '..', 'data', 'market-maker-backtest-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n📄 报告已保存: ${reportPath}`);

  return report;
}

module.exports = { fetchKlines, CONFIG };
if (require.main === module) {
  main().then(() => { console.log('\n✅ 做市回测完成'); process.exit(0); })
    .catch(e => { console.error('❌ 回测失败:', e); process.exit(1); });
}
