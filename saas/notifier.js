/**
 * Notification Center v1.0
 * 
 * 支持 Telegram + WeChat 通知推送
 * 交易信号、开仓平仓、止损止盈、每日报告、异常告警
 * 
 * 配置：
 *   TELEGRAM_BOT_TOKEN  - Telegram Bot API Token
 *   TELEGRAM_CHAT_ID    - 接收通知的 Chat ID
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

class NotificationCenter {
  constructor(config = {}) {
    this.telegram = {
      botToken: config.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || '',
      chatId: config.telegramChatId || process.env.TELEGRAM_CHAT_ID || '',
    };
    this.enabled = config.enabled !== false;
    
    // 通知冷却：同类型+同交易对 5 分钟内不重复
    this._cooldownMs = 5 * 60 * 1000;
    this._lastSent = new Map(); // key: type:symbol → timestamp
    
    // 失败重试队列
    this._retryQueue = [];
    this._maxRetries = 3;
    
    // 通知历史
    this._history = [];
    this._maxHistory = 500;
    
    // 加载历史
    this._loadHistory();
    
    // 启动重试循环（每 30 秒）
    this._retryTimer = setInterval(() => this._processRetryQueue(), 30000);
    
    console.log(`[Notifier] ✅ 通知中心已启动 | Telegram: ${this.telegram.botToken ? '✅' : '❌ 未配置'} | WeChat: 预留`);
  }
  
  // ═══════════════════════════════
  // 公开接口
  // ═══════════════════════════════
  
  /**
   * 开仓通知
   */
  notifyOpenPosition({ symbol, side, price, amount, strategy, confidence, reasons }) {
    const emoji = side === 'LONG' ? '🟢' : '🔴';
    const text = [
      `${emoji} 开仓信号`,
      `━━━━━━━━━━━━━`,
      `交易对: ${symbol}`,
      `方向: ${side === 'LONG' ? '做多 📈' : '做空 📉'}`,
      `价格: $${this._fmt(price)}`,
      `金额: $${this._fmt(amount)}`,
      `策略: ${strategy || 'N/A'}`,
      confidence != null ? `信心: ${(confidence * 100).toFixed(1)}%` : '',
      reasons?.length ? `理由: ${reasons.slice(0, 3).join(', ')}` : '',
      `时间: ${new Date().toISOString().slice(0, 19)}`,
    ].filter(Boolean).join('\n');
    
    return this._send('OPEN_POSITION', symbol, text);
  }
  
  /**
   * 平仓通知
   */
  notifyClosePosition({ symbol, side, entryPrice, exitPrice, pnl, pnlPercent, holdTime, reason }) {
    const profit = pnl >= 0;
    const emoji = profit ? '💰' : '💸';
    const text = [
      `${emoji} 平仓`,
      `━━━━━━━━━━━━━`,
      `交易对: ${symbol}`,
      `方向: ${side || 'N/A'}`,
      `开仓价: $${this._fmt(entryPrice)}`,
      `平仓价: $${this._fmt(exitPrice)}`,
      `P&L: ${profit ? '+' : ''}$${this._fmt(Math.abs(pnl))} (${profit ? '+' : ''}${(pnlPercent * 100).toFixed(2)}%)`,
      `持仓时间: ${this._fmtDuration(holdTime)}`,
      `原因: ${reason || '信号平仓'}`,
      `时间: ${new Date().toISOString().slice(0, 19)}`,
    ].join('\n');
    
    return this._send('CLOSE_POSITION', symbol, text);
  }
  
  /**
   * 止损触发
   */
  notifyStopLoss({ symbol, side, price, lossAmount, lossPercent }) {
    const text = [
      `🛑 止损触发`,
      `━━━━━━━━━━━━━`,
      `交易对: ${symbol}`,
      `方向: ${side || 'N/A'}`,
      `止损价: $${this._fmt(price)}`,
      `亏损: -$${this._fmt(lossAmount)} (${(lossPercent * 100).toFixed(2)}%)`,
      `时间: ${new Date().toISOString().slice(0, 19)}`,
    ].join('\n');
    
    return this._send('STOP_LOSS', symbol, text);
  }
  
  /**
   * 止盈触发
   */
  notifyTakeProfit({ symbol, side, price, profitAmount, profitPercent }) {
    const text = [
      `🎯 止盈触发`,
      `━━━━━━━━━━━━━`,
      `交易对: ${symbol}`,
      `方向: ${side || 'N/A'}`,
      `止盈价: $${this._fmt(price)}`,
      `盈利: +$${this._fmt(profitAmount)} (+${(profitPercent * 100).toFixed(2)}%)`,
      `时间: ${new Date().toISOString().slice(0, 19)}`,
    ].join('\n');
    
    return this._send('TAKE_PROFIT', symbol, text);
  }
  
  /**
   * 每日报告
   */
  notifyDailyReport({ balance, positions, dailyPnl, totalPnl, winRate, totalTrades, neuralNetStats }) {
    const profit = dailyPnl >= 0;
    const positionsText = positions?.length 
      ? positions.map(p => `  ${p.symbol}: ${p.side} ${p.pnl >= 0 ? '+' : ''}$${this._fmt(p.pnl)}`).join('\n')
      : '  无持仓';
    
    const text = [
      `📊 每日报告`,
      `━━━━━━━━━━━━━`,
      `总余额: $${this._fmt(balance)}`,
      `当日P&L: ${profit ? '+' : ''}$${this._fmt(Math.abs(dailyPnl))} (${profit ? '↑' : '↓'})`,
      `累计P&L: ${totalPnl >= 0 ? '+' : ''}$${this._fmt(Math.abs(totalPnl))}`,
      `胜率: ${(winRate * 100).toFixed(1)}% (${totalTrades} 笔)`,
      ``,
      `持仓:`,
      positionsText,
    ];
    
    if (neuralNetStats) {
      text.push('', `神经网络:`, 
        `  训练次数: ${neuralNetStats.trainCount || 0}`,
        `  准确率: ${((neuralNetStats.accuracy || 0) * 100).toFixed(1)}%`,
      );
    }
    
    text.push(`时间: ${new Date().toISOString().slice(0, 19)}`);
    
    return this._send('DAILY_REPORT', 'ALL', text.join('\n'));
  }
  
  /**
   * 异常告警
   */
  notifyAlert({ level, title, message }) {
    const emoji = level === 'CRITICAL' ? '🚨' : level === 'WARNING' ? '⚠️' : 'ℹ️';
    const text = [
      `${emoji} ${title}`,
      `━━━━━━━━━━━━━`,
      message,
      `等级: ${level}`,
      `时间: ${new Date().toISOString().slice(0, 19)}`,
    ].join('\n');
    
    return this._send('ALERT', title, text);
  }
  
  /**
   * 策略信号通知（不开仓，仅信号）
   */
  notifySignal({ symbol, signal, score, reasons }) {
    const emoji = signal === 'BUY' ? '🟢' : signal === 'SELL' ? '🔴' : '⚪';
    const text = [
      `${emoji} 策略信号`,
      `━━━━━━━━━━━━━`,
      `交易对: ${symbol}`,
      `信号: ${signal}`,
      `综合评分: ${score?.toFixed(2) || 'N/A'}`,
      reasons?.length ? `分析: ${reasons.slice(0, 3).join(', ')}` : '',
      `时间: ${new Date().toISOString().slice(0, 19)}`,
    ].filter(Boolean).join('\n');
    
    return this._send('SIGNAL', symbol, text);
  }
  
  // ═══════════════════════════════
  // 内部实现
  // ═══════════════════════════════
  
  async _send(type, symbol, text) {
    if (!this.enabled) return;
    
    // 冷却检查
    const cooldownKey = `${type}:${symbol}`;
    const lastSent = this._lastSent.get(cooldownKey);
    if (lastSent && Date.now() - lastSent < this._cooldownMs) {
      return; // 冷却中，跳过
    }
    
    this._lastSent.set(cooldownKey, Date.now());
    
    // 记录历史
    const record = { type, symbol, text, timestamp: Date.now() };
    this._history.push(record);
    if (this._history.length > this._maxHistory) this._history.shift();
    this._saveHistory();
    
    // 控制台输出
    console.log(`[Notifier] 📨 ${type} [${symbol}]`);
    
    // 发送 Telegram
    if (this.telegram.botToken && this.telegram.chatId) {
      const ok = await this._sendTelegram(text);
      if (!ok) {
        this._retryQueue.push({ type, symbol, text, retries: 0 });
        // v113.5: 防止无限增长
        if (this._retryQueue.length > 50) this._retryQueue.shift();
      }
    }
    
    // WeChat 预留（需要扫码登录，暂不实现）
    // this._sendWeChat(text);
  }
  
  async _sendTelegram(text) {
    return new Promise((resolve) => {
      if (!this.telegram.botToken || !this.telegram.chatId) {
        resolve(false);
        return;
      }
      
      const data = JSON.stringify({
        chat_id: this.telegram.chatId,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      
      const options = {
        hostname: 'api.telegram.org',
        path: `/bot${this.telegram.botToken}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 10000,
      };
      
      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(true);
          } else {
            console.error(`[Notifier] Telegram 发送失败: ${res.statusCode} ${body.slice(0, 200)}`);
            resolve(false);
          }
        });
      });
      
      req.on('error', (e) => {
        console.error(`[Notifier] Telegram 网络错误: ${e.message}`);
        resolve(false);
      });
      
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      
      req.write(data);
      req.end();
    });
  }
  
  async _processRetryQueue() {
    if (this._retryQueue.length === 0) return;
    
    const pending = [...this._retryQueue];
    this._retryQueue = [];
    
    for (const item of pending) {
      if (item.retries >= this._maxRetries) {
        console.error(`[Notifier] 重试 ${item.retries} 次仍失败，丢弃: ${item.type}:${item.symbol}`);
        continue;
      }
      
      const ok = await this._sendTelegram(item.text);
      if (!ok) {
        item.retries++;
        this._retryQueue.push(item);
      }
    }
  }
  
  // ═══════════════════════════════
  // 工具方法
  // ═══════════════════════════════
  
  _fmt(n) {
    if (n == null || isNaN(n)) return '0.00';
    if (Math.abs(n) < 0.01) return n.toPrecision(4);
    return n.toFixed(2);
  }
  
  _fmtDuration(ms) {
    if (!ms) return 'N/A';
    const sec = Math.floor(ms / 1000);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h${m}m`;
    if (m > 0) return `${m}m${s}s`;
    return `${s}s`;
  }
  
  _loadHistory() {
    try {
      const p = path.join(__dirname, '..', 'data', 'notifications.json');
      if (fs.existsSync(p)) {
        this._history = JSON.parse(fs.readFileSync(p, 'utf8'));
      }
    } catch (e) { /* ignore */ }
  }
  
  _saveHistory() {
    try {
      const p = path.join(__dirname, '..', 'data', 'notifications.json');
      fs.writeFileSync(p, JSON.stringify(this._history.slice(-this._maxHistory), null, 2));
    } catch (e) { /* ignore */ }
  }
  
  getHistory(limit = 50) {
    return this._history.slice(-limit);
  }
  
  destroy() {
    if (this._retryTimer) clearInterval(this._retryTimer);
  }
}

module.exports = NotificationCenter;
