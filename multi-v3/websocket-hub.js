/**
 * WebSocketHub v3 — 实时推送中心
 * 
 * 功能：
 *   - 每个用户订阅自己的数据频道
 *   - 频道：own_positions, own_trades, market_overview, signals, alerts
 *   - 心跳检测（15秒间隔）
 *   - 空闲断开（60秒无活动）
 *   - O(N) 广播（不是 O(N²)）
 *   - 每用户推送节流（positions: 1次/秒, market: 1次/秒）
 */

const EventEmitter = require('events');

class WebSocketHub extends EventEmitter {
  constructor(config = {}) {
    super();
    this.port = config.port || 8015;
    this.heartbeatInterval = config.heartbeatInterval || 15000;
    this.idleTimeout = config.idleTimeout || 60000;
    this.log = (msg) => console.log(`[WSHub] ${new Date().toISOString()} ${msg}`);

    // 连接池
    this.clients = new Map();  // userId → { ws, subscriptions, lastActivity, throttleState }

    // 频道订阅索引
    this.channelIndex = new Map();  // channel → Set<userId>

    // 统计
    this.stats = {
      totalConnections: 0,
      currentConnections: 0,
      messagesSent: 0,
      messagesDropped: 0,
    };

    // 心跳和空闲检测
    this._heartbeatTimer = null;
    this._idleCheckTimer = null;

    // 行情数据缓存（避免重复推送）
    this._marketCache = { data: null, timestamp: 0 };
  }

  /**
   * 启动 WebSocket 服务器
   */
  start(server) {
    // 如果传入 HTTP server，使用 ws 库挂载
    try {
      const WebSocket = require('ws');
      this.wss = new WebSocket.Server({ server, path: '/ws' });
      
      this.wss.on('connection', (ws, req) => {
        this._handleConnection(ws, req);
      });

      this.log(`WebSocket 服务器启动 — 端口 ${this.port}`);
    } catch (e) {
      // ws 库未安装，使用轮询模式降级
      this.log(`ws 库未安装，使用 HTTP 长轮询降级模式`);
    }

    // 心跳
    this._heartbeatTimer = setInterval(() => this._heartbeat(), this.heartbeatInterval);
    // 空闲检测
    this._idleCheckTimer = setInterval(() => this._checkIdle(), 30000);
  }

