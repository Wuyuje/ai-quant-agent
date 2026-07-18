/**
 * SaaS Platform v3.0 启动入口 — v108 全品种全市场
 * 
 * 启动的所有引擎：
 *   1. Crypto Futures 引擎 (BTC/ETH/SOL等10交易对)
 *   2. Gold 现货引擎 (PAXGUSDT — 4策略融合)
 *   3. Forex 外汇引擎 (EUR/USD等 — 5策略融合)
 *   4. Index/ETF 引擎 (6策略融合)
 *   5. Commodity 商品引擎 (原油/白银等 — 4策略融合)
 *   6. Bond 债券引擎 (利率周期/收益率曲线 — 4策略融合)
 *   7. CrossMarket 跨市场套利引擎 (8种套利)
 *   8. CrossMarketSignalBus 跨市场信号总线 (7联动规则)
 *   9. CapitalRouter 资金路由器 (动态分配)
 *   10. SharedRiskLayer 跨市场共享风控
 *   11. NotificationService 多渠道通知
 *   12. MultiEngine v3 百万用户框架
 *   13. Greenfield BSC链上同步
 *   14. Dashboard 仪表盘
 *   15. SaaS Server 用户平台
 *   16. UserTrader 用户自动跟单
 *
 * 启动：
 *   node saas/start.js
 */

const path = require('path');
const fs = require('fs');
const DataBus = require('../data/databus');
const DeepSeekBrain = require('../brain/deepseek-brain');
const MasterDAgent = require('../brain/masterd-agent'); // v113: MasterD分身
const Engine = require('../engine');
const SaasServer = require('./server');
const UserTrader = require('./user-trader');
const { CEXUserTrader } = require('./cex-user-trader'); // v110: 普通用户全品种交易
const { BBStrategyManager } = require('./bb-strategy-manager'); // BB多用户布林带策略

// v108: 多市场引擎
const GoldEngine = require('./gold-engine');
const ForexEngine = require('./forex-engine');
const SymbolEngine = require('./symbol-engine'); // v108.3: 通用品种引擎
const CrossMarketArb = require('./cross-market-arb');
const CrossMarketSignalBus = require('./cross-market-signals');
const CapitalRouter = require('./capital-router');
const SharedRiskLayer = require('./shared-risk-layer');
const signalPool = require('./signal-pool');
const dataHub = require('./data-hub');
const NewsHub = require('./news-hub'); // v113: 新闻信息中心
const NotificationService = require('./notification-service');

// v108: 百万用户框架
const MultiEngineV3 = require('../multi-v3/multi-engine-v3');

// v108: Greenfield 链上同步
let GreenfieldSync = null;
try { GreenfieldSync = require('../greenfield/sync'); } catch(e) { console.log('[Greenfield] 未加载:', e.message); }

const CONFIG = require('../config/loader');
const PAIRS = require('../config/trading-pairs');

