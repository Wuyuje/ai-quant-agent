/**
 * v66: 多服务器编排与监控
 * 
 * 分布式量化交易服务器管理
 * 1. 服务器注册与管理
 * 2. 健康检查 (HTTP ping)
 * 3. 负载均衡 (round-robin / least-positions / pnl-based)
 * 4. 故障转移
 * 5. 持仓与PnL聚合
 * 6. 告警系统
 * 7. 重新平衡建议
 */

const http = require('http');

class MultiServerManager {
  constructor(config = {}) {
    this.maxServers = config.maxServers || 10;
    this.healthCheckIntervalMs = config.healthCheckIntervalMs || 30000;
    this.healthCheckTimeoutMs = config.healthCheckTimeoutMs || 5000;
    this.failoverEnabled = config.failoverEnabled !== false;
    this.alertThresholds = {
      maxLatencyMs: config.maxLatencyMs || 2000,
      positionCapacityPct: config.positionCapacityPct || 0.8,
      maxDailyLossPct: config.maxDailyLossPct || -5,
      ...config.alertThresholds,
    };

    this._servers = new Map();
    this._alerts = [];
    this._failoverHistory = [];
    this._healthCheckTimer = null;
    this._rrIndex = 0;
    this.loadBalanceStrategy = config.loadBalanceStrategy || 'least-positions';
  }

  // ═══════════════════════════════════════════
  // 服务器注册
  // ═══════════════════════════════════════════
  addServer(config) {
    if (this._servers.size >= this.maxServers) {
      return { success: false, error: `已达最大服务器数 ${this.maxServers}` };
    }
    const id = config.id || `srv_${Date.now()}`;
    if (this._servers.has(id)) {
      return { success: false, error: '服务器ID已存在' };
    }
    this._servers.set(id, {
      id,
      name: config.name || id,
      host: config.host || 'localhost',
      port: config.port || 8005,
      region: config.region || 'default',
      role: config.role || 'worker',
      maxLoad: config.maxLoad || 100,
      enabled: config.enabled !== false,
      status: 'unknown',
      latency: 0,
      lastCheck: 0,
      engineRunning: false,
      positions: 0,
      pnl: 0,
      balance: 0,
      cycleCount: 0,
    });
    return { success: true, id };
  }

  removeServer(id) {
    const existed = this._servers.delete(id);
    return { success: existed, id };
  }

  // ═══════════════════════════════════════════
  // 健康检查
  // ═══════════════════════════════════════════
  async checkHealth(serverId) {
    const server = this._servers.get(serverId);
    if (!server) return { error: '服务器不存在' };

    const startTime = Date.now();
    try {
      const data = await this._httpGet(server.host, server.port, '/api/status', this.healthCheckTimeoutMs);
      const latency = Date.now() - startTime;

      server.latency = latency;
      server.lastCheck = Date.now();
      server.engineRunning = data.running || false;
      server.positions = data.positionCount || 0;
      server.pnl = data.state?.totalPnl || 0;
      server.balance = data.balance?.balance || 0;
      server.cycleCount = data.cycleCount || 0;
      server.status = server.enabled ? 'healthy' : 'disabled';

      // 告警检查
      this._checkAlerts(server);

      return { serverId, status: 'healthy', latency, data };
    } catch (e) {
      server.status = 'down';
      server.latency = Date.now() - startTime;
      server.lastCheck = Date.now();

      this._addAlert({
        type: 'SERVER_DOWN',
        serverId,
        message: `${server.name} (${server.host}:${server.port}) 不可达: ${e.message}`,
        severity: 'critical',
        time: Date.now(),
      });

      if (this.failoverEnabled) {
        await this.handleFailover(serverId);
      }

      return { serverId, status: 'down', error: e.message };
    }
  }

  async checkAllHealth() {
    const results = [];
    for (const id of this._servers.keys()) {
      results.push(await this.checkHealth(id));
    }
    return results;
  }

  startHealthCheck() {
    if (this._healthCheckTimer) clearInterval(this._healthCheckTimer);
    this._healthCheckTimer = setInterval(async () => {
      await this.checkAllHealth();
    }, this.healthCheckIntervalMs);
    return { started: true, interval: this.healthCheckIntervalMs };
  }

