/**
 * UserTrader v92 — 纯 CEX 模式
 *
 * 用户通过 Binance API Key 接入，平台代为执行交易
 * 链上合约已分离，后期新合约部署后可重新接入（见 backup/）
 *
 * 核心职责：
 *   1. 定时遍历 userDB 中 tradingEnabled=true 且有 cexApiKey 的用户
 *   2. 通过用户自己的 Binance API 查询余额和持仓
 *   3. 用多策略引擎做交易决策
 *   4. 通过 Binance Futures API 执行交易
 *   5. 记录交易日志
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// ═══════════════════════════════════
// CEX 交易成本常量
// ═══════════════════════════════════
const CEX_FEE_RATE = 0.0004;          // 0.04% 单边手续费
const CEX_SLIPPAGE = 0.0005;          // 0.05% 预估滑点
const MAX_POSITIONS_PER_USER = 3;     // 单用户最多持仓3个
const MIN_TRADE_USDT = 10;            // 最小交易金额
const MAX_SINGLE_TRADE_USDT = 10000;  // 单笔最大交易金额
const DUST_USDT = 5;                  // 残留阈值
const _userLocks = new Map();         // per-user 交易锁

const TRADE_LOG_FILE = path.join(__dirname, '..', 'data', 'user-trades.json');
const STATE_FILE = path.join(__dirname, '..', 'data', 'user-trader-state.json');

// v106.3: 解密工具（用户 API Key 是加密存储的）
const { decrypt: _decryptKey } = require('../core/crypto-utils');

// v50: 多策略引擎集成
const { StrategyManager } = require('./strategies/strategy-manager');

// ═══════════════════════════════════
// Binance API 客户端（为每个用户独立）
// ═══════════════════════════════════
class BinanceUserClient {
  constructor(apiKey, apiSecret) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = 'https://fapi.binance.com';
    this._exchangeInfoCache = null;
    this._exchangeInfoTime = 0;
  }

  _sign(params) {
    const qs = new URLSearchParams(params).toString();
    const signature = crypto.createHmac('sha256', this.apiSecret).update(qs).digest('hex');
    return qs + '&signature=' + signature;
  }

  async _request(method, endpoint, params = {}) {
    params.timestamp = Date.now();
    params.recvWindow = 10000;
    const signed = this._sign(params);
    const url = `${this.baseUrl}${endpoint}?${signed}`;
    return new Promise((resolve, reject) => {
      const req = https.request(url, {
        method,
        headers: { 'X-MBX-APIKEY': this.apiKey },
        timeout: 10000,
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.code && json.code !== 200) reject(new Error(JSON.stringify(json)));
            else resolve(json);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });
  }

  async getBalance() {
    const account = await this._request('GET', '/fapi/v2/account');
    const usdt = account.assets?.find(a => a.asset === 'USDT');
    return {
      total: parseFloat(usdt?.walletBalance || 0),
      available: parseFloat(usdt?.availableBalance || 0),
      pnl: parseFloat(usdt?.unrealizedProfit || 0),
    };
  }

  async getPositions() {
    const account = await this._request('GET', '/fapi/v2/account');
    const positions = (account.positions || []).filter(p => Math.abs(parseFloat(p.positionAmt || 0)) > 0);
    return positions.map(p => ({
      symbol: p.symbol,
      side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
      qty: Math.abs(parseFloat(p.positionAmt)),
      entryPrice: parseFloat(p.entryPrice),
      markPrice: parseFloat(p.markPrice || 0),
      pnl: parseFloat(p.unrealizedProfit || 0),
      leverage: parseInt(p.leverage || 1),
      notional: Math.abs(parseFloat(p.notional || 0)),
    }));
  }

  async getPosition(symbol) {
    const positions = await this.getPositions();
    return positions.find(p => p.symbol === symbol) || null;
  }

  async setupLeverage(symbol, leverage) {
    try {
      await this._request('POST', '/fapi/v1/leverage', { symbol, leverage });
    } catch (e) { /* 已设置则忽略 */ }
  }

  async getExchangeInfo(symbol) {
    const now = Date.now();
    if (this._exchangeInfoCache && now - this._exchangeInfoTime < 3600000) {
      return this._exchangeInfoCache[symbol];
    }
    try {
      const data = await this._request('GET', '/fapi/v1/exchangeInfo');
      const info = {};
      for (const s of (data.symbols || [])) {
        const minNotional = s.filters?.find(f => f.filterType === 'MIN_NOTIONAL');
        const lotSize = s.filters?.find(f => f.filterType === 'LOT_SIZE');
        info[s.symbol] = {
          minNotional: minNotional ? parseFloat(minNotional.notional || minNotional.minNotional || 5) : 5,
          minQty: lotSize ? parseFloat(lotSize.minQty) : 0.001,
          stepSize: lotSize ? lotSize.stepSize : null,
          qtyPrecision: s.baseAssetPrecision || 3,
        };
      }
      this._exchangeInfoCache = info;
      this._exchangeInfoTime = now;
      return info[symbol];
    } catch (e) {
      return { minNotional: 5, minQty: 0.001, stepSize: null, qtyPrecision: 3 };
    }
  }

  async openLong(symbol, leverage, positionSizeUsdt) {
    await this.setupLeverage(symbol, leverage);
    const ticker = await this._request('GET', '/fapi/v1/ticker/price', { symbol });
    const price = parseFloat(ticker.price);
    if (!price || price <= 0) throw new Error(`${symbol} no price`);

    const info = await this.getExchangeInfo(symbol);
    const rawQty = positionSizeUsdt * leverage / price;
    const step = info.stepSize ? parseFloat(info.stepSize) : Math.pow(10, -info.qtyPrecision);
    const qty = Math.floor(rawQty / step) * step;
    const fixedQty = parseFloat(qty.toFixed(info.qtyPrecision));

    if (fixedQty < info.minQty) throw new Error(`qty ${fixedQty} < min ${info.minQty}`);
    if (fixedQty * price < info.minNotional) throw new Error(`notional $${(fixedQty * price).toFixed(2)} < min $${info.minNotional}`);

    const result = await this._request('POST', '/fapi/v1/order', {
      symbol, side: 'BUY', type: 'MARKET', quantity: String(fixedQty),
    }).catch(async (e) => {
      // v106.3: Hedge Mode 兼容 — -4061 需要加 positionSide
      if (String(e.message || e).includes('-4061')) {
        return await this._request('POST', '/fapi/v1/order', {
          symbol, side: 'BUY', type: 'MARKET', quantity: String(fixedQty), positionSide: 'LONG',
        });
      }
      throw e;
    });
    return { success: true, order: result, side: 'LONG', qty: fixedQty, leverage, price };
  }

  async openShort(symbol, leverage, positionSizeUsdt) {
    await this.setupLeverage(symbol, leverage);
    const ticker = await this._request('GET', '/fapi/v1/ticker/price', { symbol });
    const price = parseFloat(ticker.price);
    if (!price || price <= 0) throw new Error(`${symbol} no price`);

    const info = await this.getExchangeInfo(symbol);
    const rawQty = positionSizeUsdt * leverage / price;
    const step = info.stepSize ? parseFloat(info.stepSize) : Math.pow(10, -info.qtyPrecision);
    const qty = Math.floor(rawQty / step) * step;
    const fixedQty = parseFloat(qty.toFixed(info.qtyPrecision));

    if (fixedQty < info.minQty) throw new Error(`qty ${fixedQty} < min ${info.minQty}`);
    if (fixedQty * price < info.minNotional) throw new Error(`notional $${(fixedQty * price).toFixed(2)} < min $${info.minNotional}`);

    const result = await this._request('POST', '/fapi/v1/order', {
      symbol, side: 'SELL', type: 'MARKET', quantity: String(fixedQty),
    }).catch(async (e) => {
      // v106.3: Hedge Mode 兼容 — -4061 需要加 positionSide
      if (String(e.message || e).includes('-4061')) {
        return await this._request('POST', '/fapi/v1/order', {
          symbol, side: 'SELL', type: 'MARKET', quantity: String(fixedQty), positionSide: 'SHORT',
        });
      }
      throw e;
    });
    return { success: true, order: result, side: 'SHORT', qty: fixedQty, leverage, price };
  }

  async closePosition(symbol) {
    const pos = await this.getPosition(symbol);
    if (!pos) return { success: true, reason: 'already_closed' };
    const closeSide = pos.side === 'LONG' ? 'SELL' : 'BUY';
    try {
      const result = await this._request('POST', '/fapi/v1/order', {
        symbol, side: closeSide, type: 'MARKET', quantity: String(pos.qty),
      }).catch(async (e) => {
        // v106.3: Hedge Mode 兼容
        if (String(e.message || e).includes('-4061')) {
          const ps = pos.side === 'LONG' ? 'LONG' : 'SHORT';
          return await this._request('POST', '/fapi/v1/order', {
            symbol, side: closeSide, type: 'MARKET', quantity: String(pos.qty), positionSide: ps, reduceOnly: 'true',
          });
        }
        throw e;
      });
      return { success: true, order: result, pnl: pos.pnl };
    } catch (e) {
      if (String(e.message || e).includes('-4164') || String(e.message || e).includes('notional')) {
        const result = await this._request('POST', '/fapi/v1/order', {
          symbol, side: closeSide, type: 'MARKET', quantity: String(pos.qty), reduceOnly: 'true',
        });
        return { success: true, order: result, pnl: pos.pnl };
      }
      throw e;
    }
  }

  async getPrice(symbol) {
    try {
      const ticker = await this._request('GET', '/fapi/v1/ticker/price', { symbol });
      return parseFloat(ticker.price);
    } catch (e) { return 0; }
  }
}

