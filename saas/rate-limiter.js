/**
 * RateLimiter — Binance API 智能限速队列
 * 
 * v113.13.6: 分层限速 — 管理员和普通用户独立 limiter
 *   - adminLimiter: 管理员引擎（行情扫描/子引擎K线）— 600权重/min
 *   - userLimiter: 普通用户交易（余额/持仓/下单）— 900权重/min
 *   - 共享 IP 级别封禁状态（Binance 按 IP 封禁，不按 Key）
 *   - 总和 1500 < Binance 2400 限制，留 38% 安全余量
 * 
 * 用法:
 *   const { adminLimiter, userLimiter } = require('./rate-limiter');
 *   await adminLimiter.acquire(1);  // 管理员引擎请求
 *   await userLimiter.acquire(5);   // 用户交易请求
 *   
 *   // 包裹请求
 *   const result = await adminLimiter.schedule(1, () => binance.get(...));
 */

// ═══════════════════════════════════
// 共享 IP 级别状态 — 所有 limiter 共用
// ═══════════════════════════════════
const _sharedState = {
  _banned: false,
  _bannedUntil: 0,
  _banCount: 0,
  _bannedInfo: null,
  _totalWindow: [],  // 所有 limiter 的合并权重窗口（用于 IP 级别总量检查）
};

class RateLimiter {
  constructor(opts = {}) {
    // Binance 限速
    this.maxWeightPerMin = opts.maxWeightPerMin || 1200;
    this.warnThreshold = opts.warnThreshold || 0.8;
    this._minInterval = opts.minInterval || 200;
    this._name = opts.name || 'default'; // v113.13.6: 识别用
    this._shared = opts.sharedState || _sharedState; // v113.13.6: 共享 IP 状态

    // 请求最小间隔
    this._lastRequestTime = 0;

    // 权重消耗表
    this.weightMap = {
      'GET /fapi/v1/ticker/price': 1,
      'GET /fapi/v1/ticker/24hr': 2,
      'GET /fapi/v2/account': 5,
      'GET /fapi/v2/positionRisk': 5,
      'GET /fapi/v1/klines': 1,
      'GET /fapi/v1/depth': 2,
      'POST /fapi/v1/order': 0,
      'GET /fapi/v1/exchangeInfo': 20,
    };

    // 滑动窗口跟踪（本实例独立）
    this._window = [];
    this._queue = [];
    this._processing = false;

    // 统计
    this.stats = {
      totalRequests: 0,
      totalWeight: 0,
      queueMax: 0,
      rejected: 0,
    };

    // 定时清理旧记录
    this._cleanupTimer = setInterval(() => this._cleanup(), 10000);
  }

  // v113.13.6: 兼容旧代码的属性代理 — 指向 sharedState
  get _banned() { return this._shared._banned; }
  set _banned(v) { this._shared._banned = v; }
  get _bannedUntil() { return this._shared._bannedUntil; }
  set _bannedUntil(v) { this._shared._bannedUntil = v; }
  get _banCount() { return this._shared._banCount; }
  set _banCount(v) { this._shared._banCount = v; }
  get _bannedInfo() { return this._shared._bannedInfo; }
  set _bannedInfo(v) { this._shared._bannedInfo = v; }

  /**
   * 获取本实例当前权重消耗
   */
  _currentWeight() {
    const now = Date.now();
    const oneMinAgo = now - 60000;
    return this._window
      .filter(w => w.time > oneMinAgo)
      .reduce((sum, w) => sum + w.weight, 0);
  }

  /**
   * v113.13.6: 获取 IP 级别总权重（所有 limiter 合计）
   */
  _totalCurrentWeight() {
    const now = Date.now();
    const oneMinAgo = now - 60000;
    return this._shared._totalWindow
      .filter(w => w.time > oneMinAgo)
      .reduce((sum, w) => sum + w.weight, 0);
  }

  /**
   * IP 级别总权重上限（Binance 限制 2400，我们用 1500）
   */
  get _totalMaxWeight() { return 1500; }

  /**
   * 计算需要等待的时间 (ms) — 基于本实例限制
   */
  _waitTime(weight) {
    const current = this._currentWeight();
    if (current + weight <= this.maxWeightPerMin) {
      // 本实例没超，但检查 IP 总量
      const totalCurrent = this._totalCurrentWeight();
      if (totalCurrent + weight <= this._totalMaxWeight) return 0;
      // IP 总量超了 — 等最早的记录过期
      return this._waitTotal(weight);
    }
    
    // 本实例超了 — 等旧记录过期
    const needed = current + weight - this.maxWeightPerMin;
    const sorted = [...this._window]
      .filter(w => w.time > Date.now() - 60000)
      .sort((a, b) => a.time - b.time);
    
    let freed = 0;
    for (const w of sorted) {
      freed += w.weight;
      if (freed >= needed) {
        return w.time - Date.now() + 60000 + 100;
      }
    }
    return 60000;
  }

