/**
 * MasterD Agent v1.0 — MasterD 分身核心
 * 
 * = 克隆 MasterD 的完整 AI Agent =
 * 
 * 这不是简单的外部API调用，而是 MasterD 本人的分身：
 *   1. 语言模型 — 理解自然语言指令，解析意图，生成分析报告
 *   2. 思维模型 — 多步推理链：技术面→基本面→情绪→风险→决策
 *   3. 代码生成 — 自动生成策略代码/调参/修bug/回测验证
 *   4. 执行落地 — 不只是建议，直接调API拿数据→分析→执行→反馈→进化
 *   5. 外部大模型增强 — DeepSeek/OpenAI/Claude多模型投票
 *   6. 新闻中心 — 交易所新闻→情绪分析→信号增强
 * 
 * 架构:
 *   MasterD Agent
 *   ├── LanguageModel    语言理解+意图解析
 *   ├── ThinkingEngine    多步推理链
 *   ├── CodeGenerator     代码生成+验证
 *   ├── Executor          执行落地
 *   ├── LLMManager        外部大模型管理 (多模型投票)
 *   └── NewsHub           新闻信息中心
 */

const LLMManager = require('../saas/llm-manager');
const NewsHub = require('../saas/news-hub');
// v113.11: 自我进化闭环 — 热加载+自动修复+参数自适应+回测验证
const { hotLoader, adaptiveParams, backtestValidator, autoFixer } = require('../saas/auto-fixer');

class MasterDAgent {
  constructor(config = {}) {
    this.config = config;
    this.version = '1.0.0';
    this.name = 'MasterD-Agent';

    // 外部大模型管理器
    this.llm = new LLMManager({
      deepseek: config.deepseek || {},
      openai: config.openai || {},
      claude: config.claude || {},
      voteMode: config.voteMode || 'vote',
    });

    // 新闻信息中心
    this.news = new NewsHub(config.news || {});

    // 交易记忆
    this.memory = {
      trades: [],
      maxTrades: 500,
      lessons: [],
      maxLessons: 100,
      strategyAdjustments: [],
      codeChanges: [],
    };

    // 推理链历史
    this.reasoningChains = [];
    this.maxChains = 200;

    // 代码生成历史
    this.generatedCode = [];
    this.maxCodeHistory = 50;

    // 执行日志
    this.executionLog = [];
    this.maxExecLog = 500;

    // 自适应参数
    this.adaptiveParams = {
      confidenceThreshold: 0.25,
      riskTolerance: 'moderate', // conservative | moderate | aggressive
      maxLeverage: 3,
      learningRate: 0.001,
      selfReflectionInterval: 20, // 每20次交易自我反思一次
    };

    // 统计
    this.stats = {
      totalAnalysis: 0,
      totalDecisions: 0,
      totalCodeGenerated: 0,
      totalExecuted: 0,
      llmVotes: 0,
      llmConsensus: 0,
      newsEnhanced: 0,
      newsBlocked: 0,
      selfReflections: 0,
      strategyAdjustments: 0,
      codeChanges: 0,
      byModel: {},
    };

    // 模型准确率追踪 (用于权重进化)
    this.modelAccuracy = {
      deepseek: { correct: 0, total: 0 },
      openai: { correct: 0, total: 0 },
      claude: { correct: 0, total: 0 },
      masterd: { correct: 0, total: 0 }, // MasterD自身推理
    };

    this.log = (msg) => console.log(`[MasterD-Agent] ${msg}`);
    this.log(`🧬 MasterD Agent 分身已启动 v${this.version}`);
    this.log(`📊 可用模型: ${this.llm.getAvailableModels().map(m => m.name).join(', ') || '纯规则模式'}`);

    // v113.11: 自我进化闭环 — 绑定 HotLoader + AutoFixer + AdaptiveParams
    this.hotLoader = hotLoader;
    this.adaptiveParams2 = adaptiveParams;
    this.backtestValidator = backtestValidator;
    this.autoFixer = autoFixer;
    this.autoFixer.attach(null, this);
    this._evolutionInterval = setInterval(() => this._runEvolution(), 60000);
    this.log(`🧬 v113.11 自我进化闭环已启用 — HotLoader+AutoFixer+AdaptiveParams+Backtest`);
  }

  // ═════════════════════════════════════════════════════════════
  //  1. 语言模型 — 理解自然语言，解析意图
  // ═════════════════════════════════════════════════════════════

  /**
   * 解析自然语言指令
   * @returns {Object} { intent, params, action }
   */
  parseInstruction(text) {
    const t = (text || '').toLowerCase();
    const intent = {
      raw: text,
      intent: 'unknown',
      params: {},
      action: null,
    };

    // 交易指令
    if (/开仓|open.*position|做多|做空|long|short/i.test(t)) {
      intent.intent = 'trade';
      const symbolMatch = t.match(/(\b[a-z]{2,10}\b)/);
      if (symbolMatch) intent.params.symbol = symbolMatch[1].toUpperCase() + 'USDT';
      intent.params.direction = /做多|long/i.test(t) ? 'LONG' : /做空|short/i.test(t) ? 'SHORT' : null;
      intent.action = 'executeTrade';
    }

    // 分析指令
    if (/分析|analyze|看看|评估|行情/i.test(t)) {
      intent.intent = 'analyze';
      const symbolMatch = t.match(/(\b[a-z]{2,10}\b)/);
      if (symbolMatch) intent.params.symbol = symbolMatch[1].toUpperCase() + 'USDT';
      intent.action = 'analyze';
    }

    // 策略调整
    if (/调.*参|优化|adjust.*param|optimize|改.*策略/i.test(t)) {
      intent.intent = 'optimize';
      intent.action = 'optimizeStrategy';
    }

    // 代码生成
    if (/写.*代码|生成.*策略|create.*strategy|write.*code|new.*strategy/i.test(t)) {
      intent.intent = 'codegen';
      intent.action = 'generateCode';
    }

    // 修bug
    if (/修.*bug|fix|修复|错误|error|fail/i.test(t)) {
      intent.intent = 'fixbug';
      intent.action = 'fixBug';
    }

    // 回测
    if (/回测|backtest|测试.*策略/i.test(t)) {
      intent.intent = 'backtest';
      intent.action = 'runBacktest';
    }

    // 查询
    if (/持仓|余额|balance|position|多少/i.test(t)) {
      intent.intent = 'query';
      intent.action = 'queryStatus';
    }

    return intent;
  }

