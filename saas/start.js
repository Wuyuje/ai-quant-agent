/**
 * SaaS Platform v3.0 启动入口 — v124 纯BB策略版
 * 
 * v124 变更：
 *   - 停用所有旧合约策略（Engine 18策略、Gold、Forex、SymbolEngine、CrossArb等）
 *   - 只保留 BBStrategyManager（布林带策略）作为唯一交易策略
 *   - 保留：Dashboard仪表盘、SaaS Server（算力付费/用户管理）、UserTrader（跟单）、MultiEngine v3
 *   - 保留：Greenfield BSC链上同步
 *
 * 启动：
 *   node saas/start.js
 */

const path = require('path');
const fs = require('fs');
const DataBus = require('../data/databus');
const Engine = require('../engine');
const SaasServer = require('./server');
const UserTrader = require('./user-trader');
const { BBStrategyManager } = require('./bb-strategy-manager'); // BB多用户布林带策略

// v108: 百万用户框架
const MultiEngineV3 = require('../multi-v3/multi-engine-v3');

// v108: Greenfield 链上同步
let GreenfieldSync = null;
try { GreenfieldSync = require('../greenfield/sync'); } catch(e) { console.log('[Greenfield] 未加载:', e.message); }

const CONFIG = require('../config/loader');
const PAIRS = require('../config/trading-pairs');

