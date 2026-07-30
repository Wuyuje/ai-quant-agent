/**
 * 双策略管理器 v2 — BB策略 + 趋势策略 共同运行
 * 
 * 百万用户框架:
 * - 每轮重新读取用户DB，自动注册新用户
 * - 清理已禁用用户(保留有持仓的监控)
 * - 看门狗: 停止的引擎自动重启
 * - 算力费检查: 余额不足暂停开新仓
 * - 管理员全免算力费
 * - BB 3仓 + 趋势 3仓 = 6仓, 各自独立管理
 */

const { BBStrategy, CONFIG: BB_CONFIG } = require('./bb-strategy');
const { TrendStrategy, CONFIG: TREND_CONFIG } = require('./trend-strategy');
const { decrypt } = require('../core/crypto-utils');
const fs = require('fs');
const path = require('path');

class DualStrategyManager {
  constructor(opts = {}) {
    this.adminApiKey = opts.apiKey || process.env.BINANCE_API_KEY || '';
    this.adminApiSecret = opts.apiSecret || process.env.BINANCE_API_SECRET || '';
    this.userDB = opts.userDB || null;
    this.running = false;
    this._cycleCount = 0;
    this._timer = null;
    this.intervalMs = opts.intervalMs || 30000;
    
    // BB策略实例池 { wallet → BBStrategy }
    this._bbEngines = {};
    // 趋势策略实例池 { wallet → TrendStrategy }
    this._trendEngines = {};
    
    // 算力费配置
    this.PLATFORM_FEE_RATE = 0.20;
    this.ECO_FUND_RATE = 0.10;
    this.USER_SHARE_RATE = 0.70;
    
    this.ADMIN_WALLETS = [
      '0xfa3b90c574469909d20848273c06752a22fde74a',
      '0xe6ddf0771c7610dba77eb5a07ba7771dd7f5e91e',
      '0x41c89c7df1ad4c8dd251c5afe45aa1c791fb6ea5', // 白名单用户,免算力费
    ];
    
    this._log('双策略管理器v2初始化');
  }

  _log(msg) {
    const ts = new Date().toISOString();
    console.log(`[DualStrategy] ${ts} ${msg}`);
  }

  _isAdmin(wallet) {
    if (!wallet) return false;
    const w = wallet.toLowerCase();
    // v3: 只有前2个是真正管理员(有管理员API Key), 第3个是白名单用户(免算力费但不创建引擎)
    return w === this.ADMIN_WALLETS[0].toLowerCase() || w === this.ADMIN_WALLETS[1].toLowerCase();
  }
  
  // v3: 判断是否白名单(免算力费) — 包含管理员和所有ADMIN_WALLETS
  _isWhitelisted(wallet) {
    if (!wallet) return false;
    const w = wallet.toLowerCase();
    return this.ADMIN_WALLETS.some(a => a.toLowerCase() === w);
  }

  // ═══ 启动 ═══
  start() {
    if (this.running) return;
    this.running = true;
    this._log('🚀 双策略管理器启动');
    this._loop();
  }

  async _loop() {
    if (!this.running) return;
    try {
      await this._cycle();
    } catch(e) {
      this._log(`❌ 循环异常: ${e.message}`);
    }
    this._timer = setTimeout(() => this._loop(), this.intervalMs);
  }

