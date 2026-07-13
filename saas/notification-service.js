/**
 * Multi-Market Notification Service v97 — 多市场交易通知服务
 * 
 * 支持渠道:
 * - Telegram (需要 Bot Token)
 * - 控制台日志 (始终启用)
 * - Dashboard WebSocket (前端实时推送)
 * 
 * 通知类型:
 * - 开仓/平仓通知
 * - 盈亏日报
 * - 风控警报
 * - 跨市场信号
 * - 系统状态
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

class NotificationService {
  constructor(config = {}) {
    this.telegramToken = config.telegramToken || process.env.TELEGRAM_BOT_TOKEN || '';
    this.telegramChatId = config.telegramChatId || process.env.TELEGRAM_CHAT_ID || '';
    this.enabled = true;
    this.messageQueue = [];
    this.maxQueueSize = 100;
    this.lastSentTime = {};
    this.minIntervalMs = 5000; // 同一类型消息至少间隔5秒

    this.logFile = path.join(__dirname, '..', 'logs', 'notifications.log');

    if (this.telegramToken) {
      console.log('[Notify] ✅ Telegram通知已启用');
    } else {
      console.log('[Notify] ⚠️ Telegram未配置 — 仅控制台日志');
    }
  }

  /**
   * 开仓通知
   */
  notifyOpen(market, symbol, direction, price, size, strategy, leverage) {
    const msg = `📈 开仓 ${market.toUpperCase()}\n` +
      `  币种: ${symbol}\n` +
      `  方向: ${direction} ${leverage}x\n` +
      `  价格: $${price}\n` +
      `  金额: $${size}\n` +
      `  策略: ${strategy}`;
    
    this._send('open', msg);
  }

  /**
   * 平仓通知
   */
  notifyClose(market, symbol, direction, entryPrice, exitPrice, pnl, pnlPct) {
    const emoji = pnl >= 0 ? '🟢' : '🔴';
    const msg = `${emoji} 平仓 ${market.toUpperCase()}\n` +
      `  币种: ${symbol}\n` +
      `  方向: ${direction}\n` +
      `  入场: $${entryPrice} → 出场: $${exitPrice}\n` +
      `  盈亏: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)} (${pnlPct.toFixed(2)}%)`;
    
    this._send('close', msg);
  }

  /**
   * 风控警报
   */
  notifyRiskAlert(level, message) {
    const emoji = level === 'CRITICAL' ? '🚨' : level === 'HIGH' ? '⚠️' : 'ℹ️';
    this._send('risk', `${emoji} 风控 [${level}]: ${message}`);
  }

  /**
   * 跨市场信号
   */
  notifyCrossMarketSignal(signalName, actions) {
    const msg = `⚡ 跨市场信号: ${signalName}\n` +
      actions.map(a => `  → ${a.market}: ${a.desc}`).join('\n');
    
    this._send('signal', msg);
  }

  /**
   * 日报
   */
  notifyDailyReport(data) {
    const msg = `📊 日报\n` +
      `  总资金: $${data.balance}\n` +
      `  日盈亏: ${data.dailyPnl >= 0 ? '+' : ''}$${data.dailyPnl}\n` +
      `  持仓数: ${data.positions}\n` +
      `  交易数: ${data.trades}\n` +
      `  风控状态: ${data.halted ? '🔴 已熔断' : '🟢 正常'}\n` +
      `  各市场:\n` +
      Object.entries(data.markets || {}).map(([m, v]) => `    ${m}: ${v}`).join('\n');
    
    this._send('daily', msg);
  }

  /**
   * 套利机会通知
   */
  notifyArbOpportunity(type, pair, profit, action) {
    const msg = `🔗 套利机会: ${type}\n` +
      `  配对: ${pair}\n` +
      `  预期利润: ${profit}\n` +
      `  动作: ${action}`;
    
    this._send('arb', msg);
  }

  /**
   * 系统状态
   */
  notifySystemStatus(status) {
    const engines = Object.entries(status.engines || {}).map(([name, ok]) => 
      `  ${ok ? '✅' : '❌'} ${name}`
    ).join('\n');
    
    const msg = `🤖 系统状态\n` +
      `  引擎: ${Object.values(status.engines).filter(Boolean).length}/${Object.keys(status.engines).length}\n` +
      engines;
    
    this._send('system', msg);
  }

  /**
   * 发送消息
   */
  _send(type, message) {
    // 控制台日志
    this._log(`[${type.toUpperCase()}] ${message}`);

    // 频率限制
    const now = Date.now();
    if (this.lastSentTime[type] && now - this.lastSentTime[type] < this.minIntervalMs) {
      this.messageQueue.push({ type, message, time: now });
      return;
    }

    // Telegram
    if (this.telegramToken && this.telegramChatId) {
      this._sendTelegram(message);
      this.lastSentTime[type] = now;
    }
  }

  /**
   * 发送Telegram消息
   */
  _sendTelegram(text) {
    try {
      const url = `https://api.telegram.org/bot${this.telegramToken}/sendMessage`;
      const data = JSON.stringify({
        chat_id: this.telegramChatId,
        text: text.slice(0, 4000), // Telegram限制
        parse_mode: 'HTML',
      });

      const req = https.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const r = JSON.parse(body);
            if (!r.ok) this._log(`[Telegram] 发送失败: ${r.description}`);
          } catch (e) {}
        });
      });
      req.on('error', (e) => this._log(`[Telegram] 错误: ${e.message}`));
      req.write(data);
      req.end();
    } catch (e) {
      this._log(`[Telegram] 发送异常: ${e.message}`);
    }
  }

  /**
   * 处理消息队列
   */
  processQueue() {
    const now = Date.now();
    const toSend = this.messageQueue.filter(msg => now - (this.lastSentTime[msg.type] || 0) >= this.minIntervalMs);
    
    for (const msg of toSend) {
      if (this.telegramToken && this.telegramChatId) {
        this._sendTelegram(msg.message);
        this.lastSentTime[msg.type] = now;
      }
    }

    this.messageQueue = this.messageQueue.filter(msg => now - (this.lastSentTime[msg.type] || 0) < this.minIntervalMs);
  }

  _log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    try {
      const dir = path.dirname(this.logFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.logFile, line + '\n');
    } catch (e) {}
  }
}

module.exports = NotificationService;
