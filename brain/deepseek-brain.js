/**
 * DeepSeek Brain v2 — DeepSeek 大模型核心决策引擎
 * 
 * 角色：AI 量化交易的「大脑」，综合所有数据源做出最终决策
 * 
 * 能力：
 * 1. 多维度推理：技术面 + 链上数据 + 资金费率 + 情绪 + 持仓状态
 * 2. 自我反思：从历史交易中学习，调整策略参数
 * 3. 自适应：根据市场状态（趋势/震荡/极端）切换策略风格
 * 4. 风控推理：不机械止损，而是理解市场上下文后决策
 * 5. 进化学习：每次交易结果反馈回模型，持续提升
 */

const https = require('https');

class DeepSeekBrain {
  constructor(config = {}) {
    this.apiKey = config.apiKey || process.env.DEEPSEEK_API_KEY;
    this.model = config.model || 'deepseek-chat';
    this.baseURL = 'api.deepseek.com';
    this.maxRetries = 2;
    this.timeout = 30000;  // 30秒超时（推理需要更多时间）

    // 交易历史（用于自我反思和进化）
    this.tradeHistory = [];
    this.maxHistory = 100;
    
    // 策略进化参数（v8 激进优化版）
    this.strategyParams = {
      riskTolerance: 'moderate',  // conservative / moderate / aggressive
      maxLeverage: 12,
      positionSizePct: 12,
      stopLossMultiplier: 2.0,
      takeProfitMultiplier: 4.0,
    };

    // 缓存
    this.lastCallTime = {};
    this.cacheMs = 30000;  // 30秒缓存（决策要更实时）

    // 性能追踪
    this.performanceStats = {
      totalDecisions: 0,
      deepseekDecisions: 0,
      fallbackDecisions: 0,
      avgResponseMs: 0,
      errors: 0,
    };

    this.log = (msg) => console.log(`[DeepSeek-Brain] ${new Date().toISOString()} ${msg}`);
    
    if (this.apiKey) {
      this.log(`✅ 已接入 DeepSeek (${this.model})，API Key: ${this.apiKey.slice(0, 8)}...`);
    } else {
      this.log('⚠️ 未设置 DEEPSEEK_API_KEY，将使用规则引擎降级');
    }
  }

  /**
   * 核心决策入口 — 被 ai-engine.js 的 makeDecision 调用
   * 返回标准格式决策，与规则引擎输出兼容
   */
  async analyzeMarket(snapshot, ruleSignal, currentPosition, accountBalance, recentDecisions = []) {
    const symbol = snapshot.symbol;
    const startTime = Date.now();
    this.performanceStats.totalDecisions++;

    // 无 API Key → 降级
    if (!this.apiKey) {
      this.performanceStats.fallbackDecisions++;
      return this._fallbackAnalysis(snapshot, ruleSignal);
    }

    // 缓存检查
    if (this.lastCallTime[symbol] && Date.now() - this.lastCallTime[symbol] < this.cacheMs) {
      return this._fallbackAnalysis(snapshot, ruleSignal);
    }

    try {
      const prompt = this._buildMasterPrompt(snapshot, ruleSignal, currentPosition, accountBalance, recentDecisions);
      const response = await this._callDeepSeek(prompt);
      const parsed = this._parseResponse(response);
      
      this.lastCallTime[symbol] = Date.now();
      this.performanceStats.deepseekDecisions++;
      
      const elapsed = Date.now() - startTime;
      this.performanceStats.avgResponseMs = 
        (this.performanceStats.avgResponseMs * 0.9) + (elapsed * 0.1);

      this.log(`🧠 ${symbol} 决策: ${parsed.direction} | score=${parsed.score.toFixed(2)} | conf=${parsed.confidence.toFixed(2)} | ${elapsed}ms`);
      this.log(`   理由: ${parsed.reasoning}`);
      if (parsed.riskNote) this.log(`   ⚠️ ${parsed.riskNote}`);

      return parsed;
    } catch (err) {
      this.performanceStats.errors++;
      this.log(`❌ ${symbol} API 失败: ${err.message}，降级到规则引擎`);
      this.performanceStats.fallbackDecisions++;
      return this._fallbackAnalysis(snapshot, ruleSignal);
    }
  }

