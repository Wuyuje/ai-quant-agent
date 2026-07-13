/**
 * v68: 高级回测增强模块
 * 
 * 1. 滑点模型 — 线性 + 平方根模型
 * 2. Walk-Forward Analysis — 滚动窗口验证
 * 3. In-Sample / Out-of-Sample — 过拟合检测
 * 4. Monte Carlo Simulation — 蒙特卡洛模拟
 */

class BacktestEnhancer {
  constructor(config = {}) {
    this.defaultFeeRate = config.feeRate || 0.0004;   // 0.04% (taker)
    this.defaultSlippage = config.slippage || 0.0003;  // 0.03% base slippage
    this.marketImpactFactor = config.impactFactor || 0.1; // 市场冲击因子
  }

  // ═══════════════════════════════════
  // 1. 滑点模型
  // ═══════════════════════════════════

  /**
   * 线性滑点模型 — 按交易量的固定比例
   * @param {number} orderSize — 订单金额 (USDT)
   * @param {number} pairVolume — 交易对24h成交量 (USDT)
   * @returns {number} 滑点比例 (0-1)
   */
  linearSlippage(orderSize, pairVolume) {
    if (!pairVolume || pairVolume <= 0) return this.defaultSlippage;
    const participationRate = orderSize / pairVolume;
    return Math.min(0.05, this.defaultSlippage + participationRate * this.marketImpactFactor);
  }

  /**
   * 平方根市场冲击模型 (Square-Root Impact Model)
   * 机构常用模型：冲击成本 ∝ √(订单量/日均成交量)
   * 参考: Almgren et al. (2005) "Direct Estimation of Equity Market Impact"
   * 
   * @param {number} orderSize — 订单金额
   * @param {number} adv — 平均日成交量 (ADV)
   * @param {number} volatility — 日波动率 (0-1)
   * @returns {object} { slippagePct, model, details }
   */
  squareRootImpact(orderSize, adv, volatility = 0.02) {
    if (!adv || adv <= 0) {
      return { slippagePct: this.defaultSlippage * 100, model: 'fallback', details: { reason: 'no_adv' } };
    }

    const participation = orderSize / adv;
    const permanentImpact = volatility * Math.sqrt(participation) * 0.5;
    const temporaryImpact = volatility * Math.sqrt(participation) * 0.5;
    const totalImpact = permanentImpact + temporaryImpact;

    return {
      slippagePct: Math.min(5, totalImpact * 100), // cap at 5%
      model: 'sqrt',
      details: {
        participation: (participation * 100).toFixed(4) + '%',
        permanentImpact: (permanentImpact * 100).toFixed(4) + '%',
        temporaryImpact: (temporaryImpact * 100).toFixed(4) + '%',
        volatility: (volatility * 100).toFixed(2) + '%',
      },
    };
  }

  /**
   * 综合交易成本模型
   * 总成本 = 手续费 + 滑点 + 市场冲击 + 资金费率
   */
  estimateTotalCost(orderSize, adv, volatility, fundingRate = 0.0001, holdHours = 4) {
    const fee = orderSize * this.defaultFeeRate;
    const impact = this.squareRootImpact(orderSize, adv, volatility);
    const slippageCost = orderSize * (impact.slippagePct / 100);
    const fundingCost = orderSize * Math.abs(fundingRate) * (holdHours / 8); // 8h funding cycle

    const total = fee + slippageCost + fundingCost;
    const totalPct = (total / orderSize) * 100;

    return {
      fee,
      slippage: slippageCost,
      funding: fundingCost,
      total,
      totalPct,
      impact,
    };
  }

  // ═══════════════════════════════════
  // 2. Walk-Forward Analysis
  // ═══════════════════════════════════

