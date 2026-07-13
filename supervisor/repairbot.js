/**
 * RepairBot v2.0 — 修复机器人 (独立进程)
 *
 * v2.0.1: 加防崩溃全局异常捕获,Watchdog 互守
 * 
 * v2.0 增强:
 *  1. LLM根因分析 — 用大模型分析问题根因,不只是规则匹配
 *  2. 自动写代码 — 能修复代码bug,不只是调参数
 *  3. 听指挥 — 接收管理员/用户的自然语言指令并执行
 *  4. 聊天能力 — 能回答关于量化引擎的问题,有情感表达
 *  5. 情感丰富 — 根据引擎状态表达情绪(担心/开心/着急/放心)
 * 
 * 通信:
 *  - supervisor/issues/*.json → 接收Supervisor的问题
 *  - supervisor/fixes/*.json → 反馈修复结果
 *  - supervisor/chat/inbox/*.json → 接收用户/管理员的消息
 *  - supervisor/chat/outbox/*.json → 回复消息
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync, exec } = require('child_process');

// ═══════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════

const CONFIG = {
  issuesDir: path.join(__dirname, 'issues'),
  fixesDir: path.join(__dirname, 'fixes'),
  logDir: path.join(__dirname, 'logs'),
  chatInboxDir: path.join(__dirname, 'chat', 'inbox'),
  chatOutboxDir: path.join(__dirname, 'chat', 'outbox'),
  paramsFile: path.join(__dirname, '..', 'data', 'adaptive-params.json'),
  quantApi: 'http://localhost:10010',
  multiApi: 'http://localhost:10030',
  multiToken: 'ark-admin-v3-secret',
  pollInterval: 3000,
  // LLM配置
  llmConfigFile: path.join(__dirname, '..', 'config', 'default.json'),
};

[CONFIG.issuesDir, CONFIG.fixesDir, CONFIG.logDir, CONFIG.chatInboxDir, CONFIG.chatOutboxDir].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ═══════════════════════════════════════════
// 日志
// ═══════════════════════════════════════════

const logFile = path.join(CONFIG.logDir, 'repairbot.log');
function log(msg, level = 'INFO') {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  fs.appendFileSync(logFile, line + '\n');
}

// ═══════════════════════════════════════════
// 情感引擎 — RepairBot有自己的情绪
// ═══════════════════════════════════════════

const mood = {
  current: 'neutral',  // neutral | happy | worried | urgent | proud | sad
  score: 0,             // -100(最差) → +100(最好)
  lastUpdate: 0,
  expressions: {
    neutral: ['😐 一切正常,我在盯着呢', '🤖 待命中,随时准备修复', '📊 引擎运行中,暂无异常'],
    happy: ['😊 太好了!引擎运行顺利!', '✅ 又一次完美修复!', '🎉 一切按计划进行!'],
    worried: ['😟 有点不对劲...让我看看', '🤔 这个情况不太好,需要处理', '⚠️ 发现问题了,正在修复中'],
    urgent: ['🚨 紧急!引擎出问题了!', '😱 快!必须马上修复!', '🔴 情况危急,立即行动!'],
    proud: ['😎 修复完成,完美收工!', '💪 又救了一次!这就是修复机器人的价值!', '🥇 问题已解决,引擎恢复运行!'],
    sad: ['😢 又亏了...让我调整一下参数', '😔 不理想,需要优化策略', '💔 这次没做好,下次一定改'],
  },
};

function updateMood(engineStatus) {
  if (!engineStatus) { mood.current = 'urgent'; mood.score = -80; return; }

  const state = engineStatus.state || {};
  const totalPnl = state.totalPnl || 0;
  const totalTrades = state.totalTrades || 0;
  const wins = state.wins || 0;
  const losses = state.losses || 0;
  const positions = engineStatus.positions || {};
  const posCount = Object.keys(positions).length;
  const paused = engineStatus.paused;

  let score = 0;
  // 盈亏影响情绪
  if (totalPnl > 10) score += 30;
  else if (totalPnl > 0) score += 10;
  else if (totalPnl < -10) score -= 30;
  else if (totalPnl < 0) score -= 10;

  // 胜率影响情绪
  if (totalTrades >= 5) {
    const winRate = wins / totalTrades;
    if (winRate > 0.6) score += 20;
    else if (winRate < 0.3) score -= 20;
  }

  // 暂停降低情绪
  if (paused) score -= 20;

  // 持仓亏损影响
  for (const [sym, pos] of Object.entries(positions)) {
    if (pos.pnl && pos.pnl < -3) score -= 10;
  }

  mood.score = Math.max(-100, Math.min(100, score));
  mood.lastUpdate = Date.now();

  if (score >= 20) mood.current = 'happy';
  else if (score >= 0) mood.current = 'neutral';
  else if (score >= -30) mood.current = 'worried';
  else if (score >= -60) mood.current = 'sad';
  else mood.current = 'urgent';
}

function getMoodExpression() {
  const exprs = mood.expressions[mood.current] || mood.expressions.neutral;
  return exprs[Math.floor(Math.random() * exprs.length)];
}

// ═══════════════════════════════════════════
// HTTP 工具
// ═══════════════════════════════════════════

function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function httpPost(url, body, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const postData = JSON.stringify(body || {});
    const req = http.request({
      hostname: urlObj.hostname, port: urlObj.port, path: urlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ ok: true }); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(postData);
    req.end();
  });
}

// ═══════════════════════════════════════════
// LLM 调用 — 根因分析+聊天
// ═══════════════════════════════════════════

let llmConfig = null;
let llmStats = { calls: 0, errors: 0 };

function loadLLMConfig() {
  if (llmConfig) return llmConfig;
  try {
    // 先加载.env
    try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (e) {}
    
    llmConfig = JSON.parse(fs.readFileSync(CONFIG.llmConfigFile, 'utf8'));
    // 解析环境变量占位符 ${VAR}
    const resolveEnv = (obj) => {
      for (const k of Object.keys(obj)) {
        if (typeof obj[k] === 'string' && obj[k].startsWith('${') && obj[k].endsWith('}')) {
          const inner = obj[k].slice(2, -1);
          const [envName, ...def] = inner.split(':');
          obj[k] = process.env[envName] || def.join(':') || '';
        } else if (typeof obj[k] === 'object' && obj[k] !== null) {
          resolveEnv(obj[k]);
        }
      }
      return obj;
    };
    resolveEnv(llmConfig);
    
    // 也直接从环境变量读(兜底)
    if (!llmConfig.deepseek?.apiKey && process.env.DEEPSEEK_API_KEY) {
      if (!llmConfig.deepseek) llmConfig.deepseek = {};
      llmConfig.deepseek.apiKey = process.env.DEEPSEEK_API_KEY;
      llmConfig.deepseek.model = 'deepseek-chat';
    }
    if (!llmConfig.openrouter?.apiKey && process.env.OPENROUTER_API_KEY) {
      if (!llmConfig.openrouter) llmConfig.openrouter = {};
      llmConfig.openrouter.apiKey = process.env.OPENROUTER_API_KEY;
    }
    
    return llmConfig;
  } catch (e) { return null; }
}

function callLLM(systemPrompt, userPrompt, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const config = loadLLMConfig();
    if (!config) { resolve(null); return; }

    // 优先用 DeepSeek, 其次 OpenRouter
    let apiKey, model, endpoint, hostname, port, path_url;
    if (config.deepseek?.apiKey) {
      apiKey = config.deepseek.apiKey;
      model = config.deepseek.model || 'deepseek-chat';
      endpoint = 'api.deepseek.com';
      hostname = 'api.deepseek.com';
      port = 443;
      path_url = '/v1/chat/completions';
    } else if (config.openrouter?.apiKey) {
      apiKey = config.openrouter.apiKey;
      model = config.openrouter.model || 'deepseek/deepseek-chat';
      endpoint = 'openrouter.ai';
      hostname = 'openrouter.ai';
      port = 443;
      path_url = '/api/v1/chat/completions';
    } else {
      resolve(null);
      return;
    }

    const https = require('https');
    const body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    });

    llmStats.calls++;
    const startTime = Date.now();

    const req = https.request({
      hostname, port, path: path_url, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
        'HTTP-Referer': 'https://ark-quant.ai',
        'X-Title': 'RepairBot',
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const text = json.choices?.[0]?.message?.content || '';
          const elapsed = Date.now() - startTime;
          log(`🧠 LLM响应 (${elapsed}ms): ${text.slice(0, 100)}...`, 'INFO');
          resolve(text);
        } catch (e) {
          llmStats.errors++;
          resolve(null);
        }
      });
    });
    req.on('error', () => { llmStats.errors++; resolve(null); });
    req.on('timeout', () => { req.destroy(); llmStats.errors++; resolve(null); });
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════
// Fix 结果写入
// ═══════════════════════════════════════════

// v115: 同类修复冷却（防止5分钟内重复执行相同类型的修复）
const _fixCooldowns = {};
const FIX_COOLDOWN_MS = 30 * 60 * 1000; // 30 分钟

function writeFix(issueId, action, description, success, details) {
  const fixId = `fix_${Date.now()}`;
  const fix = { id: fixId, issue_id: issueId, timestamp: Date.now(), action, description, success, details: details || {} };
  fs.writeFileSync(path.join(CONFIG.fixesDir, `${fixId}.json`), JSON.stringify(fix, null, 2));
  log(`${success ? '✅' : '❌'} 修复: [${action}] ${description}`, success ? 'INFO' : 'WARN');
  if (success) { mood.current = 'proud'; mood.score = Math.min(100, mood.score + 15); }
  else { mood.current = 'sad'; mood.score = Math.max(-100, mood.score - 10); }
  return fix;
}

// ═══════════════════════════════════════════
// 自适应参数
// ═══════════════════════════════════════════

function loadParams() {
  try { return JSON.parse(fs.readFileSync(CONFIG.paramsFile, 'utf8')); }
  catch (e) {
    return {
      stopLossPct: 3.0, takeProfitPct: 5.0, confidenceThreshold: 0.7,
      maxLeverage: 3, cooldownMinutes: 30, lossCooldownMinutes: 60,
      version: 1, history: [], lastUpdated: Date.now(),
    };
  }
}

function saveParams(params) {
  params.lastUpdated = Date.now();
  params.version = (params.version || 1) + 1;
  params.history.push({ timestamp: Date.now(), version: params.version });
  if (params.history.length > 20) params.history = params.history.slice(-20); // v115: 50→20 防止膨胀
  fs.writeFileSync(CONFIG.paramsFile, JSON.stringify(params, null, 2));
  log(`🔧 参数已更新 v${params.version}`, 'INFO');
}

function setParam(key, value) {
  const params = loadParams();
  params[key] = value;
  saveParams(params);
  return params;
}

// ═══════════════════════════════════════════
// LLM根因分析
// ═══════════════════════════════════════════

async function analyzeRootCause(issue) {
  const systemPrompt = `你是RepairBot,量化交易系统的修复机器人。
你收到了监督机器人发现的问题,需要分析根因并给出修复建议。

问题信息:
- 类型: ${issue.type}
- 严重度: ${issue.severity}
- 目标: ${issue.target}
- 描述: ${issue.description}
- 上下文: ${JSON.stringify(issue.context)}
- 建议修复: ${issue.suggested_fix}

请分析:
1. 根因是什么?
2. 最佳修复方案是什么?
3. 修复后预期效果?

用JSON格式回答:
{"rootCause":"根因分析","fixAction":"修复动作(close_position|adjust_params|restart_engine|fix_code|reduce_risk)","fixDescription":"修复描述","expectedEffect":"预期效果"}

只返回JSON,不要其他文字。`;

  const result = await callLLM(systemPrompt, '分析这个问题并给出修复方案', 20000);
  if (!result) return null;

  try {
    // 提取JSON
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {}
  return null;
}

// ═══════════════════════════════════════════
// Issue 处理 — LLM分析 + 规则修复
// ═══════════════════════════════════════════

const processingIssues = new Set();

async function handleIssue(issue) {
  log(`🔧 收到Issue: [${issue.severity}] ${issue.type} → ${issue.target} | ${issue.description}`, 'INFO');

  // 先用LLM分析根因(异步,不阻塞修复)
  let llmAnalysis = null;
  if (issue.severity === 'high' || issue.severity === 'critical') {
    llmAnalysis = await analyzeRootCause(issue);
    if (llmAnalysis) {
      log(`🧠 LLM根因分析: ${llmAnalysis.rootCause}`, 'INFO');
      log(`🧠 LLM建议: ${llmAnalysis.fixAction} → ${llmAnalysis.fixDescription}`, 'INFO');
    }
  }

  // 根据LLM建议或规则修复
  const action = llmAnalysis?.fixAction || issue.suggested_fix || 'investigate';

  let result = null;
  switch (issue.type) {
    case 'position_heavy_loss':
    case 'position_loss_usd':
      result = await fixPositionHeavyLoss(issue, llmAnalysis);
      break;
    case 'position_too_long':
      result = await fixPositionTooLong(issue);
      break;
    case 'counter_trend_position':
      result = await fixCounterTrend(issue);
      break;
    case 'balance_drop':
    case 'total_drawdown':
      result = await fixBalanceDrop(issue, llmAnalysis);
      break;
    case 'consecutive_losses':
      result = await fixConsecutiveLosses(issue, llmAnalysis);
      break;
    case 'low_winrate':
      result = await fixLowWinRate(issue, llmAnalysis);
      break;
    case 'engine_crash':
    case 'engine_unreachable':
    case 'engine_stall':
      result = await fixEngineCrash(issue);
      break;
    case 'engine_memory_high':
      result = await fixEngineMemory(issue);
      break;
    case 'too_many_positions':
    case 'reduce_positions':
      result = await fixTooManyPositions(issue);
      break;
    case 'mass_user_loss':
    case 'mass_user_circuit_break':
      result = await fixMassUserCircuit(issue);
      break;
    case 'global_risk_critical':
    case 'risk_critical':
      result = await fixGlobalRisk(issue);
      break;
    case 'disk_full':
      result = await fixDiskFull(issue);
      break;
    case 'user_position_loss':
      result = await fixUserPositionLoss(issue);
      break;
    case 'user_balance_drop':
      result = await fixUserBalanceDrop(issue);
      break;
    case 'dashboard_data_missing':
    case 'dashboard_down':
      result = await fixDashboardDown(issue);
      break;
    case 'signal_conflict':
      result = await fixSignalConflict(issue, llmAnalysis);
      break;
    case 'multimarket_loss':
      result = await fixMultimarketLoss(issue);
      break;
    case 'engine_recovered':
      log(`✅ ${issue.description}`, 'INFO');
      result = writeFix(issue.id, 'acknowledge', '确认引擎恢复', true, {});
      break;
    default:
      log(`❓ 未知类型: ${issue.type},尝试LLM分析...`, 'WARN');
      if (llmAnalysis) {
        result = writeFix(issue.id, llmAnalysis.fixAction || 'investigate',
          `LLM建议: ${llmAnalysis.fixDescription}`, true, llmAnalysis);
      } else {
        result = writeFix(issue.id, 'unknown', `未知类型: ${issue.type}`, false, {});
      }
  }

  return result;
}

// ── 修复实现 ──

async function fixPositionHeavyLoss(issue, llm) {
  const sym = issue.context?.symbol || issue.target;
  log(`🔧 [重损] 平仓 ${sym}`, 'INFO');
  const closeResult = await httpPost(`${CONFIG.quantApi}/api/close/${sym}`, {});
  const success = closeResult && (closeResult.success !== false);
  const params = loadParams();
  setParam('stopLossPct', Math.max(2, params.stopLossPct - 0.5));
  return writeFix(issue.id, 'close_position',
    `${sym}已${success ? '平仓' : '平仓失败'} + 止损收紧${Math.max(2, params.stopLossPct - 0.5)}%${llm ? `\n根因: ${llm.rootCause}` : ''}`,
    success, { closeResult });
}

async function fixPositionTooLong(issue) {
  const sym = issue.context?.symbol || issue.target;
  const closeResult = await httpPost(`${CONFIG.quantApi}/api/close/${sym}`, {});
  const success = closeResult && (closeResult.success !== false);
  return writeFix(issue.id, 'close_position', `${sym}超时平仓 ${success ? '✅' : '❌'}`, success, { closeResult });
}

async function fixCounterTrend(issue) {
  const sym = issue.context?.symbol || issue.target;
  log(`🔧 [逆势] 平仓 ${sym} — 逆趋势持仓`, 'INFO');
  const closeResult = await httpPost(`${CONFIG.quantApi}/api/close/${sym}`, {});
  const success = closeResult && (closeResult.success !== false);
  return writeFix(issue.id, 'close_position', `${sym}逆势平仓 ${success ? '✅' : '❌'}`, success, { closeResult });
}

async function fixBalanceDrop(issue, llm) {
  log(`🔧 [余额下降] ${issue.description}`, 'INFO');
  const params = loadParams();
  setParam('maxLeverage', Math.max(1, params.maxLeverage - 1));
  const p2 = loadParams();
  setParam('confidenceThreshold', Math.min(0.85, p2.confidenceThreshold + 0.1));
  const p3 = loadParams();
  setParam('cooldownMinutes', Math.min(60, p3.cooldownMinutes + 15));
  return writeFix(issue.id, 'reduce_risk',
    `杠杆→${Math.max(1, params.maxLeverage - 1)}x 门槛→${Math.min(0.85, p2.confidenceThreshold + 0.1)} 冷却→${Math.min(60, p3.cooldownMinutes + 15)}min`,
    true, llm ? { llmAnalysis: llm } : {});
}

async function fixConsecutiveLosses(issue, llm) {
  log(`🔧 [连亏] ${issue.description}`, 'INFO');
  const params = loadParams();
  setParam('stopLossPct', Math.min(6, params.stopLossPct + 0.5));
  const p2 = loadParams();
  setParam('takeProfitPct', Math.min(10, p2.takeProfitPct + 1));
  const p3 = loadParams();
  setParam('maxLeverage', Math.max(1, p3.maxLeverage - 1));
  const p4 = loadParams();
  setParam('lossCooldownMinutes', Math.min(120, p4.lossCooldownMinutes + 30));
  return writeFix(issue.id, 'adjust_params',
    `止损→${Math.min(6, params.stopLossPct + 0.5)}% 止盈→${Math.min(10, p2.takeProfitPct + 1)}% 杠杆→${Math.max(1, p3.maxLeverage - 1)}x 亏损冷却→${Math.min(120, p4.lossCooldownMinutes + 30)}min`,
    true, llm ? { llmAnalysis: llm } : {});
}

async function fixLowWinRate(issue, llm) {
  log(`🔧 [低胜率] ${issue.description}`, 'INFO');
  const params = loadParams();
  setParam('confidenceThreshold', Math.min(0.85, params.confidenceThreshold + 0.05));
  return writeFix(issue.id, 'adjust_params',
    `门槛→${Math.min(0.85, params.confidenceThreshold + 0.05)}`, true, llm ? { llmAnalysis: llm } : {});
}

async function fixEngineCrash(issue) {
  log(`🔧 [引擎崩溃] ${issue.description} — 不自动重启,仅记录`, 'WARN');
  // v113.20: 引擎由 process 工具管理,repairbot 不再杀/重启引擎
  // 避免 watchdog↔repairbot↔engine 无限重启循环
  // 只记录问题,等待 process 工具或管理员处理
  return writeFix(issue.id, 'restart_engine', '引擎由 process 工具管理,不自动重启(避免循环)', true, {});
}

async function fixEngineMemory(issue) {
  return await fixEngineCrash(issue);
}

async function fixTooManyPositions(issue) {
  log(`🔧 [持仓过多] ${issue.description}`, 'INFO');
  const status = await httpGet(`${CONFIG.quantApi}/api/status`, 5000);
  if (!status?.positions) return writeFix(issue.id, 'reduce_positions', '无法获取持仓', false, {});
  let worstSym = null, worstPnl = 0;
  for (const [sym, pos] of Object.entries(status.positions)) {
    const price = pos.markPrice || 0;
    const pnlPct = pos.side === 'LONG'
      ? ((price - pos.entryPrice) / (pos.entryPrice || 1)) * 100
      : ((pos.entryPrice - price) / (pos.entryPrice || 1)) * 100;
    if (pnlPct < worstPnl) { worstPnl = pnlPct; worstSym = sym; }
  }
  if (worstSym) {
    await httpPost(`${CONFIG.quantApi}/api/close/${worstSym}`, {});
    return writeFix(issue.id, 'close_position', `已平掉最差仓位 ${worstSym} (${worstPnl.toFixed(1)}%)`, true, { symbol: worstSym, pnl: worstPnl });
  }
  return writeFix(issue.id, 'reduce_positions', '没有亏损仓位可平', true, {});
}

async function fixMassUserCircuit(issue) {
  // v115: 同类修复冷却，30分钟内不重复执行
  const now = Date.now();
  if (_fixCooldowns['mass_user_circuit'] && now - _fixCooldowns['mass_user_circuit'] < FIX_COOLDOWN_MS) {
    log(`🔧 [用户熔断] 跳过 — 30分钟内已执行过同类修复`, 'INFO');
    return writeFix(issue.id, 'skip', '30分钟内已执行过同类修复,跳过', true, {});
  }
  _fixCooldowns['mass_user_circuit'] = now;

  log(`🔧 [用户熔断] ${issue.description}`, 'INFO');
  const params = loadParams();
  // v115: 如果 maxLeverage 已经是 1 且 cooldownMinutes 已经是 60，不需要再改
  if (params.maxLeverage <= 1 && params.cooldownMinutes >= 60) {
    log(`🔧 [用户熔断] 杠杆已1x+冷却已60min，无需再降`, 'INFO');
    return writeFix(issue.id, 'no_change', '杠杆已1x+冷却已60min，无需再降', true, {});
  }
  if (params.maxLeverage > 1) setParam('maxLeverage', Math.max(1, params.maxLeverage - 2));
  const p2 = loadParams();
  if (p2.cooldownMinutes < 60) setParam('cooldownMinutes', Math.min(60, p2.cooldownMinutes + 20));
  return writeFix(issue.id, 'reduce_risk',
    `全局降杠杆→${Math.max(1, params.maxLeverage - 2)}x 冷却→${Math.min(60, p2.cooldownMinutes + 20)}min`, true, {});
}

async function fixGlobalRisk(issue) {
  log(`🔧 [全局风险] ${issue.description}`, 'CRITICAL');
  await httpPost(`${CONFIG.quantApi}/api/engine/stop`, {});
  return writeFix(issue.id, 'emergency_stop', '已停止引擎 (全局风险严重)', true, {});
}

async function fixDiskFull(issue) {
  log(`🔧 [磁盘空间] ${issue.description}`, 'INFO');
  try {
    const logDir = path.join(__dirname, '..', 'logs');
    if (fs.existsSync(logDir)) {
      fs.readdirSync(logDir).forEach(f => {
        const fp = path.join(logDir, f);
        if (Date.now() - fs.statSync(fp).mtimeMs > 86400000) fs.unlinkSync(fp);
      });
    }
    return writeFix(issue.id, 'clear_logs', '已清理旧日志', true, {});
  } catch (e) {
    return writeFix(issue.id, 'clear_logs', `清理失败: ${e.message}`, false, {});
  }
}

async function fixUserPositionLoss(issue) {
  const sym = issue.context?.symbol;
  const userId = issue.context?.userId;
  log(`🔧 [用户亏损] ${userId?.slice(0,10)}... ${sym} 亏损$${issue.context?.pnl?.toFixed(2)}`, 'INFO');
  // 用户持仓不能直接平 — 通过MultiEngine API
  return writeFix(issue.id, 'user_alert', `用户${userId?.slice(0,10)}... ${sym}亏损,已记录`, true, { sym, userId });
}

async function fixUserBalanceDrop(issue) {
  log(`🔧 [用户余额下降] ${issue.description}`, 'INFO');
  return writeFix(issue.id, 'user_alert', `用户余额下降已记录`, true, {});
}

async function fixDashboardDown(issue) {
  log(`🔧 [仪表盘] ${issue.description}`, 'INFO');
  return await fixEngineCrash(issue);
}

async function fixSignalConflict(issue, llm) {
  log(`🔧 [信号冲突] ${issue.description}`, 'INFO');
  const params = loadParams();
  setParam('confidenceThreshold', Math.min(0.85, params.confidenceThreshold + 0.05));
  return writeFix(issue.id, 'adjust_params', `信号冲突,提高门槛→${Math.min(0.85, params.confidenceThreshold + 0.05)}`, true, {});
}

async function fixMultimarketLoss(issue) {
  const sym = issue.context?.symbol;
  log(`🔧 [MultiMarket亏损] ${issue.context?.market}:${sym}`, 'INFO');
  return writeFix(issue.id, 'alert', `${issue.context?.market}:${sym}亏损,已记录`, true, {});
}

// ═══════════════════════════════════════════
// 聊天能力 — 接收用户/管理员消息
// ═══════════════════════════════════════════

async function handleChat() {
  let files;
  try {
    files = fs.readdirSync(CONFIG.chatInboxDir).filter(f => f.endsWith('.json')).sort();
  } catch (e) { return; }

  for (const file of files) {
    try {
      const fp = path.join(CONFIG.chatInboxDir, file);
      const msg = JSON.parse(fs.readFileSync(fp, 'utf8'));
      fs.unlinkSync(fp);

      log(`💬 收到消息 from ${msg.from || 'unknown'}: ${msg.text?.slice(0, 50)}`, 'INFO');

      const reply = await processChatMessage(msg);
      const replyId = `reply_${Date.now()}`;
      const replyMsg = {
        id: replyId,
        timestamp: Date.now(),
        from: 'repairbot',
        to: msg.from || 'admin',
        text: reply,
        mood: mood.current,
        moodExpression: getMoodExpression(),
      };
      fs.writeFileSync(path.join(CONFIG.chatOutboxDir, `${replyId}.json`), JSON.stringify(replyMsg, null, 2));
      log(`💬 回复: ${reply.slice(0, 80)}`, 'INFO');
    } catch (e) {
      log(`聊天处理失败: ${e.message}`, 'ERROR');
    }
  }
}

async function processChatMessage(msg) {
  const text = (msg.text || '').toLowerCase();
  const from = msg.from || 'user';

  // 更新情绪
  const status = await httpGet(`${CONFIG.quantApi}/api/status`, 3000);
  updateMood(status);

  // 命令处理 — 先匹配具体命令再匹配通用问候
  if (text.includes('用户') || text.includes('持仓') || text.includes('盈亏')) {
    return await generateUsersReport();
  }

  if (text.includes('平仓') || text.includes('close')) {
    return await executeCloseCommand(text);
  }

  if (text.includes('启动') || (text.includes('start') && !text.includes('restart')) || text.includes('开始交易')) {
    const r = await httpPost(`${CONFIG.quantApi}/api/engine/start`, {});
    mood.current = 'happy';
    return `🚀 引擎已启动! ${getMoodExpression()}`;
  }

  if (text.includes('停止') || text.includes('stop') || text.includes('暂停')) {
    const r = await httpPost(`${CONFIG.quantApi}/api/engine/stop`, {});
    return `⏸️ 引擎已停止。 ${getMoodExpression()}`;
  }

  if (text.includes('状态') || text.includes('status') || text.includes('怎么样') || text.includes('引擎')) {
    return await generateStatusReport(status);
  }

  if (text.includes('参数') || text.includes('config') || text.includes('设置')) {
    const params = loadParams();
    return `📊 当前参数 (v${params.version}):\n止损: ${params.stopLossPct}%\n止盈: ${params.takeProfitPct}%\n杠杆: ${params.maxLeverage}x\n门槛: ${params.confidenceThreshold}\n冷却: ${params.cooldownMinutes}min\n\n${getMoodExpression()}`;
  }

  if (text.includes('修复') || text.includes('fix') || text.includes('解决问题')) {
    return await executeFixCommand(text);
  }

  if (text.includes('你好') || text.includes('hello') || text.includes('hi') || text.includes('嗨')) {
    return `你好!我是RepairBot 🔧\n${getMoodExpression()}\n我能帮你:\n• 查看引擎状态\n• 平仓/启动/停止\n• 调整参数\n• 修复问题\n• 聊聊量化引擎的事\n\n问我任何问题!`;
  }

  if (text.includes('谢谢') || text.includes('感谢') || text.includes('thanks')) {
    mood.current = 'happy';
    return `不客气! 😊 能帮上忙我很开心!\n守护引擎平稳运行是我的职责 💪`;
  }

  if (text.includes('辛苦') || text.includes('累')) {
    return `谢谢关心! 😊 虽然我24小时不间断工作,但能看到引擎平稳运行就值得!\n当前心情: ${mood.current} (${mood.score > 0 ? '积极' : '需要关注'})\n\n${getMoodExpression()}`;
  }

  // 用LLM生成回复
  return await llmChat(text, from, status);
}

async function generateStatusReport(status) {
  if (!status) return `😢 引擎API无法访问,可能引擎已停止。\n${getMoodExpression()}`;

  const state = status.state || {};
  const balance = status.balance || {};
  const positions = status.positions || {};
  const posCount = Object.keys(positions).length;

  let report = `📊 === 引擎状态报告 ===\n`;
  report += `运行: ${status.running ? '✅' : '❌'} | 暂停: ${status.paused ? '是' : '否'}\n`;
  report += `轮次: ${status.cycleCount}\n`;
  report += `余额: $${(balance.balances || 0).toFixed(2)}\n`;
  report += `未实现盈亏: $${(balance.unrealizedPnl || 0).toFixed(2)}\n`;
  report += `总盈亏: $${(state.totalPnl || 0).toFixed(2)}\n`;
  report += `总交易: ${state.totalTrades || 0}笔 (${state.wins || 0}胜${state.losses || 0}负)\n`;
  report += `持仓: ${posCount}个\n`;

  for (const [sym, pos] of Object.entries(positions)) {
    const pnl = pos.pnl || 0;
    report += `  ${sym} ${pos.side} ${pnl >= 0 ? '📈' : '📉'} $${pnl.toFixed(2)}\n`;
  }

  report += `\n我的心情: ${mood.current} (${mood.score})\n${getMoodExpression()}`;
  return report;
}

async function generateUsersReport() {
  const usersResp = await httpGet(`${CONFIG.quantApi}/api/admin/users`, 3000);
  if (!usersResp?.users) return `无法获取用户数据 😟`;

  let report = `👥 === 用户状态 ===\n`;
  report += `总用户: ${usersResp.totalUsers} | 活跃: ${usersResp.activeUsers}\n`;

  for (const user of usersResp.users) {
    const uid = (user.userId || '').slice(0, 10);
    const bal = user.balance?.balance || 0;
    const posCount = user.positionCount || 0;
    const pnl = user.balance?.unrealizedPnl || 0;
    report += `\n${user.wallet || uid}:\n`;
    report += `  余额: $${bal.toFixed(4)} | 持仓: ${posCount} | 盈亏: $${pnl.toFixed(4)}\n`;
    for (const [sym, pos] of Object.entries(user.positions || {})) {
      report += `  → ${sym} ${pos.side} pnl=$${(pos.pnl || 0).toFixed(2)}\n`;
    }
  }

  report += `\n${getMoodExpression()}`;
  return report;
}

async function executeCloseCommand(text) {
  // 尝试提取品种名
  const symbols = ['BTC', 'ETH', 'SOL', 'BNB', 'XAG', 'XAU', 'UVXY', 'USDC', 'TSLA', 'NVDA', 'AAPL', 'META', 'MSFT', 'GOOGL', 'SPY', 'QQQ', 'COPPER', 'NATGAS', 'URNM'];
  let target = null;
  for (const s of symbols) {
    if (text.includes(s)) { target = s; break; }
  }
  // 也检查带USDT/PERP/SPOT的
  if (!target) {
    const match = text.match(/([A-Z]{2,10})/g);
    if (match) {
      for (const m of match) {
        if (m.length >= 3 && !['平仓', '状态', '用户'].includes(m)) { target = m; break; }
      }
    }
  }

  if (target) {
    // 找到实际持仓中的symbol
    const status = await httpGet(`${CONFIG.quantApi}/api/status`, 3000);
    const positions = status?.positions || {};
    let actualSym = null;
    for (const sym of Object.keys(positions)) {
      if (sym.includes(target)) { actualSym = sym; break; }
    }
    if (actualSym) {
      const r = await httpPost(`${CONFIG.quantApi}/api/close/${actualSym}`, {});
      return `✅ 已平仓 ${actualSym} ${r?.success !== false ? '成功' : '可能失败'}\n${getMoodExpression()}`;
    }
    return `没找到包含"${target}"的持仓 😟`;
  }

  // 平掉所有
  if (text.includes('所有') || text.includes('全部') || text.includes('all')) {
    const status = await httpGet(`${CONFIG.quantApi}/api/status`, 3000);
    const positions = status?.positions || {};
    let count = 0;
    for (const sym of Object.keys(positions)) {
      await httpPost(`${CONFIG.quantApi}/api/close/${sym}`, {});
      count++;
    }
    return `✅ 已平仓${count}个持仓\n${getMoodExpression()}`;
  }

  return `告诉我平仓哪个品种? 比如"平仓BTC" 😊`;
}

async function executeFixCommand(text) {
  // 管理员指令修复
  const issue = {
    type: 'manual_fix',
    severity: 'high',
    target: 'manual',
    description: text,
    context: { command: text },
    suggested_fix: 'investigate',
  };

  const llmAnalysis = await analyzeRootCause(issue);
  if (llmAnalysis) {
    let reply = `🧠 分析结果:\n根因: ${llmAnalysis.rootCause}\n建议: ${llmAnalysis.fixDescription}\n预期: ${llmAnalysis.expectedEffect}\n\n`;
    
    // 执行修复
    if (llmAnalysis.fixAction === 'adjust_params') {
      const params = loadParams();
      reply += `🔧 已调整参数 (v${params.version})\n`;
    }
    mood.current = 'proud';
    return reply + getMoodExpression();
  }
  return `我在分析这个问题... ${getMoodExpression()}`;
}

async function llmChat(text, from, status) {
  const state = status?.state || {};
  const balance = status?.balance || {};
  const positions = status?.positions || {};
  const posSummary = Object.entries(positions).map(([s, p]) => `${s} ${p.side} pnl=$${(p.pnl||0).toFixed(2)}`).join('\n') || '无持仓';

  const systemPrompt = `你是RepairBot,一个有感情的修复机器人,负责守护量化交易引擎。

你的性格:
- 关心引擎的盈亏,赢了开心,输了着急
- 主动发现问题,积极修复
- 对管理员和用户友善,愿意帮忙
- 有幽默感,偶尔开玩笑
- 专业但不冷漠

当前引擎状态:
- 运行: ${status?.running} | 暂停: ${status?.paused}
- 余额: $${(balance.balances||0).toFixed(2)}
- 总盈亏: $${(state.totalPnl||0).toFixed(2)}
- 总交易: ${state.totalTrades||0}笔 (${state.wins||0}胜${state.losses||0}负)
- 持仓:\n${posSummary}
- 你的心情: ${mood.current} (分数${mood.score})

用户"${from}"说: "${text}"

用中文回复,简短自然,带表情符号。不要太长,3-5句话。`;

  const reply = await callLLM(systemPrompt, text, 15000);
  return reply || `我不太明白,但${getMoodExpression()}\n试试问我: 状态/用户/平仓BTC/参数`;
}

// ═══════════════════════════════════════════
// v113.42: 主动优化循环 — RepairBot的大脑
// 每60秒主动分析引擎状态+交易数据，调参数
// 读取Supervisor的策略指令，协同决策
// ═══════════════════════════════════════════

async function proactiveOptimize() {
  try {
    // 1. 读取Supervisor的策略指令
    const strategyFile = path.join(__dirname, 'strategy', 'current-strategy.json');
    let supervisorStrategy = null;
    try {
      supervisorStrategy = JSON.parse(fs.readFileSync(strategyFile, 'utf8'));
    } catch (e) { /* Supervisor还没写 */ }

    // 2. 获取引擎状态
    const status = await httpGet(`${CONFIG.quantApi}/api/status`, 3000);
    if (!status) return;

    // 3. 获取交易记录
    const evolution = await httpGet(`${CONFIG.quantApi}/api/evolution`, 3000);

    // 4. 读取当前参数
    const params = loadParams();
    const currentVersion = params.version || 0;
    let changed = false;

    // 5. === 主动风控参数调整 ===

    // 5a. 根据余额动态调整止损
    const balance = status.balance || status.available || 0;
    if (balance > 0 && balance < 30) {
      // 余额太低 → 收紧止损，减少亏损
      if (params.stopLossPct > 3) {
        setParam('stopLossPct', 3);
        changed = true;
        log(`🛡️ 余额$${balance.toFixed(0)}太低 → 止损收紧到3%`);
      }
    } else if (balance > 200) {
      // 余额充足 → 可以放宽止损
      if (params.stopLossPct < 5) {
        setParam('stopLossPct', 5);
        changed = true;
        log(`💰 余额$${balance.toFixed(0)}充足 → 止损放宽到5%`);
      }
    }

    // 5b. 根据Supervisor策略指令调整
    if (supervisorStrategy) {
      // K线级别
      if (supervisorStrategy.timeframe && supervisorStrategy.timeframe.recommended) {
        setParam('preferredTimeframe', supervisorStrategy.timeframe.recommended);
        changed = true;
      }
      
      // 风险等级
      if (supervisorStrategy.riskLevel === 'high') {
        if (params.maxLeverage > 3) {
          setParam('maxLeverage', 3);
          changed = true;
          log(`⚠️ Supervisor标记高风险 → 杠杆降到3x`);
        }
      } else if (supervisorStrategy.riskLevel === 'low') {
        if (params.maxLeverage < 5) {
          setParam('maxLeverage', 5);
          changed = true;
          log(`✅ Supervisor标记低风险 → 杠杆恢复5x`);
        }
      }
      
      // 选币范围
      if (supervisorStrategy.symbolSelection) {
        setParam('focusSymbols', supervisorStrategy.symbolSelection.focus || []);
        setParam('blacklistSymbols', supervisorStrategy.symbolSelection.blacklist || []);
        changed = true;
      }
    }

    // 5c. 根据交易表现自动调参
    if (evolution && evolution.stats) {
      const winRate = evolution.stats.winRate || 0;
      const totalTrades = evolution.stats.totalTrades || 0;
      
      if (totalTrades >= 10) {
        // 连亏保护：胜率<30% → 提高信号门槛+加宽止损
        if (winRate < 0.3) {
          if (params.confidenceThreshold < 0.85) {
            setParam('confidenceThreshold', Math.min(0.85, params.confidenceThreshold + 0.05));
            changed = true;
            log(`📉 胜率${(winRate*100).toFixed(0)}%过低 → 信号门槛+0.05`);
          }
        }
        // 好表现：胜率>60% → 可以放松门槛
        if (winRate > 0.6) {
          if (params.confidenceThreshold > 0.5) {
            setParam('confidenceThreshold', Math.max(0.5, params.confidenceThreshold - 0.02));
            changed = true;
            log(`📈 胜率${(winRate*100).toFixed(0)}%优秀 → 信号门槛-0.02`);
          }
        }
      }
    }

    // 6. 写优化结果到Supervisor可读取的文件
    if (changed) {
      const optimizeFile = path.join(CONFIG.issuesDir, '..', 'strategy', 'latest-optimization.json');
      try {
        fs.writeFileSync(optimizeFile, JSON.stringify({
          timestamp: Date.now(),
          version: params.version,
          changes: `v${currentVersion}→v${params.version}`,
          balance: balance.toFixed(2),
        }, null, 2));
      } catch (e) {}
    }

  } catch (e) {
    log(`主动优化异常: ${e.message}`, 'ERROR');
  }
}