// 全局引用（用于优雅关闭）
let _engine, _goldEngine, _forexEngine;
let _symbolEngines = {}; // v108.3: 每品种独立引擎
let _crossArb, _signalBus, _multiEngine, _greenfieldSync;
let _dashboard, _server, _userTrader, _notifier;

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  🔥 ARK Quant Agent v108 — 全品种全市场智能交易引擎       ║');
  console.log('║  Crypto+Gold+Forex+Index+Commodity+Bond+CrossArb         ║');
  console.log('║  48策略 × 7市场 × 共享风控 × 跨市场对冲 × 百万用户       ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  // 确保数据目录
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // ═══ 防死机：检测 watchdog 写入的 crash state，自己优雅退出让 watchdog 重启 ═══
  const crashStateFile = path.join(dataDir, 'engine-crash.state');
  if (fs.existsSync(crashStateFile)) {
    try {
      const crashInfo = JSON.parse(fs.readFileSync(crashStateFile, 'utf-8'));
      console.log(`[启动] 🚨 检测到 crash state (${crashInfo.reason})，本实例退出，让 watchdog 启动新实例`);
      // 删除 state 文件后退出
      fs.unlinkSync(crashStateFile);
      process.exit(0);
    } catch (e) { /* state 文件损坏，忽略 */ }
  }

  // ═══ 定期检测 crash state（5 秒检查一次，让 watchdog 能触发本实例退出） ═══
  setInterval(() => {
    try {
      if (fs.existsSync(crashStateFile)) {
        const crashInfo = JSON.parse(fs.readFileSync(crashStateFile, 'utf-8'));
        console.log(`[运行中] 🚨 检测到 crash state (${crashInfo.reason})，本实例退出，watchdog 会重启`);
        fs.unlinkSync(crashStateFile);
        // 不调用 gracefulShutdown，直接退出（不平仓、不碰 Binance 持仓）
        // Binance 上的仓位会原封不动保留，新实例启动后 Guardian 自动接管
        setTimeout(() => process.exit(0), 500);
      }
    } catch (e) { /* ignore */ }
  }, 5000);

  // ═══ 1. 共享 DataBus（行情数据） ═══
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

  // ═══ 2. DeepSeek（可选） ═══
  let deepSeek = null;
  try {
    deepSeek = new DeepSeekBrain({
      apiKey: CONFIG.deepseek?.apiKey || process.env.DEEPSEEK_API_KEY,
      model: CONFIG.deepseek?.model || 'deepseek-chat',
    });
    console.log('[启动] 🧠 DeepSeek 就绪');
  } catch (e) {
    console.log('[启动] ⚠️ DeepSeek 未配置，使用规则引擎');
  }

  // ═══ 3. Binance API Key（从 .env 读取，供多市场引擎使用） ═══
  const binanceApiKey = process.env.BINANCE_API_KEY || '';
  const binanceApiSecret = process.env.BINANCE_API_SECRET || '';

  // ═══ 4. 管理员 Crypto 引擎 ═══
  const port = process.env.SAAS_PORT || 10020;
  const engine = new Engine({ dataBus });
  _engine = engine;
  engine.start();
  console.log('[启动] 🤖 Crypto Futures 引擎已启动 (18策略融合)');

  // v112.5: 注入统一信号池和数据收集中心
  engine.signalPool = signalPool;
  engine.dataHub = dataHub;
  dataHub.setDeps({
    neuralNet: engine.neuralNet,
    autoTrainer: engine.autoTrainer,
    strategyManager: engine.strategyManager,
    brain: engine.brain,
    exitManager: engine.exitManager,
    positionSizer: engine.positionSizer,
  });
  console.log('[启动] 🧠 统一信号池 + 数据收集中心已注入');

  // ═══ v113: MasterD Agent 分身 ═══
  const masterdAgent = new MasterDAgent({
    // v2.0: OpenRouter 免费模型 (27个免费大模型, 无需付费)
    openrouter: {
      apiKey: CONFIG.openrouter?.apiKey || process.env.OPENROUTER_API_KEY,
      freeModels: CONFIG.openrouter?.freeModels,
    },
    deepseek: {
      apiKey: CONFIG.deepseek?.apiKey || process.env.DEEPSEEK_API_KEY,
      model: CONFIG.deepseek?.model || 'deepseek-chat',
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    },
    claude: {
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
    },
  });
  masterdAgent.loadState();
  engine.masterdAgent = masterdAgent;
  engine.news = masterdAgent.news; // 新闻中心引用

  // v113.11: 自我进化闭环 — Agent绑定engine引用(读K线+改参数+热加载)
  masterdAgent.config.engine = engine;
  masterdAgent.autoFixer.attach(engine, masterdAgent);
  masterdAgent.hotLoader.attach(engine.strategyManager);

  // v113.11.2: 暂存子引擎引用 — AutoFixer需要控制子引擎
  engine._subEngines = [];
  dataHub.setDeps({
    neuralNet: engine.neuralNet,
    autoTrainer: engine.autoTrainer,
    strategyManager: engine.strategyManager,
    brain: engine.brain,
    exitManager: engine.exitManager,
    positionSizer: engine.positionSizer,
    masterdAgent, // v113: Agent也接收交易反馈
  });
  console.log(`[启动] 🧬 MasterD Agent 分身已启动 (模型: ${masterdAgent.llm.getAvailableModels().map(m => m.name).join(', ') || '纯规则模式'})`);

  // ═══ 5. v108: 多市场引擎 ═══
  // Gold 引擎
  let goldEngine = null;
  try {
    goldEngine = new GoldEngine();
    _goldEngine = goldEngine;
    engine._subEngines.push(goldEngine);
    await goldEngine.start();
    console.log('[启动] 🥇 Gold 现货引擎已启动 (4策略融合)');
  } catch (e) { console.log('[启动] ⚠️ Gold 引擎启动失败:', e.message); }

  // Forex 引擎
  let forexEngine = null;
  try {
    forexEngine = new ForexEngine(binanceApiKey, binanceApiSecret);
    _forexEngine = forexEngine;
    engine._subEngines.push(forexEngine);
    await forexEngine.start();
    console.log('[启动] 💱 Forex 外汇引擎已启动 (5策略融合)');
  } catch (e) { console.log('[启动] ⚠️ Forex 引擎启动失败:', e.message); }

  // ═══ v108.4: 5大品种类别独立引擎 — 合约/现货/股票/商品/债券 各自独立 ═══
  //
  // 类别1: 加密货币合约 (已由主引擎 Engine 处理, 18策略, 10币种)
  // 类别2: 加密货币现货 (新增, SymbolEngine spot)
  // 类别3: 股票/ETF (现货+合约, 每品种独立)
  // 类别4: 商品 (合约, 每品种独立)
  // 类别5: 债券/利率 (合约, 每品种独立)
  //
  const symbolEngineConfigs = [
    // ── 类别2: 加密货币现货 (BTC/ETH/SOL等现货, 只做多) ──
    { name: 'BTC-SPOT',   category: 'crypto',   market: 'spot',    symbols: ['BTCUSDT'],  equity: 50 },
    { name: 'ETH-SPOT',   category: 'crypto',   market: 'spot',    symbols: ['ETHUSDT'],  equity: 50 },
    { name: 'SOL-SPOT',   category: 'crypto',   market: 'spot',    symbols: ['SOLUSDT'],  equity: 50 },
    { name: 'BNB-SPOT',   category: 'crypto',   market: 'spot',    symbols: ['BNBUSDT'],  equity: 50 },

    // ── 类别3: 股票/ETF 现货 (币安APP「股票」板块, 带B, 只做多) ──
    { name: 'TSLA-SPOT',  category: 'stock',    market: 'spot',    symbols: ['TSLABUSDT'], equity: 50 },
    { name: 'NVDA-SPOT',  category: 'stock',    market: 'spot',    symbols: ['NVDABUSDT'], equity: 50 },
    { name: 'AAPL-SPOT',  category: 'stock',    market: 'futures', symbols: ['AAPLUSDT'], equity: 50 },
    { name: 'META-SPOT',  category: 'stock',    market: 'spot',    symbols: ['METABUSDT'], equity: 50 },
    { name: 'MSFT-SPOT',  category: 'stock',    market: 'spot',    symbols: ['MSFTBUSDT'], equity: 50 },
    { name: 'GOOGL-SPOT', category: 'stock',    market: 'spot',    symbols: ['GOOGLBUSDT'],equity: 50 },
    { name: 'SPY-SPOT',   category: 'etf',      market: 'spot',    symbols: ['SPYBUSDT'],  equity: 50 },
    { name: 'QQQ-SPOT',   category: 'etf',      market: 'spot',    symbols: ['QQQBUSDT'],  equity: 50 },

    // ── 类别3: 股票/ETF 合约永续 (币安APP「U本位」板块, 可做多做空) ──
    { name: 'TSLA-PERP',  category: 'stock',    market: 'futures', symbols: ['TSLAUSDT'], equity: 50 },
    { name: 'NVDA-PERP',  category: 'stock',    market: 'futures', symbols: ['NVDAUSDT'], equity: 50 },
    { name: 'AAPL-PERP',  category: 'stock',    market: 'futures', symbols: ['AAPLUSDT'], equity: 50 },
    { name: 'META-PERP',  category: 'stock',    market: 'futures', symbols: ['METAUSDT'], equity: 50 },
    { name: 'MSFT-PERP',  category: 'stock',    market: 'futures', symbols: ['MSFTUSDT'], equity: 50 },
    { name: 'GOOGL-PERP', category: 'stock',    market: 'futures', symbols: ['GOOGLUSDT'],equity: 50 },
    { name: 'SPY-PERP',   category: 'etf',      market: 'futures', symbols: ['SPYUSDT'],  equity: 50 },
    { name: 'QQQ-PERP',   category: 'etf',      market: 'futures', symbols: ['QQQUSDT'],  equity: 50 },

    // ── 类别4: 商品 (合约U本位, 可做多做空) ──
    { name: 'XAG-PERP',   category: 'commodity',market: 'futures', symbols: ['XAGUSDT'],  equity: 50 },
    { name: 'XAU-PERP',   category: 'commodity',market: 'futures', symbols: ['XAUUSDT'],  equity: 50 },
    { name: 'COPPER-PERP',category: 'commodity',market: 'futures', symbols: ['COPPERUSDT'],equity: 50 },
    { name: 'NATGAS-PERP',category: 'commodity',market: 'futures', symbols: ['NATGASUSDT'],equity: 50 },

    // ── 类别5: 债券/利率 (合约U本位) ──
    // USDC-PERP 已移除 — 稳定币无波动，无法盈利
    { name: 'UVXY-PERP',  category: 'bond',     market: 'futures', symbols: ['UVXYUSDT'], equity: 50 },
    { name: 'URNM-PERP',  category: 'bond',     market: 'futures', symbols: ['URNMUSDT'], equity: 50 },
  ];

  for (const cfg of symbolEngineConfigs) {
    try {
      const eng = new SymbolEngine({
        ...cfg,
        apiKey: binanceApiKey,
        apiSecret: binanceApiSecret,
        equity: 50, // 每品种分配$50
      });
      eng._loadState();
      await eng.start();
      _symbolEngines[cfg.name] = eng;
      engine._subEngines.push(eng);  // v113.11.2: 绑定给AutoFixer
      console.log(`[启动] 📊 ${cfg.name} 引擎已启动 | ${cfg.category} | ${cfg.market} | 标的: ${cfg.symbols.join(',')}`);
    } catch (e) { console.log(`[启动] ⚠️ ${cfg.name} 引擎启动失败: ${e.message}`); }
  }
  console.log(`[启动] ✅ ${Object.keys(_symbolEngines).length} 个品种引擎全部启动`);

  // 跨市场套利引擎
  let crossArb = null;
  try {
    crossArb = new CrossMarketArb(binanceApiKey, binanceApiSecret);
    _crossArb = crossArb;
    await crossArb.start();
    console.log('[启动] 🔄 CrossMarket 跨市场套利引擎已启动 (8种套利)');
  } catch (e) { console.log('[启动] ⚠️ CrossMarket 套利引擎启动失败:', e.message); }

  // ═══ 6. v108: 资金路由 + 共享风控 + 通知 ═══
  let capitalRouter = null;
  try {
    // 从引擎获取余额
    let balance = 0;
    try { const bal = await engine.trader.getBalance(); balance = bal?.balance || 0; } catch(e) {}
    capitalRouter = new CapitalRouter(balance || 100);
    console.log('[启动] 💰 CapitalRouter 资金路由器已启动');
  } catch (e) { console.log('[启动] ⚠️ CapitalRouter 启动失败:', e.message); }

  // 跨市场共享风控层
  let sharedRisk = null;
  try {
    let balance = 0;
    try { const bal = await engine.trader.getBalance(); balance = bal?.balance || 0; } catch(e) {}
    sharedRisk = new SharedRiskLayer(balance || 100);
    engine.sharedRisk = sharedRisk; // 注入主引擎
    console.log('[启动] 🛡️ SharedRiskLayer 跨市场共享风控已启动');
  } catch (e) { console.log('[启动] ⚠️ SharedRiskLayer 启动失败:', e.message); }

  // 跨市场信号总线
  let signalBus = null;
  try {
    signalBus = new CrossMarketSignalBus({
      crypto: engine,
      gold: goldEngine,
      forex: forexEngine,
      symbolEngines: _symbolEngines, // v108.3
    });
    _signalBus = signalBus;
    signalBus.start();
    console.log('[启动] 📡 CrossMarketSignalBus 跨市场信号总线已启动 (7联动规则)');
  } catch (e) { console.log('[启动] ⚠️ SignalBus 启动失败:', e.message); }

  // 通知服务
  let notifier = null;
  try {
    notifier = new NotificationService();
    _notifier = notifier;
    notifier.notifySystemStatus({
      engines: {
        'Crypto Futures': true,
        'Gold Spot': !!goldEngine,
        'Forex': !!forexEngine,
        'Symbol Engines': Object.keys(_symbolEngines).length > 0,
        'Cross Arb': !!crossArb,
        'Signal Bus': !!signalBus,
        'Shared Risk': !!sharedRisk,
      }
    });
    console.log('[启动] 📬 NotificationService 多渠道通知已启动');
  } catch (e) { console.log('[启动] ⚠️ NotificationService 启动失败:', e.message); }

  // ═══ 7. v108: Greenfield BSC 链上同步 ═══
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

  // ═══ 8. SaaS Server（用户平台） ═══
  const server = new SaasServer(engine, port, {
    dataBus,
    goldEngine, forexEngine,
    symbolEngines: _symbolEngines,
    capitalRouter, sharedRisk, signalBus, crossArb,
  });
  _server = server;
  server.start();

  // ═══ 9. Dashboard 仪表盘 ═══
  const Dashboard = require('../dashboard/server');
  const dashboardPort = process.env.DASHBOARD_PORT || 10010;
  const dashboard = new Dashboard(engine, dashboardPort, {
    capitalRouter, sharedRisk, signalBus, crossArb,
    goldEngine, forexEngine, symbolEngines: _symbolEngines,
    masterdAgent: engine.masterdAgent, // v113: 传给仪表盘
    newsHub: engine.news, // v113: 新闻中心
  });
  _dashboard = dashboard;
  dashboard.start();
  console.log(`[启动] 📊 Dashboard 运行在端口 ${dashboardPort}`);

  // ═══ 10. UserTrader 用户自动跟单 ═══
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

  // ═══ 10b. v110: CEXUserTrader — 已停用（2026-07-18）══
  // 停用原因：CEXUserTrader 与 BBStrategyManager 共用 Binance 账户，
  // CEXUserTrader 的 ATR 止损会提前平掉 BB 的仓位，
  // BBEngine 看到 remote 持仓消失就误判为“强平”，
  // 导致 BB 策略胜率从 100% 被拖到 72.3%。
  // 停用后 BB 策略独立运行，胜率恢复到 100%（轨道止盈部分）。
  // 未来若要恢复，取消下面的注释即可。
  /*
  try {
    const cexTrader = new CEXUserTrader({
      userDB: server.userDB,
      dataBus,
      strategyManager: engine.strategyManager || null,
      intervalMs: 60000,
    });
    // 注入所有引擎信号源 + 管理员核心策略组件
    cexTrader.goldEngine = goldEngine || null;
    cexTrader.forexEngine = forexEngine || null;
    cexTrader.symbolEngines = _symbolEngines || {};
    cexTrader.cryptoEngine = engine;
    cexTrader.crossArb = _crossArb || null;
    cexTrader.signalBus = _signalBus || null;
    // v111: 共享管理员策略组件 — Brain/ExitManager/PositionSizer
    cexTrader.brain = engine.brain || null;
    cexTrader.exitManager = engine.exitManager || null;
    cexTrader.positionSizer = engine.positionSizer || null;
    cexTrader.sharedRisk = engine.sharedRisk || null;
    // v112.5: 共享信号池和数据收集中心
    cexTrader.signalPool = signalPool;
    cexTrader.dataHub = dataHub;
    cexTrader.start();
    server.cexUserTrader = cexTrader;
    engine._cexUserTrader = cexTrader; // v113.68: 让 AutoFixer 能访问用户交易器
    console.log('[启动] 🤖 CEXUserTrader 全品种自动交易已启动 (Gold/Forex/Stock/Commodity/Bond/Crypto)');
  } catch (e) { console.log('[启动] ⚠️ CEXUserTrader 启动失败:', e.message); }
  */
  console.log('[启动] ⏸️ CEXUserTrader 已停用 — BB 策略独立运行避免双策略冲突');

  // ═══ 10c. BBStrategyManager — 多用户布林带策略 ═══
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
    console.log('[启动] 📊 BBStrategyManager 多用户布林带策略已启动');
  } catch (e) { console.log('[启动] ⚠️ BBStrategyManager 启动失败:', e.message); }

  // ═══ 11. v108: MultiEngine v3 — 百万用户框架 ═══
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
    // 注入共享组件
    multiEngine.sharedDataBus = dataBus;
    multiEngine.sharedDeepSeek = deepSeek;
    // v113.14: 共享策略实例 + rate-limiter + 平仓管理 + 仓位计算
    multiEngine.sharedStrategy = engine?.strategyManager || null;
    multiEngine.sharedLimiter = require('./rate-limiter').userLimiter;
    multiEngine.sharedExitManager = engine?.exitManager || null;
    multiEngine.sharedPositionSizer = engine?.positionSizer || null;
    _multiEngine = multiEngine;
    await multiEngine.init();
    multiEngine.start();
    console.log(`[启动] 🚀 MultiEngine v3 百万用户框架已启动 — HTTP:${multiPort} WS:${multiWsPort}`);
    console.log(`[启动]    管理面板: http://localhost:${multiPort}/admin/overview?token=ark-admin-v3-secret`);
  } catch (e) { console.log('[启动] ⚠️ MultiEngine v3 启动失败:', e.message); }

  // ═══ 状态汇总 ═══
  const _cats = {};
  for (const [k, e] of Object.entries(_symbolEngines)) {
    const c = e.category || 'other';
    if (!_cats[c]) _cats[c] = [];
    _cats[c].push(k);
  }
  console.log('');
  console.log('📊 ═══════════════════════════════════════════');
  console.log('📊 全品种引擎状态 (5大类别独立):');
  console.log('📊 ───────────────────────────────────────────');
  console.log(`📊 1. 加密货币合约: ✅ (主引擎 18策略融合) — 端口 ${dashboardPort}/${port}`);
  const cryptoSpot = (_cats['crypto'] || []).filter(k => k.includes('SPOT'));
  console.log(`📊 2. 加密货币现货: ${cryptoSpot.length > 0 ? '✅' : '❌'} (${cryptoSpot.length}个: ${cryptoSpot.join(', ')})`);
  const stockSpot = (_cats['stock'] || []).filter(k => k.includes('SPOT'));
  const stockPerp = (_cats['stock'] || []).filter(k => k.includes('PERP'));
  console.log(`📊 3. 股票/ETF 现货: ${stockSpot.length > 0 ? '✅' : '❌'} (${stockSpot.length}个: ${stockSpot.join(', ')})`);
  console.log(`📊    股票/ETF 合约: ${stockPerp.length > 0 ? '✅' : '❌'} (${stockPerp.length}个: ${stockPerp.join(', ')})`);
  const etfs = (_cats['etf'] || []);
  if (etfs.length) console.log(`📊    ETF引擎:        ✅ (${etfs.length}个: ${etfs.join(', ')})`);
  const commodities = (_cats['commodity'] || []);
  console.log(`📊 4. 商品:          ${commodities.length > 0 ? '✅' : '❌'} (${commodities.length}个: ${commodities.join(', ')})`);
  const bonds = (_cats['bond'] || []);
  console.log(`📊 5. 债券/利率:    ${bonds.length > 0 ? '✅' : '❌'} (${bonds.length}个: ${bonds.join(', ')})`);
  console.log(`📊    Gold Spot:      ${goldEngine ? '✅' : '❌'} (4策略融合)`);
  console.log(`📊    Forex:          ${forexEngine ? '✅' : '❌'} (5策略融合)`);
  console.log(`📊    Cross Arb:      ${crossArb ? '✅' : '❌'} (8种套利)`);
  console.log(`📊    Capital Router: ${capitalRouter ? '✅' : '❌'} (动态分配)`);
  console.log(`📊    Shared Risk:    ${sharedRisk ? '✅' : '❌'} (跨市场统一风控)`);
  console.log(`📊    Signal Bus:     ${signalBus ? '✅' : '❌'} (7联动规则)`);
  console.log(`📊    Notification:   ${notifier ? '✅' : '❌'} (多渠道通知)`);
  console.log(`📊    Greenfield:     ${greenfieldSync ? '✅' : '❌'} (BSC链上同步)`);
  console.log(`📊    MultiEngine v3: ${multiEngine ? '✅' : '❌'} (百万用户框架)`);
  console.log(`📊    UserTrader:    ✅ (用户跟单-加密货币)`);
  console.log(`📊    CEX全品种:     ✅ (用户交易-全品种信号)`);
  console.log(`📊    品种引擎总计:    ${Object.keys(_symbolEngines).length}个`);
  console.log('📊 ═══════════════════════════════════════════');
  console.log('');
  console.log('═══════════════════════════════');
  console.log(`  🌐 Dashboard: http://localhost:${dashboardPort}`);
  console.log(`  🌐 SaaS API:  http://localhost:${port}`);
  if (multiEngine) console.log(`  🌐 Multi v3:  http://localhost:${process.env.MULTI_PORT || 10030}`);
  console.log('═══════════════════════════════');
  console.log('\n等待登录... 🔗\n');

  // ═══ 防崩溃 v2 — 不吞错误，记到 state 文件后退出，让 watchdog 重启 ═══
  process.on('uncaughtException', (err) => {
    console.error('[FATAL] uncaughtException:', err.message, err.stack?.split('\n').slice(0,3).join('\n'));
    // 写入崩溃状态文件，watchdog 检测后重启
    try {
      fs.writeFileSync(path.join(__dirname, '..', 'data', 'engine-crash.state'),
        JSON.stringify({ reason: 'uncaughtException', msg: err.message, ts: Date.now() }));
    } catch (e) { /* ignore */ }
    // 3 秒后退出（让日志写入）
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

  // 优雅关闭 — SIGINT/SIGTERM 触发关闭 + 退出，watchdog 会重启
  process.on('SIGINT', () => {
    console.log('⚠️ SIGINT — 优雅关闭后退出，watchdog 会重启');
    gracefulShutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    console.log('⚠️ SIGTERM — 优雅关闭后退出，watchdog 会重启');
    gracefulShutdown('SIGTERM');
  });
}

main().catch(e => {
  console.error('❌ 启动失败:', e);
  console.log('⚠️ 启动失败，5秒后重试...');
  setTimeout(() => main().catch(() => {}), 5000);
});

// ========== 防死机增强 ==========
let _isShuttingDown = false;
// ⚠️ 重要：gracefulShutdown 绝不碰 Binance 持仓
// Binance 上的所有仓位原封不动保留，重启后 Guardian 同步机制会自动接管
async function gracefulShutdown(reason) {
  if (_isShuttingDown) return;
  _isShuttingDown = true;
  console.error(`🚨 [${reason}] 开始优雅关闭（Binance 持仓保留不动）...`);
  
  // 写入关闭状态文件（watchdog 可检测）
  try {
    const stateFile = path.join(__dirname, '..', 'data', 'engine-shutdown.state');
    fs.writeFileSync(stateFile, JSON.stringify({ reason, ts: Date.now() }));
  } catch (e) { /* ignore */ }
  
  // 只停止引擎循环，不碰任何仓位
  try {
    if (_engine) { _engine.running = false; }
    if (_goldEngine) { _goldEngine.running = false; }
    if (_forexEngine) { _forexEngine.running = false; }
  } catch (e) { /* ignore */ }
  
  // 关闭 HTTP 服务器
  try {
    if (_server) { _server.close(); }
  } catch (e) { /* ignore */ }
  
  // 等待 2 秒让持仓状态保存到本地 state 文件
  await new Promise(r => setTimeout(r, 2000));
  console.error(`🚨 [${reason}] 优雅关闭完成，Binance 持仓保留，退出进程（watchdog 会启动新实例接管）`);
  process.exit(1);
}

setInterval(() => {
  const mem = process.memoryUsage();
  const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
  const rssUsedMB = Math.round(mem.rss / 1024 / 1024);
  if (rssUsedMB > 2048) {
    console.error(`⚠️ [内存警告] RSS=${rssUsedMB}MB Heap=${heapUsedMB}MB`);
    if (global.gc) global.gc();
  }
  if (rssUsedMB > 3072) {
    gracefulShutdown(`内存超限 RSS=${rssUsedMB}MB`);
  }
}, 30000);

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

let lastLoopCheck = Date.now();
setInterval(() => {
  const now = Date.now();
  const delay = now - lastLoopCheck - 5000;
  if (delay > 1000) {
    console.error(`⚠️ [事件循环延迟] ${delay}ms`);
  }
  lastLoopCheck = now;
}, 5000);
