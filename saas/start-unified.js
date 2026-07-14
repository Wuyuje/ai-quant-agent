/**
 * start-unified.js — 统一策略切换启动器
 *
 * 同时管理 A策略（18策略+多市场引擎）和 B策略（BB布林带引擎）
 * 管理员可在仪表盘上一键切换策略，真正启动/停止对应引擎
 *
 * 启动的组件：
 *   ✅ SaaS Server (用户DB + API + 仪表盘静态文件) — 始终运行
 *   ✅ Dashboard (仪表盘) — 始终运行
 *   ✅ BBStrategyManager (B策略) — 可启停
 *   ✅ Engine + DataBus + CEXUserTrader (A策略) — 可启停
 *   ✅ MultiEngine v3 (百万用户框架) — 随A策略启停
 *
 * 启动：
 *   node saas/start-unified.js
 *
 * 默认策略：B策略（读取 data/active-strategy.json）
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SaasServer = require('./server');
const { BBStrategyManager } = require('./bb-strategy-manager');
const { DexTrader } = require('./dex-trader');
const Dashboard = require('../dashboard/server');

// A策略组件（延迟加载，节省内存）
let Engine = null;
let DataBus = null;
let CEXUserTrader = null;
let MultiEngineV3 = null;
let UserTrader = null;
let GoldEngine = null;
let ForexEngine = null;
let SymbolEngine = null;
let CONFIG = null;
let PAIRS = null;

function loadAStrategyModules() {
  if (Engine) return; // 已加载
  try {
    DataBus = require('../data/databus');
    Engine = require('../engine');
    CEXUserTrader = require('./cex-user-trader').CEXUserTrader;
    MultiEngineV3 = require('../multi-v3/multi-engine-v3');
    UserTrader = require('./user-trader');
    try { GoldEngine = require('./gold-engine'); } catch(e) { console.log('[A策略] GoldEngine 不可用'); }
    try { ForexEngine = require('./forex-engine'); } catch(e) { console.log('[A策略] ForexEngine 不可用'); }
    try { SymbolEngine = require('./symbol-engine'); } catch(e) { console.log('[A策略] SymbolEngine 不可用'); }
    CONFIG = require('../config/loader');
    PAIRS = require('../config/trading-pairs');
    console.log('[A策略] 模块已加载');
  } catch (e) {
    console.error('[A策略] 模块加载失败:', e.message);
  }
}

// ═══ Dummy Engine — A策略未启动时的空壳 ═══
function createDummyEngine() {
  return {
    running: false,
    paused: true,
    dataBus: null,
    positions: {},
    positionCount: 0,
    state: { totalPnl: 0, totalTrades: 0, wins: 0, losses: 0, _openTime: {}, _posATR: {} },
    cycleCount: 0,
    strategyManager: null,
    masterdAgent: null,
    news: null,
    brain: null,
    exitManager: null,
    positionSizer: null,
    sharedRisk: null,
    capitalRouter: null,
    crossArb: null,
    signalBus: null,
    signalPool: null,
    dataHub: null,
    goldEngine: null,
    forexEngine: null,
    symbolEngines: {},
    neuralNet: null,
    guardian: { positions: {}, postCloseVerify: async () => {} },
    trader: null,
    _cachedBalance: null,
    _peakPnlPct: {},
    _openTime: {},
    _posATR: {},
    _closedSymbols: {},
    _openedThisScan: {},
    getStatus: function() {
      return {
        running: false,
        paused: true,
        positions: {},
        positionCount: 0,
        state: { totalPnl: 0, totalTrades: 0, wins: 0, losses: 0, _openTime: {}, _posATR: {} },
        cycleCount: 0,
      };
    },
    getAdminStatus: function() { return this.getStatus(); },
    togglePause: function() { return true; },
    startEngine: function() { return { started: false, message: 'A策略未启动' }; },
    stopEngine: function() { return { stopped: true }; },
    getConfig: function() { return { message: 'A策略未启动' }; },
    updateConfig: function() { return { updated: false }; },
    _recordTradeClose: function() {},
  };
}

// ═══ 统一策略管理器 ═══
class UnifiedStrategyManager {
  constructor({ server, dashboard }) {
    this.server = server;
    this.dashboard = dashboard;
    this.activeStrategy = 'bb'; // 默认B策略
    this.switching = false; // 正在切换中
    
    // A策略组件
    this.aEngine = null;
    this.aDataBus = null;
    this.aCexTrader = null;
    this.aMultiEngine = null;
    this.aUserTrader = null;
    this.aGoldEngine = null;
    this.aForexEngine = null;
    this.aSymbolEngines = {};
    
    // B策略组件
    this.bbManager = null;
    
    // DEX 交易器（始终运行，独立于A/B策略）
    this.dexTrader = null;
    
    // 读取当前策略
    this._strategyFile = path.join(__dirname, '..', 'data', 'active-strategy.json');
    try {
      const cfg = JSON.parse(fs.readFileSync(this._strategyFile, 'utf8'));
      this.activeStrategy = cfg.activeStrategy || 'bb';
    } catch (e) {
      this.activeStrategy = 'bb';
    }
    
    console.log(`[Unified] 初始策略: ${this.activeStrategy === 'bb' ? 'B策略' : 'A策略'}`);
  }

  getActiveStrategy() {
    return this.activeStrategy;
  }

  isBBActive() {
    return this.activeStrategy === 'bb';
  }

  setActiveStrategy(strategy) {
    // 只更新文件标记，实际切换由 switchStrategy() 异步完成
    const cfg = {
      activeStrategy: strategy,
      lastSwitch: new Date().toISOString(),
      switchedBy: 'admin',
    };
    try {
      fs.writeFileSync(this._strategyFile, JSON.stringify(cfg, null, 2));
    } catch (e) {}
    return cfg;
  }

  // ═══ 启动B策略 ═══
  async startBStrategy() {
    if (this.bbManager?.running) {
      console.log('[Unified] B策略已在运行');
      return;
    }
    
    try {
      if (!this.bbManager) {
        this.bbManager = new BBStrategyManager({
          userDB: this.server.userDB,
          intervalMs: 30000,
        });
      }
      // 解除锁定模式，由统一管理器控制
      this.bbManager._locked = false;
      this.bbManager.start();
      this.server.bbStrategyManager = this.bbManager;
      this.dashboard.bbStrategyManager = this.bbManager;
      console.log('[Unified] ✅ B策略 (BB布林带引擎) 已启动');
    } catch (e) {
      console.error('[Unified] ❌ B策略启动失败:', e.message);
    }
  }

  // ═══ 停止B策略 ═══
  async stopBStrategy() {
    if (!this.bbManager?.running) {
      console.log('[Unified] B策略已停止');
      return;
    }
    
    try {
      this.bbManager._locked = false; // 临时解除锁定才能停止
      this.bbManager.stop();
      console.log('[Unified] 🛑 B策略已停止');
    } catch (e) {
      console.error('[Unified] B策略停止失败:', e.message);
    }
  }

  // ═══ 启动A策略 ═══
  async startAStrategy() {
    if (this.aEngine?.running) {
      console.log('[Unified] A策略已在运行');
      return;
    }
    
    console.log('[Unified] 正在启动A策略...');
    loadAStrategyModules();
    
    if (!Engine || !CONFIG || !PAIRS) {
      console.error('[Unified] ❌ A策略模块加载失败，无法启动');
      return;
    }
    
    try {
      // 1. DataBus（行情数据）
      console.log('[Unified] [A策略] 连接行情数据...');
      this.aDataBus = new DataBus(CONFIG);
      const blacklistSet = new Set(PAIRS._blacklist || []);
      const symbols = Object.keys(PAIRS).filter(s => !blacklistSet.has(s) && !s.startsWith('_'));
      this.aDataBus.connectWS(symbols);
      await new Promise(r => setTimeout(r, 2000));
      
      for (const sym of symbols) {
        try {
          await this.aDataBus.fetchTicker(sym);
          await this.aDataBus.fetchKlines(sym, CONFIG.data.klineInterval, CONFIG.data.klineLimit);
          await new Promise(r => setTimeout(r, 150));
        } catch (e) {}
      }
      console.log(`[Unified] [A策略] ${symbols.length} 个交易对数据就绪`);
      
      // 2. Engine（18策略引擎）
      this.aEngine = new Engine({ dataBus: this.aDataBus });
      await this.aEngine.start();
      console.log('[Unified] [A策略] Crypto Futures 引擎已启动 (18策略融合)');
      
      // 3. CEXUserTrader（用户全品种交易器）
      try {
        this.aCexTrader = new CEXUserTrader({
          userDB: this.server.userDB,
          dataBus: this.aDataBus,
          strategyManager: this.aEngine.strategyManager || null,
          intervalMs: 60000,
        });
        this.aCexTrader.cryptoEngine = this.aEngine;
        if (this.aGoldEngine) this.aCexTrader.goldEngine = this.aGoldEngine;
        if (this.aForexEngine) this.aCexTrader.forexEngine = this.aForexEngine;
        this.aCexTrader.symbolEngines = this.aSymbolEngines || {};
        this.aCexTrader.brain = this.aEngine.brain || null;
        this.aCexTrader.exitManager = this.aEngine.exitManager || null;
        this.aCexTrader.positionSizer = this.aEngine.positionSizer || null;
        this.aCexTrader.sharedRisk = this.aEngine.sharedRisk || null;
        this.aCexTrader.start();
        this.server.cexUserTrader = this.aCexTrader;
        this.aEngine._cexUserTrader = this.aCexTrader;
        console.log('[Unified] [A策略] CEXUserTrader 已启动');
      } catch (e) {
        console.log('[Unified] [A策略] CEXUserTrader 启动失败:', e.message);
      }
      
      // 4. UserTrader（管理员跟单）
      try {
        this.aUserTrader = new UserTrader({
          userDB: this.server.userDB,
          dataBus: this.aDataBus,
          traderKey: process.env.TRADER_PRIVATE_KEY,
          intervalMs: 60000,
        });
        this.aUserTrader.start();
        this.server.userTrader = this.aUserTrader;
        console.log('[Unified] [A策略] UserTrader 已启动');
      } catch (e) {
        console.log('[Unified] [A策略] UserTrader 启动失败:', e.message);
      }
      
      // 5. 替换Dashboard的engine引用
      this.dashboard.engine = this.aEngine;
      this.server.engine = this.aEngine;
      
      // 注入BB管理器到engine
      if (this.bbManager) {
        this.aEngine._bbStrategyManager = this.bbManager;
      }
      
      console.log('[Unified] ✅ A策略已启动 (18策略+CEX+UserTrader)');
    } catch (e) {
      console.error('[Unified] ❌ A策略启动失败:', e.message, e.stack?.split('\n').slice(0, 3).join('\n'));
    }
  }

  // ═══ 停止A策略 ═══
  async stopAStrategy() {
    if (!this.aEngine?.running) {
      console.log('[Unified] A策略已停止');
      // 恢复dummy engine
      this.dashboard.engine = createDummyEngine();
      this.server.engine = createDummyEngine();
      return;
    }
    
    console.log('[Unified] 正在停止A策略...');
    
    try {
      // 停止CEXUserTrader
      if (this.aCexTrader?.running) {
        this.aCexTrader.stop();
        console.log('[Unified] [A策略] CEXUserTrader 已停止');
      }
      
      // 停止UserTrader
      if (this.aUserTrader?.running) {
        this.aUserTrader.stop();
        console.log('[Unified] [A策略] UserTrader 已停止');
      }
      
      // 停止MultiEngine
      if (this.aMultiEngine?.running) {
        try { this.aMultiEngine.stop(); } catch(e) {}
        console.log('[Unified] [A策略] MultiEngine 已停止');
      }
      
      // 停止Engine
      if (this.aEngine) {
        this.aEngine.stop();
        console.log('[Unified] [A策略] Engine 已停止');
      }
      
      // 断开DataBus
      if (this.aDataBus) {
        try { this.aDataBus.disconnect(); } catch(e) {}
      }
      
      // 恢复dummy engine
      this.dashboard.engine = createDummyEngine();
      this.server.engine = createDummyEngine();
      this.server.cexUserTrader = null;
      this.aEngine = null;
      this.aDataBus = null;
      this.aCexTrader = null;
      this.aUserTrader = null;
      this.aMultiEngine = null;
      
      console.log('[Unified] 🛑 A策略已停止');
    } catch (e) {
      console.error('[Unified] A策略停止失败:', e.message);
    }
  }

  // ═══ 策略切换（异步，真正启停引擎） ═══
  async switchStrategy(strategy) {
    if (this.switching) {
      return { success: false, error: '正在切换中，请等待' };
    }
    
    if (strategy === this.activeStrategy) {
      return { success: true, message: '策略未变化', strategy };
    }
    
    this.switching = true;
    const fromStrategy = this.activeStrategy;
    const toStrategy = strategy;
    
    console.log(`[Unified] 🔄 策略切换: ${fromStrategy === 'bb' ? 'B策略' : 'A策略'} → ${toStrategy === 'bb' ? 'B策略' : 'A策略'}`);
    
    try {
      // 更新策略文件
      this.setActiveStrategy(toStrategy);
      this.activeStrategy = toStrategy;
      
      if (toStrategy === 'bb') {
        // A → B：先停A策略，再启动B策略
        await this.stopAStrategy();
        await new Promise(r => setTimeout(r, 1000));
        await this.startBStrategy();
      } else {
        // B → A：先停B策略，再启动A策略
        await this.stopBStrategy();
        await new Promise(r => setTimeout(r, 1000));
        await this.startAStrategy();
      }
      
      console.log(`[Unified] ✅ 策略切换完成: ${toStrategy === 'bb' ? 'B策略' : 'A策略'}`);
      this.switching = false;
      
      return {
        success: true,
        strategy: toStrategy,
        name: toStrategy === 'bb' ? 'B策略 (布林带)' : 'A策略 (均衡)',
        from: fromStrategy,
        to: toStrategy,
      };
    } catch (e) {
      console.error(`[Unified] ❌ 策略切换失败:`, e.message);
      this.switching = false;
      return { success: false, error: e.message };
    }
  }

  // ═══ 获取状态 ═══
  getStatus() {
    return {
      activeStrategy: this.activeStrategy,
      switching: this.switching,
      aStrategy: {
        running: this.aEngine?.running || false,
        cycleCount: this.aEngine?.cycleCount || 0,
      },
      bStrategy: {
        running: this.bbManager?.running || false,
        cycleCount: this.bbManager?._cycleCount || 0,
        activeUsers: this.bbManager ? Object.keys(this.bbManager._engines || {}).length : 0,
      },
    };
  }
}

// ═══ 主入口 ═══
async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  🎛️  统一策略切换启动器 (A策略 + B策略)                    ║');
  console.log('║  管理员可在仪表盘上一键切换策略                            ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  const saasPort = parseInt(process.env.SAAS_PORT || '10020');
  const dashboardPort = parseInt(process.env.DASHBOARD_PORT || '10010');

  // ═══ Dummy Engine ═══
  const dummyEngine = createDummyEngine();

  // ═══ 1. SaaS Server ═══
  const server = new SaasServer(dummyEngine, saasPort, {
    dataBus: null,
    goldEngine: null, forexEngine: null,
    symbolEngines: {},
  });
  server.start();
  console.log(`[启动] ✅ SaaS Server 已启动 (port ${saasPort})`);

  // ═══ 2. Dashboard ═══
  const dashboard = new Dashboard(dummyEngine, dashboardPort, {
    bbStrategyManager: null,
    cexUserTrader: null,
    goldEngine: null,
    forexEngine: null,
    symbolEngines: {},
    masterdAgent: null,
    newsHub: null,
  });
  dashboard.bbStrategyManager = null;
  
  // 覆盖A策略status API（当A策略未运行时返回"已停止"）
  const app = dashboard.app;
  app.use('/api/status', (req, res, next) => {
    if (req.method === 'GET' && !unifiedManager?.aEngine?.running) {
      return res.json({
        running: false,
        paused: true,
        positions: {},
        positionCount: 0,
        state: { totalPnl: 0, totalTrades: 0, wins: 0, losses: 0 },
        cycleCount: 0,
        message: 'A策略未启动',
        balance: { balance: 0, available: 0, unrealizedPnl: 0 },
        totalUsers: Object.keys(server.userDB?.users || {}).length,
      });
    }
    next();
  });

  await dashboard.start();
  
  // 反向代理到SaaS Server
  app.use((req, res) => {
    const proxy = http.request({
      hostname: '127.0.0.1',
      port: saasPort,
      path: req.url,
      method: req.method,
      headers: req.headers,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    req.pipe(proxy);
    proxy.on('error', () => {
      res.status(502).json({ error: 'SaaS server unavailable' });
    });
  });
  
  console.log(`[启动] ✅ Dashboard 已启动 — http://localhost:${dashboardPort}`);

  // ═══ 3. 统一策略管理器 ═══
  const unifiedManager = new UnifiedStrategyManager({ server, dashboard });
  global.unifiedManager = unifiedManager;

  // ═══ 4. 根据初始策略启动对应引擎 ═══
  if (unifiedManager.activeStrategy === 'bb') {
    await unifiedManager.startBStrategy();
  } else {
    await unifiedManager.startAStrategy();
    // 如果A策略也启动了BB管理器（作为副引擎）
    if (unifiedManager.bbManager) {
      unifiedManager.bbManager._locked = false;
    }
  }

  // ═══ 4.5 启动 DEX 交易器（独立于A/B策略，始终运行）═══
  try {
    unifiedManager.dexTrader = new DexTrader({
      userDB: server.userDB,
      intervalMs: 60000,
    });
    unifiedManager.dexTrader.start();
    server.dexTrader = unifiedManager.dexTrader;
    dashboard.dexTrader = unifiedManager.dexTrader;
    console.log('[Unified] ✅ DEX Trader 已启动 (独立于A/B策略)');
  } catch (e) {
    console.error('[Unified] ❌ DEX Trader 启动失败:', e.message);
  }

  // ═══ 状态汇总 ═══
  const status = unifiedManager.getStatus();
  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log('  🎛️  统一策略启动器已就绪');
  console.log(`  🌐 Dashboard: http://localhost:${dashboardPort}`);
  console.log(`  🌐 SaaS API:  http://localhost:${saasPort}`);
  console.log(`  📌 当前策略: ${status.activeStrategy === 'bb' ? 'B策略 (布林带)' : 'A策略 (均衡)'}`);
  console.log(`  ${status.aStrategy.running ? '✅ A策略: 运行中' : '❌ A策略: 已停止'}`);
  console.log(`  ${status.bStrategy.running ? '✅ B策略: 运行中' : '❌ B策略: 已停止'}`);
  console.log('═══════════════════════════════════════════════');

  // ═══ 防崩溃 ═══
  process.on('uncaughtException', (err) => {
    console.error('[FATAL] uncaughtException:', err.message);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] unhandledRejection:', reason?.message || reason);
  });

  // ═══ 心跳 ═══
  setInterval(() => {
    const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const userCount = Object.keys(server.userDB?.users || {}).length;
    const st = unifiedManager.getStatus();
    console.log(`[HEARTBEAT] ⏰ ${new Date().toISOString().slice(11,19)} | MEM: ${mem}MB | Users: ${userCount} | A策略: ${st.aStrategy.running ? '✅' : '❌'} | B策略: ${st.bStrategy.running ? '✅' : '❌'}`);
  }, 5 * 60 * 60 * 1000);

  process.on('SIGINT', () => console.log('⚠️ SIGINT 忽略 — 引擎继续运行'));
  process.on('SIGTERM', () => console.log('⚠️ SIGTERM 忽略 — 引擎继续运行'));
}

// 注意：unifiedManager 需要全局可访问，Dashboard 的 /api/strategy/switch 会调用它
global.unifiedManager = null;

main().catch(e => {
  console.error('❌ 启动失败:', e);
  console.log('⚠️ 5秒后重试...');
  setTimeout(() => main().catch(() => {}), 5000);
});