// ═══════════════════════════════════
// UserTrader 核心
// ═══════════════════════════════════
class UserTrader {
  constructor(opts = {}) {
    this.userDB = opts.userDB;
    this.dataBus = opts.dataBus;
    this.intervalMs = opts.intervalMs || 60000;

    this.running = false;
    this._timer = null;
    this._cycleCount = 0;
    this._userStates = {};
    this._cexClients = {};  // wallet → BinanceUserClient
    this._symbolBlacklist = new Set(); // 不可交易的品种黑名单

    // v50: 多策略管理器
    this.strategyManager = new StrategyManager({
      grid: { gridSize: 10, gridSpacing: 0.02, positionSize: 0.1 },
      dca: { interval: 24 * 60 * 60 * 1000, amountPerInterval: 50, maxPositions: 5 },
      kelly: { maxPositionPct: 0.25, minPositionPct: 0.05, maxRiskPerTrade: 0.02, kellyFraction: 0.5 },
      volatility: { lookbackPeriod: 20 },
    });

    this._userStats = {};
    this._loadState();
    this._log('UserTrader v92 (纯CEX模式) 已初始化');
  }

  _log(msg) {
    const { createLogger } = require('../utils/logger');
    if (!this._winston) this._winston = createLogger('UserTrader');
    this._winston.info(msg);
  }