  // ═══ 每轮: 注册用户 + 清理 + 看门狗 ═══
  async _cycle() {
    this._cycleCount++;
    
    // 每轮重新读取用户文件
    let users = {};
    try {
      const usersFile = path.join(__dirname, '..', 'data', 'saas-users.json');
      if (fs.existsSync(usersFile)) {
        const fresh = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
        users = fresh.users || fresh;
        if (this.userDB) this.userDB.users = users;
      }
    } catch(e) {}

    // 收集所有需要跑策略的用户
    const activeUsers = [];
    
    for (const [wallet, u] of Object.entries(users)) {
      if (!u.tradingEnabled) continue;
      if (u.exchangeMode === 'dex') continue;
      if (!u.binanceApiKey || !u.binanceSecret) continue;
      
      // 算力费检查
      const isAdmin = this._isAdmin(wallet);
      const isWhitelisted = this._isWhitelisted(wallet);
      if (!isAdmin && !isWhitelisted) {
        if (u.gatesFeeLow) {
          if (this._cycleCount % 10 === 0) {
            this._log(`⏸️ ${wallet.slice(0,10)}... 算力费不足($${(u.gatesFeeBalance||0).toFixed(2)})，暂停开新仓`);
          }
        }
      }
      
      activeUsers.push({ wallet, apiKey: decrypt(u.binanceApiKey), apiSecret: decrypt(u.binanceSecret), isAdmin, gatesFeeLow: !!u.gatesFeeLow });
    }
    
    // 管理员始终加入
    if (this.adminApiKey && this.adminApiSecret) {
      const adminWallet = this.ADMIN_WALLETS[0];
      if (!activeUsers.find(u => u.wallet.toLowerCase() === adminWallet.toLowerCase())) {
        activeUsers.push({ wallet: adminWallet, apiKey: this.adminApiKey, apiSecret: this.adminApiSecret, isAdmin: true, gatesFeeLow: false });
      }
    }
    
    if (activeUsers.length === 0) {
      if (this._cycleCount % 20 === 0) this._log(`第${this._cycleCount}轮: 无用户`);
      return;
    }
    
    if (this._cycleCount % 10 === 0) {
      this._log(`第${this._cycleCount}轮: ${activeUsers.length}个用户`);
    }
    
    // 注册新用户
    for (const u of activeUsers) {
      await this._ensureEngine(u.wallet, u.apiKey, u.apiSecret, u.gatesFeeLow);
    }
    
    // 清理已禁用的用户(保留有持仓的监控)
    const activeWallets = new Set(activeUsers.map(u => u.wallet.toLowerCase()));
    for (const wallet of Object.keys(this._bbEngines)) {
      if (!activeWallets.has(wallet.toLowerCase())) {
        const bbPos = Object.keys(this._bbEngines[wallet]?.positions || {}).length;
        const trendPos = Object.keys(this._trendEngines[wallet]?.positions || {}).length;
        if (bbPos > 0 || trendPos > 0) {
          // 有持仓,保留监控但暂停开新仓
          if (this._bbEngines[wallet]) this._bbEngines[wallet].gatesFeePaused = true;
          if (this._trendEngines[wallet]) this._trendEngines[wallet].gatesFeePaused = true;
        } else {
          // 无持仓,清理
          this._bbEngines[wallet] && (this._bbEngines[wallet].running = false);
          this._trendEngines[wallet] && (this._trendEngines[wallet].running = false);
          delete this._bbEngines[wallet];
          delete this._trendEngines[wallet];
          if (this._cycleCount % 10 === 0) this._log(`🛑 清理 ${wallet.slice(0,10)}... (无持仓)`);
        }
      }
    }
    
    // 看门狗: 停止的引擎自动重启
    this._watchdog(activeUsers);
  }

  // ═══ 确保用户有BB+趋势引擎 ═══
  async _ensureEngine(wallet, apiKey, apiSecret, gatesFeeLow) {
    // v3: 所有有效用户都能创建引擎(各自API Key独立,不互相影响)
    if (!apiKey || apiKey.length < 20) return;
    if (apiKey.length !== 64 || !apiKey.match(/^[a-zA-Z0-9]+$/)) return;
    // BB引擎
    if (!this._bbEngines[wallet]) {
      const bb = new BBStrategy(apiKey, apiSecret, wallet);
      bb.gatesFeePaused = gatesFeeLow;
      bb._userDB = this.userDB;
      this._bbEngines[wallet] = bb;
      bb.start().catch(e => this._log(`❌ ${wallet.slice(0,10)} BB启动失败: ${e.message}`));
      if (this._cycleCount <= 5) this._log(`✅ ${wallet.slice(0,10)}... BB引擎启动`);
    } else {
      this._bbEngines[wallet].gatesFeePaused = gatesFeeLow;
    }
    
    // 趋势引擎(延迟5秒启动避免API冲突)
    if (!this._trendEngines[wallet]) {
      const trend = new TrendStrategy(apiKey, apiSecret, wallet);
      trend.gatesFeePaused = gatesFeeLow;
      trend._userDB = this.userDB;
      this._trendEngines[wallet] = trend;
      setTimeout(() => {
        trend.start().catch(e => this._log(`❌ ${wallet.slice(0,10)} 趋势启动失败: ${e.message}`));
      }, 30000); // v3: 延迟30秒错峰(和BB错开)
      if (this._cycleCount <= 5) this._log(`✅ ${wallet.slice(0,10)}... 趋势引擎启动`);
    } else {
      this._trendEngines[wallet].gatesFeePaused = gatesFeeLow;
    }
    
    // 互相注入仓位(避免接管对方仓位)
    this._bbEngines[wallet]?.setTrendPositions?.(this._trendEngines[wallet]?.positions || {});
    this._trendEngines[wallet]?.setBBPositions?.(this._bbEngines[wallet]?.positions || {});
  }