// 全局引用（用于优雅关闭）
let _engine, _dashboard, _server, _userTrader;
let _multiEngine, _greenfieldSync;

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  🔥 ARK Quant Agent v124 — 纯BB策略版                     ║');
  console.log('║  只运行BB布林带策略 · 仪表盘 · 算力付费 · 用户管理        ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  // 确保数据目录
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // ═══ 防死机：检测 watchdog 写入的 crash state ═══
  const crashStateFile = path.join(dataDir, 'engine-crash.state');
  if (fs.existsSync(crashStateFile)) {
    try {
      const crashInfo = JSON.parse(fs.readFileSync(crashStateFile, 'utf-8'));
      console.log(`[启动] 🚨 检测到 crash state (${crashInfo.reason})，本实例退出，让 watchdog 启动新实例`);
      fs.unlinkSync(crashStateFile);
      process.exit(0);
    } catch (e) { /* state 文件损坏，忽略 */ }
  }

  // ═══ 定期检测 crash state ═══
  setInterval(() => {
    try {
      if (fs.existsSync(crashStateFile)) {
        const crashInfo = JSON.parse(fs.readFileSync(crashStateFile, 'utf-8'));
        console.log(`[运行中] 🚨 检测到 crash state (${crashInfo.reason})，本实例退出`);
        fs.unlinkSync(crashStateFile);
        setTimeout(() => process.exit(0), 500);
      }
    } catch (e) { /* ignore */ }
  }, 5000);

  // ═══ 1. 共享 DataBus（行情数据）— BB策略需要K线数据 ═══
  console.log('[启动] 📡 连接 Binance 行情...');
  const dataBus = new DataBus(CONFIG);
  const blacklistSet = new Set(PAIRS._blacklist || []);
  const symbols = Object.keys(PAIRS).filter(s => !blacklistSet.has(s) && !s.startsWith('_'));
  dataBus.connectWS(symbols);
  await new Promise(r => setTimeout(r, 3000));

  for (const sym of symbols) {
    try {
      await dataBus.fetchTicker(sym);
      await dataBus.fetchKlines(sym, CONFIG.data.klineInterval, CONFIG.data.klineLimit);
      await new Promise(r => setTimeout(r, 200));
    } catch (e) { console.error(`[SaaS-Start] ${sym} 数据加载失败: ${e.message}`); }
  }
  console.log(`[启动] 📊 ${symbols.length} 个交易对数据就绪`);

  // ═══ 2. Engine 实例（不启动交易，只作为数据容器） ═══
  const port = process.env.SAAS_PORT || 10020;
  const engine = new Engine({ dataBus });
  _engine = engine;
  // v124: engine.start() 不再调用 — 只用BB策略
  console.log('[启动] ⏸️ Engine 主引擎不启动交易循环 (v124: 只用BB策略)');

  // ═══ 3. Binance API Key（从 .env 读取） ═══
  const binanceApiKey = process.env.BINANCE_API_KEY || '';
  const binanceApiSecret = process.env.BINANCE_API_SECRET || '';

  // ═══ v124: 以下引擎全部停用 ═══
  console.log('[启动] ⏸️ Gold/Forex/SymbolEngine/CrossArb/SignalBus/RiskLayer 已停用 (v124)');

  // ═══ 4. Greenfield BSC 链上同步 ═══
  let greenfieldSync = null;
  if (GreenfieldSync) {
    try {
      greenfieldSync = new GreenfieldSync();
      _greenfieldSync = greenfieldSync;
      await greenfieldSync.init();
      greenfieldSync.startAutoSync();
      console.log('[启动] 🌿 Greenfield BSC 链上同步已启动');
    } catch (e) { console.log('[启动] ⏭️ Greenfield 跳过 (未配置mnemonic)'); }
  }

  // ═══ 5. SaaS Server（用户平台 + 算力付费） ═══
  const server = new SaasServer(engine, port, {
    dataBus,
    goldEngine: null, forexEngine: null,
    symbolEngines: {},
    capitalRouter: null, sharedRisk: null, signalBus: null, crossArb: null,
  });
  _server = server;
  server.start();

  // ═══ 6. Dashboard 仪表盘 ═══
  if (!process.env.PRIVATE_ACCESS) process.env.PRIVATE_ACCESS = 'no';
  const Dashboard = require('../dashboard/server');
  const dashboardPort = process.env.DASHBOARD_PORT || 10010;
  const dashboard = new Dashboard(engine, dashboardPort, {
    capitalRouter: null, sharedRisk: null, signalBus: null, crossArb: null,
    goldEngine: null, forexEngine: null, symbolEngines: {},
    masterdAgent: null,
    newsHub: null,
  });
  _dashboard = dashboard;
  dashboard.start();
  console.log(`[启动] 📊 Dashboard 运行在端口 ${dashboardPort}`);

  // ═══ 7. UserTrader 用户自动跟单 ═══
  const userTrader = new UserTrader({
    userDB: server.userDB,
    dataBus,
    traderKey: process.env.TRADER_PRIVATE_KEY,
    intervalMs: 60000,
  });
  _userTrader = userTrader;
  server.userTrader = userTrader;
  userTrader.start();
  console.log('[启动] 🤖 UserTrader 用户自动跟单已启动');

  // ═══ 8. CEXUserTrader — 已停用 ═══
  console.log('[启动] ⏸️ CEXUserTrader 已停用 (v124)');

  // ═══ 9. BBStrategyManager — 唯一交易策略 ═══
  let bbStrategyManager = null;
  try {
    bbStrategyManager = new BBStrategyManager({
      userDB: server.userDB,
      intervalMs: 30000,
    });
    bbStrategyManager.start();
    server.bbStrategyManager = bbStrategyManager;
    engine._bbStrategyManager = bbStrategyManager;
    dashboard.bbStrategyManager = bbStrategyManager; // 注入仪表盘
    console.log('[启动] 📊 BBStrategyManager 多用户布林带策略已启动 (唯一策略)');
  } catch (e) { console.log('[启动] ⚠️ BBStrategyManager 启动失败:', e.message); }

  // ═══ 10. MultiEngine v3 — 百万用户框架 ═══
  let multiEngine = null;
  try {
    const multiPort = parseInt(process.env.MULTI_PORT || '10030');
    const multiWsPort = parseInt(process.env.WS_PORT || '10035');
    multiEngine = new MultiEngineV3({
      port: multiPort,
      wsPort: multiWsPort,
      dataPath: path.join(__dirname, '..', 'data', 'saas-users.json'),
      batchSize: parseInt(process.env.MULTI_BATCH_SIZE || '20'),
    });
    multiEngine.sharedDataBus = dataBus;
    _multiEngine = multiEngine;
    await multiEngine.init();
    multiEngine.start();
    console.log(`[启动] 🚀 MultiEngine v3 百万用户框架已启动 — HTTP:${multiPort} WS:${multiWsPort}`);
  } catch (e) { console.log('[启动] ⚠️ MultiEngine v3 启动失败:', e.message); }

  // ═══ 状态汇总 ═══
  console.log('');
  console.log('📊 ═══════════════════════════════════════════');
  console.log('📊 v124 纯BB策略版状态:');
  console.log('📊 ───────────────────────────────────────────');
  console.log('📊 BB策略:        ✅ (唯一交易策略)');
  console.log('📊 旧合约引擎:    ⏸️ 已停用 (18策略/Gold/Forex/Symbol/Arb)');
  console.log(`📊 Dashboard:     ✅ 端口 ${dashboardPort}`);
  console.log(`📊 SaaS Server:   ✅ 端口 ${port}`);
  console.log(`📊 UserTrader:    ✅ (用户跟单)`);
  console.log(`📊 MultiEngine:   ${multiEngine ? '✅' : '❌'} (百万用户框架)`);
  console.log(`📊 Greenfield:    ${greenfieldSync ? '✅' : '❌'} (BSC链上同步)`);
  console.log('📊 ═══════════════════════════════════════════');
  console.log('');
  console.log('═══════════════════════════════');
  console.log(`  🌐 Dashboard: http://localhost:${dashboardPort}`);
  console.log(`  🌐 SaaS API:  http://localhost:${port}`);
  if (multiEngine) console.log(`  🌐 Multi v3:  http://localhost:${process.env.MULTI_PORT || 10030}`);
  console.log('═══════════════════════════════');
  console.log('\n等待登录... 🔗\n');

  // ═══ 防崩溃 ═══
  process.on('uncaughtException', (err) => {
    console.error('[FATAL] uncaughtException:', err.message, err.stack?.split('\n').slice(0,3).join('\n'));
    try {
      fs.writeFileSync(path.join(__dirname, '..', 'data', 'engine-crash.state'),
        JSON.stringify({ reason: 'uncaughtException', msg: err.message, ts: Date.now() }));
    } catch (e) { /* ignore */ }
    setTimeout(() => process.exit(1), 3000);
  });
  process.on('unhandledRejection', (reason, promise) => {
    console.error('[FATAL] unhandledRejection:', reason?.message || reason);
    try {
      fs.writeFileSync(path.join(__dirname, '..', 'data', 'engine-crash.state'),
        JSON.stringify({ reason: 'unhandledRejection', msg: reason?.message || String(reason), ts: Date.now() }));
    } catch (e) { /* ignore */ }
    setTimeout(() => process.exit(1), 3000);
  });

  // ═══ 心跳保活 ═══
  setInterval(() => {
    const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const userCount = Object.keys(server.userDB?.users || {}).length;
    console.log(`[HEARTBEAT] ⏰ ${new Date().toISOString().slice(11,19)} | MEM: ${mem}MB | Users: ${userCount}`);
  }, 5 * 60 * 1000);

  // 优雅关闭
  process.on('SIGINT', () => { gracefulShutdown('SIGINT'); });
  process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });
}