  stopHealthCheck() {
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer);
      this._healthCheckTimer = null;
    }
  }

  // ═══════════════════════════════════════════
  // HTTP GET 请求
  // ═══════════════════════════════════════════
  _httpGet(host, port, path, timeoutMs) {
    return new Promise((resolve, reject) => {
      const req = http.get({
        hostname: host, port, path,
        timeout: timeoutMs,
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Invalid JSON response')); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
  }

  // ═══════════════════════════════════════════
  // 负载均衡 — 选择服务器
  // ═══════════════════════════════════════════
  selectServer(task) {
    const healthy = [...this._servers.values()].filter(s => s.status === 'healthy' && s.enabled);
    if (healthy.length === 0) return null;

    switch (this.loadBalanceStrategy) {
      case 'round-robin': {
        const server = healthy[this._rrIndex % healthy.length];
        this._rrIndex = (this._rrIndex + 1) % healthy.length;
        return server;
      }
      case 'least-positions':
        return healthy.sort((a, b) => a.positions - b.positions)[0];
      case 'least-latency':
        return healthy.sort((a, b) => a.latency - b.latency)[0];
      case 'pnl-based':
        return healthy.sort((a, b) => b.pnl - a.pnl)[0];
      default:
        return healthy[0];
    }
  }

  // ═══════════════════════════════════════════
  // 故障转移
  // ═══════════════════════════════════════════
  async handleFailover(failedServerId) {
    const failed = this._servers.get(failedServerId);
    if (!failed) return { error: '服务器不存在' };

    const backups = [...this._servers.values()].filter(
      s => s.role === 'backup' && s.status === 'healthy' && s.enabled
    );

    if (backups.length === 0) {
      this._addAlert({
        type: 'FAILOVER_FAILED',
        serverId: failedServerId,
        message: `${failed.name} 故障但无可用备份服务器`,
        severity: 'critical',
        time: Date.now(),
      });
      return { success: false, error: '无可用备份服务器' };
    }

    const target = backups.sort((a, b) => a.positions - b.positions)[0];
    const failoverRecord = {
      from: failedServerId,
      to: target.id,
      fromName: failed.name,
      toName: target.name,
      positions: failed.positions,
      time: Date.now(),
      status: 'initiated',
    };

    this._failoverHistory.push(failoverRecord);
    if (this._failoverHistory.length > 50) this._failoverHistory.shift();

    this._addAlert({
      type: 'FAILOVER',
      serverId: failedServerId,
      message: `${failed.name} → ${target.name} 故障转移已启动 (${failed.positions} 个持仓)`,
      severity: 'warning',
      time: Date.now(),
    });

    return { success: true, failover: failoverRecord };
  }

  // ═══════════════════════════════════════════
  // 持仓聚合
  // ═══════════════════════════════════════════
  async aggregatePositions() {
    const allPositions = [];
    const symbolMap = {};

    for (const [id, server] of this._servers) {
      if (server.status !== 'healthy') continue;
      try {
        const data = await this._httpGet(server.host, server.port, '/api/status', this.healthCheckTimeoutMs);
        const positions = data.positions || {};
        for (const [symbol, pos] of Object.entries(positions)) {
          allPositions.push({ serverId: id, serverName: server.name, symbol, ...pos });
          if (!symbolMap[symbol]) symbolMap[symbol] = [];
          symbolMap[symbol].push(id);
        }
      } catch (e) {}
    }

    // 检测跨服务器重复持仓
    const duplicates = Object.entries(symbolMap)
      .filter(([, servers]) => servers.length > 1)
      .map(([symbol, servers]) => ({ symbol, servers }));

    return { totalPositions: allPositions.length, positions: allPositions, duplicates, duplicateCount: duplicates.length };
  }

  // ═══════════════════════════════════════════
  // PnL 聚合
  // ═══════════════════════════════════════════
  aggregatePnL() {
    let totalPnl = 0, totalTrades = 0, totalWins = 0, totalLosses = 0;
    const perServer = [];

    for (const [id, server] of this._servers) {
      if (server.status === 'down') continue;
      totalPnl += server.pnl || 0;
      const wins = 0, losses = 0, trades = 0; // 从实际数据获取
      totalTrades += trades; totalWins += wins; totalLosses += losses;
      perServer.push({ serverId: id, name: server.name, pnl: server.pnl, positions: server.positions, status: server.status });
    }

    return {
      totalPnl, totalTrades, totalWins, totalLosses,
      winRate: totalTrades > 0 ? (totalWins / totalTrades * 100) : 0,
      perServer,
    };
  }

  // ═══════════════════════════════════════════
  // 告警系统
  // ═══════════════════════════════════════════
  _addAlert(alert) {
    this._alerts.push(alert);
    if (this._alerts.length > 200) this._alerts.shift();
  }

  _checkAlerts(server) {
    // 延迟告警
    if (server.latency > this.alertThresholds.maxLatencyMs) {
      this._addAlert({
        type: 'HIGH_LATENCY',
        serverId: server.id,
        message: `${server.name} 延迟 ${server.latency}ms > ${this.alertThresholds.maxLatencyMs}ms`,
        severity: 'warning',
        time: Date.now(),
      });
    }
    // 持仓容量告警
    if (server.maxLoad > 0 && server.positions / server.maxLoad > this.alertThresholds.positionCapacityPct) {
      this._addAlert({
        type: 'HIGH_POSITIONS',
        serverId: server.id,
        message: `${server.name} 持仓 ${server.positions} 达容量 ${Math.round(server.positions / server.maxLoad * 100)}%`,
        severity: 'warning',
        time: Date.now(),
      });
    }
    // 日亏损告警
    if (server.pnl < this.alertThresholds.maxDailyLossPct) {
      this._addAlert({
        type: 'DAILY_LOSS',
        serverId: server.id,
        message: `${server.name} PnL ${server.pnl.toFixed(2)} 超日亏损限制`,
        severity: 'critical',
        time: Date.now(),
      });
    }
    // 引擎停止告警
    if (!server.engineRunning && server.enabled) {
      this._addAlert({
        type: 'ENGINE_STOPPED',
        serverId: server.id,
        message: `${server.name} 引擎已停止`,
        severity: 'critical',
        time: Date.now(),
      });
    }
  }

  getActiveAlerts() {
    const cutoff = Date.now() - 3600000; // 1小时
    return this._alerts.filter(a => a.time > cutoff);
  }

  // ═══════════════════════════════════════════
  // 重新平衡建议
  // ═══════════════════════════════════════════
  rebalance() {
    const healthy = [...this._servers.values()].filter(s => s.status === 'healthy' && s.enabled);
    if (healthy.length < 2) return { suggestions: [], reason: '可用服务器不足' };

    const avgPositions = healthy.length > 0 ? healthy.reduce((sum, s) => sum + s.positions, 0) / healthy.length : 0;
    const suggestions = [];

    for (const server of healthy) {
      if (server.positions > avgPositions * 1.5) {
        const targets = healthy.filter(s => s.id !== server.id && s.positions < avgPositions * 0.8);
        if (targets.length > 0) {
          const target = targets.sort((a, b) => a.positions - b.positions)[0];
          const moveCount = Math.ceil((server.positions - avgPositions) / 2);
          suggestions.push({
            from: server.id, fromName: server.name,
            to: target.id, toName: target.name,
            positions: moveCount,
            reason: `${server.name} 持仓 ${server.positions} 远超平均 ${avgPositions.toFixed(0)}`,
          });
        }
      }
    }

    return { suggestions, avgPositions };
  }

  // ═══════════════════════════════════════════
  // Dashboard 数据
  // ═══════════════════════════════════════════
  getDashboard() {
    const servers = [...this._servers.values()].map(s => ({
      id: s.id, name: s.name, host: s.host, port: s.port,
      region: s.region, role: s.role, status: s.status,
      latency: s.latency, positions: s.positions, pnl: s.pnl,
      balance: s.balance, engineRunning: s.engineRunning,
      cycleCount: s.cycleCount, lastCheck: s.lastCheck,
    }));

    const pnlSummary = this.aggregatePnL();
    const rebalanceSuggestions = this.rebalance();

    return {
      servers,
      totalServers: this._servers.size,
      healthyServers: servers.filter(s => s.status === 'healthy').length,
      downServers: servers.filter(s => s.status === 'down').length,
      alerts: this.getActiveAlerts(),
      failoverHistory: this._failoverHistory.slice(-10),
      pnlSummary,
      rebalanceSuggestions: rebalanceSuggestions.suggestions,
      loadBalanceStrategy: this.loadBalanceStrategy,
    };
  }

  // ═══════════════════════════════════════════
  // 汇总
  // ═══════════════════════════════════════════
  getSummary() {
    let totalPnl = 0, healthy = 0, totalPositions = 0;
    for (const s of this._servers.values()) {
      if (s.status === 'healthy') { healthy++; totalPnl += s.pnl || 0; totalPositions += s.positions; }
    }
    return {
      totalServers: this._servers.size,
      healthyServers: healthy,
      downServers: this._servers.size - healthy,
      totalPnl,
      totalPositions,
      activeAlerts: this.getActiveAlerts().length,
      failoverCount: this._failoverHistory.length,
    };
  }

  // ═══════════════════════════════════════════
  // 信号
  // ═══════════════════════════════════════════
  getSignal() {
    const summary = this.getSummary();
    let status = 'HEALTHY';
    if (summary.downServers > 0 && summary.healthyServers > 0) status = 'DEGRADED';
    if (summary.healthyServers === 0 && summary.totalServers > 0) status = 'CRITICAL';
    return {
      action: status === 'HEALTHY' ? 'CONTINUE' : status === 'DEGRADED' ? 'MONITOR' : 'FAILOVER',
      status,
      ...summary,
    };
  }
}

module.exports = { MultiServerManager };