  /**
   * Walk-Forward 滚动窗口分析
   * 
   * 将历史数据分成多个窗口：
   *   [In-Sample][Out-of-Sample][In-Sample][Out-of-Sample]...
   * 
   * 在每个 In-Sample 窗口优化参数
   * 在紧接着的 Out-of-Sample 窗口验证
   * 
   * @param {Array} klines — 完整K线数据
   * @param {Function} runStrategy — (klines, params) => { trades, pnl, winRate, sharpe }
   * @param {Object} options — { windowSize, oosRatio, stepSize }
   */
  async walkForward(klines, runStrategy, options = {}) {
    const {
      windowSize = 300,    // 每个窗口 K线数
      oosRatio = 0.3,      // Out-of-Sample 占比
      stepSize = 100,      // 滚动步长
    } = options;

    const results = [];
    const oosSize = Math.floor(windowSize * oosRatio);
    const isSize = windowSize - oosSize;

    console.log(`\n🔄 Walk-Forward Analysis`);
    console.log(`  窗口: ${windowSize}根 | IS=${isSize} OOS=${oosSize} | 步长=${stepSize}`);

    for (let start = 0; start + windowSize <= klines.length; start += stepSize) {
      const isWindow = klines.slice(start, start + isSize);
      const oosWindow = klines.slice(start + isSize, start + windowSize);

      // In-Sample: 优化参数
      const isResult = await runStrategy(isWindow, { phase: 'in-sample' });
      
      // Out-of-Sample: 用IS优化的参数验证
      const oosResult = await runStrategy(oosWindow, { 
        phase: 'out-of-sample',
        params: isResult.optimalParams || {},
      });

      const degradation = isResult.sharpe > 0 
        ? ((isResult.sharpe - oosResult.sharpe) / isResult.sharpe * 100).toFixed(1)
        : 'N/A';

      results.push({
        window: Math.floor(start / stepSize) + 1,
        isStart: start,
        oosStart: start + isSize,
        inSample: {
          pnl: isResult.pnl,
          sharpe: isResult.sharpe,
          winRate: isResult.winRate,
          trades: isResult.trades?.length || 0,
        },
        outOfSample: {
          pnl: oosResult.pnl,
          sharpe: oosResult.sharpe,
          winRate: oosResult.winRate,
          trades: oosResult.trades?.length || 0,
        },
        degradation: degradation + '%',
      });

      console.log(`  Window ${results.length}: IS sharpe=${isResult.sharpe?.toFixed(2)} → OOS sharpe=${oosResult.sharpe?.toFixed(2)} (退化: ${degradation}%)`);
    }

    // 汇总
    const summary = this._summarizeWalkForward(results);
    console.log(`\n📊 Walk-Forward 汇总:`);
    console.log(`  窗口数: ${results.length}`);
    console.log(`  IS 平均夏普: ${summary.avgIsSharpe.toFixed(2)}`);
    console.log(`  OOS 平均夏普: ${summary.avgOosSharpe.toFixed(2)}`);
    console.log(`  平均退化: ${summary.avgDegradation.toFixed(1)}%`);
    console.log(`  OOS 正收益窗口: ${summary.oosPositiveCount}/${results.length}`);
    console.log(`  过拟合风险: ${summary.overfitRisk}`);

    return { results, summary };
  }

  _summarizeWalkForward(results) {
    if (results.length === 0) {
      return { avgIsSharpe: 0, avgOosSharpe: 0, avgDegradation: 0, oosPositiveCount: 0, overfitRisk: 'unknown' };
    }

    const isSharpes = results.map(r => r.inSample.sharpe || 0);
    const oosSharpes = results.map(r => r.outOfSample.sharpe || 0);
    const degradations = results.map(r => {
      const d = parseFloat(r.degradation);
      return isNaN(d) ? 0 : d;
    });

    const avgIsSharpe = isSharpes.reduce((a, b) => a + b, 0) / isSharpes.length;
    const avgOosSharpe = oosSharpes.reduce((a, b) => a + b, 0) / oosSharpes.length;
    const avgDegradation = degradations.reduce((a, b) => a + b, 0) / degradations.length;
    const oosPositiveCount = oosSharpes.filter(s => s > 0).length;

    // 过拟合风险评级
    let overfitRisk = 'low';
    if (avgDegradation > 60) overfitRisk = '🔴 high';
    else if (avgDegradation > 30) overfitRisk = '🟡 moderate';
    else if (avgDegradation > 15) overfitRisk = '🟢 low';
    if (avgOosSharpe < 0) overfitRisk = '🔴 critical (OOS亏损)';

    return {
      avgIsSharpe,
      avgOosSharpe,
      avgDegradation,
      oosPositiveCount,
      overfitRisk,
    };
  }

