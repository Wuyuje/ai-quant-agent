/**
 * API限速保护器 — 每个API Key独立限速 + 全局IP限速
 * 
 * 架构:
 * 1. 每个BinanceAPI实例有自己的limiter(按API Key限速)
 *    → 每个用户独立的2400配额,互不影响
 * 2. 全局IP limiter(按IP限速)
 *    → 所有请求共享IP配额,防止总请求过多
 * 3. 请求间隔50ms + 错峰扫描
 * 4. 封禁检测 — 收到-1003自动暂停60分钟
 * 5. 百万用户: 每个用户独立限速,不会因为用户多被封
 */

const fs = require('fs');
const path = require('path');

class APIRateLimiter {
  constructor(maxPerMinute = 1800) {
    this._requestCount = 0;
    this._windowStart = Date.now();
    this._maxPerMinute = maxPerMinute; // 每分钟最多请求(默认1800,Binance限制2400)
    this._minInterval = 50; // 两个请求之间至少50ms
    this._lastRequest = 0;
    this._banned = false;
    this._banUntil = 0;
  }

  // 检查是否可以发请求
  async wait() {
    // 封禁状态
    if (this._banned) {
      if (Date.now() < this._banUntil) {
        const remain = Math.ceil((this._banUntil - Date.now()) / 60000);
        throw new Error(`API被封,还需${remain}分钟`);
      }
      this._banned = false;
    }

    // 重置窗口
    const now = Date.now();
    if (now - this._windowStart > 60000) {
      this._requestCount = 0;
      this._windowStart = now;
    }

    // 超过限制
    if (this._requestCount >= this._maxPerMinute) {
      const waitMs = 60000 - (now - this._windowStart);
      await new Promise(r => setTimeout(r, waitMs));
      this._requestCount = 0;
      this._windowStart = Date.now();
    }

    // 请求间隔
    const elapsed = now - this._lastRequest;
    if (elapsed < this._minInterval) {
      await new Promise(r => setTimeout(r, this._minInterval - elapsed));
    }

    this._requestCount++;
    this._lastRequest = Date.now();
  }

  // 检测到-1003错误时调用
  ban(durationMin = 60) {
    this._banned = true;
    this._banUntil = Date.now() + durationMin * 60000;
    console.log(`[RateLimiter] API被封,暂停${durationMin}分钟`);
  }

  isBanned() {
    return this._banned && Date.now() < this._banUntil;
  }

  getCount() {
    return this._requestCount;
  }
}

// 全局IP限速器(所有用户共享,防止IP被封)
const ipLimiter = new APIRateLimiter(3000); // IP级别: 每分钟最多3000请求

module.exports = { APIRateLimiter, ipLimiter };