  /**
   * 持仓管理决策 — 专门处理已有仓位的止损/止盈/持有判断
   * 这是 DeepSeek 的核心优势：理解上下文后做复杂判断
   */
  async analyzePosition(position, currentPrice, marketSnapshot, tradeHistory) {
    if (!this.apiKey) return null;

    const symbol = position.symbol;
    const isLong = position.side === 'LONG';
    const entryPrice = position.entryPrice;
    const rawPnlPct = isLong
      ? ((currentPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - currentPrice) / entryPrice) * 100;
    const leverage = position.leverage || 3;
    const pnlPct = rawPnlPct * leverage;
    const holdMinutes = position.openTime ? (Date.now() - position.openTime) / 60000 : 0;

    // 构建持仓管理 prompt
    const ind = marketSnapshot?.indicators || {};
    const ticker = marketSnapshot?.ticker || {};

    const prompt = `你是一个加密货币量化交易AI，正在管理一个持仓。请决定是平仓还是继续持有。

## 当前持仓
- 交易对: ${symbol}
- 方向: ${position.side}
- 入场价: $${entryPrice}
- 当前价: $${currentPrice}
- 杠杆: ${leverage}x
- 未实现盈亏: ${pnlPct.toFixed(2)}%（杠杆后）
- 持仓时间: ${holdMinutes.toFixed(0)} 分钟

## 技术指标
- RSI(14): ${ind.rsi?.toFixed(1) || 'N/A'}
- MA7: ${ind.ma7?.toFixed(4) || 'N/A'} (方向: ${ind.ma7Direction || 'N/A'})
- 价格vs MA7: ${ind.priceVsMa7 || 'N/A'}
- BB位置: ${ind.bb ? `$${ind.bb.lower?.toFixed(4)}-$$${ind.bb.upper?.toFixed(4)}` : 'N/A'}
- 成交量: ${ind.volume?.ratio?.toFixed(2) || 'N/A'}x vs均量
- 24h涨跌: ${ticker.changePercent?.toFixed(2) || 'N/A'}%

## 决策选项
1. **HOLD** - 继续持有（趋势未变，有继续盈利空间）
2. **CLOSE** - 平仓（趋势反转、达到止盈/止损条件、或风险过大）

请基于以上数据，输出 JSON 决策（不要 markdown 标记）。

⚠️ 关键规则：
1. 如果 RSI < 35（超卖区）且持有空头，考虑平仓（超卖反弹概率高）
2. 如果 RSI > 65（超买区）且持有多头，考虑平仓（超买回调概率高）
3. 如果亏损 < 2% 且趋势未反转，优先 HOLD（不要过早止损）
4. 如果趋势方向与持仓一致，优先 HOLD

输出格式：
{
  "action": "HOLD 或 CLOSE",
  "reason": "决策理由（30字以内）",
  "confidence": 0到1的信心值
}`;

    try {
      const response = await this._callDeepSeek(prompt);
      let cleaned = response.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      const parsed = JSON.parse(cleaned);
      
      this.log(`📊 ${symbol} 持仓管理: ${parsed.action} | ${parsed.reason} | conf=${parsed.confidence?.toFixed(2)}`);
      return parsed;
    } catch (err) {
      this.log(`⚠️ ${symbol} 持仓管理 API 失败: ${err.message}`);
      return null;
    }
  }

  /**
   * 自我反思 — 从历史交易中学习，调整策略
   */
  async selfReflect() {
    if (!this.apiKey || this.tradeHistory.length < 5) return;

    const recentTrades = this.tradeHistory.slice(-20);
    const wins = recentTrades.filter(t => t.pnl > 0);
    const losses = recentTrades.filter(t => t.pnl < 0);
    const winRate = wins.length / recentTrades.length;
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + Math.abs(t.pnl), 0) / losses.length : 0;

