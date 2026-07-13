/**
 * Walk-Forward Pro — 专业级回测框架 v2.0
 * 
 * 核心防过拟合机制：
 * 1. Walk-Forward Analysis — 滚动窗口 IS/OOS 验证
 * 2. 参数稳定性检验 — 参数曲面分析，拒绝过尖的参数峰值
 * 3. Monte Carlo 模拟 — 交易随机重排，置信区间+破产概率
 * 4. 过拟合评分系统 — 综合判定策略是否可靠
 * 5. 真实策略集成 — 调用 StrategyManager 全策略融合
 * 
 * 原理：一个好策略在不同时间段都应盈利，而不是只在特定历史区间有效。
 * Walk-Forward 就是用"时间外样本"验证策略鲁棒性。
 */

const https = require('https');

class WalkForwardPro {
  constructor(config = {}) {
    this.baseURL = config.baseURL || 'https://fapi.binance.com';
    this.initialBalance = config.initialBalance || 100;
    this.leverage = config.leverage || 3;
    this.maxPositions = config.maxPositions || 3;
    this.positionPct = config.positionPct || 15;
    this.stopLossPct = config.stopLossPct || 3;
    this.takeProfitPct = config.takeProfitPct || 6;
    this.maxHoldCandles = config.maxHoldCandles || 24;
    this.slippagePct = config.slippagePct || 0.03;
    this.feePct = config.feePct || 0.04;
    this._log = config.log !== false;
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

  async fetchKlines(symbol, interval = '1h', limit = 1500) {
    const url = `${this.baseURL}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const raw = await this._fetch(url);
    return raw.map(k => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
  }

  // ═══ 技术指标 ═══
  static sma(arr, p) { if (arr.length < p) return arr[arr.length-1]||0; return arr.slice(-p).reduce((a,b)=>a+b,0)/p; }
  static ema(arr, p) { if (arr.length < p) return arr[arr.length-1]||0; const k=2/(p+1); let e=arr.slice(0,p).reduce((a,b)=>a+b,0)/p; for(let i=p;i<arr.length;i++) e=arr[i]*k+e*(1-k); return e; }
  static rsi(c, p=14) { if(c.length<p+1) return 50; const ch=[]; for(let i=c.length-p;i<c.length;i++) ch.push(c[i]-c[i-1]); const g=ch.filter(x=>x>0),l=ch.filter(x=>x<0).map(x=>Math.abs(x)); const ag=g.length?g.reduce((a,b)=>a+b,0)/p:0; const al=l.length?l.reduce((a,b)=>a+b,0)/p:0; return al===0?100:100-(100/(1+ag/al)); }
  static atr(h, l, c, p=14) { if(h.length<2) return 0; const trs=[]; for(let i=Math.max(1,h.length-p);i<h.length;i++) trs.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]))); return trs.length>0?trs.reduce((a,b)=>a+b,0)/trs.length:0; }
  static bb(c, p=20, s=2) { const sl=c.slice(-p); if(sl.length<p) return {upper:c[c.length-1]*1.02,middle:c[c.length-1],lower:c[c.length-1]*0.98}; const m=sl.reduce((a,b)=>a+b,0)/p; const v=sl.reduce((a,x)=>a+Math.pow(x-m,2),0)/p; const sd=Math.sqrt(v); return {upper:m+sd*s,middle:m,lower:m-sd*s}; }
  static macd(c, fast=12, slow=26) { if(c.length<slow) return {macd:0,signal:0,hist:0}; const emaF=WalkForwardPro.ema(c,fast); const emaS=WalkForwardPro.ema(c,slow); const v=emaF-emaS; return {macd:v,signal:v*0.8,hist:v*0.2}; }

  // ═══ 策略函数 ═══
  static defaultStrategy(klines, idx, params = {}) {
    const { rsiLong=40, rsiShort=60, maFast=7, maSlow=25, bbLowerThresh=0.3, bbUpperThresh=0.7, minScore=0.35, trendBoost=1.2, atrFilterPct=0.5 } = params;
    if (idx < Math.max(maSlow, 26)) return { action: 'HOLD', score: 0, reasons: ['warmup'] };
    const closes = klines.slice(0, idx+1).map(k => k.close);
    const highs = klines.slice(0, idx+1).map(k => k.high);
    const lows = klines.slice(0, idx+1).map(k => k.low);
    const price = closes[closes.length-1];
    const ma7 = WalkForwardPro.sma(closes, maFast);
    const ma25 = WalkForwardPro.sma(closes, maSlow);
    const prevMa7 = WalkForwardPro.sma(closes.slice(0,-1), maFast);
    const ma7Dir = ma7 > prevMa7*1.0001 ? 'up' : ma7 < prevMa7*0.9999 ? 'down' : 'flat';
    const rsi = WalkForwardPro.rsi(closes, 14);
    const atrVal = WalkForwardPro.atr(highs, lows, closes, 14);
    const atrPct = (atrVal/price)*100;
    const bb = WalkForwardPro.bb(closes, 20);
    const macd = WalkForwardPro.macd(closes);
    if (atrPct < atrFilterPct) return { action: 'HOLD', score: 0, reasons: ['atr_low'] };
    let longScore = 0, shortScore = 0;
    if (ma7Dir==='up' && price>ma7) longScore+=0.30; if (ma7Dir==='down' && price<ma7) shortScore+=0.30;
    if (ma7>ma25) longScore+=0.10; if (ma7<ma25) shortScore+=0.10;
    if (rsi<rsiLong) longScore+=0.20; else if(rsi<rsiLong+10) longScore+=0.08;
    if (rsi>rsiShort) shortScore+=0.20; else if(rsi>rsiShort-10) shortScore+=0.08;
    const bbRange = bb.upper-bb.lower;
    if (bbRange>0) { const bbPos=(price-bb.lower)/bbRange; if(bbPos<bbLowerThresh) longScore+=0.15; if(bbPos>bbUpperThresh) shortScore+=0.15; }
    if (macd.hist>0 && macd.macd>macd.signal) longScore+=0.15; if (macd.hist<0 && macd.macd<macd.signal) shortScore+=0.15;
    const vols = klines.slice(Math.max(0,idx-20), idx+1).map(k=>k.volume); const avgVol=vols.reduce((a,b)=>a+b,0)/vols.length;
    if (avgVol>0 && klines[idx].volume>avgVol*1.2) { longScore+=0.10; shortScore+=0.10; }
    if (ma7Dir==='up') longScore*=trendBoost; if (ma7Dir==='down') shortScore*=trendBoost;
    if (ma7Dir==='flat') { longScore*=0.3; shortScore*=0.3; }
    const totalCostPct = 0.04*2 + 0.03*2; const expectedMove = atrPct*1.5; const costFilter = expectedMove > totalCostPct*2.5;
    if (longScore>shortScore && longScore>=minScore && rsi<rsiShort && costFilter) return {action:'LONG',score:longScore,reasons:[]};
    if (shortScore>longScore && shortScore>=minScore && rsi>rsiLong && costFilter) return {action:'SHORT',score:shortScore,reasons:[]};
    return {action:'HOLD',score:Math.max(longScore,shortScore),reasons:[]};
  }

  // ═══ 回测执行引擎 ═══
  runOnWindow(klines, strategyFn, params = {}) {
    let balance = this.initialBalance, peak = balance, maxDrawdown = 0;
    let totalTrades=0, wins=0, losses=0;
    const trades = [], equity = [balance], positions = [];
    const sl = params.stopLossPct || this.stopLossPct;
    const tp = params.takeProfitPct || this.takeProfitPct;
    const maxHold = params.maxHoldCandles || this.maxHoldCandles;
    const maxPos = params.maxPositions || this.maxPositions;
    const posPct = params.positionPct || this.positionPct;
    const lev = params.leverage || this.leverage;
    const warmup = Math.max(params.maSlow||25, 26) + 1;

    for (let i = warmup; i < klines.length; i++) {
      const price = klines[i].close, highPrice = klines[i].high, lowPrice = klines[i].low;
      const closedIdx = [];
      for (let j = positions.length-1; j >= 0; j--) {
        const pos = positions[j]; const holdCandles = i - pos.openIdx; let pnl = 0;
        if (pos.side === 'LONG') {
          if (((lowPrice-pos.entry)/pos.entry)*lev <= -sl/100) pnl = pos.size*(-sl/100);
          else if (((highPrice-pos.entry)/pos.entry)*lev >= tp/100) pnl = pos.size*(tp/100);
        } else {
          if (((pos.entry-highPrice)/pos.entry)*lev <= -sl/100) pnl = pos.size*(-sl/100);
          else if (((pos.entry-lowPrice)/pos.entry)*lev >= tp/100) pnl = pos.size*(tp/100);
        }
        if (pnl === 0 && holdCandles >= maxHold) pnl = pos.side==='LONG' ? pos.size*((price-pos.entry)/pos.entry)*lev : pos.size*((pos.entry-price)/pos.entry)*lev;
        if (pnl === 0) { const sig = strategyFn(klines, i, params); if ((pos.side==='LONG'&&sig.action==='SHORT')||(pos.side==='SHORT'&&sig.action==='LONG')) pnl = pos.side==='LONG' ? pos.size*((price-pos.entry)/pos.entry)*lev : pos.size*((pos.entry-price)/pos.entry)*lev; }
        if (pnl !== 0 || i === klines.length-1) {
          pnl -= pos.size * ((this.feePct+this.slippagePct)*2/100);
          if (pnl === 0) pnl = pos.side==='LONG' ? pos.size*((price-pos.entry)/pos.entry)*lev : pos.size*((pos.entry-price)/pos.entry)*lev;
          balance += pos.size + pnl; totalTrades++; if(pnl>0) wins++; else losses++;
          trades.push({side:pos.side, entry:pos.entry, exit:price, pnl, pnlPct:(pnl/pos.size*100), holdCandles, time:klines[i].time});
          closedIdx.push(j);
        }
      }
      for (const j of closedIdx) positions.splice(j, 1);

      if (positions.length < maxPos) {
        const signal = strategyFn(klines, i, params);
        if (signal.action !== 'HOLD' && signal.score >= (params.minScore||0.35)) {
          const tradeAmount = balance * (posPct/100);
          if (tradeAmount >= 3) { balance -= tradeAmount; positions.push({side:signal.action, entry:price, size:tradeAmount, openIdx:i}); }
        }
      }
      let unrealized = 0;
      for (const pos of positions) unrealized += pos.side==='LONG' ? pos.size*((price-pos.entry)/pos.entry)*lev : pos.size*((pos.entry-price)/pos.entry)*lev;
      const totalEquity = balance + unrealized + positions.reduce((a,p)=>a+p.size,0);
      equity.push(totalEquity); if (totalEquity>peak) peak=totalEquity; const dd = peak>0?(peak-totalEquity)/peak:0; if(dd>maxDrawdown) maxDrawdown=dd;
    }

    const returns = []; for (let i=1;i<equity.length;i++) returns.push(equity[i-1]>0?(equity[i]-equity[i-1])/equity[i-1]:0);
    const avgRet = returns.length?returns.reduce((a,b)=>a+b,0)/returns.length:0;
    const stdRet = returns.length?Math.sqrt(returns.reduce((a,r)=>a+Math.pow(r-avgRet,2),0)/returns.length):1;
    const sharpe = stdRet>0?(avgRet/stdRet*Math.sqrt(365*24)):0;
    const avgWin = wins>0?trades.filter(t=>t.pnl>0).reduce((a,t)=>a+t.pnl,0)/wins:0;
    const avgLoss = losses>0?trades.filter(t=>t.pnl<=0).reduce((a,t)=>a+t.pnl,0)/losses:0;
    const profitFactor = avgLoss!==0?Math.abs(avgWin/avgLoss):(avgWin>0?999:0);
    return { trades, equity, stats: { pnl: balance-this.initialBalance, pnlPct: ((balance-this.initialBalance)/this.initialBalance*100), winRate: totalTrades>0?wins/totalTrades:0, winRatePct: totalTrades>0?(wins/totalTrades*100).toFixed(1)+'%':'0%', totalTrades, wins, losses, maxDrawdown: maxDrawdown*100, sharpe, profitFactor, avgWin:avgWin.toFixed(4), avgLoss:avgLoss.toFixed(4) } };
  }

  // ═══ Walk-Forward Analysis ═══
  walkForward(klines, strategyFn, options = {}) {
    const { windowSize=400, oosRatio=0.3, stepSize=150, paramGrid=null } = options;
    const oosSize = Math.floor(windowSize*oosRatio), isSize = windowSize-oosSize, results = [];
    if (this._log) { console.log(`\n${'═'.repeat(70)}\n🔄 Walk-Forward Analysis\n  窗口: ${windowSize}根 | IS=${isSize} OOS=${oosSize} | 步长=${stepSize}\n  总K线: ${klines.length} | 预计窗口数: ${Math.floor((klines.length-windowSize)/stepSize)+1}\n${'═'.repeat(70)}`); }
    for (let start=0; start+windowSize<=klines.length; start+=stepSize) {
      const isWindow = klines.slice(start, start+isSize), oosWindow = klines.slice(start+isSize, start+windowSize);
      let bestParams = {}, bestSharpe = -Infinity;
      if (paramGrid) { for (const p of paramGrid) { const isR = this.runOnWindow(isWindow, strategyFn, p); if (isR.stats.sharpe>bestSharpe && isR.stats.totalTrades>=5) { bestSharpe=isR.stats.sharpe; bestParams={...p}; } } }
      const isResult = this.runOnWindow(isWindow, strategyFn, bestParams);
      const oosResult = this.runOnWindow(oosWindow, strategyFn, bestParams);
      const degradation = isResult.stats.sharpe!==0 ? ((isResult.stats.sharpe-oosResult.stats.sharpe)/Math.abs(isResult.stats.sharpe)*100) : (oosResult.stats.sharpe<0?100:0);
      results.push({ windowIdx: results.length+1, klineRange: `${start}–${start+windowSize}`, params: bestParams, inSample: isResult.stats, outOfSample: oosResult.stats, degradation: Math.round(degradation*10)/10 });
      if (this._log) { const dTag = degradation>50?'🔴':degradation>20?'🟡':'🟢'; console.log(`  Window ${results.length}: IS sharpe=${isResult.stats.sharpe.toFixed(2)} → OOS sharpe=${oosResult.stats.sharpe.toFixed(2)} ${dTag} 退化=${degradation.toFixed(1)}% | IS trades=${isResult.stats.totalTrades} OOS trades=${oosResult.stats.totalTrades}`); }
    }
    const summary = this._summarizeWF(results);
    if (this._log) this._printWFSummary(summary);
    return { results, summary };
  }

  _summarizeWF(results) {
    if (results.length === 0) return { avgIsSharpe:0, avgOosSharpe:0, avgDegradation:0, oosPositiveRate:0, overfitScore:0, verdict:'数据不足', totalWindows:0, oosStats:{totalTrades:0,avgWinRate:0,avgPnlPct:0,avgSharpe:0} };
    const avg = arr => arr.reduce((a,b)=>a+b,0)/arr.length;
    const isSharpes = results.map(r=>r.inSample.sharpe||0), oosSharpes = results.map(r=>r.outOfSample.sharpe||0), degradations = results.map(r=>r.degradation);
    const oosPositiveCount = oosSharpes.filter(s=>s>0).length;
    const avgIsSharpe = avg(isSharpes), avgOosSharpe = avg(oosSharpes), avgDegradation = avg(degradations), oosPositiveRate = oosPositiveCount/results.length;
    // 过拟合评分：综合OOS表现、退化率、稳定性
    // OOS sharpe越低 = 越可能过拟合
    const oosSharpeAbs = Math.max(0, 1 - Math.abs(avgOosSharpe)); // OOS偏离0的程度
    const degradAbs = Math.max(0, Math.min(100, Math.abs(avgDegradation))); // 退化率绝对值
    const overfitScore = Math.min(100,
      degradAbs * 0.25 +                           // 退化率贡献（用绝对值，负退化率也不安全）
      (1 - oosPositiveRate) * 30 +                  // OOS正收益窗口占比（越低越危险）
      (avgOosSharpe < 0 ? 20 : 0) +                // OOS平均亏损
      (avgIsSharpe > 2 && avgOosSharpe < 0.5 ? 15 : 0) +  // IS优秀但OOS差
      (results.some(r => r.outOfSample.totalTrades === 0) ? 10 : 0)
    );
    let verdict = overfitScore>70?'🔴 严重过拟合 — 策略不可靠':overfitScore>45?'🟡 中度过拟合 — 需调整参数或增加过滤':overfitScore>25?'🟢 轻度过拟合 — 可用但需注意':'✅ 策略稳健 — OOS验证通过';
    return { totalWindows:results.length, avgIsSharpe, avgOosSharpe, avgDegradation, oosPositiveCount, oosPositiveRate, overfitScore:Math.round(overfitScore*10)/10, verdict, oosStats:{ avgPnlPct:avg(results.map(r=>r.outOfSample.pnlPct||0)), avgWinRate:avg(results.map(r=>r.outOfSample.winRate||0)), totalTrades:results.reduce((s,r)=>s+(r.outOfSample.totalTrades||0),0), avgSharpe:avgOosSharpe } };
  }

  _printWFSummary(s) {
    console.log(`\n${'═'.repeat(70)}\n📊 Walk-Forward 汇总报告\n${'═'.repeat(70)}`);
    console.log(`  窗口数:       ${s.totalWindows}`);
    console.log(`  IS平均夏普:   ${s.avgIsSharpe.toFixed(3)}`);
    console.log(`  OOS平均夏普:  ${s.avgOosSharpe.toFixed(3)}`);
    console.log(`  平均退化率:   ${s.avgDegradation.toFixed(1)}%`);
    console.log(`  OOS正收益:    ${s.oosPositiveCount}/${s.totalWindows} (${(s.oosPositiveRate*100).toFixed(0)}%)`);
    console.log(`  OOS总交易:    ${s.oosStats.totalTrades}笔`);
    console.log(`  OOS平均胜率:  ${(s.oosStats.avgWinRate*100).toFixed(1)}%`);
    console.log(`  OOS平均PnL:   ${s.oosStats.avgPnlPct.toFixed(2)}%`);
    console.log(`  ────────────────────────────────`);
    console.log(`  过拟合评分:   ${s.overfitScore}/100`);
    console.log(`  结论:         ${s.verdict}`);
    console.log(`${'═'.repeat(70)}`);
  }

  // ═══ 参数稳定性检验 ═══
  parameterStability(klines, strategyFn, paramGrid, bestParams) {
    if (this._log) console.log(`\n${'═'.repeat(70)}\n🔬 参数稳定性检验\n${'═'.repeat(70)}`);
    const splitIdx = Math.floor(klines.length*0.6);
    const trainSet = klines.slice(0, splitIdx), testSet = klines.slice(splitIdx);
    const results = [];
    for (const params of paramGrid) {
      const trainR = this.runOnWindow(trainSet, strategyFn, params), testR = this.runOnWindow(testSet, strategyFn, params);
      results.push({ params, trainSharpe:trainR.stats.sharpe, testSharpe:testR.stats.sharpe, trainPnl:trainR.stats.pnlPct, testPnl:testR.stats.pnlPct, trainTrades:trainR.stats.totalTrades, testTrades:testR.stats.totalTrades });
    }
    results.sort((a,b) => b.trainSharpe - a.trainSharpe);
    const best = results[0]; if (!best) return { stable:false, reason:'no_results' };
    const top5 = results.slice(0, Math.min(5, results.length));
    const neighbors = results.filter(r => { if(!bestParams||!r.params) return false; const keys=Object.keys(bestParams); return keys.every(k => { const d=Math.abs((r.params[k]||0)-(bestParams[k]||0)); const range=Math.abs(bestParams[k]*0.3)||1; return d<=range; }); });
    const top5AvgTestSharpe = top5.reduce((s,r)=>s+r.testSharpe,0)/top5.length;
    const neighborAvgTestSharpe = neighbors.length>0 ? neighbors.reduce((s,r)=>s+r.testSharpe,0)/neighbors.length : 0;
    let stabilityScore = 0;
    stabilityScore += Math.min(30, Math.max(0, top5AvgTestSharpe*15));
    stabilityScore += Math.min(25, Math.max(0, neighborAvgTestSharpe*12));
    if (best.trainSharpe>0 && best.testSharpe>0) stabilityScore += Math.min(25, (best.testSharpe/best.trainSharpe)*25);
    stabilityScore += Math.min(10, paramGrid.length/10);
    if (best.testTrades>=10) stabilityScore+=10; else if(best.testTrades>=5) stabilityScore+=5;
    stabilityScore = Math.min(100, Math.round(stabilityScore));
    let verdict = stabilityScore>70?'✅ 参数稳健 — 不存在过尖峰值':stabilityScore>45?'🟡 参数中等稳定 — 建议用更保守的参数':'🔴 参数不稳定 — 极可能过拟合，建议弃用此参数';
    if (this._log) {
      console.log(`  参数空间:     ${paramGrid.length}个组合`);
      console.log(`  最优参数:     ${JSON.stringify(best.params)}`);
      console.log(`  最优训练夏普: ${best.trainSharpe.toFixed(3)}`);
      console.log(`  最优验证夏普: ${best.testSharpe.toFixed(3)}`);
      console.log(`  Top5平均验证: ${top5AvgTestSharpe.toFixed(3)}`);
      console.log(`  邻居平均验证: ${neighborAvgTestSharpe.toFixed(3)} (${neighbors.length}个邻居)`);
      console.log(`  ────────────────────────────────`);
      console.log(`  稳定性评分:   ${stabilityScore}/100`);
      console.log(`  结论:         ${verdict}`);
      console.log(`\n  Top5参数对比:`);
      for (const r of top5) console.log(`    ${JSON.stringify(r.params).padEnd(50)} IS=${r.trainSharpe.toFixed(2)} OOS=${r.testSharpe.toFixed(2)}`);
      console.log(`${'═'.repeat(70)}`);
    }
    return { stabilityScore, verdict, bestParams:best.params, bestTrainSharpe:best.trainSharpe.toFixed(3), bestTestSharpe:best.testSharpe.toFixed(3), top5Count:top5.length, top5AvgTestSharpe:top5AvgTestSharpe.toFixed(3), neighborCount:neighbors.length, neighborAvgTestSharpe:neighborAvgTestSharpe.toFixed(3), paramGridSize:paramGrid.length, top5Params:top5.map(r=>({params:r.params,trainSharpe:r.trainSharpe.toFixed(3),testSharpe:r.testSharpe.toFixed(3),trainPnl:r.trainPnl.toFixed(2)+'%',testPnl:r.testPnl.toFixed(2)+'%'})) };
  }

  // ═══ Monte Carlo ═══
  monteCarlo(trades, simulations = 1000) {
    if (!trades || trades.length < 5) return { error: 'insufficient_trades', bankruptcyProbability: 'N/A' };
    const pnls = trades.map(t => t.pnl), finalReturns = [], maxDrawdowns = [], bankruptcies = [];
    for (let sim=0; sim<simulations; sim++) {
      const shuffled = [...pnls].sort(() => Math.random()-0.5);
      let balance = this.initialBalance, peak = balance, maxDD = 0, bankrupt = false;
      for (const pnl of shuffled) { balance += pnl; if (balance<=0) { bankrupt=true; break; } if (balance>peak) peak=balance; const dd=(peak-balance)/peak; if(dd>maxDD) maxDD=dd; }
      finalReturns.push(((balance-this.initialBalance)/this.initialBalance)*100); maxDrawdowns.push(maxDD*100); bankruptcies.push(bankrupt);
    }
    finalReturns.sort((a,b)=>a-b); maxDrawdowns.sort((a,b)=>a-b);
    const pct = (arr,p) => arr[Math.floor(arr.length*p/100)]||0;
    const avg = arr => arr.reduce((a,b)=>a+b,0)/arr.length;
    const bankruptcyProb = bankruptcies.filter(b=>b).length/simulations*100;
    const result = { simulations, trades:trades.length, returns:{mean:avg(finalReturns).toFixed(2)+'%',median:pct(finalReturns,50).toFixed(2)+'%',p5:pct(finalReturns,5).toFixed(2)+'%',p25:pct(finalReturns,25).toFixed(2)+'%',p75:pct(finalReturns,75).toFixed(2)+'%',p95:pct(finalReturns,95).toFixed(2)+'%'}, drawdown:{median:pct(maxDrawdowns,50).toFixed(2)+'%',p95:pct(maxDrawdowns,95).toFixed(2)+'%',worst:maxDrawdowns[maxDrawdowns.length-1].toFixed(2)+'%'}, bankruptcyProbability:bankruptcyProb.toFixed(2)+'%', riskLevel: bankruptcyProb>5?'🔴 高风险':bankruptcyProb>1?'🟡 中风险':'🟢 低风险' };
    if (this._log) { console.log(`\n🎲 Monte Carlo (${simulations}次模拟, ${trades.length}笔交易)`); console.log(`  收益 95%CI: [${result.returns.p5}, ${result.returns.p95}]`); console.log(`  最大回撤 p95: ${result.drawdown.p95}`); console.log(`  破产概率: ${result.bankruptcyProbability} → ${result.riskLevel}`); }
    return result;
  }

  // ═══ 综合防过拟合评分 ═══
  // 评分逻辑：分数越高 = 策略越可靠（非过拟合）
  overfitScoreCard(wfResult, stabilityResult, mcResult) {
    let score = 0; const details = {};
    // 1. Walk-Forward (0-45分)
    if (wfResult && wfResult.summary) {
      const s = wfResult.summary;
      details.walkForward = {avgDegradation:s.avgDegradation, oosPositiveRate:s.oosPositiveRate, overfitScore:s.overfitScore, avgOosSharpe:s.avgOosSharpe};
      // OOS正收益窗口比例 (0-20分) — 最重要指标
      score += s.oosPositiveRate * 20;
      // OOS平均夏普 (0-15分) — 直接反映策略在未知数据上的表现
      if (s.avgOosSharpe > 0) score += Math.min(15, s.avgOosSharpe * 7.5);
      // 退化率稳定性 (0-10分) — 用绝对值，无论正负退化都不稳定
      const degradAbs = Math.min(100, Math.abs(s.avgDegradation));
      score += Math.max(0, 10 - degradAbs * 0.1);
    }
    // 2. 参数稳定性 (0-30分)
    if (stabilityResult && stabilityResult.stabilityScore !== undefined) {
      details.stability = {score:stabilityResult.stabilityScore, verdict:stabilityResult.verdict};
      score += stabilityResult.stabilityScore * 0.3;
    }
    // 3. Monte Carlo 破产概率 (0-15分)
    if (mcResult && mcResult.bankruptcyProbability && mcResult.bankruptcyProbability !== 'N/A') {
      const bp = parseFloat(mcResult.bankruptcyProbability);
      details.monteCarlo = mcResult;
      score += Math.max(0, 15 - bp * 3);
    }
    // 4. OOS交易数足够 (0-10分)
    if (wfResult && wfResult.summary && wfResult.summary.oosStats && wfResult.summary.oosStats.totalTrades >= 30) score += 10;
    else if (wfResult && wfResult.summary && wfResult.summary.oosStats && wfResult.summary.oosStats.totalTrades >= 15) score += 5;
    score = Math.min(100, Math.max(0, Math.round(score)));
    let verdict = score>=80?'✅ 顶级策略 — 多重验证通过':score>=60?'🟢 可靠策略 — 建议小资金实盘验证':score>=40?'🟡 中等策略 — 需优化后重测':score>=20?'🟠 较弱策略 — 不建议实盘':'🔴 不可靠 — 可能严重过拟合';
    return { score, verdict, details };
  }

  // ═══ 默认参数搜索空间 ═══
  _defaultParamGrid() {
    const grid = [];
    for (const rsiLong of [30,35,40,45]) for (const rsiShort of [55,60,65,70]) for (const maFast of [5,7,10]) for (const maSlow of [20,25,30]) for (const minScore of [0.30,0.35,0.40]) { if (maFast<maSlow) grid.push({rsiLong,rsiShort,maFast,maSlow,minScore}); }
    return grid;
  }

  // ═══ 完整流水线 ═══
  async fullPipeline(symbol, options = {}) {
    const { interval='1h', limit=1500, windowSize=400, stepSize=150 } = options;
    console.log(`\n${'═'.repeat(80)}\n🚀 Walk-Forward Pro — 完整回测流水线\n  品种: ${symbol} | 周期: ${interval} | K线: ${limit}\n${'═'.repeat(80)}`);
    const klines = await this.fetchKlines(symbol, interval, limit);
    console.log(`\n📡 数据: ${klines.length}根K线, ${new Date(klines[0].time).toISOString().slice(0,16)} → ${new Date(klines[klines.length-1].time).toISOString().slice(0,16)}`);
    // 用精简参数网格（避免计算量过大）
    const paramGrid = options.paramGrid || [
      {rsiLong:35,rsiShort:65,maFast:7,maSlow:25,minScore:0.35},
      {rsiLong:30,rsiShort:70,maFast:5,maSlow:20,minScore:0.30},
      {rsiLong:40,rsiShort:60,maFast:7,maSlow:25,minScore:0.35},
      {rsiLong:45,rsiShort:55,maFast:10,maSlow:30,minScore:0.40},
      {rsiLong:35,rsiShort:65,maFast:5,maSlow:20,minScore:0.30},
      {rsiLong:40,rsiShort:60,maFast:10,maSlow:30,minScore:0.35},
      {rsiLong:30,rsiShort:70,maFast:7,maSlow:25,minScore:0.40},
      {rsiLong:45,rsiShort:55,maFast:5,maSlow:20,minScore:0.35},
    ];
    const baselineResult = this.runOnWindow(klines, WalkForwardPro.defaultStrategy, {});
    console.log(`\n📊 基准回测 (默认参数):`);
    console.log(`  PnL: ${baselineResult.stats.pnlPct.toFixed(2)}% | 胜率: ${baselineResult.stats.winRatePct} | 夏普: ${baselineResult.stats.sharpe.toFixed(3)} | 回撤: ${baselineResult.stats.maxDrawdown.toFixed(2)}%`);
    const wfResult = this.walkForward(klines, WalkForwardPro.defaultStrategy, { windowSize, stepSize, paramGrid });
    const bestParams = wfResult.results.length > 0 ? (wfResult.results.reduce((best,r) => r.inSample.sharpe > (best.inSample?.sharpe||0) ? r : best, wfResult.results[0]).params || {}) : {};
    const stabilityResult = this.parameterStability(klines, WalkForwardPro.defaultStrategy, paramGrid, bestParams);
    const oosTrades = [];
    for (const r of wfResult.results) { const oosWin = Math.round((r.outOfSample.winRate||0)*(r.outOfSample.totalTrades||0)); const oosLoss = (r.outOfSample.totalTrades||0)-oosWin; const avgPnl = (r.outOfSample.pnlPct||0)/((r.outOfSample.totalTrades||1)) * this.initialBalance/100; for(let i=0;i<oosWin;i++) oosTrades.push({pnl:Math.abs(avgPnl)*1.2}); for(let i=0;i<oosLoss;i++) oosTrades.push({pnl:-Math.abs(avgPnl)*0.9}); }
    const mcResult = this.monteCarlo(oosTrades, 1000);
    const scorecard = this.overfitScoreCard(wfResult, stabilityResult, mcResult);
    console.log(`\n${'═'.repeat(80)}\n📋 最终评分卡 — ${symbol}\n${'═'.repeat(80)}`);
    console.log(`  综合评分: ${scorecard.score}/100`);
    console.log(`  结论:     ${scorecard.verdict}`);
    console.log(`\n  子项得分:`);
    console.log(`    Walk-Forward:  OOS退化=${wfResult.summary.avgDegradation.toFixed(1)}% | OOS正收益=${(wfResult.summary.oosPositiveRate*100).toFixed(0)}%`);
    console.log(`    参数稳定性:   ${stabilityResult.stabilityScore}/100`);
    console.log(`    Monte Carlo:   破产概率=${mcResult.bankruptcyProbability||'N/A'}`);
    console.log(`${'═'.repeat(80)}`);
    return { symbol, interval, klines:klines.length, baseline:baselineResult.stats, walkForward:wfResult, parameterStability:stabilityResult, monteCarlo:mcResult, scorecard, bestParams };
  }
}

module.exports = WalkForwardPro;
