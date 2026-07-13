/** * LLM Manager v2.0 — 外部大模型多模型管理器 * * v2.0 新增: OpenRouter 免费模型支持 (27个免费模型, 无需付费) * * 支持模型:
 *   - OpenRouter 免费 (Llama 70B, Qwen3, Gemma4, GPT-OSS 等)
 *   - DeepSeek (deepseek-chat / deepseek-reasoner)
 *   - OpenAI (gpt-4o / gpt-4o-mini)
 *   - Claude (claude-sonnet-4-20250514)
 *
 * 决策模式:
 *   1. single  — 单模型调用
 *   2. vote    — 多模型投票（加权融合）
 *   3. chain   — 链式推理（模型A → 模型B → 模型C 逐步深化）
 *   4. parallel— 并行调用，取共识
 */

const https = require('https');

class LLMManager {
  constructor(config = {}) {
    this.models = {};
    this.defaultModel = null;
    this.voteMode = config.voteMode || 'vote'; // vote | chain | parallel
    this.timeout = config.timeout || 30000;
    this.maxRetries = config.maxRetries || 2;
    this.cache = new Map();
    this.cacheMs = 60000; // 1分钟缓存
    this.stats = {
      totalCalls: 0,
      byModel: {},
      errors: 0,
      avgResponseMs: 0,
      voteAgreements: 0,
      voteDisagreements: 0,
    };
    this.log = (msg) => console.log(`[LLM-Manager] ${msg}`);

    // 注册可用模型
    this._registerModels(config);
  }

  /**
   * 注册所有可用模型
   */
  _registerModels(config) {
    // v2.0: OpenRouter 免费模型 — 最优先注册
    // 27个免费模型, 无需付费, 注册即用
    const orKey = config.openrouter?.apiKey || process.env.OPENROUTER_API_KEY;
    const orFreeModels = config.openrouter?.freeModels || [
      { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'llama-70b', weight: 0.2 },
      { id: 'qwen/qwen3-next-80b-a3b-instruct:free', name: 'qwen3-80b', weight: 0.2 },
      { id: 'qwen/qwen3-coder:free', name: 'qwen3-coder', weight: 0.15 },
      { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'nemotron-120b', weight: 0.15 },
      { id: 'openai/gpt-oss-120b:free', name: 'gpt-oss-120b', weight: 0.2 },
      { id: 'google/gemma-4-31b-it:free', name: 'gemma4-31b', weight: 0.1 },
    ];
    
    if (orKey) {
      for (const m of orFreeModels) {
        const key = `or-${m.name}`;
        this.models[key] = {
          name: key,
          apiKey: orKey,
          model: m.id,
          baseURL: 'openrouter.ai',
          endpoint: '/api/v1/chat/completions',
          weight: m.weight,
          enabled: true,
          isOpenRouter: true,
          tier: 'free',
          cooldownUntil: 0, // 限速冷却时间戳
        };
      }
      this.log(`✅ OpenRouter ${orFreeModels.length}个免费模型已注册`);
      // 定期轮换模型权重 — 每次调用时选择未冷却的模型
      this._orRoundRobin = 0;
    } else {
      // 无API Key时提示
      this.log('💡 OpenRouter 免费模型: 设置 OPENROUTER_API_KEY 或 config.openrouter.apiKey 即可激活27个免费大模型');
    }
    // DeepSeek
    const dsKey = config.deepseek?.apiKey || process.env.DEEPSEEK_API_KEY;
    if (dsKey) {
      this.models.deepseek = {
        name: 'deepseek',
        apiKey: dsKey,
        model: config.deepseek?.model || 'deepseek-chat',
        baseURL: 'api.deepseek.com',
        endpoint: '/v1/chat/completions',
        weight: config.deepseek?.weight || 0.35,
        enabled: true,
      };
      this.log(`✅ DeepSeek 已注册 (${this.models.deepseek.model}, weight=${this.models.deepseek.weight})`);
    }

    // OpenAI
    const oaiKey = config.openai?.apiKey || process.env.OPENAI_API_KEY;
    if (oaiKey) {
      this.models.openai = {
        name: 'openai',
        apiKey: oaiKey,
        model: config.openai?.model || 'gpt-4o-mini',
        baseURL: 'api.openai.com',
        endpoint: '/v1/chat/completions',
        weight: config.openai?.weight || 0.35,
        enabled: true,
      };
      this.log(`✅ OpenAI 已注册 (${this.models.openai.model}, weight=${this.models.openai.weight})`);
    }

    // Claude
    const claudeKey = config.claude?.apiKey || process.env.ANTHROPIC_API_KEY;
    if (claudeKey) {
      this.models.claude = {
        name: 'claude',
        apiKey: claudeKey,
        model: config.claude?.model || 'claude-sonnet-4-20250514',
        baseURL: 'api.anthropic.com',
        endpoint: '/v1/messages',
        weight: config.claude?.weight || 0.30,
        enabled: true,
        isClaude: true, // Claude API格式不同
      };
      this.log(`✅ Claude 已注册 (${this.models.claude.model}, weight=${this.models.claude.weight})`);
    }

    // 选默认模型
    const available = Object.keys(this.models);
    if (available.length === 0) {
      this.log('⚠️ 无外部大模型可用，将使用纯规则引擎');
    } else {
      this.defaultModel = available[0];
      this.log(`🧠 可用模型: ${available.join(', ')} | 模式: ${this.voteMode}`);
    }
  }

