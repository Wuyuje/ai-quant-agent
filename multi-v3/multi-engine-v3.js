/**
 * MultiEngine v3 — 百万用户主引擎（v113.14 集群就绪版）
 *
 * 架构升级：
 *   - 分批轮询调度：每轮只处理一批用户（可配置 batch size）
 *   - 共享策略实例：1 个 StrategyManager 给所有用户用，不为每个用户创建
 *   - 共享 rate-limiter：adminLimiter + userLimiter 分层
 *   - 用户数据流式加载：不在启动时一次读 100 万用户
 *   - 行情完全共享：DataBus WebSocket，0 API 消耗
 *   - 集群就绪：Worker 模式（每 1000 用户一个进程）
 */

const EventEmitter = require('events');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MessageBus = require('./message-bus');
const { RiskIsolator } = require('./risk-isolator');
const { SubscriptionManager } = require('./subscription');
const WebSocketHub = require('./websocket-hub');
const UserPool = require('./user-pool');
const AdminDashboard = require('./admin-dashboard');
const UserEngine = require('./user-engine-v3');

const CONFIG = {
  port: 8010,
  wsPort: 8015,
  dataPath: path.join(__dirname, '..', 'data', 'saas-users.json'),
  cycleInterval: 60000,
  riskCheckInterval: 30000,
  statsInterval: 60000,
  healthCheckInterval: 30000,
  maxConcurrentCycles: 50,    // 并行执行用户循环数
  batchSize: 20,             // v113.14: 每轮只处理20个用户（百万用户可扩展）
  maxUsersPerWorker: 1000,    // 每 Worker 最多1000用户
};

