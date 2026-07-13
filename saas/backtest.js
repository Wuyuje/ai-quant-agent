/**
 * BacktestEngine v1 — 策略回测引擎
 * 
 * 用 Binance 历史 K 线回测任意策略组合
 * 支持：多策略融合、滑点模型、资金费率、手续费扣除
 * 
 * 用法：node saas/backtest.js [symbol] [days]
 * 例：node saas/backtest.js BTCUSDT 30
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ═══ 加载策略 ═══
let StrategyManager;
try {
  StrategyManager = require('./strategies/strategy-manager').StrategyManager;
} catch (e) {
  // fallback
  StrategyManager = require('./strategies/strategy-manager');
}

// ═══ Binance 历史K线 API ═══
function fetchKlines(symbol, interval = '1h', limit = 500, startTime = null) {
  return new Promise((resolve, reject) => {
    let url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    if (startTime) url += `&startTime=${startTime}`;

    const req = https.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const raw = JSON.parse(data);
          const candles = raw.map(k => ({
            timestamp: k[0],
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
          }));
          resolve(candles);
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// 批量拉取多天K线
async function fetchAllKlines(symbol, days, interval = '1h') {
  const allCandles = [];
  const msPerCandle = interval === '1h' ? 3600000 : interval === '5m' ? 300000 : 86400000;
  const totalCandles = Math.ceil(days * 24 * (interval === '1h' ? 1 : interval === '5m' ? 12 : 1 / 24));
  let startTime = Date.now() - days * 86400000;

  console.log(`📥 拉取 ${symbol} ${interval} K线，共 ${days} 天...`);

  // 分批拉取（Binance限制1500根/次）
  let fetched = 0;
  while (fetched < totalCandles) {
    const batch = Math.min(1000, totalCandles - fetched);
    try {
      const candles = await fetchKlines(symbol, interval, batch, startTime);
      if (candles.length === 0) break;
      allCandles.push(...candles);
      startTime = candles[candles.length - 1].timestamp + msPerCandle;
      fetched += candles.length;
      if (candles.length < batch) break; // 没有更多数据
    } catch (e) {
      console.error(`⚠️ 拉取失败: ${e.message}，已获取 ${allCandles.length} 根`);
      break;
    }
  }

  console.log(`✅ 获取 ${allCandles.length} 根K线 (${(allCandles.length / 24).toFixed(1)} 天)`);
  return allCandles;
}

// ═══ 回测引擎 ═══
class BacktestEngine {
  constructor(options = {}) {
    this.initialBalance = options.initialBalance || 100; // $100 起步
    this.fee = options.fee || 0.0004;  // 0.04% 手续费
    this.slippage = options.slippage || 0.0002; // 0.02% 滑点
    this.maxLeverage = options.maxLeverage || 10;
    this.riskPerTrade = options.riskPerTrade || 0.03; // 3% 风险
  }

  /**
   * 运行回测
   * @param {Object[]} candles - K线数据
   * @param {Function} strategyFn - 策略函数 (candles, index) => { direction, confidence }
   * @returns {Object} 回测结果
   */
  run(candles, strategyFn) {
    let balance = this.initialBalance;
    let equity = balance;
    let position = null; // { side, entryPrice, size, leverage, entryTime }
    let peakEquity = balance;
    let maxDrawdown = 0;

    const trades = [];
    const equityCurve = [];
    const FUNDING_RATE = 0.0001; // 0.01% / 8h 简化

    for (let i = 50; i < candles.length; i++) { // 跳过前50根（需要数据预热）
      const candle = candles[i];
      const price = candle.close;

      // 检查持仓状态
      if (position) {
        // 计算浮动PnL
        const priceDiff = position.side === 'LONG'
          ? (price - position.entryPrice) / position.entryPrice
          : (position.entryPrice - price) / position.entryPrice;

        const grossPnl = priceDiff * position.leverage;
        const cost = this.fee * 2 + this.slippage * 2 + Math.abs(grossPnl) * 0.0001; // 手续费+滑点+资金费
        const netPnl = grossPnl - cost;

        // 峰值追踪
        const currentEquity = balance + position.size * netPnl;
        if (currentEquity > peakEquity) peakEquity = currentEquity;
        const drawdown = (peakEquity - currentEquity) / peakEquity;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;

        // 止损：亏损超过 5%
        if (netPnl < -0.05) {
          const exitPrice = position.side === 'LONG'
            ? price * (1 - this.slippage)
            : price * (1 + this.slippage);

          const realizedPnl = position.size * netPnl;
          balance += realizedPnl;
          trades.push({
            side: position.side,
            entryPrice: position.entryPrice,
            exitPrice,
            entryTime: position.entryTime,
            exitTime: candle.timestamp,
            pnl: realizedPnl,
            pnlPct: netPnl * 100,
            reason: 'STOP_LOSS',
          });
          position = null;
        }
        // 止盈：盈利超过 3%
        else if (netPnl > 0.03) {
          const exitPrice = position.side === 'LONG'
            ? price * (1 - this.slippage)
            : price * (1 + this.slippage);

          const realizedPnl = position.size * netPnl;
          balance += realizedPnl;
          trades.push({
            side: position.side,
            entryPrice: position.entryPrice,
            exitPrice,
            entryTime: position.entryTime,
            exitTime: candle.timestamp,
            pnl: realizedPnl,
            pnlPct: netPnl * 100,
            reason: 'TAKE_PROFIT',
          });
          position = null;
        }
        // 跟踪止损：峰值回撤超过 1.5%
        else if (grossPnl > 0.01 && priceDiff < (position.side === 'LONG' ? 0.005 : -0.005)) {
          const realizedPnl = position.size * netPnl;
          balance += realizedPnl;
          trades.push({
            side: position.side,
            entryPrice: position.entryPrice,
            exitPrice: price,
            entryTime: position.entryTime,
            exitTime: candle.timestamp,
            pnl: realizedPnl,
            pnlPct: netPnl * 100,
            reason: 'TRAILING_STOP',
          });
          position = null;
        }
      }

      // 无仓位时检查信号
      if (!position) {
        const subCandles = candles.slice(Math.max(0, i - 99), i + 1);
        const signal = strategyFn(subCandles, i);

        if (signal && signal.confidence > 0.5 && (signal.direction === 'long' || signal.direction === 'short')) {
          const leverage = Math.min(
            Math.max(Math.round(signal.confidence * this.maxLeverage), 2),
            this.maxLeverage
          );
          const tradeSize = balance * this.riskPerTrade * leverage;

          const entryPrice = signal.direction === 'long'
            ? price * (1 + this.slippage)
            : price * (1 - this.slippage);

          position = {
            side: signal.direction.toUpperCase(),
            entryPrice,
            size: Math.min(tradeSize, balance * 0.95), // 最多用95%资金
            leverage,
            entryTime: candle.timestamp,
          };
        }
      }

      equity = position
        ? balance + position.size * ((position.side === 'LONG'
          ? (price - position.entryPrice) / position.entryPrice
          : (position.entryPrice - price) / position.entryPrice) * position.leverage - this.fee * 2 - this.slippage * 2)
        : balance;

      equityCurve.push({ time: candle.timestamp, equity, price });
    }

    // 强制平仓
    if (position) {
      const lastPrice = candles[candles.length - 1].close;
      const priceDiff = position.side === 'LONG'
        ? (lastPrice - position.entryPrice) / position.entryPrice
        : (position.entryPrice - lastPrice) / position.entryPrice;
      const netPnl = priceDiff * position.leverage - this.fee * 2 - this.slippage * 2;
      const realizedPnl = position.size * netPnl;
      balance += realizedPnl;
      trades.push({
        side: position.side,
        entryPrice: position.entryPrice,
        exitPrice: lastPrice,
        entryTime: position.entryTime,
        exitTime: candles[candles.length - 1].timestamp,
        pnl: realizedPnl,
        pnlPct: netPnl * 100,
        reason: 'FORCED_CLOSE',
      });
    }

    // 统计
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const winRate = trades.length > 0 ? wins.length / trades.length : 0;
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length) : 0;
    const profitFactor = avgLoss > 0 ? (avgWin * wins.length) / (avgLoss * losses.length) : Infinity;

    return {
      summary: {
        initialBalance: this.initialBalance,
        finalBalance: Math.round(balance * 100) / 100,
        totalPnl: Math.round(totalPnl * 100) / 100,
        totalPnlPct: Math.round((totalPnl / this.initialBalance) * 10000) / 100,
        totalTrades: trades.length,
        winRate: Math.round(winRate * 10000) / 100,
        avgWinPct: Math.round(avgWin * 100) / 100,
        avgLossPct: Math.round(avgLoss * 100) / 100,
        profitFactor: Math.round(profitFactor * 100) / 100,
        maxDrawdown: Math.round(maxDrawdown * 10000) / 100,
        sharpeRatio: this._sharpe(equityCurve),
        winTrades: wins.length,
        lossTrades: losses.length,
        stopLoss: trades.filter(t => t.reason === 'STOP_LOSS').length,
        takeProfit: trades.filter(t => t.reason === 'TAKE_PROFIT').length,
        trailingStop: trades.filter(t => t.reason === 'TRAILING_STOP').length,
      },
      trades,
      equityCurve,
    };
  }

  _sharpe(equityCurve) {
    if (equityCurve.length < 2) return 0;
    const returns = [];
    for (let i = 1; i < equityCurve.length; i++) {
      returns.push((equityCurve[i].equity - equityCurve[i - 1].equity) / equityCurve[i - 1].equity);
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length;
    const std = Math.sqrt(variance);
    return std > 0 ? Math.round((mean / std) * Math.sqrt(8760) * 100) / 100 : 0; // 年化
  }
}

