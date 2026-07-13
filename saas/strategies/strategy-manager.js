/**
 * v60: 策略管理器 — 第一梯队
 * 
 * 整合7个策略模块，统一调度：
 * 1. MultiTimeframe  — 多时间框架趋势分析
 * 2. GridTrading     — 网格交易
 * 3. DCAInvesting    — DCA定投
 * 4. KellyPosition   — 凯利仓位
 * 5. VolatilityAdaptive — 波动率自适应
 * 6. MLPredictor     — [v60新] ML趋势预测
 * 7. DynamicWeight   — [v60新] 动态权重
 * 8. RiskParity      — [v60新] 风险平价
 * 9. TailRiskControl — [v60新] 尾部风险控制

 */

const { GridTrading } = require('./grid-trading');
const { DCAInvesting } = require('./dca-investing');
const { MultiTimeframe } = require('./multi-timeframe');
const { KellyPosition } = require('./kelly-position');
const { VolatilityAdaptive } = require('./volatility-adaptive');
const { MLPredictor } = require('./ml-predictor');
const { NeuralNet } = require('./neural-net');
const { DynamicWeight } = require('./dynamic-weight');
const { RiskParity } = require('./risk-parity');
const { TailRiskControl } = require('./tail-risk-control');
const { StrategyEnsemble } = require('./ensemble');

// v93: 世界顶尖策略新增
const FundingRateArb = require('./funding-rate-arb');
const DeltaNeutral = require('./delta-neutral');
const CrossExchangeSpread = require('./cross-exchange-spread');
const SentimentDriven = require('./sentiment-driven');

// v93+: 精英策略新增
const RegimeDetect = require('./regime-detect');
const PairsTrading = require('./pairs-trading');
const MarketMakingV2 = require('./market-making');

// v85: EnhancedDataBus（可选，不强制加载）
let EnhancedDataBus;
try { EnhancedDataBus = require('../enhanced-databus').EnhancedDataBus; } catch(e) { EnhancedDataBus = null; }

class StrategyManager {
  constructor(config = {}) {
    // 初始化所有策略
    // v73: 只保留真正参与开仓决策的策略
    this.strategies = {
      grid: new GridTrading(config.grid || {}),
      dca: new DCAInvesting(config.dca || {}),
      multiTimeframe: new MultiTimeframe(),
      kelly: new KellyPosition(config.kelly || {}),
      volatility: new VolatilityAdaptive(config.volatility || {}),
      ml: new MLPredictor(config.ml || {}),
      dynamicWeight: new DynamicWeight(config.dynamicWeight || {}),
      riskParity: new RiskParity(config.riskParity || {}),
      tailRisk: new TailRiskControl(config.tailRisk || {}),
      neuralNet: new NeuralNet(config.neuralNet || {}),
      // v85: 多策略投票制融合层
      ensemble: new StrategyEnsemble(config.ensemble || {}),
      // v93: 世界顶尖策略
      fundingRate: FundingRateArb,
      deltaNeutral: DeltaNeutral,
      crossSpread: CrossExchangeSpread,
      sentiment: SentimentDriven,
      // v93+: 精英策略
      regimeDetect: RegimeDetect,
      pairsTrading: PairsTrading,
      marketMaking: MarketMakingV2,
    };
    // v85: EnhancedDataBus实例
    this._enhancedBus = EnhancedDataBus ? new EnhancedDataBus() : null;

    // 尝试加载已训练的神经网络模型
    this.strategies.neuralNet.load();

    // v114: 策略权重重构 — 对标世界顶级量化基金
    // 权重之和不需要=1, 最终会被归一化
    // 杀死: grid, dca, crossSpread, deltaNeutral, fundingRate(假), sentiment(假), riskParity, marketMaking
    // 保留并加强: neuralNet, ml, multiTimeframe, volatility, regimeDetect
    this.weights = {
      neuralNet: 0.30,          // 神经网络 — 主权重 (对标Renaissance统计模型)
      ml: 0.25,                 // 多因子ML预测 (对标Two Sigma多因子)
      multiTimeframe: 0.20,     // 多时间框架趋势 (对标Citadel趋势跟踪)
      regimeDetect: 0.15,       // 市场体制检测 (对标AQR regime switching)
      volatility: 0.10,         // 波动率自适应 (风控)
      // 以下策略权重=0 但保留代码做风控参考
      kelly: 0.00,              // Kelly仓位已在PositionSizer处理
      dynamicWeight: 0.00,      // 动态权重已被固定权重替代
      tailRisk: 0.00,           // 尾部风险(仅保护不参与开仓)
      // 已杀死的策略(权重=0, 不参与决策)
      grid: 0.00,               // 网格交易 — 趋势市场必亏
      dca: 0.00,                // DCA定投 — 与趋势策略矛盾
      fundingRate: 0.00,        // 资金费率套利 — 没有实际计算funding rate
      deltaNeutral: 0.00,       // Delta中性 — 没有期权无法实现
      crossSpread: 0.00,        // 跨所价差 — 只有一个交易所
      sentiment: 0.00,          // 情绪驱动 — 没有真实情绪数据源
      pairsTrading: 0.00,       // 配对交易 — 需要协整检验
      riskParity: 0.00,         // 风险平价 — 仓位已在PositionSizer处理
    };

    // v114: 只启用有效策略
    this.enabled = {
      multiTimeframe: true,
      neuralNet: true,
      ml: true,
      volatility: true,
      regimeDetect: true,
      kelly: true,          // 保留代码做仓位参考
      dynamicWeight: true,  // 保留代码做权重参考
      tailRisk: true,       // 保留做风控
      // 已杀死
      grid: false,
      dca: false,
      fundingRate: false,
      deltaNeutral: false,
      crossSpread: false,
      sentiment: false,
      pairsTrading: false,
      marketMaking: false,
      riskParity: false,
    };

    // 策略状态
    this.strategyState = {};
    this.lastUpdate = 0;
    this.updateInterval = 60000;

    // v60: 风险状态
    this._riskLevel = 'safe';
    this._riskAction = 'continue';
    this._cycleCount = 0;
  }

