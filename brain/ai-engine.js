/**
 * AI Decision Engine v6 — DeepSeek 大模型驱动 + 自我进化
 * 
 * 架构：
 *   DeepSeek 大模型 → 核心决策大脑（理解市场、推理判断）
 *   规则引擎 → 保底降级 + 快速过滤（DeepSeek 挂了时兜底）
 *   OnChainBrain → 链上数据（鲸鱼、资金流向、链上信心）
 *   自我反思 → 每 N 笔交易后回顾，调整策略参数
 * 
 * 决策流程：
 *   1. 规则引擎快速筛选（技术面 + 链上 + 情绪）→ ruleSignal
 *   2. DeepSeek 综合所有维度推理 → deepseekDecision
 *   3. 交叉验证：规则 vs DeepSeek
 *      - 一致 → 强信号，提高信心
 *      - 矛盾 → DeepSeek 优先但降低信心
 *      - DeepSeek 失败 → 规则引擎保底
 *   4. 风控检查 + 盈亏比 → 最终决策
 */

let DeepSeekBrain = null;
try { DeepSeekBrain = require('./deepseek-brain'); } catch(e) { /* optional: deepseek-brain not installed */ }
let OnChainBrain = null;
try { OnChainBrain = require('./onchain-brain'); } catch(e) { /* optional: onchain-brain not installed */ }

class AIDecisionEngine {
  constructor(config, dataBus) {
    this.config = config;
    this.dataBus = dataBus;
    this.recentDecisions = [];
    this.winCount = 0;
    this.lossCount = 0;
    this.totalPnl = 0;
    this.cooldownUntil = 0;
    this.perSymbolCooldown = {};
    this.openTime = {};
    this.dsAdviceCache = {};
    this._dsTimeoutMs = 5000;  // v13: DeepSeek 5秒超时，不阻塞主循环
    this.log = (msg) => console.log(`[AI-Brain] ${new Date().toISOString()} ${msg}`);
    
    // ═══ DeepSeek 核心大脑 ═══
    this.deepseek = DeepSeekBrain ? new DeepSeekBrain({
      apiKey: (config.deepseek && config.deepseek.apiKey) || process.env.DEEPSEEK_API_KEY,
      model: (config.deepseek && config.deepseek.model) || 'deepseek-chat'
    }) : null;
    
    if (this.deepseek && this.deepseek.apiKey) {
      this.log('🧠 DeepSeek 已接入 → AI 大模型决策模式');
    } else {
      this.log('⚙️ DeepSeek 未配置 → 规则引擎降级模式');
    }

    // OnChain Brain
    this.onchain = OnChainBrain ? new OnChainBrain({
      accountBalance: 170,
      maxLeverage: (config.trading && config.trading.maxLeverage) || 5
    }) : null;
    if (this.onchain) this.log('⛓️ OnChainBrain 已接入');

    // 自我反思定时器
    this._selfReflectInterval = null;
    this._tradeCountSinceReflect = 0;
    this._reflectEveryN = 10;  // 每 10 笔交易做一次自我反思
    
    // ═══ 用户喂养数据 ═══
    this._userFeedback = [];     // 用户反馈队列
    this._feedbackWeights = {};   // 按币种的用户评分权重
    this._learningRate = 0.1;    // 学习率
  }

  /**
   * 接收用户反馈，调整策略权重
   */
  feedUserFeedback({ symbol, rating, comment, sentiment, wallet }) {
    this._userFeedback.push({ symbol, rating, comment, sentiment, wallet, ts: Date.now() });
    if (this._userFeedback.length > 200) this._userFeedback = this._userFeedback.slice(-200);
    
    // 更新币种权重
    if (!this._feedbackWeights[symbol]) this._feedbackWeights[symbol] = { score: 0, count: 0 };
    const fb = this._feedbackWeights[symbol];
    fb.count++;
    // rating 1-5 → 权重 0.6-1.4
    const weight = 0.6 + (rating / 5) * 0.8;
    fb.score = fb.score * (1 - this._learningRate) + weight * this._learningRate;
    
    // 如果某币种评分持续低，降低其开仓概率
    if (fb.count >= 3 && fb.score < 0.8) {
      this.log(`📉 ${symbol} 用户反馈差 (${(fb.score*100).toFixed(0)}%)，降低开仓权重`);
    }
    if (fb.count >= 3 && fb.score > 1.2) {
      this.log(`📈 ${symbol} 用户反馈好 (${(fb.score*100).toFixed(0)}%)，提高开仓权重`);
    }
  }

  /**
   * 启动自我反思定时器
   */
  startSelfEvolution() {
    if (!this.deepseek || !this.deepseek.apiKey) return;
    // 每 4 小时做一次定时反思
    this._selfReflectInterval = setInterval(async () => {
      try {
        await this.deepseek.selfReflect();
      } catch (e) {
        this.log(`⚠️ 定时自我反思失败: ${e.message}`);
      }
    }, 4 * 3600000);
    this.log('🧬 自我进化已启动（4小时/次 + 每10笔交易）');
  }

