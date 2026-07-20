/**
 * SaaS Platform v3.0 启动入口 — v125 B策略默认/A策略按需
 * 
 * v125 变更：
 *   - B策略（BBStrategyManager 布林带）默认启动，作为主策略
 *   - A策略（Engine 主引擎 + Gold/Forex/Symbol/CrossArb 等旧引擎）由开关控制
 *   - 开关文件：config/strategy-switch.json 的 aStrategyEnabled 字段
 *   - 默认 aStrategyEnabled=false，只跑 B 策略
 *   - 管理员通过仪表盘按钮或 /api/strategy/a/start 接口开启 A 策略
 *   - 保留：Dashboard仪表盘、SaaS Server、UserTrader、MultiEngine v3、Greenfield
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

// v125: 策略开关（A 策略默认关闭）
const STRATEGY_SWITCH_FILE = path.join(__dirname, '..', 'config', 'strategy-switch.json');
function loadStrategySwitch() {
  try {
    const cfg = JSON.parse(fs.readFileSync(STRATEGY_SWITCH_FILE, 'utf-8'));
    return !!(cfg && cfg.aStrategyEnabled === true);
  } catch (e) { return false; }
}
const ENABLE_A_STRATEGY = loadStrategySwitch();

// A 策略相关旧引擎 require（仅在 A 策略启用时加载，避免无谓模块初始化）
let GoldEngine = null, ForexEngine = null, SymbolEngine = null, CrossArb = null;
let SignalBus = null, RiskLayer = null, CapitalRouter = null, CEXUserTrader = null;
if (ENABLE_A_STRATEGY) {
  try { GoldEngine = require('../gold-engine'); } catch(e) { console.log('[A策略] gold-engine 加载失败:', e.message); }
  try { ForexEngine = require('../forex-engine'); } catch(e) { console.log('[A策略] forex-engine 加载失败:', e.message); }
  try { SymbolEngine = require('../symbol-engine'); } catch(e) { console.log('[A策略] symbol-engine 加载失败:', e.message); }
  try { CrossArb = require('./cross-arb'); } catch(e) { console.log('[A策略] cross-arb 加载失败:', e.message); }
  try { SignalBus = require('./signal-bus'); } catch(e) { console.log('[A策略] signal-bus 加载失败:', e.message); }
  try { RiskLayer = require('./risk-layer'); } catch(e) { console.log('[A策略] risk-layer 加载失败:', e.message); }
  try { CapitalRouter = require('./capital-router'); } catch(e) { console.log('[A策略] capital-router 加载失败:', e.message); }
  try { CEXUserTrader = require('./cex-user-trader'); } catch(e) { console.log('[A策略] cex-user-trader 加载失败:', e.message); }
}

// 全局引用（用于优雅关闭）
let _engine, _dashboard, _server, _userTrader;
let _goldEngine, _forexEngine, _symbolEngines = {}, _crossArb, _signalBus, _sharedRisk, _capitalRouter, _cexUserTrader;
let _multiEngine, _greenfieldSync;

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log(`║  🔥 ARK Quant Agent v125 — B策略默认/A策略按需          ║`);
  console.log(`║  B策略 (BB布林带): ✅ 默认启动                            ║`);
  console.log(`║  A策略 (旧引擎):    ${ENABLE_A_STRATEGY ? '✅ 已启用 (按开关)' : '⏸️ 已停用 (管理员指令开启)'}${' '.repeat(Math.max(0, 24 - (ENABLE_A_STRATEGY ? 16 : 30)))}║`);
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

  // ═══ 2. Engine 实例（数据容器 + A策略可选启动）═══
  const port = process.env.SAAS_PORT || 10020;
  const engine = new Engine({ dataBus });
  _engine = engine;
  if (ENABLE_A_STRATEGY) {
    // A 策略启用：启动主引擎交易循环
    try {
      await engine.start();
      console.log('[启动] ✅ Engine 主引擎已启动 (A策略)');
    } catch (e) {
      console.log('[启动] ⚠️ Engine 主引擎启动失败:', e.message);
    }
  } else {
    // v125: B 策略模式，主引擎不启动交易循环
    console.log('[启动] ⏸️ Engine 主引擎不启动 (B策略模式，用 BBStrategyManager)');
  }

  // ═══ 3. Binance API Key（从 .env 读取） ═══
  const binanceApiKey = process.env.BINANCE_API_KEY || '';
  const binanceApiSecret = process.env.BINANCE_API_SECRET || '';

  // ═══ A 策略旧引擎初始化（仅启用时）═══
  let goldEngine = null, forexEngine = null;
  let symbolEngines = {};
  let crossArb = null, signalBus = null, sharedRisk = null, capitalRouter = null;
  let cexUserTrader = null;
  if (ENABLE_A_STRATEGY) {
    console.log('[启动] 🟡 A 策略启动中 (Engine + Gold + Forex + Symbol + CrossArb + SignalBus + RiskLayer + CapitalRouter + CEXUserTrader)...');
    try {
      if (GoldEngine) {
        goldEngine = new GoldEngine({ dataBus, userDB: null });
        await goldEngine.start();
        _goldEngine = goldEngine;
        console.log('[A策略] ✅ GoldEngine 已启动');
      }
    } catch (e) { console.log('[A策略] ⚠️ GoldEngine 启动失败:', e.message); }
    try {
      if (ForexEngine) {
        forexEngine = new ForexEngine({ dataBus, userDB: null });
        await forexEngine.start();
        _forexEngine = forexEngine;
        console.log('[A策略] ✅ ForexEngine 已启动');
      }
    } catch (e) { console.log('[A策略] ⚠️ ForexEngine 启动失败:', e.message); }
    try {
      if (SignalBus) {
        signalBus = new SignalBus({ dataBus });
        await signalBus.start();
        _signalBus = signalBus;
        console.log('[A策略] ✅ SignalBus 已启动');
      }
    } catch (e) { console.log('[A策略] ⚠️ SignalBus 启动失败:', e.message); }
    try {
      if (RiskLayer) {
        sharedRisk = new RiskLayer({ dataBus });
        await sharedRisk.start();
        _sharedRisk = sharedRisk;
        console.log('[A策略] ✅ RiskLayer 已启动');
      }
    } catch (e) { console.log('[A策略] ⚠️ RiskLayer 启动失败:', e.message); }
    try {
      if (CapitalRouter) {
        capitalRouter = new CapitalRouter({ dataBus });
        await capitalRouter.start();
        _capitalRouter = capitalRouter;
        console.log('[A策略] ✅ CapitalRouter 已启动');
      }
    } catch (e) { console.log('[A策略] ⚠️ CapitalRouter 启动失败:', e.message); }
    try {
      if (CrossArb) {
        crossArb = new CrossArb({ dataBus });
        await crossArb.start();
        _crossArb = crossArb;
        console.log('[A策略] ✅ CrossArb 已启动');
      }
    } catch (e) { console.log('[A策略] ⚠️ CrossArb 启动失败:', e.message); }
    // SymbolEngine: 每品种独立引擎
    try {
      if (SymbolEngine) {
        const symbolCfg = require('../config/trading-pairs');
        const symbolList = Object.keys(symbolCfg).filter(s => !s.startsWith('_'));
        for (const sym of symbolList) {
          try {
            const se = new SymbolEngine({ symbol: sym, dataBus, userDB: null });
            await se.start();
            symbolEngines[sym] = se;
          } catch (e) { /* skip */ }
        }
        _symbolEngines = symbolEngines;
        console.log(`[A策略] ✅ SymbolEngine 已启动 ${Object.keys(symbolEngines).length} 个`);
      }
    } catch (e) { console.log('[A策略] ⚠️ SymbolEngine 启动失败:', e.message); }
    console.log('[启动] ✅ A 策略启动完成');
  } else {
    console.log('[启动] ⏸️ A 策略已停用 (Gold/Forex/Symbol/CrossArb/SignalBus/RiskLayer)');
  }

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
    goldEngine, forexEngine,
    symbolEngines,
    capitalRouter, sharedRisk, signalBus, crossArb,
  });
  _server = server;
  server.start();

  // ═══ 6. Dashboard 仪表盘 ═══
  if (!process.env.PRIVATE_ACCESS) process.env.PRIVATE_ACCESS = 'no';
  const Dashboard = require('../dashboard/server');
  const dashboardPort = process.env.DASHBOARD_PORT || 10010;
  const dashboard = new Dashboard(engine, dashboardPort, {
    capitalRouter, sharedRisk, signalBus, crossArb,
    goldEngine, forexEngine, symbolEngines,
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

  // ═══ 8. CEXUserTrader (A 策略一部分) ═══
  if (ENABLE_A_STRATEGY && CEXUserTrader) {
    try {
      cexUserTrader = new CEXUserTrader({
        userDB: server.userDB,
        dataBus,
        traderKey: process.env.TRADER_PRIVATE_KEY,
        goldEngine, forexEngine, symbolEngines,
      });
      cexUserTrader.start();
      _cexUserTrader = cexUserTrader;
      server.cexUserTrader = cexUserTrader;
      console.log('[启动] ✅ CEXUserTrader 已启动 (A策略)');
    } catch (e) { console.log('[启动] ⚠️ CEXUserTrader 启动失败:', e.message); }
  } else {
    console.log('[启动] ⏸️ CEXUserTrader 已停用' + (ENABLE_A_STRATEGY ? ' (模块未加载)' : ' (B策略模式)'));
  }

  // ═══ 9. BBStrategyManager — B策略 (默认启动) ═══
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
    console.log('[启动] 📊 BBStrategyManager B策略已启动');
  } catch (e) { console.log('[启动] ⚠️ BBStrategyManager 启动失败:', e.message); }

  // ═══ 9.5 UnifiedStrategyManager — A/B 策略统一切换 ═══
  // 让仪表盘的 A/B 切换按钮真正能启停引擎
  try {
    const UnifiedStrategyManager = require('./start-unified').UnifiedStrategyManager || null;
    if (UnifiedStrategyManager && bbStrategyManager) {
      const um = new UnifiedStrategyManager({ server, dashboard });
      // 复用已启动的 BBStrategyManager，避免重复启动
      um.bbManager = bbStrategyManager;
      um.activeStrategy = 'bb';
      global.unifiedManager = um;
      console.log('[启动] 🎚️ UnifiedStrategyManager 已启动 (A/B 策略切换器，复用现有 BB 管理器)');
    } else {
      console.log('[启动] ⏭️ UnifiedStrategyManager 未加载 (start-unified.js 不可用)');
    }
  } catch (e) { console.log('[启动] ⚠️ UnifiedStrategyManager 加载失败:', e.message); }

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
  console.log('📊 v125 策略状态:');
  console.log('📊 ───────────────────────────────────────────');
  console.log('📊 B策略 (BB布林带): ✅ 启动');
  console.log(`📊 A策略 (旧引擎): ${ENABLE_A_STRATEGY ? '✅ 启用' : '⏸️ 停用 (需管理员指令)'}`);
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
  
  // v125: A 策略引擎关闭
  try { if (_goldEngine) _goldEngine.stop?.(); } catch (e) {}
  try { if (_forexEngine) _forexEngine.stop?.(); } catch (e) {}
  try {
    for (const se of Object.values(_symbolEngines || {})) {
      try { se.stop?.(); } catch (e) {}
    }
  } catch (e) {}
  try { if (_crossArb) _crossArb.stop?.(); } catch (e) {}
  try { if (_signalBus) _signalBus.stop?.(); } catch (e) {}
  try { if (_sharedRisk) _sharedRisk.stop?.(); } catch (e) {}
  try { if (_capitalRouter) _capitalRouter.stop?.(); } catch (e) {}
  try { if (_cexUserTrader) _cexUserTrader.stop?.(); } catch (e) {}
  
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
