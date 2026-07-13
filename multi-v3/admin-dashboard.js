/**
 * AdminDashboard v3 — 管理员多用户仪表盘 API
 * 
 * 功能：
 *   - 平台总览：用户数、交易量、收入、风控状态
 *   - 用户管理：列表、详情、暂停/封禁/恢复
 *   - 风控概览：用户回撤分布、熔断状态
 *   - 收入追踪：日/周/月平台费
 *   - 系统健康：Worker状态、内存、CPU
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class AdminDashboard {
  constructor(userPool, subscriptionManager, riskIsolator, messageBus) {
    this.userPool = userPool;
    this.subscriptionManager = subscriptionManager;
    this.riskIsolator = riskIsolator;
    this.messageBus = messageBus;
    this.log = (msg) => console.log(`[AdminDashboard] ${new Date().toISOString()} ${msg}`);

    // 收入数据
    this.revenuePath = path.join(__dirname, '..', 'data', 'revenue-stats.json');
    this.revenue = this._loadRevenue();

    // v113.14: 从环境变量读取 token，不再硬编码
    this.adminToken = process.env.ADMIN_TOKEN || process.env.MULTI_ADMIN_TOKEN || crypto.randomBytes(16).toString('hex');
    this.adminTokenSet = !!process.env.ADMIN_TOKEN || !!process.env.MULTI_ADMIN_TOKEN;
  }

  /**
   * 验证管理员身份
   */
  authenticate(token) {
    return token === this.adminToken;
  }

  // ═══ 平台总览 ═══

  getOverview() {
    const poolStats = this.userPool.getPoolStats();
    const subStats = this.subscriptionManager.getStats();
    const riskOverview = this.riskIsolator.getOverview();

    // 交易统计（从data目录读取）
    const tradeStats = this._getTradeStats();

    return {
      timestamp: new Date().toISOString(),
      users: {
        total: poolStats.total,
        online: poolStats.online,
        active: poolStats.active,
        paused: poolStats.paused,
        banned: poolStats.banned,
      },
      subscriptions: subStats,
      risk: riskOverview,
      trading: tradeStats,
      revenue: this._getRevenueStats(),
      system: this._getSystemHealth(),
    };
  }

  // ═══ 用户管理 ═══

  listUsers(filters = {}) {
    const allUsers = Object.values(this.userPool.users);
    let result = allUsers;

    // 过滤
    if (filters.status) {
      result = result.filter(u => u.status === filters.status);
    }
    if (filters.search) {
      const q = filters.search.toLowerCase();
      result = result.filter(u =>
        u.userId.toLowerCase().includes(q) ||
        (u.walletAddress && u.walletAddress.toLowerCase().includes(q))
      );
    }

    // 分页
    const page = filters.page || 1;
    const limit = Math.min(filters.limit || 50, 200);
    const total = result.length;
    const offset = (page - 1) * limit;
    result = result.slice(offset, offset + limit);

    // 丰富数据
    result = result.map(u => ({
      userId: u.userId,
      walletAddress: u.walletAddress ? u.walletAddress.slice(0, 10) + '...' : null,
      status: u.status,
      registeredAt: u.registeredAt,
      lastActive: u.lastActive,
      subscription: this.subscriptionManager.getSubscription(u.userId).plan,
      riskLevel: this.riskIsolator.getUserRisk(u.userId)?.level || 'unknown',
    }));

    return { users: result, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  getUserDetail(userId) {
    const user = this.userPool.getUser(userId);
    if (!user) return null;

    return {
      ...user,
      risk: this.riskIsolator.getUserRisk(userId),
      subscription: this.subscriptionManager.getSubscription(userId),
    };
  }

  pauseUser(userId, adminId) {
    const success = this.userPool.pauseUser(userId);
    if (success) {
      this._logAction('pause_user', adminId, userId);
    }
    return { success };
  }

  resumeUser(userId, adminId) {
    const success = this.userPool.resumeUser(userId);
    if (success) {
      this._logAction('resume_user', adminId, userId);
    }
    return { success };
  }

  banUser(userId, adminId, reason) {
    const success = this.userPool.banUser(userId);
    if (success) {
      this._logAction('ban_user', adminId, userId, reason);
    }
    return { success };
  }

  // ═══ 风控管理 ═══

  emergencyStop(adminId, reason) {
    this.riskIsolator.emergencyStopAll(reason);
    this._logAction('emergency_stop', adminId, null, reason);
    return { success: true };
  }

  resumeAll(adminId) {
    this.riskIsolator.resumeFromEmergency();
    this._logAction('resume_all', adminId, null);
    return { success: true };
  }

  // ═══ 收入追踪 ═══

  addRevenue(userId, amount, type = 'subscription') {
    const today = new Date().toISOString().split('T')[0];
    if (!this.revenue.daily[today]) {
      this.revenue.daily[today] = { total: 0, subscriptions: 0, trading_fees: 0, count: 0 };
    }

    this.revenue.daily[today].total += amount;
    this.revenue.daily[today][type] = (this.revenue.daily[today][type] || 0) + amount;
    this.revenue.daily[today].count++;
    this.revenue.total += amount;

    this._saveRevenue();
  }

  getRevenueByPeriod(period = 'daily', days = 30) {
    const result = [];
    const now = new Date();

    for (let i = 0; i < days; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const key = date.toISOString().split('T')[0];
      result.push({
        date: key,
        ...(this.revenue.daily[key] || { total: 0, count: 0 }),
      });
    }

    return result.reverse();
  }

  // ═══ API 路由处理 ═══

  /**
   * 处理 HTTP 请求
   */
  handleRequest(req, res, body) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method;

    // 解析 token
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '') || url.searchParams.get('token');

    if (!this.authenticate(token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }

    // 路由
    if (path === '/admin/overview' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.getOverview()));
      return true;
    }

    if (path === '/admin/users' && method === 'GET') {
      const filters = {
        status: url.searchParams.get('status'),
        search: url.searchParams.get('search'),
        page: parseInt(url.searchParams.get('page') || '1'),
        limit: parseInt(url.searchParams.get('limit') || '50'),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.listUsers(filters)));
      return true;
    }

    const userMatch = path.match(/^\/admin\/user\/(.+)$/);
    if (userMatch && method === 'GET') {
      const detail = this.getUserDetail(userMatch[1]);
      res.writeHead(detail ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(detail || { error: 'User not found' }));
      return true;
    }

    if (path === '/admin/emergency-stop' && method === 'POST') {
      const result = this.emergencyStop('admin', body?.reason || 'Manual stop');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return true;
    }

    if (path === '/admin/resume' && method === 'POST') {
      const result = this.resumeAll('admin');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return true;
    }

    if (path === '/admin/revenue' && method === 'GET') {
      const days = parseInt(url.searchParams.get('days') || '30');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.getRevenueByPeriod('daily', days)));
      return true;
    }

    if (path === '/admin/health' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this._getSystemHealth()));
      return true;
    }

    return false; // 未匹配
  }

  // ═══ 内部方法 ═══

  _getTradeStats() {
    try {
      const tradesPath = path.join(__dirname, '..', 'data', 'cex-user-trades.json');
      if (fs.existsSync(tradesPath)) {
        const trades = JSON.parse(fs.readFileSync(tradesPath, 'utf8'));
        return {
          totalTrades: Array.isArray(trades) ? trades.length : 0,
        };
      }
    } catch (e) {}
    return { totalTrades: 0 };
  }

  _getRevenueStats() {
    const today = new Date().toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
    const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

    let weekTotal = 0, monthTotal = 0;
    Object.entries(this.revenue.daily).forEach(([date, data]) => {
      if (date >= weekAgo) weekTotal += data.total;
      if (date >= monthAgo) monthTotal += data.total;
    });

    return {
      today: this.revenue.daily[today]?.total || 0,
      thisWeek: weekTotal,
      thisMonth: monthTotal,
      allTime: this.revenue.total,
    };
  }

  _getSystemHealth() {
    const memUsage = process.memoryUsage();
    return {
      uptime: process.uptime(),
      memory: {
        rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB',
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
      },
      pid: process.pid,
      nodeVersion: process.version,
    };
  }

  _logAction(action, adminId, targetId, detail) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      action,
      adminId,
      targetId,
      detail,
    };
    this.log(`ADMIN ACTION: ${action} by ${adminId} on ${targetId || 'global'} — ${detail || ''}`);
  }

  _loadRevenue() {
    try {
      if (fs.existsSync(this.revenuePath)) {
        return JSON.parse(fs.readFileSync(this.revenuePath, 'utf8'));
      }
    } catch (e) {}
    return { daily: {}, total: 0 };
  }

  _saveRevenue() {
    try {
      const dir = path.dirname(this.revenuePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.revenuePath, JSON.stringify(this.revenue, null, 2));
    } catch (e) {}
  }
}

module.exports = AdminDashboard;