  // ═══════════════════════════════════
  // 3. In-Sample / Out-of-Sample 分割
  // ═══════════════════════════════════

  /**
   * 将数据分割为训练集和测试集
   * @param {Array} klines — 完整K线
   * @param {number} trainRatio — 训练集占比 (0-1)
   */
  splitData(klines, trainRatio = 0.7) {
    const splitIdx = Math.floor(klines.length * trainRatio);
    return {
      train: klines.slice(0, splitIdx),
      test: klines.slice(splitIdx),
      splitIdx,
      trainSize: splitIdx,
      testSize: klines.length - splitIdx,
    };
  }

  /**
   * 过拟合检测
   * 比较训练集和测试集的表现差异
   */
  detectOverfitting(trainResult, testResult) {
    const trainSharpe = trainResult.sharpe || 0;
    const testSharpe = testResult.sharpe || 0;
    const trainWinRate = trainResult.winRate || 0;
    const testWinRate = testResult.winRate || 0;
    const trainReturn = trainResult.totalReturn || 0;
    const testReturn = testResult.totalReturn || 0;

    const sharpeDegradation = trainSharpe > 0 
      ? ((trainSharpe - testSharpe) / trainSharpe * 100) 
      : 100;
    const winRateDegradation = trainWinRate > 0
      ? ((trainWinRate - testWinRate) / trainWinRate * 100)
      : 0;

    const overfitScore = (
      Math.min(100, Math.abs(sharpeDegradation)) * 0.5 +
      Math.min(100, Math.abs(winRateDegradation)) * 0.3 +
      (trainReturn > 0 && testReturn < 0 ? 20 : 0)
    );

    let verdict;
    if (overfitScore > 60) verdict = '🔴 严重过拟合';
    else if (overfitScore > 35) verdict = '🟡 中度过拟合';
    else if (overfitScore > 15) verdict = '🟢 轻度过拟合';
    else verdict = '✅ 无过拟合';

    return {
      trainSharpe,
      testSharpe,
      sharpeDegradation: sharpeDegradation.toFixed(1) + '%',
      winRateDegradation: winRateDegradation.toFixed(1) + '%',
      trainReturn: trainReturn.toFixed(2) + '%',
      testReturn: testReturn.toFixed(2) + '%',
      overfitScore: overfitScore.toFixed(1),
      verdict,
    };
  }

  // ═══════════════════════════════════
  // 4. Monte Carlo Simulation
  // ═══════════════════════════════════