  /**
   * v60: 综合分析（升级版）
   */
  async analyze(marketData) {
    const { klines, currentPrice, symbol } = marketData;
    this._cycleCount++;

    // v50: 多时间框架K线
    const klinesByTimeframe = this._buildMultiTimeframe(klines);

    // ═══ 1. 多时间框架分析 ═══
    const multiTimeframeResult = this.strategies.multiTimeframe.analyze(klinesByTimeframe);
    const multiTimeframeSignal = this.strategies.multiTimeframe.generateSignal(multiTimeframeResult);
    const consistency = this.strategies.multiTimeframe.checkConsistency(multiTimeframeResult);

    // ═══ 2. 波动率分析 ═══
    const volatilityResult = this.strategies.volatility.calculateVolatility(klines);
    const volatilityAdvice = this.strategies.volatility.getRegimeAdvice();
    const anomalyCheck = this.strategies.volatility.checkAnomaly();

    // ═══ 3. v60: 动态权重（根据市场状态调整） ═══
    // 构建模拟indicators供DynamicWeight使用
    const simulatedInd = this._buildSimulatedIndicators(klines, currentPrice);
    const dynamicWeightResult = this.strategies.dynamicWeight.evaluate(simulatedInd, volatilityResult);
    const activeWeights = dynamicWeightResult.weights;

    // v73: 直接使用ML预测，LSTM微服务已禁用
    const effectiveMlResult = this.strategies.ml.predict(klines, simulatedInd);

    // ═══ 4b. v63: 神经网络预测 ═══
    const nnFeatures = this.strategies.neuralNet.extractFeatures(klines, simulatedInd);
    nnFeatures._symbol = symbol;
    const nnResult = this.strategies.neuralNet.predict(nnFeatures);
    // 神经网络结果转换为 ML 兼容格式
    const nnSignal = {
      valid: nnResult.valid,
      direction: nnResult.direction,
      confidence: nnResult.confidence,
      action: nnResult.action,
      probabilities: nnResult.probabilities,
      source: 'neural-net',
    };

    // ═══ 5. 网格分析 ═══
    const gridAnalysis = this.strategies.grid.analyze(klines);
    let gridSignal = { action: 'HOLD', reason: '网格不适用' };
    if (gridAnalysis.suitable) {
      const gridSetup = this.strategies.grid.setupGrid(currentPrice, gridAnalysis.high, gridAnalysis.low);
      gridSignal = this.strategies.grid.generateSignal(currentPrice);
    }

    // ═══ 6. DCA分析 ═══
    const dcaAnalysis = this.strategies.dca.analyze(klines, currentPrice);
    let dcaSignal = { action: 'HOLD', reason: 'DCA不适用' };
    if (dcaAnalysis.suitable) {
      dcaSignal = this.strategies.dca.generateSignal(currentPrice);
    }

    // ═══ v85: Ensemble多策略投票 ═══
    let ensembleResult = null;
    try {
      // 获取增强市场数据（orderbook, funding, volume profile）
      let enhancedData = {};
      if (this._enhancedBus) {
        enhancedData = await this._enhancedBus.getEnhancedData(symbol, klines);
      }
      ensembleResult = this.strategies.ensemble.evaluate(klines, enhancedData);
      // 根据市场体制调整权重
      this.strategies.ensemble.adjustForRegime(dynamicWeightResult.regime || 'neutral');
    } catch(e) {
      ensembleResult = { action: 'FLAT', confidence: 0, reasoning: `Ensemble错误: ${e.message}` };
    }

    // ═══ 7. v60: 综合评分（使用动态权重 + ML + v85 Ensemble） ═══
    const compositeScore = this.calculateCompositeScore({
      multiTimeframe: multiTimeframeSignal,
      grid: gridSignal,
      dca: dcaSignal,
      volatility: volatilityResult,
      consistency,
      ml: effectiveMlResult,
      activeWeights,
      ensemble: ensembleResult,  // v85: 新增
    });

    // ═══ 8. 生成最终信号 ═══
    const finalSignal = this.generateFinalSignal(compositeScore, {
      multiTimeframe: multiTimeframeSignal,
      grid: gridSignal,
      dca: dcaSignal,
      volatility: volatilityResult,
      volatilityAdvice,
      anomalyCheck,
      consistency,
      ml: effectiveMlResult,
      neuralNet: nnSignal,
      ensemble: ensembleResult,  // v85: 新增
    });

    // ═══ 9. v60: 风险评估 ═══
    const riskAssessment = this.strategies.tailRisk.assess({
      equity: marketData.equity || 0,
      positions: marketData.positions || [],
      indicators: simulatedInd,
      klines,
    });
    this._riskLevel = riskAssessment.riskLevel;
    this._riskAction = riskAssessment.action;

    // v60: 如果风险等级高，降低信号
    if (riskAssessment.action === 'stop' || riskAssessment.action === 'liquidate') {
      finalSignal.action = 'HOLD';
      finalSignal.reasons.push(`TAIL_RISK: ${riskAssessment.reason}`);
    } else if (riskAssessment.action === 'reduce') {
      finalSignal.confidence *= (1 - riskAssessment.reducePct);
      finalSignal.reasons.push(`TAIL_RISK_REDUCE: ${riskAssessment.reason}`);
    }

    return {
      symbol,
      timestamp: Date.now(),
      compositeScore,
      finalSignal,
      analysis: {
        multiTimeframe: multiTimeframeResult,
        grid: gridAnalysis,
        dca: dcaAnalysis,
        volatility: volatilityResult,
        volatilityAdvice,
        anomalyCheck,
        consistency,
        // v60 新增
        ml: effectiveMlResult,
        neuralNet: nnSignal,
        dynamicWeight: dynamicWeightResult,
        risk: riskAssessment,
      },
      signals: {
        multiTimeframe: multiTimeframeSignal,
        grid: gridSignal,
        dca: dcaSignal,
        ml: effectiveMlResult,
        neuralNet: nnSignal,
      },
    };
  }

