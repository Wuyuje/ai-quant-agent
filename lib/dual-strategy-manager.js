/**
 * 双策略管理器 — BB策略 + 趋势策略 共同运行
 * 
 * - BB策略最多3仓, 趋势策略最多2仓, 总共最多5仓
 * - 各自独立管理止盈止损, 互不干扰
 * - 同币种不冲突: 一个币只能被一个策略管理
 * - 共享Binance API, 但各自维护自己的positions
 */

const { BBStrategy } = require('./bb-strategy');
const { TrendStrategy } = require('./trend-strategy');
const fs = require('fs');
const path = require('path');

class DualStrategyManager {
  constructor(opts = {}) {
    this.adminApiKey = opts.apiKey || process.env.BINANCE_API_KEY || '';
    this.adminApiSecret = opts.apiSecret || process.env.BINANCE_API_SECRET || '';
    this.userDB = opts.userDB || null;
    this.running = false;
    
    // BB策略实例池 { wallet → BBStrategy }
    this._bbEngines = {};
    // 趋势策略实例池 { wallet → TrendStrategy }
    this._trendEngines = {};
    
    this.ADMIN_WALLETS = [
      '0xfa3b90c574469909d20848273c06752a22fde74a',
      '0xe6ddf0771c7610dba77eb5a07ba7771dd7f5e91e',
    ];
    
    this._log('双策略管理器初始化');
  }

  _log(msg) {
    const ts = new Date().toISOString();
    console.log(`[DualStrategy] ${ts} ${msg}`);
  }

  // ═══ 启动管理员的双策略 ═══
  async startAdmin() {
    const wallet = this.ADMIN_WALLETS[0];
    const bb = new BBStrategy(this.adminApiKey, this.adminApiSecret, wallet);
    const trend = new TrendStrategy(this.adminApiKey, this.adminApiSecret, wallet);
    
    this._bbEngines[wallet] = bb;
    this._trendEngines[wallet] = trend;
    
    // 先启动BB策略
    bb.start().catch(e => this._log(`❌ BB策略启动失败: ${e.message}`));
    
    // 5秒后启动趋势策略(避免同时拉API)
    setTimeout(() => {
      trend.start().catch(e => this._log(`❌ 趋势策略启动失败: ${e.message}`));
    }, 5000);
    
    this._log(`✅ 管理员双策略启动: BB(${wallet.slice(0,10)}...) + TREND(${wallet.slice(0,10)}...)`);
  }

  // ═══ 启动用户的双策略 ═══
  async startUser(wallet, apiKey, apiSecret) {
    if (!apiKey || !apiSecret) return;
    if (this._bbEngines[wallet] && this._trendEngines[wallet]) return;
    
    const bb = new BBStrategy(apiKey, apiSecret, wallet);
    const trend = new TrendStrategy(apiKey, apiSecret, wallet);
    
    this._bbEngines[wallet] = bb;
    this._trendEngines[wallet] = trend;
    
    bb.start().catch(e => this._log(`❌ ${wallet.slice(0,10)} BB启动失败: ${e.message}`));
    setTimeout(() => {
      trend.start().catch(e => this._log(`❌ ${wallet.slice(0,10)} 趋势启动失败: ${e.message}`));
    }, 5000);
    
    this._log(`✅ ${wallet.slice(0,10)}... 双策略启动`);
  }

  // ═══ 获取管理员状态 ═══
  getAdminStatus() {
    for (const w of this.ADMIN_WALLETS) {
      const bb = this._bbEngines[w];
      const trend = this._trendEngines[w];
      if (bb || trend) {
        return {
          wallet: w,
          bb: bb ? bb.getSummary() : null,
          trend: trend ? trend.getSummary() : null,
          totalPositions: (bb?.positions.length || 0) + (trend?.positions.length || 0),
        };
      }
    }
    return null;
  }

  // ═══ 获取所有用户状态 ═══
  getAllUsersStatus() {
    const result = [];
    for (const wallet of Object.keys(this._bbEngines)) {
      if (this.ADMIN_WALLETS.includes(wallet)) continue;
      const bb = this._bbEngines[wallet];
      const trend = this._trendEngines[wallet];
      result.push({
        wallet,
        bb: bb ? bb.getSummary() : null,
        trend: trend ? trend.getSummary() : null,
      });
    }
    return result;
  }

  // ═══ 获取用户状态 ═══
  getUserStatus(wallet) {
    const bb = this._bbEngines[wallet];
    const trend = this._trendEngines[wallet];
    if (!bb && !trend) return null;
    return {
      wallet,
      bb: bb ? bb.getSummary() : null,
      trend: trend ? trend.getSummary() : null,
    };
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
