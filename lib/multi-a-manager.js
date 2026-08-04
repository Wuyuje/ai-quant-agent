/**
 * MultiAStrategyManager — 多用户 A策略(AI选币+真实下单) 管理器
 *
 * 架构(参考 DualStrategyManager):
 *   - 每个有效用户一个独立 AStrategySim 实例
 *   - 各自 API key、独立持仓、独立 state/交易文件 → 互不干扰
 *   - 共享行情缓存(所有用户选币共用一份 ticker, 减API压力)
 *   - 每用户独立账容守卫(防单用户超载)
 *   - 普通用户盈利自动扣算力费到管理员钱包(AStrategySim._collectServiceFee)
 *   - 管理员/白名单用户豁免算力费
 *
 * 启动: 被 saas/start.js 创建并 start()
 */

const fs = require('fs');
const path = require('path');
const { AStrategySim } = require('./a-strategy-sim');
const { SharedMarket } = require('./shared-market');
const { AccountCapacityGuard } = require('./account-capacity-guard');
const { decrypt } = require('../core/crypto-utils');

class MultiAStrategyManager {
  constructor(opts = {}) {
    this.adminApiKey = opts.apiKey || process.env.BINANCE_API_KEY || '';
    this.adminApiSecret = opts.apiSecret || process.env.BINANCE_API_SECRET || '';
    this.userDB = opts.userDB || null;
    this.running = false;
    this._cycleCount = 0;
    this._timer = null;
    this.intervalMs = opts.intervalMs || 30000;

    // v16: 只平不开模式 — 停止A策略开新仓,保留现有持仓止盈止损平仓
    this.pauseOpen = true;

    // A策略引擎池 { wallet → AStrategySim }
    this._aEngines = {};

    // 共享行情缓存(所有用户共用)
    this.sharedMarket = new SharedMarket();

    // 管理员钱包(免算力费)
    this.ADMIN_WALLETS = [
      '0xfa3b90c574469909d20848273c06752a22fde74a',
      '0xe6ddf0771c7610dba77eb5a07ba7771dd7f5e91e',
      '0x41c89c7df1ad4c8dd251c5afe45aa1c791fb6ea5',
      '0xc6dbb4cd3b6a12068c7388248da2bd32df7ef9b7',
    ];

    this._log('多用户A策略管理器初始化');
  }

  _log(msg) {
    const ts = new Date().toISOString();
    console.log(`[MultiA] ${ts} ${msg}`);
  }

  _isAdmin(wallet) {
    return this.ADMIN_WALLETS.some(a => a.toLowerCase() === (wallet||'').toLowerCase());
  }

  // ═══ 启动 ═══
  start() {
    if (this.running) return;
    this.running = true;
    this._log('🚀 多用户A策略管理器启动');
    this._loop();
  }

  stop() {
    this.running = false;
    if (this._timer) clearTimeout(this._timer);
    for (const engine of Object.values(this._aEngines)) engine.running = false;
    this._log('🛑 多用户A策略管理器停止');
  }

  async _loop() {
    if (!this.running) return;
    try { await this._cycle(); } catch(e) { this._log(`❌ 循环异常: ${e.message}`); }
    this._timer = setTimeout(() => this._loop(), this.intervalMs);
  }

  // ═══ 每轮: 读用户 + 创建/管理引擎 ═══
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

    // 收集需要跑A策略的用户
    const activeUsers = [];
    for (const [wallet, u] of Object.entries(users)) {
      if (!u.tradingEnabled) continue;
      if (u.exchangeMode === 'dex') continue;
      if (!u.binanceApiKey || !u.binanceSecret) continue;
      activeUsers.push({
        wallet,
        apiKey: decrypt(u.binanceApiKey),
        apiSecret: decrypt(u.binanceSecret),
        isAdmin: this._isAdmin(wallet),
        gatesFeeLow: !!u.gatesFeeLow,
      });
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
    if (this._cycleCount % 10 === 0) this._log(`第${this._cycleCount}轮: ${activeUsers.length}个活跃用户`);

    // 为每个用户创建/复用引擎
    for (const u of activeUsers) {
      await this._ensureEngine(u);
    }

    // 清理已禁用/无API的用户(保留有持仓的监控)
    const activeWallets = new Set(activeUsers.map(u => u.wallet.toLowerCase()));
    for (const wallet of Object.keys(this._aEngines)) {
      if (!activeWallets.has(wallet.toLowerCase())) {
        const pos = Object.keys(this._aEngines[wallet]?.positions || {}).length;
        if (pos > 0) {
          // 有持仓,保留监控
          this._aEngines[wallet].gatesFeePaused = true;
        } else {
          this._aEngines[wallet].running = false;
          delete this._aEngines[wallet];
          if (this._cycleCount % 10 === 0) this._log(`🛑 清理无持仓用户 ${wallet.slice(0,10)}...`);
        }
      }
    }
  }