  /**
   * 生成分析报告
   */
  async generateReport(analysisData) {
    const { symbol, klines, indicators, sentiment, brainDecision, positions } = analysisData;

    const systemPrompt = `你是 MasterD，一个专注区块链和量化交易的AI Agent。
你需要生成一份专业的市场分析报告。

要求:
- 简洁有力，不废话
- 给出明确的方向判断和理由
- 标注风险等级
- 如果有新闻影响，必须提及

输出格式:
{
  "symbol": "品种",
  "direction": "LONG/SHORT/WAIT",
  "confidence": 0.0-1.0,
  "analysis": "技术面分析(50字以内)",
  "fundamentals": "基本面分析(50字以内)",
  "risks": "风险提示(30字以内)",
  "recommendation": "操作建议(30字以内)",
  "riskLevel": "low/medium/high"
}`;

    const userPrompt = `品种: ${symbol}
当前价: ${klines?.[klines.length-1]?.close || 'N/A'}
RSI: ${indicators?.rsi || 'N/A'}
MA7: ${indicators?.ma7 || 'N/A'} MA25: ${indicators?.ma25 || 'N/A'}
布林带: ${indicators?.bb ? `上${indicators.bb.upper} 中${indicators.bb.middle} 下${indicators.bb.lower}` : 'N/A'}
情绪: ${sentiment?.label || 'N/A'} (score: ${sentiment?.score || 0})
Brain决策: ${brainDecision?.action || 'N/A'} conf=${brainDecision?.confidence || 0}
现有持仓: ${positions ? Object.keys(positions).join(',') : '无'}`;

    const result = await this.llm.ask(systemPrompt, userPrompt, null, (text) => {
      try { return JSON.parse(text); } catch { return { analysis: text }; }
    });

    return result || { analysis: '分析不可用', direction: 'WAIT', confidence: 0 };
  }

  // ═════════════════════════════════════════════════════════════
  //  2. 思维模型 — 多步推理链
  // ═════════════════════════════════════════════════════════════

  /**
   * 深度分析 — 多步推理链
   * 
   * 推理链:
   *   Step 1: 技术面分析 (K线形态/趋势/指标)
   *   Step 2: 基本面分析 (新闻/资金/情绪)
   *   Step 3: 风险评估 (杠杆/仓位/回撤)
   *   Step 4: 综合决策 (融合以上+外部模型投票)
   *   Step 5: 信号增强 (新闻情绪调整)
   */
  async deepAnalyze(symbol, klines, indicators, marketData = {}, currentPositions = {}) {
    this.stats.totalAnalysis++;
    const startTime = Date.now();

    const chain = {
      symbol,
      timestamp: Date.now(),
      steps: [],
    };

    // Step 1: 技术面推理
    const techAnalysis = this._reasonTechnical(symbol, klines, indicators);
    chain.steps.push({ step: 'technical', result: techAnalysis });
    this.log(`📐 [${symbol}] 技术面: ${techAnalysis.direction} score=${techAnalysis.score.toFixed(2)} | ${techAnalysis.reasons.join(', ')}`);

    // Step 2: 基本面/情绪面推理
    let sentimentData = null;
    try {
      const sentiment = await this.news.getSentiment(symbol);
      sentimentData = sentiment;
      chain.steps.push({ step: 'sentiment', result: sentiment });
      this.log(`📰 [${symbol}] 情绪: ${sentiment.label} score=${sentiment.score.toFixed(2)} | ${sentiment.reasons.slice(0, 2).join(', ')}`);
    } catch (e) {
      chain.steps.push({ step: 'sentiment', result: { error: e.message } });
    }

    // Step 3: 风险评估
    const riskAssessment = this._reasonRisk(symbol, klines, indicators, currentPositions);
    chain.steps.push({ step: 'risk', result: riskAssessment });
    this.log(`⚠️ [${symbol}] 风险: ${riskAssessment.level} | ${riskAssessment.reasons.join(', ')}`);

    // Step 4: 自身推理合成
    const masterdDecision = this._synthesizeDecision(techAnalysis, sentimentData, riskAssessment, currentPositions);
    chain.steps.push({ step: 'masterd_synthesis', result: masterdDecision });
    this.log(`🧠 [${symbol}] MasterD推理: ${masterdDecision.direction} conf=${masterdDecision.confidence.toFixed(2)} | ${masterdDecision.reasoning}`);

    // Step 5: 外部大模型投票增强 (如果有可用模型)
    let llmVote = null;
    if (this.llm.getAvailableModels().length > 0) {
      try {
        llmVote = await this._llmVote(symbol, klines, indicators, sentimentData, masterdDecision);
        chain.steps.push({ step: 'llm_vote', result: llmVote });
        this.stats.llmVotes++;
        if (llmVote.consensus) this.stats.llmConsensus++;
        this.log(`🗳️ [${symbol}] LLM投票: ${llmVote.decision} conf=${(llmVote.confidence || 0).toFixed(2)} consensus=${llmVote.consensus}`);
      } catch (e) {
        chain.steps.push({ step: 'llm_vote', result: { error: e.message } });
      }
    }

    // Step 6: 最终融合决策
    const finalDecision = this._fuseDecision(masterdDecision, llmVote, sentimentData, riskAssessment);
    chain.steps.push({ step: 'final', result: finalDecision });
    this.log(`✅ [${symbol}] 最终: ${finalDecision.direction} conf=${finalDecision.confidence.toFixed(2)} lev=${finalDecision.leverage} | ${finalDecision.reasoning.slice(0, 80)}`);

    // Step 7: 新闻信号增强
    let enhancedSignal = null;
    if (finalDecision.direction !== 'WAIT' && sentimentData) {
      try {
        enhancedSignal = await this.news.enhanceSignal({
          symbol,
          dir: finalDecision.direction,
          confidence: finalDecision.confidence,
          strength: finalDecision.strength,
        });
        if (enhancedSignal.newsBoost) this.stats.newsEnhanced++;
        if (enhancedSignal.newsBlocked) this.stats.newsBlocked++;
        chain.steps.push({ step: 'news_enhance', result: enhancedSignal });
      } catch (e) { /* 静默 */ }
    }

    // 保存推理链
    this.reasoningChains.push(chain);
    if (this.reasoningChains.length > this.maxChains) this.reasoningChains.shift();

    const elapsed = Date.now() - startTime;
    this.stats.totalDecisions++;

    return {
      ...finalDecision,
      newsEnhanced: enhancedSignal,
      reasoningChain: chain.steps.map(s => ({ step: s.step, summary: typeof s.result === 'object' ? JSON.stringify(s.result).slice(0, 200) : String(s.result).slice(0, 200) })),
      elapsedMs: elapsed,
    };
  }