  /**
   * 蒙特卡洛模拟
   * 将历史交易随机重排，模拟 1000+ 种可能路径
   * 输出：95%置信区间、最大回撤分布、破产概率
   * 
   * @param {Array} trades — 历史交易记录 [{pnl, ...}]
   * @param {number} initialBalance
   * @param {number} simulations — 模拟次数
   */
  monteCarloSimulation(trades, initialBalance = 100, simulations = 1000) {
    if (!trades || trades.length === 0) {
      return { error: 'no_trades' };
    }

    const pnls = trades.map(t => t.pnl || 0);
    const finalReturns = [];
    const maxDrawdowns = [];
    const bankruptcies = [];

    console.log(`\n🎲 Monte Carlo Simulation: ${simulations}次模拟, ${pnls.length}笔交易`);

    for (let sim = 0; sim < simulations; sim++) {
      // 随机打乱交易顺序
      const shuffled = [...pnls].sort(() => Math.random() - 0.5);
      
      let balance = initialBalance;
      let peak = initialBalance;
      let maxDD = 0;
      let bankrupt = false;

      for (const pnl of shuffled) {
        balance += pnl;
        if (balance <= 0) {
          bankrupt = true;
          break;
        }
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak;
        if (dd > maxDD) maxDD = dd;
      }

      finalReturns.push(((balance - initialBalance) / initialBalance) * 100);
      maxDrawdowns.push(maxDD * 100);
      bankruptcies.push(bankrupt);
    }

    // 排序计算分位数
    finalReturns.sort((a, b) => a - b);
    maxDrawdowns.sort((a, b) => a - b);

    const percentile = (arr, p) => {
      const idx = Math.floor(arr.length * p / 100);
      return arr[Math.min(idx, arr.length - 1)];
    };

    const bankruptcyProb = (bankruptcies.filter(b => b).length / simulations) * 100;

    const result = {
      simulations,
      trades: pnls.length,
      initialBalance,
      returns: {
        mean: (finalReturns.reduce((a, b) => a + b, 0) / simulations).toFixed(2) + '%',
        median: percentile(finalReturns, 50).toFixed(2) + '%',
        p5: percentile(finalReturns, 5).toFixed(2) + '%',     // 95%置信下界
        p25: percentile(finalReturns, 25).toFixed(2) + '%',
        p75: percentile(finalReturns, 75).toFixed(2) + '%',
        p95: percentile(finalReturns, 95).toFixed(2) + '%',   // 95%置信上界
        worst: finalReturns[0].toFixed(2) + '%',
        best: finalReturns[simulations - 1].toFixed(2) + '%',
      },
      drawdown: {
        mean: (maxDrawdowns.reduce((a, b) => a + b, 0) / simulations).toFixed(2) + '%',
        median: percentile(maxDrawdowns, 50).toFixed(2) + '%',
        p95: percentile(maxDrawdowns, 95).toFixed(2) + '%',
        worst: maxDrawdowns[simulations - 1].toFixed(2) + '%',
      },
      bankruptcyProbability: bankruptcyProb.toFixed(2) + '%',
      riskLevel: bankruptcyProb > 5 ? '🔴 高风险' : bankruptcyProb > 1 ? '🟡 中风险' : '🟢 低风险',
    };

    console.log(`  收益 95% CI: [${result.returns.p5}, ${result.returns.p95}]`);
    console.log(`  最大回撤 中位数: ${result.drawdown.median}`);
    console.log(`  最大回撤 95%分位: ${result.drawdown.p95}`);
    console.log(`  破产概率: ${result.bankruptcyProbability}`);
    console.log(`  风险等级: ${result.riskLevel}`);

    return result;
  }

  // ═══════════════════════════════════
  // 5. 综合增强回测
  // ═══════════════════════════════════

  /**
   * 带滑点+成本+蒙特卡洛的完整增强回测
   * 包装原有 BacktestEngine.runBacktest 结果
   */
  enhanceResult(backtestResult, options = {}) {
    const {
      orderSize = 100,
      adv = 50000000, // $50M default ADV
      volatility = 0.02,
      simulations = 1000,
    } = options;

    console.log(`\n🔧 增强回测分析...`);

    // 1. 成本分析
    const costAnalysis = this.estimateTotalCost(orderSize, adv, volatility);
    console.log(`  交易成本: ${costAnalysis.totalPct.toFixed(3)}% (fee=${(costAnalysis.fee).toFixed(2)}, slip=${(costAnalysis.slippage).toFixed(2)}, funding=${(costAnalysis.funding).toFixed(2)})`);

    // 2. 蒙特卡洛模拟
    const mcResult = this.monteCarloSimulation(backtestResult.trades || [], backtestResult.initialBalance || 100, simulations);

    // 3. 过拟合检测 (如果有walk-forward结果)
    const overfitCheck = options.trainResult && options.testResult
      ? this.detectOverfitting(options.trainResult, options.testResult)
      : null;

    return {
      original: backtestResult,
      costAnalysis,
      monteCarlo: mcResult,
      overfitCheck,
    };
  }
}

module.exports = BacktestEnhancer;