main().catch(e => {
  console.error('❌ 启动失败:', e);
  console.log('⚠️ 启动失败，5秒后重试...');
  setTimeout(() => main().catch(() => {}), 5000);
});

// ========== 优雅关闭 ==========
let _isShuttingDown = false;
async function gracefulShutdown(reason) {
  if (_isShuttingDown) return;
  _isShuttingDown = true;
  console.error(`🚨 [${reason}] 开始优雅关闭（Binance 持仓保留不动）...`);
  
  try {
    const stateFile = path.join(__dirname, '..', 'data', 'engine-shutdown.state');
    fs.writeFileSync(stateFile, JSON.stringify({ reason, ts: Date.now() }));
  } catch (e) { /* ignore */ }
  
  try {
    if (_engine) { _engine.running = false; }
  } catch (e) { /* ignore */ }
  
  try {
    if (_server) { _server.close(); }
  } catch (e) { /* ignore */ }
  
  await new Promise(r => setTimeout(r, 2000));
  console.error(`🚨 [${reason}] 优雅关闭完成，退出进程`);
  process.exit(1);
}

// 内存监控
setInterval(() => {
  const mem = process.memoryUsage();
  const rssUsedMB = Math.round(mem.rss / 1024 / 1024);
  if (rssUsedMB > 2048) {
    console.error(`⚠️ [内存警告] RSS=${rssUsedMB}MB`);
    if (global.gc) global.gc();
  }
  if (rssUsedMB > 3072) {
    gracefulShutdown(`内存超限 RSS=${rssUsedMB}MB`);
  }
}, 30000);

// CPU 监控
let lastCpuTime = Date.now();
let lastCpuUsage = process.cpuUsage();
setInterval(() => {
  const now = Date.now();
  const currentCpu = process.cpuUsage();
  const cpuDiff = currentCpu.user - lastCpuUsage.user;
  const timeDiff = now - lastCpuTime;
  const cpuPercent = (cpuDiff / timeDiff / 1000) * 100;
  if (cpuPercent > 90) {
    console.error(`⚠️ [CPU警告] 使用率 ${cpuPercent.toFixed(1)}%`);
  }
  lastCpuTime = now;
  lastCpuUsage = currentCpu;
}, 10000);

// 事件循环延迟监控
let lastLoopCheck = Date.now();
setInterval(() => {
  const now = Date.now();
  const delay = now - lastLoopCheck - 5000;
  if (delay > 1000) {
    console.error(`⚠️ [事件循环延迟] ${delay}ms`);
  }
  lastLoopCheck = now;
}, 5000);