  /**
   * 技术面推理
   */
  _reasonTechnical(symbol, klines, ind) {
    if (!klines || klines.length < 30 || !ind) {
      return { direction: 'WAIT', score: 0, reasons: ['数据不足'] };
    }

    // 安全提取指标值，undefined/null → 默认值
    const rsi = typeof ind.rsi === 'number' ? ind.rsi : 50;
    const ma7 = typeof ind.ma7 === 'number' ? ind.ma7 : 0;
    const ma25 = typeof ind.ma25 === 'number' ? ind.ma25 : 0;
    const ma99 = typeof ind.ma99 === 'number' ? ind.ma99 : 0;
    const macd = typeof ind.macd === 'number' ? ind.macd : null;
    const signal = typeof ind.signal === 'number' ? ind.signal : null;
    const bb = ind.bb || null;

    let score = 0;
    let strength = 0;
    const reasons = [];
    const price = parseFloat(klines[klines.length - 1].close);

    // 趋势
    if (ma7 > ma25) { score += 0.25; strength += 1; reasons.push('MA金叉'); }
    else { score -= 0.25; strength += 1; reasons.push('MA死叉'); }

    if (ma25 > ma99) { score += 0.15; reasons.push('中期趋势向上'); }
    else { score -= 0.15; reasons.push('中期趋势向下'); }

    // RSI
    if (rsi < 30) { score += 0.15; reasons.push(`RSI超卖${rsi.toFixed(0)}`); }
    else if (rsi > 70) { score -= 0.15; reasons.push(`RSI超买${rsi.toFixed(0)}`); }
    else if (rsi > 50) { score += 0.05; reasons.push(`RSI偏多${rsi.toFixed(0)}`); }
    else { score -= 0.05; reasons.push(`RSI偏空${rsi.toFixed(0)}`); }

    // 布林带
    if (bb) {
      if (bb.pctB < 0.2) { score += 0.1; reasons.push('BB下轨反弹'); }
      else if (bb.pctB > 0.8) { score -= 0.1; reasons.push('BB上轨压力'); }
    }

    // MACD
    if (macd != null && signal != null) {
      if (macd > signal) { score += 0.15; reasons.push('MACD金叉'); }
      else { score -= 0.15; reasons.push('MACD死叉'); }
    }

    // 成交量
    const recentVol = klines.slice(-5).reduce((s, k) => s + parseFloat(k.volume), 0) / 5;
    const avgVol = klines.slice(-20).reduce((s, k) => s + parseFloat(k.volume), 0) / 20;
    if (recentVol > avgVol * 1.5) { strength += 0.5; reasons.push('放量'); }
    else if (recentVol < avgVol * 0.5) { strength -= 0.3; reasons.push('缩量'); }

    // K线形态
    const last3 = klines.slice(-3);
    const bullishEngulfing = last3[2].close > last3[1].open && last3[2].open < last3[1].close && last3[2].close > last3[1].close;
    const bearishEngulfing = last3[2].close < last3[1].open && last3[2].open > last3[1].close && last3[2].close < last3[1].close;
    if (bullishEngulfing) { score += 0.1; strength += 0.5; reasons.push('看涨吞没'); }
    if (bearishEngulfing) { score -= 0.1; strength += 0.5; reasons.push('看跌吞没'); }

    let direction = 'WAIT';
    if (score > 0.15) direction = 'LONG';
    else if (score < -0.15) direction = 'SHORT';

    return { direction, score: parseFloat(score.toFixed(3)), strength: Math.max(0, strength), reasons };
  }

  /**
   * 风险评估推理
   */
  _reasonRisk(symbol, klines, ind, currentPositions) {
    let riskScore = 0;
    const reasons = [];
    let level = 'low';

    // 波动率
    if (klines && klines.length > 20) {
      const closes = klines.slice(-20).map(k => parseFloat(k.close));
      const avg = closes.reduce((s, c) => s + c, 0) / closes.length;
      const variance = closes.reduce((s, c) => s + Math.pow(c - avg, 2), 0) / closes.length;
      const volPct = Math.sqrt(variance) / avg * 100;
      if (volPct > 3) { riskScore += 2; reasons.push(`高波动${volPct.toFixed(1)}%`); }
      else if (volPct > 1.5) { riskScore += 1; reasons.push(`中波动${volPct.toFixed(1)}%`); }
    }

    // 持仓数
    const posCount = Object.keys(currentPositions || {}).length;
    if (posCount >= 5) { riskScore += 2; reasons.push(`持仓过多${posCount}个`); }
    else if (posCount >= 3) { riskScore += 1; reasons.push(`持仓${posCount}个`); }

    // RSI极端
    if (ind?.rsi > 80 || ind?.rsi < 20) { riskScore += 1; reasons.push(`RSI极端${ind.rsi.toFixed(0)}`); }

    // 连亏
    const recentTrades = this.memory.trades.slice(-5);
    const recentLosses = recentTrades.filter(t => !t.isWin).length;
    if (recentLosses >= 3) { riskScore += 2; reasons.push(`近期${recentLosses}连亏`); }

    if (riskScore >= 4) level = 'high';
    else if (riskScore >= 2) level = 'medium';

    return { level, score: riskScore, reasons };
  }

