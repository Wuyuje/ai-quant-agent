/**
 * UserEngine v3 — 单用户独立引擎（实盘交易版）
 *
 * 架构升级（v113.14）：
 *   - 每个用户用自己的 API Key 调 Binance（隔离 Key，共享 IP 限速）
 *   - 策略实例由 Worker 共享（不为每个用户创建 15 个策略）
 *   - 余额/持仓走共享缓存（5分钟 TTL）
 *   - 行情数据完全共享（DataBus WebSocket，0 API 消耗）
 *   - 持仓状态从 Binance 真实持仓同步
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const USER_DATA_DIR = path.join(__dirname, '..', 'data', 'users');
const BINANCE_FUTURES_BASE = 'https://fapi.binance.com';

class UserEngine extends EventEmitter {
  constructor(userId, config, sharedComponents) {
    super();
    this.userId = userId;
    this.config = config;
    this.log = (msg) => console.log(`[UserEngine:${userId.slice(0, 12)}] ${new Date().toISOString()} ${msg}`);

    this.messageBus = sharedComponents.messageBus;
    this.riskIsolator = sharedComponents.riskIsolator;
    this.subscriptionManager = sharedComponents.subscriptionManager;
    this.wsHub = sharedComponents.wsHub;
    this.dataBus = sharedComponents.dataBus || null;
    this.sharedStrategy = sharedComponents.sharedStrategy;
    this.sharedLimiter = sharedComponents.sharedLimiter;
    this.sharedExitManager = sharedComponents.sharedExitManager;
    this.sharedPositionSizer = sharedComponents.sharedPositionSizer;

    this.apiKey = config.binanceApiKey || '';
    this.apiSecret = config.binanceSecret || '';

    this.state = {
      running: false, paused: false, cycleCount: 0, startTime: null,
      lastSignal: null, lastDecision: null, pnl: 0, peakPnl: 0,
      tradesCount: 0, winCount: 0, lossCount: 0,
    };
    this.positions = {};
    this._balanceCache = null;
    this._balanceCacheTime = 0;
    this._positionCache = null;
    this._positionCacheTime = 0;
    this._CACHE_TTL = 5 * 60 * 1000;
    this._consecutiveLosses = 0;
    this._cooldownUntil = 0;

    this.userDataPath = path.join(USER_DATA_DIR, userId);
    this._ensureDataDir();
    this._loadState();
  }

  start() {
    if (this.state.running) return;
    this.state.running = true;
    this.state.startTime = Date.now();
    this.log(`引擎启动 — 策略: ${Object.keys(this.sharedStrategy?.strategies || {}).length} 个`);
    this._saveState();
  }

  stop() { this.state.running = false; this.state.paused = false; this._saveState(); }
  pause() { this.state.paused = true; }
  resume() { this.state.paused = false; }

  async executeCycle(marketData) {
    if (!this.state.running || this.state.paused) return null;
    if (!this.apiKey || !this.apiSecret) return null;

    const subscription = this.subscriptionManager.getSubscription(this.userId);
    if (!subscription || subscription.status !== 'active') return null;

    const balance = await this._getCachedBalance();
    const totalBalance = balance?.balance || 1000;
    const riskCheck = this.riskIsolator.updateAndCheck(this.userId, this.state.pnl, totalBalance);
    if (!riskCheck.allowed) {
      this.emit('risk:blocked', { userId: this.userId, reason: riskCheck.reason });
      return null;
    }

    this.state.cycleCount++;
    const realPositions = await this._getCachedPositions();
    this._syncPositions(realPositions);
    const exits = await this._checkAndClosePositions(balance);
    const signals = await this._collectSignals(marketData);
    const decision = this._makeDecision(signals, realPositions);

    let openResult = null;
    if (decision.action === 'open') {
      openResult = await this._executeOpen(decision, balance, realPositions);
    }

    if (this.wsHub && (decision.action !== 'hold' || exits.length > 0 || openResult)) {
      this.wsHub.pushPositions(this.userId, {
        positions: this.positions, decision, exits, openResult,
        pnl: this.state.pnl, balance: balance?.balance, timestamp: Date.now(),
      });
    }

    if (decision.action !== 'hold') {
      this.state.lastDecision = decision;
      this.emit('decision', { userId: this.userId, decision, signals: signals.summary });
    }

    this._saveState();
    return { decision, exits, openResult, signals: signals.summary };
  }

  async _request(method, endpoint, params = {}) {
    if (!this.apiKey || !this.apiSecret) throw new Error('No API Key');
    if (!this.sharedLimiter) throw new Error('No rate-limiter');

    return this.sharedLimiter.schedule(2, () => new Promise((resolve, reject) => {
      const allParams = { timestamp: Date.now(), recvWindow: 10000, ...params };
      const query = new URLSearchParams(allParams).toString();
      const signature = crypto.createHmac('sha256', this.apiSecret).update(query).digest('hex');
      const fullQuery = `${query}&signature=${signature}`;
      const url = new URL(`${BINANCE_FUTURES_BASE}${endpoint}?${fullQuery}`);
      const reqOpts = {
        method, hostname: url.hostname, path: url.pathname + url.search,
        headers: { 'X-MBX-APIKEY': this.apiKey }, timeout: 10000,
      };
      const req = https.request(reqOpts, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.code && parsed.code !== 200) reject(new Error(`Binance ${parsed.code}: ${parsed.msg}`));
            else resolve(parsed);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    }));
  }

  async _getCachedBalance() {
    const now = Date.now();
    if (this._balanceCache && now - this._balanceCacheTime < this._CACHE_TTL) return this._balanceCache;
    try {
      const data = await this._request('GET', '/fapi/v3/balance');
      const usdt = data.find(b => b.asset === 'USDT');
      if (usdt) {
        this._balanceCache = {
          balance: parseFloat(usdt.balance),
          available: parseFloat(usdt.availableBalance || usdt.balance),
          unrealizedPnl: parseFloat(usdt.crossUnPnl || 0),
        };
        this._balanceCacheTime = now;
      }
      return this._balanceCache;
    } catch (e) {
      if (e.message?.includes('Invalid API-key') || e.message?.includes('-2015')) {
        this.state.paused = true;
        this.log(`🚫 API Key 无效，暂停交易`);
      }
      return this._balanceCache;
    }
  }

  async _getCachedPositions() {
    const now = Date.now();
    if (this._positionCache && now - this._positionCacheTime < this._CACHE_TTL) return this._positionCache;
    try {
      const data = await this._request('GET', '/fapi/v3/positionRisk');
      this._positionCache = data
        .filter(p => parseFloat(p.positionAmt) !== 0)
        .map(p => ({
          symbol: p.symbol, side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
          qty: Math.abs(parseFloat(p.positionAmt)), entryPrice: parseFloat(p.entryPrice),
          markPrice: parseFloat(p.markPrice), pnl: parseFloat(p.unRealizedProfit),
          leverage: parseInt(p.leverage) || 3, timestamp: p.updateTime || Date.now(),
        }));
      this._positionCacheTime = now;
      return this._positionCache;
    } catch (e) { return this._positionCache || []; }
  }

  _syncPositions(realPositions) {
    const realSymbols = new Set(realPositions.map(p => p.symbol));
    for (const sym of Object.keys(this.positions)) {
      if (!realSymbols.has(sym)) delete this.positions[sym];
    }
    for (const rp of realPositions) {
      if (!this.positions[rp.symbol]) {
        this.positions[rp.symbol] = {
          side: rp.side, entryPrice: rp.entryPrice, qty: rp.qty,
          leverage: rp.leverage, openTime: rp.timestamp, _peakPnl: 0,
        };
      } else {
        this.positions[rp.symbol].markPrice = rp.markPrice;
        this.positions[rp.symbol].pnl = rp.pnl;
      }
    }
  }

  async _checkAndClosePositions(balance) {
    const exits = [];
    for (const [symbol, pos] of Object.entries(this.positions)) {
      const md = this.dataBus?.marketData?.[symbol];
      const currentPrice = md?.price || pos.markPrice;
      if (!currentPrice) continue;

      const openTime = pos.openTime || Date.now();
      const holdHours = (Date.now() - openTime) / 3600000;
      const leverage = pos.leverage || 3;
      const rawPnlPct = (pos.side === 'LONG'
        ? (currentPrice - pos.entryPrice) / pos.entryPrice
        : (pos.entryPrice - currentPrice) / pos.entryPrice);
      const netPnlPct = rawPnlPct * leverage - 0.001 * 2 - 0.0001 * Math.floor(holdHours / 8);

      let peakPnl = pos._peakPnl || 0;
      if (netPnlPct > peakPnl) peakPnl = netPnlPct;
      pos._peakPnl = peakPnl;

      let shouldClose = false;
      let reason = '';

      // v113.16: 每个用户独立的 AdaptiveExitManager — 不共享连亏状态
      if (!this._userExitManagers) this._userExitManagers = {};
      if (!this._userExitManagers[this.userId]) {
        const AdaptiveExitManager = require('../saas/adaptive-exit');
        this._userExitManagers[this.userId] = new AdaptiveExitManager();
      }
      const _userExit = this._userExitManagers[this.userId];

      // Brain 决策（共享策略逻辑，但不共享状态）
      if (this.sharedExitManager?.brain?.managePosition) {
        const klines = this.dataBus?.klines?.[symbol] || [];
        const brainDecision = this.sharedExitManager.brain.managePosition(symbol, {
          side: pos.side, entryPrice: pos.entryPrice, leverage,
          openTime, _peakPnlPct: peakPnl * 100,
        }, klines, this.dataBus?.indicators?.[symbol] || {});
        if (brainDecision?.action === 'CLOSE') {
          shouldClose = true; reason = brainDecision.reason || 'Brain平仓';
        }
      }

      // v113.16: AdaptiveExitManager 顶级策略止盈止损 — 用户独立实例
      if (!shouldClose) {
        const klines = this.dataBus?.klines?.[symbol] || [];
        const _atrPct = this._calcATRPct(klines, currentPrice) || 1.5;
        const _grossPnlPct = rawPnlPct * leverage * 100; // 百分比
        try {
          const _exitCalc = _userExit.calculate(symbol, {
            side: pos.side, entryPrice: pos.entryPrice, leverage,
            openTime, _peakPnlPct: peakPnl * 100,
          }, { price: currentPrice, atr: _atrPct * currentPrice / 100, atrPct: _atrPct, klines }, {});
          const _exitDecision = _userExit.shouldClose(symbol, {
            side: pos.side, entryPrice: pos.entryPrice, leverage, openTime, _peakPnlPct: peakPnl * 100,
          }, _grossPnlPct, _exitCalc);
          if (_exitDecision && _exitDecision.shouldClose) {
            shouldClose = true;
            reason = _exitDecision.reason;
          }
        } catch(e) {}
      }

      // 超时兜底
      if (!shouldClose && holdHours * 60 > 480 && netPnlPct < -0.015) {
        shouldClose = true; reason = `⏰超时止损 ${(netPnlPct * 100).toFixed(1)}%`;
      }
      if (!shouldClose && holdHours * 60 > 720) {
        shouldClose = true; reason = `⏰最大持仓时间 ${holdHours.toFixed(0)}h`;
      }

      if (!shouldClose && (Date.now() - openTime) > 15 * 60000) {
        const klines = this.dataBus?.klines?.[symbol] || [];
        if (klines.length >= 50 && this.sharedStrategy) {
          try {
            const result = await this.sharedStrategy.analyze({ klines, currentPrice, symbol });
            const signal = result.finalSignal;
            if (pos.side === 'LONG' && signal.action === 'SELL' && signal.confidence > 0.6) {
              shouldClose = true; reason = `策略反转平多 conf=${signal.confidence.toFixed(2)}`;
            } else if (pos.side === 'SHORT' && signal.action === 'BUY' && signal.confidence > 0.6) {
              shouldClose = true; reason = `策略反转平空 conf=${signal.confidence.toFixed(2)}`;
            }
          } catch (e) {}
        }
      }

      if (!shouldClose) continue;

      try {
        const closeSide = pos.side === 'LONG' ? 'SELL' : 'BUY';
        const positionSide = pos.side === 'LONG' ? 'LONG' : 'SHORT';
        await this._request('POST', '/fapi/v1/order', {
          symbol, side: closeSide, type: 'MARKET',
          quantity: pos.qty, positionSide, reduceOnly: 'true',
        });
        this.log(`📉 平仓 ${symbol} | ${reason} | PnL ${(netPnlPct * 100).toFixed(2)}% | ${holdHours.toFixed(1)}h`);
        this.state.tradesCount++;
        if (netPnlPct > 0) { this.state.winCount++; this._consecutiveLosses = 0; }
        else { this.state.lossCount++; this._consecutiveLosses++; }
        this.state.pnl += netPnlPct * (pos.qty * pos.entryPrice);
        // v113.16: 记录到用户独立 exitManager
        if (this._userExitManagers && this._userExitManagers[this.userId]) {
          this._userExitManagers[this.userId].recordResult(netPnlPct * 100);
        }
        exits.push({ symbol, side: pos.side, reason, pnl: netPnlPct, holdHours });
        delete this.positions[symbol];
        if (this._consecutiveLosses >= 3) {
          this._cooldownUntil = Date.now() + 5 * 60 * 1000; // v113.23: 1h→5min
          this.log(`🚨 连亏${this._consecutiveLosses}笔，熔断5min`);
        }
      } catch (e) {
        this.log(`❌ 平仓失败 ${symbol}: ${e.message}`);
        try {
          const closeSide2 = pos.side === 'LONG' ? 'SELL' : 'BUY';
          await this._request('POST', '/fapi/v1/order', {
            symbol, side: closeSide2, type: 'MARKET',
            quantity: pos.qty, reduceOnly: 'true',
          });
          delete this.positions[symbol];
        } catch (e2) {
          this.log(`${symbol} reduceOnly平仓也失败: ${e2.message}`);
        }
      }
    }
    if (exits.length > 0) this._positionCache = null;
    return exits;
  }

  async _collectSignals(marketData) {
    const signals = {};
    let totalWeight = 0;
    let weightedScore = 0;
    const reasons = [];
    const strategyManager = this.sharedStrategy;
    if (!strategyManager) return { signals, summary: { score: 0, direction: 'neutral', confidence: 0, signalCount: 0, reasons: [] } };

    const userData = {
      price: marketData.price, prices: marketData.prices, volumes: marketData.volumes,
      positions: this.positions, symbol: this.config.primaryPair || 'BTCUSDT',
      klines: this.dataBus?.klines?.[this.config.primaryPair || 'BTCUSDT'] || [],
      indicators: this.dataBus?.indicators?.[this.config.primaryPair || 'BTCUSDT'] || {},
      timestamp: Date.now(),
    };

    for (const [name, strategy] of Object.entries(strategyManager.strategies || {})) {
      if (!this.subscriptionManager.canUseStrategy(this.userId, name)) continue;
      if (strategyManager.enabled && !strategyManager.enabled[name]) continue;
      try {
        let result;
        if (strategy.analyze) result = await strategy.analyze(userData);
        else if (strategy.evaluate) result = await strategy.evaluate(userData);
        if (result && result.signal > 0) {
          const weight = strategyManager.weights?.[name] || 0.1;
          signals[name] = { ...result, weight };
          totalWeight += weight;
          weightedScore += result.signal * weight * (result.direction === 'long' ? 1 : -1);
          reasons.push(`[${name}] ${(result.signal * 100).toFixed(0)}% ${result.direction}`);
        }
      } catch (e) {}
    }

    const normalizedScore = totalWeight > 0 ? weightedScore / totalWeight : 0;
    return {
      signals,
      summary: {
        score: normalizedScore,
        direction: normalizedScore > 0.1 ? 'long' : normalizedScore < -0.1 ? 'short' : 'neutral',
        confidence: Math.abs(normalizedScore),
        signalCount: Object.keys(signals).length, reasons,
      },
    };
  }

  _makeDecision(signals, realPositions) {
    const { summary } = signals;
    if (summary.confidence < 0.3 || summary.direction === 'neutral')
      return { action: 'hold', reason: '信号不足', ...summary };
    if (Date.now() < this._cooldownUntil)
      return { action: 'hold', reason: '连亏熔断冷却中', ...summary };
    const hasPosition = realPositions.some(p => p.side === summary.direction.toUpperCase());
    if (hasPosition) return { action: 'hold', reason: '已有同方向仓位', ...summary };
    const hasOpposite = realPositions.some(p => p.side !== summary.direction.toUpperCase());
    if (hasOpposite) return { action: 'close_opposite', reason: '反向信号', ...summary };

    let positionPct, leverage;
    if (this.sharedPositionSizer) {
      // v113.25: 用 sharedPositionSizer 动态计算（与管理员一致）
      const sizing = this.sharedPositionSizer.size({
        balanceUsd: balance?.balance || 0,
        atrPct: 2, // 默认ATR
        currentPrice: 0,
        signalStrength: summary.confidence >= 0.8 ? 'strong' : summary.confidence >= 0.6 ? 'moderate' : 'weak',
        confidence: summary.confidence,
        posCount: realPositions.length,
        trendStrength: 0,
      });
      if (sizing.reject) return { action: 'hold', reason: `仓位拒绝: ${sizing.reason}`, ...summary };
      positionPct = sizing.details?.balancePct ? parseFloat(sizing.details.balancePct) / 100 : 0.15;
      leverage = sizing.leverage;
    } else {
      // 兼容回退
      if (summary.confidence >= 0.8) positionPct = this.config.maxPositionPct || 0.15;
      else if (summary.confidence >= 0.6) positionPct = (this.config.maxPositionPct || 0.15) * 0.7;
      else positionPct = (this.config.maxPositionPct || 0.15) * 0.5;
      leverage = this.config.leverage || 3;
    }

    return {
      action: 'open', side: summary.direction, positionPct, leverage,
      reason: `综合信号 ${(summary.confidence * 100).toFixed(0)}% → ${summary.direction} ${leverage}x`,
      ...summary,
    };
  }

  async _executeOpen(decision, balance, realPositions) {
    if (!balance || balance.balance < 10) return { success: false, reason: '余额不足' };
    // v113.62: 使用阶梯式动态仓位 — 按用户余额计算
    const _maxPos = this.sharedPositionSizer
      ? this.sharedPositionSizer._calcMaxPositions(balance.balance)
      : (this.config.maxPositions || 3);
    if (realPositions.length >= _maxPos) return { success: false, reason: '满仓' };

    const symbol = this.config.primaryPair || 'BTCUSDT';
    const positionUsdt = Math.min(
      decision.positionPct * balance.balance,
      balance.available * 0.4,
      (this.config.tradeAmount || 50) * 0.5,
    );
    if (positionUsdt < 5) return { success: false, reason: '仓位太小' };
    // v113.25: leverage 由 _makeDecision 的 sharedPositionSizer 动态计算
    const leverage = decision.leverage || this.config.leverage || 3;

    if (this.riskIsolator) {
      const riskCheck = this.riskIsolator.canOpenPosition(this.userId, positionUsdt, balance.balance);
      if (!riskCheck.allowed) return { success: false, reason: riskCheck.reason };
    }

    try {
      await this._request('POST', '/fapi/v1/leverage', { symbol, leverage }).catch(() => {});
      const side = decision.side === 'long' ? 'BUY' : 'SELL';
      const positionSide = decision.side === 'long' ? 'LONG' : 'SHORT';
      const result = await this._request('POST', '/fapi/v1/order', {
        symbol, side, type: 'MARKET', quantity: positionUsdt, positionSide,
      });
      if (result && result.avgPrice) {
        this.log(`📈 开仓 ${symbol} ${decision.side.toUpperCase()} | $${positionUsdt.toFixed(2)} × ${leverage}x`);
        this.positions[symbol] = {
          side: decision.side.toUpperCase(), entryPrice: parseFloat(result.avgPrice),
          qty: positionUsdt / parseFloat(result.avgPrice), leverage, openTime: Date.now(), _peakPnl: 0,
        };
        this._positionCache = null;
        this._balanceCache = null;
        this.state.tradesCount++;
        this.emit('trade', { userId: this.userId, symbol, side: decision.side, amount: positionUsdt });
        return { success: true, symbol, side: decision.side, amount: positionUsdt, price: parseFloat(result.avgPrice) };
      }
      return { success: false, reason: '下单无返回价格' };
    } catch (e) {
      const errMsg = String(e.message || e);
      this.log(`❌ 开仓失败 ${symbol}: ${errMsg.slice(0, 100)}`);
      return { success: false, reason: errMsg.slice(0, 100) };
    }
  }

  _ensureDataDir() {
    if (!fs.existsSync(this.userDataPath)) fs.mkdirSync(this.userDataPath, { recursive: true });
  }

  // v113.16: ATR百分比计算
  _calcATRPct(klines, currentPrice) {
    if (!klines || klines.length < 20) return 1.5;
    try {
      const recent = klines.slice(-20);
      const ranges = recent.map(k => (k.high - k.low) / (k.high || 1));
      const avgRange = ranges.reduce((s, r) => s + r, 0) / ranges.length;
      return avgRange * 100; // ATR as percentage
    } catch (e) { return 1.5; }
  }

  _saveState() {
    try {
      fs.writeFileSync(
        path.join(this.userDataPath, 'engine-state.json'),
        JSON.stringify({ ...this.state, positions: this.positions }, null, 2)
      );
    } catch (e) {}
  }

  _loadState() {
    try {
      const statePath = path.join(this.userDataPath, 'engine-state.json');
      if (fs.existsSync(statePath)) {
        const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        this.state = { ...this.state, ...saved, running: false, startTime: null };
        this.positions = saved.positions || {};
      }
    } catch (e) {}
  }

  getStatus() {
    return {
      userId: this.userId, running: this.state.running, paused: this.state.paused,
      cycleCount: this.state.cycleCount, pnl: this.state.pnl, peakPnl: this.state.peakPnl,
      tradesCount: this.state.tradesCount,
      winRate: this.state.tradesCount > 0
        ? ((this.state.winCount / this.state.tradesCount) * 100).toFixed(1) + '%' : 'N/A',
      positions: Object.keys(this.positions).length,
      strategies: Object.keys(this.sharedStrategy?.strategies || {}).length,
      lastDecision: this.state.lastDecision,
    };
  }
}

module.exports = UserEngine;
