/**
 * RevenueDistributor — 收益分配器
 * 
 * 负责记录每次平仓后的收益分配：
 * - 用户收益 80% → 用户钱包
 * - 平台算力 Token 20% → 平台钱包
 * 
 * 链上分配合约（Phase 2 部署到 BSC）：
 * - RevenueDistribution.sol
 * - 用户充值/提现合约
 * - 订阅费管理合约
 */

const fs = require('fs');
const path = require('path');

const REVENUE_LOG = path.join(__dirname, '..', 'data', 'revenue.json');
const STATS_FILE = path.join(__dirname, '..', 'data', 'revenue-stats.json');

class RevenueDistributor {
  constructor(config = {}) {
    this.platformWallet = config.platformWallet || '0x0000000000000000000000000000000000000000';
    this.platformFeePct = config.platformFeePct || 20;
    this.userSharePct = config.userSharePct || 80;
    
    this.revenueLog = this._loadLog();
    this.stats = this._loadStats();
    
    this.log = (msg) => console.log(`[Revenue] ${new Date().toISOString()} ${msg}`);
  }

  // ============ 计算分配 ============
  calculate(pnl) {
    const userShare = pnl * (this.userSharePct / 100);
    const platformFee = pnl * (this.platformFeePct / 100);

    return {
      totalPnl: pnl,
      userShare,
      platformFee,
      breakdown: {
        userPct: this.userSharePct,
        platformPct: this.platformFeePct,
      }
    };
  }

  // ============ 记录分配 ============
  record(userId, pnl, distribution) {
    const record = {
      userId,
      pnl,
      distribution,
      timestamp: Date.now(),
    };

    this.revenueLog.push(record);

    // 更新统计
    this.stats.totalPnl += pnl;
    this.stats.totalPlatformFee += distribution.platformFee;
    this.stats.totalUserShare += distribution.userShare;
    this.stats.totalTrades++;
    if (!this.stats.userStats[userId]) {
      this.stats.userStats[userId] = { totalPnl: 0, totalFee: 0, trades: 0 };
    }
    this.stats.userStats[userId].totalPnl += pnl;
    this.stats.userStats[userId].totalFee += distribution.platformFee;
    this.stats.userStats[userId].trades++;

    this._save();
    return record;
  }

  // ============ 查询 ============
  getUserRevenue(userId) {
    const userTrades = this.revenueLog.filter(r => r.userId === userId);
    const totalPnl = userTrades.reduce((s, r) => s + r.pnl, 0);
    const totalFee = userTrades.reduce((s, r) => s + r.distribution.platformFee, 0);
    const totalUserShare = userTrades.reduce((s, r) => s + r.distribution.userShare, 0);
    
    return {
      userId,
      totalPnl,
      totalFee,
      totalUserShare,
      tradeCount: userTrades.length,
      trades: userTrades.slice(-20),
    };
  }

  getStats() {
    return { ...this.stats };
  }

  // ============ 持久化 ============
  _loadLog() {
    try {
      if (fs.existsSync(REVENUE_LOG)) return JSON.parse(fs.readFileSync(REVENUE_LOG, 'utf8'));
    } catch (e) { console.error(`[Revenue] _loadLog FAILED: ${e.message}`); }
    return [];
  }

  _loadStats() {
    try {
      if (fs.existsSync(STATS_FILE)) return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    } catch (e) { console.error(`[Revenue] _loadStats FAILED: ${e.message}`); }
    return {
      totalPnl: 0,
      totalPlatformFee: 0,
      totalUserShare: 0,
      totalTrades: 0,
      userStats: {},
    };
  }

  _save() {
    try {
      if (this.revenueLog.length > 2000) this.revenueLog = this.revenueLog.slice(-1000);
      fs.writeFileSync(REVENUE_LOG, JSON.stringify(this.revenueLog, null, 2));
      fs.writeFileSync(STATS_FILE, JSON.stringify(this.stats, null, 2));
    } catch (e) { console.error(`[Revenue] _save FAILED: ${e.message}`); }
  }
}

module.exports = RevenueDistributor;