  /**
   * v60: 综合评分（使用动态权重 + ML预测）
   */
  calculateCompositeScore(signals) {
    let score = 0;
    let totalWeight = 0;
    let reasons = [];

    const w = signals.activeWeights || this.weights;

    // v114: 只计算有效策略的分数, 跳过权重=0的已杀死策略

    // 多时间框架信号
    if (this.enabled.multiTimeframe && signals.multiTimeframe.action !== 'HOLD') {
      const mtScore = signals.multiTimeframe.action === 'BUY' ?
        signals.multiTimeframe.strength : -signals.multiTimeframe.strength;
      score += mtScore * (w.multiTimeframe || 0.20);
      totalWeight += w.multiTimeframe || 0.20;
      reasons.push(`多时间框架: ${mtScore.toFixed(2)}`);
    }

    // ML预测信号
    if (this.enabled.ml && signals.ml?.valid && signals.ml.direction !== 0) {
      const mlScore = signals.ml.fusedScore;
      score += mlScore * (w.ml || 0.25);
      totalWeight += w.ml || 0.25;
      reasons.push(`ML: dir=${signals.ml.direction} conf=${signals.ml.confidence.toFixed(2)}`);
    }

    // 神经网络预测信号 — 主权重
    if (this.enabled.neuralNet && signals.neuralNet?.valid && signals.neuralNet.direction !== 0) {
      const nnScore = signals.neuralNet.direction * signals.neuralNet.confidence;
      score += nnScore * (w.neuralNet || 0.30);
      totalWeight += w.neuralNet || 0.30;
      reasons.push(`神经网络: ${signals.neuralNet.action} conf=${signals.neuralNet.confidence.toFixed(2)}`);
      
      // 高置信度加成
      if (signals.neuralNet.confidence >= 0.8) {
        const boost = signals.neuralNet.direction * signals.neuralNet.confidence * 0.3;
        score += boost;
        totalWeight += 0.3;
        reasons.push(`🔥NN高置信度: +${boost.toFixed(2)}`);
      }
    }

    // Ensemble投票 (如果有效)
    if (signals.ensemble && signals.ensemble.action !== 'FLAT' && signals.ensemble.confidence > 0.3) {
      const ensDir = signals.ensemble.action === 'LONG' ? 1 : signals.ensemble.action === 'SHORT' ? -1 : 0;
      const ensScore = ensDir * signals.ensemble.confidence;
      score += ensScore * 0.20;
      totalWeight += 0.20;
      reasons.push(`Ensemble: ${signals.ensemble.action} conf=${signals.ensemble.confidence.toFixed(2)}`);
    }

    // v114: 已杀死的策略(grid/dca/fundingRate/sentiment等)不再计算分数

    // 波动率调整
    if (signals.volatility.regime === 'extreme') {
      score *= 0.5;
      reasons.push('波动率极端: 评分×0.5');
    }

    // 一致性加成
    if (signals.consistency.consistent) {
      score *= 1.2;
      reasons.push('时间框架一致: +20%');
    }

    // ML一致性加成
    if (signals.ml?.valid && signals.ml.consistency > 0.75) {
      score *= 1.15;
      reasons.push(`ML一致(${(signals.ml.consistency * 100).toFixed(0)}%): +15%`);
    }

    // 归一化
    if (totalWeight > 0) {
      score /= totalWeight;
    }

    return {
      score,
      weights: totalWeight,
      reasons,
      normalized: Math.max(-1, Math.min(1, score)),
    };
  }

