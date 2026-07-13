/**
 * AI Quant Agent v11 — 主逻辑（被 index.js / ClusterManager 加载）
 */
const Engine = require('./engine');
const Dashboard = require('./dashboard/server');
const { CEXUserTrader } = require('./saas/cex-user-trader');
const SaasServer = require('./saas/server');
const GoldEngine = require('./saas/gold-engine');
const ForexEngine = require('./saas/forex-engine');
const IndexEngine = require('./saas/index-engine');
const CrossMarketArb = require('./saas/cross-market-arb');
const MultiMarketManager = require('./saas/multi-market-manager');
const CrossMarketSignalBus = require('./saas/cross-market-signals');
const CommodityEngine = require('./saas/commodity-engine');
const BondEngine = require('./saas/bond-engine');
const CapitalRouter = require('./saas/capital-router');
const SharedRiskLayer = require('./saas/shared-risk-layer');
const NotificationService = require('./saas/notification-service');

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   🔥 AI Quant Agent v96 — 全品种全市场智能交易引擎      ║');
  console.log('║   Crypto+Gold+Forex+Index+Commodity+Bond+CrossArb       ║');
  console.log('║   48策略 × 7市场 × 共享风控 × 跨市场对冲 × 机构级架构  ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  const engine = new Engine();
  const goldEngine = new GoldEngine();
  const dashboard = new Dashboard(engine, 10010);

  // v98: CEX用户交易引擎 — 传入dataBus和多市场引擎引用
  let cexUserTrader = null;
  try {
    cexUserTrader = new CEXUserTrader({
      userDB: { users: {} },
      dataBus: engine.dataBus,  // v98: 传入dataBus
      strategyManager: engine.strategyManager,
      intervalMs: 30000,
    });
  } catch (e) {
    console.log('[CEX] CEXUserTrader 初始化失败:', e.message);
  }

  dashboard.start();
  await engine.start();

  // v95: 初始化多市场管理器
  let multiMarket = null;
  let forexEngine = null;
  let indexEngine = null;
  let crossArb = null;

  // v81: 启动黄金现货引擎
  try {
    await goldEngine.start();
    console.log('[Gold] ✅ 黄金现货引擎已启动 — PAXGUSDT Spot');
  } catch (e) {
    console.log('[Gold] ⚠️ 黄金引擎启动失败:', e.message);
  }

  // v95: 启动外汇引擎
  try {
    const apiKey = process.env.BINANCE_API_KEY || '';
    const apiSecret = process.env.BINANCE_API_SECRET || '';
    forexEngine = new ForexEngine(apiKey, apiSecret);
    await forexEngine.start();
    console.log('[Forex] ✅ 外汇引擎已启动 — EUR/USD, GBP/USD, USD/JPY, AUD/USD');
  } catch (e) {
    console.log('[Forex] ⚠️ 外汇引擎启动失败:', e.message);
  }

  // v95: 启动股指/ETF引擎
  try {
    const apiKey = process.env.BINANCE_API_KEY || '';
    const apiSecret = process.env.BINANCE_API_SECRET || '';
    indexEngine = new IndexEngine(apiKey, apiSecret);
    await indexEngine.start();
    console.log('[Index] ✅ 股指/ETF引擎已启动 — BTC, ETH, SOL, BNB, AVAX, PAXG');
  } catch (e) {
    console.log('[Index] ⚠️ 股指引擎启动失败:', e.message);
  }

  // v95: 启动跨市场套利引擎
  try {
    const apiKey = process.env.BINANCE_API_KEY || '';
    const apiSecret = process.env.BINANCE_API_SECRET || '';
    crossArb = new CrossMarketArb(apiKey, apiSecret);
    await crossArb.start();
    console.log('[Arb] ✅ 跨市场套利引擎已启动 — 现货期货/跨资产/三角套利');
  } catch (e) {
    console.log('[Arb] ⚠️ 跨市场套利引擎启动失败:', e.message);
  }

  // v96: 启动商品引擎 (石油/白银/大宗商品)
  let commodityEngine = null;
  try {
    const apiKey = process.env.BINANCE_API_KEY || '';
    const apiSecret = process.env.BINANCE_API_SECRET || '';
    commodityEngine = new CommodityEngine(apiKey, apiSecret);
    await commodityEngine.start();
    console.log('[Commodity] ✅ 商品引擎已启动 — Gold/Silver/Oil/Energy');
  } catch (e) {
    console.log('[Commodity] ⚠️ 商品引擎启动失败:', e.message);
  }

  // v96: 启动债券/国债引擎
  let bondEngine = null;
  try {
    const apiKey = process.env.BINANCE_API_KEY || '';
    const apiSecret = process.env.BINANCE_API_SECRET || '';
    bondEngine = new BondEngine(apiKey, apiSecret);
    await bondEngine.start();
    console.log('[Bond] ✅ 国债/债券引擎已启动 — 利率周期/收益率曲线/通胀挂钩');
  } catch (e) {
    console.log('[Bond] ⚠️ 债券引擎启动失败:', e.message);
  }

  // v96: 智能资金路由器
  let capitalRouter = null;
  try {
    const balance = 138.53;
    capitalRouter = new CapitalRouter(balance);
    console.log('[CapitalRouter] ✅ 资金路由器已启动 — $' + balance.toFixed(2));
  } catch (e) {
    console.log('[CapitalRouter] ⚠️ 资金路由器启动失败:', e.message);
  }

  // v97: 跨市场共享风控层
  const sharedRisk = new SharedRiskLayer(138.53);
  console.log('[SharedRisk] ✅ 跨市场共享风控层已启动');

  // v97: 将共享风控层注入主引擎
  engine.sharedRisk = sharedRisk;

  console.log('');
  console.log('📊 ═══════════════════════════════════════════');
  console.log('📊 全品种引擎状态:');
  console.log(`📊   Crypto Futures:  ✅ (18策略融合)`);
  console.log(`📊   Gold Spot:       ${goldEngine ? '✅' : '❌'} (4策略融合)`);
  console.log(`📊   Forex:           ${forexEngine ? '✅' : '❌'} (5策略融合)`);
  console.log(`📊   Index/ETF:       ${indexEngine ? '✅' : '❌'} (6策略融合)`);
  console.log(`📊   Cross Arb:       ${crossArb ? '✅' : '❌'} (8种套利)`);
  console.log(`📊   Commodity:       ${commodityEngine ? '✅' : '❌'} (4策略融合)`);
  console.log(`📊   Bond:            ${bondEngine ? '✅' : '❌'} (4策略融合)`);
  console.log(`📊   Capital Router:  ${capitalRouter ? '✅' : '❌'} (动态分配)`);
  console.log(`📊   Shared Risk:     ✅ (跨市场统一风控)`);
  console.log('📊 ═══════════════════════════════════════════');

  // v95: 启动跨市场信号总线
  let signalBus = null;
  try {
    signalBus = new CrossMarketSignalBus({
      crypto: engine,
      gold: goldEngine,
      forex: forexEngine,
      index: indexEngine,
    });
    signalBus.start();
    console.log('[SignalBus] ✅ 跨市场信号总线已启动 — 7个联动规则');
  } catch (e) {
    console.log('[SignalBus] ⚠️ 信号总线启动失败:', e.message);
  }

  // v76: 启动 SaaS 多用户平台
  let saasServer = null;
  try {
    saasServer = new SaasServer(engine, 10020, {
      userTrader: cexUserTrader,
      goldEngine,
      forexEngine,
      indexEngine,
      commodityEngine,
      bondEngine,
      capitalRouter,
      sharedRisk,
      signalBus,
      crossArb,
      multiMarket,
    });
    saasServer.start();
  } catch (e) {
    console.log('[SaaS] SaasServer 初始化失败:', e.message);
  }

  // v72: 引擎就绪后连接 CEX 交易器
  if (cexUserTrader) {
    cexUserTrader.dataBus = engine.dataBus;
    cexUserTrader.strategyManager = engine.strategyManager;
    try {
      const fs = require('fs');
      const path = require('path');
      const usersFile = path.join(__dirname, 'data', 'saas-users.json');
      if (fs.existsSync(usersFile)) {
        const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
        cexUserTrader.userDB = { users };
        const cexUsers = Object.entries(users).filter(([_, u]) => u.binanceApiKey && u.binanceSecret);
        console.log(`[CEX] 加载 ${cexUsers.length} 个 CEX 用户`);
      }
    } catch (e) {
      console.log('[CEX] 用户数据库加载失败:', e.message);
    }
    // v98: 传入多市场引擎引用
    cexUserTrader.forexEngine = forexEngine;
    cexUserTrader.indexEngine = indexEngine;
    cexUserTrader.goldEngine = goldEngine;
    cexUserTrader.commodityEngine = commodityEngine;
    cexUserTrader.bondEngine = bondEngine;
    cexUserTrader.crossArb = crossArb;
    cexUserTrader.start();
  }

  // v97: 通知服务
  const notifier = new NotificationService();
  
  // v97: 系统启动完成通知
  notifier.notifySystemStatus({
    engines: {
      'Crypto Futures': true,
      'Gold Spot': !!goldEngine,
      'Forex': !!forexEngine,
      'Index/ETF': !!indexEngine,
      'Cross Arb': !!crossArb,
      'Commodity': !!commodityEngine,
      'Bond': !!bondEngine,
      'Signal Bus': true,
      'Shared Risk': true,
    }
  });

  process.on('SIGINT', async () => {
    console.log('\nShutting down all engines...');
    await engine.stop();
    goldEngine.stop();
    if (forexEngine) forexEngine.stop();
    if (indexEngine) indexEngine.stop();
    if (crossArb) crossArb.stop();
    if (signalBus) signalBus.stop();
    if (commodityEngine) commodityEngine.stop();
    if (bondEngine) bondEngine.stop();
    dashboard.stop();
    if (saasServer) saasServer.stop();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await engine.stop();
    goldEngine.stop();
    if (forexEngine) forexEngine.stop();
    if (indexEngine) indexEngine.stop();
    if (crossArb) crossArb.stop();
    if (signalBus) signalBus.stop();
    if (commodityEngine) commodityEngine.stop();
    if (bondEngine) bondEngine.stop();
    dashboard.stop();
    if (saasServer) saasServer.stop();
    process.exit(0);
  });
  process.on('uncaughtException', (err) => {
    console.error('[FATAL] uncaughtException:', err.message);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] unhandledRejection:', reason);
  });
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