  /**
   * 自身推理合成
   */
  _synthesizeDecision(tech, sentiment, risk, currentPositions) {
    let compositeScore = tech.score;
    if (sentiment) compositeScore += sentiment.score * 0.3;
    if (risk.level === 'high') compositeScore *= 0.5;
    else if (risk.level === 'medium') compositeScore *= 0.8;

    let direction = 'WAIT';
    let confidence = 0;
    if (compositeScore > 0.2) { direction = 'LONG'; confidence = Math.min(Math.abs(compositeScore) * 1.5, 1); }
    else if (compositeScore < -0.2) { direction = 'SHORT'; confidence = Math.min(Math.abs(compositeScore) * 1.5, 1); }

    if (risk.level === 'high' && confidence < 0.8) { direction = 'WAIT'; confidence *= 0.3; }

    let leverage = 1;
    if (confidence > 0.7 && risk.level === 'low') leverage = 3;
    else if (confidence > 0.5 && risk.level !== 'high') leverage = 2;
    if (this.memory.trades.slice(-3).filter(t => !t.isWin).length >= 2) leverage = 1;

    const allReasons = [...tech.reasons, ...(sentiment?.reasons || []), ...risk.reasons];

    return {
      direction,
      confidence: parseFloat(confidence.toFixed(3)),
      leverage,
      strength: tech.strength,
      compositeScore: parseFloat(compositeScore.toFixed(3)),
      reasoning: allReasons.slice(0, 5).join(' | '),
      riskLevel: risk.level,
    };
  }

  /**
   * LLM多模型投票
   */
  async _llmVote(symbol, klines, indicators, sentiment, masterdDecision) {
    const systemPrompt = `你是量化交易AI决策系统。根据市场数据给出交易方向判断。

输出严格JSON格式:
{
  "direction": "LONG" | "SHORT" | "WAIT",
  "confidence": 0.0-1.0,
  "reasoning": "30字以内理由",
  "riskNote": "风险提示(可选)"
}

规则:
- 只在有明确方向时给LONG/SHORT
- 数据不足或矛盾时给WAIT
- confidence反映你对这个判断的确信程度`;

    const klineSummary = klines ? `近5根: ${klines.slice(-5).map(k => `${parseFloat(k.close).toFixed(2)}`).join(' → ')}` : '无数据';
    const indSummary = indicators ? `RSI=${indicators.rsi?.toFixed(1) || 'N/A'} MA7=${indicators.ma7?.toFixed(2) || 'N/A'} MA25=${indicators.ma25?.toFixed(2) || 'N/A'}` : '无指标';
    const sentimentSummary = sentiment ? `情绪=${sentiment.label}(${sentiment.score.toFixed(2)})` : '无情绪数据';

    const userPrompt = `品种: ${symbol}
K线: ${klineSummary}
指标: ${indSummary}
情绪: ${sentimentSummary}
MasterD推理: ${masterdDecision.direction} conf=${masterdDecision.confidence.toFixed(2)}

给出你的独立判断:`;

    return await this.llm.vote(systemPrompt, userPrompt, {
      parseFn: (text) => {
        try {
          // 提取JSON
          const match = text.match(/\{[\s\S]*\}/);
          if (match) return JSON.parse(match[0]);
          return { direction: 'WAIT', confidence: 0, reasoning: text.slice(0, 100) };
        } catch { return { direction: 'WAIT', confidence: 0, reasoning: 'parse error' }; }
      },
    });
  }

  /**
   * 融合最终决策 — MasterD自身推理 + LLM投票 + 新闻情绪
   */
  _fuseDecision(masterd, llmVote, sentiment, risk) {
    let direction = masterd.direction;
    let confidence = masterd.confidence;
    let leverage = masterd.leverage;
    const fuseReasons = [`MasterD: ${masterd.direction}(${masterd.confidence.toFixed(2)})`];

    // LLM投票调整
    if (llmVote && llmVote.decision) {
      fuseReasons.push(`LLM投票: ${llmVote.decision}(${(llmVote.confidence || 0).toFixed(2)}) consensus=${llmVote.consensus}`);

      if (llmVote.decision === masterd.direction && llmVote.consensus) {
        // 一致 — 增强置信度
        confidence = Math.min(1, confidence * 1.15 + 0.05);
        fuseReasons.push('模型一致，置信度增强');
      } else if (llmVote.decision !== masterd.direction && llmVote.decision !== 'WAIT') {
        // 分歧 — 降低置信度
        confidence *= 0.6;
        fuseReasons.push('模型分歧，置信度降低');
        if (llmVote.consensus && (llmVote.confidence || 0) > 0.7) {
          // LLM强烈反对 — 采纳LLM方向
          direction = llmVote.decision;
          confidence = (llmVote.confidence || 0) * 0.7;
          fuseReasons.push('LLM强烈反对，采纳LLM方向');
        }
      }
    }

    // 新闻情绪调整
    if (sentiment) {
      const newsAligns = (sentiment.label === 'bullish' && direction === 'LONG') ||
                         (sentiment.label === 'bearish' && direction === 'SHORT');
      const newsConflicts = (sentiment.label === 'bullish' && direction === 'SHORT') ||
                            (sentiment.label === 'bearish' && direction === 'LONG');

      if (newsAligns) {
        confidence = Math.min(1, confidence + Math.abs(sentiment.score) * 0.1);
        fuseReasons.push(`新闻一致+${sentiment.label}`);
      } else if (newsConflicts && Math.abs(sentiment.score) > 0.3) {
        confidence *= 0.7;
        fuseReasons.push(`新闻冲突-${sentiment.label}`);
        if (Math.abs(sentiment.score) > 0.5 && risk.level === 'high') {
          direction = 'WAIT';
          fuseReasons.push('高影响新闻+高风险，转为WAIT');
        }
      }
    }

    // 高风险最终检查
    if (risk.level === 'high' && confidence < 0.6) {
      direction = 'WAIT';
      fuseReasons.push('高风险低置信，转为WAIT');
    }

    confidence = Math.max(0, Math.min(1, confidence));

    return {
      direction,
      confidence: parseFloat(confidence.toFixed(3)),
      leverage,
      strength: masterd.strength,
      reasoning: fuseReasons.join(' | '),
      compositeScore: masterd.compositeScore,
      riskLevel: risk.level,
      llmConsensus: llmVote?.consensus || false,
      llmDecision: llmVote?.decision || null,
    };
  }

