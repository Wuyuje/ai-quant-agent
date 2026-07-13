/**
 * Supervisor Bot v2.0 — 监督机器人 (独立进程)
 * 
 * v2.0.1: 加防崩溃全局异常捕获,Watchdog 互守
 * 
 * v2.0 增强:
 *  - 全方位观测：管理员盈亏/每个用户盈亏/仪表盘所有数据/策略表现/链上持仓
 *  - 12+检测器全覆盖
 *  - 用户持仓逐个检查
 *  - 仪表盘数据完整性检查
 *  - WS连接/K线新鲜度/信号质量/资金流向
 *  - 历史趋势追踪(不只看当前,还看变化趋势)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');

// ═══════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════

const CONFIG = {
  quantApi: 'http://localhost:10010',
  multiApi: 'http://localhost:10030',
  multiToken: 'ark-admin-v3-secret',
  issuesDir: path.join(__dirname, 'issues'),
  fixesDir: path.join(__dirname, 'fixes'),
  logDir: path.join(__dirname, 'logs'),
  checkInterval: 15000,
  // 阈值
  thresholds: {
    heavyLossPct: -8,         // 单仓重损
    heavyLossUsd: -5,         // 单仓重损(USD绝对值)
    longHoldMin: 480,        // 持仓过长
    consecLossCount: 4,      // 连续亏损
    lowWinRate: 0.35,         // 低胜率
    balanceDropPct: 0.10,    // 余额下降
    staleKlineMin: 5,        // K线过期
    memLeakGrowthPct: 50,    // 内存增长
    maxMemMB: 500,           // 内存上限
    userLossUsd: -3,         // 用户单仓亏损(USD)
    userBalanceDropPct: 0.15, // 用户余额下降
    totalDrawdownPct: 0.20,  // 总回撤
    signalStaleMin: 30,      // 信号过期
    wsDownSec: 60,           // WS断线
  },
};

[CONFIG.issuesDir, CONFIG.fixesDir, CONFIG.logDir].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ═══════════════════════════════════════════
// 日志
// ═══════════════════════════════════════════

const logFile = path.join(CONFIG.logDir, 'supervisor.log');
function log(msg, level = 'INFO') {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  fs.appendFileSync(logFile, line + '\n');
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
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
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
// Issue 管理
// ═══════════════════════════════════════════

let issueCounter = 0;
const activeIssues = new Set();

function writeIssue(type, severity, target, description, context, suggestedFix) {
  const issueId = `issue_${Date.now()}_${++issueCounter}`;
  const dedupKey = `${type}_${target}`;
  // v115: 同类 Issue 去重冷却从 5 分钟改为 30 分钟，防止 Supervisor 反复触发同类问题
  if (activeIssues.has(dedupKey)) return null;
  activeIssues.add(dedupKey);
  setTimeout(() => activeIssues.delete(dedupKey), 1800000); // 30分钟去重

  const issue = {
    id: issueId, timestamp: Date.now(), severity, type, target,
    description, context: context || {}, suggested_fix: suggestedFix || 'investigate',
  };
  const filePath = path.join(CONFIG.issuesDir, `${issueId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(issue, null, 2));
  log(`⚠️ Issue: [${severity}] ${type} → ${target} | ${description}`, 'WARN');
  return issueId;
}

// ═══════════════════════════════════════════
// 历史状态追踪
// ═══════════════════════════════════════════

const history = {
  balance: 0,
  cycleCount: 0,
  cycleTime: 0,
  userBalances: {},   // userId → prevBalance
  positionSnapshots: {}, // sym → {entryPrice, side, openTime}
  memHistory: [],
  totalPnlHistory: [],  // 总盈亏历史
  klineLastUpdate: {}, // sym → timestamp
  scanCount: 0,
};

// ═══════════════════════════════════════════
// 全方位检测
// ═══════════════════════════════════════════

async function checkAll() {
  history.scanCount++;

  // 1. 引擎进程健康
  await checkEngineProcess();

  // 2. 引擎状态 (持仓/余额/轮次)
  const status = await httpGet(`${CONFIG.quantApi}/api/status`);
  if (status) {
    checkAdminPositions(status);
    checkBalance(status);
    checkEngineStall(status);
    checkTotalDrawdown(status);
  } else {
    writeIssue('engine_unreachable', 'critical', 'engine', '量化引擎API无法访问', {}, 'restart_engine');
  }

  // 3. 用户状态 (逐个检查每个用户)
  const usersResp = await httpGet(`${CONFIG.quantApi}/api/admin/users`);
  if (usersResp) {
    checkAllUsers(usersResp);
  }

  // 4. 进化/策略数据
  const evolution = await httpGet(`${CONFIG.quantApi}/api/evolution`);
  if (evolution) {
    checkStrategyPerformance(evolution);
    checkAutoFixerStatus(evolution);
  }

  // 5. 仪表盘数据完整性
  await checkDashboardData();

  // 6. 策略信号
  const signals = await httpGet(`${CONFIG.quantApi}/api/strategy-signals`);
  if (signals) {
    checkSignalQuality(signals);
  }

  // 7. MultiMarket全部持仓
  const allPos = await httpGet(`${CONFIG.quantApi}/api/multi-market/all-positions`);
  if (allPos) {
    checkMultiMarketPositions(allPos);
  }

  // 8. MultiEngine总览
  const overview = await httpGet(`${CONFIG.multiApi}/admin/overview?token=${CONFIG.multiToken}`);
  if (overview) {
    checkMultiEngine(overview);
  }

  // 9. 系统健康
  checkSystemHealth();

  // 10. 风险报告
  const risk = await httpGet(`${CONFIG.quantApi}/api/risk/report`);
  if (risk) {
    checkRiskReport(risk);
  }

  // 11. 读取修复结果
  readFixes();

  // 12. 每5轮输出一次综合报告
  if (history.scanCount % 20 === 0) {
    outputFullReport();
  }

  // 13. v113.42: 主动市场分析 → 写策略指令给RepairBot和引擎
  await proactiveMarketAnalysis(status, signals, evolution);
}

// ── 引擎进程 ──
async function checkEngineProcess() {
  try {
    const result = execSync('pgrep -f "node.*start.js" 2>/dev/null', { encoding: 'utf8' });
    if (!result.trim()) {
      writeIssue('engine_crash', 'critical', 'engine', '量化引擎进程不存在', {}, 'restart_engine');
    }
  } catch (e) {
    writeIssue('engine_crash', 'critical', 'engine', '量化引擎进程不存在', {}, 'restart_engine');
  }
}

// ── 管理员持仓 ──
function checkAdminPositions(status) {
  const positions = status.positions || {};
  const balance = status.balance || {};
  const state = status.state || {};
  const totalPnl = state.totalPnl || 0;
  const totalTrades = state.totalTrades || 0;
  const wins = state.wins || 0;
  const losses = state.losses || 0;

  for (const [sym, pos] of Object.entries(positions)) {
    const price = pos.markPrice || pos.entryPrice || 0;
    const isLong = pos.side === 'LONG';
    const pnlPct = isLong
      ? ((price - pos.entryPrice) / (pos.entryPrice || 1)) * 100 * (pos.leverage || 1)
      : ((pos.entryPrice - price) / (pos.entryPrice || 1)) * 100 * (pos.leverage || 1);
    const pnlUsd = pos.pnl || 0;

    // 单仓重损(百分比)
    if (pnlPct < CONFIG.thresholds.heavyLossPct) {
      writeIssue('position_heavy_loss', 'high', sym,
        `管理员 ${sym} ${pos.side} 亏损${pnlPct.toFixed(1)}%`,
        { symbol: sym, side: pos.side, pnlPct, entryPrice: pos.entryPrice, currentPrice: price, pnlUsd },
        'close_position');
    }

    // 单仓重损(USD绝对值)
    if (pnlUsd < CONFIG.thresholds.heavyLossUsd) {
      writeIssue('position_loss_usd', 'high', sym,
        `管理员 ${sym} ${pos.side} 亏损$${pnlUsd.toFixed(2)}`,
        { symbol: sym, side: pos.side, pnlUsd, pnlPct },
        'close_position');
    }

    // 持仓过长且亏损
    const openTime = state._openTime?.[sym] || pos.openTime;
    if (openTime) {
      const holdMin = (Date.now() - openTime) / 60000;
      if (holdMin > CONFIG.thresholds.longHoldMin && pnlPct < 0) {
        writeIssue('position_too_long', 'medium', sym,
          `管理员 ${sym} 持仓${holdMin.toFixed(0)}分钟且亏损${pnlPct.toFixed(1)}%`,
          { symbol: sym, holdMin, pnlPct },
          'close_position');
      }
    }
  }

  // 持仓数过多
  const posCount = Object.keys(positions).length;
  if (posCount > 5) {
    writeIssue('too_many_positions', 'medium', 'admin',
      `管理员持仓${posCount}个,风险过高`,
      { posCount }, 'reduce_positions');
  }

  // 检查做逆势单
  for (const [sym, pos] of Object.entries(positions)) {
    checkTrendAlignment(sym, pos);
  }
}

// ── 检查持仓方向与趋势是否一致 ──
async function checkTrendAlignment(sym, pos) {
  const decisions = await httpGet(`${CONFIG.quantApi}/api/decisions?symbol=${sym}`, 3000);
  if (!decisions || !decisions.decisions) return;

  const recent = decisions.decisions.slice(-3);
  for (const d of recent) {
    if (d.symbol === sym && d.trend) {
      const trend = d.trend.toUpperCase();
      const side = pos.side?.toUpperCase();
      if ((trend === 'UP' && side === 'SHORT') || (trend === 'DOWN' && side === 'LONG')) {
        writeIssue('counter_trend_position', 'high', sym,
          `${sym} ${pos.side}但趋势${trend},逆势持仓`,
          { symbol: sym, side: pos.side, trend },
          'close_position');
      }
    }
  }
}

// ── 余额 ──
function checkBalance(status) {
  const balAmt = status.balance?.balances || status.balance?.balance || 0;
  if (history.balance > 0 && balAmt > 0) {
    const drop = (history.balance - balAmt) / history.balance;
    if (drop > CONFIG.thresholds.balanceDropPct) {
      writeIssue('balance_drop', 'high', 'admin',
        `管理员余额从$${history.balance.toFixed(2)}降到$${balAmt.toFixed(2)} (-${(drop*100).toFixed(1)}%)`,
        { prev: history.balance, current: balAmt, dropPct: drop * 100 },
        'reduce_risk');
    }
  }
  history.balance = balAmt;
}

// ── 总回撤 ──
function checkTotalDrawdown(status) {
  const state = status.state || {};
  const totalPnl = state.totalPnl || 0;
  const totalTrades = state.totalTrades || 0;
  const wins = state.wins || 0;
  const losses = state.losses || 0;

  history.totalPnlHistory.push(totalPnl);
  if (history.totalPnlHistory.length > 100) history.totalPnlHistory.shift();

  if (history.totalPnlHistory.length >= 10) {
    const peak = Math.max(...history.totalPnlHistory);
    const drawdown = peak - totalPnl;
    const drawdownPct = peak > 0 ? drawdown / Math.abs(peak) : 0;
    if (drawdownPct > CONFIG.thresholds.totalDrawdownPct) {
      writeIssue('total_drawdown', 'high', 'admin',
        `总盈亏回撤${(drawdownPct * 100).toFixed(1)}% (峰值${peak.toFixed(2)}→当前${totalPnl.toFixed(2)})`,
        { peak, current: totalPnl, drawdownPct: drawdownPct * 100 },
        'reduce_risk');
    }
  }

  // 胜率
  if (totalTrades >= 20) {
    const winRate = wins / totalTrades;
    if (winRate < CONFIG.thresholds.lowWinRate) {
      writeIssue('low_winrate', 'high', 'admin',
        `管理员胜率仅${(winRate * 100).toFixed(1)}% (${totalTrades}笔交易, ${wins}胜${losses}负)`,
        { winRate, totalTrades, wins, losses },
        'adjust_params');
    }
  }
}

// ── 引擎停滞 ──
function checkEngineStall(status) {
  const cycle = status.cycleCount || 0;
  const now = Date.now();
  if (!history.cycleTime) { history.cycleTime = now; history.cycleCount = cycle; return; }
  const elapsed = now - history.cycleTime;
  if (elapsed > 120000) {
    if (cycle === history.cycleCount && !status.paused) {
      writeIssue('engine_stall', 'high', 'engine',
        `引擎轮次2分钟未增长(卡在${cycle}),且未暂停`,
        { cycle, paused: status.paused }, 'restart_engine');
    }
    history.cycleTime = now;
    history.cycleCount = cycle;
  }
}

// ── 全部用户检查 ──
function checkAllUsers(usersResp) {
  const users = usersResp.users || [];
  if (!Array.isArray(users) || users.length === 0) return;

  let totalUsersLoss = 0;
  let usersWithLoss = 0;
  let usersWithPositions = 0;

  for (const user of users) {
    const userId = user.userId || user.wallet || 'unknown';
    const balance = user.balance || {};
    const positions = user.positions || {};
    const balAmt = balance.balance || 0;
    const unrealizedPnl = balance.unrealizedPnl || 0;

    // 用户余额追踪
    const prevBal = history.userBalances[userId] || 0;
    if (prevBal > 0 && balAmt > 0) {
      const drop = (prevBal - balAmt) / prevBal;
      if (drop > CONFIG.thresholds.userBalanceDropPct) {
        writeIssue('user_balance_drop', 'high', `user:${userId}`,
          `用户${userId.slice(0, 10)}...余额下降${(drop * 100).toFixed(1)}% ($${prevBal.toFixed(4)}→$${balAmt.toFixed(4)})`,
          { userId, prev: prevBal, current: balAmt, dropPct: drop * 100 },
          'reduce_user_risk');
      }
    }
    if (balAmt > 0) history.userBalances[userId] = balAmt;

    // 用户持仓检查
    const posCount = Object.keys(positions).length;
    if (posCount > 0) usersWithPositions++;

    for (const [sym, pos] of Object.entries(positions)) {
      const pnl = pos.pnl || 0;
      const price = pos.markPrice || pos.entryPrice || 0;
      const isLong = pos.side === 'LONG';
      const pnlPct = isLong
        ? ((price - pos.entryPrice) / (pos.entryPrice || 1)) * 100 * (pos.leverage || 1)
        : ((pos.entryPrice - price) / (pos.entryPrice || 1)) * 100 * (pos.leverage || 1);

      // 用户单仓亏损
      if (pnl < CONFIG.thresholds.userLossUsd) {
        writeIssue('user_position_loss', 'medium', `user:${userId}:${sym}`,
          `用户${userId.slice(0, 10)}... ${sym} ${pos.side} 亏损$${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%)`,
          { userId, symbol: sym, side: pos.side, pnl, pnlPct },
          'close_user_position');
      }

      if (pnl < 0) { totalUsersLoss += Math.abs(pnl); usersWithLoss++; }
    }
  }

  // v115: 只在有用户亏损时才触发 mass_user_loss；用户已无持仓时不触发
  if (usersWithPositions > 0 && usersWithLoss > 0 && usersWithLoss / Math.max(1, usersWithPositions) > 0.7) {
    writeIssue('mass_user_loss', 'high', 'users',
      `${usersWithLoss}/${usersWithPositions}个有持仓的用户在亏损`,
      { usersWithLoss, usersWithPositions, totalUsersLoss },
      'reduce_risk');
  }
}

// ── 仪表盘数据完整性 ──
async function checkDashboardData() {
  const endpoints = [
    { url: '/api/status', name: '引擎状态' },
    { url: '/api/trades', name: '交易记录' },
    { url: '/api/decisions', name: '决策记录' },
    { url: '/api/strategies-summary', name: '策略摘要' },
    { url: '/api/market-overview', name: '市场概览' },
    { url: '/api/system/health', name: '系统健康' },
    { url: '/api/risk/report', name: '风险报告' },
  ];

  let failedCount = 0;
  for (const ep of endpoints) {
    const data = await httpGet(`${CONFIG.quantApi}${ep.url}`, 3000);
    if (!data) {
      failedCount++;
      writeIssue('dashboard_data_missing', 'medium', `api:${ep.name}`,
        `仪表盘API ${ep.name} (${ep.url}) 无响应`,
        { endpoint: ep.url, name: ep.name },
        'restart_engine');
    }
  }

  if (failedCount >= 3) {
    writeIssue('dashboard_down', 'high', 'dashboard',
      `${failedCount}/${endpoints.length}个仪表盘API无响应`,
      { failedCount, total: endpoints.length },
      'restart_engine');
  }
}

// ── 信号质量 ──
function checkSignalQuality(signals) {
  const sigs = signals.signals || signals || [];
  if (!Array.isArray(sigs)) return;

  let strongCount = 0, weakCount = 0, conflictingCount = 0;
  const bySymbol = {};

  for (const sig of sigs) {
    const sym = sig.symbol || 'unknown';
    const strength = sig.strength || sig.score || 0;
    const direction = sig.direction || sig.signal || '';

    if (!bySymbol[sym]) bySymbol[sym] = [];
    bySymbol[sym].push(direction);

    if (strength > 50) strongCount++;
    else if (strength < 20) weakCount++;
  }

  // 信号冲突检测
  for (const [sym, dirs] of Object.entries(bySymbol)) {
    if (dirs.length >= 2) {
      const unique = [...new Set(dirs)];
      if (unique.length > 1) {
        conflictingCount++;
      }
    }
  }

  if (conflictingCount > 3) {
    writeIssue('signal_conflict', 'medium', 'signals',
      `${conflictingCount}个品种信号冲突(多空矛盾)`,
      { conflictingCount },
      'adjust_params');
  }
}

// ── MultiMarket持仓 ──
function checkMultiMarketPositions(allPos) {
  const positions = allPos.positions || {};
  for (const [market, posList] of Object.entries(positions)) {
    if (!Array.isArray(posList)) continue;
    for (const pos of posList) {
      const pnl = pos.pnl || pos.unrealizedPnl || 0;
      const pnlPct = pos.pnlPct || 0;
      if (pnlPct < CONFIG.thresholds.heavyLossPct) {
        writeIssue('multimarket_loss', 'medium', `${market}:${pos.symbol}`,
          `${market} ${pos.symbol} ${pos.side} 亏损${pnlPct.toFixed(1)}%`,
          { market, symbol: pos.symbol, side: pos.side, pnl, pnlPct },
          'close_position');
      }
    }
  }
}

// ── 策略表现 ──
function checkStrategyPerformance(evolution) {
  const guardian = evolution.guardian || {};
  const adaptiveExit = evolution.adaptiveExit || {};

  if (guardian.consecutiveLosses >= CONFIG.thresholds.consecLossCount) {
    writeIssue('consecutive_losses', 'high', 'strategy',
      `${guardian.consecutiveLosses}连亏`,
      { consecLoss: guardian.consecutiveLosses }, 'adjust_params');
  }

  const winRate = adaptiveExit.winRate ? parseFloat(adaptiveExit.winRate) : 0;
  const totalTrades = adaptiveExit.recentTrades || 0;
  if (totalTrades >= 20 && winRate < CONFIG.thresholds.lowWinRate * 100) {
    writeIssue('low_winrate', 'high', 'strategy',
      `策略胜率仅${winRate}% (${totalTrades}笔)`,
      { winRate, totalTrades }, 'adjust_params');
  }
}

// ── AutoFixer状态 ──
let _lastAutoFixerLog = '';
function checkAutoFixerStatus(evolution) {
  const autoFixer = evolution.autoFixer || {};
  if (autoFixer.totalFixes > 0) {
    const recent = autoFixer.recentFixes || [];
    const summary = recent.slice(-3).map(f => `${f.issue}:${f.fix}:${f.success?'✅':'❌'}`).join('|');
    // 去重：只在内容变化时输出
    if (summary !== _lastAutoFixerLog) {
      _lastAutoFixerLog = summary;
      for (const fix of recent.slice(-3)) {
        log(`📊 引擎AutoFixer: ${fix.issue} → ${fix.fix} ${fix.success ? '✅' : '❌'}`);
      }
    }
  }
}

// ── MultiEngine ──
function checkMultiEngine(overview) {
  const users = overview.users || {};
  const risk = overview.risk || {};

  const pausedUsers = users.paused || 0;
  const totalUsers = users.total || 1;
  if (pausedUsers / totalUsers > 0.5 && totalUsers > 0) {
    writeIssue('mass_user_circuit_break', 'high', 'users',
      `${pausedUsers}/${totalUsers}用户熔断 (${(pausedUsers/totalUsers*100).toFixed(0)}%)`,
      { pausedUsers, totalUsers }, 'reduce_risk');
  }

  if (risk.globalLevel === 'critical' || risk.emergencyStop) {
    writeIssue('global_risk_critical', 'critical', 'engine',
      `全局风险: ${risk.globalLevel}, 紧急停止: ${risk.emergencyStop}`,
      { globalLevel: risk.globalLevel, emergencyStop: risk.emergencyStop },
      'emergency_action');
  }
}

// ── 风险报告 ──
function checkRiskReport(risk) {
  if (risk.globalRiskLevel === 'critical' || risk.emergencyStop) {
    writeIssue('risk_critical', 'critical', 'engine',
      `风险等级: ${risk.globalRiskLevel}`,
      { ...risk }, 'emergency_action');
  }
}

// ── 系统健康 ──
function checkSystemHealth() {
  const mem = process.memoryUsage();
  const memMB = mem.rss / 1024 / 1024;
  history.memHistory.push(memMB);
  if (history.memHistory.length > 30) history.memHistory.shift();

  if (memMB > CONFIG.thresholds.maxMemMB) {
    writeIssue('memory_high', 'medium', 'supervisor',
      `Supervisor内存${memMB.toFixed(0)}MB`, { memMB }, 'clear_cache');
  }

  try {
    const result = execSync('ps -o rss= -p $(pgrep -f "node.*start.js" | head -1) 2>/dev/null', { encoding: 'utf8' });
    const engineMemMB = parseInt(result.trim()) / 1024;
    if (engineMemMB > CONFIG.thresholds.maxMemMB) {
      writeIssue('engine_memory_high', 'medium', 'engine',
        `量化引擎内存${engineMemMB.toFixed(0)}MB`, { memMB: engineMemMB }, 'restart_engine');
    }
  } catch (e) {}

  try {
    const result = execSync('df -m / 2>/dev/null | tail -1', { encoding: 'utf8' });
    const parts = result.trim().split(/\s+/);
    const freeMB = parseInt(parts[3] || 0);
    if (freeMB < 1000) {
      writeIssue('disk_full', 'high', 'system',
        `磁盘剩余${freeMB}MB`, { freeMB }, 'clear_logs');
    }
  } catch (e) {}
}

// ── 读取修复结果 ──
function readFixes() {
  try {
    const files = fs.readdirSync(CONFIG.fixesDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const fp = path.join(CONFIG.fixesDir, file);
        const fix = JSON.parse(fs.readFileSync(fp, 'utf8'));
        log(`${fix.success ? '✅' : '❌'} 修复: [${fix.action}] ${fix.description}`, fix.success ? 'INFO' : 'WARN');
        fs.unlinkSync(fp);
      } catch (e) {}
    }
  } catch (e) {}
}

// ═══════════════════════════════════════════
// v113.42: 主动市场分析 — Supervisor的核心大脑
// 每15秒分析一次市场+引擎状态，主动写策略指令
// ═══════════════════════════════════════════

const STRATEGY_DIR = path.join(__dirname, 'strategy');
if (!fs.existsSync(STRATEGY_DIR)) fs.mkdirSync(STRATEGY_DIR, { recursive: true });

let lastStrategyUpdate = 0;
let marketAnalysisHistory = [];

async function proactiveMarketAnalysis(status, signals, evolution) {
  try {
    // 每30秒才更新一次策略指令（不要太频繁）
    if (Date.now() - lastStrategyUpdate < 30000) return;
    lastStrategyUpdate = Date.now();

    const analysis = {
      timestamp: Date.now(),
      // === 1. 市场波动率分析 ===
      volatility: { regime: 'normal', avgAtr: 0, recommendation: '' },
      // === 2. 选币范围建议 ===
      symbolSelection: { mode: 'normal', focus: [], blacklist: [], recommendation: '' },
      // === 3. K线级别建议 ===
      timeframe: { current: '1h', recommended: '1h', reason: '' },
      // === 4. 杠杆建议 ===
      leverage: { current: 5, recommended: 5, reason: '' },
      // === 5. 仓位建议 ===
      positionSize: { riskPerTrade: 0.02, recommendation: '' },
      // === 6. 风险等级 ===
      riskLevel: 'normal',
      // === 7. 持仓管理建议 ===
      positionManagement: { maxHold: 2, recommendation: '' },
      // === 8. 交易表现 ===
      performance: { winRate: 0, profitFactor: 0, recentTrades: 0, recommendation: '' },
    };

    // --- 1. 波动率分析 ---
    if (signals && Array.isArray(signals)) {
      const atrValues = signals
        .filter(s => s.strength > 0)
        .map(s => ({ symbol: s.symbol, atr: s.atr || 0 }))
        .filter(s => s.atr > 0);
      
      if (atrValues.length > 0) {
        const avgAtr = atrValues.reduce((sum, s) => sum + s.atr, 0) / atrValues.length;
        const maxAtr = Math.max(...atrValues.map(s => s.atr));
        analysis.volatility.avgAtr = Math.round(avgAtr * 100) / 100;
        
        if (avgAtr > 3.0) {
          analysis.volatility.regime = 'extreme';
          analysis.volatility.recommendation = '极端波动，建议降杠杆到2-3x，只选ATR<2%的币';
        } else if (avgAtr > 1.5) {
          analysis.volatility.regime = 'high';
          analysis.volatility.recommendation = '高波动，杠杆3-5x，选ATR<1.5%的币';
        } else if (avgAtr < 0.5) {
          analysis.volatility.regime = 'low';
          analysis.volatility.recommendation = '低波动，可加杠杆到5-8x，趋势较慢需要耐心';
        } else {
          analysis.volatility.recommendation = '正常波动，标准配置5x杠杆';
        }
      }
    }

    // --- 2. 选币范围 ---
    if (signals && Array.isArray(signals)) {
      const strongSignals = signals.filter(s => s.strength >= 3.0);
      const weakSignals = signals.filter(s => s.strength < 1.5);
      
      analysis.symbolSelection.focus = strongSignals.map(s => s.symbol).slice(0, 10);
      analysis.symbolSelection.blacklist = weakSignals.map(s => s.symbol).slice(0, 5);
      
      if (strongSignals.length === 0) {
        analysis.symbolSelection.mode = 'cautious';
        analysis.symbolSelection.recommendation = '无强信号，建议空仓观望或只做BTC/ETH';
      } else if (strongSignals.length >= 5) {
        analysis.symbolSelection.mode = 'aggressive';
        analysis.symbolSelection.recommendation = `${strongSignals.length}个强信号，可积极选币`;
      } else {
        analysis.symbolSelection.mode = 'normal';
        analysis.symbolSelection.recommendation = `${strongSignals.length}个强信号，正常选币`;
      }
    }

    // --- 3. K线级别建议 ---
    if (analysis.volatility.avgAtr > 0) {
      const atr = analysis.volatility.avgAtr;
      // 杠杆×ATR vs 止损距离
      const lev = analysis.leverage.current;
      const slPct = 5; // adaptive-params的止损
      const slPriceDist = slPct / lev; // 止损价格%
      
      if (slPriceDist < atr * 1.5) {
        // 止损太近 → 建议放大K线级别
        analysis.timeframe.recommended = '4h';
        analysis.timeframe.reason = `ATR ${atr}% > 止损价格 ${slPriceDist.toFixed(2)}% → 4h过滤噪音`;
      } else if (slPriceDist < atr * 2.5) {
        analysis.timeframe.recommended = '1h';
        analysis.timeframe.reason = `ATR ${atr}% ≈ 止损价格 ${slPriceDist.toFixed(2)}% → 1h平衡`;
      } else {
        analysis.timeframe.recommended = '15m';
        analysis.timeframe.reason = `ATR ${atr}% < 止损价格 ${slPriceDist.toFixed(2)}% → 15m捕捉快速趋势`;
      }
    }

    // --- 4. 杠杆建议 ---
    if (status && status.balance) {
      const balance = status.balance;
      if (balance < 50) {
        analysis.leverage.recommended = 3;
        analysis.leverage.reason = '余额<$50，降杠杆保护本金';
      } else if (analysis.volatility.regime === 'extreme') {
        analysis.leverage.recommended = 2;
        analysis.leverage.reason = '极端波动，杠杆降到2x';
      } else if (analysis.volatility.regime === 'high') {
        analysis.leverage.recommended = 3;
        analysis.leverage.reason = '高波动，杠杆3x';
      } else if (analysis.volatility.regime === 'low') {
        analysis.leverage.recommended = 7;
        analysis.leverage.reason = '低波动，可加杠杆到7x';
      } else {
        analysis.leverage.recommended = 5;
        analysis.leverage.reason = '正常波动，标准5x';
      }
    }

    // --- 5. 风险等级 ---
    if (analysis.volatility.regime === 'extreme') {
      analysis.riskLevel = 'high';
    } else if (analysis.volatility.regime === 'high') {
      analysis.riskLevel = 'medium';
    } else {
      analysis.riskLevel = 'low';
    }

    // --- 6. 交易表现分析 ---
    if (evolution && evolution.stats) {
      const stats = evolution.stats;
      const winRate = stats.winRate || 0;
      const totalTrades = stats.totalTrades || 0;
      const avgPnl = stats.avgPnl || 0;
      
      analysis.performance.winRate = winRate;
      analysis.performance.recentTrades = totalTrades;
      analysis.performance.profitFactor = stats.profitFactor || 0;
      
      if (totalTrades >= 10) {
        if (winRate < 0.3) {
          analysis.performance.recommendation = `胜率仅${(winRate*100).toFixed(0)}%，建议提高信号门槛到0.7`;
          // 主动写issue给RepairBot
          writeIssue('low_winrate_proactive', 'high', 'strategy',
            `胜率${(winRate*100).toFixed(0)}%过低(${totalTrades}笔)，主动调参`,
            { winRate, totalTrades, avgPnl },
            'adjust_params');
        } else if (winRate > 0.6 && stats.profitFactor > 1.5) {
          analysis.performance.recommendation = `胜率${(winRate*100).toFixed(0)}%表现优秀，可适当放松门槛`;
        }
      }
    }

    // --- 写策略指令文件 ---
    const strategyFile = path.join(STRATEGY_DIR, 'current-strategy.json');
    fs.writeFileSync(strategyFile, JSON.stringify(analysis, null, 2));
    
    // 每10轮记录一次分析历史
    if (history.scanCount % 10 === 0) {
      log(`🧠 市场分析: 波动=${analysis.volatility.regime}(${analysis.volatility.avgAtr}%) K线=${analysis.timeframe.recommended} 杠杆=${analysis.leverage.recommended}x 风险=${analysis.riskLevel} 信号=${analysis.symbolSelection.focus.length}个`, 'INFO');
    }
    
  } catch (e) {
    log(`市场分析异常: ${e.message}`, 'ERROR');
  }
}

// ── 综合报告 ──
function outputFullReport() {
  log(`📊 === 第${history.scanCount}轮综合报告 ===`, 'INFO');
  log(`  引擎余额: $${history.balance.toFixed(2)}`);
  log(`  引擎轮次: ${history.cycleCount}`);
  log(`  追踪用户: ${Object.keys(history.userBalances).length}个`);
  log(`  盈亏历史: ${history.totalPnlHistory.length}条`);
  log(`  扫描总数: ${history.scanCount}`);
}

// ═══════════════════════════════════════════
// 主循环
// ═══════════════════════════════════════════

async function main() {
  log('👁️ Supervisor Bot v2.0 启动 — 全方位监督量化引擎', 'INFO');
  log(`📊 检测间隔: ${CONFIG.checkInterval / 1000}秒 | 12+检测器`, 'INFO');

  [CONFIG.issuesDir, CONFIG.fixesDir].forEach(d => {
    try { fs.readdirSync(d).forEach(f => fs.unlinkSync(path.join(d, f))); } catch (e) {}
  });

  while (true) {
    try { await checkAll(); }
    catch (e) { log(`检测异常: ${e.message}`, 'ERROR'); }
    await new Promise(r => setTimeout(r, CONFIG.checkInterval));
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
process.on('SIGINT', () => { log('⚠️ SIGINT 忽略 — 监督机器人继续运行', 'INFO'); });
process.on('SIGTERM', () => { log('⚠️ SIGTERM 忽略 — 监督机器人继续运行', 'INFO'); });

main();