  /**
   * v113.13.6: IP 总量等待
   */
  _waitTotal(weight) {
    const needed = this._totalCurrentWeight() + weight - this._totalMaxWeight;
    const sorted = [...this._shared._totalWindow]
      .filter(w => w.time > Date.now() - 60000)
      .sort((a, b) => a.time - b.time);
    
    let freed = 0;
    for (const w of sorted) {
      freed += w.weight;
      if (freed >= needed) {
        return w.time - Date.now() + 60000 + 100;
      }
    }
    return 60000;
  }

  /**
   * 请求消耗权重
   */
  async acquire(weight = 1) {
    // v113.13.4: 封禁状态清除 — 过期了也要清
    if (this._banned && Date.now() >= this._bannedUntil) {
      this._banned = false;
      this._bannedInfo = null;
      console.log(`[RateLimiter:${this._name}] ✅ IP封禁已过期，清除熔断状态`);
    }
    // v113.11.2: 持久化封禁状态 — 让AutoFixer能检测到
    if (this._banned && Date.now() < this._bannedUntil) {
      const wait = this._bannedUntil - Date.now();
      this._bannedInfo = { banned: true, until: this._bannedUntil, waitSec: Math.ceil(wait/1000) };
      console.log(`[RateLimiter:${this._name}] 🚫 IP封禁中，等待 ${(wait/1000).toFixed(0)}s 解封`);
      await new Promise(r => setTimeout(r, wait + 1000));
      this._banned = false;
      this._bannedInfo = null;
    }
    
    // 请求间隔
    const sinceLast = Date.now() - this._lastRequestTime;
    if (sinceLast < this._minInterval) {
      await new Promise(r => setTimeout(r, this._minInterval - sinceLast));
    }
    this._lastRequestTime = Date.now();
    
    const wait = this._waitTime(weight);
    
    // 记录统计
    this.stats.totalRequests++;
    this.stats.totalWeight += weight;
    
    // 警告
    const current = this._currentWeight();
    const rate = current / this.maxWeightPerMin;
    if (rate > this.warnThreshold) {
      console.warn(`[RateLimiter:${this._name}] ⚠️ 权重 ${current}/${this.maxWeightPerMin} (${(rate*100).toFixed(0)}%)，队列${this._queue.length}个等待`);
    }
    // v113.13.5: 90%权重时主动冷静 10秒
    if (rate > 0.9 && !this._coolingDown) {
      this._coolingDown = true;
      console.warn(`[RateLimiter:${this._name}] 🧊 权重超90%，主动冷静 10s`);
      await new Promise(r => setTimeout(r, 10000));
      this._coolingDown = false;
    }

    // v113.13.6: IP 总量检查
    const totalCurrent = this._totalCurrentWeight();
    const totalRate = totalCurrent / this._totalMaxWeight;
    if (totalRate > 0.9 && !this._coolingDown) {
      this._coolingDown = true;
      console.warn(`[RateLimiter:${this._name}] 🧊 IP总权重 ${totalCurrent}/${this._totalMaxWeight} (${(totalRate*100).toFixed(0)}%)，冷静 10s`);
      await new Promise(r => setTimeout(r, 10000));
      this._coolingDown = false;
    }
    
    if (wait > 0) {
      console.log(`[RateLimiter:${this._name}] 等待 ${(wait/1000).toFixed(1)}s (本实例${current}/${this.maxWeightPerMin}, IP总${totalCurrent}/${this._totalMaxWeight})`);
      await new Promise(r => setTimeout(r, wait));
    }
    
    // 记录到本实例窗口 + 共享总窗口
    const now = Date.now();
    this._window.push({ weight, time: now });
    this._shared._totalWindow.push({ weight, time: now, source: this._name });
  }