  // ═════════════════════════════════════════════════════════════
  //  3. 代码生成 — 自动写策略/调参/修bug
  // ═════════════════════════════════════════════════════════════

  /**
   * 生成策略代码
   */
  async generateStrategy(description, context = {}) {
    this.stats.totalCodeGenerated++;
    const startTime = Date.now();

    const systemPrompt = `你是 MasterD，一个能写量化交易策略代码的AI Agent。
你需要根据描述生成完整的、可直接运行的JavaScript策略代码。

要求:
- 使用标准格式: class StrategyName { analyze(klines, indicators) { return {direction, score, reasons} } }
- 代码简洁高效，不依赖外部库
- 包含完整的风险控制逻辑
- 可直接集成到现有 StrategyManager 中

只输出JavaScript代码，不要解释。`;

    const userPrompt = `策略描述: ${description}

${context.marketData ? `当前市场: ${JSON.stringify(context.marketData).slice(0, 500)}` : ''}
${context.existingStrategies ? `已有策略(参考): ${context.existingStrategies}` : ''}
${context.performance ? `近期表现: ${JSON.stringify(context.performance).slice(0, 300)}` : ''}

生成策略代码:`;

    let code = null;
    if (this.llm.getAvailableModels().length > 0) {
      code = await this.llm.ask(systemPrompt, userPrompt, null);
    }

    // 如果LLM不可用，用规则引擎生成基础策略
    if (!code) {
      code = this._generateBasicStrategy(description, context);
    }

    // 提取代码块
    const codeMatch = code && code.match(/```javascript\n?([\s\S]*?)```/);
    const finalCode = codeMatch ? codeMatch[1].trim() : (code || '');

    const record = {
      id: `strat_${Date.now()}`,
      description,
      code: finalCode,
      timestamp: Date.now(),
      context: Object.keys(context),
      status: 'generated',
    };

    this.generatedCode.push(record);
    if (this.generatedCode.length > this.maxCodeHistory) this.generatedCode.shift();
    this.memory.codeChanges.push({ type: 'generate', description, timestamp: Date.now() });

    this.log(`📝 生成策略代码: ${description.slice(0, 50)} (${finalCode.length} chars, ${Date.now() - startTime}ms)`);
    return record;
  }

  /**
   * 生成基础策略 (无LLM降级)
   */
  _generateBasicStrategy(description, context = {}) {
    return `// 自动生成策略: ${description}
// 生成时间: ${new Date().toISOString()}
class AutoStrategy {
  constructor(config = {}) {
    this.name = 'AutoStrategy_' + Date.now();
    this.params = {
      rsiBuy: 35,
      rsiSell: 65,
      maPeriod: 25,
      volThreshold: 1.5,
      ...config,
    };
  }

  analyze(klines, indicators) {
    if (!klines || klines.length < 30 || !indicators) {
      return { direction: 'WAIT', score: 0, reasons: ['数据不足'] };
    }

    let score = 0;
    const reasons = [];

    // RSI
    if (indicators.rsi < this.params.rsiBuy) { score += 0.3; reasons.push('RSI超卖'); }
    else if (indicators.rsi > this.params.rsiSell) { score -= 0.3; reasons.push('RSI超买'); }

    // MA趋势
    if (indicators.ma7 > indicators.ma25) { score += 0.2; reasons.push('MA金叉'); }
    else { score -= 0.2; reasons.push('MA死叉'); }

    // 布林带
    if (indicators.bb && indicators.bb.pctB < 0.2) { score += 0.15; reasons.push('BB下轨'); }
    else if (indicators.bb && indicators.bb.pctB > 0.8) { score -= 0.15; reasons.push('BB上轨'); }

    let direction = 'WAIT';
    if (score > 0.2) direction = 'LONG';
    else if (score < -0.2) direction = 'SHORT';

    return { direction, score: parseFloat(score.toFixed(3)), reasons };
  }
}`;
  }

  /**
   * 参数优化建议
   */
  async optimizeParams(strategyName, currentParams, performanceData) {
    const systemPrompt = `你是 MasterD 量化交易参数优化AI。
根据策略近期表现数据，建议参数调整。

输出JSON:
{
  "paramName": "建议值(数字)",
  ...
  "reasoning": "调整理由(50字以内)",
  "expectedImprovement": "预期改善(30字以内)"
}`;

    const userPrompt = `策略: ${strategyName}
当前参数: ${JSON.stringify(currentParams)}
近期表现: 胜率=${performanceData.winRate || 'N/A'} 总盈亏=${performanceData.totalPnl || 'N/A'} 交易次数=${performanceData.trades || 0}
${performanceData.recentTrades ? `最近交易: ${JSON.stringify(performanceData.recentTrades.slice(-5))}` : ''}`;

    const result = await this.llm.ask(systemPrompt, userPrompt, null, (text) => {
      try { return JSON.parse(text); } catch { return { reasoning: text.slice(0, 200) }; }
    });

    if (result) {
      this.memory.strategyAdjustments.push({
        strategyName,
        oldParams: currentParams,
        newParams: result,
        timestamp: Date.now(),
      });
      this.stats.strategyAdjustments++;
      this.log(`🔧 参数优化: ${strategyName} | ${result.reasoning || '调整'}`);
    }

    return result || { reasoning: '优化不可用' };
  }