  /**
   * 调用单个模型
   */
  async _callModel(modelName, systemPrompt, userPrompt, temperature = 0.3) {
    const model = this.models[modelName];
    if (!model || !model.enabled) throw new Error(`Model ${modelName} not available`);

    const cacheKey = `${modelName}:${systemPrompt.slice(0, 100)}:${userPrompt.slice(0, 200)}`;
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.time < this.cacheMs) return cached.result;
    }

    const startTime = Date.now();
    this.stats.totalCalls++;
    if (!this.stats.byModel[modelName]) this.stats.byModel[modelName] = { calls: 0, errors: 0, avgMs: 0 };
    this.stats.byModel[modelName].calls++;

    // v2.0: 跳过冷却中的模型
    if (model.cooldownUntil && Date.now() < model.cooldownUntil) {
      throw new Error(`${modelName} 冷却中，剩余${Math.ceil((model.cooldownUntil - Date.now())/1000)}s`);
    }

    try {
      let response;

      if (model.isClaude) {
        response = await this._callClaude(model, systemPrompt, userPrompt, temperature);
      } else {
        // DeepSeek & OpenAI 都用 OpenAI 兼容格式
        response = await this._callOpenAICompatible(model, systemPrompt, userPrompt, temperature);
      }

      const elapsed = Date.now() - startTime;
      this.stats.byModel[modelName].avgMs = 
        (this.stats.byModel[modelName].avgMs * 0.8) + (elapsed * 0.2);
      this.stats.avgResponseMs = (this.stats.avgResponseMs * 0.9) + (elapsed * 0.1);

      // 缓存
      this.cache.set(cacheKey, { time: Date.now(), result: response });
      if (this.cache.size > 200) {
        // v113.5: 批量清理过期缓存，而不是只删第一个
        const now = Date.now();
        for (const [k, v] of this.cache) {
          if (now - v.time > this.cacheMs) this.cache.delete(k);
        }
        // 如果清理过期后仍超限，删最旧的
        if (this.cache.size > 200) {
          const firstKey = this.cache.keys().next().value;
          this.cache.delete(firstKey);
        }
      }

      return response;
    } catch (err) {
      this.stats.errors++;
      this.stats.byModel[modelName].errors++;
      throw err;
    }
  }

  /**
   * OpenAI兼容格式调用 (DeepSeek/OpenAI)
   */
  _callOpenAICompatible(model, systemPrompt, userPrompt, temperature) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model: model.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature,
        max_tokens: 2000,
        stream: false,
      });

      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${model.apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      };
      // OpenRouter需要额外headers
      if (model.isOpenRouter) {
        headers['HTTP-Referer'] = 'https://strike-agent.com';
        headers['X-Title'] = 'MasterD-Quant';
      }

      const options = {
        hostname: model.baseURL,
        port: 443,
        path: model.endpoint,
        method: 'POST',
        headers,
        timeout: this.timeout,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) {
              // v2.0: 处理OpenRouter 429限速
              if (res.statusCode === 429 && model.isOpenRouter) {
                const retryAfter = json.error.metadata?.retry_after_seconds || 20;
                model.cooldownUntil = Date.now() + (retryAfter * 1000);
                this.log(`⏳ ${model.name} 限速冷却 ${retryAfter}s`);
              }
              throw new Error(json.error.message || 'API error');
            }
            const content = json.choices?.[0]?.message?.content || '';
            resolve(content);
          } catch (e) {
            reject(new Error(`Parse error: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(body);
      req.end();
    });
  }

  /**
   * Claude格式调用
   */
  _callClaude(model, systemPrompt, userPrompt, temperature) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model: model.model,
        max_tokens: 2000,
        temperature,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userPrompt },
        ],
      });

      const options = {
        hostname: model.baseURL,
        port: 443,
        path: model.endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': model.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: this.timeout,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) throw new Error(json.error.message || 'Claude API error');
            const content = json.content?.[0]?.text || '';
            resolve(content);
          } catch (e) {
            reject(new Error(`Claude parse error: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Claude timeout')); });
      req.write(body);
      req.end();
    });
  }

  /**
   * 多模型投票决策
   * @param {string} systemPrompt - 系统提示
   * @param {string} userPrompt - 用户提示
   * @param {Object} opts - { models: ['deepseek','openai','claude'], parseFn: (text) => parsedObj }
   * @returns {Object} { decision, confidence, models: {name: {decision, reasoning}}, consensus, voteType }
   */
  async vote(systemPrompt, userPrompt, opts = {}) {
    const modelNames = opts.models || Object.keys(this.models);
    const parseFn = opts.parseFn || ((text) => { try { return JSON.parse(text); } catch { return { raw: text }; } });

    if (modelNames.length === 0 || Object.keys(this.models).length === 0) {
      return { decision: null, confidence: 0, models: {}, consensus: false, reason: 'no models available' };
    }

    // 并行调用所有模型
    const results = await Promise.allSettled(
      modelNames
        .filter(name => {
          const m = this.models[name];
          return m?.enabled && (!m.cooldownUntil || Date.now() >= m.cooldownUntil);
        })
        .map(async (name) => {
          const text = await this._callModel(name, systemPrompt, userPrompt, opts.temperature || 0.3);
          const parsed = parseFn(text);
          return { name, text, parsed };
        })
    );

    const modelResults = {};
    const decisions = [];
    let totalWeight = 0;

    for (const r of results) {
      if (r.status === 'fulfilled') {
        const { name, text, parsed } = r.value;
        modelResults[name] = {
          decision: parsed.direction || parsed.action || null,
          confidence: parsed.confidence || 0.5,
          reasoning: parsed.reasoning || text.slice(0, 200),
          raw: parsed,
        };
        if (modelResults[name].decision) {
          decisions.push({
            decision: modelResults[name].decision,
            confidence: modelResults[name].confidence,
            weight: this.models[name].weight,
          });
          totalWeight += this.models[name].weight;
        }
      } else {
        // v113.5: 用索引而不是 indexOf (更可靠)
        const idx = results.indexOf(r);
        // modelNames 可能在 filter 后比 results 短，需要用 filter 后的实际顺序
        const activeNames = modelNames.filter(name => {
          const m = this.models[name];
          return m?.enabled && (!m.cooldownUntil || Date.now() >= m.cooldownUntil);
        });
        const name = activeNames[idx] || `model_${idx}`;
        modelResults[name] = { error: r.reason?.message || 'failed', decision: null };
      }
    }

    // 加权投票
    if (decisions.length === 0) {
      return { decision: null, confidence: 0, models: modelResults, consensus: false, reason: 'all models failed' };
    }

    const voteCount = {};
    for (const d of decisions) {
      const key = d.decision;
      if (!voteCount[key]) voteCount[key] = { count: 0, weightedScore: 0, totalConfidence: 0 };
      voteCount[key].count++;
      voteCount[key].weightedScore += d.weight;
      voteCount[key].totalConfidence += d.confidence * d.weight;
    }

    // 排序，取最高票
    const sorted = Object.entries(voteCount).sort((a, b) => b[1].weightedScore - a[1].weightedScore);
    const [winnerDecision, winnerStats] = sorted[0];
    const consensus = sorted.length === 1 || (sorted[1] && winnerStats.count > sorted[1][1].count);

    if (consensus) this.stats.voteAgreements++;
    else this.stats.voteDisagreements++;

    const avgConfidence = winnerStats.totalConfidence / winnerStats.weightedScore;

    return {
      decision: winnerDecision,
      confidence: Math.min(avgConfidence, 1),
      models: modelResults,
      consensus,
      voteCount: Object.fromEntries(Object.entries(voteCount).map(([k, v]) => [k, v.count])),
      weightedScores: Object.fromEntries(Object.entries(voteCount).map(([k, v]) => [k, v.weightedScore])),
    };
  }

  /**
   * 链式推理 — 模型A的输出作为模型B的输入
   */
  async chain(systemPrompt, userPrompt, modelChain, parseFn) {
    let currentPrompt = userPrompt;
    const chainResults = [];

    for (const modelName of modelChain) {
      if (!this.models[modelName]?.enabled) continue;
      try {
        const text = await this._callModel(modelName, systemPrompt, currentPrompt);
        const parsed = parseFn ? parseFn(text) : text;
        chainResults.push({ model: modelName, output: parsed, text });
        // 把上一步结果作为下一步输入
        currentPrompt = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
      } catch (e) {
        chainResults.push({ model: modelName, error: e.message });
      }
    }

    return {
      finalResult: chainResults[chainResults.length - 1]?.output || null,
      chain: chainResults,
    };
  }

  /**
   * 单模型调用 — v2.0: 自动选择未冷却的模型
   */
  async ask(systemPrompt, userPrompt, modelName = null, parseFn = null) {
    // 如果指定了模型就用指定的
    if (modelName && this.models[modelName]) {
      try {
        const text = await this._callModel(modelName, systemPrompt, userPrompt);
        return parseFn ? parseFn(text) : text;
      } catch (e) { return null; }
    }
    
    // v2.1: 遍历所有未冷却的OpenRouter模型，逐个尝试
    const orModels = Object.values(this.models).filter(m => m.enabled && m.isOpenRouter && (!m.cooldownUntil || Date.now() >= m.cooldownUntil));
    for (const model of orModels) {
      try {
        const text = await this._callModel(model.name, systemPrompt, userPrompt);
        return parseFn ? parseFn(text) : text;
      } catch (e) {
        this.log(`⚠️ ${model.name} 失败: ${e.message.slice(0,60)}, 尝试下一个...`);
        continue; // 失败后继续尝试下一个
      }
    }
    
    // 尝试所有非OpenRouter模型
    const otherModels = Object.values(this.models).filter(m => m.enabled && !m.isOpenRouter);
    for (const model of otherModels) {
      try {
        const text = await this._callModel(model.name, systemPrompt, userPrompt);
        return parseFn ? parseFn(text) : text;
      } catch (e) { continue; }
    }
    return null;
  }

  /**
   * 获取可用模型列表
   */
  getAvailableModels() {
    return Object.entries(this.models)
      .filter(([_, m]) => m.enabled)
      .map(([name, m]) => ({ name, model: m.model, weight: m.weight }));
  }

  /**
   * 获取统计
   */
  getStats() {
    return {
      ...this.stats,
      availableModels: this.getAvailableModels(),
      voteMode: this.voteMode,
      cacheSize: this.cache.size,
    };
  }

  /**
   * 更新模型权重（根据DataHub反馈进化）
   */
  updateWeights(modelPerformance) {
    // modelPerformance: { deepseek: { correctRate: 0.65 }, openai: { correctRate: 0.72 }, ... }
    for (const [name, perf] of Object.entries(modelPerformance)) {
      if (!this.models[name]) continue;
      if (perf.correctRate != null) {
        // 正确率越高，权重越大
        this.models[name].weight = Math.max(0.1, Math.min(0.6, perf.correctRate));
      }
    }
    // 归一化权重
    const total = Object.values(this.models).reduce((s, m) => s + m.weight, 0);
    if (total > 0) {
      for (const m of Object.values(this.models)) {
        m.weight = m.weight / total;
      }
    }
    this.log(`📊 模型权重已更新: ${Object.entries(this.models).map(([k, v]) => `${k}=${(v.weight * 100).toFixed(0)}%`).join(', ')}`);
  }
}

module.exports = LLMManager;