  // ============ 主入口 ============
  async makeDecision(snapshot, currentPosition, accountBalance) {
    const symbol = snapshot.symbol;
    const price = snapshot.ticker?.price || 0;
    this.log(`━━━ 分析 ${symbol} @ $${price} ━━━`);

    // 冷却期
    if (Date.now() < this.cooldownUntil) return this._wait('全局冷却期');
    if (this.perSymbolCooldown[symbol] && Date.now() < this.perSymbolCooldown[symbol]) {
      return this._wait(`${symbol} 冷却期`);
    }

    // ═══ 第1步：技术面规则引擎（快速筛选）═══
    const techAnalysis = this._technicalAnalysisV5(snapshot);
    this.log(`📐 技术面: ${techAnalysis.direction} | score=${techAnalysis.score.toFixed(2)} | ${techAnalysis.reasons.join(', ')}`);

    // ═══ 第2步：链上数据 ═══
    let onchainAnalysis = null;
    if (this.onchain) {
      try {
        const oc = await this.onchain.analyze(symbol);
        onchainAnalysis = {
          direction: oc.direction,
          score: oc.score,
          confidence: oc.confidence,
          dimensions: oc.dimensions,
          reasoning: oc.reasoning,
          suggestedLeverage: oc.meta?.suggestedLeverage || 3,
          suggestedPositionPct: oc.meta?.suggestedPositionPct || 10,
        };
        this.log(`⛓️ 链上: ${onchainAnalysis.direction} | conf=${onchainAnalysis.confidence.toFixed(3)} | ${onchainAnalysis.dimensions?.whale?.detail || ''}`);
      } catch(e) {
        this.log(`⚠️ 链上分析失败: ${e.message}`);
      }
    }

    // ═══ 第3步：情绪面 ═══
    const sentimentAnalysis = this._sentimentAnalysis(snapshot);

    // ═══ 第4步：构建规则引擎信号（传给 DeepSeek 参考）═══
    const ruleSignal = this._buildRuleSignal(techAnalysis, onchainAnalysis, sentimentAnalysis);

    // ═══ 第5步：DeepSeek 仅做数据参考（v13: 非阻塞5秒超时）═══
    let deepseekInsight = null;
    if (this.deepseek && this.deepseek.apiKey) {
      try {
        const dsPromise = this.deepseek.analyzeMarket(
          snapshot, ruleSignal, currentPosition, accountBalance, this.recentDecisions
        );
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('DeepSeek timeout (5s)')), this._dsTimeoutMs)
        );
        deepseekInsight = await Promise.race([dsPromise, timeoutPromise]);
        this.log(`🧠 DeepSeek 参考: ${deepseekInsight.direction} | conf=${deepseekInsight.confidence.toFixed(2)} | ${deepseekInsight.reasoning}`);
      } catch(e) {
        this.log(`⚠️ DeepSeek 跳过: ${e.message}`);
      }
    }

    // ═══ 第6步：规则引擎决策（v7: 核心决策，不再由 DeepSeek 主导）═══
    const consensus = this._ruleBasedDecision(techAnalysis, onchainAnalysis, sentimentAnalysis, ruleSignal);
    this.log(`📐 规则决策: ${consensus.direction} | 强度=${consensus.strength.toFixed(2)} | 来源=${consensus.source}`);

    // ═══ 第7步：盈亏比 ═══
    const riskReward = this._calcRiskRewardV5(consensus, snapshot, price);

    // ═══ 第8步：风控 ═══
    const riskCheck = this._riskCheck(accountBalance, symbol);

    // ═══ 第9步：综合决策 ═══
    const decision = this._fuseDecisionV7({
      symbol,
      snapshot,
      techAnalysis,
      onchainAnalysis,
      sentimentAnalysis,
      deepseekInsight,
      consensus,
      riskReward,
      riskCheck,
      currentPosition,
      accountBalance,
      price
    });

    this.log(`📋 最终: ${decision.action} | 来源=${decision.source || 'unknown'} | ${decision.reasoning}`);

    // 记录
    this.recentDecisions.push({
      symbol, ...decision, price, timestamp: Date.now()
    });
    if (this.recentDecisions.length > 50) this.recentDecisions.shift();

    return decision;
  }

  // ============ 持仓管理 v6：DeepSeek + 规则双通道 ============
  async managePositions(currentPositions, marketData) {
    const actions = [];
    for (const pos of currentPositions) {
      const sym = pos.symbol;
      try {
      const currentPrice = marketData?.[sym]?.price || pos.markPrice;
      if (!currentPrice || currentPrice <= 0) continue;

      const entryPrice = pos.entryPrice;
      if (!entryPrice || isNaN(entryPrice) || entryPrice <= 0) {
        this.log(`⚠️ ${sym} entryPrice 无效(${entryPrice})，跳过持仓管理`);
        continue;
      }
      const isLong = pos.side === 'LONG';
      const leverage = pos.leverage || 3;
      
      const rawPnlPct = isLong
        ? ((currentPrice - entryPrice) / entryPrice) * 100
        : ((entryPrice - currentPrice) / entryPrice) * 100;
      const pnlPct = rawPnlPct * leverage;
      if (isNaN(pnlPct)) {
        this.log(`⚠️ ${sym} pnlPct NaN，跳过`);
        continue;
      }
      // openTime: 如果链上持仓没有 openTime，用实际开仓时间，不设假时间
      if (!this.openTime[sym] && pos.openTime) {
        this.openTime[sym] = pos.openTime;
      }
      const holdMinutes = this.openTime[sym] ? (Date.now() - this.openTime[sym]) / 60000 : 30;

      // ===== 硬止损：必平（放宽到-10%，给仓位足够呼吸空间）=====
      if (pnlPct <= -10) {
        actions.push({ symbol: sym, action: 'CLOSE', reason: `硬止损 PnL=${pnlPct.toFixed(2)}%` });
        this.log(`🛑 ${sym} 硬止损: PnL=${pnlPct.toFixed(2)}%`);
        continue;
      }

      // ===== 快速止损：3分钟内亏损>5%才触发（放宽）=====
      if (holdMinutes < 3 && pnlPct <= -5) {
        actions.push({ symbol: sym, action: 'CLOSE', reason: `快速止损 PnL=${pnlPct.toFixed(2)}% (${holdMinutes.toFixed(1)}min)` });
        this.log(`⚡ ${sym} 快速止损`);
        continue;
      }

      // ===== 止盈：目标提高到15%=====
      if (pnlPct >= 15) {
        actions.push({ symbol: sym, action: 'CLOSE', reason: `止盈 PnL=${pnlPct.toFixed(2)}%` });
        this.log(`🎯 ${sym} 止盈`);
        continue;
      }

      // ===== 动态止盈回落：峰值40%回落才平（放宽）=====
      if (pnlPct > 3) {
        const peakPnl = this._getPeakPnl(sym);
        if (peakPnl > 5 && pnlPct < peakPnl * 0.4) {
          actions.push({ symbol: sym, action: 'CLOSE', reason: `止盈回落 ${pnlPct.toFixed(2)}% < 峰值${peakPnl.toFixed(2)}%` });
          this.log(`📉 ${sym} 止盈回落`);
          continue;
        }
      }

      // ===== v8: 趋势反转检测（取消MA7单一指标，改用BB+价格位置双确认）=====
      if (holdMinutes > 10) {
        const reversal = this._checkTrendReversalV8(sym, pos.side, currentPrice);
        if (reversal) {
          actions.push({ symbol: sym, action: 'CLOSE', reason: reversal });
          this.log(`🔄 ${sym} 趋势反转: ${reversal}`);
          continue;
        }
      }

      this._updatePeakPnl(sym, pnlPct);

      } catch(posErr) {
        this.log(`❌ ${sym} 持仓管理异常，已隔离: ${posErr.message}`);
      }
    }
    return actions;
  }

  // ============ v5 技术分析（趋势确认 + 缩量过滤 + 假信号过滤）============
  _technicalAnalysisV5(snapshot) {
    const ind = snapshot.indicators;
    if (!ind) return { direction: 'WAIT', score: 0, reasons: ['无指标数据'] };

    const reasons = [];
    let longScore = 0;
    let shortScore = 0;

    // 趋势判断
    const trendUp = ind.ma7Direction === 'up' && ind.priceVsMa7 === 'above';
    const trendDown = ind.ma7Direction === 'down' && ind.priceVsMa7 === 'below';
    const earlyBounce = ind.ma7Direction === 'down' && ind.priceVsMa7 === 'above';
    const earlyDrop = ind.ma7Direction === 'up' && ind.priceVsMa7 === 'below';

    if (trendUp) { longScore += 0.4; reasons.push('MA7↑价上方'); }
    else if (trendDown) { shortScore += 0.4; reasons.push('MA7↓价下方'); }
    else if (earlyBounce) { longScore += 0.1; reasons.push('反弹初期'); }
    else if (earlyDrop) { shortScore += 0.1; reasons.push('下跌初期'); }
    else if (ind.ma7Direction === 'up') { longScore += 0.15; reasons.push('MA7↑'); }
    else if (ind.ma7Direction === 'down') { shortScore += 0.15; reasons.push('MA7↓'); }

    // MA 交叉
    if (ind.ma7CrossAbove) {
      if (ind.ma7Direction === 'up' || trendUp) { longScore += 0.25; reasons.push('金叉(确认)'); }
      else if (earlyBounce) { longScore += 0.08; reasons.push('金叉(初期)'); }
      else { longScore += 0.15; reasons.push('金叉'); }
    }
    if (ind.ma7CrossBelow) {
      if (ind.ma7Direction === 'down' || trendDown) { shortScore += 0.25; reasons.push('死叉(确认)'); }
      else if (earlyDrop) { shortScore += 0.08; reasons.push('死叉(初期)'); }
      else { shortScore += 0.15; reasons.push('死叉'); }
    }

    // RSI
    if (ind.rsi < 25) { longScore += 0.25; reasons.push(`RSI超卖${ind.rsi.toFixed(0)}`); }
    else if (ind.rsi < 35) { longScore += 0.15; reasons.push(`RSI偏低${ind.rsi.toFixed(0)}`); }
    else if (ind.rsi < 45) { longScore += 0.05; reasons.push(`RSI中低`); }
    else if (ind.rsi > 75) { shortScore += 0.25; reasons.push(`RSI超买${ind.rsi.toFixed(0)}`); }
    else if (ind.rsi > 65) { shortScore += 0.15; reasons.push(`RSI偏高`); }
    else if (ind.rsi > 55) { shortScore += 0.05; reasons.push(`RSI中高`); }

    // 布林带
    if (ind.bb) {
      if (ind.price <= ind.bb.lower) { longScore += 0.2; reasons.push('触BB下轨'); }
      else if (ind.price >= ind.bb.upper) { shortScore += 0.2; reasons.push('触BB上轨'); }
    }

    // K线
    if (ind.candle.isBullish) { longScore += 0.08; reasons.push(`阳线`); }
    else { shortScore += 0.08; reasons.push(`阴线`); }

    // 成交量确认
    if (ind.volume.ratio > 2.0) {
      if (ind.candle.isBullish) { longScore += 0.15; reasons.push(`放量阳线`); }
      else { shortScore += 0.15; reasons.push(`放量阴线`); }
    } else if (ind.volume.ratio < 0.3) {
      reasons.push('极度缩量');
      longScore *= 0.5; shortScore *= 0.5;
    } else if (ind.volume.ratio < 0.6) {
      reasons.push('缩量');
      longScore *= 0.7; shortScore *= 0.7;
    }

    // 横盘
    if (ind.range?.isRanging) {
      reasons.push('横盘');
      longScore *= 0.5; shortScore *= 0.5;
    }

    // 假信号过滤
    const isEarlyStage = earlyBounce || earlyDrop;
    const minScore = isEarlyStage ? 0.4 : 0.25;

    const score = longScore - shortScore;
    let direction = 'WAIT';
    if (longScore >= minScore && longScore > shortScore * 1.5) direction = 'LONG';
    else if (shortScore >= minScore && shortScore > longScore * 1.5) direction = 'SHORT';

    return { direction, score, reasons, longScore, shortScore, _rsi: ind?.rsi, _indicators: ind };
  }

  _sentimentAnalysis(snapshot) {
    const sentiment = snapshot.sentiment;
    if (!sentiment) return { direction: 'WAIT', score: 0, value: 50 };
    const v = sentiment.value;
    let direction = 'WAIT', score = 0;
    if (v < 20) { direction = 'LONG'; score = 0.3; }
    else if (v < 35) { score = 0.15; }
    else if (v > 80) { direction = 'SHORT'; score = -0.3; }
    else if (v > 65) { score = -0.15; }
    return { direction, score, value: v };
  }

  /**
   * 构建规则引擎综合信号（传给 DeepSeek 参考用的）
   */
  _buildRuleSignal(tech, onchain, sentiment) {
    const reasons = [];
    let strength = 0;
    let action = 'WAIT';

    // 技术面权重最高
    if (tech.direction !== 'WAIT') {
      reasons.push(`技术=${tech.direction}(${tech.score.toFixed(2)})`);
      strength += Math.abs(tech.score) * 0.5;
      action = tech.direction;
    }

    // 链上确认/拒绝
    if (onchain) {
      if (onchain.direction === action && action !== 'WAIT') {
        reasons.push(`链上确认(${onchain.confidence.toFixed(2)})`);
        strength += onchain.confidence * 0.3;
      } else if (onchain.direction !== 'WAIT' && onchain.direction !== action) {
        reasons.push(`链上矛盾(${onchain.direction})`);
        strength -= onchain.confidence * 0.2;
      }
    }

    // 情绪辅助
    if (sentiment.direction === action) {
      reasons.push(`情绪一致`);
      strength += 0.1;
    }

    if (strength < 0.15) action = 'WAIT';

    return { action, strength: Math.max(0, strength), reasons };
  }

  /**
   * v6 交叉验证：DeepSeek 为核心 + 规则引擎验证
   */
  _crossValidateV6(tech, onchain, sentiment, deepseek, ruleSignal) {
    // ═══ DeepSeek 优先模式 ═══
    if (deepseek && deepseek.direction !== 'WAIT') {
      // DeepSeek 有明确方向
      const dsConf = deepseek.confidence || 0;
      let strength = dsConf;

      // 规则引擎确认 → 提高强度
      if (ruleSignal.action === deepseek.direction) {
        strength = Math.min(1, dsConf * 1.2 + ruleSignal.strength * 0.3);
        return {
          direction: deepseek.direction,
          strength,
          source: 'deepseek+rule_confirmed',
          deepseekScore: deepseek.score,
        };
      }

      // 规则引擎矛盾 → 降低强度但不反转
      if (ruleSignal.action !== 'WAIT' && ruleSignal.action !== deepseek.direction) {
        strength = dsConf * 0.65;
        return {
          direction: deepseek.direction,
          strength,
          source: 'deepseek_overrule',
          deepseekScore: deepseek.score,
        };
      }

      // 规则引擎 WAIT → 中等强度
      return {
        direction: deepseek.direction,
        strength: dsConf * 0.85,
        source: 'deepseek_solo',
        deepseekScore: deepseek.score,
      };
    }

    // ═══ DeepSeek 无方向 / 失败 → 规则引擎接管 ═══
    if (tech.direction === 'WAIT') {
      return { direction: 'WAIT', strength: 0, source: 'rule_wait' };
    }

    // 只用规则引擎
    if (!onchain || onchain.direction === 'WAIT') {
      return { direction: tech.direction, strength: 0.5 + Math.abs(tech.score) * 0.3, source: 'rule_only' };
    }

    // 链上确认
    if (onchain.direction === tech.direction) {
      return { direction: tech.direction, strength: 0.7 + onchain.confidence * 0.3, source: 'rule+onchain' };
    }

    // 链上反对
    if (onchain.confidence > 0.35) {
      return { direction: 'WAIT', strength: 0, source: 'onchain_veto' };
    }

    return { direction: tech.direction, strength: 0.4 + Math.abs(tech.score) * 0.2, source: 'rule_weak' };
  }

  /**
   * v5 盈亏比
   */
  _calcRiskRewardV5(consensus, snapshot, price) {
    if (!price || price <= 0 || consensus.direction === 'WAIT') {
      return { ratio: 0, stopLoss: 0, takeProfit: 0, viable: false };
    }

    const ind = snapshot.indicators;
    let atrPct = 1.5;
    if (ind?.bb?.upper && ind?.bb?.lower && ind?.bb?.middle) {
      atrPct = ((ind.bb.upper - ind.bb.lower) / ind.bb.middle) * 100;
    }

    // 使用 DeepSeek 的策略参数
    const slMult = this.deepseek?.strategyParams?.stopLossMultiplier || 2.0;
    const tpMult = this.deepseek?.strategyParams?.takeProfitMultiplier || 4.0;

    const slPct = Math.max(atrPct * slMult, 1.0) / 100;
    const tpPct = Math.max(atrPct * tpMult, 2.0) / 100;

    const direction = consensus.direction;
    let stopLoss, takeProfit;
    if (direction === 'LONG') {
      stopLoss = price * (1 - slPct);
      takeProfit = price * (1 + tpPct);
    } else {
      stopLoss = price * (1 + slPct);
      takeProfit = price * (1 - tpPct);
    }

    const risk = Math.abs(price - stopLoss);
    const reward = Math.abs(takeProfit - price);
    const ratio = risk > 0 ? reward / risk : 0;
    const viable = ratio >= 1.3 && direction !== 'WAIT';

    return { ratio, stopLoss, takeProfit, viable, direction, slPct, tpPct };
  }

  _riskCheck(accountBalance, symbol) {
    const violations = [];
    if (this.totalPnl < -accountBalance * (this.config.trading.maxDrawdownPercent / 100)) {
      violations.push('超过最大回撤');
    }
    const todayPnl = this._getTodayPnl();
    if (todayPnl < -accountBalance * (this.config.trading.dailyLossLimitPercent / 100)) {
      violations.push('超过每日亏损限制');
      this.cooldownUntil = Date.now() + 3600000;
    }
    const recentLosses = this.recentDecisions.slice(-5).filter(d => d.pnl && d.pnl < 0).length;
    if (recentLosses >= 3) {
      violations.push('连续3次亏损');
      this.cooldownUntil = Date.now() + (this.config.trading.cooldownAfterLossMs || 600000);
    }
    return { allowed: violations.length === 0, violations };
  }

  /**
   * v7 规则引擎核心决策（替代 DeepSeek 交叉验证）
   * 规则引擎胜率 67% >> DeepSeek 0%，回归规则主导
   */
  _ruleBasedDecision(tech, onchain, sentiment, ruleSignal) {
    // 技术面是核心
    if (tech.direction === 'WAIT') {
      // 链上也没有方向
      if (!onchain || onchain.direction === 'WAIT') {
        return { direction: 'WAIT', strength: 0, source: 'no_signal' };
      }
      // 技术面 WAIT 但链上有信号 → 低强度
      return { direction: onchain.direction, strength: onchain.confidence * 0.4, source: 'onchain_only_weak' };
    }

    // 技术面有方向
    let strength = 0.5 + Math.abs(tech.score) * 0.3;
    let source = 'rule_tech';

    // 链上确认 → 大幅提升
    if (onchain && onchain.direction === tech.direction) {
      strength = Math.min(1, strength + onchain.confidence * 0.35);
      source = 'rule_tech+onchain';
    }
    // 链上反对 → 降低
    else if (onchain && onchain.direction !== 'WAIT' && onchain.direction !== tech.direction) {
      if (onchain.confidence > 0.35) {
        // 链上强反对 → 中和为 WAIT
        return { direction: 'WAIT', strength: 0, source: 'onchain_veto' };
      }
      strength -= onchain.confidence * 0.2;
      source = 'rule_tech_onchain_disagree';
    }

    // 情绪辅助
    if (sentiment.direction === tech.direction) {
      strength += 0.1;
    }

    if (strength < 0.45) {
      return { direction: 'WAIT', strength: 0, source: 'strength_too_low' };
    }

    return { direction: tech.direction, strength, source };
  }

  /**
   * v7 综合决策（规则引擎主导，DeepSeek 只做参考标注）
   */
  _fuseDecisionV7({ symbol, snapshot, techAnalysis, onchainAnalysis, sentimentAnalysis, deepseekInsight, consensus, riskReward, riskCheck, currentPosition, accountBalance, price: priceParam }) {
    // 风控拦截
    if (!riskCheck.allowed) {
      return this._wait(`风控: ${riskCheck.violations.join('; ')}`);
    }

    // 有持仓
    if (currentPosition) {
      // v7: 平仓判断完全由规则引擎决定，不用 DeepSeek
      const shouldClose = this._shouldClosePositionV7(currentPosition, techAnalysis, priceParam);
      if (shouldClose) {
        this._clearPeakPnl(symbol);
        return {
          action: 'CLOSE', confidence: 0.8, leverage: 0, positionSize: 0,
          stopLoss: 0, takeProfit: 0,
          reasoning: `平仓: ${shouldClose}`,
          source: consensus.source
        };
      }
      const isLong = currentPosition.side === 'LONG';
      const entry = currentPosition.entryPrice || priceParam;
      const pnlPct = isLong ? ((priceParam - entry) / entry) * 100 : ((entry - priceParam) / entry) * 100;
      return this._wait(`持有 ${currentPosition.side} ${symbol} PnL=${pnlPct.toFixed(2)}%`);
    }

    // ===== 无持仓：开仓判断 =====
    const rejectReasons = [];

    if (consensus.direction === 'WAIT') rejectReasons.push('信号未确认');
    if (!riskReward.viable) rejectReasons.push(`盈亏比不足(R:R=${riskReward.ratio.toFixed(1)})`);
    if (consensus.strength < 0.45) rejectReasons.push(`强度不足(${consensus.strength.toFixed(2)})`);
    if (techAnalysis.reasons.includes('横盘')) rejectReasons.push('横盘');
    if (!accountBalance || accountBalance < 10) rejectReasons.push('余额不足');

    // DeepSeek 仅供参考（v7 已不参与决策，此处仅作日志参考）
    // 不再作为开仓过滤条件

    // ⚠️ v8: RSI 过滤放宽 — 做空允许RSI到30，做多允许RSI到70
    const rsi = techAnalysis._rsi;
    if (rsi !== undefined && rsi !== null) {
      if (consensus.direction === 'SHORT' && rsi < 30) {
        rejectReasons.push(`RSI超卖(${rsi.toFixed(0)})禁止做空`);
      }
      if (consensus.direction === 'LONG' && rsi > 70) {
        rejectReasons.push(`RSI超买(${rsi.toFixed(0)})禁止做多`);
      }
    }

    // ⚠️ 趋势确认过滤：只在明确趋势中开仓
    const ind = techAnalysis._indicators;
    if (ind) {
      const hasTrend = (ind.ma7Direction === 'up' || ind.ma7Direction === 'down') &&
                       (ind.priceVsMa7 === 'above' || ind.priceVsMa7 === 'below');
      if (!hasTrend && !ind.ma7CrossAbove && !ind.ma7CrossBelow) {
        rejectReasons.push('无明确趋势(非趋势+无交叉)');
      }
    }

    // ⚠️ 成交量确认：缩量不做
    if (ind?.volume?.ratio !== undefined && ind.volume.ratio < 0.6) {
      rejectReasons.push(`缩量(${ind.volume.ratio.toFixed(2)}x)不开仓`);
    }

    if (rejectReasons.length > 0) {
      return this._wait(rejectReasons.join(' | '));
    }

    // ===== 开仓 =====
    const direction = consensus.direction;

    // DeepSeek 参考标注（不影响决策，仅记录）
    const dsNote = deepseekInsight ? ` | DS=${deepseekInsight.direction}(ref)` : '';

    // ⚠️ v8: 成本核算 — 预期利润必须 > 成本 x 3
    const fundingRate = snapshot?.funding || 0;
    const mktPrice = snapshot?.ticker?.price || priceParam || 0;
    // 成本：开仓+平仓手续费 0.04%x2 + 资金费率(按8小时) + 滑点
    const feeCostPct = 0.08; // 0.04% 开 + 0.04% 平
    const fundingCostPct = Math.abs(fundingRate) * 100; // 每8小时
    const slippagePct = 0.03; // 0.03% 滑点
    const totalCostPct = feeCostPct + fundingCostPct + slippagePct;
    // 预期利润 = ATR 波动率 x R:R
    const atrPct = techAnalysis._indicators?.atrPercent || 1.0;
    const expectedProfitPct = atrPct * riskReward.ratio;
    if (expectedProfitPct < totalCostPct * 3) {
      return this._wait(`成本过滤: 预期利润(${expectedProfitPct.toFixed(2)}%) < 成本x3(${(totalCostPct * 3).toFixed(2)}%)`);
    }

    // 杠杆：v8 激进策略 — 充分利用资金
    let leverage;
    const baseLeverage = onchainAnalysis?.suggestedLeverage || 6;
    // v8: 放宽杠杆限制，高波动时仍保持一定杠杆
    let maxLev = 12;
    if (atrPct > 5) maxLev = 4;
    else if (atrPct > 3) maxLev = 6;
    else if (atrPct > 2) maxLev = 8;
    leverage = Math.max(3, Math.min(Math.round(baseLeverage * consensus.strength * 1.5), maxLev));

    // 仓位：v8 激进策略 — 12%本金，高置信度加码
    let positionPct = onchainAnalysis?.suggestedPositionPct || 12;
    if (atrPct > 5) positionPct = Math.min(positionPct, 8);
    else if (atrPct > 3) positionPct = Math.min(positionPct, 10);
    // 高置信度(>0.7)允许满仓位
    const confidence = consensus.strength;
    if (confidence < 0.5) positionPct = Math.min(positionPct, 8);
    const positionSize = accountBalance * (positionPct / 100) * confidence;

    // 最小可开金额检查（Binance 最小 $5）
    if (positionSize < 8) {
      return this._wait(`仓位太小($${positionSize.toFixed(2)} < $8)`);
    }

    // 冷却期：v15 延长至5分钟（防止频繁交易）
    this.perSymbolCooldown[symbol] = Date.now() + 300000;
    this.openTime[symbol] = Date.now();

    // 理由
    const ruleReasons = techAnalysis.reasons.slice(0, 3).join(',');
    const costNote = `cost=${totalCostPct.toFixed(3)}% R:R=${riskReward.ratio.toFixed(1)}`;
    const reasoning = `${direction} | 技术=${techAnalysis.direction}(${techAnalysis.score.toFixed(2)}) 链上=${onchainAnalysis?.direction || 'N/A'} | ${costNote} lev=${leverage}x${dsNote} | ${ruleReasons}`;

    return {
      action: direction,
      confidence,
      leverage,
      positionSize,
      stopLoss: riskReward.slPct,
      takeProfit: riskReward.tpPct,
      reasoning,
      source: consensus.source
    };
  }

  /**
   * v7 平仓判断（纯规则引擎，去掉 DeepSeek）
   * DeepSeek 平仓胜率 0/7=0%，不再信任
   */
  _shouldClosePositionV7(pos, techAnalysis, currentPrice) {
    // v8: 放宽平仓条件，不再频繁因技术面波动平仓
    // 技术面强反转 — score>0.4 才触发（之前0.2太敏感）
    if (pos.side === 'LONG' && techAnalysis.direction === 'SHORT' && Math.abs(techAnalysis.score) > 0.4) {
      return `技术面反转 SHORT(score=${techAnalysis.score.toFixed(2)})`;
    }
    if (pos.side === 'SHORT' && techAnalysis.direction === 'LONG' && Math.abs(techAnalysis.score) > 0.4) {
      return `技术面反转 LONG(score=${techAnalysis.score.toFixed(2)})`;
    }

    // v8: 趋势消失+亏损+持仓>30分钟 才平（之前8分钟太短）
    const openTime = pos.openTime || Date.now();
    const holdMinutes = (Date.now() - openTime) / 60000;
    if (holdMinutes > 30 && techAnalysis.direction === 'WAIT' && Math.abs(techAnalysis.score) < 0.1) {
      const unrealizedPnlPct = pos.side === 'SHORT'
        ? ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100
        : ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
      if (unrealizedPnlPct < -1) {
        return `趋势消失(持仓${holdMinutes.toFixed(0)}分钟, PnL=${unrealizedPnlPct.toFixed(2)}%)`;
      }
    }

    return null;
  }

  // ============ 工具方法 ============
  /**
   * 技术强反转检测（DeepSeek HOLD 时的最后防线）
   * 只在 RSI 极端+趋势反转时才覆盖 DeepSeek HOLD
   */
  _checkTechReversal(symbol, currentSide, currentPrice, snapshot) {
    if (!snapshot?.indicators) return null;
    const ind = snapshot.indicators;
    const rsi = ind.rsi || 50;

    // 空头持仓 + RSI 极端超卖(<25) + 价格站上MA7 → 强反弹信号
    if (currentSide === 'SHORT') {
      if (rsi < 25 && ind.priceVsMa7 === 'above') {
        return `RSI极超卖(${rsi.toFixed(0)})+价格站上MA7，强反弹`;
      }
      // 空头 + 金叉确认
      if (ind.ma7CrossAbove && ind.ma7Direction === 'up') {
        return `MA7金叉确认，趋势转多`;
      }
    }

    // 多头持仓 + RSI 极端超买(>75) + 价格跌破MA7 → 强回调信号
    if (currentSide === 'LONG') {
      if (rsi > 75 && ind.priceVsMa7 === 'below') {
        return `RSI极超买(${rsi.toFixed(0)})+价格跌破MA7，强回调`;
      }
      if (ind.ma7CrossBelow && ind.ma7Direction === 'down') {
        return `MA7死叉确认，趋势转空`;
      }
    }

    return null;
  }

  _checkTrendReversal(symbol, currentSide, currentPrice) {
    // v8: 已废弃，改用 _checkTrendReversalV8
    return this._checkTrendReversalV8(symbol, currentSide, currentPrice);
  }

  /**
   * v8 趋势反转检测 — BB+价格位置 双确认
   * 不再用MA7单一指标（震荡市假信号太多）
   */
  _checkTrendReversalV8(symbol, currentSide, currentPrice) {
    if (!this.dataBus) return null;
    const ind = this.dataBus.calculateIndicators(symbol);
    if (!ind || !ind.bb || !ind.bb.upper || !ind.bb.middle) return null;
    const bb = ind.bb;
    const rsi = ind.rsi || 50;

    // 空头持仓 + 价格突破中轨 + RSI>55 → 趋势可能反转为多
    if (currentSide === 'SHORT') {
      if (currentPrice > bb.middle && rsi > 55) {
        return `趋势反转: 价格突破BB中轨($${bb.middle.toFixed(4)}) + RSI=${rsi.toFixed(0)}`;
      }
    }
    // 多头持仓 + 价格跌破中轨 + RSI<45 → 趋势可能反转为空
    if (currentSide === 'LONG') {
      if (currentPrice < bb.middle && rsi < 45) {
        return `趋势反转: 价格跌破BB中轨($${bb.middle.toFixed(4)}) + RSI=${rsi.toFixed(0)}`;
      }
    }
    return null;
  }

  _getPeakPnl(symbol) {
    if (!this._peakPnl) this._peakPnl = {};
    return this._peakPnl[symbol] || 0;
  }

  _updatePeakPnl(symbol, pnlPct) {
    if (!this._peakPnl) this._peakPnl = {};
    if (pnlPct > (this._peakPnl[symbol] || 0)) this._peakPnl[symbol] = pnlPct;
  }

  _clearPeakPnl(symbol) {
    if (this._peakPnl) delete this._peakPnl[symbol];
  }

  _wait(reason) {
    return { action: 'WAIT', confidence: 0, leverage: 0, positionSize: 0, stopLoss: 0, takeProfit: 0, reasoning: `观望: ${reason}` };
  }

  _getTodayPnl() {
    const today = new Date().toISOString().slice(0, 10);
    return this.recentDecisions
      .filter(d => d.timestamp && new Date(d.timestamp).toISOString().slice(0, 10) === today)
      .reduce((sum, d) => sum + (d.pnl || 0), 0);
  }

  recordTradeResult(decision, pnl) {
    const lastDecision = this.recentDecisions[this.recentDecisions.length - 1];
    if (lastDecision) {
      lastDecision.pnl = pnl;
      lastDecision.executed = true;
    }
    if (pnl > 0) this.winCount++;
    else this.lossCount++;
    this.totalPnl += pnl;

    // 反馈给 DeepSeek 学习
    if (this.deepseek) {
      this.deepseek.recordTrade({ ...decision, pnl });
    }

    // 触发自我反思
    this._tradeCountSinceReflect++;
    if (this._tradeCountSinceReflect >= this._reflectEveryN && this.deepseek?.apiKey) {
      this._tradeCountSinceReflect = 0;
      this.deepseek.selfReflect().catch(() => {});
    }

    this.log(`📊 结果: PnL=$${pnl.toFixed(2)} | 胜率=${this.winCount + this.lossCount > 0 ? (this.winCount / (this.winCount + this.lossCount) * 100).toFixed(1) : 0}% | 总=$${this.totalPnl.toFixed(2)}`);
  }

  getStats() {
    const total = this.winCount + this.lossCount;
    const dsStats = this.deepseek?.getPerformanceSummary() || {};
    return {
      winRate: total > 0 ? (this.winCount / total * 100).toFixed(1) + '%' : 'N/A',
      totalTrades: total,
      totalPnl: this.totalPnl.toFixed(2),
      deepseek: dsStats,
      strategyParams: this.deepseek?.strategyParams || {},
      recentDecisions: this.recentDecisions.slice(-10)
    };
  }
}

module.exports = AIDecisionEngine;