  /**
   * 自动诊断bug
   */
  async diagnoseBug(errorInfo, codeSnippet) {
    const systemPrompt = `你是 MasterD 代码诊断AI。
分析错误信息，找出根因，给出修复方案。

输出JSON:
{
  "rootCause": "根因(30字以内)",
  "fix": "修复代码",
  "explanation": "解释(50字以内)",
  "severity": "high/medium/low"
}`;

    const userPrompt = `错误: ${errorInfo.message || errorInfo}
${errorInfo.stack ? `堆栈: ${errorInfo.stack.slice(0, 500)}` : ''}
${codeSnippet ? `代码: ${codeSnippet.slice(0, 1000)}` : ''}`;

    const result = await this.llm.ask(systemPrompt, userPrompt, null, (text) => {
      try { return JSON.parse(text); } catch { return { rootCause: text.slice(0, 100), fix: '', severity: 'medium' }; }
    });

    if (result) {
      this.memory.codeChanges.push({ type: 'bugfix', rootCause: result.rootCause, timestamp: Date.now() });
      this.stats.codeChanges++;
      this.log(`🐛 Bug诊断: ${result.rootCause} | 严重度: ${result.severity}`);
    }

    return result || { rootCause: '诊断不可用' };
  }

  // ═════════════════════════════════════════════════════════════
  //  4. 执行落地 — 直接调用引擎API执行
  // ═════════════════════════════════════════════════════════════

  /**
   * 执行交易
   */
  async execute(decision, executor) {
    this.stats.totalExecuted++;
    const log = {
      action: 'execute',
      symbol: decision.symbol,
      direction: decision.direction,
      confidence: decision.confidence,
      timestamp: Date.now(),
      status: 'pending',
    };

    try {
      if (!executor || typeof executor.executeTrade !== 'function') {
        throw new Error('no executor available');
      }

      const result = await executor.executeTrade({
        symbol: decision.symbol,
        side: decision.direction,
        leverage: decision.leverage || 1,
        positionPct: decision.positionPct || 5,
        stopLoss: decision.stopLoss,
        takeProfit: decision.takeProfit,
        reason: `MasterD-Agent: ${decision.reasoning || ''}`,
      });

      log.status = result.success ? 'success' : 'failed';
      log.result = result;
      this.log(`✅ 执行: ${decision.symbol} ${decision.direction} | ${result.success ? '成功' : '失败'}`);
    } catch (e) {
      log.status = 'error';
      log.error = e.message;
      this.log(`❌ 执行失败: ${e.message}`);
    }

    this.executionLog.push(log);
    if (this.executionLog.length > this.maxExecLog) this.executionLog.shift();
    return log;
  }

  /**
   * 执行平仓
   */
  async closePosition(symbol, reason, executor) {
    const log = { action: 'close', symbol, reason, timestamp: Date.now(), status: 'pending' };
    try {
      const result = await executor.closePosition(symbol, reason);
      log.status = 'success';
      log.result = result;
    } catch (e) {
      log.status = 'error';
      log.error = e.message;
    }
    this.executionLog.push(log);
    if (this.executionLog.length > this.maxExecLog) this.executionLog.shift();
    return log;
  }

  // ═════════════════════════════════════════════════════════════
  //  5. 自我反思与进化
  // ═════════════════════════════════════════════════════════════

  /**
   * 记录交易结果 → 学习进化
   */
  recordTrade(symbol, pnlPct, isWin, context = {}) {
    const trade = {
      symbol,
      pnlPct,
      isWin,
      timestamp: Date.now(),
      ...context,
    };

    this.memory.trades.push(trade);
    if (this.memory.trades.length > this.memory.maxTrades) this.memory.trades.shift();

    // 更新模型准确率
    if (context.modelDecision) {
      for (const [model, decision] of Object.entries(context.modelDecision)) {
        if (!this.modelAccuracy[model]) this.modelAccuracy[model] = { correct: 0, total: 0 };
        this.modelAccuracy[model].total++;
        if ((decision === 'LONG' && isWin && pnlPct > 0) || (decision === 'SHORT' && isWin && pnlPct > 0)) {
          this.modelAccuracy[model].correct++;
        }
      }
    }

    // 每N次交易自我反思
    if (this.memory.trades.length % this.adaptiveParams.selfReflectionInterval === 0) {
      this._selfReflect();
    }

    // 每50次交易更新模型权重
    if (this.memory.trades.length % 50 === 0) {
      this._updateModelWeights();
    }
  }

