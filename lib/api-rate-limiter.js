/**
 * API限速保护器 — 防止Binance封IP
 * 
 * 策略:
 * 1. 全局请求计数器 — 每分钟不超过1200请求(留50%余量)
 * 2. 请求间隔 — 两个请求之间至少间隔50ms
 * 3. 错峰执行 — BB和趋势错开30秒扫描
 * 4. 选币限制 — 每轮最多拉10个币的K线(不是30个)
 * 5. 封禁检测 — 收到-1003自动暂停60分钟
 */

const fs = require('fs');
const path = require('path');

class APIRateLimiter {
  constructor() {
    this._requestCount = 0;
    this._windowStart = Date.now();
    this._maxPerMinute = 1200; // 每分钟最多1200请求(Binance限制2400)
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

// 全局单例
const globalLimiter = new APIRateLimiter();

module.exports = { APIRateLimiter, globalLimiter };