  /**
   * v60: 生成最终信号（加入ML和风险因素）
   */
  generateFinalSignal(compositeScore, allSignals) {
    const { score, normalized } = compositeScore;
    const { volatilityAdvice, anomalyCheck, consistency, ml, ensemble, neuralNet } = allSignals;

    // v113.53: 神经网络高置信度覆盖 — 不让其他策略淹没NN强信号
    // 当 NN 置信度>=0.80 且方向明确时，直接提升到至少 moderate 门槛
    let _nnOverride = false;
    let _overrideDir = 0;
    if (neuralNet?.valid && neuralNet.direction !== 0 && neuralNet.confidence >= 0.80) {
      const nnDir = neuralNet.direction; // 1=LONG, -1=SHORT
      const techDir = normalized > 0 ? 1 : normalized < 0 ? -1 : 0;
      
      if (techDir === 0) {
        // 技术面 HOLD 但 NN 有强方向 → 直接用 NN 方向，提升到 moderate
        _nnOverride = true;
        _overrideDir = nnDir;
        compositeScore.normalized = nnDir * 0.20; // moderate门槛=0.18, 刚过
        compositeScore.reasons.push(`🔥NN覆盖: HOLD→${nnDir > 0 ? 'LONG' : 'SHORT'} conf=${neuralNet.confidence.toFixed(2)}`);
      } else if (techDir === nnDir) {
        // 技术面和NN同方向 → 增强
        _nnOverride = true;
        _overrideDir = nnDir;
        const boost = nnDir * neuralNet.confidence * 0.15;
        compositeScore.normalized = Math.max(-1, Math.min(1, normalized + boost));
        compositeScore.reasons.push(`🔥NN增强: ${nnDir > 0 ? 'LONG' : 'SHORT'} +${boost.toFixed(2)} conf=${neuralNet.confidence.toFixed(2)}`);
      }
      // 如果 techDir 和 nnDir 反向 → 不覆盖，让风险控制决定
    }
    
    const _effectiveNormalized = compositeScore.normalized;

    // v60: 如果ML方向与技术分析矛盾，降低置信度
    let mlConflict = false;
    if (ml?.valid && ml.direction !== 0) {
      const techDir = _effectiveNormalized > 0 ? 1 : _effectiveNormalized < 0 ? -1 : 0;
      if (techDir !== 0 && ml.direction !== techDir) {
        mlConflict = true;
      }
    }

    // v85: Ensemble一致性加成/减损
    let ensembleAgrees = false;
    let ensembleConflict = false;
    let highConfMinority = false;
    if (ensemble && ensemble.action !== 'FLAT' && ensemble.confidence > 0.4) {
      const ensDir = ensemble.action === 'LONG' ? 1 : ensemble.action === 'SHORT' ? -1 : 0;
      const techDir = _effectiveNormalized > 0 ? 1 : _effectiveNormalized < 0 ? -1 : 0;
      if (ensDir === techDir) {
        ensembleAgrees = true;
      } else if (techDir !== 0 && ensDir !== techDir) {
        ensembleConflict = true;
      }
      // v107: 检查是否有高置信度少数派
      if (ensemble.divergence && ensemble.divergence.maxConfidenceVote) {
        const mcv = ensemble.divergence.maxConfidenceVote;
        const mcvDir = mcv.action === 'LONG' ? 1 : mcv.action === 'SHORT' ? -1 : 0;
        if (mcvDir === techDir && mcv.confidence > 0.8) {
          highConfMinority = true; // 少数派方向与最终方向一致且高置信
        }
      }
    }

    // v116: 降低信号阈值 — 放更多机会进来（激进模式）
    const thresholds = {
      strong: 0.25,   // v116: 0.30→0.25 让更多信号被识别为strong
      moderate: 0.15, // v116: 0.18→0.15 让更多信号达到moderate
      weak: 0.06,     // v116: 0.08→0.06
    };

    let action = 'HOLD';
    let strength = 'none';
    let confidence = 0;
    let reasons = [];

    if (_effectiveNormalized > thresholds.strong) {
      action = 'BUY';
      strength = 'strong';
      confidence = 0.85;
      reasons.push('强烈买入信号');
    } else if (_effectiveNormalized > thresholds.moderate) {
      action = 'BUY';
      strength = 'moderate';
      confidence = 0.65;
      reasons.push('中等买入信号');
    } else if (_effectiveNormalized > thresholds.weak) {
      action = 'BUY';
      strength = 'weak';
      confidence = 0.45;
      reasons.push('弱买入信号');
    } else if (_effectiveNormalized < -thresholds.strong) {
      action = 'SELL';
      strength = 'strong';
      confidence = 0.85;
      reasons.push('强烈卖出信号');
    } else if (_effectiveNormalized < -thresholds.moderate) {
      action = 'SELL';
      strength = 'moderate';
      confidence = 0.65;
      reasons.push('中等卖出信号');
    } else if (_effectiveNormalized < -thresholds.weak) {
      action = 'SELL';
      strength = 'weak';
      confidence = 0.45;
      reasons.push('弱卖出信号');
    } else {
      action = 'HOLD';
      strength = 'none';
      confidence = 0.2;
      reasons.push('无明确信号');
    }

    // 异常检查
    if (anomalyCheck.isAnomaly) {
      confidence *= 0.5;
      reasons.push('波动率异常: 信心减半');
    }

    // v113.15: 一致性检查 — 时间框架不一致降分但不归零，顺势信号仍可开仓
    if (!consistency.consistent) {
      confidence *= 0.5;  // v113.15: 从 confidence=0 改为降50%
      reasons.push('⚠️时间框架不一致-50%');
    }

    // v60: ML矛盾检查
    if (mlConflict) {
      confidence *= 0.6;
      reasons.push('ML与技术分析矛盾: -40%');
    }

    // v60: ML一致加成
    if (ml?.valid && !mlConflict && ml.confidence > 0.6) {
      confidence *= 1.1;
      reasons.push('ML确认方向: +10%');
    }

    // v85: Ensemble一致性加成
    if (ensembleAgrees) {
      confidence *= 1.25;
      reasons.push(`Ensemble确认(${ensemble.strength}): +25%`);
    }
    // v85: Ensemble冲突惩罚
    if (ensembleConflict) {
      confidence *= 0.5;
      reasons.push(`Ensemble方向矛盾: -50%`);
    }
    // v107: 高置信度少数派加成 — 少数派与最终方向一致且置信度极高
    if (highConfMinority) {
      confidence *= 1.15;
      reasons.push(`高置信度少数派确认: +15%`);
    }

    // 波动率建议
    if (volatilityAdvice.strategy === '观望') {
      action = 'HOLD';
      reasons.push('波动率建议观望');
    }

    return {
      action,
      strength,
      confidence,
      reasons,
      score: normalized,
      timestamp: Date.now(),
      // v107: 保留分歧度信息供上层使用
      divergence: ensemble?.divergence || null,
    };
  }