    const prompt = `你是一个加密货币量化交易AI，正在回顾自己的交易表现。请分析并给出策略调整建议。

## 最近 ${recentTrades.length} 笔交易统计
- 胜率: ${(winRate * 100).toFixed(1)}%
- 平均盈利: $${avgWin.toFixed(2)}
- 平均亏损: $${avgLoss.toFixed(2)}
- 盈亏比: ${avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : 'N/A'}
- 总盈亏: $${recentTrades.reduce((s, t) => s + t.pnl, 0).toFixed(2)}

## 交易明细
${recentTrades.map(t => `${t.symbol} ${t.action} PnL=$${t.pnl?.toFixed(2)} | ${t.reasoning?.slice(0, 50) || ''}`).join('\n')}

## 当前策略参数
- 风险偏好: ${this.strategyParams.riskTolerance}
- 最大杠杆: ${this.strategyParams.maxLeverage}x
- 仓位比例: ${this.strategyParams.positionSizePct}%
- 止损倍数: ${this.strategyParams.stopLossMultiplier}x ATR
- 止盈倍数: ${this.strategyParams.takeProfitMultiplier}x ATR

请输出 JSON 策略调整建议（不要 markdown 标记）：
{
  "riskTolerance": "conservative/moderate/aggressive",
  "maxLeverage": 1-10的整数,
  "positionSizePct": 5-20的整数,
  "stopLossMultiplier": 1.0-3.0的浮点数,
  "takeProfitMultiplier": 1.5-5.0的浮点数,
  "analysis": "分析（50字以内）",
  "keyInsight": "关键发现（30字以内）"
}`;