  // ═══ CEX 客户端管理 ═══
  _getCexClient(userData) {
    // v106.3: 兼容 binanceApiKey/binanceSecret 字段名 + 解密
    const rawKey = userData.cexApiKey || userData.binanceApiKey;
    const rawSecret = userData.cexApiSecret || userData.binanceSecret;
    if (!rawKey || !rawSecret) return null;
    // 解密（如果不是加密格式，decrypt 会原样返回）
    const key = _decryptKey(rawKey);
    const secret = _decryptKey(rawSecret);
    if (!key || !secret) return null;
    const cacheKey = `${key.slice(0, 8)}`;
    if (!this._cexClients[cacheKey]) {
      this._cexClients[cacheKey] = new BinanceUserClient(key, secret);
    }
    return this._cexClients[cacheKey];
  }

  // ═══ 启动 / 停止 ═══
  start() {
    if (this.running) return;
    this.running = true;
    this._log(`🚀 UserTrader v92 启动，间隔 ${this.intervalMs / 1000}s`);
    this._waitForDataBus().then(() => this._loop());
  }

  async _waitForDataBus(maxWait = 30000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const klinesCount = Object.keys(this.dataBus?.klines || {}).length;
      if (klinesCount >= 5) {
        this._log(`✅ DataBus 就绪: ${klinesCount} 个交易对有K线`);
        return;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  stop() {
    this.running = false;
    if (this._timer) clearTimeout(this._timer);
    this._log('UserTrader 停止');
  }

  async _loop() {
    if (!this.running) return;
    try { await this._cycle(); } catch (e) { this._log(`❌ 循环异常: ${e.message}`); }
    this._timer = setTimeout(() => this._loop(), this.intervalMs);
  }

  // ═══ 单次交易循环 ═══
  async _cycle() {
    this._cycleCount++;

    // v106.3: 每轮重新从文件读取用户数据（确保获取最新绑定的API Key）
    try {
      const usersFile = path.join(__dirname, '..', 'data', 'saas-users.json');
      if (fs.existsSync(usersFile)) {
        const fresh = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
        this.userDB.users = fresh.users || fresh;
      }
    } catch (e) { /* ignore */ }

    const users = this.userDB.users || {};

    // v92: 过滤条件改为 cexApiKey（不再需要 vaultAddress）
    // v106.3: 兼容 binanceApiKey 字段名（CEX模式用户存储为 binanceApiKey）
    // v106.4: 安全验证 — 只交易正规注册用户（有passwordHash）+ tradingEnabled + 有效API Key
    const activeUsers = Object.entries(users).filter(([_, u]) =>
      u.tradingEnabled &&
      u.passwordHash &&  // 必须通过正规注册流程
      (u.cexApiKey || (u.binanceApiKey && u.binanceSecret))  // 有有效API Key
    );

    if (activeUsers.length === 0) {
      if (this._cycleCount % 10 === 0) this._log(`第 ${this._cycleCount} 轮: 无活跃用户`);
      return;
    }

    if (this._cycleCount % 5 === 0) this._log(`第 ${this._cycleCount} 轮: ${activeUsers.length} 个活跃用户`);

    for (const [wallet, userData] of activeUsers) {
      try {
        const t0 = Date.now();
        await this._tradeForUser(wallet, userData);
        if (Date.now() - t0 > 5000) {
          this._log(`⏱️ 用户 ${wallet.slice(0, 10)} 交易耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        }
      } catch (e) {
        this._log(`❌ 用户 ${wallet.slice(0, 10)}: ${e.message}`);
      } finally {
        _userLocks.delete(wallet);
      }
    }
    this._saveState();
  }

  // ═══ 为单个用户交易 ═══
  async _tradeForUser(wallet, userData) {
    const client = this._getCexClient(userData);
    if (!client) {
      if (this._cycleCount % 10 === 0) this._log(`[trade] ${wallet.slice(0, 10)} 无CEX API Key`);
      return;
    }
    if (_userLocks.get(wallet)) return;
    _userLocks.set(wallet, true);

    const strategy = userData.strategy || 'balanced';
    const strategyConfig = {
      conservative: { maxPositionPct: 0.15, leverage: 3, slPct: 0.03, tpPct: 0.05, minScore: 7, maxPositions: 2, cooldownMs: 14400000, timeoutHrs: 24 },
      balanced:     { maxPositionPct: 0.20, leverage: 3, slPct: 0.03, tpPct: 0.06, minScore: 7, maxPositions: 3, cooldownMs: 14400000, timeoutHrs: 20 },
      aggressive:   { maxPositionPct: 0.25, leverage: 5, slPct: 0.04, tpPct: 0.08, minScore: 6, maxPositions: 3, cooldownMs: 14400000, timeoutHrs: 24 },
      grid:         { maxPositionPct: 0.15, leverage: 2, slPct: 0.02, tpPct: 0.04, minScore: 3, maxPositions: 5, cooldownMs: 7200000, timeoutHrs: 12 },
      dca:          { maxPositionPct: 0.20, leverage: 2, slPct: 0.05, tpPct: 0.20, minScore: 2, maxPositions: 5, cooldownMs: 86400000, timeoutHrs: 168 },
    }[strategy] || { maxPositionPct: 0.20, leverage: 3, slPct: 0.03, tpPct: 0.06, minScore: 6, maxPositions: 3, cooldownMs: 14400000, timeoutHrs: 20 };

    // 1. 从 CEX 查余额
    let balance;
    try {
      balance = await client.getBalance();
    } catch (e) {
      this._log(`[trade] ${wallet.slice(0, 10)} 余额查询失败: ${e.message}`);
      return;
    }
    const availableBalance = balance.available;

    // 2. 先检查已有持仓是否需要平仓
    const state = this._getUserState(wallet);
    let currentPositions = [];
    try {
      currentPositions = await client.getPositions();
      // 同步本地 state
      state.positions = {};
      for (const p of currentPositions) {
        state.positions[p.symbol] = {
          side: p.side, entryPrice: p.entryPrice, qty: p.qty,
          leverage: p.leverage, pnl: p.pnl, notional: p.notional,
        };
      }
    } catch (e) {
      this._log(`[trade] ${wallet.slice(0, 10)} 持仓查询失败: ${e.message}`);
    }

    // 检查持仓止盈止损
    for (const [sym, pos] of Object.entries(state.positions)) {
      const md = this.dataBus?.marketData?.[sym];
      const currentPrice = md?.price || pos.markPrice;
      if (!currentPrice) continue;
      await this._checkClosePosition(wallet, client, sym, pos, currentPrice, strategyConfig, state);
    }

    // 3. 余额检查
    const userTradeAmount = Number(userData.tradeAmount) || 0;
    if (userTradeAmount <= 0) return;
    const effectiveBalance = Math.min(availableBalance, userTradeAmount);
    if (effectiveBalance < MIN_TRADE_USDT) return;

    // 4. 仓位是否已满
    const remainingPositions = Object.keys(state.positions || {});
    const remainingSlots = strategyConfig.maxPositions - remainingPositions.length;
    if (remainingSlots <= 0) return;

    // 5. 多维度评分
    const topSymbols = await this._selectTopSymbols(15);

    // 6. 新候选（过滤已有仓位+冷却）
    const cooldowns = state.cooldowns || {};
    const now = Date.now();
    const candidates = topSymbols
      .filter(s => s.score >= strategyConfig.minScore && !remainingPositions.includes(s.symbol))
      .filter(s => (now - (cooldowns[s.symbol] || 0)) > strategyConfig.cooldownMs)
      .slice(0, remainingSlots);

    if (candidates.length === 0) return;

    // v113.5: 提前过滤 TradFi 品种，避免每轮重复尝试-4411被拒
    const TRADFI_PREFIXES_UT = ['MSFT','TSLA','NVDA','AAPL','META','GOOGL','SPY','QQQ','XAG','XAU','COPPER','NATGAS','UVXY','URNM','PAXG'];
    const isTradFiUT = (sym) => TRADFI_PREFIXES_UT.some(p => sym.startsWith(p));

    // 7. 逐个开仓
    for (const cand of candidates) {
      // 跳过黑名单品种
      let checkSym = cand.symbol;
      if (checkSym.endsWith('BUSDT')) checkSym = checkSym.replace('BUSDT', 'USDT');
      if (this._symbolBlacklist.has(checkSym)) continue;
      // v113.5: 跳过 TradFi 品种
      if (isTradFiUT(checkSym)) continue;

      try {
        await this._openPosition(wallet, client, cand, effectiveBalance, strategyConfig, state);
      } catch (e) {
        const errMsg = String(e.message || e);
        if (errMsg.includes('-4411')) {
          this._symbolBlacklist.add(checkSym);
          this._log(`⛔ ${checkSym} 需要 TradFi-Perps 协议，已加入黑名单`);
        } else {
          this._log(`❌ 开仓异常 ${cand.symbol}: ${errMsg}`);
        }
      }
    }
  }

  // ═══ 开仓（CEX 模式）═══
  async _openPosition(wallet, client, cand, balance, config, state) {
    const { symbol, score, side, currentPrice, atrPct, atr, confidence, volRegime } = cand;
    const atrPctValue = atrPct || (atr && currentPrice ? atr / currentPrice : 0.02);

    // 凯利公式仓位计算
    const userStats = this._getUserStats(wallet);
    const winRate = userStats.winRate > 0 ? userStats.winRate : 0.5;
    const avgWin = userStats.avgWin > 0 ? userStats.avgWin : 0.03;
    const avgLoss = userStats.avgLoss > 0 ? userStats.avgLoss : 0.01;
    const kellyResult = this.strategyManager.strategies.kelly.calculateKelly(winRate, avgWin, avgLoss);
    let kellyPct = kellyResult.boundedKelly;

    const minKelly = balance < 100 ? 0.40 : balance < 500 ? 0.25 : 0.10;
    kellyPct = Math.max(kellyPct, minKelly);
    if (confidence) kellyPct *= Math.max(confidence, 0.5);
    if (score >= 6) kellyPct *= 1.2; else if (score < 4) kellyPct *= 0.8;
    if (volRegime === 'extreme') kellyPct *= 0.5; else if (volRegime === 'high') kellyPct *= 0.7;

    let positionUsdt = balance * kellyPct;
    const effectiveMaxPct = balance < 100 ? Math.max(config.maxPositionPct, 0.50) : config.maxPositionPct;
    positionUsdt = Math.min(positionUsdt, balance * effectiveMaxPct);
    positionUsdt = Math.min(positionUsdt, MAX_SINGLE_TRADE_USDT);

    if (positionUsdt < MIN_TRADE_USDT) return;

    const leverage = config.leverage || 3;

    // 合约交易对修正: BUSDT → USDT
    let futuresSymbol = symbol;
    if (futuresSymbol.endsWith('BUSDT')) {
      futuresSymbol = futuresSymbol.replace('BUSDT', 'USDT');
    }

    this._log(
      `📈 ${wallet.slice(0, 8)} 开仓 ${futuresSymbol} ${side} | $${positionUsdt.toFixed(2)} | ${leverage}x | 凯利${(kellyPct * 100).toFixed(1)}% | 分${score} | 置信${(confidence || 0).toFixed(2)}`
    );

    // 执行交易
    let result;
    if (side === 'LONG') {
      result = await client.openLong(futuresSymbol, leverage, positionUsdt);
    } else {
      result = await client.openShort(futuresSymbol, leverage, positionUsdt);
    }

    // 记录仓位
    if (!state.positions) state.positions = {};
    state.positions[symbol] = {
      side, entryPrice: result.price || currentPrice,
      leverage, amount: positionUsdt, openTime: Date.now(),
      score, atrPct: atrPctValue,
    };

    this._logTrade(wallet, 'CEX', {
      symbol, action: side, amount: positionUsdt,
      price: result.price || currentPrice, timestamp: Date.now(),
      score, atrPct: atrPctValue, leverage,
    });
  }

  // ═══ 平仓检查（CEX 模式）═══
  async _checkClosePosition(wallet, client, symbol, pos, currentPrice, config, state) {
    const entryPrice = pos.entryPrice;
    if (!entryPrice || !currentPrice) return;

    const holdTime = Date.now() - (pos.openTime || Date.now());
    const holdMinutes = holdTime / 60000;
    const holdHours = holdTime / 3600000;

    // 实际 PnL
    const rawPnlPct = pos.side === 'LONG'
      ? (currentPrice - entryPrice) / entryPrice
      : (entryPrice - currentPrice) / entryPrice;
    const costPct = CEX_FEE_RATE * 2 + CEX_SLIPPAGE * 2; // 双边成本
    const netPnlPct = rawPnlPct - costPct;
    const leveragedPnl = netPnlPct * (pos.leverage || 1);

    if (!pos._peakPnl) pos._peakPnl = 0;
    if (leveragedPnl > pos._peakPnl) pos._peakPnl = leveragedPnl;

    let shouldClose = false;
    let reason = '';

    // 1. 极端亏损保护
    if (netPnlPct <= -0.05) {
      shouldClose = true;
      reason = `极端止损 净亏 ${(netPnlPct * 100).toFixed(2)}%`;
    }
    // 2. 保护期15分钟
    else if (holdMinutes < 15) { return; }
    // 3. ATR 动态止损
    else if (netPnlPct <= -(config.slPct || 0.03)) {
      shouldClose = true;
      reason = `止损 净亏 ${(netPnlPct * 100).toFixed(2)}%`;
    }
    // 4. 止盈
    else if (netPnlPct >= (config.tpPct || 0.06)) {
      shouldClose = true;
      reason = `止盈 净赚 ${(netPnlPct * 100).toFixed(1)}%`;
    }
    // 5. 移动止盈：峰值回撤 40%
    else if (pos._peakPnl >= 0.04 && netPnlPct <= pos._peakPnl * 0.6) {
      shouldClose = true;
      reason = `移动止盈 峰值${(pos._peakPnl * 100).toFixed(1)}% → ${(netPnlPct * 100).toFixed(1)}%`;
    }
    // 6. 超时
    else if (holdHours >= (config.timeoutHrs || 20) && netPnlPct < 0.005) {
      shouldClose = true;
      reason = `超时${holdHours.toFixed(0)}h`;
    }
    // 7. 多策略反转
    if (!shouldClose && holdMinutes >= 15) {
      const klines = this.dataBus?.klines?.[symbol];
      if (klines && klines.length >= 50) {
        try {
          const strategyResult = await this.strategyManager.analyze({ klines, currentPrice, symbol });
          const finalSignal = strategyResult.finalSignal;
          if (pos.side === 'LONG' && finalSignal.action === 'SELL' && finalSignal.confidence > 0.5) {
            shouldClose = true;
            reason = `策略反转平多 conf=${finalSignal.confidence.toFixed(2)}`;
          } else if (pos.side === 'SHORT' && finalSignal.action === 'BUY' && finalSignal.confidence > 0.5) {
            shouldClose = true;
            reason = `策略反转平空 conf=${finalSignal.confidence.toFixed(2)}`;
          }
        } catch (e) { /* 策略分析失败不影响平仓检查 */ }
      }
    }

    if (!shouldClose) return;

    this._log(`📉 ${wallet.slice(0, 8)} 平仓 ${symbol} | ${reason} | 净PnL ${(netPnlPct * 100).toFixed(2)}%`);

    try {
      await client.closePosition(symbol);

      this._logTrade(wallet, 'CEX', {
        symbol, action: 'CLOSE', amount: pos.amount,
        price: currentPrice, pnl: netPnlPct * pos.amount,
        timestamp: Date.now(), reason, holdHours: holdHours.toFixed(1),
      });

      // 更新统计
      this._updateUserStats(wallet, netPnlPct, netPnlPct * pos.amount);
      const stats = this._getUserStats(wallet);
      this._log(`📊 ${wallet.slice(0, 8)} 统计: 胜率=${(stats.winRate * 100).toFixed(0)}% (${stats.wins}W/${stats.losses}L)`);

      delete state.positions[symbol];
      if (!state.cooldowns) state.cooldowns = {};
      state.cooldowns[symbol] = Date.now();
    } catch (e) {
      this._log(`❌ 平仓异常 ${symbol}: ${e.message}`);
    }
  }

  // ═══ 信号评分（完整保留原始策略）═══
  async _scoreSymbol(symbol) {
    const md = this.dataBus?.marketData?.[symbol];
    if (!md) return { score: 0, side: null };
    const ind = this.dataBus.calculateIndicators(symbol);
    if (!ind) return { score: 0, side: null };
    const { price: currentPrice, rsi, atrPercent: atrPct, bb, ma7, ma25: ma21, ma99: ma55, volume: volInfo, atr } = ind;
    if (!currentPrice || !bb || !ma21) return { score: 0, side: null };
    const pctB = bb.pctB || 0.5;
    const klines = this.dataBus?.klines?.[symbol];
    if (!klines || klines.length < 50) return { score: 0, side: null };
    const lastKline = klines[klines.length - 1];
    const isGreen = (lastKline?.close || currentPrice) > (lastKline?.open || currentPrice);
    const isRed = !isGreen;

    const marketData = { klines, currentPrice, symbol };
    const strategyResult = await this.strategyManager.analyze(marketData);
    const finalSignal = strategyResult.finalSignal;
    const compositeScore = strategyResult.compositeScore;
    const volRegime = strategyResult.analysis.volatility?.regime || 'medium';
    const consistency = strategyResult.analysis.consistency || {};
    const anomaly = strategyResult.analysis.anomalyCheck || {};

    let score = 0;
    let side = null;

    if (finalSignal.action === 'BUY') { side = 'LONG'; score += finalSignal.confidence * 3.5; }
    else if (finalSignal.action === 'SELL') { side = 'SHORT'; score += finalSignal.confidence * 3.5; }

    const longTrend = ma7 > ma21 && ma21 > ma55;
    const shortTrend = ma7 < ma21 && ma21 < ma55;
    if (side === 'LONG' && longTrend) score += 2.5;
    if (side === 'SHORT' && shortTrend) score += 2.5;

    if (side === 'LONG') {
      score += (pctB < 0.15 ? 1.5 : pctB < 0.30 ? 1.0 : 0);
      score += (rsi < 30 ? 1.5 : rsi < 40 ? 1.0 : 0);
      if (isGreen) score += 0.5;
    } else if (side === 'SHORT') {
      score += (pctB > 0.85 ? 1.5 : pctB > 0.70 ? 1.0 : 0);
      score += (rsi > 70 ? 1.5 : rsi > 60 ? 1.0 : 0);
      if (isRed) score += 0.5;
    }

    if (strategyResult.signals.grid?.action !== 'HOLD') score += 1.0;
    if (strategyResult.signals.dca?.action === 'BUY' && side === 'LONG') score += 0.5;

    if (volRegime === 'extreme') score *= 0.5;
    else if (volRegime === 'high') score *= 0.8;
    else if (volRegime === 'low') score *= 1.1;

    if (consistency.consistent) score *= 1.15;
    if (anomaly.isAnomaly) score *= 0.7;

    const bigCapShortBlock = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];
    if (side === 'SHORT' && bigCapShortBlock.includes(symbol) && score < 5) return { score: 0, side: null };
    if (score < 3) return { score: 0, side: null };

    return {
      score: Math.round(score * 10) / 10,
      side, currentPrice, ma7, ma21, ma55, rsi, atrPct, atr, pctB,
      volRatio: volInfo?.ratio || 1, volRegime,
      consistency: consistency.consistent,
      confidence: finalSignal.confidence,
      compositeScore: compositeScore?.normalized,
    };
  }

  async _selectTopSymbols(maxCount = 10) {
    const marketData = this.dataBus?.marketData || {};
    const allKlines = this.dataBus?.klines || {};
    const scored = [];
    for (const [sym, md] of Object.entries(marketData)) {
      if (!sym.endsWith('USDT')) continue;
      const klines = allKlines[sym];
      if (!klines || klines.length < 50) continue;
      const result = await this._scoreSymbol(sym);
      if (result.score >= 3) scored.push({ symbol: sym, ...result });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxCount);
  }

  // ═══ 辅助方法 ═══
  _getUserState(wallet) {
    if (!this._userStates[wallet]) this._userStates[wallet] = { positions: {}, lastCycle: 0 };
    return this._userStates[wallet];
  }

  _getUserStats(wallet) {
    if (!this._userStats[wallet]) this._userStats[wallet] = { wins: 0, losses: 0, totalPnl: 0, avgWin: 0, avgLoss: 0, winRate: 0 };
    return this._userStats[wallet];
  }

  _updateUserStats(wallet, pnlPct, pnlUsdt) {
    if (typeof pnlPct !== 'number' || !isFinite(pnlPct)) pnlPct = 0;
    if (typeof pnlUsdt !== 'number' || !isFinite(pnlUsdt)) pnlUsdt = 0;
    const stats = this._getUserStats(wallet);
    stats.totalPnl += pnlUsdt;
    if (pnlPct > 0) { stats.wins++; stats.avgWin = (stats.avgWin * (stats.wins - 1) + pnlPct) / stats.wins; }
    else if (pnlPct < 0) { stats.losses++; stats.avgLoss = (stats.avgLoss * (stats.losses - 1) + Math.abs(pnlPct)) / stats.losses; }
    const total = stats.wins + stats.losses;
    stats.winRate = total > 0 ? stats.wins / total : 0;
  }

  _logTrade(wallet, source, trade) {
    const entry = { wallet, source, ...trade };
    try {
      let trades = [];
      if (fs.existsSync(TRADE_LOG_FILE)) trades = JSON.parse(fs.readFileSync(TRADE_LOG_FILE, 'utf8'));
      trades.push(entry);
      if (trades.length > 1000) trades = trades.slice(-700);
      fs.writeFileSync(TRADE_LOG_FILE, JSON.stringify(trades, null, 2));
    } catch (e) {}
  }

  _loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        this._userStates = data.userStates || {};
        this._cycleCount = data.cycleCount || 0;
        this._userStats = data.userStats || {};
      }
    } catch (e) {}
  }

  _saveState() {
    try {
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        userStates: this._userStates,
        cycleCount: this._cycleCount,
        userStats: this._userStats,
        lastSave: Date.now(),
      }, null, 2));
    } catch (e) {}
  }

  // ═══ 公开查询方法（仪表盘用）═══
  getUserState(wallet) { return this._userStates[wallet] || { positions: {} }; }

  getUserTrades(wallet, limit = 20) {
    try {
      if (!this._tradesCache || Date.now() - (this._tradesCacheTime || 0) > 5000) {
        this._tradesCache = fs.existsSync(TRADE_LOG_FILE) ? JSON.parse(fs.readFileSync(TRADE_LOG_FILE, 'utf8')) : [];
        this._tradesCacheTime = Date.now();
      }
      return this._tradesCache.filter(t => t.wallet === wallet).slice(-limit);
    } catch (e) { return []; }
  }

  getAllUserTrades(limit = 50) {
    try {
      return fs.existsSync(TRADE_LOG_FILE)
        ? JSON.parse(fs.readFileSync(TRADE_LOG_FILE, 'utf8')).slice(-limit)
        : [];
    } catch (e) { return []; }
  }

  getStatus() {
    return {
      running: this.running,
      cycleCount: this._cycleCount,
      activeUsers: Object.entries(this.userDB?.users || {}).filter(([_, u]) => u.tradingEnabled && u.cexApiKey).length,
      totalUsers: Object.keys(this.userDB?.users || {}).length,
    };
  }
}

module.exports = UserTrader;
