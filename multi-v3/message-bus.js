/**
 * MessageBus v3 — 进程间消息队列（v113.14 集群就绪版）
 *
 * 升级：
 *   - 单机模式：EventEmitter 进程内通信（零依赖）
 *   - 集群模式：自动检测 Redis，有则用 Redis pub/sub 跨 Worker 通信
 *   - 无 Redis 时降级为进程内通信，不报错
 *   - 消息 TTL + 优先级 + 背压保护 + 批量发送
 */

const EventEmitter = require('events');

const PRIORITY = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
const DEFAULT_TTL = {
  PRICE_UPDATE: 30000, TRADE_SIGNAL: 300000, USER_ACTION: 300000,
  HEARTBEAT: 60000, ALERT: 300000, SYSTEM: 600000,
};

class MessageBus extends EventEmitter {
  constructor(config = {}) {
    super();
    this.maxQueueSize = config.maxQueueSize || 10000;
    this.batchInterval = config.batchInterval || 100;
    this.redisUrl = config.redisUrl || process.env.REDIS_URL || null;
    this.log = (msg) => console.log(`[MessageBus] ${new Date().toISOString()} ${msg}`);

    this.queues = {};
    Object.keys(DEFAULT_TTL).forEach(type => { this.queues[type] = []; });
    this.subscriptions = new Map();
    this._redisClient = null;
    this._redisSub = null;
    this._redisReady = false;

    this.stats = { published: 0, delivered: 0, dropped: 0, expired: 0, batches: 0, crossProcess: 0 };
    this._batchBuffer = [];
    this._batchTimer = null;
    this._cleanupInterval = setInterval(() => this._cleanup(), 10000);

    // v113.14: 尝试连接 Redis（集群模式）
    this._initRedis();
  }

  async _initRedis() {
    if (!this.redisUrl) return; // 单机模式，不需要 Redis

    try {
      const redis = require('redis');
      this._redisClient = redis.createClient({ url: this.redisUrl });
      this._redisSub = redis.createClient({ url: this.redisUrl });

      this._redisSub.on('message', (channel, data) => {
        try {
          const msg = JSON.parse(data);
          this._dispatchLocal(msg.type, msg.payload, msg);
          this.stats.crossProcess++;
        } catch (e) {}
      });

      await this._redisClient.connect();
      await this._redisSub.connect();
      this._redisReady = true;
      this.log(`Redis 连接成功 — 集群模式已启用`);
    } catch (e) {
      this.log(`Redis 不可用 (${e.message}) — 降级为单机模式`);
      this._redisReady = false;
    }
  }

  publish(type, payload, priority = 'NORMAL') {
    const now = Date.now();
    const ttl = DEFAULT_TTL[type] || 300000;
    const message = {
      type, payload, priority: PRIORITY[priority] || PRIORITY.NORMAL,
      priorityName: priority, publishedAt: now, expiresAt: now + ttl,
      id: `msg_${now}_${Math.random().toString(36).slice(2, 8)}`,
      source: process.env.WORKER_ID || 'master',
    };

    const queue = this.queues[type];
    if (queue && queue.length >= this.maxQueueSize) {
      const dropped = this._dropLowestPriority(type);
      if (dropped) { this.stats.dropped++; }
    }
    if (queue) { queue.push(message); queue.sort((a, b) => a.priority - b.priority); }
    this.stats.published++;

    // v113.14: 集群模式 — 通过 Redis 跨 Worker
    if (this._redisReady && this._redisClient) {
      this._redisClient.publish(`ark:${type}`, JSON.stringify(message)).catch(() => {});
    }

    // 本地分发
    this._batchBuffer.push(message);
    if (!this._batchTimer) {
      this._batchTimer = setTimeout(() => this._flushBatch(), this.batchInterval);
    }
  }

  _dispatchLocal(type, payload, message) {
    const subs = this.subscriptions.get(type);
    if (!subs || subs.size === 0) return;
    subs.forEach(cb => {
      try { cb(payload, message); this.stats.delivered++; }
      catch (e) { this.log(`订阅回调错误 [${type}]: ${e.message}`); }
    });
  }

  subscribe(type, callback) {
    if (!this.subscriptions.has(type)) this.subscriptions.set(type, new Set());
    this.subscriptions.get(type).add(callback);

    // v113.14: Redis 订阅
    if (this._redisReady && this._redisSub) {
      this._redisSub.subscribe(`ark:${type}`).catch(() => {});
    }

    return () => this.subscriptions.get(type)?.delete(callback);
  }

  _flushBatch() {
    this._batchTimer = null;
    const batch = this._batchBuffer.splice(0);
    if (batch.length === 0) return;
    this.stats.batches++;
    batch.forEach(msg => this._dispatchLocal(msg.type, msg.payload, msg));
  }

  _dropLowestPriority(type) {
    const queue = this.queues[type];
    if (!queue || queue.length === 0) return null;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].priority >= PRIORITY.NORMAL) return queue.splice(i, 1)[0];
    }
    return null;
  }

  _cleanup() {
    const now = Date.now();
    let expiredTotal = 0;
    Object.values(this.queues).forEach(queue => {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].expiresAt < now && queue[i].priority >= PRIORITY.NORMAL) {
          queue.splice(i, 1); expiredTotal++;
        }
      }
    });
    if (expiredTotal > 0) this.stats.expired += expiredTotal;
  }

  getStats() {
    const queueSizes = {};
    Object.entries(this.queues).forEach(([type, queue]) => { queueSizes[type] = queue.length; });
    return {
      ...this.stats, subscriptions: this.subscriptions.size, queueSizes,
      redisMode: this._redisReady, workerId: process.env.WORKER_ID || 'master',
    };
  }

  healthCheck() {
    const stats = this.getStats();
    return {
      healthy: true, queueTotal: Object.values(stats.queueSizes).reduce((a, b) => a + b, 0),
      dropRate: stats.published > 0 ? (stats.dropped / stats.published * 100).toFixed(2) + '%' : '0%',
      redisMode: this._redisReady, workerId: process.env.WORKER_ID || 'master',
    };
  }

  async shutdown() {
    if (this._batchTimer) clearTimeout(this._batchTimer);
    if (this._cleanupInterval) clearInterval(this._cleanupInterval);
    this._flushBatch();
    if (this._redisClient) await this._redisClient.quit().catch(() => {});
    if (this._redisSub) await this._redisSub.quit().catch(() => {});
    this.removeAllListeners();
    this.log('MessageBus 已关闭');
  }
}

module.exports = MessageBus;