  /**
   * 自我反思
   */
  _selfReflect() {
    this.stats.selfReflections++;
    const recent = this.memory.trades.slice(-this.adaptiveParams.selfReflectionInterval);
    const wins = recent.filter(t => t.isWin).length;
    const losses = recent.length - wins;
    const winRate = wins / recent.length;
    const avgPnl = recent.reduce((s, t) => s + (t.pnlPct || 0), 0) / recent.length;

    const lessons = [];

    if (winRate < 0.4) {
      lessons.push(`胜率低(${(winRate * 100).toFixed(0)}%)，需要提高信号门槛或加强过滤`);
      this.adaptiveParams.confidenceThreshold = Math.min(0.6, this.adaptiveParams.confidenceThreshold + 0.05);
    } else if (winRate > 0.7) {
      lessons.push(`胜率高(${(winRate * 100).toFixed(0)}%)，可以适当降低门槛或增加仓位`);
      this.adaptiveParams.confidenceThreshold = Math.max(0.15, this.adaptiveParams.confidenceThreshold - 0.03);
    }

    if (avgPnl < 0) {
      lessons.push(`近期平均亏损${avgPnl.toFixed(2)}%，建议加强止损或减少高杠杆交易`);
      this.adaptiveParams.maxLeverage = Math.max(1, this.adaptiveParams.maxLeverage - 1);
    } else if (avgPnl > 2) {
      lessons.push(`近期平均盈利${avgPnl.toFixed(2)}%，当前策略表现良好`);
    }

    // 连亏分析
    let maxConsecLoss = 0, currLoss = 0;
    for (const t of recent) {
      if (!t.isWin) { currLoss++; maxConsecLoss = Math.max(maxConsecLoss, currLoss); }
      else currLoss = 0;
    }
    if (maxConsecLoss >= 3) {
      lessons.push(`出现${maxConsecLoss}连亏，建议暂停或大幅降仓`);
      this.adaptiveParams.riskTolerance = 'conservative';
    } else if (maxConsecLoss <= 1 && winRate > 0.5) {
      this.adaptiveParams.riskTolerance = 'moderate';
    }

    // 找出亏损品种
    const bySymbol = {};
    for (const t of recent) {
      if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { wins: 0, losses: 0, pnl: 0 };
      if (t.isWin) bySymbol[t.symbol].wins++; else bySymbol[t.symbol].losses++;
      bySymbol[t.symbol].pnl += t.pnlPct || 0;
    }
    const badSymbols = Object.entries(bySymbol).filter(([_, s]) => s.losses > s.wins && s.pnl < 0);
    if (badSymbols.length > 0) {
      lessons.push(`表现差的品种: ${badSymbols.map(([s]) => s).join(', ')}`);
    }

    this.memory.lessons.push({
      timestamp: Date.now(),
      winRate: parseFloat(winRate.toFixed(3)),
      avgPnl: parseFloat(avgPnl.toFixed(3)),
      maxConsecLoss,
      lessons,
    });
    if (this.memory.lessons.length > this.memory.maxLessons) this.memory.lessons.shift();

    this.log(`\u{1F914} \u81ea\u6211\u53cd\u601d: \u80dc\u7387=${(winRate * 100).toFixed(0)}% \u5e73\u5747=${avgPnl.toFixed(2)}% | ${lessons.join('; ')}`);

    // v113.11: \u81ea\u6211\u8fdb\u5316\u95ed\u73af \u2014 \u53cd\u601d\u7ed3\u8bba\u81ea\u52a8\u8c03\u53c2
    try {
      const paramResult = this.adaptiveParams2.applyReflection({ winRate, avgPnl, maxConsecLoss, lessons });
      if (paramResult.changed) {
        this.stats.strategyAdjustments += paramResult.changes.length;
        this.log(`\u{1F527} \u81ea\u9002\u5e94\u8c03\u53c2: ${paramResult.changes.join(', ')}`);
        // \u5e94\u7528\u65b0\u53c2\u6570\u5230\u5f15\u64ce
        this._applyAdaptiveParams();
      }
    } catch (e) {
      this.log(`\u53c2\u6570\u81ea\u9002\u5e94\u5931\u8d25: ${e.message}`);
    }
  }

  // ═════════════════════════════════════════════════════════════
  //  v113.11: 自我进化闭环 — 核心方法
  // ═════════════════════════════════════════════════════════════

  /**
   * 自我进化主循环 — 每分钟执行
   * 1. 运行AutoFixer检测问题
   * 2. 评估热加载策略表现
   * 3. 根据反思课程决定是否生成新策略
   */
  async _runEvolution() {
    try {
      // 1. AutoFixer检测
      await this.autoFixer.runCheck();

      // 2. 评估热加载策略表现
      for (const [name, info] of this.hotLoader.loadedStrategies) {
        // 每笔交易后由recordTrade更新表现
        if (info.performance.trades >= 10) {
          const winRate = info.performance.wins / info.performance.trades;
          if (winRate < 0.3 && info.performance.pnl < 0) {
            this.log(`\u26a0\ufe0f \u7b56\u7575 "${name}" \u8868\u73b0\u5dee \u2014 \u81ea\u52a8\u5378\u8f7d`);
            this.hotLoader.unloadStrategy(name);
          }
        }
      }

      // 3. 每5次反思生成一次新策略尝试
      if (this.stats.selfReflections > 0 && this.stats.selfReflections % 5 === 0) {
        await this._tryGenerateNewStrategy();
      }
    } catch (e) {
      // 静默 \u2014 \u4e0d\u80fd\u5f71\u54cd\u4e3b\u5f15\u64ce
    }
  }

  /**
   * 尝试生成新策略 — 回测验证后热加载
   */
  async _tryGenerateNewStrategy() {
    if (!this.llm || this.llm.getAvailableModels().length === 0) return;
    if (this.hotLoader.loadedStrategies.size >= this.hotLoader.maxStrategies) return;

    const recentLessons = this.memory.lessons.slice(-5);
    const lessonSummary = recentLessons.map(l => l.lessons.join('; ')).join('\n');

    try {
      this.log(`\u{1F9EC} \u5c1d\u8bd5\u751f\u6210\u65b0\u7b56\u7575...`);
      const record = await this.generateStrategy(
        `基于反思课程自动生成: ${lessonSummary}`,
        { performance: { winRate: recentLessons[0]?.winRate, avgPnl: recentLessons[0]?.avgPnl } }
      );

      if (record && record.code && record.code.length > 50) {
        // \u56de\u6d4b\u9a8c\u8bc1
        const klines = this._getRecentKlines();
        if (klines && klines.length > 50) {
          const validation = await this.backtestValidator.validate(`evolution_${Date.now()}`, record.code, klines);
          if (validation.pass) {
            const loadResult = await this.hotLoader.loadStrategy(`evolution_${Date.now()}`, record.code, { weight: 0.15 });
            if (loadResult.success) {
              this.log(`\u2705 \u81ea\u8fdb\u5316: \u65b0\u7b56\u7575\u751f\u6210+\u56de\u6d4b\u901a\u8fc7+\u70ed\u52a0\u8f7d`);
              this.stats.codeChanges++;
            }
          } else {
            this.log(`\u274c \u81ea\u8fdb\u5316: \u65b0\u7b56\u7575\u56de\u6d4b\u4e0d\u901a\u8fc7 \u2014 \u4e0d\u52a0\u8f7d`);
          }
        }
      }
    } catch (e) {
      // \u9759\u9ed8
    }
  }