  /**
   * v60: 风险平价仓位分配
   */
  allocatePositions(candidates, totalCapital, existingPositions = []) {
    return this.strategies.riskParity.allocate(candidates, totalCapital, existingPositions);
  }

  /**
   * v60: 获取风险报告
   */
  getRiskReport() {
    return this.strategies.tailRisk.getReport();
  }

  /**
   * v60: 记录交易结果（用于ML学习和尾部风险）
   */
  recordTradeResult(pnl, predictedDir, actualDir, factorScores) {
    this.strategies.tailRisk.recordTradeResult(pnl);
    this.strategies.ml.learn(predictedDir, actualDir, factorScores);
    // v63: 神经网络在线训练
    if (factorScores?.nnFeatures && actualDir !== 0) {
      this.strategies.neuralNet.train(factorScores.nnFeatures, actualDir);
      // v107: 每10次训练保存一次模型（从50缩短，减少重启丢失）
      if (this.strategies.neuralNet.trainCount % 10 === 0) {
        this.strategies.neuralNet.save();
      }
    }
  }

  /**
   * v63: 获取神经网络统计
   */
  getNeuralNetStats() {
    return this.strategies.neuralNet.getStats();
  }

  /**
   * v60: 获取ML学习统计
   */
  getMLStats() {
    return this.strategies.ml.getStats();
  }