  /**
   * 处理新连接
   */
  _handleConnection(ws, req) {
    let userId = null;

    // 从URL参数或首条消息获取 userId
    const url = new URL(req.url, `http://localhost`);
    userId = url.searchParams.get('userId');

    if (!userId) {
      // 等待认证消息
      const authTimeout = setTimeout(() => {
        ws.close(4001, '认证超时');
      }, 10000);

      ws.once('message', (data) => {
        clearTimeout(authTimeout);
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'auth' && msg.userId) {
            userId = msg.userId;
            this._registerClient(userId, ws);
          } else {
            ws.close(4002, '认证失败');
          }
        } catch (e) {
          ws.close(4003, '消息格式错误');
        }
      });
    } else {
      this._registerClient(userId, ws);
    }
  }

  /**
   * 注册客户端
   */
  _registerClient(userId, ws) {
    // 替换旧连接
    if (this.clients.has(userId)) {
      const oldClient = this.clients.get(userId);
      try { oldClient.ws.close(4004, '新连接替代'); } catch (e) {}
    }

    const client = {
      ws,
      userId,
      subscriptions: new Set(['own_positions', 'own_trades', 'market_overview']),
      lastActivity: Date.now(),
      throttleState: {},
      connectedAt: Date.now(),
    };

    this.clients.set(userId, client);
    this.stats.totalConnections++;
    this.stats.currentConnections = this.clients.size;

    // 默认订阅频道
    client.subscriptions.forEach(ch => {
      if (!this.channelIndex.has(ch)) this.channelIndex.set(ch, new Set());
      this.channelIndex.get(ch).add(userId);
    });

    // 发送欢迎消息
    this._send(ws, {
      type: 'connected',
      userId,
      channels: Array.from(client.subscriptions),
      serverTime: Date.now(),
    });

    // 消息处理
    ws.on('message', (data) => {
      client.lastActivity = Date.now();
      try {
        const msg = JSON.parse(data);
        this._handleClientMessage(userId, msg);
      } catch (e) {}
    });

    ws.on('close', () => {
      this._unregisterClient(userId);
    });

    ws.on('error', () => {
      this._unregisterClient(userId);
    });

    this.log(`客户端连接: ${userId}`);
  }

  /**
   * 处理客户端消息
   */
  _handleClientMessage(userId, msg) {
    const client = this.clients.get(userId);
    if (!client) return;

    switch (msg.type) {
      case 'subscribe':
        if (msg.channel) {
          client.subscriptions.add(msg.channel);
          if (!this.channelIndex.has(msg.channel)) this.channelIndex.set(msg.channel, new Set());
          this.channelIndex.get(msg.channel).add(userId);
          this._send(client.ws, { type: 'subscribed', channel: msg.channel });
        }
        break;

      case 'unsubscribe':
        if (msg.channel) {
          client.subscriptions.delete(msg.channel);
          this.channelIndex.get(msg.channel)?.delete(userId);
          this._send(client.ws, { type: 'unsubscribed', channel: msg.channel });
        }
        break;

      case 'ping':
        this._send(client.ws, { type: 'pong', time: Date.now() });
        break;

      case 'request_positions':
        this.emit('request:positions', userId);
        break;

      case 'request_trades':
        this.emit('request:trades', userId);
        break;
    }
  }

  // ═══ 推送 API ═══

  /**
   * 推送给单个用户
   */
  sendToUser(userId, channel, data) {
    const client = this.clients.get(userId);
    if (!client || !client.subscriptions.has(channel)) return;

    // 节流检查
    const throttleKey = channel;
    const now = Date.now();
    const lastSent = client.throttleState[throttleKey] || 0;
    const throttleMs = this._getThrottleMs(channel);

    if (now - lastSent < throttleMs) {
      this.stats.messagesDropped++;
      return;
    }

    client.throttleState[throttleKey] = now;
    this._send(client.ws, { type: 'data', channel, data, timestamp: now });
    this.stats.messagesSent++;
  }

  /**
   * 广播到频道所有订阅者
   */
  broadcast(channel, data) {
    const subscribers = this.channelIndex.get(channel);
    if (!subscribers || subscribers.size === 0) return;

    const now = Date.now();
    const msg = JSON.stringify({ type: 'data', channel, data, timestamp: now });

    subscribers.forEach(userId => {
      const client = this.clients.get(userId);
      if (!client) return;

      // 节流
      const lastSent = client.throttleState[channel] || 0;
      if (now - lastSent < this._getThrottleMs(channel)) {
        this.stats.messagesDropped++;
        return;
      }

      client.throttleState[channel] = now;
      try {
        client.ws.send(msg);
        this.stats.messagesSent++;
      } catch (e) {
        this._unregisterClient(userId);
      }
    });
  }

  /**
   * 行情数据推送（带缓存）
   */
  pushMarketUpdate(data) {
    const now = Date.now();
    // 全局节流：市场数据最多1秒推一次
    if (now - this._marketCache.timestamp < 1000) return;
    
    this._marketCache = { data, timestamp: now };
    this.broadcast('market_overview', data);
  }

  /**
   * 推送交易信号给特定用户
   */
  pushSignal(userId, signal) {
    this.sendToUser(userId, 'signals', signal);
  }

  /**
   * 推送警报给特定用户
   */
  pushAlert(userId, alert) {
    this.sendToUser(userId, 'alerts', alert);
  }

  /**
   * 推送持仓更新
   */
  pushPositions(userId, positions) {
    this.sendToUser(userId, 'own_positions', positions);
  }

  /**
   * 推送交易记录
   */
  pushTrade(userId, trade) {
    this.sendToUser(userId, 'own_trades', trade);
  }

  // ═══ 内部方法 ═══

  _getThrottleMs(channel) {
    switch (channel) {
      case 'own_positions': return 1000;
      case 'market_overview': return 1000;
      case 'own_trades': return 500;
      case 'signals': return 2000;
      case 'alerts': return 500;
      default: return 1000;
    }
  }

  _send(ws, data) {
    try {
      if (ws.readyState === 1) { // OPEN
        ws.send(JSON.stringify(data));
      }
    } catch (e) {}
  }

  _unregisterClient(userId) {
    const client = this.clients.get(userId);
    if (!client) return;

    client.subscriptions.forEach(ch => {
      this.channelIndex.get(ch)?.delete(userId);
    });

    this.clients.delete(userId);
    this.stats.currentConnections = this.clients.size;
    this.log(`客户端断开: ${userId}`);
  }

  _heartbeat() {
    const now = Date.now();
    this.clients.forEach((client, userId) => {
      try {
        if (client.ws.readyState === 1) {
          this._send(client.ws, { type: 'heartbeat', time: now });
        }
      } catch (e) {
        this._unregisterClient(userId);
      }
    });
  }

  _checkIdle() {
    const now = Date.now();
    this.clients.forEach((client, userId) => {
      if (now - client.lastActivity > this.idleTimeout) {
        this.log(`用户 ${userId} 空闲超时，断开连接`);
        try { client.ws.close(4010, '空闲超时'); } catch (e) {}
        this._unregisterClient(userId);
      }
    });
  }

  getStats() {
    return {
      ...this.stats,
      channels: Object.fromEntries(
        Array.from(this.channelIndex.entries()).map(([ch, users]) => [ch, users.size])
      ),
    };
  }

  async shutdown() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    if (this._idleCheckTimer) clearInterval(this._idleCheckTimer);
    this.clients.forEach((client, userId) => {
      try { client.ws.close(1000, '服务器关闭'); } catch (e) {}
    });
    this.clients.clear();
    this.channelIndex.clear();
    if (this.wss) this.wss.close();
    this.log('WebSocketHub 已关闭');
  }
}

module.exports = WebSocketHub;