  // ═══ 看门狗 ═══
  _watchdog(activeUsers) {
    for (const u of activeUsers) {
      const bb = this._bbEngines[u.wallet];
      const trend = this._trendEngines[u.wallet];
      
      if (bb && !bb.running) {
        this._log(`🐕 ${u.wallet.slice(0,10)} BB引擎已停,重启`);
        bb.start().catch(e => this._log(`❌ 重启失败: ${e.message}`));
      }
      if (trend && !trend.running) {
        this._log(`🐕 ${u.wallet.slice(0,10)} 趋势引擎已停,重启`);
        trend.start().catch(e => this._log(`❌ 重启失败: ${e.message}`));
      }
    }
  }

  // ═══ 管理员状态 ═══
  getAdminStatus() {
    for (const w of this.ADMIN_WALLETS) {
      const bb = this._bbEngines[w];
      const trend = this._trendEngines[w];
      if (bb || trend) {
        const bbSummary = bb ? bb.getSummary() : { positions: [], positionCount: 0, balance: 0 };
        const trendSummary = trend ? trend.getSummary() : { positions: [], positionCount: 0, balance: 0 };
        // 合并BB+趋势仓位为旧格式(兼容仪表盘)
        const allPositions = [...(bbSummary.positions || []), ...(trendSummary.positions || [])];
        return {
          wallet: w,
          // 新格式
          bb: bbSummary,
          trend: trendSummary,
          // 旧格式兼容(仪表盘前端读这些字段)
          balance: bbSummary.balance || 0,
          positionCount: allPositions.length,
          maxPositions: (bbSummary.maxPositions || 3) + (trendSummary.maxPositions || 3),
          positions: allPositions,
          totalPnlUsd: (bbSummary.totalPnlUsd || 0) + (trendSummary.totalPnlUsd || 0),
          running: true,
          totalPositions: allPositions.length,
        };
      }
    }
    return null;
  }

  // ═══ 所有用户状态 ═══
  getAllUsersStatus() {
    const result = [];
    // v3: 同时返回有引擎的用户 + 用户DB里所有未删除的用户
    const seen = new Set();
    
    // 1. 有引擎的用户
    for (const wallet of Object.keys(this._bbEngines)) {
      // 只跳过真正的管理员(前2个),白名单用户(第3个)不跳过
      const isAdminAcct = wallet.toLowerCase() === this.ADMIN_WALLETS[0].toLowerCase() || wallet.toLowerCase() === this.ADMIN_WALLETS[1].toLowerCase();
      if (isAdminAcct) continue;
      seen.add(wallet.toLowerCase());
      const bbS = this._bbEngines[wallet]?.getSummary() || { positions: [], positionCount: 0, balance: 0 };
      const trendS = this._trendEngines[wallet]?.getSummary() || { positions: [], positionCount: 0, balance: 0 };
      const allPos = [...(bbS.positions || []), ...(trendS.positions || [])];
      // 从用户DB读算力费状态
      let feeBalance = 0, feeLow = false, isWhitelisted = false;
      try {
        const u = this.userDB?.get(wallet);
        if (u) { feeBalance = u.gatesFeeBalance||0; feeLow = u.gatesFeeLow; }
        isWhitelisted = this._isWhitelisted(wallet);
      } catch(e) {}
      result.push({
        wallet,
        bb: bbS, trend: trendS,
        balance: bbS.balance || 0,
        positionCount: allPos.length,
        maxPositions: (bbS.maxPositions || 3) + (trendS.maxPositions || 3),
        positions: allPos,
        totalPnlUsd: (bbS.totalPnlUsd || 0) + (trendS.totalPnlUsd || 0),
        running: bbS.running || trendS.running,
        gatesFeePaused: isWhitelisted ? false : (this._bbEngines[wallet]?.gatesFeePaused || false),
        gatesFeeBalance: feeBalance,
        isWhitelisted,
      });
    }
    
    // 2. 用户DB里有但没有引擎的用户(如API Key未绑定的白名单用户)
    try {
      // 直接从文件读取最新的用户列表
      const usersFile = path.join(__dirname, '..', 'data', 'saas-users.json');
      const fileUsers = fs.existsSync(usersFile) ? (JSON.parse(fs.readFileSync(usersFile, 'utf8')).users || JSON.parse(fs.readFileSync(usersFile, 'utf8'))) : {};
      for (const [wallet, u] of Object.entries(fileUsers)) {
        // 白名单用户不是管理员,不应该跳过
        // 只跳过真正的管理员(ADMIN_WALLETS[0]和[1])
        const isAdminAccount = wallet.toLowerCase() === this.ADMIN_WALLETS[0].toLowerCase() || wallet.toLowerCase() === this.ADMIN_WALLETS[1].toLowerCase();
        if (isAdminAccount) continue;
        if (seen.has(wallet.toLowerCase())) continue;
        if (u.deleted) continue;
        const isWhitelisted = this._isWhitelisted(wallet);
        result.push({
          wallet,
          bb: null, trend: null,
          balance: 0,
          positionCount: 0,
          maxPositions: 6,
          positions: [],
          totalPnlUsd: 0,
          running: false,
          gatesFeePaused: isWhitelisted ? false : (u.gatesFeeLow || false),
          gatesFeeBalance: u.gatesFeeBalance || 0,
          isWhitelisted,
        });
      }
    } catch(e) {}
    
    return result;
  }