  /**
   * v60: 获取动态权重统计
   */
  getDynamicWeightStats() {
    return this.strategies.dynamicWeight.getStats();
  }

  /**
   * 计算仓位大小
   */
  calculatePositionSize(params) {
    const { totalCapital, winRate, avgWin, avgLoss, entryPrice, stopLoss } = params;
    const kellyResult = this.strategies.kelly.calculateKelly(winRate, avgWin, avgLoss);
    const volatilityResult = this.strategies.volatility.calculateVolatility(params.klines);
    const adjustedKelly = this.strategies.kelly.adjustForMarket(kellyResult.boundedKelly, {
      volatility: volatilityResult.volatility,
      trendStrength: params.trendStrength || 1,
      rsi: params.rsi || 50,
      correlation: params.correlation || 0,
    });
    const positionSize = this.strategies.kelly.calculatePositionSize(
      totalCapital, adjustedKelly.adjustedKelly, entryPrice, stopLoss
    );
    const drawdownCheck = this.strategies.kelly.updateDrawdown(totalCapital);
    return { kelly: kellyResult, adjustedKelly, positionSize, drawdownCheck, recommendation: positionSize.positionSize };
  }

  optimizePortfolio(positions, totalCapital) {
    return this.strategies.kelly.optimizePortfolio(positions, totalCapital);
  }

