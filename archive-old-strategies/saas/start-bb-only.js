/**
 * start-bb-only.js — 只启动 B策略（BB引擎）
 *
 * 停掉 A策略的所有组件：
 *   ❌ Engine (18策略融合)
 *   ❌ GoldEngine / ForexEngine / SymbolEngine
 *   ❌ CEXUserTrader / UserTrader
 *   ❌ MultiEngine v3 / CrossArb / SignalBus
 *
 * 只保留：
 *   ✅ SaaS Server (用户DB + API + 仪表盘静态文件)
 *   ✅ BBStrategyManager (B策略)
 *   ✅ Dashboard (仪表盘 — A策略部分显示"已停止")
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SaasServer = require('./server');
const { BBStrategyManager } = require('./bb-strategy-manager');
const Dashboard = require('../dashboard/server');

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  📊 B策略专用启动器 (A策略已停止)');
  console.log('═══════════════════════════════════════════════');

  const saasPort = parseInt(process.env.SAAS_PORT || '10020');
  const dashboardPort = parseInt(process.env.DASHBOARD_PORT || '10010');

  // ═══ Dummy Engine — A策略已停止的空壳 ═══
  // SaasServer 和 Dashboard 都需要 engine 参数，传一个空壳
  const dummyEngine = {
    running: false,
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
    trader: null, // null → /api/status 走 catch 分支
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
    getAdminStatus: function() {
      return this.getStatus();
    },
    togglePause: function() { return true; },
    startEngine: function() { return { started: false, message: 'A策略已停止' }; },
    stopEngine: function() { return { stopped: true }; },
    getConfig: function() { return { message: 'A策略已停止' }; },
    updateConfig: function() { return { updated: false }; },
    _recordTradeClose: function() {},
  };

  // ═══ 1. SaaS Server (用户DB + 认证 API) ═══
  const server = new SaasServer(dummyEngine, saasPort, {
    dataBus: null,
    goldEngine: null, forexEngine: null,
    symbolEngines: {},
  });
  server.start();
  console.log(`[启动] ✅ SaaS Server 已启动 (port ${saasPort})`);

  // ═══ 2. BBStrategyManager (B策略) ═══
  let bbStrategyManager = null;
  try {
    bbStrategyManager = new BBStrategyManager({
      userDB: server.userDB,
      intervalMs: 30000,
    });
    bbStrategyManager.start();
    server.bbStrategyManager = bbStrategyManager;
    console.log('[启动] ✅ BBStrategyManager (B策略) 已启动');
  } catch (e) {
    console.log('[启动] ❌ BBStrategyManager 启动失败:', e.message);
  }

  // ═══ 3. Dashboard (仪表盘) ═══
  try {
    const dashboard = new Dashboard(dummyEngine, dashboardPort, {
      bbStrategyManager: bbStrategyManager,
      cexUserTrader: null,
      goldEngine: null,
      forexEngine: null,
      symbolEngines: {},
      masterdAgent: null,
      newsHub: null,
    });
    // 先设置 bbStrategyManager（路由闭包用 this.bbStrategyManager 动态查找）
    dashboard.bbStrategyManager = bbStrategyManager;
    dummyEngine._bbStrategyManager = bbStrategyManager; // 双保险

    // 先调用 dashboard.start() 注册所有路由（BB策略等）
    // 覆盖 A策略相关API — 返回"已停止"
    const app = dashboard.app;

    // 在 start() 之前覆盖 /api/status（因为 _setupRoutes 里也注册了）
    // Express 后注册的同路径路由不会覆盖前面的，所以用中间件拦截
    app.use('/api/status', (req, res, next) => {
      if (req.method === 'GET') {
        return res.json({
          running: false,
          paused: true,
          positions: {},
          positionCount: 0,
          state: { totalPnl: 0, totalTrades: 0, wins: 0, losses: 0 },
          cycleCount: 0,
          message: 'A策略已停止，仅运行B策略',
          balance: { balance: 0, available: 0, unrealizedPnl: 0 },
          totalUsers: Object.keys(server.userDB?.users || {}).length,
        });
      }
      next();
    });

    // 注册 Dashboard 所有路由（包括 BB策略）
    await dashboard.start();

    // 最后才加 catch-all 反向代理到 SaaS Server
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
  } catch (e) {
    console.log('[启动] ❌ Dashboard 启动失败:', e.message);
  }

  // ═══ 状态汇总 ═══
  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log('  📊 B策略专用模式已启动');
  console.log(`  🌐 Dashboard: http://localhost:${dashboardPort}`);
  console.log(`  🌐 SaaS API:  http://localhost:${saasPort}`);
  console.log('  ❌ A策略: 已停止');
  console.log('  ✅ B策略: 运行中 (BB布林带引擎)');
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
    console.log(`[HEARTBEAT] ⏰ ${new Date().toISOString().slice(11,19)} | MEM: ${mem}MB | Users: ${userCount} | B策略: ${bbStrategyManager?.running ? '✅' : '❌'}`);
  }, 5 * 60 * 1000);

  process.on('SIGINT', () => console.log('⚠️ SIGINT 忽略 — B策略继续运行'));
  process.on('SIGTERM', () => console.log('⚠️ SIGTERM 忽略 — B策略继续运行'));
}

main().catch(e => {
  console.error('❌ 启动失败:', e);
  setTimeout(() => main().catch(() => {}), 5000);
});