  /**
   * 应用自适应参数到引擎
   */
  _applyAdaptiveParams() {
    const params = this.adaptiveParams2.getParams();

    // \u66f4\u65b0\u81ea\u5df1\u7684 adaptiveParams
    this.adaptiveParams.confidenceThreshold = params.confidenceThreshold;
    this.adaptiveParams.maxLeverage = params.maxLeverage;

    // \u66f4\u65b0\u5f15\u64ce\u7684\u6b62\u635f/\u6b62\u764c/\u51b7\u5374\u53c2\u6570
    if (this.config.engine) {
      const engine = this.config.engine;
      if (engine.stopLossPct !== undefined) engine.stopLossPct = params.stopLossPct;
      if (engine.takeProfitPct !== undefined) engine.takeProfitPct = params.takeProfitPct;
      if (engine._cooldownMs !== undefined) {
        engine._cooldownMs = params.cooldownMinutes * 60 * 1000;
      }
      if (engine._lossCooldownMs !== undefined) {
        engine._lossCooldownMs = params.lossCooldownMinutes * 60 * 1000;
      }
    }

    this.log(`\u{1F527} \u5f15\u64ce\u53c2\u6570\u5df2\u66f4\u65b0: \u6b62\u635f=${params.stopLossPct}% \u6b62\u764c=${params.takeProfitPct}% \u51b7\u5374=${params.cooldownMinutes}min`);
  }

  /**
   * 获取最近K线数据(用于回测)
   */
  _getRecentKlines() {
    if (this.config.engine && this.config.engine.klines) {
      // \u4f18\u5148BTC\u7684K\u7ebf
      return this.config.engine.klines['BTCUSDT'] ||
             Object.values(this.config.engine.klines)[0] || null;
    }
    return null;
  }

  /**
   * 更新模型权重 — 根据准确率
   */
  _updateModelWeights() {
    const perf = {};
    for (const [model, acc] of Object.entries(this.modelAccuracy)) {
      if (acc.total >= 5) {
        perf[model] = { correctRate: acc.correct / acc.total };
      }
    }
    if (Object.keys(perf).length >= 2) {
      this.llm.updateWeights(perf);
      this.log(`📊 模型权重已根据${Object.keys(perf).length}个模型表现更新`);
    }
  }

  // ═════════════════════════════════════════════════════════════
  //  6. 状态与接口
  // ═════════════════════════════════════════════════════════════

  /**
   * 获取Agent状态
   */
  getStatus() {
    const recentTrades = this.memory.trades.slice(-20);
    const wins = recentTrades.filter(t => t.isWin).length;
    const recentWinRate = recentTrades.length > 0 ? wins / recentTrades.length : 0;
    const recentAvgPnl = recentTrades.length > 0 ? recentTrades.reduce((s, t) => s + (t.pnlPct || 0), 0) / recentTrades.length : 0;

    return {
      version: this.version,
      name: this.name,
      status: 'online',
      uptime: process.uptime ? process.uptime() : 0,

      // 决策统计
      stats: { ...this.stats },

      // 自适应参数
      adaptiveParams: { ...this.adaptiveParams },

      // 近期表现
      performance: {
        recentTrades: recentTrades.length,
        recentWinRate: parseFloat(recentWinRate.toFixed(3)),
        recentAvgPnl: parseFloat(recentAvgPnl.toFixed(3)),
        totalMemory: this.memory.trades.length,
        lessons: this.memory.lessons.length,
      },

      // 模型状态
      llm: {
        ...this.llm.getStats(),
        modelAccuracy: Object.fromEntries(
          Object.entries(this.modelAccuracy).map(([k, v]) => [k, v.total > 0 ? (v.correct / v.total).toFixed(2) : 'N/A'])
        ),
      },

      // 新闻中心状态
      news: this.news.getStats(),

      // 最近反思
      lastReflection: this.memory.lessons[this.memory.lessons.length - 1] || null,

      // 最近推理链
      lastReasoning: this.reasoningChains[this.reasoningChains.length - 1] || null,

      // 最近执行
      recentExecutions: this.executionLog.slice(-10),

      // 最近代码生成
      recentCodeGen: this.generatedCode.slice(-5).map(c => ({ id: c.id, description: c.description, timestamp: c.timestamp, status: c.status })),

      // 最近策略调整
      recentAdjustments: this.memory.strategyAdjustments.slice(-5),

      // 最近bug修复
      recentBugfixes: this.memory.codeChanges.filter(c => c.type === 'bugfix').slice(-5),

      // 最近课程
      recentLessons: this.memory.lessons.slice(-3),
    };
  }

  /**
   * 获取推理链历史
   */
  getReasoningHistory(limit = 10) {
    return this.reasoningChains.slice(-limit);
  }

  /**
   * 获取执行日志
   */
  getExecutionLog(limit = 20) {
    return this.executionLog.slice(-limit);
  }

  /**
   * 获取新闻概览
   */
  async getNewsOverview() {
    return await this.news.getNewsOverview();
  }

  /**
   * 获取学习课程
   */
  getLessons(limit = 10) {
    return this.memory.lessons.slice(-limit);
  }

  /**
   * 保存状态
   */
  saveState() {
    try {
      const fs = require('fs');
      const path = require('path');
      const statePath = path.join(__dirname, '..', 'data', 'masterd-agent-state.json');
      const state = {
        memory: this.memory,
        adaptiveParams: this.adaptiveParams,
        modelAccuracy: this.modelAccuracy,
        stats: this.stats,
      };
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    } catch (e) { /* 静默 */ }
  }

  /**
   * 加载状态
   */
  loadState() {
    try {
      const fs = require('fs');
      const path = require('path');
      const statePath = path.join(__dirname, '..', 'data', 'masterd-agent-state.json');
      if (fs.existsSync(statePath)) {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (state.memory) this.memory = { ...this.memory, ...state.memory };
        if (state.adaptiveParams) this.adaptiveParams = { ...this.adaptiveParams, ...state.adaptiveParams };
        if (state.modelAccuracy) this.modelAccuracy = { ...this.modelAccuracy, ...state.modelAccuracy };
        if (state.stats) this.stats = { ...this.stats, ...state.stats };
        this.log(`📂 状态已加载: ${this.memory.trades.length}条交易记忆, ${this.memory.lessons.length}条课程`);
      }
    } catch (e) { /* 静默 */ }
  }
}

module.exports = MasterDAgent;
