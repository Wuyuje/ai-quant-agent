/**
 * v63: 策略回测验证引擎 — 淘汰垃圾策略
 * 
 * 功能：
 *   1. 拉取 Binance 历史 K线（1h，最多1500根 ≈ 62天）
 *   2. 逐根回放，模拟每个策略独立运行
 *   3. 对每个策略计算：胜率、盈亏比、最大回撤、夏普比率、总收益、利润因子
 *   4. 输出策略排名，淘汰低效策略
 *   5. 支持 DEX 成本模型（1.6% 双边费用）
 * 
 * 用法：node backtest/strategy-backtest.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════
const CONFIG = {
  symbols: ['ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'LINKUSDT', 'ADAUSDT', 'AVAXUSDT'],
  interval: '1h',
  limit: 1500,                    // 1500根 K线 ≈ 62天
  initialCapital: 1000,           // 初始资金 $1000
  dexCostPct: 0.016,              // DEX 双边成本 1.6%
  slippageBps: 50,                // 滑点 0.5%
  // 回测参数组合
  stopLossPcts: [0.02, 0.03, 0.04, 0.05],
  takeProfitMultis: [3, 4, 5, 6, 7],  // ATR 倍数
  minScores: [5, 6, 7, 8],
  protectionMins: [15, 30, 45],
  reversalBufferPcts: [0.02, 0.03, 0.04],
  trailingPeakPcts: [0.02, 0.03, 0.04],
  trailingDropPcts: [0.3, 0.4, 0.5],
};

// ═══════════════════════════════════════════
// HTTP 请求工具
// ═══════════════════════════════════════════
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

// ═══════════════════════════════════════════
// 技术指标计算
// ═══════════════════════════════════════════
function sma(arr, p) {
  if (arr.length < p) return arr[arr.length - 1] || 0;
  return arr.slice(-p).reduce((a, b) => a + b, 0) / p;
}

function ema(arr, p) {
  if (arr.length < p) return arr[arr.length - 1] || 0;
  const k = 2 / (p + 1);
  let e = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

function rsi(closes, p = 14) {
  if (closes.length < p + 1) return 50;
  const ch = [];
  for (let i = closes.length - p; i < closes.length; i++) ch.push(closes[i] - closes[i - 1]);
  const gains = ch.filter(x => x > 0);
  const losses = ch.filter(x => x < 0).map(x => Math.abs(x));
  const avgGain = gains.length ? gains.reduce((a, b) => a + b, 0) / p : 0;
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / p : 0;
  return avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
}

function atr(highs, lows, closes, p = 14) {
  if (highs.length < 2) return 0;
  const trs = [];
  for (let i = Math.max(1, highs.length - p); i < highs.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function bollingerBands(closes, p = 20, mult = 2) {
  if (closes.length < p) return { upper: 0, middle: 0, lower: 0, pctB: 0.5 };
  const slice = closes.slice(-p);
  const mid = slice.reduce((a, b) => a + b, 0) / p;
  const variance = slice.reduce((a, b) => a + (b - mid) ** 2, 0) / p;
  const std = Math.sqrt(variance);
  const upper = mid + mult * std;
  const lower = mid - mult * std;
  const cur = closes[closes.length - 1];
  const pctB = upper === lower ? 0.5 : (cur - lower) / (upper - lower);
  return { upper, middle: mid, lower, pctB };
}

// ═══════════════════════════════════════════
// 策略信号生成（与 user-trader.js 一致）
// ═══════════════════════════════════════════
function generateSignal(klines) {
  const closes = klines.map(k => parseFloat(k.close));
  const highs = klines.map(k => parseFloat(k.high));
  const lows = klines.map(k => parseFloat(k.low));
  const currentPrice = closes[closes.length - 1];

  const ma7 = sma(closes, 7);
  const ma21 = sma(closes, 21);
  const ma55 = sma(closes, 55);
  const rsiVal = rsi(closes, 14);
  const atrVal = atr(highs, lows, closes, 14);
  const atrPct = atrVal / currentPrice;
  const bb = bollingerBands(closes, 20, 2);
  const pctB = bb.pctB;

  const lastKline = klines[klines.length - 1];
  const isGreen = parseFloat(lastKline.close) > parseFloat(lastKline.open);
  const isRed = parseFloat(lastKline.close) < parseFloat(lastKline.open);

  let score = 0;
  let side = null;

  // 1. 多时间框架信号（MA 交叉确认）
  const longSignal = ma7 > ma21;
  const shortSignal = ma7 < ma21;

  if (longSignal) {
    side = 'LONG';
    score += 2.0; // 基础信号分
  } else if (shortSignal) {
    side = 'SHORT';
    score += 2.0;
  }

  // 2. 趋势确认
  const longTrend = ma7 > ma21 && ma21 > ma55;
  const shortTrend = ma7 < ma21 && ma21 < ma55;
  if (side === 'LONG' && longTrend) score += 2.5;
  if (side === 'SHORT' && shortTrend) score += 2.5;

  // 3. BB + RSI 确认
  if (side === 'LONG') {
    score += (pctB < 0.15 ? 1.5 : pctB < 0.30 ? 1.0 : 0);
    score += (rsiVal < 30 ? 1.5 : rsiVal < 40 ? 1.0 : 0);
    if (isGreen) score += 0.5;
  } else if (side === 'SHORT') {
    score += (pctB > 0.85 ? 1.5 : pctB > 0.70 ? 1.0 : 0);
    score += (rsiVal > 70 ? 1.5 : rsiVal > 60 ? 1.0 : 0);
    if (isRed) score += 0.5;
  }

  // 4. 波动率调整
  const volRegime = atrPct > 0.04 ? 'extreme' : atrPct > 0.025 ? 'high' : atrPct > 0.01 ? 'medium' : 'low';
  if (volRegime === 'extreme') score *= 0.5;
  else if (volRegime === 'high') score *= 0.8;
  else if (volRegime === 'low') score *= 1.1;

  // 5. 一致性奖励
  const consistency = (longSignal && longTrend) || (shortSignal && shortTrend);
  if (consistency) score *= 1.15;

  return {
    score: Math.round(score * 10) / 10,
    side,
    currentPrice,
    atr: atrVal,
    atrPct,
    ma7, ma21, ma55,
    rsi: rsiVal,
    pctB,
    volRegime,
  };
}

// ═══════════════════════════════════════════
// 回测单个策略（单个币种 + 单个参数组合）
// ═══════════════════════════════════════════
function backtestStrategy(klines, params) {
  const {
    minScore = 6,
    stopLossPct = 0.03,
    takeProfitMulti = 5,
    protectionMins = 30,
    reversalBufferPct = 0.04,
    trailingPeakPct = 0.03,
    trailingDropPct = 0.4,
    dexCostPct = 0.016,
    maxPositions = 3,
    initialCapital = 1000,
  } = params;

  let capital = initialCapital;
  let peakCapital = initialCapital;
  let maxDrawdown = 0;
  let totalPnl = 0;
  let wins = 0, losses = 0;
  let trades = [];
  let position = null;
  let cooldowns = {};
  const protectionMs = protectionMins * 60 * 1000;
  // K线间隔（1h = 3600s），但用K线数量来模拟时间
  const barIntervalMs = 3600 * 1000;

  // 需要至少55根K线来计算MA55
  const startIdx = 60;

  for (let i = startIdx; i < klines.length; i++) {
    const slice = klines.slice(0, i + 1);
    const signal = generateSignal(slice);
    const kline = klines[i];
    const klineTime = kline.openTime;
    const currentPrice = parseFloat(kline.close);

    // === 检查已有仓位 ===
    if (position) {
      const holdTime = klineTime - position.openTime;
      const holdMs = holdTime * 1000; // klineTime is in seconds
      const holdMinutes = holdMs / 60000;

      let rawPnlPct;
      if (position.side === 'LONG') {
        rawPnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
      } else {
        rawPnlPct = (position.entryPrice - currentPrice) / position.entryPrice;
      }
      const singleSideCost = dexCostPct / 2;
      const netPnlPct = rawPnlPct - singleSideCost;
      const leveragedPnl = netPnlPct * (position.leverage || 1);

      if (leveragedPnl > (position._peakPnl || 0)) position._peakPnl = leveragedPnl;

      let shouldClose = false;
      let reason = '';

      // 1. 极端止损
      if (netPnlPct <= -0.05) {
        shouldClose = true;
        reason = `极端止损 ${(netPnlPct * 100).toFixed(2)}%`;
      }
      // 2. 保护期
      else if (holdMinutes < protectionMins) {
        // 保护期内不检查
      }
      // 3. 固定止损
      else if (netPnlPct <= -stopLossPct) {
        shouldClose = true;
        reason = `止损 ${(netPnlPct * 100).toFixed(2)}%`;
      }
      // 4. 价格止损
      else if (position.side === 'LONG' && currentPrice <= position.sl) {
        shouldClose = true;
        reason = `价格止损 ${currentPrice} <= ${position.sl.toFixed(4)}`;
      }
      else if (position.side === 'SHORT' && currentPrice >= position.sl) {
        shouldClose = true;
        reason = `价格止损 ${currentPrice} >= ${position.sl.toFixed(4)}`;
      }
      // 5. 止盈
      else if (netPnlPct >= 0.05) {
        shouldClose = true;
        reason = `止盈 ${(netPnlPct * 100).toFixed(1)}%`;
      }
      // 6. 移动止盈
      else if ((position._peakPnl || 0) >= trailingPeakPct && netPnlPct <= (position._peakPnl || 0) * (1 - trailingDropPct)) {
        shouldClose = true;
        reason = `移动止盈 峰值${((position._peakPnl || 0) * 100).toFixed(1)}% → ${(netPnlPct * 100).toFixed(1)}%`;
      }
      // 7. 超时
      else if (holdMs / 3600000 >= 24 && netPnlPct < 0.005) {
        shouldClose = true;
        reason = `超时24h`;
      }
      // 8. 趋势反转
      else if (holdMinutes >= 15) {
        const ind = generateSignal(slice);
        const ma7v = ind.ma7;
        const ma21v = ind.ma21;
        const curRSI = ind.rsi;
        const buffer = reversalBufferPct;

        if (position.side === 'LONG' && ma7v < ma21v && (ma7v / ma21v < 1 - buffer) && curRSI < 75) {
          shouldClose = true;
          reason = `反转平多 MA7<MA21 RSI=${curRSI.toFixed(0)}`;
        }
        if (position.side === 'SHORT' && ma7v > ma21v && (ma7v / ma21v > 1 + buffer) && curRSI > 25) {
          shouldClose = true;
          reason = `反转平空 MA7>MA21 RSI=${curRSI.toFixed(0)}`;
        }
      }

      if (shouldClose) {
        const pnlUsd = position.positionUsdt * netPnlPct;
        capital += pnlUsd;
        totalPnl += pnlUsd;

        if (netPnlPct > 0) wins++;
        else losses++;

        trades.push({
          symbol: position.symbol,
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice: currentPrice,
          pnlPct: netPnlPct,
          pnlUsd: pnlUsd,
          reason,
          holdMinutes: holdMinutes,
          score: position.score,
        });

        cooldowns[position.symbol] = klineTime;
        position = null;

        // 更新最大回撤
        if (capital > peakCapital) peakCapital = capital;
        const dd = (peakCapital - capital) / peakCapital;
        if (dd > maxDrawdown) maxDrawdown = dd;
      }
    }

    // === 开新仓 ===
    if (!position && signal.score >= minScore && signal.side) {
      // 冷却检查
      const lastClose = cooldowns[signal.symbol] || 0;
      const cooldownMs = 14400000; // 4小时
      if ((klineTime - lastClose) * 1000 < cooldownMs) continue;

      // 冷却期可能在多币种时跨币种，这里单币种回测不需要
      const atrPctValue = signal.atrPct;
      const expectedMove = atrPctValue * takeProfitMulti;
      const minExpectedMove = 0.026; // 2.6%

      if (expectedMove < minExpectedMove && signal.pctB > 0.15) continue;

      const stopDistPct = Math.max(stopLossPct, 3 * signal.atr / signal.currentPrice);
      const positionUsdt = capital * 0.2; // 20%仓位

      if (positionUsdt < 5) continue; // 资金不足

      position = {
        symbol: signal.symbol,
        side: signal.side,
        entryPrice: currentPrice,
        positionUsdt,
        openTime: klineTime,
        sl: signal.side === 'LONG'
          ? currentPrice * (1 - stopDistPct)
          : currentPrice * (1 + stopDistPct),
        tp: signal.side === 'LONG'
          ? currentPrice * (1 + expectedMove)
          : currentPrice * (1 - expectedMove),
        stopDistPct,
        expectedMove,
        score: signal.score,
        atr: signal.atr,
        atrPct: signal.atrPct,
        _peakPnl: 0,
        leverage: 1,
      };
    }
  }

  // === 强制平仓最后一笔 ===
  if (position) {
    const lastPrice = parseFloat(klines[klines.length - 1].close);
    let rawPnlPct;
    if (position.side === 'LONG') {
      rawPnlPct = (lastPrice - position.entryPrice) / position.entryPrice;
    } else {
      rawPnlPct = (position.entryPrice - lastPrice) / position.entryPrice;
    }
    const netPnlPct = rawPnlPct - dexCostPct / 2;
    const pnlUsd = position.positionUsdt * netPnlPct;
    capital += pnlUsd;
    totalPnl += pnlUsd;
    if (netPnlPct > 0) wins++;
    else losses++;

    trades.push({
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: lastPrice,
      pnlPct: netPnlPct,
      pnlUsd: pnlUsd,
      reason: '回测结束',
      holdMinutes: 0,
      score: position.score,
    });
  }

  // === 统计 ===
  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? wins / totalTrades : 0;
  const avgWin = trades.filter(t => t.pnlPct > 0).reduce((a, b) => a + b.pnlPct, 0) / Math.max(1, wins);
  const avgLoss = Math.abs(trades.filter(t => t.pnlPct <= 0).reduce((a, b) => a + b.pnlPct, 0) / Math.max(1, losses));
  const profitFactor = avgLoss > 0 ? (avgWin * wins) / (avgLoss * losses) : 0;
  const roi = ((capital - initialCapital) / initialCapital) * 100;

  // 夏普比率（简化版）
  const pnls = trades.map(t => t.pnlPct);
  const avgPnl = pnls.length > 0 ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0;
  const stdPnl = pnls.length > 1 ? Math.sqrt(pnls.reduce((a, b) => a + (b - avgPnl) ** 2, 0) / (pnls.length - 1)) : 0;
  const sharpe = stdPnl > 0 ? (avgPnl / stdPnl) * Math.sqrt(365 * 24) : 0; // 年化

  return {
    totalTrades,
    wins,
    losses,
    winRate: winRate * 100,
    avgWin: avgWin * 100,
    avgLoss: avgLoss * 100,
    profitFactor,
    maxDrawdown: maxDrawdown * 100,
    roi,
    finalCapital: capital,
    totalPnl,
    sharpe,
    trades: trades.slice(-20), // 保留最后20笔
  };
}

// ═══════════════════════════════════════════
// 拉取 K线数据
// ═══════════════════════════════════════════
async function fetchKlines(symbol, interval, limit) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  try {
    const data = await fetch(url);
    return data.map(k => ({
      openTime: k[0] / 1000,
      open: k[1],
      high: k[2],
      low: k[3],
      close: k[4],
      volume: k[5],
      closeTime: k[6] / 1000,
    }));
  } catch (e) {
    console.error(`  ❌ ${symbol} 获取失败: ${e.message}`);
    return [];
  }
}

// ═══════════════════════════════════════════
// 主函数：回测所有策略 × 所有币种
// ═══════════════════════════════════════════
async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  v63 策略回测验证引擎 — 淘汰垃圾策略');
  console.log('═══════════════════════════════════════════\n');

  // 1. 拉取所有币种K线
  console.log('📊 拉取历史K线数据...');
  const allKlines = {};
  for (const sym of CONFIG.symbols) {
    allKlines[sym] = await fetchKlines(sym, CONFIG.interval, CONFIG.limit);
    console.log(`  ${sym}: ${allKlines[sym].length} 根K线`);
  }

  // 2. 逐币种回测当前策略
  console.log('\n═══ 第一阶段：单币种策略回测 ═══\n');

  const baseParams = {
    minScore: 6,
    stopLossPct: 0.03,
    takeProfitMulti: 5,
    protectionMins: 30,
    reversalBufferPct: 0.04,
    trailingPeakPct: 0.03,
    trailingDropPct: 0.4,
    dexCostPct: CONFIG.dexCostPct,
    initialCapital: CONFIG.initialCapital,
  };

  const perSymbolResults = {};
  for (const sym of CONFIG.symbols) {
    if (allKlines[sym].length < 60) continue;
    const result = backtestStrategy(allKlines[sym], { ...baseParams, symbol: sym });
    perSymbolResults[sym] = result;
    console.log(`  ${sym}: ${result.totalTrades}笔 | 胜率${result.winRate.toFixed(1)}% | 盈亏比${(result.avgWin / Math.max(0.01, result.avgLoss)).toFixed(2)} | ROI${result.roi.toFixed(2)}% | 回撤${result.maxDrawdown.toFixed(1)}% | 夏普${result.sharpe.toFixed(2)}`);
  }

  // 3. 多币种组合回测（模拟实际运行）
  console.log('\n═══ 第二阶段：多币种组合回测（模拟实盘） ═══\n');

  // 合并所有K线按时间排序
  const allBars = [];
  for (const sym of CONFIG.symbols) {
    for (const k of allKlines[sym]) {
      allBars.push({ ...k, symbol: sym });
    }
  }
  allBars.sort((a, b) => a.openTime - b.openTime);

  // 按时间步进，每步检查所有币种
  const multiResult = backtestMultiSymbol(allKlines, CONFIG.symbols, baseParams);
  console.log(`  组合回测: ${multiResult.totalTrades}笔 | 胜率${multiResult.winRate.toFixed(1)}% | ROI${multiResult.roi.toFixed(2)}% | 回撤${multiResult.maxDrawdown.toFixed(1)}% | 夏普${multiResult.sharpe.toFixed(2)}`);
  console.log(`  最终资金: $${multiResult.finalCapital.toFixed(2)} (初始$${CONFIG.initialCapital})`);

  // 4. 策略排名
  console.log('\n═══ 第三阶段：币种盈利能力排名 ═══\n');
  const ranked = Object.entries(perSymbolResults)
    .sort((a, b) => b[1].roi - a[1].roi);

  console.log('  排名 | 币种   | 交易数 | 胜率   | 盈亏比 | ROI    | 最大回撤 | 夏普  | 评级');
  console.log('  ────┼────────┼────────┼────────┼────────┼────────┼──────────┼───────┼─────');
  for (let i = 0; i < ranked.length; i++) {
    const [sym, r] = ranked[i];
    const ratio = r.avgLoss > 0 ? r.avgWin / r.avgLoss : 0;
    let grade = 'D';
    if (r.roi > 10 && r.winRate > 40) grade = 'A';
    else if (r.roi > 0 && r.winRate > 30) grade = 'B';
    else if (r.roi > -5) grade = 'C';
    const flag = grade === 'D' ? '🗑️' : grade === 'C' ? '⚠️' : grade === 'B' ? '✅' : '🏆';
    console.log(`  ${i + 1}   | ${sym.padEnd(6)} | ${String(r.totalTrades).padEnd(6)} | ${r.winRate.toFixed(1).padEnd(6)}% | ${ratio.toFixed(2).padEnd(6)} | ${r.roi.toFixed(2).padEnd(6)}% | ${r.maxDrawdown.toFixed(1).padEnd(8)}% | ${r.sharpe.toFixed(2).padEnd(5)} | ${flag} ${grade}`);
  }

  // 5. 淘汰建议
  console.log('\n═══ 第四阶段：淘汰建议 ═══\n');
  const garbage = ranked.filter(([s, r]) => r.roi < -10 || (r.winRate < 20 && r.totalTrades > 5));
  const weak = ranked.filter(([s, r]) => r.roi >= -10 && r.roi < 0);
  const good = ranked.filter(([s, r]) => r.roi >= 0 && r.roi < 10);
  const excellent = ranked.filter(([s, r]) => r.roi >= 10);

  if (garbage.length > 0) {
    console.log('  🗑️ 淘汰（ROI < -10% 或 胜率 < 20%）:');
    for (const [s, r] of garbage) console.log(`     ${s}: ROI=${r.roi.toFixed(2)}% 胜率=${r.winRate.toFixed(1)}%`);
  }
  if (weak.length > 0) {
    console.log('  ⚠️ 警告（ROI < 0%）:');
    for (const [s, r] of weak) console.log(`     ${s}: ROI=${r.roi.toFixed(2)}% 胜率=${r.winRate.toFixed(1)}%`);
  }
  if (good.length > 0) {
    console.log('  ✅ 可用（0% ≤ ROI < 10%）:');
    for (const [s, r] of good) console.log(`     ${s}: ROI=${r.roi.toFixed(2)}% 胜率=${r.winRate.toFixed(1)}%`);
  }
  if (excellent.length > 0) {
    console.log('  🏆 优秀（ROI ≥ 10%）:');
    for (const [s, r] of excellent) console.log(`     ${s}: ROI=${r.roi.toFixed(2)}% 胜率=${r.winRate.toFixed(1)}%`);
  }

  // 6. 保存结果
  const report = {
    timestamp: new Date().toISOString(),
    config: CONFIG,
    perSymbol: perSymbolResults,
    multiSymbol: multiResult,
    ranking: ranked.map(([s, r]) => ({ symbol: s, ...r })),
    garbage: garbage.map(([s]) => s),
    weak: weak.map(([s]) => s),
    good: good.map(([s]) => s),
    excellent: excellent.map(([s]) => s),
  };

  const reportPath = path.join(__dirname, '..', 'data', 'backtest-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n📄 报告已保存: ${reportPath}`);

  return report;
}

// ═══════════════════════════════════════════
// 多币种组合回测
// ═══════════════════════════════════════════
function backtestMultiSymbol(allKlines, symbols, params) {
  const {
    minScore = 6,
    stopLossPct = 0.03,
    takeProfitMulti = 5,
    protectionMins = 30,
    reversalBufferPct = 0.04,
    trailingPeakPct = 0.03,
    trailingDropPct = 0.4,
    dexCostPct = 0.016,
    maxPositions = 3,
    initialCapital = 1000,
  } = params;

  let capital = initialCapital;
  let peakCapital = initialCapital;
  let maxDrawdown = 0;
  let totalPnl = 0;
  let wins = 0, losses = 0;
  let trades = [];
  let positions = {}; // symbol -> position
  let cooldowns = {};
  const protectionMs = protectionMins * 60 * 1000;
  const barIntervalMs = 3600 * 1000;

  // 找到最长的K线序列
  const maxLen = Math.max(...symbols.map(s => allKlines[s]?.length || 0));

  for (let i = 60; i < maxLen; i++) {
    for (const sym of symbols) {
      const klines = allKlines[sym];
      if (!klines || klines.length <= i) continue;

      const slice = klines.slice(0, i + 1);
      const kline = klines[i];
      const klineTime = kline.openTime;
      const currentPrice = parseFloat(kline.close);

      // === 检查已有仓位 ===
      if (positions[sym]) {
        const pos = positions[sym];
        const holdMs = (klineTime - pos.openTime) * 1000;
        const holdMinutes = holdMs / 60000;

        let rawPnlPct;
        if (pos.side === 'LONG') {
          rawPnlPct = (currentPrice - pos.entryPrice) / pos.entryPrice;
        } else {
          rawPnlPct = (pos.entryPrice - currentPrice) / pos.entryPrice;
        }
        const singleSideCost = dexCostPct / 2;
        const netPnlPct = rawPnlPct - singleSideCost;
        const leveragedPnl = netPnlPct * (pos.leverage || 1);

        if (leveragedPnl > (pos._peakPnl || 0)) pos._peakPnl = leveragedPnl;

        let shouldClose = false;
        let reason = '';

        if (netPnlPct <= -0.05) { shouldClose = true; reason = `极端止损`; }
        else if (holdMinutes < protectionMins) { /* 保护期 */ }
        else if (netPnlPct <= -stopLossPct) { shouldClose = true; reason = `止损 ${(netPnlPct * 100).toFixed(2)}%`; }
        else if (pos.side === 'LONG' && currentPrice <= pos.sl) { shouldClose = true; reason = `价格止损`; }
        else if (pos.side === 'SHORT' && currentPrice >= pos.sl) { shouldClose = true; reason = `价格止损`; }
        else if (netPnlPct >= 0.05) { shouldClose = true; reason = `止盈`; }
        else if ((pos._peakPnl || 0) >= trailingPeakPct && netPnlPct <= (pos._peakPnl || 0) * (1 - trailingDropPct)) {
          shouldClose = true; reason = `移动止盈`;
        }
        else if (holdMs / 3600000 >= 24 && netPnlPct < 0.005) { shouldClose = true; reason = `超时`; }
        else if (holdMinutes >= 15) {
          const ind = generateSignal(slice);
          if (pos.side === 'LONG' && ind.ma7 < ind.ma21 && (ind.ma7 / ind.ma21 < 1 - reversalBufferPct) && ind.rsi < 75) {
            shouldClose = true; reason = `反转平多`;
          }
          if (pos.side === 'SHORT' && ind.ma7 > ind.ma21 && (ind.ma7 / ind.ma21 > 1 + reversalBufferPct) && ind.rsi > 25) {
            shouldClose = true; reason = `反转平空`;
          }
        }

        if (shouldClose) {
          const pnlUsd = pos.positionUsdt * netPnlPct;
          capital += pnlUsd;
          totalPnl += pnlUsd;
          if (netPnlPct > 0) wins++; else losses++;

          trades.push({ symbol: sym, side: pos.side, pnlPct: netPnlPct, pnlUsd, reason, holdMinutes, score: pos.score });
          cooldowns[sym] = klineTime;
          delete positions[sym];

          if (capital > peakCapital) peakCapital = capital;
          const dd = (peakCapital - capital) / peakCapital;
          if (dd > maxDrawdown) maxDrawdown = dd;
        }
      }

      // === 开新仓 ===
      const openCount = Object.keys(positions).length;
      if (openCount < maxPositions && !positions[sym]) {
        const lastClose = cooldowns[sym] || 0;
        if ((klineTime - lastClose) * 1000 < 14400000) continue; // 4h冷却

        const signal = generateSignal(slice);
        if (signal.score < minScore || !signal.side) continue;

        const atrPctValue = signal.atrPct;
        const expectedMove = atrPctValue * takeProfitMulti;
        if (expectedMove < 0.026 && signal.pctB > 0.15) continue;

        const stopDist = Math.max(stopLossPct, 3 * signal.atr / signal.currentPrice);
        const perPosCapital = capital / (maxPositions - openCount);
        const positionUsdt = Math.min(perPosCapital * 0.25, capital * 0.3);

        if (positionUsdt < 5) continue;

        positions[sym] = {
          symbol: sym,
          side: signal.side,
          entryPrice: currentPrice,
          positionUsdt,
          openTime: klineTime,
          sl: signal.side === 'LONG' ? currentPrice * (1 - stopDist) : currentPrice * (1 + stopDist),
          stopDistPct: stopDist,
          expectedMove,
          score: signal.score,
          _peakPnl: 0,
          leverage: 1,
        };
      }
    }
  }

  // 强平所有剩余仓位
  for (const [sym, pos] of Object.entries(positions)) {
    const klines = allKlines[sym];
    const lastPrice = parseFloat(klines[klines.length - 1].close);
    let rawPnlPct = pos.side === 'LONG'
      ? (lastPrice - pos.entryPrice) / pos.entryPrice
      : (pos.entryPrice - lastPrice) / pos.entryPrice;
    const netPnlPct = rawPnlPct - dexCostPct / 2;
    const pnlUsd = pos.positionUsdt * netPnlPct;
    capital += pnlUsd;
    totalPnl += pnlUsd;
    if (netPnlPct > 0) wins++; else losses++;
    trades.push({ symbol: sym, side: pos.side, pnlPct: netPnlPct, pnlUsd, reason: '回测结束' });
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? wins / totalTrades : 0;
  const avgWin = trades.filter(t => t.pnlPct > 0).reduce((a, b) => a + b.pnlPct, 0) / Math.max(1, wins);
  const avgLoss = Math.abs(trades.filter(t => t.pnlPct <= 0).reduce((a, b) => a + b.pnlPct, 0) / Math.max(1, losses));
  const profitFactor = avgLoss > 0 ? (avgWin * wins) / (avgLoss * losses) : 0;
  const roi = ((capital - initialCapital) / initialCapital) * 100;

  const pnls = trades.map(t => t.pnlPct);
  const avgPnl = pnls.length > 0 ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0;
  const stdPnl = pnls.length > 1 ? Math.sqrt(pnls.reduce((a, b) => a + (b - avgPnl) ** 2, 0) / (pnls.length - 1)) : 0;
  const sharpe = stdPnl > 0 ? (avgPnl / stdPnl) * Math.sqrt(365 * 24) : 0;

  return {
    totalTrades, wins, losses,
    winRate: winRate * 100,
    avgWin: avgWin * 100, avgLoss: avgLoss * 100,
    profitFactor,
    maxDrawdown: maxDrawdown * 100,
    roi, finalCapital: capital, totalPnl, sharpe,
    trades: trades.slice(-20),
  };
}

// ═══════════════════════════════════════════
// 导出（供 grid-search.js 复用）
// ═══════════════════════════════════════════
module.exports = { generateSignal, fetchKlines, backtestStrategy, backtestMultiSymbol, sma, ema, rsi, atr, bollingerBands, CONFIG };

// ═══════════════════════════════════════════
// 运行（仅当直接执行时）
// ═══════════════════════════════════════════
if (require.main === module) {
  main().then(report => {
    console.log('\n✅ 策略回测验证完成');
    process.exit(0);
  }).catch(e => {
    console.error('❌ 回测失败:', e);
    process.exit(1);
  });
}