  // ═══ 单用户状态 ═══
  getUserStatus(wallet) {
    const bb = this._bbEngines[wallet];
    const trend = this._trendEngines[wallet];
    if (!bb && !trend) return null;
    const bbS = bb?.getSummary() || { positions: [], positionCount: 0, balance: 0 };
    const trendS = trend?.getSummary() || { positions: [], positionCount: 0, balance: 0 };
    const allPos = [...(bbS.positions || []), ...(trendS.positions || [])];
    return {
      wallet, bb: bbS, trend: trendS,
      // 旧格式兼容
      balance: bbS.balance || 0,
      positionCount: allPos.length,
      maxPositions: (bbS.maxPositions || 3) + (trendS.maxPositions || 3),
      positions: allPos,
      totalPnlUsd: (bbS.totalPnlUsd || 0) + (trendS.totalPnlUsd || 0),
      running: bbS.running || trendS.running,
      gatesFeePaused: bb?.gatesFeePaused || false,
    };
  }

  // ═══ 获取当前策略(兼容仪表盘) ═══
  getActiveStrategy() {
    return 'bb'; // 始终返回bb(B策略)
  }

  // ═══ 统计 ═══
  getStats() {
    let bbPositions = 0, trendPositions = 0;
    let bbPnl = 0, trendPnl = 0;
    let totalWins = 0, totalLosses = 0, totalTrades = 0;
    let realizedPnl = 0;
    
    // v3: 从交易历史文件读取统计(不依赖内存,重启不丢)
    try {
      const dataDir = path.join(__dirname, '..', 'data');
      for (const wallet of Object.keys(this._bbEngines)) {
        const tradeFile = path.join(dataDir, `bb-trades-${wallet.toLowerCase()}.json`);
        if (fs.existsSync(tradeFile)) {
          const trades = JSON.parse(fs.readFileSync(tradeFile, 'utf8'));
          totalTrades += trades.length;
          totalWins += trades.filter(t => t.pnlUsd > 0).length;
          totalLosses += trades.filter(t => t.pnlUsd <= 0).length;
          realizedPnl += trades.reduce((s, t) => s + (t.pnlUsd || 0), 0);
        }
      }
    } catch(e) {}
    
    for (const bb of Object.values(this._bbEngines)) {
      const s = bb.getSummary();
      bbPositions += s.positionCount;
      bbPnl += s.totalPnlUsd;
    }
    for (const trend of Object.values(this._trendEngines)) {
      const s = trend.getSummary();
      trendPositions += s.positionCount;
      trendPnl += s.totalPnlUsd;
    }
    
    const floatPnl = bbPnl + trendPnl;
    return {
      running: this.running,
      cycleCount: this._cycleCount,
      bbUsers: Object.keys(this._bbEngines).length,
      trendUsers: Object.keys(this._trendEngines).length,
      bbPositions, trendPositions,
      totalPositions: bbPositions + trendPositions,
      bbPnl: +bbPnl.toFixed(2),
      trendPnl: +trendPnl.toFixed(2),
      totalPnl: +floatPnl.toFixed(2), // 浮动盈亏
      floatPnl: +floatPnl.toFixed(2),
      realizedPnl: +realizedPnl.toFixed(2), // 已实现盈亏
      totalAllPnl: +(floatPnl + realizedPnl).toFixed(2), // 浮动+已实现
      trades: totalTrades,
      wins: totalWins,
      losses: totalLosses,
    };
  }
}

module.exports = { DualStrategyManager };
