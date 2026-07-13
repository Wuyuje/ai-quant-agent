/**
 * Backtest Engine — 历史数据回测系统
 * 
 * 功能：
 *   1. 拉取 Binance 历史 K线（1h/4h，最多 1500 根）
 *   2. 逐根回放，模拟 AI 决策引擎完整决策链
 *   3. 支持多币种、多周期回测
 *   4. 输出：胜率、盈亏比、最大回撤、夏普比率、总收益
 *   5. 对比：scanner 筛选 vs 全量扫描 vs 静态列表
 * 
 * 注意：回测不调用 DeepSeek/OnChain（避免 API 限速和延迟），
 *       使用模拟数据替代，重点验证规则引擎和技术面。
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

class BacktestEngine {
  constructor() {
    this.baseURL = 'https://fapi.binance.com';
    this.results = [];
  }

  _fetch(url, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), timeout);
      https.get(url, { timeout }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
      }).on('error', e => { clearTimeout(timer); reject(e); });
    });
  }

  // ============ K线指标计算 ============
  _sma(arr, p) { if (arr.length < p) return arr[arr.length-1]||0; return arr.slice(-p).reduce((a,b)=>a+b,0)/p; }
  _ema(arr, p) {
    if (arr.length < p) return arr[arr.length-1]||0;
    const k = 2/(p+1);
    let e = arr.slice(0,p).reduce((a,b)=>a+b,0)/p;
    for (let i=p; i<arr.length; i++) e = arr[i]*k + e*(1-k);
    return e;
  }
  _rsi(c, p=14) {
    if (c.length < p+1) return 50;
    const ch = [];
    for (let i=c.length-p; i<c.length; i++) ch.push(c[i]-c[i-1]);
    const g = ch.filter(x=>x>0), l = ch.filter(x=>x<0).map(x=>Math.abs(x));
    const ag = g.length ? g.reduce((a,b)=>a+b,0)/p : 0;
    const al = l.length ? l.reduce((a,b)=>a+b,0)/p : 0;
    return al===0 ? 100 : 100-(100/(1+ag/al));
  }
  _atr(h, l, p=14) {
    if (h.length < 2) return 0;
    const trs = [];
    for (let i=Math.max(1,h.length-p); i<h.length; i++) {
      trs.push(Math.max(h[i]-l[i], Math.abs(h[i]-h[i-1]), Math.abs(l[i]-l[i-1])));
    }
    return trs.reduce((a,b)=>a+b,0)/trs.length;
  }
  _bb(c, p=20, s=2) {
    const sl = c.slice(-p);
    const m = sl.reduce((a,b)=>a+b,0)/p;
    const v = sl.reduce((a,x)=>a+Math.pow(x-m,2),0)/p;
    const sd = Math.sqrt(v);
    return { upper: m+sd*s, middle: m, lower: m-sd*s };
  }

  calcIndicators(closes, highs, lows, volumes, idx) {
    const window = idx + 1;
    const c = closes.slice(0, window);
    const h = highs.slice(0, window);
    const l = lows.slice(0, window);
    const v = volumes.slice(0, window);
    if (c.length < 26) return null;

    const price = c[c.length-1];
    const ma7 = this._sma(c, 7);
    const ma25 = this._sma(c, 25);
    const prevMa7 = this._sma(c.slice(0,-1), 7);
    const ma7Dir = ma7 > prevMa7*1.0001 ? 'up' : ma7 < prevMa7*0.9999 ? 'down' : 'flat';
    const rsi = this._rsi(c, 14);
    const atr = this._atr(h, l, 14);
    const atrPct = (atr/price)*100;
    const bb = this._bb(c, 20);
    const volSma = this._sma(v, 20);
    const volRatio = volSma > 0 ? v[v.length-1]/volSma : 1;

    const pVsMa7 = price > ma7 ? 'above' : 'below';
    const prevPrice = c[c.length-2];
    const ma7CrossAbove = prevPrice <= this._sma(c.slice(0,-1), 7) && price > ma7;
    const ma7CrossBelow = prevPrice >= this._sma(c.slice(0,-1), 7) && price < ma7;

    return { price, ma7, ma25, ma7Direction: ma7Dir, priceVsMa7: pVsMa7, ma7CrossAbove, ma7CrossBelow,
             rsi, atr, atrPercent: atrPct, bb, volume: { current: v[v.length-1], avg: volSma, ratio: volRatio } };
  }

  // ============ 规则引擎决策（模拟 AI Engine v8）============
  decide(ind, fundingRate) {
    if (!ind) return { action: 'WAIT', reason: 'no_data' };

    const { price, ma7, ma25, ma7Direction, priceVsMa7, ma7CrossAbove, ma7CrossBelow, rsi, atrPercent, bb, volume } = ind;

    // === RSI 硬过滤 ===
    const longBlocked = rsi > 65;
    const shortBlocked = rsi < 35;

    // === 技术评分 ===
    let longScore = 0, shortScore = 0;
    const reasons = [];

    // MA趋势
    if (ma7Direction === 'up' && priceVsMa7 === 'above') { longScore += 0.3; reasons.push('MA7↑↑'); }
    if (ma7Direction === 'down' && priceVsMa7 === 'below') { shortScore += 0.3; reasons.push('MA7↓↓'); }
    if (ma7CrossAbove) { longScore += 0.2; reasons.push('金叉'); }
    if (ma7CrossBelow) { shortScore += 0.2; reasons.push('死叉'); }

    // RSI
    if (rsi > 65) shortScore += 0.15;
    else if (rsi > 55) shortScore += 0.05;
    if (rsi < 35) longScore += 0.15;
    else if (rsi < 45) longScore += 0.05;

    // BB
    if (bb) {
      if (price <= bb.lower) longScore += 0.15;
      if (price >= bb.upper) shortScore += 0.15;
    }

    // 成交量
    if (volume.ratio > 1.3) { longScore += 0.1; shortScore += 0.1; }
    if (volume.ratio < 0.5) { longScore *= 0.5; shortScore *= 0.5; }

    // MA7 vs MA25
    if (ma7 > ma25) longScore += 0.1;
    if (ma7 < ma25) shortScore += 0.1;

    // 横盘检测（简化）
    if (ma7Direction === 'flat') { longScore *= 0.3; shortScore *= 0.3; }

    // 成本过滤
    const feeCostPct = 0.08;
    const fundingCostPct = Math.abs(fundingRate || 0) * 100;
    const slippagePct = 0.03;
    const totalCostPct = feeCostPct + fundingCostPct + slippagePct;
    const expectedProfitPct = atrPercent * 1.7; // 简化 R:R

    // 方向确定
    let direction = 'WAIT';
    let score = 0;
    if (longScore > shortScore && longScore >= 0.35 && !longBlocked && expectedProfitPct > totalCostPct * 3) {
      direction = 'LONG'; score = longScore;
    } else if (shortScore > longScore && shortScore >= 0.35 && !shortBlocked && expectedProfitPct > totalCostPct * 3) {
      direction = 'SHORT'; score = shortScore;
    }

    return {
      action: direction, score, reasons,
      longScore, shortScore,
      costPct: totalCostPct,
      expectedProfitPct,
      longBlocked, shortBlocked,
    };
  }

  // ============ 回测核心 ============
  /**
   * @param {string} symbol - 交易对
   * @param {string} interval - K线周期 (1h/4h/1d)
   * @param {number} limit - K线数量 (max 1500)
   * @param {object} params - 回测参数
   */
  async runBacktest(symbol, interval = '1h', limit = 750, params = {}) {
    const {
      initialBalance = 100,   // 初始资金 USDT
      maxPositions = 3,       // 最大持仓数
      leverage = 3,           // 杠杆
      positionPct = 10,       // 每次用余额百分比
      stopLossPct = 3,        // 止损 %
      takeProfitPct = 6,      // 止盈 %
      maxHoldCandles = 24,    // 最大持仓K线数
    } = params;

    console.log(`\n📊 回测 ${symbol} ${interval} x ${limit}根 K线`);
    console.log(`  初始资金: $${initialBalance} | 杠杆: ${leverage}x | 止损: ${stopLossPct}% | 止盈: ${takeProfitPct}%`);

    // 拉取K线
    const url = `${this.baseURL}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const raw = await this._fetch(url);
    const klines = raw.map(k => ({
      time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
    }));

    console.log(`  K线: ${klines.length}根, 时间: ${new Date(klines[0].time).toISOString().slice(0,16)} → ${new Date(klines[klines.length-1].time).toISOString().slice(0,16)}`);

    // 预计算所有指标
    const closes = klines.map(k => k.close);
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);
    const volumes = klines.map(k => k.volume);

    // 模拟资金费率（取历史均值~0.01%）
    const avgFunding = 0.0001;

    // 回测状态
    let balance = initialBalance;
    let peak = balance;
    let maxDrawdown = 0;
    let totalTrades = 0;
    let wins = 0;
    let losses = 0;
    let totalPnl = 0;
    let trades = [];
    let positions = []; // {side, entry, size, leverage, openIdx, pnl}

    const equity = [balance]; // 资金曲线

    for (let i = 26; i < klines.length; i++) {
      const ind = this.calcIndicators(closes, highs, lows, volumes, i);
      if (!ind) continue;
      const price = closes[i];
      const highPrice = highs[i];
      const lowPrice = lows[i];

      // === 阶段1：检查现有持仓 ===
      const closedPositions = [];
      for (let j = positions.length - 1; j >= 0; j--) {
        const pos = positions[j];
        const holdCandles = i - pos.openIdx;
        const isLong = pos.side === 'LONG';

        // 计算实时 PnL
        let unrealizedPnlPct;
        if (isLong) {
          unrealizedPnlPct = ((price - pos.entry) / pos.entry) * pos.leverage;
          // 检查止损（用最低价）
          const lowPnl = ((lowPrice - pos.entry) / pos.entry) * pos.leverage;
          if (lowPnl <= -stopLossPct/100) {
            const exitPrice = pos.entry * (1 - stopLossPct/(100*pos.leverage));
            const pnl = pos.size * (exitPrice - pos.entry) / (pos.entry || 1) * pos.leverage;
            balance += pos.size + pnl;
            totalPnl += pnl;
            trades.push({ symbol, side: pos.side, entry: pos.entry, exit: exitPrice, pnl, reason: 'stoploss', holdCandles, time: klines[i].time });
            totalTrades++; if (pnl > 0) wins++; else losses++;
            closedPositions.push(j);
            continue;
          }
          // 检查止盈（用最高价）
          const highPnl = ((highPrice - pos.entry) / pos.entry) * pos.leverage;
          if (highPnl >= takeProfitPct/100) {
            const exitPrice = pos.entry * (1 + takeProfitPct/(100*pos.leverage));
            const pnl = pos.size * (exitPrice - pos.entry) / (pos.entry || 1) * pos.leverage;
            balance += pos.size + pnl;
            totalPnl += pnl;
            trades.push({ symbol, side: pos.side, entry: pos.entry, exit: exitPrice, pnl, reason: 'takeprofit', holdCandles, time: klines[i].time });
            totalTrades++; if (pnl > 0) wins++; else losses++;
            closedPositions.push(j);
            continue;
          }
        } else {
          unrealizedPnlPct = ((pos.entry - price) / pos.entry) * pos.leverage;
          const highPnl = ((pos.entry - highPrice) / pos.entry) * pos.leverage;
          if (highPnl <= -stopLossPct/100) {
            const exitPrice = pos.entry * (1 + stopLossPct/(100*pos.leverage));
            const pnl = pos.size * (pos.entry - exitPrice) / (pos.entry || 1) * pos.leverage;
            balance += pos.size + pnl;
            totalPnl += pnl;
            trades.push({ symbol, side: pos.side, entry: pos.entry, exit: exitPrice, pnl, reason: 'stoploss', holdCandles, time: klines[i].time });
            totalTrades++; if (pnl > 0) wins++; else losses++;
            closedPositions.push(j);
            continue;
          }
          const lowPnl = ((pos.entry - lowPrice) / pos.entry) * pos.leverage;
          if (lowPnl >= takeProfitPct/100) {
            const exitPrice = pos.entry * (1 - takeProfitPct/(100*pos.leverage));
            const pnl = pos.size * (pos.entry - exitPrice) / (pos.entry || 1) * pos.leverage;
            balance += pos.size + pnl;
            totalPnl += pnl;
            trades.push({ symbol, side: pos.side, entry: pos.entry, exit: exitPrice, pnl, reason: 'takeprofit', holdCandles, time: klines[i].time });
            totalTrades++; if (pnl > 0) wins++; else losses++;
            closedPositions.push(j);
            continue;
          }
        }

        // 趋势反转平仓
        const tech = this.decide(ind, avgFunding);
        if (pos.side === 'LONG' && tech.action === 'SHORT' && tech.score > 0.3) {
          const pnl = pos.size * (price - pos.entry) / (pos.entry || 1) * pos.leverage;
          balance += pos.size + pnl;
          totalPnl += pnl;
          trades.push({ symbol, side: pos.side, entry: pos.entry, exit: price, pnl, reason: 'trend_reverse', holdCandles, time: klines[i].time });
          totalTrades++; if (pnl > 0) wins++; else losses++;
          closedPositions.push(j);
          continue;
        }
        if (pos.side === 'SHORT' && tech.action === 'LONG' && tech.score > 0.3) {
          const pnl = pos.size * (pos.entry - price) / (pos.entry || 1) * pos.leverage;
          balance += pos.size + pnl;
          totalPnl += pnl;
          trades.push({ symbol, side: pos.side, entry: pos.entry, exit: price, pnl, reason: 'trend_reverse', holdCandles, time: klines[i].time });
          totalTrades++; if (pnl > 0) wins++; else losses++;
          closedPositions.push(j);
          continue;
        }

        // 超时平仓
        if (holdCandles >= maxHoldCandles) {
          const pnl = pos.side === 'LONG'
            ? pos.size * (price - pos.entry) / (pos.entry || 1) * pos.leverage
            : pos.size * (pos.entry - price) / (pos.entry || 1) * pos.leverage;
          balance += pos.size + pnl;
          totalPnl += pnl;
          trades.push({ symbol, side: pos.side, entry: pos.entry, exit: price, pnl, reason: 'timeout', holdCandles, time: klines[i].time });
          totalTrades++; if (pnl > 0) wins++; else losses++;
          closedPositions.push(j);
        }
      }
      // 移除已平仓
      for (const j of closedPositions) positions.splice(j, 1);

      // === 阶段2：开新仓 ===
      if (positions.length < maxPositions) {
        const decision = this.decide(ind, avgFunding);
        if (decision.action !== 'WAIT' && decision.score >= 0.35) {
          const tradeAmount = balance * (positionPct / 100);
          if (tradeAmount >= 5) { // 最小 $5
            balance -= tradeAmount;
            positions.push({
              side: decision.action,
              entry: price,
              size: tradeAmount,
              leverage,
              openIdx: i,
            });
          }
        }
      }

      // 记录权益
      let unrealized = 0;
      for (const pos of positions) {
        unrealized += pos.side === 'LONG'
          ? pos.size * (price - pos.entry) / (pos.entry || 1) * pos.leverage
          : pos.size * (pos.entry - price) / (pos.entry || 1) * pos.leverage;
      }
      const totalEquity = balance + unrealized + positions.reduce((a,p) => a + p.size, 0);
      equity.push(totalEquity);
      if (totalEquity > peak) peak = totalEquity;
      const dd = peak > 0 ? (peak - totalEquity) / peak : 0;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    // 清理未平仓
    for (const pos of positions) {
      const price = closes[closes.length-1];
      const pnl = pos.side === 'LONG'
        ? pos.size * (price - pos.entry) / (pos.entry || 1) * pos.leverage
        : pos.size * (pos.entry - price) / (pos.entry || 1) * pos.leverage;
      balance += pos.size + pnl;
      totalPnl += pnl;
      totalTrades++; if (pnl > 0) wins++; else losses++;
      trades.push({ symbol, side: pos.side, entry: pos.entry, exit: price, pnl, reason: 'backtest_end', holdCandles: klines.length-pos.openIdx, time: klines[klines.length-1].time });
    }

    // 计算统计
    const winRate = totalTrades > 0 ? (wins/totalTrades*100).toFixed(1) : 0;
    const avgWin = wins > 0 ? trades.filter(t=>t.pnl>0).reduce((a,t)=>a+t.pnl,0)/wins : 0;
    const avgLoss = losses > 0 ? trades.filter(t=>t.pnl<=0).reduce((a,t)=>a+t.pnl,0)/losses : 0;
    const profitFactor = avgLoss !== 0 ? Math.abs(avgWin/avgLoss).toFixed(2) : '∞';
    const totalReturn = ((balance - initialBalance)/initialBalance*100).toFixed(2);
    const annualizedReturn = (totalReturn * (365 * 24 / klines.length)).toFixed(1); // 假设 1h K线

    // 夏普比率
    const returns = [];
    for (let i = 1; i < equity.length; i++) {
      returns.push(equity[i-1] > 0 ? (equity[i] - equity[i-1]) / equity[i-1] : 0);
    }
    const avgReturn = returns.length ? returns.reduce((a,b)=>a+b,0)/returns.length : 0;
    const stdReturn = returns.length ? Math.sqrt(returns.reduce((a,r)=>a+Math.pow(r-avgReturn,2),0)/returns.length) : 1;
    const sharpy = stdReturn > 0 ? (avgReturn / stdReturn * Math.sqrt(365*24)).toFixed(2) : 0;

    // 盈亏分布
    const winTrades = trades.filter(t => t.pnl > 0);
    const lossTrades = trades.filter(t => t.pnl <= 0);
    const bestTrade = trades.length > 0 ? Math.max(...trades.map(t=>t.pnl)) : 0;
    const worstTrade = trades.length > 0 ? Math.min(...trades.map(t=>t.pnl)) : 0;

    const result = {
      symbol, interval, klines: klines.length,
      initialBalance, finalBalance: balance.toFixed(2),
      totalReturn: totalReturn + '%',
      annualizedReturn: annualizedReturn + '%',
      totalTrades, wins, losses,
      winRate: winRate + '%',
      profitFactor,
      avgWin: avgWin.toFixed(4),
      avgLoss: avgLoss.toFixed(4),
      bestTrade: bestTrade.toFixed(4),
      worstTrade: worstTrade.toFixed(4),
      maxDrawdown: (maxDrawdown*100).toFixed(2) + '%',
      sharpeRatio: sharpy,
      trades: trades.slice(-30), // 最近30笔
      equity,
      reasonDistribution: {},
    };

    // 平仓原因分布
    for (const t of trades) {
      result.reasonDistribution[t.reason] = (result.reasonDistribution[t.reason]||0) + 1;
    }

    return result;
  }

  /**
   * 多币种并行回测
   */
  async runMultiBacktest(symbols, interval = '1h', limit = 750, params = {}) {
    console.log(`\n🔬 多币种回测: ${symbols.join(', ')} | ${interval} x ${limit}根`);
    const results = {};
    for (const sym of symbols) {
      try {
        results[sym] = await this.runBacktest(sym, interval, limit, params);
        // 打印单币结果
        const r = results[sym];
        console.log(`  ✅ ${sym}: ${r.totalReturn} | 交易${r.totalTrades}笔 | 胜率${r.winRate} | 最大回撤${r.maxDrawdown}`);
      } catch(e) {
        console.log(`  ❌ ${sym}: ${e.message}`);
      }
    }
    return results;
  }

  /**
   * 打印详细报告
   */
  printReport(result) {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`📊 回测报告: ${result.symbol} ${result.interval} (${result.klines}根K线)`);
    console.log(`${'═'.repeat(70)}`);
    console.log(`初始资金:    $${result.initialBalance}`);
    console.log(`最终资金:    $${result.finalBalance}`);
    console.log(`总收益:      ${result.totalReturn}`);
    console.log(`年化收益:    ${result.annualizedReturn}`);
    console.log(`${'─'.repeat(70)}`);
    console.log(`总交易:      ${result.totalTrades} 笔`);
    console.log(`胜/负:       ${result.wins} / ${result.losses}`);
    console.log(`胜率:        ${result.winRate}`);
    console.log(`盈亏比:      ${result.profitFactor}`);
    console.log(`平均盈利:    $${result.avgWin}`);
    console.log(`平均亏损:    $${result.avgLoss}`);
    console.log(`最好交易:    $${result.bestTrade}`);
    console.log(`最差交易:    $${result.worstTrade}`);
    console.log(`${'─'.repeat(70)}`);
    console.log(`最大回撤:    ${result.maxDrawdown}`);
    console.log(`夏普比率:    ${result.sharpeRatio}`);
    console.log(`${'─'.repeat(70)}`);
    console.log(`平仓原因分布:`);
    for (const [reason, count] of Object.entries(result.reasonDistribution)) {
      console.log(`  ${reason}: ${count}笔 (${(count/result.totalTrades*100).toFixed(0)}%)`);
    }
    console.log(`${'─'.repeat(70)}`);
    console.log(`最近交易:`);
    for (const t of result.trades.slice(-10)) {
      const time = new Date(t.time).toISOString().slice(5,16);
      const pnlSign = t.pnl >= 0 ? '+' : '';
      console.log(`  ${time} ${t.side.padEnd(5)} entry=${t.entry.toFixed(2)} exit=${t.exit.toFixed(2)} pnl=${pnlSign}$${t.pnl.toFixed(4)} (${t.reason})`);
    }
    console.log(`${'═'.repeat(70)}`);
  }

  /**
   * 打印多币种汇总
   */
  printSummary(results) {
    console.log(`\n${'═'.repeat(80)}`);
    console.log(`📊 多币种回测汇总`);
    console.log(`${'═'.repeat(80)}`);
    console.log('Symbol       收益%     交易  胜率    回撤    夏普   盈亏比');
    console.log(`${'─'.repeat(80)}`);

    let totalProfit = 0;
    for (const [sym, r] of Object.entries(results)) {
      const ret = parseFloat(r.totalReturn);
      totalProfit += ret;
      console.log(
        `${sym.padEnd(13)}${r.totalReturn.padStart(7)}${String(r.totalTrades).padStart(6)}${r.winRate.padStart(7)}${r.maxDrawdown.padStart(8)}${String(r.sharpeRatio).padStart(7)}${String(r.profitFactor).padStart(7)}`
      );
    }
    console.log(`${'─'.repeat(80)}`);
    console.log(`平均收益: ${(totalProfit/Object.keys(results).length).toFixed(2)}%`);
    console.log(`${'═'.repeat(80)}`);
  }
}

// ═══════════════════════════════════════════
// v68: 增强回测集成
// ═══════════════════════════════════════════
const BacktestEnhancer = require('./enhancer');

/**
 * 增强回测 — 带滑点+蒙特卡洛+过拟合检测
 */
BacktestEngine.prototype.runEnhancedBacktest = async function(symbol, interval, limit, params = {}) {
  // 先运行原始回测
  const result = await this.runBacktest(symbol, interval, limit, params);
  
  // 增强分析
  const enhancer = new BacktestEnhancer();
  const enhanced = enhancer.enhanceResult(result, {
    orderSize: params.positionPct || 10,
    adv: params.adv || 50000000,
    volatility: params.volatility || 0.02,
    simulations: 500,
  });
  
  return { ...result, enhanced };
};

/**
 * Walk-Forward 回测
 */
BacktestEngine.prototype.runWalkForward = async function(symbol, interval = '1h', limit = 1500, options = {}) {
  const enhancer = new BacktestEnhancer();
  
  // 拉取K线
  const url = `${this.baseURL}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const raw = await this._fetch(url);
  const klines = raw.map(k => ({
    time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
  }));
  
  const runStrategy = async (windowKlines, opts = {}) => {
    const closes = windowKlines.map(k => k.close);
    const highs = windowKlines.map(k => k.high);
    const lows = windowKlines.map(k => k.low);
    const volumes = windowKlines.map(k => k.volume);
    
    let balance = 100, trades = [], positions = [];
    for (let i = 26; i < windowKlines.length; i++) {
      const ind = this.calcIndicators(closes, highs, lows, volumes, i);
      if (!ind) continue;
      const decision = this.decide(ind, 0.0001);
      
      // 简单开仓
      if (positions.length < 3 && decision.action !== 'WAIT' && decision.score >= 0.35) {
        balance -= 10;
        positions.push({ side: decision.action, entry: closes[i], size: 10, leverage: 2, openIdx: i });
      }
      
      // 简单平仓
      for (let j = positions.length - 1; j >= 0; j--) {
        const pos = positions[j];
        const pnl = pos.side === 'LONG'
          ? pos.size * (closes[i] - pos.entry) / pos.entry * pos.leverage
          : pos.size * (pos.entry - closes[i]) / pos.entry * pos.leverage;
        if (i - pos.openIdx >= 24 || pnl >= 0.6 || pnl <= -0.3) {
          balance += pos.size + pnl;
          trades.push({ pnl });
          positions.splice(j, 1);
        }
      }
    }
    
    const returns = trades.length > 0 ? trades.map(t => t.pnl / 10) : [0];
    const avgRet = returns.reduce((a, b) => a + b, 0) / returns.length;
    const stdRet = Math.sqrt(returns.reduce((a, r) => a + Math.pow(r - avgRet, 2), 0) / returns.length);
    
    return {
      pnl: balance - 100,
      sharpe: stdRet > 0 ? avgRet / stdRet : 0,
      winRate: trades.length > 0 ? trades.filter(t => t.pnl > 0).length / trades.length * 100 : 0,
      trades,
    };
  };
  
  return enhancer.walkForward(klines, runStrategy, options);
};

module.exports = BacktestEngine;
module.exports.BacktestEnhancer = BacktestEnhancer;