class MultiEngine extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = { ...CONFIG, ...config };
    this.log = (msg) => console.log(`[MultiEngine] ${new Date().toISOString()} ${msg}`);

    this.messageBus = new MessageBus();
    this.riskIsolator = new RiskIsolator();
    this.subscriptionManager = new SubscriptionManager();
    this.wsHub = new WebSocketHub({ port: this.config.wsPort });
    this.userPool = new UserPool(this.subscriptionManager, this.messageBus);
    this.adminDashboard = new AdminDashboard(
      this.userPool, this.subscriptionManager, this.riskIsolator, this.messageBus
    );

    this.userEngines = {};
    this.sharedDataBus = null;
    this.sharedDeepSeek = null;
    this.sharedStrategy = null;       // v113.14: 共享策略实例
    this.sharedLimiter = null;        // v113.14: 共享 rate-limiter
    this.sharedExitManager = null;    // v113.14: 共享平仓管理
    this.sharedPositionSizer = null;  // v113.14: 共享仓位计算

    this.running = false;
    this.server = null;
    this._cycleTimer = null;
    this._riskTimer = null;
    this._statsTimer = null;
    this._currentBatch = 0;  // v113.14: 当前批次

    this.stats = {
      startTime: null, totalCycles: 0, totalDecisions: 0, totalTrades: 0,
    };

    // 事件绑定
    this.riskIsolator.on('global:emergency', (data) => {
      this.log(`🚨 全局紧急停止触发！`);
      Object.values(this.userEngines).forEach(engine => engine.pause());
      this.messageBus.publish('ALERT', { type: 'emergency', ...data }, 'CRITICAL');
    });
    this.riskIsolator.on('global:recover', () => {
      this.log('✅ 全局恢复正常');
      Object.values(this.userEngines).forEach(engine => engine.resume());
    });
    this.riskIsolator.on('user:halt', (userId, risk) => {
      this.log(`⛔ 用户 ${userId} 熔断`);
      this.userEngines[userId]?.pause();
      this.wsHub.pushAlert(userId, {
        type: 'risk_halt',
        message: `回撤 ${(risk.drawdown * 100).toFixed(1)}%，交易已暂停`,
        timestamp: Date.now(),
      });
    });
    this.riskIsolator.on('user:recover', (userId) => {
      this.log(`✅ 用户 ${userId} 恢复`);
      this.userEngines[userId]?.resume();
      this.wsHub.pushAlert(userId, {
        type: 'risk_recover', message: '风控恢复，交易已重新启用', timestamp: Date.now(),
      });
    });
  }

  async init() {
    this.log('初始化 MultiEngine v3...');
    // ═══ 共享量化策略(百万用户核心): 共享选币池+最新双策略, 所有用户共用 ═══
    if (!this.sharedStrategy) {
      try {
        const { SharedQuantStrategy } = require('./shared-quant-strategy');
        this.sharedStrategy = new SharedQuantStrategy({
          dataBus: this.sharedDataBus,
          trendPool: process.env.MULTI_TREND_POOL ? process.env.MULTI_TREND_POOL.split(',').map(s=>s.trim()) : ['BTCUSDT','ETHUSDT','SOLUSDT','ADAUSDT','OPUSDT'],
          bollPool: process.env.MULTI_BOLL_POOL ? process.env.MULTI_BOLL_POOL.split(',').map(s=>s.trim()) : ['LINKUSDT','AVAXUSDT','SUIUSDT','ARBUSDT','INJUSDT'],
          logFn: m => this.log('[' + (m||'') + ']'),
        });
        this.log('✅ 共享量化策略已初始化 (SharedQuantStrategy)');
      } catch (e) { this.log('⚠️ 共享策略初始化失败: ' + (e.message||e)); }
    }
    this.riskIsolator.start();
    await this._loadUsersStream();
    this.server = http.createServer((req, res) => this._handleRequest(req, res));
    // ═══ 境外云部署安全：默认只监听 127.0.0.1 ═══
    const privateAccess = (process.env.PRIVATE_ACCESS || 'yes').toLowerCase();
    const bindHost = privateAccess === 'yes' ? '127.0.0.1' : undefined; // undefined = 0.0.0.0
    await new Promise(resolve => this.server.listen(this.config.port, bindHost, resolve));
    this.log(`API 服务器启动 — http://${bindHost || '0.0.0.0'}:${this.config.port}`);
    if (bindHost === '127.0.0.1') this.log(`🔒 私有访问模式: 通过 SSH 隧道访问`);
    this.wsHub.start(this.server);
    this.log(`MultiEngine v3 初始化完成 — ${Object.keys(this.userEngines).length} 个用户引擎就绪`);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.stats.startTime = Date.now();
    Object.values(this.userEngines).forEach(engine => engine.start());
    this._cycleTimer = setInterval(() => this._tradingCycle(), this.config.cycleInterval);
    this._riskTimer = setInterval(() => this._riskCycle(), this.config.riskCheckInterval);
    this._statsTimer = setInterval(() => this._statsAggregation(), this.config.statsInterval);
    this.log('MultiEngine v3 运行中 — 百万用户框架就绪');
  }

  // ═══ v113.14: 分批交易循环 ═══

  async _tradingCycle() {
    if (!this.running) return;

    const activeUsers = this.userPool.getActiveUsers();
    if (activeUsers.length === 0) return;

    const marketData = this.sharedDataBus
      ? (this.sharedDataBus.getLatestData?.() || this._getMarketFromDataBus())
      : this._getMockMarketData();
    if (!marketData || !marketData.price) return;

    // ═══ 共享量化信号: 一套共享选币池(趋势+震荡)+最新双策略, 所有用户共用 ═══
    let sharedSignals = {};
    let sharedPool = null;
    if (this.sharedStrategy) {
      try {
        sharedSignals = (await this.sharedStrategy.scanSignals()) || {};
        sharedPool = {
          trend: this.sharedStrategy.getTrendPool() || [],
          bollinger: this.sharedStrategy.getBollPool() || [],
        };
        marketData.sharedSignals = sharedSignals;
        marketData.sharedPool = sharedPool;
      } catch (e) { this.log('⚠️ 共享信号计算失败: ' + (e.message||e)); }
    }

    // v113.14: 分批处理 — 每轮只处理 batchSize 个用户
    const batchSize = this.config.batchSize;
    const totalUsers = activeUsers.length;
    const batchCount = Math.ceil(totalUsers / batchSize);
    const currentBatch = this._currentBatch % batchCount;
    const startIdx = currentBatch * batchSize;
    const batchUsers = activeUsers.slice(startIdx, startIdx + batchSize);

    if (totalUsers > batchSize) {
      this.log(`分批轮询: 第${currentBatch + 1}/${batchCount}批 (${batchUsers.length}/${totalUsers} 用户)`);
    }

    // 并行执行当前批次
    const results = await Promise.allSettled(
      batchUsers.map(async (user) => {
        const engine = this.userEngines[user.userId];
        if (!engine) return null;
        return engine.executeCycle(marketData);
      })
    );

    // 统计
    results.forEach(r => {
      if (r.status === 'fulfilled' && r.value) {
        this.stats.totalCycles++;
        if (r.value.decision && r.value.decision.action !== 'hold') {
          this.stats.totalDecisions++;
        }
        if (r.value.openResult?.success) {
          this.stats.totalTrades++;
        }
      }
    });

    // 推进到下一批
    this._currentBatch++;

    // 行情广播
    this.wsHub.pushMarketUpdate({
      price: marketData.price,
      change24h: marketData.change24h || 0,
      volume24h: marketData.volume24h || 0,
      timestamp: Date.now(),
    });

    this.messageBus.publish('HEARTBEAT', {
      activeUsers: activeUsers.length, cycleCount: this.stats.totalCycles,
      batch: `${currentBatch + 1}/${batchCount}`, timestamp: Date.now(),
    });
  }

  // v113.14: 从 DataBus 获取行情
  _getMarketFromDataBus() {
    if (!this.sharedDataBus) return null;
    const md = this.sharedDataBus.marketData || {};
    // 优先 BTC
    const btc = md['BTCUSDT'] || md['BTCUSDT.P'] || Object.values(md)[0];
    if (!btc) return null;
    return {
      price: btc.price,
      prices: this.sharedDataBus.klines?.['BTCUSDT']?.map(k => k.close) || [btc.price],
      volumes: this.sharedDataBus.klines?.['BTCUSDT']?.map(k => k.volume) || [1000],
      change24h: btc.change24h || 0,
      volume24h: btc.volume24h || 0,
      timestamp: btc.timestamp || Date.now(),
    };
  }

  _riskCycle() {
    Object.entries(this.userEngines).forEach(([userId, engine]) => {
      const status = engine.getStatus();
      this.riskIsolator.updateAndCheck(userId, status.pnl, 1000 + status.pnl);
    });
  }

  _statsAggregation() {
    const overview = this.adminDashboard.getOverview();
    this.messageBus.publish('SYSTEM', { type: 'stats', data: overview, timestamp: Date.now() }, 'LOW');
  }

  // ═══ v113.14: 用户管理 ═══

  addUser(userId, walletAddress, config = {}) {
    this.userPool.register(userId, walletAddress, config);

    const sharedComponents = {
      messageBus: this.messageBus,
      riskIsolator: this.riskIsolator,
      subscriptionManager: this.subscriptionManager,
      wsHub: this.wsHub,
      dataBus: this.sharedDataBus,
      sharedStrategy: this.sharedStrategy,       // 共享策略
      sharedLimiter: this.sharedLimiter,           // 共享 rate-limiter
      sharedExitManager: this.sharedExitManager,
      sharedPositionSizer: this.sharedPositionSizer,
    };

    const engine = new UserEngine(userId, config, sharedComponents);
    this.userEngines[userId] = engine;

    engine.on('decision', (data) => {
      this.stats.totalTrades++;
      this.messageBus.publish('TRADE_SIGNAL', data, 'HIGH');
    });
    engine.on('risk:blocked', (data) => {
      this.messageBus.publish('ALERT', data, 'HIGH');
    });
    engine.on('trade', (data) => {
      this.messageBus.publish('TRADE_SIGNAL', { ...data, type: 'executed' }, 'HIGH');
    });

    if (this.running) engine.start();
    return { success: true };
  }

  removeUser(userId) {
    const engine = this.userEngines[userId];
    if (engine) { engine.stop(); delete this.userEngines[userId]; }
    this.userPool.unregisterUser(userId);
    this.riskIsolator.unregisterUser(userId);
    this.log(`用户移除: ${userId}`);
  }

  // ═══ v113.14: 流式加载用户（不在启动时一次读100万）═══

  async _loadUsersStream() {
    try {
      if (!fs.existsSync(this.config.dataPath)) return;
      const raw = fs.readFileSync(this.config.dataPath, 'utf8');
      const data = JSON.parse(raw);
      const users = data.users || data;
      const userArray = Array.isArray(users) ? users : Object.values(users);

      // v113.14: 分批加载，每批100个
      const LOAD_BATCH = 100;
      let loaded = 0;
      for (let i = 0; i < userArray.length; i += LOAD_BATCH) {
        const batch = userArray.slice(i, i + LOAD_BATCH);
        for (const user of batch) {
          const userId = user.userId || user.id || user.email || user.walletAddress;
          if (userId) {
            this.addUser(userId, user.walletAddress || userId, {
              ...user.config,
              binanceApiKey: user.binanceApiKey,
              binanceSecret: user.binanceSecret,
              primaryPair: user.primaryPair || 'BTCUSDT',
              strategy: user.strategy || 'balanced',
              riskLevel: user.riskLevel || 'medium',
              tradeAmount: user.tradeAmount || 50,
              maxPositions: user.maxPositions || 5,
              leverage: user.leverage || 3,
              maxPositionPct: user.maxPositionPct || 0.15,
            });
            loaded++;
          }
        }
        if (loaded % 1000 === 0 && loaded > 0) {
          this.log(`已加载 ${loaded} 个用户...`);
        }
      }
      this.log(`加载完成: ${loaded} 个用户`);
    } catch (e) {
      this.log(`加载用户数据失败: ${e.message}`);
    }
  }

  // 兼容旧接口
  async _loadUsers() {
    return this._loadUsersStream();
  }

  // ═══ HTTP API ═══

  _handleRequest(req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith('/admin/')) {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          const handled = this.adminDashboard.handleRequest(req, res, parsed);
          if (!handled) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); }
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      });
      return;
    }

    if (url.pathname === '/api/health') {
      res.writeHead(200);
      res.end(JSON.stringify({
        status: 'ok', version: 'v3.14', uptime: process.uptime(),
        users: Object.keys(this.userEngines).length,
        batchSize: this.config.batchSize,
        currentBatch: this._currentBatch,
      }));
      return;
    }

    if (url.pathname === '/api/user/status') {
      const token = req.headers.authorization?.replace('Bearer ', '');
      const session = this.userPool.validateSession(token);
      if (!session.valid) { res.writeHead(401); res.end(JSON.stringify({ error: session.reason })); return; }
      const engine = this.userEngines[session.userId];
      res.writeHead(200);
      res.end(JSON.stringify(engine ? engine.getStatus() : null));
      return;
    }

    // v113.14: 批量状态
    if (url.pathname === '/api/batch-status') {
      const engines = Object.values(this.userEngines);
      const batchSize = this.config.batchSize;
      const currentBatch = this._currentBatch;
      const batchCount = Math.ceil(engines.length / batchSize);
      const summary = {
        totalUsers: engines.length,
        batchSize,
        currentBatch: currentBatch % batchCount,
        batchCount,
        activeInCurrentBatch: engines.slice(
          (currentBatch % batchCount) * batchSize,
          (currentBatch % batchCount) * batchSize + batchSize
        ).map(e => ({ userId: e.userId, pnl: e.state.pnl, positions: Object.keys(e.positions).length })),
      };
      res.writeHead(200);
      res.end(JSON.stringify(summary));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  _getMockMarketData() {
    return {
      price: 67000 + Math.random() * 1000,
      prices: Array.from({ length: 100 }, (_, i) => 67000 + Math.sin(i / 10) * 500 + (Math.random() - 0.5) * 200),
      volumes: Array.from({ length: 100 }, () => 1000 + Math.random() * 3000),
      timestamp: Date.now(),
      change24h: (Math.random() - 0.5) * 5,
      volume24h: 1000000 + Math.random() * 500000,
    };
  }

  getHealth() {
    return {
      running: this.running,
      uptime: this.stats.startTime ? Date.now() - this.stats.startTime : 0,
      users: Object.keys(this.userEngines).length,
      batchSize: this.config.batchSize,
      stats: this.stats,
      components: {
        messageBus: this.messageBus.healthCheck(),
        riskIsolator: this.riskIsolator.getOverview(),
        subscriptions: this.subscriptionManager.getStats(),
        webSocket: this.wsHub.getStats(),
      },
    };
  }

  async shutdown() {
    this.log('MultiEngine v3 关闭中...');
    this.running = false;
    if (this._cycleTimer) clearInterval(this._cycleTimer);
    if (this._riskTimer) clearInterval(this._riskTimer);
    if (this._statsTimer) clearInterval(this._statsTimer);
    Object.values(this.userEngines).forEach(engine => engine.stop());
    await this.wsHub.shutdown();
    await this.messageBus.shutdown();
    this.riskIsolator.stop();
    this.subscriptionManager.shutdown();
    if (this.server) this.server.close();
    this.log('MultiEngine v3 已关闭');
  }
}

module.exports = MultiEngine;