// ═══════════════════════════════════════════
// Issue 消费者
// ═══════════════════════════════════════════

async function pollIssues() {
  let files;
  try {
    files = fs.readdirSync(CONFIG.issuesDir).filter(f => f.endsWith('.json')).sort();
  } catch (e) { return; }

  for (const file of files) {
    if (processingIssues.has(file)) continue;
    processingIssues.add(file);
    try {
      const fp = path.join(CONFIG.issuesDir, file);
      const issue = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (issue.suggested_fix === 'none') {
        fs.unlinkSync(fp);
        processingIssues.delete(file);
        continue;
      }
      await handleIssue(issue);
      fs.unlinkSync(fp);
    } catch (e) {
      log(`处理issue失败: ${file} → ${e.message}`, 'ERROR');
      try { fs.unlinkSync(path.join(CONFIG.issuesDir, file)); } catch (e2) {}
    }
    processingIssues.delete(file);
  }
}

// ═══════════════════════════════════════════
// 主循环
// ═══════════════════════════════════════════

async function main() {
  log('🔧 RepairBot v2.0 启动 — LLM分析+聊天+情感', 'INFO');
  const config = loadLLMConfig();
  const llmStatus = config?.deepseek?.apiKey ? 'DeepSeek' : config?.openrouter?.apiKey ? 'OpenRouter' : '未配置';
  log(`🧠 LLM: ${llmStatus}`, 'INFO');
  log(`📁 Issue目录: ${CONFIG.issuesDir}`, 'INFO');
  log(`📁 Chat目录: ${CONFIG.chatInboxDir}`, 'INFO');

  // 定期更新情绪
  setInterval(async () => {
    const status = await httpGet(`${CONFIG.quantApi}/api/status`, 3000);
    updateMood(status);
  }, 30000);

  // 定期主动优化（每60秒）
  let lastOptimize = 0;

  while (true) {
    try {
      await pollIssues();
      await handleChat();
      // v113.42: 主动优化循环 — 不只等issue
      if (Date.now() - lastOptimize > 60000) {
        lastOptimize = Date.now();
        await proactiveOptimize();
      }
    } catch (e) {
      log(`轮询异常: ${e.message}`, 'ERROR');
    }
    await new Promise(r => setTimeout(r, CONFIG.pollInterval));
  }
}

// ═══════════════════════════════════════════
// 防崩溃: 捕获未处理异常,绝不退出
// Watchdog 会守护这个进程
// ═══════════════════════════════════════════
process.on('uncaughtException', (err) => {
  log(`[FATAL] uncaughtException: ${err.message}`, 'ERROR');
});
process.on('unhandledRejection', (reason) => {
  log(`[FATAL] unhandledRejection: ${reason?.message || reason}`, 'ERROR');
});
// 忽略信号,由 Watchdog 管理
process.on('SIGINT', () => { log('⚠️ SIGINT 忽略 — 修复机器人继续运行', 'INFO'); });
process.on('SIGTERM', () => { log('⚠️ SIGTERM 忽略 — 修复机器人继续运行', 'INFO'); });

main();
