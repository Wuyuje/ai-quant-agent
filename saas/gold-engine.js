/**
 * Gold Engine v1 — 黄金现货独立交易引擎
 * 
 * 完全独立于Crypto合约引擎，不修改任何现有策略
 * 
 * 交易标的: PAXGUSDT (PAX Gold, 1:1黄金锚定代币)
 * 交易方式: Binance现货(Spot)
 * 
 * 架构:
 * - GoldStrategyManager — 4策略融合（动量+均值回归+宏观因子+波动率）
 * - GoldTrader — Binance现货执行
 * - ATR动态止损止盈
 * - 30秒主循环
 * 
 * 安全:
 * - 现货交易无杠杆无爆仓
 * - 用户资金在自己Binance账户
 * - 最大仓位30%限制
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { GoldStrategyManager } = require('./strategies/gold-strategy-manager');
const { GoldTrader } = require('./gold-trader');

// API Key 解密（与 cex-user-trader.js 一致）
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || process.env.ENCRYPT_KEY;
function decrypt(encryptedText) {
  if (!encryptedText || !encryptedText.includes(':')) return encryptedText; // 未加密，原样返回
  try {
    const key = Buffer.from(ENCRYPTION_KEY, 'hex');
    const [ivHex, tagHex, encrypted] = encryptedText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    return encryptedText; // fallback：可能未加密
  }
}

const STATE_FILE = path.join(__dirname, '..', 'data', 'gold_state.json');
const USERS_FILE = path.join(__dirname, '..', 'data', 'saas-users.json');

class GoldEngine {
  constructor() {
    this.running = false;
    this.paused = false;
    this.cycleCount = 0;
    this.strategyManager = new GoldStrategyManager();
    this.trader = new GoldTrader();

    // 状态
    this.currentPrice = 0;
    this.positions = {}; // { address: { qty, entryPrice, entryTime, stopLoss, takeProfit, peakPnlPct } }
    this.tradeLog = [];
    this.totalPnl = 0;
    this.totalTrades = 0;
    this.wins = 0;
    this.losses = 0;
    this.dailyPnl = 0;
    this.dailyPnlResetTime = this._startOfDay();

    // K线缓存
    this.klines = [];
    this.lastKlineFetch = 0;
    this.klineInterval = 60000; // 1分钟刷新

    // 每用户状态文件
    this.userStates = {};

    // ═══ 服务费配置（与 cex-user-trader 一致）═══
    this.PLATFORM_FEE_RATE = 0.20;   // 20% 平台服务费
    this.ECO_FEE_RATE = 0.10;        // 10% 生态基金
    this.PLATFORM_WALLET = '0xb6DEb31484353AdDaA5b6A105A2B758Df11bC28A';
    this.ECO_WALLET = '0xeF87e7fD5f0ADC5de82e84Dc9300002D9aC8bD82';
    this.FEE_STATE_FILE = path.join(__dirname, '..', 'data', 'gold-fee-state.json');
    this._feeState = { collected: [], totalPlatformFee: 0, totalEcoFund: 0 };

    this._log('Gold Engine v1 initialized — PAXGUSDT Spot Trading');
  }

  _log(msg) { console.log(`[Gold] ${msg}`); }
  _startOfDay() { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.getTime(); }

  /**
   * 加载状态
   */
  _loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        this.positions = data.positions || {};
        this.totalPnl = data.totalPnl || 0;
        this.totalTrades = data.totalTrades || 0;
        this.wins = data.wins || 0;
        this.losses = data.losses || 0;
        this._log(`Loaded state: ${Object.keys(this.positions).length} positions, PnL=$${this.totalPnl.toFixed(2)}`);
      }
    } catch (e) {
      this._log(`State load error: ${e.message}`);
    }
  }

  _saveState() {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        positions: this.positions,
        totalPnl: this.totalPnl,
        totalTrades: this.totalTrades,
        wins: this.wins,
        losses: this.losses,
        lastUpdate: Date.now(),
      }, null, 2));
    } catch (e) {}
  }

  /**
   * 加载用户数据库
   */
  _loadUsers() {
    try {
      if (fs.existsSync(USERS_FILE)) {
        return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      }
    } catch (e) {}
    return {};
  }

  /**
   * 启动引擎
   */
  async start() {
    this._log('Starting Gold Engine...');
    this.running = true;
    this._loadState();

    // 初始K线
    await this._refreshKlines();
    this._log(`K lines loaded: ${this.klines.length}`);

    // 初始价格
    this.currentPrice = await this.trader.getPrice();
    this._log(`PAXG current price: $${this.currentPrice}`);

    this._mainLoop();
  }

  stop() { this.running = false; }

  /**
   * 主循环 — 30秒一轮
   */
  async _mainLoop() {
    while (this.running) {
      try {
        this.cycleCount++;

        if (this.paused) {
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        this._checkDailyPnlReset();

        // 刷新K线
        await this._refreshKlines();

        // 刷新价格
        this.currentPrice = await this.trader.getPrice();

        if (!this.currentPrice || this.currentPrice <= 0) {
          this._log('⚠️ 无法获取价格');
          await new Promise(r => setTimeout(r, 10000));
          continue;
        }

        // 管理持仓（止损止盈）
        await this._managePositions();

        // 扫描开仓信号
        await this._scanAndOpen();

        // 保存状态
        this._saveState();

        if (this.cycleCount % 10 === 0) {
          this._log(`📊 Cycle #${this.cycleCount} price=$${this.currentPrice.toFixed(2)} positions=${Object.keys(this.positions).length} PnL=$${this.totalPnl.toFixed(2)}`);
        }

      } catch (e) {
        this._log(`❌ Error: ${e.message}`);
      }

      await new Promise(r => setTimeout(r, 30000));
    }
  }

  /**
   * 刷新K线
   */
  async _refreshKlines() {
    if (Date.now() - this.lastKlineFetch < this.klineInterval && this.klines.length > 50) return;

    try {
      this.klines = await this.trader.getKlines('1h', 200);
      this.lastKlineFetch = Date.now();
    } catch (e) {
      this._log(`K line refresh error: ${e.message}`);
    }
  }

  /**
   * 管理持仓 — ATR动态止损止盈
   */
  async _managePositions() {
    const entries = Object.entries(this.positions);
    if (entries.length === 0) return;

    for (const [userAddr, pos] of entries) {
      try {
        const price = this.currentPrice;
        if (!price || !pos.entryPrice) continue;

        // 计算PnL
        const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;

        // 更新峰值
        if (pos._peakPnlPct === undefined) pos._peakPnlPct = pnlPct;
        if (pnlPct > pos._peakPnlPct) pos._peakPnlPct = pnlPct;

        const holdMinutes = (Date.now() - (pos.entryTime || Date.now())) / 60000;

        // ── 止损检查（v826: 4层保护）──

        // 1. 价格止损（原始 SL）
        if (pos.stopLoss && price <= pos.stopLoss) {
          await this._executeClose(userAddr, '🔴 止损触发', pnlPct);
          continue;
        }

        // 2. v826: 百分比硬止损 — PnL < -2% 直接平仓
        if (pnlPct < -2) {
          await this._executeClose(userAddr, `🔴 百分比止损 PnL=${pnlPct.toFixed(2)}% < -2%`, pnlPct);
          continue;
        }

        // 3. v826: 盈利保护 — 曾盈利 >1% 后回落到 0% 以下，保本出
        if (pos._peakPnlPct > 1 && pnlPct < 0) {
          await this._executeClose(userAddr, `🟡 盈利保本 peak=${pos._peakPnlPct.toFixed(2)}% → ${pnlPct.toFixed(2)}%`, pnlPct);
          continue;
        }

        // ── 止盈检查 ──

        // 4. 止盈（原始 TP）
        if (pos.takeProfit && price >= pos.takeProfit) {
          await this._executeClose(userAddr, '🟢 止盈触发', pnlPct);
          continue;
        }

        // 5. 回撤止盈（收紧: 峰值1.2x回撤就出）
        const trailingPct = pos.atrPct ? pos.atrPct * 1.2 : 1.5;
        if (pos._peakPnlPct > trailingPct * 1.2 && pnlPct < pos._peakPnlPct - trailingPct) {
          await this._executeClose(userAddr, `🟢 回撤止盈 peak=${pos._peakPnlPct.toFixed(2)}% now=${pnlPct.toFixed(2)}%`, pnlPct);
          continue;
        }

        // 6. 超时平仓（12小时，从24h缩短）
        if (holdMinutes > 720) {
          await this._executeClose(userAddr, `⏰ 超时平仓 ${holdMinutes.toFixed(0)}min PnL=${pnlPct.toFixed(2)}%`, pnlPct);
          continue;
        }

        this._log(`💎 ${userAddr.substring(0, 8)}... PAXG PnL=${pnlPct.toFixed(2)}% peak=${(pos._peakPnlPct || 0).toFixed(2)}% hold=${holdMinutes.toFixed(0)}min`);

      } catch (e) {
        this._log(`⚠️ Position management error: ${e.message}`);
      }
    }
  }

  /**
   * 扫描开仓
   */
  async _scanAndOpen() {
    if (!this.klines || this.klines.length < 60) return;

    // 策略分析
    const analysis = await this.strategyManager.analyze({
      klines: this.klines,
      currentPrice: this.currentPrice,
      symbol: 'PAXGUSDT',
    });

    const signal = analysis.finalSignal;
    this._log(`📊 Signal: ${signal.action} ${signal.strength} conf=${signal.confidence.toFixed(2)} score=${signal.score.toFixed(4)}`);

    if (!signal || signal.action === 'HOLD') {
      this._log(`⚪ HOLD — 等待信号`);
      return;
    }

    // v81b: 接受 strong / moderate / weak（小资金也要有机会交易）
    if (signal.strength !== 'strong' && signal.strength !== 'moderate' && signal.strength !== 'weak') {
      this._log(`⚪ 信号不够 strength=${signal.strength}`);
      return;
    }

    // 计算ATR
    const atr = this._calculateATR(this.klines, 14);
    const atrPct = atr / this.currentPrice;

    // 为所有有CEX API Key的用户执行
    const users = this._loadUsers();
    const entries = Object.entries(users);

    for (const [addr, user] of entries) {
      if (!user.binanceApiKey || !user.binanceSecret) continue;
      if (this.positions[addr]) continue; // 已有仓位

      try {
        // 解密API Key（AES-256-GCM 加密存储）
        let apiKey = decrypt(user.binanceApiKey);
        let apiSecret = decrypt(user.binanceSecret);

        // 获取余额
        const balance = await this.trader.getBalance(apiKey, apiSecret);
        if (balance.totalUSDT < 9) {
          this._log(`⏭️ ${addr.substring(0, 8)}... 余额不足 $${balance.totalUSDT.toFixed(2)} (<$9, PAXG min 0.002≈$8.34)`);
          continue;
        }
        this._log(`💰 ${addr.substring(0, 8)}... USDT=$${balance.usdt.toFixed(2)} PAXG=${balance.paxg} Total=$${balance.totalUSDT.toFixed(2)}`);

        // 计算仓位
        const posSize = this.trader.calculatePositionSize(
          balance.totalUSDT, signal, atrPct, this.currentPrice
        );

        if (posSize.notional < this.trader.minNotional) {
          this._log(`⏭️ ${addr.substring(0, 8)}... 仓位太小 $${posSize.notional.toFixed(2)}`);
          continue;
        }

        // 买入
        this._log(`🎯 ${addr.substring(0, 8)}... BUY ${posSize.quantity.toFixed(3)} PAXG @ $${this.currentPrice.toFixed(2)} | ${posSize.reason}`);
        const order = await this.trader.buy(apiKey, apiSecret, posSize.quantity, this.currentPrice);

        if (order.success) {
          // 计算止损止盈
          const levels = this.trader.calculateStopTakeProfit(this.currentPrice, atr, 'BUY');

          this.positions[addr] = {
            qty: posSize.quantity,
            entryPrice: this.currentPrice,
            entryTime: Date.now(),
            stopLoss: levels.stopLoss,
            takeProfit: levels.takeProfit,
            atrPct: atrPct * 100,
            orderId: order.orderId,
            notional: posSize.notional,
          };

          this._saveState();
          this._log(`✅ ${addr.substring(0, 8)}... OPENED PAXG qty=${posSize.quantity.toFixed(3)} SL=$${levels.stopLoss.toFixed(2)} TP=$${levels.takeProfit.toFixed(2)}`);
        } else {
          this._log(`❌ ${addr.substring(0, 8)}... Order failed: ${order.error}`);
        }

      } catch (e) {
        this._log(`⚠️ ${addr.substring(0, 8)}... Error: ${e.message}`);
      }

      // 避免API限流
      await new Promise(r => setTimeout(r, 500));
    }
  }

  /**
   * 平仓
   */
  async _executeClose(userAddr, reason, pnlPct) {
    const pos = this.positions[userAddr];
    if (!pos) return;

    try {
      const users = this._loadUsers();
      const user = users[userAddr];

      if (!user || !user.binanceApiKey || !user.binanceSecret) {
        this._log(`⚠️ Cannot close ${userAddr.substring(0, 8)}... — no API key`);
        return;
      }

      // 卖出
      const order = await this.trader.sell(decrypt(user.binanceApiKey), decrypt(user.binanceSecret), pos.qty, this.currentPrice);

      if (order.success) {
        const pnl = pos.notional * (pnlPct / 100);
        this.totalPnl += pnl;
        this.totalTrades++;
        if (pnl > 0) this.wins++;
        else this.losses++;
        this.dailyPnl += pnl;

        // 记录交易
        this.tradeLog.push({
          user: userAddr.substring(0, 10),
          action: 'SELL',
          price: this.currentPrice,
          qty: pos.qty,
          pnl,
          pnlPct,
          reason,
          time: Date.now(),
        });

        this.strategyManager.recordTrade(pnl);

        this._log(`📤 ${userAddr.substring(0, 8)}... CLOSED PAXG ${reason} PnL=$${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%)`);

        // ═══ 盈利时自动扣除服务费并转账 ═══
        if (pnl > 0) {
          await this._collectAndTransferFee(userAddr, pos.notional, pnl);
        }

        delete this.positions[userAddr];
        this._saveState();
      } else {
        this._log(`❌ Close order failed: ${order.error}`);

        // 卖出失败 — 检查是否应该强制清除持仓（避免死循环）
        const failCount = pos._failCount || 0;
        pos._failCount = failCount + 1;

        if (failCount >= 3) {
          // 连续失败3次 → 清除本地持仓记录（链上仓位已不在或无法操作）
          this._log(`⚠️ 连续卖出失败${failCount + 1}次，清除本地持仓 ${userAddr.substring(0, 8)}`);
          delete this.positions[userAddr];
          this._saveState();
        } else {
          this._saveState(); // 保存_failCount
        }
      }

    } catch (e) {
      this._log(`❌ Close error: ${e.message}`);
    }
  }

  /**
   * 黄金盈利后自动扣除服务费并从用户币安现货钱包转出
   */
  async _collectAndTransferFee(userAddr, notional, pnl) {
    const platformFee = pnl * this.PLATFORM_FEE_RATE;  // 20%
    const ecoFund = pnl * this.ECO_FEE_RATE;           // 10%
    const totalFee = platformFee + ecoFund;

    this._log(`💰 Gold 服务费 ${userAddr.substring(0,8)} | 盈利 $${pnl.toFixed(2)}`
      + ` | 平台 $${platformFee.toFixed(2)} (20%)`
      + ` | 生态 $${ecoFund.toFixed(2)} (10%)`);

    if (totalFee < 1) {
      this._log(`⏭️ Gold 服务费 $${totalFee.toFixed(2)} < $1 最小转账额，跳过`);
      return;
    }

    try {
      const users = this._loadUsers();
      const user = users[userAddr];
      if (!user || !user.binanceApiKey || !user.binanceSecret) {
        this._log(`⚠️ Gold 无 API Key，跳过服务费转账`);
        return;
      }

      const apiKey = decrypt(user.binanceApiKey);
      const apiSecret = decrypt(user.binanceSecret);

      // 调用 GoldTrader 的转账方法
      if (this.trader.transferFeeToWallet) {
        // 平台费
        const pResult = await this.trader.transferFeeToWallet(apiKey, apiSecret, platformFee, this.PLATFORM_WALLET);
        if (pResult.success) this._log(`✅ Gold 平台费转账成功 $${platformFee.toFixed(2)}`);
        else this._log(`❌ Gold 平台费转账失败: ${pResult.error}`);

        // 生态基金
        const eResult = await this.trader.transferFeeToWallet(apiKey, apiSecret, ecoFund, this.ECO_WALLET);
        if (eResult.success) this._log(`✅ Gold 生态基金转账成功 $${ecoFund.toFixed(2)}`);
        else this._log(`❌ Gold 生态基金转账失败: ${eResult.error}`);
      } else {
        // GoldTrader 没有转账方法，用通用方法
        this._log(`⚠️ GoldTrader 无转账方法，仅记账`);
      }

      // 记录
      this._feeState.collected.push({
        user: userAddr.substring(0, 10),
        notional: notional.toFixed(2),
        pnl: pnl.toFixed(2),
        platformFee: platformFee.toFixed(2),
        ecoFund: ecoFund.toFixed(2),
        timestamp: Date.now(),
      });
      this._feeState.totalPlatformFee += platformFee;
      this._feeState.totalEcoFund += ecoFund;

      try {
        fs.writeFileSync(this.FEE_STATE_FILE, JSON.stringify(this._feeState, null, 2));
      } catch (e) { /* ignore */ }

    } catch (e) {
      this._log(`❌ Gold 服务费转账异常: ${e.message}`);
    }
  }

  _calculateATR(klines, period = 14) {
    if (!klines || klines.length < period + 1) return 0;
    const trs = [];
    for (let i = 1; i < klines.length; i++) {
      trs.push(Math.max(
        klines[i].high - klines[i].low,
        Math.abs(klines[i].high - klines[i - 1].close),
        Math.abs(klines[i].low - klines[i - 1].close)
      ));
    }
    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  }

  _checkDailyPnlReset() {
    const todayStart = this._startOfDay();
    if (todayStart > this.dailyPnlResetTime) {
      this.dailyPnl = 0;
      this.dailyPnlResetTime = todayStart;
    }
  }

  // ═══════════════════════════════════════════
  // Dashboard API 数据
  // ═══════════════════════════════════════════

  getStatus() {
    return {
      running: this.running,
      paused: this.paused,
      cycleCount: this.cycleCount,
      currentPrice: this.currentPrice,
      symbol: 'PAXGUSDT',
      positions: this.positions,
      positionCount: Object.keys(this.positions).length,
      totalPnl: this.totalPnl,
      totalTrades: this.totalTrades,
      wins: this.wins,
      losses: this.losses,
      winRate: this.totalTrades > 0 ? (this.wins / this.totalTrades * 100).toFixed(1) + '%' : 'N/A',
      dailyPnl: this.dailyPnl,
      recentTrades: this.tradeLog.slice(-20),
      strategyStats: this.strategyManager.getStats(),
      strategies: this.strategyManager.getAllSummaries(),
      timestamp: Date.now(),
    };
  }

  getUserGoldStatus(userAddress) {
    const pos = this.positions[userAddress];
    return {
      hasPosition: !!pos,
      position: pos || null,
      currentPrice: this.currentPrice,
      symbol: 'PAXGUSDT',
    };
  }

  togglePause() { this.paused = !this.paused; return this.paused; }
}

module.exports = GoldEngine;