  /**
   * 包裹请求，自动限速 + 重试 + 熔断
   */
  async schedule(weight, fn, opts = {}) {
    const maxRetries = opts.maxRetries || 3;
    const retryDelay = opts.retryDelay || 1000;
    
    for (let i = 0; i <= maxRetries; i++) {
      await this.acquire(weight);
      
      try {
        const result = await fn();
        return result;
      } catch (e) {
        const msg = e.message || '';
        // -1003 IP封禁 → 全局熔断（共享）
        if (msg.includes('-1003') || msg.includes('banned') || msg.includes('IP')) {
          this._banCount++;
          this._banned = true;
          this._bannedInfo = { banned: true, until: this._bannedUntil, waitSec: 0 };
          const match = msg.match(/banned until (\d+)/);
          if (match) {
            this._bannedUntil = parseInt(match[1]);
          } else {
            this._bannedUntil = Date.now() + 120000;
          }
          const waitMs = this._bannedUntil - Date.now();
          console.error(`[RateLimiter:${this._name}] 🚫 IP被封(-1003)，熔断 ${(waitMs/1000).toFixed(0)}s (第${this._banCount}次)`);
          if (i < maxRetries) {
            await new Promise(r => setTimeout(r, Math.max(waitMs + 2000, 5000)));
            this._banned = false;
            continue;
          }
          throw e;
        }
        // 429 = 超限
        if (msg.includes('429') || e.status === 429) {
          this.stats.rejected++;
          console.warn(`[RateLimiter:${this._name}] 429 限流，等待 ${(retryDelay * (i+1) / 1000).toFixed(0)}s 后重试 (${i+1}/${maxRetries})`);
          await new Promise(r => setTimeout(r, retryDelay * (i + 1)));
          continue;
        }
        // 418 = IP 封禁
        if (msg.includes('418') || e.status === 418 || msg.includes('teapot')) {
          this._banCount++;
          this._banned = true;
          this._bannedUntil = Date.now() + 300000;
          this._bannedInfo = { banned: true, until: this._bannedUntil, waitSec: 300 };
          console.error(`[RateLimiter:${this._name}] 🚫 IP被封禁 418，全局熔断 300s (第${this._banCount}次)`);
          throw e;
        }
        throw e;
      }
    }
    
    throw new Error(`[RateLimiter:${this._name}] 请求失败，已重试 ${maxRetries} 次`);
  }

  /**
   * 查看状态
   */
  getStatus() {
    const current = this._currentWeight();
    const queueLen = this._queue.length;
    if (queueLen > this.stats.queueMax) this.stats.queueMax = queueLen;
    
    return {
      name: this._name,
      currentWeight: current,
      maxWeight: this.maxWeightPerMin,
      usagePercent: ((current / this.maxWeightPerMin) * 100).toFixed(1) + '%',
      queueLength: queueLen,
      totalRequests: this.stats.totalRequests,
      rejected: this.stats.rejected,
      ipBanned: this._banned,
      ipTotalWeight: this._totalCurrentWeight(),
      ipTotalMax: this._totalMaxWeight,
    };
  }

  /**
   * 清理过期记录
   */
  _cleanup() {
    const oneMinAgo = Date.now() - 60000;
    this._window = this._window.filter(w => w.time > oneMinAgo);
    // 也清理共享窗口
    this._shared._totalWindow = this._shared._totalWindow.filter(w => w.time > oneMinAgo);
  }

  destroy() {
    clearInterval(this._cleanupTimer);
  }
}

/**
 * 多 Key 池 — 多 API Key 轮换
 */
class ApiKeyPool {
  constructor(keys) {
    this.clients = keys.map((k, i) => ({
      id: i,
      apiKey: k.apiKey,
      apiSecret: k.apiSecret,
      limiter: new RateLimiter({ maxWeightPerMin: 1200, name: `pool-${i}` }),
    }));
    this.currentIndex = 0;
  }

  getBestClient() {
    if (this.clients.length === 0) throw new Error('No API keys configured');
    let best = this.clients[0];
    let bestUsage = best.limiter._currentWeight();
    for (const c of this.clients) {
      const usage = c.limiter._currentWeight();
      if (usage < bestUsage) { best = c; bestUsage = usage; }
    }
    return best;
  }

  getStats() {
    return this.clients.map(c => ({ id: c.id, usage: c.limiter.getStatus() }));
  }

  destroy() {
    this.clients.forEach(c => c.limiter.destroy());
  }
}

// ═══════════════════════════════════
// v113.13.6: 分层限速实例
//   adminLimiter: 管理员引擎（行情扫描/子引擎K线/主引擎）— 600权重/min
//   userLimiter:  普通用户交易（余额/持仓/下单）— 900权重/min
//   globalLimiter: 兼容旧代码，指向 adminLimiter
//   IP 总量上限: 1500/分钟（Binance 限制 2400）
// ═══════════════════════════════════
const _adminLimiter = new RateLimiter({ maxWeightPerMin: 600, minInterval: 300, name: 'admin' });
const _userLimiter = new RateLimiter({ maxWeightPerMin: 900, minInterval: 300, name: 'user' });

module.exports = { 
  RateLimiter, 
  ApiKeyPool, 
  adminLimiter: _adminLimiter,
  userLimiter: _userLimiter,
  globalLimiter: _adminLimiter, // 兼容旧代码：管理员引擎继续用 globalLimiter
};
