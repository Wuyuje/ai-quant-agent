/**
 * UserPool v3 — 用户连接池管理
 * 
 * 功能：
 *   - 每个 Worker 最大管理 1000 用户
 *   - Session 管理（TTL 30天）
 *   - 用户状态：active/paused/banned/expired
 *   - API 速率限制（由 SubscriptionManager 提供额度）
 *   - 活跃用户追踪
 *   - 队列溢出保护
 */

const fs = require('fs');
const path = require('path');

const CONFIG = {
  maxUsersPerWorker: 1000,
  sessionTTL: 30 * 24 * 3600 * 1000,  // 30天
  staleThreshold: 5 * 60 * 1000,       // 5分钟没活动 = stale
  cleanupInterval: 60 * 1000,          // 1分钟清理一次
};

class UserPool {
  constructor(subscriptionManager, messageBus) {
    this.subscriptionManager = subscriptionManager;
    this.messageBus = messageBus;
    this.log = (msg) => console.log(`[UserPool] ${new Date().toISOString()} ${msg}`);

    // 用户注册表
    this.users = {};   // userId → { status, sessionToken, lastActive, config, registeredAt }
    
    // 活跃会话
    this.sessions = {};  // sessionToken → { userId, createdAt, lastAccess }

    // 排队等待的用户（超出worker容量时）
    this.pendingQueue = [];

    // 统计
    this.stats = {
      totalRegistered: 0,
      activeNow: 0,
      totalSessions: 0,
      rejectedOverflow: 0,
    };

    // 定期清理
    this._cleanupInterval = setInterval(() => this._cleanup(), CONFIG.cleanupInterval);
  }

  // ═══ 用户注册 ═══

  /**
   * 注册新用户
   */
  register(userId, walletAddress, initialConfig = {}) {
    if (Object.keys(this.users).length >= CONFIG.maxUsersPerWorker) {
      this.pendingQueue.push({ userId, walletAddress, initialConfig });
      this.stats.rejectedOverflow++;
      this.log(`⚠️ Worker 已满 (${CONFIG.maxUsersPerWorker}), 用户 ${userId} 加入排队`);
      return { success: false, reason: 'worker_full', queuePosition: this.pendingQueue.length };
    }

    this.users[userId] = {
      userId,
      walletAddress,
      status: 'active',
      sessionToken: null,
      lastActive: Date.now(),
      registeredAt: Date.now(),
      config: {
        pairs: initialConfig.pairs || ['BTCUSDT'],
        riskLevel: initialConfig.riskLevel || 'medium',
        autoTrading: initialConfig.autoTrading !== false,
        maxPositionPct: initialConfig.maxPositionPct || 0.15,
        stopLossPct: initialConfig.stopLossPct || 0.05,
        ...initialConfig,
      },
    };

    this.stats.totalRegistered++;

    // 注册到风控
    if (this.riskIsolator) {
      this.riskIsolator.registerUser(userId);
    }

    // 注册到订阅
    this.subscriptionManager.getSubscription(userId);

    this.log(`用户注册: ${userId} (${walletAddress.slice(0, 10)}...)`);
    return { success: true };
  }

  // ═══ Session 管理 ═══