// ═══ CLI ═══
async function main() {
  const symbol = process.argv[2] || 'BTCUSDT';
  const days = parseInt(process.argv[3]) || 30;

  console.log(`\n🔥 AI Quant Backtest — ${symbol} ${days}天\n`);

  // 拉取K线
  const candles = await fetchAllKlines(symbol, days, '1h');
  if (candles.length < 100) {
    console.error('❌ K线数据不足100根，无法回测');
    process.exit(1);
  }

  // 加载策略管理器
  const sm = new StrategyManager();

  // 定义策略组合函数
  const strategies = [
    { name: 'CrossSpread', fn: (cs) => sm.strategies.crossSpread.analyze({ price: cs[cs.length-1].close, prices: cs.map(c=>c.close), volumes: cs.map(c=>c.volume) }), weight: 0.3 },
    { name: 'Sentiment', fn: (cs) => sm.strategies.sentiment.analyze({ price: cs[cs.length-1].close, prices: cs.map(c=>c.close), volumes: cs.map(c=>c.volume) }), weight: 0.3 },
    { name: 'RegimeDetect', fn: (cs) => sm.strategies.regimeDetect.analyze({ price: cs[cs.length-1].close, prices: cs.map(c=>c.close), volumes: cs.map(c=>c.volume) }), weight: 0.2 },
    { name: 'PairsTrading', fn: (cs) => sm.strategies.pairsTrading.analyze({ price: cs[cs.length-1].close, prices: cs.map(c=>c.close), volumes: cs.map(c=>c.volume) }), weight: 0.2 },
  ];

  const bt = new BacktestEngine({ initialBalance: 100, maxLeverage: 5 });

  console.log(`📊 回测参数: $100 初始资金, 5x最大杠杆, 3%风险/单笔`);
  console.log(`📈 K线: ${candles.length}根 (${candles.length/24}天)\n`);

  // 融合策略回测
  const fusedResult = bt.run(candles, (cs, idx) => {
    let longScore = 0, shortScore = 0, totalWeight = 0;

    for (const { fn, weight } of strategies) {
      try {
        const r = fn(cs);
        if (r && typeof r.signal === 'number' && r.signal > 0.05 && r.direction) {
          const w = weight || 1 / strategies.length;
          if (r.direction === 'long') longScore += r.signal * w;
          else if (r.direction === 'short') shortScore += r.signal * w;
          totalWeight += w;
        }
      } catch (e) { /* skip */ }
    }

    const netScore = (longScore - shortScore) / (totalWeight || 1);
    if (netScore > 0.08) return { direction: 'long', confidence: Math.min(Math.abs(netScore) * 2, 1) };
    if (netScore < -0.08) return { direction: 'short', confidence: Math.min(Math.abs(netScore) * 2, 1) };
    return null;
  });

  // 单策略回测
  const singleResults = {};
  for (const { name, fn } of strategies) {
    try {
      const r = bt.run(candles, fn);
      singleResults[name] = r.summary;
    } catch (e) {
      singleResults[name] = { error: e.message };
    }
  }

  // 输出结果
  console.log('═══════════════════════════════════════════════');
  console.log('              🔥 融合策略回测结果');
  console.log('═══════════════════════════════════════════════');
  const s = fusedResult.summary;
  console.log(`  初始资金:    $${s.initialBalance}`);
  console.log(`  最终资金:    $${s.finalBalance}`);
  console.log(`  总收益:      $${s.totalPnl} (${s.totalPnlPct}%)`);
  console.log(`  总交易:      ${s.totalTrades}笔 (赢${s.winTrades} / 输${s.lossTrades})`);
  console.log(`  胜率:        ${s.winRate}%`);
  console.log(`  平均盈利:    +${s.avgWinPct}%`);
  console.log(`  平均亏损:    -${s.avgLossPct}%`);
  console.log(`  盈亏比:      ${s.profitFactor}`);
  console.log(`  最大回撤:    -${s.maxDrawdown}%`);
  console.log(`  Sharpe比率:  ${s.sharpeRatio}`);
  console.log(`  止盈触发:    ${s.takeProfit}次`);
  console.log(`  止损触发:    ${s.stopLoss}次`);
  console.log(`  追踪止损:    ${s.trailingStop}次`);

  console.log('\n═══════════════════════════════════════════════');
  console.log('              📊 单策略对比');
  console.log('═══════════════════════════════════════════════');
  console.log('  策略           收益%    胜率    交易  最大回撤  Sharpe');
  console.log('  ───────────── ───────  ──────  ────  ────────  ──────');

  // 排序（按收益降序）
  const sorted = Object.entries(singleResults)
    .filter(([, v]) => !v.error)
    .sort((a, b) => (b[1].totalPnlPct || 0) - (a[1].totalPnlPct || 0));

  for (const [name, r] of sorted) {
    console.log(`  ${name.padEnd(14)} ${(r.totalPnlPct + '%').padStart(7)} ${(r.winRate + '%').padStart(7)}  ${String(r.totalTrades).padStart(3)}  ${('-' + r.maxDrawdown + '%').padStart(8)}  ${String(r.sharpeRatio).padStart(5)}`);
  }

  console.log('\n═══════════════════════════════════════════════');

  // 保存结果
  const resultPath = path.join(__dirname, '..', 'data', 'backtest-result.json');
  const resultData = {
    timestamp: new Date().toISOString(),
    symbol,
    days,
    candleCount: candles.length,
    fused: fusedResult.summary,
    single: singleResults,
  };

  try {
    fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    fs.writeFileSync(resultPath, JSON.stringify(resultData, null, 2));
    console.log(`\n💾 结果已保存: ${resultPath}`);
  } catch (e) {
    console.error(`⚠️ 保存失败: ${e.message}`);
  }

  console.log('\n✅ 回测完成\n');
}

// 导出
module.exports = { BacktestEngine, fetchAllKlines };

// CLI 运行
if (require.main === module) {
  main().catch(e => {
    console.error('❌ 回测失败:', e.message);
    process.exit(1);
  });
}