    try {
      const response = await this._callDeepSeek(prompt);
      let cleaned = response.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      const parsed = JSON.parse(cleaned);

      // 更新策略参数
      if (parsed.riskTolerance) this.strategyParams.riskTolerance = parsed.riskTolerance;
      if (parsed.maxLeverage) this.strategyParams.maxLeverage = Math.max(1, Math.min(12, parsed.maxLeverage));
      if (parsed.positionSizePct) this.strategyParams.positionSizePct = Math.max(5, Math.min(20, parsed.positionSizePct));
      if (parsed.stopLossMultiplier) this.strategyParams.stopLossMultiplier = Math.max(1, Math.min(3, parsed.stopLossMultiplier));
      if (parsed.takeProfitMultiplier) this.strategyParams.takeProfitMultiplier = Math.max(1.5, Math.min(6, parsed.takeProfitMultiplier));

      this.log(`🧬 自我反思完成: ${parsed.analysis}`);
      this.log(`   关键发现: ${parsed.keyInsight}`);
      this.log(`   新参数: risk=${this.strategyParams.riskTolerance}, lev=${this.strategyParams.maxLeverage}x, pos=${this.strategyParams.positionSizePct}%`);

      return parsed;
    } catch (err) {
      this.log(`❌ 自我反思失败: ${err.message}`);
      return null;
    }
  }

  /**
   * 构建核心决策 Prompt（全量数据 + 交易历史 + 策略状态）
   */
  _buildMasterPrompt(snapshot, ruleSignal, currentPosition, accountBalance, recentDecisions) {
    const ind = snapshot.indicators;
    const ticker = snapshot.ticker;
    const funding = snapshot.fundingRate;
    const sentiment = snapshot.sentiment;
    const longShort = snapshot.longShortRatio;

    // 最近交易历史
    let historyText = '无';
    if (recentDecisions.length > 0) {
      historyText = recentDecisions.slice(-8).map(d => 
        `${d.symbol} ${d.action} PnL=${d.pnl || 0} | ${d.reasoning?.slice(0, 60) || ''}`
      ).join('\n');
    }

    // 市场状态判断
    let marketRegime = '未知';
    if (ind) {
      if (ind.range?.isRanging) marketRegime = '震荡';
      else if (ind.ma7Direction === 'up' && ind.priceVsMa7 === 'above') marketRegime = '上升趋势';
      else if (ind.ma7Direction === 'down' && ind.priceVsMa7 === 'below') marketRegime = '下降趋势';
      else marketRegime = '过渡期';
    }

    const prompt = `你是一个顶级加密货币量化交易AI。请基于多维数据做出精确的交易决策。

## 交易对: ${snapshot.symbol}
## 当前市场状态: ${marketRegime}

### 价格数据
- 当前价: $${ticker?.price}
- 24h涨跌: ${ticker?.changePercent?.toFixed(2)}%
- 24h量: $${(ticker?.volume || 0).toLocaleString()}

### 技术指标
- RSI(14): ${ind?.rsi?.toFixed(1)} ${ind?.rsi < 30 ? '(超卖)' : ind?.rsi > 70 ? '(超买)' : ''}
- MA7: $${ind?.ma7?.toFixed(4)} | 方向: ${ind?.ma7Direction} | 价格${ind?.priceVsMa7}MA7
- 金叉/死叉: 金叉=${ind?.ma7CrossAbove || false} 死叉=${ind?.ma7CrossBelow || false}
- BB: $${ind?.bb?.lower?.toFixed(4)} - $${ind?.bb?.middle?.toFixed(4)} - $${ind?.bb?.upper?.toFixed(4)}
- ATR%: ${ind?.atrPercent?.toFixed(2)}%
- 成交量: ${ind?.volume?.ratio?.toFixed(2)}x vs 20期均量 ${ind?.volume?.ratio > 1.5 ? '(放量)' : ind?.volume?.ratio < 0.5 ? '(缩量)' : ''}
- K线: ${ind?.candle?.pattern || '无明显'} ${ind?.candle?.isBullish ? '(阳线)' : '(阴线)'}

### 资金面
- 资金费率: ${funding != null ? (funding * 100).toFixed(4) + '%' : 'N/A'} ${funding > 0.001 ? '(多头付费偏高)' : funding < -0.001 ? '(空头付费偏高)' : ''}
- 多空比: 多${longShort ? (longShort.longRatio * 100).toFixed(1) : '?'}% / 空${longShort ? (longShort.shortRatio * 100).toFixed(1) : '?'}%

### 情绪
- Fear & Greed: ${sentiment?.value || 'N/A'} (${sentiment?.label || '未知'})

### 规则引擎初步信号
- 方向: ${ruleSignal.action} | 强度: ${ruleSignal.strength?.toFixed(2)} | 原因: ${ruleSignal.reasons?.join(', ')}

### 账户
- 余额: $${accountBalance?.toFixed(2)}
- 持仓: ${currentPosition ? `${currentPosition.side} ${currentPosition.symbol} 入场$${currentPosition.entryPrice} PnL=${currentPosition.pnl?.toFixed(2)}` : '无'}

### 最近交易历史
${historyText}

### 策略参数
- 风险偏好: ${this.strategyParams.riskTolerance}
- 最大杠杆: ${this.strategyParams.maxLeverage}x

## 关键规则（必须严格遵守！）
1. RSI < 35（超卖区）→ 禁止做空！超卖意味着短期反弹概率高，做空必亏
2. RSI > 65（超买区）→ 禁止做多！超买意味着短期回调概率高
3. 如果理由中包含"等待""无明确信号""信号不足"，direction 必须填 "WAIT"，不能填 LONG/SHORT
4. 只有 RSI 35-65 中性区间 + 趋势确认 + 放量确认时才开仓
5. 杠杆至少 2x（1x 杠杆仓位太小，止损线太近，日常波动就触发止损）

## 请输出 JSON 决策（不要 markdown 代码块标记）:
{
  "score": <-1到1，正=做多 负=做空>,
  "direction": "LONG" | "SHORT" | "WAIT",
  "confidence": <0到1>,
  "reasoning": "<50字中文决策理由，不含犹豫词>",
  "riskNote": "<风险提示，30字以内>",
  "suggestedLeverage": <2-${this.strategyParams.maxLeverage}整数，至少2>,
  "positionPercent": <5-15整数>,
  "marketRegime": "${marketRegime}",
  "_rsiValue": <当前RSI数值>
}`;

    return prompt;
  }

  /**
   * 调用 DeepSeek API
   */
  _callDeepSeek(prompt) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: `你是一个严谨的加密货币量化交易AI。你只输出JSON决策，不输出任何其他内容。

你的核心原则：
1. 数据驱动，不做无依据的猜测
2. 风控优先：宁可错过机会，也不冒险开仓
3. 趋势跟随：顺势交易，不抄底不摸顶
4. 自我进化：从每笔交易中学习
5. 极度保守：只有多维度数据同时确认时才行动

当前策略偏好：${this.strategyParams.riskTolerance}`
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.15,
        max_tokens: 800,
        response_format: { type: 'json_object' }
      });

      const options = {
        hostname: this.baseURL,
        path: '/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'application/json'
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) {
              reject(new Error(json.error.message || JSON.stringify(json.error)));
              return;
            }
            const content = json.choices?.[0]?.message?.content;
            if (!content) {
              reject(new Error('Empty response'));
              return;
            }
            resolve(content);
          } catch (e) {
            reject(new Error(`Parse error: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(this.timeout, () => {
        req.destroy();
        reject(new Error('Request timeout (30s)'));
      });
      req.write(body);
      req.end();
    });
  }

  /**
   * 解析 DeepSeek 返回
   */
  _parseResponse(raw) {
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    
    const parsed = JSON.parse(cleaned);
    
    // 校验
    const score = Math.max(-1, Math.min(1, Number(parsed.score) || 0));
    let direction = (parsed.direction || 'WAIT').toUpperCase();
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    
    // 安全阀
    if (confidence < 0.35 && direction !== 'WAIT') {
      direction = 'WAIT';
    }

    // ⚠️ 关键修复：如果理由中包含"等待""无明确信号""保守"等犹豫词，强制 WAIT
    const hesitations = ['等待', '无明确信号', '不确定', '观望', '无信号', '不宜', '信号不足', '保守观望', '暂不'];
    const hasHesitation = hesitations.some(h => (parsed.reasoning || '').includes(h));
    if (hasHesitation && direction !== 'WAIT') {
      this.log(`⚠️ DeepSeek 理由含犹豫词但direction=${direction}，强制修正为WAIT`);
      direction = 'WAIT';
      confidence = Math.min(confidence, 0.2);
    }

    // ⚠️ 关键修复2：RSI超卖禁止做空，RSI超买禁止做多
    // DeepSeek 经常给 "RSI超卖但趋势向下" → SHORT，这是逆指标，必亏
    // RSI < 30 = 超卖 = 短期反弹概率大，做空风险极高
    // RSI > 70 = 超买 = 短期回调概率大，做多风险极高
    if (parsed._rsiValue !== undefined) {
      if (direction === 'SHORT' && parsed._rsiValue < 35) {
        this.log(`⚠️ RSI=${parsed._rsiValue} 超卖区禁止做空，修正为WAIT`);
        direction = 'WAIT';
      }
      if (direction === 'LONG' && parsed._rsiValue > 65) {
        this.log(`⚠️ RSI=${parsed._rsiValue} 超买区禁止做多，修正为WAIT`);
        direction = 'WAIT';
      }
    }

    const leverage = Math.max(2, Math.min(this.strategyParams.maxLeverage, Number(parsed.suggestedLeverage) || 3));
    const positionPercent = Math.max(5, Math.min(15, Number(parsed.positionPercent) || this.strategyParams.positionSizePct));

    return {
      score,
      direction,
      confidence,
      reasoning: String(parsed.reasoning || 'DeepSeek 分析').slice(0, 100),
      riskNote: String(parsed.riskNote || '').slice(0, 50),
      suggestedLeverage: leverage,
      positionPercent,
      marketRegime: parsed.marketRegime || '未知',
      source: 'deepseek',
      raw: cleaned
    };
  }

  /**
   * 降级规则引擎（无 API Key 时使用）
   */
  _fallbackAnalysis(snapshot, ruleSignal) {
    const ind = snapshot.indicators;
    if (!ind) return { score: 0, direction: 'WAIT', confidence: 0, reasoning: '数据不足', source: 'fallback' };

    let score = 0;
    const reasons = [];

    if (ind.rsi < 30) { score += 0.25; reasons.push(`RSI超卖(${ind.rsi.toFixed(0)})`); }
    else if (ind.rsi > 70) { score -= 0.25; reasons.push(`RSI超买(${ind.rsi.toFixed(0)})`); }
    
    if (ind.ma7Direction === 'up' && ind.priceVsMa7 === 'above') { score += 0.2; reasons.push('MA7上行趋势'); }
    else if (ind.ma7Direction === 'down' && ind.priceVsMa7 === 'below') { score -= 0.2; reasons.push('MA7下行趋势'); }
    
    if (ind.ma7CrossAbove) { score += 0.25; reasons.push('金叉'); }
    if (ind.ma7CrossBelow) { score -= 0.25; reasons.push('死叉'); }
    
    if (ind.price <= ind.bb?.lower) { score += 0.15; reasons.push('触BB下轨'); }
    else if (ind.price >= ind.bb?.upper) { score -= 0.15; reasons.push('触BB上轨'); }

    const funding = snapshot.fundingRate;
    if (funding > 0.001) { score -= 0.1; }
    else if (funding < -0.001) { score += 0.1; }

    const direction = score > 0.3 ? 'LONG' : score < -0.3 ? 'SHORT' : 'WAIT';
    const confidence = Math.min(1, Math.abs(score) * 0.8 + (ind.volume?.ratio > 1 ? 0.1 : 0));

    return {
      score,
      direction,
      confidence,
      reasoning: reasons.join(', ') || '规则引擎降级',
      riskNote: '',
      suggestedLeverage: 3,
      positionPercent: 8,
      source: 'fallback'
    };
  }

  /**
   * 记录交易
   */
  recordTrade(trade) {
    this.tradeHistory.push({ ...trade, timestamp: Date.now() });
    if (this.tradeHistory.length > this.maxHistory) this.tradeHistory.shift();
  }

  /**
   * 自我反思 — 从最近交易中学习
   */
  async selfReflect({ recentDecisions, currentPerformance }) {
    if (!this.apiKey) return null;

    const historyText = recentDecisions.map(d =>
      `${d.symbol} ${d.direction} PnL=${d.pnl} ${d.outcome} — ${d.reasoning}`
    ).join('\n');

    const prompt = `你是一个量化交易AI的自我反思模块。回顾最近交易，找出问题和改进方向。

## 最近交易
${historyText}

## 当前绩效
- 胜率: ${currentPerformance.winRate}%
- 总盈亏: $${currentPerformance.totalPnl}
- 平均持仓: ${currentPerformance.avgHoldMin || 'N/A'} 分钟

## 当前策略参数
${JSON.stringify(this.strategyParams, null, 2)}

请分析并输出JSON（不要markdown代码块标记）：
{
  "insights": ["发现1", "发现2", "发现3"],
  "strengths": ["优势1", "优势2"],
  "weaknesses": ["劣势1", "劣势2"],
  "adjustments": {
    "riskTolerance": "conservative/moderate/aggressive",
    "positionSizePct": <5-15整数>,
    "stopLossMultiplier": <1.0-3.0浮点>,
    "takeProfitMultiplier": <1.5-5.0浮点>
  },
  "summary": "50字以内的核心发现"}`;

    try {
      const response = await this._callDeepSeek(prompt);
      const parsed = JSON.parse(response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
      
      // 应用调整
      if (parsed.adjustments) {
        if (parsed.adjustments.riskTolerance) this.strategyParams.riskTolerance = parsed.adjustments.riskTolerance;
        if (parsed.adjustments.positionSizePct) this.strategyParams.positionSizePct = Math.max(5, Math.min(15, parsed.adjustments.positionSizePct));
        if (parsed.adjustments.stopLossMultiplier) this.strategyParams.stopLossMultiplier = Math.max(1, Math.min(3, parsed.adjustments.stopLossMultiplier));
        if (parsed.adjustments.takeProfitMultiplier) this.strategyParams.takeProfitMultiplier = Math.max(1.5, Math.min(5, parsed.adjustments.takeProfitMultiplier));
      }

      this.log('📝 自我反思完成: ' + parsed.summary);
      return parsed;
    } catch(e) {
      this.log('❌ 自我反思失败: ' + e.message);
      return null;
    }
  }

  /**
   * 策略进化 — 动态调整策略参数
   */
  async evolveStrategy({ currentParams, performance, marketRegime }) {
    if (!this.apiKey) return null;

    const prompt = `你是一个量化交易AI的策略进化模块。根据绩效和市场状态，优化策略参数。

## 当前参数
${JSON.stringify(currentParams, null, 2)}

## 绩效
- 胜率: ${performance.winRate}%
- Sharpe: ${performance.sharpe}
- 总盈亏: $${performance.totalPnl}
- 最大回撤: ${performance.maxDrawdown}%

## 市场状态
${marketRegime}

请优化参数并输出JSON（不要markdown代码块标记）：
{
  "newParams": {
    "rsiOverbought": <60-80>,
    "rsiOversold": <20-40>,
    "riskReward": <1.5-4.0浮点>,
    "maxLeverage": <1-10整数>,
    "positionSizePct": <5-15整数>,
    "stopLossPct": <0.5-5.0浮点>,
    "takeProfitPct": <1.0-10.0浮点>
  },
  "reasoning": "50字以内说明为什么这样调整",
  "expectedImpact": "预期效果"}`;

    try {
      const response = await this._callDeepSeek(prompt);
      const parsed = JSON.parse(response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
      this.log('🧬 策略进化: ' + parsed.reasoning);
      return parsed;
    } catch(e) {
      this.log('❌ 策略进化失败: ' + e.message);
      return null;
    }
  }

  /**
   * 获取性能统计
   */
  getPerformanceSummary() {
    return {
      ...this.performanceStats,
      avgResponseMs: Math.round(this.performanceStats.avgResponseMs),
      strategyParams: { ...this.strategyParams },
      tradeHistoryCount: this.tradeHistory.length,
    };
  }
}

module.exports = DeepSeekBrain;
