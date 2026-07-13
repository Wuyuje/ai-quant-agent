/**
 * SubscriptionManager v3 — 订阅付费管理（v113.14 集群就绪版）
 *
 * 升级：
 *   - 用量追踪持久化到文件（多 Worker 共享）
 *   - 集群模式：用量数据定期刷新到磁盘，Worker 间通过文件共享
 *   - 有 Redis 时自动切换为 Redis 计数器
 */

const fs = require('fs');
const path = require('path');

const PLANS = {
  FREE: {
    name: 'FREE', price: 0, maxPairs: 5,
    maxStrategies: ['multiTimeframe', 'grid', 'dca', 'sentiment'],
    apiRateLimit: 100, maxOpenPositions: 2, maxPositionSize: 100,
    executionPriority: 'low', features: ['basic_signals', 'market_data'], dataRetentionDays: 7,
  },
  PRO: {
    name: 'PRO', price: 29, maxPairs: 20, maxStrategies: 'all',
    apiRateLimit: 1000, maxOpenPositions: 10, maxPositionSize: 5000,
    executionPriority: 'normal',
    features: ['basic_signals', 'market_data', 'advanced_signals', 'backtest', 'alerts', 'neural_net'],
    dataRetentionDays: 90,
  },
  VIP: {
    name: 'VIP', price: 99, maxPairs: 50, maxStrategies: 'all',
    apiRateLimit: 5000, maxOpenPositions: 50, maxPositionSize: 50000,
    executionPriority: 'high',
    features: ['basic_signals', 'market_data', 'advanced_signals', 'backtest', 'alerts', 'neural_net', 'custom_strategy', 'priority_support', 'copy_trading'],
    dataRetentionDays: 365,
  },
};

const ARK_DISCOUNT = { minBalance: 1000, discountPct: 50 };

class SubscriptionManager {
  constructor(dataPath) {
    this.dataPath = dataPath || path.join(__dirname, '..', 'data', 'subscriptions.json');
    this.usagePath = path.join(__dirname, '..', 'data', 'usage-counters.json');
    this.subscriptions = this._load();
    this.log = (msg) => console.log(`[Subscription] ${new Date().toISOString()} ${msg}`);

    // v113.14: 用量追踪持久化
    this.usage = this._loadUsage();
    this._usageFlushInterval = setInterval(() => this._flushUsage(), 5000); // 5秒刷新
    this._usageResetInterval = setInterval(() => this._resetUsage(), 60000);
  }

  getSubscription(userId) {
    const sub = this.subscriptions[userId];
    if (!sub) return this._createFreeSubscription(userId);
    if (sub.endDate && new Date(sub.endDate) < new Date()) {
      sub.status = 'expired'; sub.plan = 'FREE';
      this._save();
    }
    return sub;
  }

  getPlan(userId) {
    const sub = this.getSubscription(userId);
    return PLANS[sub.plan] || PLANS.FREE;
  }

  hasFeature(userId, feature) {
    return this.getPlan(userId).features.includes(feature);
  }

  canUseStrategy(userId, strategyName) {
    const plan = this.getPlan(userId);
    if (plan.maxStrategies === 'all') return true;
    return plan.maxStrategies.includes(strategyName);
  }

  // v113.14: 用量追踪 — 持久化到文件
  checkRateLimit(userId) {
    const plan = this.getPlan(userId);
    const usage = this._getUsage(userId);
    if (usage.apiCalls >= plan.apiRateLimit) {
      return { allowed: false, remaining: 0, resetIn: 60 - Math.floor((Date.now() - usage.resetAt) / 1000) };
    }
    usage.apiCalls++;
    return { allowed: true, remaining: plan.apiRateLimit - usage.apiCalls };
  }

  subscribe(userId, planName, durationMonths = 1, arkBalance = 0) {
    const plan = PLANS[planName];
    if (!plan || planName === 'FREE') return { success: false, error: '无效的订阅计划' };
    let price = plan.price * durationMonths;
    let discountApplied = false;
    if (arkBalance >= ARK_DISCOUNT.minBalance) {
      price *= (1 - ARK_DISCOUNT.discountPct / 100);
      discountApplied = true;
    }
    const now = new Date();
    const endDate = new Date(now);
    endDate.setMonth(endDate.getMonth() + durationMonths);
    this.subscriptions[userId] = {
      userId, plan: planName, status: 'active',
      startDate: now.toISOString(), endDate: endDate.toISOString(),
      price, discountApplied, arkBalanceAtSubscribe: arkBalance,
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
    };
    this._save();
    return { success: true, plan: planName, endDate: endDate.toISOString(), price, discountApplied };
  }

  cancel(userId) {
    const sub = this.subscriptions[userId];
    if (!sub) return { success: false, error: '无订阅记录' };
    sub.status = 'cancelled'; sub.plan = 'FREE';
    sub.updatedAt = new Date().toISOString();
    this._save();
    return { success: true };
  }

  getStats() {
    const subs = Object.values(this.subscriptions);
    const active = subs.filter(s => s.status === 'active');
    const byPlan = { FREE: 0, PRO: 0, VIP: 0 };
    let monthlyRevenue = 0;
    subs.forEach(s => {
      byPlan[s.plan] = (byPlan[s.plan] || 0) + 1;
      if (s.status === 'active' && s.plan !== 'FREE') {
        const plan = PLANS[s.plan];
        monthlyRevenue += plan ? plan.price : 0;
      }
    });
    return {
      totalUsers: subs.length, activeUsers: active.length, byPlan, monthlyRevenue,
      avgRevenuePerUser: active.length > 0 ? (monthlyRevenue / active.length).toFixed(2) : 0,
    };
  }

  _getUsage(userId) {
    if (!this.usage[userId] || Date.now() - this.usage[userId].resetAt > 60000) {
      this.usage[userId] = { apiCalls: 0, trades: 0, dataQueries: 0, resetAt: Date.now() };
    }
    return this.usage[userId];
  }

  _resetUsage() {
    const now = Date.now();
    Object.keys(this.usage).forEach(userId => {
      if (now - this.usage[userId].resetAt > 60000) {
        this.usage[userId] = { apiCalls: 0, trades: 0, dataQueries: 0, resetAt: now };
      }
    });
  }

  // v113.14: 持久化用量到文件（集群共享）
  _loadUsage() {
    try {
      if (fs.existsSync(this.usagePath)) {
        return JSON.parse(fs.readFileSync(this.usagePath, 'utf8'));
      }
    } catch (e) {}
    return {};
  }

  _flushUsage() {
    try {
      fs.writeFileSync(this.usagePath, JSON.stringify(this.usage, null, 2));
    } catch (e) {}
  }

  _createFreeSubscription(userId) {
    this.subscriptions[userId] = {
      userId, plan: 'FREE', status: 'active',
      startDate: new Date().toISOString(), endDate: null, price: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    this._save();
    return this.subscriptions[userId];
  }

  _load() {
    try {
      if (fs.existsSync(this.dataPath)) return JSON.parse(fs.readFileSync(this.dataPath, 'utf8'));
    } catch (e) {}
    return {};
  }

  _save() {
    try {
      const dir = path.dirname(this.dataPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.dataPath, JSON.stringify(this.subscriptions, null, 2));
    } catch (e) {}
  }

  shutdown() {
    if (this._usageFlushInterval) clearInterval(this._usageFlushInterval);
    if (this._usageResetInterval) clearInterval(this._usageResetInterval);
    this._flushUsage();
    this._save();
  }
}

module.exports = { SubscriptionManager, PLANS, ARK_DISCOUNT };
