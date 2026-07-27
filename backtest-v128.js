#!/usr/bin/env node
/**
 * v128 B策略历史回撤
 * 拉取Binance历史K线，用当前策略逻辑模拟交易
 * 输出: 胜率、回报率、最大回撤、盈亏比、趋势仓vs轨道仓对比
 */

const https = require('https');

// ═══ 配置（和bb-engine.js一致）═══
const CONFIG = {
  bbPeriod: 20, bbStd: 2.0,
  klineInterval: '5m',
  adxThreshold: 20,
  minAtrPct: 0.10,
  narrowCount: 2,
  bandwidthOpenBlock: 90, bandwidthOpenAllow: 85,
  profitTriggerPct: 1.5, trendProfitTriggerPct: 2.5,
  atrStopMultiplier: 2.0,
  singleKLossPct: 3,
  ultimateLossPct: 15,
  atrPeriod: 14, volumeMaPeriod: 20,
  leverage: 3,
  maxPositions: 5, trendMax: 3, bbMax: 2,
  perPositionPct: 0.12, // 中波动默认
};

// ═══ 指标计算 ═══
const Indicators = {
  sma(data, period) {
    if (data.length < period) return null;
    const slice = data.slice(-period);
    return slice.reduce((a,b) => a+b, 0) / period;
  },

  ema(klines, period) {
    if (klines.length < period) return null;
    const k = 2 / (period + 1);
    let ema = klines.slice(0, period).reduce((s,c) => s + c.close, 0) / period;
    for (let i = period; i < klines.length; i++) {
      ema = klines[i].close * k + ema * (1 - k);
    }
    return ema;
  },

  bollinger(klines, period = 20, std = 2.0) {
    if (klines.length < period) return null;
    const slice = klines.slice(-period);
    const closes = slice.map(k => k.close);
    const mid = closes.reduce((a,b) => a+b, 0) / period;
    const variance = closes.reduce((s,c) => s + (c-mid)**2, 0) / period;
    const sd = Math.sqrt(variance);
    return { mid, upper: mid + sd * std, lower: mid - sd * std, bandwidth: (sd*4)/mid*100 };
  },

  atr(klines, period = 14) {
    if (klines.length < period + 1) return null;
    let trs = [];
    for (let i = 1; i < klines.length; i++) {
      const h = klines[i].high, l = klines[i].low, pc = klines[i-1].close;
      trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
    }
    return trs.slice(-period).reduce((a,b) => a+b, 0) / period;
  },

  adx(klines, period = 14) {
    if (klines.length < period * 2) return null;
    let dmPlus = [], dmMinus = [], trs = [];
    for (let i = 1; i < klines.length; i++) {
      const up = klines[i].high - klines[i-1].high;
      const down = klines[i-1].low - klines[i].low;
      const dmP = (up > down && up > 0) ? up : 0;
      const dmM = (down > up && down > 0) ? down : 0;
      const h = klines[i].high, l = klines[i].low, pc = klines[i-1].close;
      dmPlus.push(dmP); dmMinus.push(dmM);
      trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
    }
    // Wilder smoothing
    let atr = trs.slice(0, period).reduce((a,b) => a+b, 0);
    let sdmP = dmPlus.slice(0, period).reduce((a,b) => a+b, 0);
    let sdmM = dmMinus.slice(0, period).reduce((a,b) => a+b, 0);
    let dxs = [];
    for (let i = period; i < trs.length; i++) {
      atr = atr - atr/period + trs[i];
      sdmP = sdmP - sdmP/period + dmPlus[i];
      sdmM = sdmM - sdmM/period + dmMinus[i];
      const diP = sdmP / atr * 100;
      const diM = sdmM / atr * 100;
      const dx = Math.abs(diP - diM) / (diP + diM) * 100;
      dxs.push(dx);
    }
    if (dxs.length < period) return null;
    return dxs.slice(-period).reduce((a,b) => a+b, 0) / period;
  },

  bandwidthPercentile(klines, lookback = 100) {
    const bws = [];
    for (let i = 0; i <= klines.length - 20; i++) {
      const slice = klines.slice(i, i + 20);
      if (slice.length < 20) continue;
      const bb = this.bollinger(slice, 20, 2.0);
      if (bb) bws.push(bb.bandwidth);
      if (bws.length >= lookback) break;
    }
    if (bws.length < 10) return null;
    bws.sort((a,b) => a-b);
    const currentBB = this.bollinger(klines.slice(-20), 20, 2.0);
    if (!currentBB) return null;
    const rank = bws.filter(b => b < currentBB.bandwidth).length;
    return rank / bws.length * 100;
  },

  isNarrowing(klines, count = 2) {
    const slice = klines.slice(-count - 1);
    for (let i = 1; i < slice.length; i++) {
      const bb1 = this.bollinger(slice.slice(0, i + 20 > slice.length ? slice.length : i + 20), 20, 2.0);
      const bb2 = this.bollinger(slice.slice(0, i - 1 + 20 > slice.length ? slice.length : i - 1 + 20), 20, 2.0);
      if (!bb1 || !bb2) continue;
      if (bb1.bandwidth >= bb2.bandwidth) return false;
    }
    return true;
  },

  volumeMA(klines, period = 20) {
    const slice = klines.slice(-period);
    return slice.reduce((s,k) => s + k.volume, 0) / period;
  },
};