  /**
   * 创建/续期会话
   */
  createSession(userId) {
    if (!this.users[userId]) return { success: false, reason: 'user_not_found' };
    if (this.users[userId].status === 'banned') return { success: false, reason: 'user_banned' };

    const token = `sess_${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    this.sessions[token] = {
      userId,
      createdAt: Date.now(),
      lastAccess: Date.now(),
    };

    this.users[userId].sessionToken = token;
    this.users[userId].lastActive = Date.now();
    this.stats.totalSessions++;

    return { success: true, token, expiresIn: CONFIG.sessionTTL };
  }

  /**
   * 验证会话
   */
  validateSession(token) {
    const session = this.sessions[token];
    if (!session) return { valid: false, reason: 'session_not_found' };

    const age = Date.now() - session.createdAt;
    if (age > CONFIG.sessionTTL) {
      this.destroySession(token);
      return { valid: false, reason: 'session_expired' };
    }

    session.lastAccess = Date.now();
    const user = this.users[session.userId];
    if (user) user.lastActive = Date.now();

    return { valid: true, userId: session.userId };
  }

  /**
   * 销毁会话
   */
  destroySession(token) {
    const session = this.sessions[token];
    if (session) {
      const user = this.users[session.userId];
      if (user) user.sessionToken = null;
      delete this.sessions[token];
    }
  }

  // ═══ 用户操作 ═══

  /**
   * 暂停用户
   */
  pauseUser(userId) {
    if (this.users[userId]) {
      this.users[userId].status = 'paused';
      this.log(`用户 ${userId} 已暂停`);
      return true;
    }
    return false;
  }

  /**
   * 恢复用户
   */
  resumeUser(userId) {
    if (this.users[userId] && this.users[userId].status === 'paused') {
      this.users[userId].status = 'active';
      this.log(`用户 ${userId} 已恢复`);
      return true;
    }
    return false;
  }

  /**
   * 封禁用户
   */
  banUser(userId) {
    if (this.users[userId]) {
      this.users[userId].status = 'banned';
      if (this.users[userId].sessionToken) {
        this.destroySession(this.users[userId].sessionToken);
      }
      this.log(`🚫 用户 ${userId} 已封禁`);
      return true;
    }
    return false;
  }

  /**
   * 更新用户配置
   */
  updateConfig(userId, config) {
    if (!this.users[userId]) return false;
    this.users[userId].config = { ...this.users[userId].config, ...config };
    return true;
  }

  /**
   * 获取活跃用户列表
   */
  getActiveUsers() {
    const now = Date.now();
    return Object.values(this.users).filter(u =>
      u.status === 'active' && (now - u.lastActive) < CONFIG.staleThreshold
    );
  }

  /**
   * 获取用户详情
   */
  getUser(userId) {
    const user = this.users[userId];
    if (!user) return null;

    const subscription = this.subscriptionManager.getSubscription(userId);
    return {
      ...user,
      sessionToken: user.sessionToken ? '***' : null,
      subscription,
    };
  }

  /**
   * 池状态
   */
  getPoolStats() {
    const users = Object.values(this.users);
    const now = Date.now();
    return {
      total: users.length,
      max: CONFIG.maxUsersPerWorker,
      utilization: (users.length / CONFIG.maxUsersPerWorker * 100).toFixed(1) + '%',
      active: users.filter(u => u.status === 'active').length,
      paused: users.filter(u => u.status === 'paused').length,
      banned: users.filter(u => u.status === 'banned').length,
      online: users.filter(u => u.status === 'active' && (now - u.lastActive) < CONFIG.staleThreshold).length,
      activeSessions: Object.keys(this.sessions).length,
      pendingQueue: this.pendingQueue.length,
      stats: this.stats,
    };
  }

  // ═══ 清理 ═══

  _cleanup() {
    const now = Date.now();

    // 清理过期会话
    Object.entries(this.sessions).forEach(([token, session]) => {
      if (now - session.createdAt > CONFIG.sessionTTL) {
        this.destroySession(token);
      }
    });

    // 处理排队用户
    if (this.pendingQueue.length > 0 && Object.keys(this.users).length < CONFIG.maxUsersPerWorker) {
      const batch = this.pendingQueue.splice(0, Math.min(10, this.pendingQueue.length));
      batch.forEach(({ userId, walletAddress, initialConfig }) => {
        this.register(userId, walletAddress, initialConfig);
      });
    }
  }

  shutdown() {
    if (this._cleanupInterval) clearInterval(this._cleanupInterval);
    this.log('UserPool 已关闭');
  }
}

module.exports = UserPool;