  // ═══ 确保用户有A引擎 ═══
  async _ensureEngine(u) {
    if (!u.apiKey || u.apiKey.length < 20) return;
    if (u.apiKey.length !== 64 || !u.apiKey.match(/^[a-zA-Z0-9]+$/)) return;

    const walletKey = u.wallet.toLowerCase();
    // 管理员用新三线策略实盘测试(可开仓);其他用户只平不开自然清仓
    const isAdminEngine = !!u.isAdmin;
    const pauseOpenForThis = !isAdminEngine; // 非管理员=只平不开
    if (!this._aEngines[walletKey]) {
      // 每用户独立账容守卫(各管各的账户,防超载防强平)
      // v2: 适度提高杠杆上限以更积极开仓,但仍防超载(别重蹈B策略8.8x爆仓覆辙)
      const guard = new AccountCapacityGuard({ maxTotalLeverage: 7, maxSymbolLeverage: 3 });
      const engine = new AStrategySim(u.apiKey, u.apiSecret, {
        wallet: u.wallet,
        realTrading: true,               // 实盘真实下单
        pauseOpen: pauseOpenForThis,     // 管理员=false(开新仓),其他用户=true(只平不开)
        sharedMarket: this.sharedMarket,
        accountGuard: guard,
        userDB: this.userDB,
        perUserFile: true,                // 独立 state/trades/log 文件
      });
      this._aEngines[walletKey] = engine;
      // 错峰启动(每用户间隔,减少API压力)
      const delay = Object.keys(this._aEngines).length * 1000;
      setTimeout(() => engine.start().catch(e => this._log(`❌ ${u.wallet.slice(0,10)} A引擎启动失败: ${e.message}`)), delay);
      if (this._cycleCount <= 5) this._log(`${u.wallet.slice(0,10)}... ${isAdminEngine?'✅管理员新三线策略+可开仓':'⏸️用户只平不开清仓'}启动(延迟${delay}ms)`);
    } else {
      this._aEngines[walletKey].gatesFeePaused = !!u.gatesFeeLow;
      // 按用户强制设置pauseOpen(管理员开新仓,其他只平不开)
      this._aEngines[walletKey]._pauseOpen = pauseOpenForThis;
      if (this._cycleCount <= 5) this._log(`${u.wallet.slice(0,10)}... ${isAdminEngine?'已设为可开仓(新策略)':'只平不开(继续清仓)'}`);
    }
  }

  // ═══ 所有用户状态 ═══
  getAllUsersStatus() {
    const result = [];
    for (const [wallet, engine] of Object.entries(this._aEngines)) {
      const s = engine.getSummary ? engine.getSummary() : {};
      result.push({
        wallet,
        isAdmin: this._isAdmin(wallet),
        balance: engine.balance || 0,
        positionCount: Object.keys(engine.positions || {}).length,
        positions: Object.values(engine.positions || {}).map(p => ({
          symbol: p.symbol, side: p.side, qty: p.qty,
          entryPrice: p.entryPrice, currentPrice: p.currentPrice,
          pnlPct: p.currentPrice ? this._calcPnlPct(p) : 0,
          margin: p.margin, leverage: p.leverage,
        })),
        trades: engine._trades || 0,
        wins: engine._wins || 0,
        losses: engine._losses || 0,
        realizedPnl: engine._realizedPnl || 0,
        running: engine.running !== false,
      });
    }
    return result;
  }

  _calcPnlPct(pos) {
    if (!pos || !pos.entryPrice || !pos.currentPrice) return 0;
    if (pos.side === 'LONG') return (pos.currentPrice - pos.entryPrice) / pos.entryPrice * 100 * (pos.leverage||3);
    return (pos.entryPrice - pos.currentPrice) / pos.entryPrice * 100 * (pos.leverage||3);
  }

  // ═══ 单用户状态 ═══
  getUserStatus(wallet) {
    const engine = this._aEngines[wallet.toLowerCase()];
    if (!engine) return null;
    const s = engine.getSummary ? engine.getSummary() : {};
    return {
      wallet, balance: engine.balance || 0,
      positionCount: Object.keys(engine.positions || {}).length,
      positions: Object.values(engine.positions || {}),
      trades: engine._trades || 0, wins: engine._wins || 0,
      losses: engine._losses || 0, realizedPnl: engine._realizedPnl || 0,
      running: engine.running !== false,
    };
  }

  getStats() {
    let totalTrades = 0, totalWins = 0, totalLosses = 0, totalPnl = 0, totalPositions = 0;
    for (const engine of Object.values(this._aEngines)) {
      totalTrades += engine._trades || 0;
      totalWins += engine._wins || 0;
      totalLosses += engine._losses || 0;
      totalPnl += engine._realizedPnl || 0;
      totalPositions += Object.keys(engine.positions || {}).length;
    }
    return { running: this.running, cycleCount: this._cycleCount, engineCount: Object.keys(this._aEngines).length, totalTrades, totalWins, totalLosses, totalPnl, totalPositions };
  }

  // ═══ 兼容 dashboard /api/a-strategy-sim 接口 ═══
  getSummary() {
    const stats = this.getStats();
    const users = this.getAllUsersStatus();
    let winRate = stats.totalTrades > 0 ? (stats.totalWins / stats.totalTrades * 100) : 0;
    return {
      running: this.running,
      cycleCount: this._cycleCount,
      engineCount: stats.engineCount,
      // 兼容单实例的 getSummary 字段
      balance: users.reduce((s,u) => s + (u.balance||0), 0),
      positionCount: stats.totalPositions,
      trades: stats.totalTrades,
      wins: stats.totalWins,
      losses: stats.totalLosses,
      realizedPnl: stats.totalPnl,
      winRate: +winRate.toFixed(1),
      users,
    };
  }
}

module.exports = { MultiAStrategyManager };