// ═══ 拉取K线 ═══
async function fetchKlines(symbol, interval = '5m', limit = 1000) {
  return new Promise((resolve, reject) => {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const raw = JSON.parse(data);
          const klines = raw.map(k => ({
            time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5]
          }));
          resolve(klines);
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ═══ 策略信号（和bb-engine.js一致）═══
function checkOpenCondition(klines) {
  const bwPercentile = Indicators.bandwidthPercentile(klines, 100);
  if (bwPercentile === null) return { allowed: false };
  if (bwPercentile > 90) return { allowed: false };

  const adx = Indicators.adx(klines, 14);
  if (!adx) return { allowed: false };

  const atr = Indicators.atr(klines, 14);
  const lastClose = klines[klines.length-1].close;
  const lastK = klines[klines.length-1];
  const atrPct = atr / lastClose * 100;
  if (atrPct < 0.10) return { allowed: false };

  const bb = Indicators.bollinger(klines, 20, 2.0);
  if (!bb) return { allowed: false };
  const ema20 = Indicators.ema(klines, 20);
  const ema60 = Indicators.ema(klines, 60);
  if (!ema20 || !ema60) return { allowed: false };
  const isUptrend = ema20 > ema60;
  const isDowntrend = ema20 < ema60;

  // 趋势启动开仓
  const emaGapPct = Math.abs(ema20 - ema60) / ema60 * 100;
  const isEarlyTrend = emaGapPct < 0.8;
  const adxRising = false // 临时关闭趋势开仓;
  const volMA = Indicators.volumeMA(klines, 20);
  const volSpike = lastK.volume > volMA * 2.0;
  const prevAdx1 = Indicators.adx(klines.slice(0,-1), 14);
  const prevAdx2 = Indicators.adx(klines.slice(0,-2), 14);
  const adxGoingUp = prevAdx1 && prevAdx2 && adx > prevAdx1 && prevAdx1 > prevAdx2;

  if (isUptrend && isEarlyTrend && adxRising && adxGoingUp && volSpike) {
    return { allowed: true, direction: 'LONG', mode: '趋势' };
  }
  if (isDowntrend && isEarlyTrend && adxRising && adxGoingUp && volSpike) {
    return { allowed: true, direction: 'SHORT', mode: '趋势' };
  }

  // BB轨道开仓
  if (adx < 20) return { allowed: false };
  if (bwPercentile >= 85) return { allowed: false };
  const isNarrowing = Indicators.isNarrowing(klines, 2);
  if (!isNarrowing) return { allowed: false };

  if (lastClose <= bb.lower && isUptrend) {
    return { allowed: true, direction: 'LONG', mode: '轨道' };
  }
  if (lastClose >= bb.upper && isDowntrend) {
    return { allowed: true, direction: 'SHORT', mode: '轨道' };
  }

  return { allowed: false };
}

// ═══ 回撤引擎 ═══
async function backtest(symbol, klines) {
  const trades = [];
  let positions = [];
  let balance = 1000; // 模拟$1000起始

  const minKlines = 120;
  for (let i = minKlines; i < klines.length; i++) {
    const window = klines.slice(0, i + 1);
    const currentKline = klines[i];

    // ── 管理已有仓位 ──
    for (let j = positions.length - 1; j >= 0; j--) {
      const pos = positions[j];
      const price = currentKline.close;
      let pnlPct;
      if (pos.side === 'LONG') pnlPct = (price - pos.entry) / pos.entry * 100 * CONFIG.leverage;
      else pnlPct = (pos.entry - price) / pos.entry * 100 * CONFIG.leverage;

      // ATR止损
      const atr = Indicators.atr(window, 14);
      if (atr) {
        const atrStopPct = atr / price * 100 * CONFIG.atrStopMultiplier;
        if (pnlPct <= -atrStopPct) {
          trades.push({ symbol, side: pos.side, mode: pos.mode, entry: pos.entry, exit: price, pnlPct, reason: 'ATR止损' });
          balance += balance * pos.positionPct * pnlPct / 100;
          positions.splice(j, 1);
          continue;
        }
      }

      // 单K止损(不含杠杆)
      if (pos.prevClose) {
        let klineLossPct;
        if (pos.side === 'LONG') klineLossPct = (pos.prevClose - price) / pos.prevClose * 100;
        else klineLossPct = (price - pos.prevClose) / pos.prevClose * 100;
        if (klineLossPct >= CONFIG.singleKLossPct) {
          trades.push({ symbol, side: pos.side, mode: pos.mode, entry: pos.entry, exit: price, pnlPct, reason: '单K止损' });
          balance += balance * pos.positionPct * pnlPct / 100;
          positions.splice(j, 1);
          continue;
        }
      }

      // 终极止损
      if (pnlPct <= -CONFIG.ultimateLossPct) {
        trades.push({ symbol, side: pos.side, mode: pos.mode, entry: pos.entry, exit: price, pnlPct, reason: '终极止损' });
        balance += balance * pos.positionPct * pnlPct / 100;
        positions.splice(j, 1);
        continue;
      }

      // 趋势反转止损
      const ema20 = Indicators.ema(window, 20);
      const ema60 = Indicators.ema(window, 60);
      if (ema20 && ema60) {
        const last3Closes = window.slice(-3).map(k => k.close);
        if (pos.side === 'LONG' && ema20 < ema60 && last3Closes.every(c => c < ema20)) {
          trades.push({ symbol, side: pos.side, mode: pos.mode, entry: pos.entry, exit: price, pnlPct, reason: '趋势反转' });
          balance += balance * pos.positionPct * pnlPct / 100;
          positions.splice(j, 1);
          continue;
        }
        if (pos.side === 'SHORT' && ema20 > ema60 && last3Closes.every(c => c > ema20)) {
          trades.push({ symbol, side: pos.side, mode: pos.mode, entry: pos.entry, exit: price, pnlPct, reason: '趋势反转' });
          balance += balance * pos.positionPct * pnlPct / 100;
          positions.splice(j, 1);
          continue;
        }
      }

      // 止盈
      const triggerPct = pos.mode === '趋势' ? CONFIG.trendProfitTriggerPct : CONFIG.profitTriggerPct;
      if (pnlPct >= triggerPct) {
        if (!pos.peakPnlPct || pnlPct > pos.peakPnlPct) pos.peakPnlPct = pnlPct;
        const drawdown = pos.peakPnlPct - pnlPct;
        // 移动止盈
        if (pos.peakPnlPct > triggerPct + 0.5 && drawdown >= 0.5) {
          trades.push({ symbol, side: pos.side, mode: pos.mode, entry: pos.entry, exit: price, pnlPct, reason: '移动止盈' });
          balance += balance * pos.positionPct * pnlPct / 100;
          positions.splice(j, 1);
          continue;
        }
        // 趋势仓: 反向轨道止盈
        const bb = Indicators.bollinger(window, 20, 2.0);
        if (pos.mode === '趋势' && bb) {
          if ((pos.side === 'LONG' && price >= bb.upper) || (pos.side === 'SHORT' && price <= bb.lower)) {
            trades.push({ symbol, side: pos.side, mode: pos.mode, entry: pos.entry, exit: price, pnlPct, reason: '趋势止盈' });
            balance += balance * pos.positionPct * pnlPct / 100;
            positions.splice(j, 1);
            continue;
          }
        }
        // 轨道仓: 中轨止盈
        if (pos.mode === '轨道' && bb) {
          if ((pos.side === 'LONG' && price >= bb.mid) || (pos.side === 'SHORT' && price <= bb.mid)) {
            trades.push({ symbol, side: pos.mode === '趋势' ? '趋势' : '轨道', entry: pos.entry, exit: price, pnlPct, reason: '中轨止盈' });
            // 修复
            const tradeMode = pos.mode;
            trades[trades.length-1].mode = tradeMode;
            balance += balance * pos.positionPct * pnlPct / 100;
            positions.splice(j, 1);
            continue;
          }
        }
      }

      pos.prevClose = price;
    }

    // ── 开新仓 ──
    if (positions.length >= CONFIG.maxPositions) continue;

    const signal = checkOpenCondition(window);
    if (signal.allowed) {
      // mode分名额
      const trendCount = positions.filter(p => p.mode === '趋势').length;
      const bbCount = positions.filter(p => p.mode === '轨道').length;
      if (signal.mode === '趋势' && trendCount >= CONFIG.trendMax) continue;
      if (signal.mode === '轨道' && bbCount >= CONFIG.bbMax) continue;

      const atr = Indicators.atr(window, 14);
      const atrPct = atr / currentKline.close * 100;
      let positionPct;
      if (atrPct > 0.5) positionPct = 0.08;
      else if (atrPct > 0.2) positionPct = 0.12;
      else positionPct = 0.15;

      positions.push({
        symbol, side: signal.direction, mode: signal.mode,
        entry: currentKline.close, positionPct,
        peakPnlPct: 0, prevClose: currentKline.close,
      });
    }
  }

  return { symbol, trades, finalBalance: balance };
}

// ═══ 主函数 ═══
async function main() {
  // 回撤标的（主流币+热门币）
  const symbols = [
    'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT',
    'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'MATICUSDT',
  ];

  console.log('════════════════════════════════════════');
  console.log('  v128 B策略历史回撤');
  console.log('  K线: 5min × 1000根 ≈ 3.5天');
  console.log('  起始资金: $1000/币');
  console.log('════════════════════════════════════════');
  console.log('');

  let allTrades = [];
  let totalInitialBalance = 0;
  let totalFinalBalance = 0;

  for (const symbol of symbols) {
    try {
      const klines = await fetchKlines(symbol, '5m', 1000);
      if (klines.length < 120) { console.log(`${symbol}: K线不足`); continue; }
      const result = await backtest(symbol, klines);
      allTrades = allTrades.concat(result.trades);
      totalInitialBalance += 1000;
      totalFinalBalance += result.finalBalance;
      const wr = result.trades.length > 0 ? result.trades.filter(t => t.pnlPct > 0).length / result.trades.length * 100 : 0;
      console.log(`${symbol}: ${result.trades.length}笔 胜率${wr.toFixed(0)}% 余额$${result.finalBalance.toFixed(2)} ${result.finalBalance > 1000 ? '✅' : '❌'}`);
    } catch(e) {
      console.log(`${symbol}: 拉取失败 ${e.message}`);
    }
  }

  // ── 汇总统计 ──
  console.log('');
  console.log('════════════════════════════════════════');
  console.log('  回撤汇总');
  console.log('════════════════════════════════════════');

  const wins = allTrades.filter(t => t.pnlPct > 0);
  const losses = allTrades.filter(t => t.pnlPct <= 0);
  const winRate = allTrades.length > 0 ? wins.length / allTrades.length * 100 : 0;
  const totalReturn = (totalFinalBalance - totalInitialBalance) / totalInitialBalance * 100;

  console.log(`总交易: ${allTrades.length}笔`);
  console.log(`胜: ${wins.length}  负: ${losses.length}`);
  console.log(`胜率: ${winRate.toFixed(1)}%`);
  console.log(`总回报率: ${totalReturn.toFixed(1)}%`);
  console.log(`初始资金: $${totalInitialBalance}  最终: $${totalFinalBalance.toFixed(2)}`);

  // 盈亏比
  const avgWin = wins.length > 0 ? wins.reduce((s,t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s,t) => s + t.pnlPct, 0) / losses.length) : 0;
  const profitFactor = avgLoss > 0 ? avgWin / avgLoss : 0;
  console.log(`平均盈利: ${avgWin.toFixed(2)}%  平均亏损: -${avgLoss.toFixed(2)}%`);
  console.log(`盈亏比: ${profitFactor.toFixed(2)}`);

  // 趋势仓 vs 轨道仓
  const trendTrades = allTrades.filter(t => t.mode === '趋势');
  const bbTrades = allTrades.filter(t => t.mode === '轨道');
  const trendWR = trendTrades.length > 0 ? trendTrades.filter(t => t.pnlPct > 0).length / trendTrades.length * 100 : 0;
  const bbWR = bbTrades.length > 0 ? bbTrades.filter(t => t.pnlPct > 0).length / bbTrades.length * 100 : 0;
  const trendPnl = trendTrades.reduce((s,t) => s + t.pnlPct, 0);
  const bbPnl = bbTrades.reduce((s,t) => s + t.pnlPct, 0);

  console.log('');
  console.log('── 趋势仓 vs 轨道仓 ──');
  console.log(`趋势仓: ${trendTrades.length}笔 胜率${trendWR.toFixed(0)}% 总PnL=${trendPnl.toFixed(1)}%`);
  console.log(`轨道仓: ${bbTrades.length}笔 胜率${bbWR.toFixed(0)}% 总PnL=${bbPnl.toFixed(1)}%`);

  // 止损方式分布
  console.log('');
  console.log('── 止损/止盈分布 ──');
  const reasons = {};
  for (const t of allTrades) {
    reasons[t.reason] = (reasons[t.reason] || 0) + 1;
  }
  for (const [reason, count] of Object.entries(reasons).sort((a,b) => b[1] - a[1])) {
    console.log(`  ${reason}: ${count}笔`);
  }

  // 最大单笔盈亏
  const maxWin = Math.max(...allTrades.map(t => t.pnlPct), 0);
  const maxLoss = Math.min(...allTrades.map(t => t.pnlPct), 0);
  console.log('');
  console.log(`最大单笔盈利: +${maxWin.toFixed(2)}%`);
  console.log(`最大单笔亏损: ${maxLoss.toFixed(2)}%`);

  console.log('');
  console.log('════════════════════════════════════════');
}

main().catch(e => { console.error(e); process.exit(1); });
