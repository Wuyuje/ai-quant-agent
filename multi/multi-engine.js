/**
 * MultiEngine — 多用户引擎管理器 v2.0
 * 
 * 核心升级：
 * - 钱包签名登录（TP Wallet + ARK 持仓验证）
 * - 平台收入自动分配（20% → 0xb6DE...C28A）
 * - 共享 AI 进化（所有用户交易数据聚合训练）
 * 
 * 架构：
 *   MultiEngine (1个)
 *     ├── DataBus (1个，共享)
 *     ├── DeepSeekBrain (1个，共享，聚合进化)
 *     ├── SessionManager (钱包登录)
 *     ├── RevenueDistributor (收益分配)
 *     ├── UserEngine: user_001 (独立 Trader/Guardian/AI)
 *     ├── UserEngine: user_002
 *     └── ...
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const DataBus = require('../data/databus');
const DeepSeekBrain = require('../brain/deepseek-brain');
const UserEngine = require('./user-engine');
const RevenueDistributor = require('./revenue-distributor');
const { CONFIG: AUTH_CONFIG, generateLoginMessage, verifyLogin, SessionManager } = require('./auth');

const CONFIG = require('../config/loader');
const PAIRS = require('../config/trading-pairs');

const USER_DB_PATH = path.join(__dirname, '..', 'data', 'users.json');

// ═══════════════════════════════════════
// 平台配置（已上链确认）
// ═══════════════════════════════════════
const PLATFORM_CONFIG = {
  platformWallet: '0xb6DEb31484353AdDaA5b6A105A2B758Df11bC28A',  // 平台收入钱包
  arkTokenContract: '0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D', // ARK 合约
  arkMinBalance: 100,           // 最低 ARK 持仓门槛
  platformFeePct: 20,           // 平台服务费 20%
  userSharePct: 70,             // 用户收益 70%
  ecoFundPct: 10,               // 生态基金 10%（策略进化 + ARK 回购）
};

class MultiEngine {
  constructor() {
    this.users = {};           // userId → UserEngine
    this.userConfigs = {};     // userId → userConfig
    this.sharedDataBus = null;
    this.sharedDeepSeek = null;
    this.revenueDistributor = null;
    this.sessionManager = new SessionManager();
    this.apiServer = null;
    this.running = false;
    this.log = (msg) => console.log(`[MultiEngine] ${new Date().toISOString()} ${msg}`);
  }

  // ═══ 初始化 ═══
  async init() {
    this.log('🏗️ 初始化 MultiEngine v2.0 (SaaS Mode)...');

    // 1. 共享 DataBus
    this.sharedDataBus = new DataBus(CONFIG);
    const symbols = Object.keys(PAIRS);
    this.sharedDataBus.connectWS(symbols);
    this.log('📡 DataBus 已连接');
    
    await new Promise(r => setTimeout(r, 3000));
    
    for (const sym of symbols) {
      try {
        await this.sharedDataBus.fetchTicker(sym);
        await this.sharedDataBus.fetchKlines(sym, CONFIG.data.klineInterval, CONFIG.data.klineLimit);
        await new Promise(r => setTimeout(r, 200));
      } catch (e) { this.log(`⚠️ ${sym} 数据加载失败: ${e.message}`); }
    }
    this.log(`📊 历史数据加载完成: ${symbols.length} 个交易对`);

    // 2. 共享 DeepSeek
    this.sharedDeepSeek = new DeepSeekBrain({
      apiKey: CONFIG.deepseek?.apiKey || process.env.DEEPSEEK_API_KEY,
      model: CONFIG.deepseek?.model || 'deepseek-chat',
    });
    this.log('🧠 DeepSeek 共享大脑已初始化');

    // 3. 收益分配器
    this.revenueDistributor = new RevenueDistributor({
      platformWallet: PLATFORM_CONFIG.platformWallet,
      platformFeePct: PLATFORM_CONFIG.platformFeePct,
      userSharePct: PLATFORM_CONFIG.userSharePct,
      ecoFundPct: PLATFORM_CONFIG.ecoFundPct,
    });
    this.log(`💰 收益分配器: 平台 ${PLATFORM_CONFIG.platformFeePct}% | 用户 ${PLATFORM_CONFIG.userSharePct}% | 生态 ${PLATFORM_CONFIG.ecoFundPct}%`);

    // 4. 加载已有用户
    this._loadUsers();

    // 5. 启动 API Server
    this._startAPIServer();

    // 6. 启动全局统计循环
    this._startStatsLoop();

    this.running = true;
    this.log('✅ MultiEngine v2.0 初始化完成');
  }

  // ═══ 用户管理 ═══
  _loadUsers() {
    try {
      if (fs.existsSync(USER_DB_PATH)) {
        const data = JSON.parse(fs.readFileSync(USER_DB_PATH, 'utf8'));
        this.userConfigs = data.users || {};
        this.log(`📂 加载 ${Object.keys(this.userConfigs).length} 个用户配置`);
      }
    } catch (e) {
      this.log(`⚠️ 加载用户配置失败: ${e.message}`);
    }
  }

  _saveUsers() {
    try {
      fs.writeFileSync(USER_DB_PATH, JSON.stringify({ users: this.userConfigs }, null, 2));
    } catch (e) { this.log(`⚠️ _saveUsers FAILED: ${e.message}`); }
  }

  /**
   * 钱包登录注册（无需 API Key，纯链上验证）
   */
  registerOrLogin(walletAddress, verification) {
    const addr = walletAddress.toLowerCase();
    
    // 检查是否已有用户
    let userConfig = this.userConfigs[addr];
    
    if (!userConfig) {
      // 新用户注册
      userConfig = {
        userId: addr,
        walletAddress: addr,
        arkBalance: verification.arkBalance,
        bnbBalance: verification.bnbBalance,
        strategy: 'balanced',  // 默认平衡策略
        subscription: 'standard', // 标准订阅
        createdAt: Date.now(),
        lastActive: Date.now(),
        totalPnl: 0,
        totalTrades: 0,
        status: 'active',
      };
      
      this.userConfigs[addr] = userConfig;
      this._saveUsers();
      this.log(`👤 新用户注册: ${addr} | ARK: ${verification.arkBalance.toFixed(2)}`);
    } else {
      // 老用户更新
      userConfig.arkBalance = verification.arkBalance;
      userConfig.bnbBalance = verification.bnbBalance;
      userConfig.lastActive = Date.now();
      this._saveUsers();
      this.log(`🔄 用户登录: ${addr} | ARK: ${verification.arkBalance.toFixed(2)}`);
    }

    // 创建 session
    const token = this.sessionManager.create(addr, {
      userId: addr,
      arkBalance: verification.arkBalance,
      strategy: userConfig.strategy,
    });

    return {
      success: true,
      token,
      user: {
        ...userConfig,
        arkMinRequired: PLATFORM_CONFIG.arkMinBalance,
      },
    };
  }

  /**
   * 验证 session
   */
  authenticate(token) {
    if (!token) return null;
    return this.sessionManager.validate(token);
  }

  /**
   * 启动用户引擎
   */
  async startUser(userId) {
    const config = this.userConfigs[userId];
    if (!config) return { success: false, reason: '用户不存在' };

    if (this.users[userId]) {
      return { success: false, reason: '用户引擎已在运行' };
    }

    // 创建虚拟 Binance 配置（用平台统一执行，或用户自己的 API Key）
    // Phase 1: 平台统一执行（用户不需要自己的 Binance API）
    const userBinanceConfig = {
      binance: {
        apiKey: config.binanceApiKey || process.env.PLATFORM_BINANCE_API_KEY || '',
        apiSecret: config.binanceApiSecret || process.env.PLATFORM_BINANCE_API_SECRET || '',
        futuresBase: CONFIG.binance.futuresBase,
        wsBase: CONFIG.binance.wsBase,
      },
      trading: {
        ...CONFIG.trading,
        maxPositions: config.maxPositions || CONFIG.trading.maxPositions || 6,
      },
    };

    try {
      const userEngine = new UserEngine(
        userId, { ...config, ...userBinanceConfig }, 
        this.sharedDataBus, this.sharedDeepSeek, CONFIG
      );
      this.users[userId] = userEngine;
      await userEngine.start();
      config.lastActive = Date.now();
      this._saveUsers();
      this.log(`✅ 用户 ${userId} 引擎已启动`);
      return { success: true };
    } catch (e) {
      delete this.users[userId];
      return { success: false, reason: e.message };
    }
  }

  async stopUser(userId) {
    const engine = this.users[userId];
    if (!engine) return { success: false, reason: '用户引擎未运行' };
    await engine.stop();
    delete this.users[userId];
    this.log(`⏹️ 用户 ${userId} 引擎已停止`);
    return { success: true };
  }

  async removeUser(userId) {
    await this.stopUser(userId);
    delete this.userConfigs[userId];
    this._saveUsers();
    return { success: true };
  }

  async startAllUsers() {
    let started = 0;
    for (const userId of Object.keys(this.userConfigs)) {
      if (!this.users[userId]) {
        const result = await this.startUser(userId);
        if (result.success) started++;
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    this.log(`🚀 启动了 ${started} 个用户引擎`);
    return started;
  }

  async stopAllUsers() {
    for (const [userId, engine] of Object.entries(this.users)) {
      await engine.stop();
    }
    this.users = {};
  }

  // ═══ 收益分配 ═══
  _distributeRevenue(userId, pnl) {
    if (pnl <= 0) return null;
    const distribution = this.revenueDistributor.calculate(pnl);
    this.revenueDistributor.record(userId, pnl, distribution);
    this.log(`💰 ${userId.slice(0, 10)}... 平仓收益 $${pnl.toFixed(2)} → 用户 $${distribution.userShare.toFixed(2)} | 平台 $${distribution.platformFee.toFixed(2)}`);
    return distribution;
  }

  // ═══ 聚合进化 ═══
  async _aggregateEvolution() {
    const allTrades = [];
    for (const [userId, engine] of Object.entries(this.users)) {
      if (engine.tradeLog && engine.tradeLog.length > 0) {
        allTrades.push(...engine.tradeLog.slice(-20));
      }
    }
    if (allTrades.length < 5) return;
    for (const trade of allTrades) {
      this.sharedDeepSeek.recordTrade(trade);
    }
    this.log(`🧬 聚合进化: ${allTrades.length} 笔交易 → 共享大脑`);
    try { await this.sharedDeepSeek.selfReflect(); } catch (e) { this.log(`⚠️ 聚合自我反思失败: ${e.message}`); }
  }

  // ═══ API Server ═══
  _startAPIServer() {
    const PORT = process.env.MULTI_PORT || 8010;
    const PUBLIC_DIR = path.join(__dirname, 'public');
    
    this.apiServer = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

      const url = new URL(req.url, `http://localhost:${PORT}`);
      const pathParts = url.pathname.split('/').filter(Boolean);
      let body = '';

      // 静态文件
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        try {
          const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html); return;
        } catch (e) { res.writeHead(500); res.end('Dashboard not found'); return; }
      }

      // 静态资源
      if (req.method === 'GET') {
        const ext = path.extname(url.pathname);
        if (ext && PUBLIC_DIR) {
          try {
            const filePath = path.join(PUBLIC_DIR, url.pathname);
            if (fs.existsSync(filePath)) {
              const ct = { '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' }[ext] || 'text/plain';
              res.writeHead(200, { 'Content-Type': ct });
              res.end(fs.readFileSync(filePath)); return;
            }
          } catch (e) { /* static file not found, continue */ }
        }
      }

      if (req.method === 'POST' || req.method === 'PUT') {
        body = await new Promise(resolve => {
          let data = '';
          req.on('data', chunk => data += chunk);
          req.on('end', () => resolve(data));
        });
      }

      // 提取 Authorization header
      const authHeader = req.headers.authorization || '';
      const token = authHeader.replace('Bearer ', '');

      try {
        const result = await this._handleAPI(req.method, pathParts, body, url.searchParams, token);
        res.writeHead(result.status || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.data));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });

    // ═══ 境外云部署安全：默认只监听 127.0.0.1 ═══
    const privateAccess = (process.env.PRIVATE_ACCESS || 'yes').toLowerCase();
    const bindHost = privateAccess === 'yes' ? '127.0.0.1' : undefined;
    this.apiServer.listen(PORT, bindHost, () => {
      this.log(`🌐 API Server: http://${bindHost || '0.0.0.0'}:${PORT}`);
      if (bindHost === '127.0.0.1') this.log(`🔒 私有访问模式: 通过 SSH 隧道访问`);
    });
  }

  async _handleAPI(method, pathParts, body, query, token) {
    const route = `${method} /${pathParts.join('/')}`;

    // ═══ 钱包认证 API ═══

    // GET /auth/nonce?address=0x... → 生成签名消息
    if (route === 'GET /auth/nonce') {
      const address = query.get('address');
      if (!address || !address.startsWith('0x')) {
        return { status: 400, data: { error: '需要有效的钱包地址' } };
      }
      const { message, nonce, timestamp } = generateLoginMessage(address);
      return { data: { message, nonce, timestamp, prefix: AUTH_CONFIG.messagePrefix } };
    }

    // POST /auth/verify → 验证签名 + ARK 持仓
    if (route === 'POST /auth/verify') {
      const { address, message, signature } = JSON.parse(body);
      if (!address || !message || !signature) {
        return { status: 400, data: { error: '需要 address, message, signature' } };
      }
      
      const verification = await verifyLogin(address, message, signature);
      if (!verification.valid) {
        return { status: 403, data: { error: verification.error, arkBalance: verification.arkBalance || 0 } };
      }
      
      const result = this.registerOrLogin(address, verification);
      return { status: 200, data: result };
    }

    // POST /auth/logout
    if (route === 'POST /auth/logout') {
      this.sessionManager.destroy(token);
      return { data: { success: true } };
    }

    // ═══ 需要认证的 API ═══
    const session = this.authenticate(token);
    
    // GET /dashboard/data → 仪表盘数据（认证后）
    if (route === 'GET /dashboard/data') {
      if (!session) return { status: 401, data: { error: '未登录' } };
      
      const engine = this.users[session.userId];
      const userConfig = this.userConfigs[session.userId];
      
      return {
        data: {
          user: {
            address: session.userId,
            strategy: userConfig?.strategy || 'balanced',
            arkBalance: session.arkBalance,
            status: userConfig?.status || 'active',
            createdAt: userConfig?.createdAt,
          },
          engine: engine ? engine.getStatus() : { running: false },
          platform: {
            wallet: PLATFORM_CONFIG.platformWallet,
            arkMinRequired: PLATFORM_CONFIG.arkMinBalance,
            totalUsers: Object.keys(this.userConfigs).length,
            activeUsers: Object.keys(this.users).length,
          },
        }
      };
    }

    // POST /engine/start → 启动自己的引擎
    if (route === 'POST /engine/start') {
      if (!session) return { status: 401, data: { error: '未登录' } };
      const result = await this.startUser(session.userId);
      return { data: result };
    }

    // POST /engine/stop → 停止自己的引擎
    if (route === 'POST /engine/stop') {
      if (!session) return { status: 401, data: { error: '未登录' } };
      const result = await this.stopUser(session.userId);
      return { data: result };
    }

    // POST /engine/strategy → 修改策略
    if (route === 'POST /engine/strategy') {
      if (!session) return { status: 401, data: { error: '未登录' } };
      const { strategy } = JSON.parse(body);
      if (!['conservative', 'balanced', 'aggressive'].includes(strategy)) {
        return { status: 400, data: { error: '策略必须是 conservative/balanced/aggressive' } };
      }
      this.userConfigs[session.userId].strategy = strategy;
      this._saveUsers();
      return { data: { success: true, strategy } };
    }

    // GET /revenue/my → 我的收益
    if (route === 'GET /revenue/my') {
      if (!session) return { status: 401, data: { error: '未登录' } };
      const revenue = this.revenueDistributor.getUserRevenue(session.userId);
      return { data: revenue };
    }

    // ═══ 管理员 API（需要平台钱包签名） ═══
    // v14: 管理员 API 需要有效的 session + 平台管理员权限
    const isAdmin = session && session.userId && PLATFORM_CONFIG.platformWallet &&
      session.userId.toLowerCase() === PLATFORM_CONFIG.platformWallet.toLowerCase();

    // GET /admin/status → 全局状态
    if (route === 'GET /admin/status') {
      if (!isAdmin) return { status: 403, data: { error: '需要管理员权限' } };
      const userStatuses = {};
      for (const [uid, engine] of Object.entries(this.users)) {
        userStatuses[uid] = engine.getStatus();
      }
      return {
        data: {
          running: this.running,
          totalUsers: Object.keys(this.userConfigs).length,
          activeUsers: Object.keys(this.users).length,
          users: userStatuses,
          platform: PLATFORM_CONFIG,
          revenueStats: this.revenueDistributor?.getStats() || {},
        }
      };
    }

    // POST /admin/start-all → 启动所有用户
    if (route === 'POST /admin/start-all') {
      if (!isAdmin) return { status: 403, data: { error: '需要管理员权限' } };
      const count = await this.startAllUsers();
      return { data: { started: count } };
    }

    // POST /admin/stop-all → 停止所有用户
    if (route === 'POST /admin/stop-all') {
      if (!isAdmin) return { status: 403, data: { error: '需要管理员权限' } };
      await this.stopAllUsers();
      return { data: { stopped: true } };
    }

    // ═══ 通用 API ═══
    if (route === 'GET /health') {
      return { data: { status: 'ok', version: '2.0', users: Object.keys(this.users).length, uptime: process.uptime() } };
    }

    if (route === 'GET /config') {
      return { data: PLATFORM_CONFIG };
    }

    return { status: 404, data: { error: 'Not found' } };
  }

  // ═══ 统计循环 ═══
  _startStatsLoop() {
    setInterval(async () => {
      try { await this._aggregateEvolution(); } catch (e) { this.log(`⚠️ 定期聚合进化失败: ${e.message}`); }
    }, 5 * 60000);

    setInterval(() => {
      for (const [uid, engine] of Object.entries(this.users)) {
        try { engine.trader.setMarketData(this.sharedDataBus.marketData); } catch (e) { /* user engine may be stopped */ }
      }
    }, 30000);

    this.log('📊 统计循环已启动');
  }

  async shutdown() {
    await this.stopAllUsers();
    this.sharedDataBus?.disconnect();
    if (this.apiServer) this.apiServer.close();
    this.running = false;
    this.log('🔴 MultiEngine 已关闭');
  }
}

module.exports = MultiEngine;
