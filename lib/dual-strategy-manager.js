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
      if (!isAdmin) {
        if (u.gatesFeeLow) {
          if (this._cycleCount % 10 === 0) {
            this._log(`⏸️ ${wallet.slice(0,10)}... 算力费不足($${(u.gatesFeeBalance||0).toFixed(2)})，暂停开新仓`);
          }
        }
      }
      
      activeUsers.push({ wallet, apiKey: u.binanceApiKey, apiSecret: u.binanceSecret, isAdmin, gatesFeeLow: !!u.gatesFeeLow });
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
    // BB引擎
    if (!this._bbEngines[wallet]) {
      const bb = new BBStrategy(apiKey, apiSecret, wallet);
      bb.gatesFeePaused = gatesFeeLow;
      this._bbEngines[wallet] = bb;
      bb.start().catch(e => this._log(`❌ ${wallet.slice(0,10)} BB启动失败: ${e.message}`));
      if (this._cycleCount <= 1) this._log(`✅ ${wallet.slice(0,10)}... BB引擎启动`);
    } else {
      this._bbEngines[wallet].gatesFeePaused = gatesFeeLow;
    }
    
    // 趋势引擎(延迟5秒启动避免API冲突)
    if (!this._trendEngines[wallet]) {
      const trend = new TrendStrategy(apiKey, apiSecret, wallet);
      trend.gatesFeePaused = gatesFeeLow;
      this._trendEngines[wallet] = trend;
      setTimeout(() => {
        trend.start().catch(e => this._log(`❌ ${wallet.slice(0,10)} 趋势启动失败: ${e.message}`));
      }, 5000);
      if (this._cycleCount <= 1) this._log(`✅ ${wallet.slice(0,10)}... 趋势引擎启动`);
    } else {
      this._trendEngines[wallet].gatesFeePaused = gatesFeeLow;
    }
    
    // 互相注入仓位(避免接管对方仓位)
    this._bbEngines[wallet]?.setTrendPositions?.(this._trendEngines[wallet]?.positions || {});
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
        return {
          wallet: w,
          bb: bb ? bb.getSummary() : null,
          trend: trend ? trend.getSummary() : null,
          totalPositions: (bb?.getSummary().positionCount || 0) + (trend?.getSummary().positionCount || 0),
        };
      }
    }
    return null;
  }

  // ═══ 所有用户状态 ═══
  getAllUsersStatus() {
    const result = [];
    for (const wallet of Object.keys(this._bbEngines)) {
      if (this.ADMIN_WALLETS.includes(wallet) || this.ADMIN_WALLETS.includes(wallet.toLowerCase())) continue;
      result.push({
        wallet,
        bb: this._bbEngines[wallet]?.getSummary() || null,
        trend: this._trendEngines[wallet]?.getSummary() || null,
      });
    }
    return result;
  }

  // ═══ 单用户状态 ═══
  getUserStatus(wallet) {
    const bb = this._bbEngines[wallet];
    const trend = this._trendEngines[wallet];
    if (!bb && !trend) return null;
    return { wallet, bb: bb?.getSummary() || null, trend: trend?.getSummary() || null };
  }

  // ═══ 统计 ═══
  getStats() {
    let bbPositions = 0, trendPositions = 0;
    let bbPnl = 0, trendPnl = 0;
    
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
    
    return {
      running: this.running,
      cycleCount: this._cycleCount,
      bbUsers: Object.keys(this._bbEngines).length,
      trendUsers: Object.keys(this._trendEngines).length,
      bbPositions, trendPositions,
      totalPositions: bbPositions + trendPositions,
      bbPnl: +bbPnl.toFixed(2),
      trendPnl: +trendPnl.toFixed(2),
      totalPnl: +(bbPnl + trendPnl).toFixed(2),
    };
  }
}

module.exports = { DualStrategyManager };