  getState() {
    return {
      lastUpdate: this.lastUpdate,
      volatilityRegime: this.strategies.volatility.volatilityRegime,
      currentVolatility: this.strategies.volatility.currentVolatility,
      strategyState: this.strategyState,
      // v60
      riskLevel: this._riskLevel,
      riskAction: this._riskAction,
      mlStats: this.strategies.ml.getStats(),
      dynamicWeightStats: this.strategies.dynamicWeight.getStats(),
      marketRegime: this.strategies.dynamicWeight.currentRegime,
    };
  }

  /**
   * v50: 从5分钟K线构建多时间框架数据
   */
  _buildMultiTimeframe(klinesBase) {
    // v69: 输入已是1h K线，合成4h和12h
    if (!klinesBase || klinesBase.length < 50) {
      return { '1h': klinesBase, '4h': null, '12h': null };
    }
    return {
      '1h': klinesBase,
      '4h': this._aggregateKlines(klinesBase, 4),
      '12h': this._aggregateKlines(klinesBase, 12),
    };
  }

  _aggregateKlines(klines, ratio) {
    if (!klines || klines.length < ratio) return [];
    const result = [];
    for (let i = 0; i + ratio <= klines.length; i += ratio) {
      const batch = klines.slice(i, i + ratio);
      result.push({
        open: batch[0].open,
        high: Math.max(...batch.map(k => k.high)),
        low: Math.min(...batch.map(k => k.low)),
        close: batch[batch.length - 1].close,
        volume: batch.reduce((sum, k) => sum + (k.volume || 0), 0),
      });
    }
    return result;
  }

  /**
   * v60: 从K线构建模拟指标（供DynamicWeight和ML使用）
   */
  _buildSimulatedIndicators(klines, currentPrice) {
    if (!klines || klines.length < 55) {
      return { adx: 0, atrPercent: 0, rsi: 50, bb: { width: 0 }, plusDI: 0, minusDI: 0 };
    }

    const closes = klines.map(k => k.close);
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);
    const n = closes.length;

    // SMA
    const sma = (data, period) => {
      if (data.length < period) return 0;
      return data.slice(-period).reduce((a, b) => a + b, 0) / period;
    };
    const ma7 = sma(closes, 7);
    const ma25 = sma(closes, 25);
    const ma99 = sma(closes, 99);

    // RSI
    let gains = 0, losses = 0;
    for (let i = n - 14; i < n; i++) {
      if (i > 0) {
        const change = closes[i] - closes[i - 1];
        if (change > 0) gains += change;
        else losses -= change;
      }
    }
    const avgGain = gains / 14;
    const avgLoss = losses / 14;
    const rsi = avgLoss > 0 ? 100 - 100 / (1 + avgGain / avgLoss) : 50;

    // ATR
    let atrSum = 0;
    for (let i = n - 14; i < n; i++) {
      if (i > 0) {
        atrSum += Math.max(
          highs[i] - lows[i],
          Math.abs(highs[i] - closes[i - 1]),
          Math.abs(lows[i] - closes[i - 1])
        );
      }
    }
    const atr = atrSum / 14;
    const atrPercent = currentPrice > 0 ? (atr / currentPrice * 100) : 0;

    // Bollinger Band Width
    const mid = sma(closes, 20);
    let variance = 0;
    for (let i = n - 20; i < n; i++) variance += Math.pow(closes[i] - mid, 2);
    variance /= 20;
    const std = Math.sqrt(variance);
    const bbWidth = currentPrice > 0 ? (4 * std / currentPrice * 100) : 0;

    // ADX (simplified)
    const adxData = this._calcADX(highs, lows, closes, 14);

    return {
      price: currentPrice,
      ma7, ma25, ma99,
      rsi,
      atr, atrPercent,
      bb: { width: bbWidth },
      adx: adxData.adx,
      plusDI: adxData.plusDI,
      minusDI: adxData.minusDI,
    };
  }

  _calcADX(highs, lows, closes, period = 14) {
    if (closes.length < period * 2) return { adx: 0, plusDI: 0, minusDI: 0 };
    const tr = [], plusDM = [], minusDM = [];
    for (let i = 1; i < highs.length; i++) {
      tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
      const up = highs[i] - highs[i - 1], down = lows[i - 1] - lows[i];
      plusDM.push(up > down && up > 0 ? up : 0);
      minusDM.push(down > up && down > 0 ? down : 0);
    }
    const smooth = (arr, p) => {
      const s = [arr.slice(0, p).reduce((a, b) => a + b, 0)];
      for (let i = p; i < arr.length; i++) s.push(s[s.length - 1] - s[s.length - 1] / p + arr[i]);
      return s;
    };
    const sTR = smooth(tr, period), sPDM = smooth(plusDM, period), sMDM = smooth(minusDM, period);
    const pdiArr = [], mdiArr = [], dxArr = [];
    for (let i = 0; i < sTR.length; i++) {
      const pdi = sTR[i] ? sPDM[i] / sTR[i] * 100 : 0;
      const mdi = sTR[i] ? sMDM[i] / sTR[i] * 100 : 0;
      pdiArr.push(pdi); mdiArr.push(mdi);
      dxArr.push(pdi + mdi ? Math.abs(pdi - mdi) / (pdi + mdi) * 100 : 0);
    }
    let adx = 0;
    if (dxArr.length >= period) adx = dxArr.slice(-period).reduce((a, b) => a + b, 0) / period;
    return { adx, plusDI: pdiArr[pdiArr.length - 1] || 0, minusDI: mdiArr[mdiArr.length - 1] || 0 };
  }

  // ═══════════════════════════════════════════
  // v66: 新策略快捷方法
  // ═══════════════════════════════════════════

  // v73: 无用策略方法已移除 (statArb, marketMaker, optionsGreeks, mevBot, multiServer)

  updateState(newState) {
    this.strategyState = { ...this.strategyState, ...newState };
    this.lastUpdate = Date.now();
  }

  // ═══════════════════════════════════════════
  // v66: 策略权重管理
  // ═══════════════════════════════════════════

  /** 获取所有策略权重和状态 */
  getStrategyConfig() {
    const result = {};
    for (const [name, weight] of Object.entries(this.weights)) {
      result[name] = {
        weight,
        enabled: this.enabled[name] || false,
      };
    }
    return result;
  }

  /** 设置策略权重 */
  setWeight(strategyName, weight) {
    if (this.weights.hasOwnProperty(strategyName)) {
      this.weights[strategyName] = Math.max(0, Math.min(1, weight));
      return { ok: true, strategy: strategyName, weight: this.weights[strategyName] };
    }
    return { ok: false, error: `Unknown strategy: ${strategyName}` };
  }

  /** 启用/禁用策略 */
  toggleStrategy(strategyName, enabled) {
    if (this.enabled.hasOwnProperty(strategyName)) {
      this.enabled[strategyName] = enabled;
      return { ok: true, strategy: strategyName, enabled: this.enabled[strategyName] };
    }
    return { ok: false, error: `Unknown strategy: ${strategyName}` };
  }

  /** 获取所有策略摘要 */
  getAllSummaries() {
    const summaries = {};
    for (const [name, strategy] of Object.entries(this.strategies)) {
      try {
        summaries[name] = strategy.getSummary ? strategy.getSummary() : { status: 'no summary' };
      } catch (e) {
        summaries[name] = { error: e.message };
      }
    }
    return summaries;
  }
}

module.exports = { StrategyManager };
