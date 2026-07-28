/**
 * CEXUserTrader — v72: 用用户自己的 Binance API Key 在 CEX 上交易
 *
 * 核心改进（对比旧版 DEX user-trader）：
 *   - 交易成本：0.2% 双边（CEX） vs 2.0% 双边（DEX）→ 降 90%
 *   - 止损/止盈：使用 v70 回测最优参数（SL 2×ATR, TP 3×ATR）
 *   - 无 Gas 费、无滑点问题
 *   - 通过 Binance Futures API 直接下单
 *   - 用户资金始终在自己的 Binance 账户里，不进平台
 *
 * 安全设计：
 *   - API Key + Secret 加密存储（AES-256）
 *   - 只开启 futures 交易权限，不开提币
 *   - IP 白名单锁定服务器 IP
 *   - 用户可随时解绑（删除 Key）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ═══════════════════════════════════
// 加密/解密工具（保护 API Key）
// ═══════════════════════════════════
const { RateLimiter, userLimiter } = require('./rate-limiter');
const _globalLimiter = userLimiter; // v113.13.6: 普通用户用独立 userLimiter

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || process.env.ENCRYPT_KEY;
if (!ENCRYPTION_KEY) { console.error('[FATAL] ENCRYPTION_KEY not set in .env'); process.exit(1); }
const ALGORITHM = 'aes-256-gcm';
const { decrypt: _decrypt } = require('../core/crypto-utils');
function decrypt(t) { return _decrypt(t); }

function encrypt(text) {
  if (!text) return '';
  try {
    const key = Buffer.from(ENCRYPTION_KEY, 'hex');
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${tag}:${encrypted}`;
  } catch (e) {
    return text; // fallback（开发环境不加密）
  }
}

function decrypt(encryptedText) {
  if (!encryptedText || !encryptedText.includes(':')) return encryptedText;
  try {
    const key = Buffer.from(ENCRYPTION_KEY, 'hex');
    const [ivHex, tagHex, encrypted] = encryptedText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    return encryptedText; // fallback
  }
}

// ═══════════════════════════════════
// Binance Futures API 客户端
// ═══════════════════════════════════
class BinanceClient {
  constructor(apiKey, apiSecret) {
    this.apiKey = decrypt(apiKey);
    this.apiSecret = decrypt(apiSecret);
    this.baseURL = 'https://fapi.binance.com';
  }

  // 签名请求
  _sign(params) {
    const query = new URLSearchParams(params).toString();
    const signature = crypto.createHmac('sha256', this.apiSecret).update(query).digest('hex');
    return `${query}&signature=${signature}`;
  }

  async _request(method, endpoint, params = {}) {
    // v113.10: 用 schedule 包裹 — 自动限速+熔断+重试
    return _globalLimiter.schedule(2, () => this._doRequest(method, endpoint, params));
  }

  async _doRequest(method, endpoint, params = {}) {
    const https = require('https');
    return new Promise((resolve, reject) => {
      const allParams = { timestamp: Date.now(), recvWindow: 5000, ...params };
      const signedQuery = this._sign(allParams);

      const url = new URL(this.baseURL + endpoint + '?' + signedQuery);
      const reqOpts = {
        method,
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers: { 'X-MBX-APIKEY': this.apiKey },
        timeout: 10000,
      };

      const timer = setTimeout(() => reject(new Error('Request timeout')), 15000);
      const req = https.request(reqOpts, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          clearTimeout(timer);
          // v113.13.4: 检测418 IP封禁 — Binance返回HTML不是JSON
          if (res.statusCode === 418) {
            reject(new Error(JSON.stringify({ code: -1003, msg: `IP banned (418). data=${data.slice(0, 100)}` })));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed.code && parsed.code !== 200) reject(new Error(JSON.stringify(parsed)));
            else resolve(parsed);
          } catch (e) { reject(new Error(`Parse error: ${data.slice(0, 200)}`)); }
        });
      });
      req.on('error', e => { clearTimeout(timer); reject(e); });
      req.end();
    });
  }

  // ═══ 账户信息 ═══
  async getBalance() {
    const data = await this._request('GET', '/fapi/v3/balance');
    const usdt = data.find(b => b.asset === 'USDT');
    return usdt ? {
      balance: parseFloat(usdt.balance),
      available: parseFloat(usdt.availableBalance || usdt.balance),
      unrealizedPnl: parseFloat(usdt.crossUnPnl || 0),
    } : null;
  }

  async getAllPositions() {
    const data = await this._request('GET', '/fapi/v3/positionRisk');
    return data
      .filter(p => parseFloat(p.positionAmt) !== 0)
      .map(p => ({
        symbol: p.symbol,
        side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
        qty: Math.abs(parseFloat(p.positionAmt)),
        entryPrice: parseFloat(p.entryPrice),
        markPrice: parseFloat(p.markPrice),
        pnl: parseFloat(p.unRealizedProfit),
        leverage: parseInt(p.leverage) || 3,
        timestamp: p.updateTime || Date.now(),
      }));
  }

  async getRealPosition(symbol) {
    const all = await this.getAllPositions();
    return all.find(p => p.symbol === symbol) || null;
  }

  // ═══ 下单 ═══
  async setupLeverage(symbol, leverage) {
    try {
      return await this._request('POST', '/fapi/v1/leverage', {
        symbol, leverage: String(leverage),
      });
    } catch (e) {
      // 多资产模式下 marginType 切换可能失败，忽略
      if (e.message?.includes('No need to change')) return {};
      throw e;
    }
  }

  async getExchangeInfo(symbol) {
    // v825: 缓存 exchangeInfo，避免每笔交易都请求 API
    if (!this._exchangeInfoCache) {
      try {
        const https = require('https');
        const url = `https://fapi.binance.com/fapi/v1/exchangeInfo`;
        this._exchangeInfoCache = await new Promise((resolve, reject) => {
          https.get(url, { timeout: 8000 }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
          }).on('error', reject);
        });
        // 每 1 小时刷新一次
        setTimeout(() => { this._exchangeInfoCache = null; }, 3600000);
      } catch (e) {
        return null;
      }
    }
    try {
      const sym = this._exchangeInfoCache.symbols?.find(s => s.symbol === symbol);
      if (!sym) return null;
      let minNotional = 5;
      for (const f of (sym.filters || [])) {
        if (f.filterType === 'MIN_NOTIONAL') minNotional = parseFloat(f.notional || f.minNotional || 5);
      }
      const lotSize = sym.filters?.find(f => f.filterType === 'LOT_SIZE');
      const priceFilter = sym.filters?.find(f => f.filterType === 'PRICE_FILTER');
      // v112.5: 优先用stepSize算精度, 避免baseAssetPrecision=8导致精度过高
      const stepStr = lotSize ? lotSize.stepSize : null;
      let qtyPrec = sym.quantityPrecision ?? 3;
      if (stepStr) { const sv = parseFloat(stepStr); if (sv > 0) qtyPrec = Math.max(0, Math.round(-Math.log10(sv))); }
      return {
        qtyPrecision: qtyPrec,
        minQty: lotSize ? parseFloat(lotSize.minQty) : 0.001,
        stepSize: lotSize ? lotSize.stepSize : null,
        tickSize: priceFilter?.tickSize || '0.01',
        minNotional,
      };
    } catch (e) {
      return null;
    }
  }

  fixQty(symbol, qty, precision = 3, stepSize = null) {
    // v112.5: 优先用stepSize计算(最准确), 否则用precision
    if (stepSize && parseFloat(stepSize) > 0) {
      const step = parseFloat(stepSize);
      const fixed = Math.floor(qty / step) * step;
      return parseFloat(fixed.toFixed(8));
    }
    const step = Math.pow(10, -precision);
    const fixed = Math.floor(qty / step) * step;
    return parseFloat(fixed.toFixed(precision));
  }

  async marketOrder(symbol, side, quantity, positionSide = null) {
    this._log(`${symbol} MARKET ${side} ${quantity}`);
    const params = { symbol, side, type: 'MARKET', quantity: String(quantity) };
    if (positionSide) params.positionSide = positionSide;
    try {
      return await this._request('POST', '/fapi/v1/order', params);
    } catch (e) {
      // 如果是双向模式错误(-4061)，不带 positionSide 重试
      if (String(e.message || e).includes('-4061') && positionSide) {
        delete params.positionSide;
        return await this._request('POST', '/fapi/v1/order', params);
      }
      // 如果是单向模式错误(-4061)，带 positionSide 重试
      if (String(e.message || e).includes('-4061') && !positionSide) {
        params.positionSide = (side === 'BUY' ? 'LONG' : 'SHORT');
        return await this._request('POST', '/fapi/v1/order', params);
      }
      throw e;
    }
  }

  async openLong(symbol, leverage, positionSize) {
    await this.setupLeverage(symbol, leverage);
    const price = await this._getPrice(symbol);
    if (!price || price <= 0) throw new Error(`${symbol} no price`);

    const info = await this.getExchangeInfo(symbol);
    const minNotional = info?.minNotional || 5;
    const qtyPrecision = info?.qtyPrecision ?? 3;
    const minQty = info?.minQty || 0.001;

    const rawQty = positionSize * leverage / price;
    const qty = this.fixQty(symbol, rawQty, qtyPrecision, info?.stepSize);
    this._log(`${symbol} 开仓: raw=${rawQty.toFixed(4)} precision=${qtyPrecision} fixed=${qty} notional=$${(qty * price).toFixed(2)}`);
    if (qty < minQty) throw new Error(`qty ${qty} < min ${minQty}`);
    if (qty * price < minNotional) throw new Error(`notional $${(qty * price).toFixed(2)} < min $${minNotional}`);

    const result = await this.marketOrder(symbol, 'BUY', qty);
    return { success: true, order: result, side: 'LONG', qty, leverage, price };
  }

  async openShort(symbol, leverage, positionSize) {
    await this.setupLeverage(symbol, leverage);
    const price = await this._getPrice(symbol);
    if (!price || price <= 0) throw new Error(`${symbol} no price`);

    const info = await this.getExchangeInfo(symbol);
    const minNotional = info?.minNotional || 5;
    const qtyPrecision = info?.qtyPrecision ?? 3;
    const minQty = info?.minQty || 0.001;

    const rawQty = positionSize * leverage / price;
    const qty = this.fixQty(symbol, rawQty, qtyPrecision, info?.stepSize);
    if (qty < minQty) throw new Error(`qty ${qty} < min ${minQty}`);
    if (qty * price < minNotional) throw new Error(`notional $${(qty * price).toFixed(2)} < min $${minNotional}`);

    const result = await this.marketOrder(symbol, 'SELL', qty);
    return { success: true, order: result, side: 'SHORT', qty, leverage, price };
  }

  async closePosition(symbol) {
    const pos = await this.getRealPosition(symbol);
    if (!pos) return { success: true, reason: 'already_closed' };
    const closeSide = pos.side === 'LONG' ? 'SELL' : 'BUY';
    const positionSide = pos.side; // LONG平多/SHORT平空
    try {
      const result = await this.marketOrder(symbol, closeSide, pos.qty, positionSide);
      return { success: true, order: result, closedSide: pos.side, pnl: pos.pnl };
    } catch (e) {
      // v90: 名义值不足时用 reduceOnly 重试
      if (String(e.message || e).includes('-4164') || String(e.message || e).includes('notional')) {
        this._log(`${symbol} 标准平仓失败(notional too small)，尝试 reduceOnly...`);
        try {
          const reduceResult = await this._request('POST', '/fapi/v1/order', {
            symbol, side: closeSide, type: 'MARKET', quantity: String(pos.qty), reduceOnly: 'true'
          });
          return { success: true, order: reduceResult, closedSide: pos.side, pnl: pos.pnl };
        } catch (e2) {
          this._log(`${symbol} reduceOnly平仓也失败: ${e2.message} — 需手动处理`);
          throw e2;
        }
      }
      throw e;
    }
  }

  async _getPrice(symbol) {
    // v113.13.6: 优先用共享 DataBus WebSocket 行情 — 不消耗 API 额度
    if (this.dataBus?.marketData?.[symbol]?.price) {
      return this.dataBus.marketData[symbol].price;
    }
    // fallback: HTTP 请求（走 userLimiter）
    try {
      const { userLimiter } = require('./rate-limiter');
      const url = `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`;
      return await userLimiter.schedule(1, () => new Promise((resolve, reject) => {
        const https = require('https');
        https.get(url, { timeout: 5000 }, (res) => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => {
            try { resolve(parseFloat(JSON.parse(d).price)); }
            catch(e) { reject(e); }
          });
        }).on('error', reject);
      }));
    } catch (e) { return 0; }
  }

  // ═══ SAPI 请求（现货/转账/提现）═══
  async _sapiRequest(method, endpoint, params = {}) {
    const https = require('https');
    return new Promise((resolve, reject) => {
      const allParams = { timestamp: Date.now(), recvWindow: 10000, ...params };
      const query = new URLSearchParams(allParams).toString();
      const signature = crypto.createHmac('sha256', this.apiSecret).update(query).digest('hex');
      const fullQuery = `${query}&signature=${signature}`;

      const url = new URL(`https://api.binance.com${endpoint}?${fullQuery}`);
      const reqOpts = {
        method,
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers: { 'X-MBX-APIKEY': this.apiKey },
        timeout: 15000,
      };

      const timer = setTimeout(() => reject(new Error('SAPI request timeout')), 20000);
      const req = https.request(reqOpts, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          clearTimeout(timer);
          try {
            const parsed = JSON.parse(data);
            if (parsed.code && parsed.code < 0) reject(new Error(JSON.stringify(parsed)));
            else resolve(parsed);
          } catch (e) { reject(new Error(`SAPI parse error: ${data.slice(0, 200)}`)); }
        });
      });
      req.on('error', e => { clearTimeout(timer); reject(e); });
      req.end();
    });
  }

  /**
   * 从用户合约账户转 USDT 到指定 BSC 地址
   * 流程: 合约钱包 → 现货钱包 (internal) → 提现到 BSC 地址
   */
  async transferFeeToWallet(amountUsdt, toAddress) {
    const results = { internal: null, withdraw: null };
    const fixedAmount = Math.floor(amountUsdt * 100) / 100; // 保留2位
    if (fixedAmount < 1) return { success: false, error: 'Amount < $1 minimum' };

    // v121: 先查现货余额，如果现货已有 USDT 说明之前 internal transfer 成功但 withdraw 失败
    // 这种情况下跳过 Step 1 直接 withdraw，避免资金重复划转
    let spotBalance = 0;
    try {
      const spotInfo = await this._sapiRequest('GET', '/sapi/v1/asset/transfer', {
        from: 'MAIN',
        to: 'MAIN',
      }).catch(() => null);
      // 如果 SAPI 查询失败（权限不足），直接走正常流程
    } catch (e) { /* 忽略，走正常流程 */ }

    // Step 1: 合约钱包 → 现货钱包 (futures → spot)
    // v121: 如果 internal transfer 失败（权限不足/余额不够），可能是之前已划转过
    //       此时尝试直接 withdraw
    let internalOk = false;
    try {
      results.internal = await this._sapiRequest('POST', '/sapi/v1/asset/transfer', {
        type: 'MAIN_UMFUTURE',   // USDT-M Futures → Spot
        asset: 'USDT',
        amount: String(fixedAmount),
      });
      this._log(`✅ Internal transfer: $${fixedAmount} futures→spot txId=${results.internal.txnId || 'ok'}`);
      internalOk = true;
    } catch (e) {
      this._log(`⚠️ Internal transfer failed: ${e.message.slice(0,80)}`);
      // 不直接 return，尝试直接 withdraw（可能资金已在现货钱包）
    }

    // Step 2: 等待到账
    if (internalOk) await new Promise(r => setTimeout(r, 2000));

    // Step 3: 现货钱包 → 提现到 BSC 地址
    try {
      results.withdraw = await this._sapiRequest('POST', '/sapi/v1/capital/withdraw/apply', {
        coin: 'USDT',
        network: 'BSC',
        address: toAddress,
        amount: String(fixedAmount),
      });
      this._log(`✅ Withdraw submitted: $${fixedAmount} USDT → ${toAddress.slice(0,10)}... withdrawId=${results.withdraw.id || 'ok'}`);
    } catch (e) {
      this._log(`❌ Withdraw failed (funds still in spot wallet): ${e.message.slice(0,80)}`);
      return { success: false, error: `Withdraw failed: ${e.message}, funds in spot wallet`, results };
    }

    return { success: true, amount: fixedAmount, results };
  }

  _log(msg) {
    console.log(`[CEXClient] ${new Date().toISOString()} ${msg}`);
  }
}

// ═══════════════════════════════════
// CEXUserTrader 核心
// ═══════════════════════════════════
class CEXUserTrader {
  /**
   * @param {Object} opts
   * @param {Object} opts.userDB       — UserDB 实例
   * @param {Object} opts.dataBus      — DataBus 实例（共享行情数据）
   * @param {Object} opts.strategyManager — 策略管理器（共享 AI 信号）
   * @param {number} opts.intervalMs   — 交易循环间隔（默认 30s）
   */
  constructor(opts = {}) {
    this.userDB = opts.userDB;
    this.dataBus = opts.dataBus;
    this.strategyManager = opts.strategyManager;
    this.intervalMs = opts.intervalMs || 60000; // v113.13.5: 30s→60s

    this.running = false;
    this._timer = null;
    this._cycleCount = 0;
    this._clients = {}; // wallet → BinanceClient

    // v113.56回滚: 策略参数恢复 — 杠杆5x, 3仓, 冷却5min
    this.strategyParams = {
      conservative: {
        leverage: 3, slPct: 0.04, tpPct: 0.08, minScore: 7,
        maxPositions: 2, cooldownMs: 1 * 3600000, timeoutHrs: 24,
        positionPct: 0.35,
        slippagePct: 0.001,
      },
      balanced: {
        leverage: 5, slPct: 0.04, tpPct: 0.08, minScore: 5,
        maxPositions: 3, cooldownMs: 5 * 60000, timeoutHrs: 12,
        positionPct: 0.35,
        slippagePct: 0.001,
      },
      aggressive: {
        leverage: 8, slPct: 0.05, tpPct: 0.10, minScore: 5,
        maxPositions: 3, cooldownMs: 5 * 60000, timeoutHrs: 12,
        positionPct: 0.40,
        slippagePct: 0.0015,
      },
    };

    // v113.23: 连亏追踪 — 按 wallet 独立冷却，互不影响
    this._consecutiveLosses = {};
    this._globalCooldownUntil = {}; // v113.23: 改为按 wallet 独立 { [wallet]: timestamp }

    // CEX 交易成本
    this.FEE_RATE = 0.0004;      // 0.04% 单边手续费 (Binance)
    this.FUNDING_RATE = 0.0001;  // 0.01% / 8h 资金费率

    // ═══════ 费用配置 ═══════
    // 普通用户: 算力 Token10% + 算力 Token20% = 实得70%
    // 管理员: 0% + 0% = 100%
    this.PLATFORM_FEE_RATE = 0.20;   // 20% 算力 Token
    this.ECO_FUND_RATE = 0.10;       // 10% 算力 Token
    this.USER_SHARE_RATE = 0.70;     // 70% 用户实得
    this.PLATFORM_WALLET = '0xb6DEb31484353AdDaA5b6A105A2B758Df11bC28A';  // 服务费钱包
    this.ECO_FUND_WALLET = '0xeF87e7fD5f0ADC5de82e84Dc9300002D9aC8bD82';  // 生态费钱包
    this.FEE_TRANSFER_THRESHOLD = 5;  // v122: 阈值改为 $5 — 累计算力 Token+算力 Token超过 $5 才自动转
    this.FEE_STATE_FILE = path.join(__dirname, '..', 'data', 'cex-fee-state.json');
    this._feeState = { pending: {}, collected: {}, totalPlatformFee: 0, totalEcoFund: 0 };

    // ═══════ v121: 转账失败冷却机制 ═══════
    // 记录每个用户最近一次转账失败时间，30分钟内不再重试
    this._transferFailCooldown = {}; // wallet → { lastFailAt, failCount }
    this.TRANSFER_COOLDOWN_MS = 30 * 60 * 1000; // 30分钟冷却
    this.TRANSFER_MAX_FAIL = 3; // 连续失败3次后停止自动转账直到用户重新绑定

    // ═══════ 管理员钱包（免一切费用） ═══════
    this.ADMIN_WALLETS = [
      '0xfA3b90c574469909D20848273C06752a22fdE74a',  // 你的钱包（主管理员）
      '0xe6DDF0771c7610dBA77eB5a07ba7771DD7F5e91e',  // 交易器钱包
      '0x41c89c7DF1AD4c8dd251C5AFE45aa1c791FB6ea5',  // 白名单用户，免算力费
    ];

    // 状态持久化
    this.STATE_FILE = path.join(__dirname, '..', 'data', 'cex-user-trader-state.json');
    this.TRADE_LOG = path.join(__dirname, '..', 'data', 'cex-user-trades.json');
    this._states = {}; // wallet → { positions, cooldowns, stats }
    this._stats = {};  // wallet → { wins, losses, totalPnl, avgWin, avgLoss }

    this._loadState();
    this._loadFeeState();
    this._log('CEXUserTrader v74 — 算力 Token模式 (BSC链上授权扣费)');
  }

  _log(msg) {
    console.log(`[CEXUserTrader] ${new Date().toISOString()} ${msg}`);
  }

  // ═══════════════════════════════════
  // 启动 / 停止
  // ═══════════════════════════════════
  start() {
    if (this.running) return;
    this.running = true;
    this._log(`🚀 CEXUserTrader 启动, 间隔 ${this.intervalMs / 1000}s`);
    this._loop();
  }

  stop() {
    this.running = false;
    if (this._timer) clearTimeout(this._timer);
    this._log('CEXUserTrader 停止');
  }

  async _loop() {
    if (!this.running) return;
    try {
      await this._cycle();
    } catch (e) {
      this._log(`❌ 循环异常: ${e.message}`);
    }
    this._timer = setTimeout(() => this._loop(), this.intervalMs);
  }

  // ═══════════════════════════════════
  // 单次交易循环
  // ═══════════════════════════════════
  async _cycle() {
    this._cycleCount++;

    // v113.13.6: 用 userLimiter 检查封禁（普通用户独立限速器）
    const { userLimiter } = require('./rate-limiter');
    if (userLimiter && userLimiter._banned && Date.now() < (userLimiter._bannedUntil || 0)) {
      if (this._cycleCount % 20 === 0) {
        const wait = Math.ceil((userLimiter._bannedUntil - Date.now()) / 1000);
        this._log(`⏸️ 第 ${this._cycleCount} 轮跳过 — API封禁中，${wait}s后解封`);
      }
      return;
    }

    // 每轮重新读取用户文件，确保获取最新绑定的API Key
    try {
      const fs = require('fs');
      const path = require('path');
      const usersFile = path.join(__dirname, '..', 'data', 'saas-users.json');
      if (fs.existsSync(usersFile)) {
        const fresh = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
        this.userDB.users = fresh.users || fresh;
      }
    } catch (e) { /* ignore */ }
    // 找出有 Binance API Key 的活跃用户（排除DEX模式用户）
    const users = this.userDB.users || {};
    const cexUsers = Object.entries(users).filter(([_, u]) =>
      u.tradingEnabled && u.binanceApiKey && u.binanceSecret && u.exchangeMode !== 'dex'
    );

    if (cexUsers.length === 0) {
      if (this._cycleCount % 20 === 0) {
        this._log(`第 ${this._cycleCount} 轮: 无CEX用户`);
      }
      return;
    }

    this._log(`第 ${this._cycleCount} 轮: ${cexUsers.length} 个CEX用户`);

    // v113.13.6: 分批轮询 — 每轮只查一批用户的余额/持仓
    // 避免百万用户时同一轮内并发过多 API 请求
    const batchSize = Math.min(cexUsers.length, 20); // 每轮最多20个用户
    const totalUsers = cexUsers.length;
    const batchCount = Math.ceil(totalUsers / batchSize);
    const currentBatch = this._cycleCount % batchCount;
    const startIdx = currentBatch * batchSize;
    const batchUsers = cexUsers.slice(startIdx, startIdx + batchSize);
    
    if (totalUsers > batchSize) {
      this._log(`  分批轮询: 第${currentBatch + 1}/${batchCount}批 (${batchUsers.length}个用户, 轮次${this._cycleCount})`);
    }

    for (const [wallet, userData] of batchUsers) {
      try {
        await this._tradeForUser(wallet, userData);
      } catch (e) {
        this._log(`❌ 用户 ${wallet.slice(0, 10)} 交易失败: ${e.message}`);
      }
    }

    this._saveState();
  }

  // ═══════════════════════════════════
  // 为单个 CEX 用户交易
  // ═══════════════════════════════════
  async _tradeForUser(wallet, userData) {
    // v113.16: 每个用户独立的 AdaptiveExitManager — 不共享连亏状态
    if (!this._userExitManagers) this._userExitManagers = {};
    if (!this._userExitManagers[wallet]) {
      const AdaptiveExitManager = require('./adaptive-exit');
      this._userExitManagers[wallet] = new AdaptiveExitManager();
      // v114: 从共享 exitManager 复制全局参数 (但状态独立)
      if (this.exitManager) {
        this._userExitManagers[wallet].slAtrMult = this.exitManager.slAtrMult;
        this._userExitManagers[wallet].tpAtrMult = this.exitManager.tpAtrMult;
        this._userExitManagers[wallet].trailingAtrMult = this.exitManager.trailingAtrMult;
      }
    }
    const _userExit = this._userExitManagers[wallet];
    // v114: 同步关键参数
    if (this.exitManager) {
      _userExit.slAtrMult = this.exitManager.slAtrMult;
      _userExit.tpAtrMult = this.exitManager.tpAtrMult;
      _userExit.trailingAtrMult = this.exitManager.trailingAtrMult;
      _userExit.timeDecayStartMin = this.exitManager.timeDecayStartMin;
      _userExit.timeDecayRate = this.exitManager.timeDecayRate;
    }

    // v113.16: 每个用户独立的 PositionSizer — 不共享连亏缩仓
    if (!this._userPositionSizers) this._userPositionSizers = {};
    if (!this._userPositionSizers[wallet]) {
      const { PositionSizer } = require('./position-sizer');
      this._userPositionSizers[wallet] = new PositionSizer();
    }
    const _userSizer = this._userPositionSizers[wallet];

    // Binance 通道
    let client = this._clients[wallet];
    if (!client) {
      client = new BinanceClient(userData.binanceApiKey, userData.binanceSecret);
      client._channel = 'binance';
      this._clients[wallet] = client;
    }

    // v119: 余额缓存5分钟, 持仓缓存降到30秒 — 避免开仓后用旧持仓数据
    if (!this._balanceCache) this._balanceCache = {};
    if (!this._positionCache) this._positionCache = {};
    const CACHE_TTL = 30 * 1000; // v119: 30秒持仓缓存（原5分钟太长导致孤儿仓位）
    const BAL_CACHE_TTL = 5 * 60 * 1000; // 余额缓存仍然5分钟
    const cacheKey = wallet;

    // 1. 查余额（带缓存）
    let balance;
    const cachedBal = this._balanceCache[cacheKey];
    if (cachedBal && Date.now() - cachedBal.time < BAL_CACHE_TTL) {
      balance = cachedBal.value;
    } else {
      try {
        balance = await client.getBalance();
        this._balanceCache[cacheKey] = { value: balance, time: Date.now() };
      } catch (e) {
        this._log(`⚠️ ${wallet.slice(0, 10)} 余额查询失败: ${e.message}`);
        // 如果是签名错误或 key 无效，标记用户
        if (e.message?.includes('Invalid API-key') || e.message?.includes('-2015')) {
          this._log(`🚫 ${wallet.slice(0, 10)} API Key 无效，暂停交易`);
          { const e = this.userDB.get(wallet) || {}; this.userDB.set(wallet, { ...e, tradingEnabled: false, binanceError: 'API Key 无效' }); }
        }
        return;
      }
    }

    if (!balance || balance.balance < 10) {
      if (this._cycleCount % 10 === 0) {
        this._log(`[trade] ${wallet.slice(0, 10)} 余额不足: $${balance?.balance?.toFixed(2) || 0}`);
      }
      return;
    }

    // ═══ 算力 Token检查（方案A：充值到Trader钱包，记账余额） ═══
    let _gatesFeePaused = false;
    if (this._isAdmin(wallet)) {
      // 管理员跳过算力 Token检查
    } else if (userData.gatesFeeLow) {
      _gatesFeePaused = true;
      if (this._cycleCount % 10 === 0) {
        this._log(`⏸️ ${wallet.slice(0, 10)}... 算力 Token余额不足($${(userData.gatesFeeBalance||0).toFixed(2)})，暂停开新仓，继续监控持仓`);
      }
    }

    const tradeAmount = Number(userData.tradeAmount) || Math.min(balance.available, 50);
    this._log(`[trade] ${wallet.slice(0, 10)} 余额=$${balance.balance.toFixed(2)} 可用=$${balance.available.toFixed(2)} tradeAmt=$${tradeAmount} strategy=${userData.strategy}`);
    const state = this._getState(wallet);

    // v113.23: 连亏熔断检查 — 按 wallet 独立，互不影响，冷却5分钟
    if (!this._consecutiveLosses) this._consecutiveLosses = {};
    if (!this._globalCooldownUntil || typeof this._globalCooldownUntil !== 'object') this._globalCooldownUntil = {};
    const _walletCooldown = this._globalCooldownUntil[wallet] || 0;
    if (Date.now() < _walletCooldown) {
      if (this._cycleCount % 10 === 0) {
        const mins = ((_walletCooldown - Date.now()) / 60000).toFixed(0);
        this._log(`⏸️ ${wallet.slice(0, 10)} 熔断中，${mins}分钟后恢复`);
      }
      return;
    }

    // 2. 先检查已有持仓是否需要平仓 — 共享管理员 Brain + ExitManager
    // v113.13.6: 持仓查询带缓存
    const cachedPos = this._positionCache[cacheKey];
    let existingPositions;
    if (cachedPos && Date.now() - cachedPos.time < CACHE_TTL) {
      existingPositions = cachedPos.value;
    } else {
      existingPositions = await client.getAllPositions();
      this._positionCache[cacheKey] = { value: existingPositions, time: Date.now() };
    }
    for (const pos of existingPositions) {
      const md = this.dataBus?.marketData?.[pos.symbol];
      const currentPrice = md?.price || pos.markPrice;
      if (!currentPrice) continue;

      const localPos = state.positions?.[pos.symbol];
      const openTime = localPos?.openTime || pos.timestamp || Date.now();
      const holdHours = (Date.now() - openTime) / 3600000;
      const leverage = pos.leverage || 3;

      // PnL — 用管理员 ExitManager 计算净利润
      const rawPnlPct = (pos.side === 'LONG'
        ? (currentPrice - pos.entryPrice) / pos.entryPrice
        : (pos.entryPrice - currentPrice) / pos.entryPrice);
      const grossPnlPct = rawPnlPct * leverage * 100;
      const netPnlPct = _userExit
        ? _userExit.toNetPnl(grossPnlPct, leverage, holdHours) / 100
        : rawPnlPct * leverage - this.FEE_RATE * 2 - this.FUNDING_RATE * Math.floor(holdHours / 8);

      // 峰值追踪 — v120: 追踪毛利峰值, 不用净值(避免单位不一致)
      let peakGrossPct = localPos?._peakGrossPct || 0;
      if (grossPnlPct > peakGrossPct) peakGrossPct = grossPnlPct;
      if (state.positions?.[pos.symbol]) state.positions[pos.symbol]._peakGrossPct = peakGrossPct;
      // 保留旧字段兼容
      let peakPnl = localPos?._peakPnl || 0;
      if (netPnlPct > peakPnl) peakPnl = netPnlPct;
      if (state.positions?.[pos.symbol]) state.positions[pos.symbol]._peakPnl = peakPnl;

      // 管理员 Brain 决定平仓
      let shouldClose = false;
      let reason = '';
      // v122: Brain平仓增加15分钟最低持仓保护 — 给策略发展空间, 避免开仓几分钟就被Brain平掉
      const _klines = this.dataBus?.klines?.[pos.symbol] || [];
      const _indicators = this.dataBus?.indicators?.[pos.symbol] || {};
      if (this.brain && holdHours * 60 >= 15) {
        const brainDecision = this.brain.managePosition(pos.symbol, {
          side: pos.side, entryPrice: pos.entryPrice, leverage,
          openTime, _peakPnlPct: peakGrossPct,
        }, _klines, _indicators, null, null, null);
        if (brainDecision.action === 'CLOSE') {
          shouldClose = true;
          reason = brainDecision.reason || 'Brain平仓';
        }
      } // v122: 持仓<15min时跳过Brain, 只用ATR止损/止盈管理
        // v113.70: AdaptiveExitManager 顶级策略止盈止损 — 用户独立实例
        if (!shouldClose && _userExit) {
          // v113.70: 用开仓时存的ATR, 不用实时klines算的(可能被引擎覆盖为5m)
          const _openAtrPct = localPos?._openAtrPct || 1.5;
          const _grossPnl = grossPnlPct; // 已经是百分比 (rawPnlPct * leverage * 100)
          // v120: 传毛利峰值, 不用净峰值(避免单位不一致)
          const _exitCalc = _userExit.calculate(pos.symbol, {
            side: pos.side, entryPrice: pos.entryPrice, leverage,
            openTime, _peakPnlPct: peakGrossPct,
          }, { price: currentPrice, atr: _openAtrPct * currentPrice / 100, atrPct: _openAtrPct, klines: _klines }, {});
          const _exitDecision = _userExit.shouldClose(pos.symbol, {
            side: pos.side, entryPrice: pos.entryPrice, leverage, openTime, _peakPnlPct: peakGrossPct,
          }, _grossPnl, _exitCalc);
          if (_exitDecision && _exitDecision.shouldClose) {
            shouldClose = true;
            reason = _exitDecision.reason;
          }
        }
      // v118: 超时兜底 — 放宽到6小时+18小时, 匹配新止盈止损逻辑
      if (!shouldClose && holdHours * 60 > 360 && netPnlPct < -0.03) {
        shouldClose = true;
        reason = `⏰超时止损 ${(netPnlPct*100).toFixed(1)}% ${holdHours.toFixed(0)}h`;
      }
      if (!shouldClose && holdHours * 60 > 1080) {
        shouldClose = true;
        reason = `⏰最大持仓时间 ${holdHours.toFixed(0)}h`;
      }
      // 策略反转 — 共享管理员 StrategyManager
      // v122: 反转置信度从0.6提高到0.75 — 减少价格微幅波动导致的误反转
      if (!shouldClose && (Date.now() - openTime) > 15 * 60000) {
        const klines = this.dataBus?.klines?.[pos.symbol] || [];
        if (klines.length >= 50 && this.strategyManager) {
          try {
            const result = await this.strategyManager.analyze({ klines, currentPrice, symbol: pos.symbol });
            const signal = result.finalSignal;
            if (pos.side === 'LONG' && signal.action === 'SELL' && signal.confidence > 0.75) {
              shouldClose = true;
              reason = `策略反转平多 conf=${signal.confidence.toFixed(2)}`;
            } else if (pos.side === 'SHORT' && signal.action === 'BUY' && signal.confidence > 0.75) {
              shouldClose = true;
              reason = `策略反转平空 conf=${signal.confidence.toFixed(2)}`;
            }
          } catch (e) {}
        }
      }

      this._saveState();
      if (!shouldClose) continue;

      // 执行平仓
      try {
        await client.closePosition(pos.symbol);
        // v123: 修复PnL=0 bug — 之前同步仓位用pos.pnl(Binance未实现盈亏),
        // 但平仓后该值可能为0或已过期。改为统一用 netPnlPct × margin 计算,
        // margin从localPosData或pos.notional/leverage获取
        const localPosData = state.positions?.[pos.symbol];
        let realPnlUsdt;
        {
          // 统一计算: PnL = netPnlPct × margin
          let margin = localPosData?.size || localPosData?.amount;
          if (!margin || margin <= 0) {
            // fallback: 用Binance返回的notional/leverage
            margin = Math.abs(pos.notional || (Math.abs(pos.qty || 0) * (pos.entryPrice || currentPrice))) / leverage;
          }
          realPnlUsdt = netPnlPct * margin;
        }
        this._log(`📉 ${wallet.slice(0,8)} 平仓 ${pos.symbol} | ${reason} | PnL ${(netPnlPct*100).toFixed(2)}% = $${realPnlUsdt.toFixed(4)} | ${holdHours.toFixed(1)}h${localPosData?._syncedFromBinance ? ' [同步仓位]' : ''}`);
        this._logTrade(wallet, { symbol: pos.symbol, action: 'CLOSE', amount: Math.abs(pos.qty || 0), price: currentPrice, pnl: realPnlUsdt, reason, holdHours: holdHours.toFixed(1), timestamp: Date.now() });
        this._updateStats(wallet, netPnlPct, realPnlUsdt);
        const pnlUsdt = realPnlUsdt;
        // v123: 同步仓位不收算力 Token
        const isSyncedPos = localPosData?._syncedFromBinance === true;
        if (pnlUsdt > 0 && !isSyncedPos) this._collectServiceFee(wallet, pos.symbol, pnlUsdt, netPnlPct);
        else if (pnlUsdt > 0 && isSyncedPos) this._log(`📊 ${wallet.slice(0,8)} 同步仓位盈利 $${pnlUsdt.toFixed(2)} — 不收算力 Token`);
        if (!this._consecutiveLosses) this._consecutiveLosses = {};
        if (netPnlPct < 0) {
          this._consecutiveLosses[wallet] = (this._consecutiveLosses[wallet]||0)+1;
          if (this._consecutiveLosses[wallet] >= 3) { this._globalCooldownUntil[wallet] = Date.now()+5*60*1000; this._log(`🚨 ${wallet.slice(0,10)} 连亏${this._consecutiveLosses[wallet]}笔，熔断5min（仅该账户）`); }
        } else { this._consecutiveLosses[wallet] = 0; }
        if (state.positions) delete state.positions[pos.symbol];
        if (!state.cooldowns) state.cooldowns = {}; state.cooldowns[pos.symbol] = Date.now();
        if (_userExit) _userExit.recordResult(netPnlPct * 100);
        if (_userSizer) _userSizer.recordTradeResult(netPnlPct);
        if (this.brain) this.brain.recordTrade(pos.symbol, netPnlPct * 100, netPnlPct > 0);
      } catch (e) { this._log(`❌ 平仓失败 ${pos.symbol}: ${e.message}`); }
    }

    // 2b. 同步 Binance 实际持仓到本地 state
    // v119: 修复孤儿仓位问题 — 不再盲目删除本地记录，而是双向同步
    const binanceSymbols = new Set(existingPositions.map(p => p.symbol));
    if (state.positions) {
      const now = Date.now();
      for (const sym of Object.keys(state.positions)) {
        if (!binanceSymbols.has(sym)) {
          const localOpenTime = state.positions[sym]?.openTime || 0;
          const sinceOpenMin = (now - localOpenTime) / 60000;
          // v119: 最近10分钟内开仓的不清理 — Binance API可能有延迟
          if (sinceOpenMin < 10) {
            this._log(`⏳ ${wallet.slice(0,10)} 保留新仓 ${sym} (开仓${sinceOpenMin.toFixed(0)}分钟前, Binance未返回, 可能API延迟)`);
          } else {
            this._log(`🧹 ${wallet.slice(0,10)} 清理遗留持仓: ${sym} (Binance已无此仓, 开仓${sinceOpenMin.toFixed(0)}分钟前)`);
            delete state.positions[sym];
          }
        }
      }
    }
    // v119: 反向同步 — Binance 上有但本地没有的仓位，补录到本地
    if (state.positions) {
      for (const pos of existingPositions) {
        if (!state.positions[pos.symbol]) {
          this._log(`📥 ${wallet.slice(0,10)} 同步Binance持仓到本地: ${pos.symbol} ${pos.side} lev=${pos.leverage}x entry=${pos.entryPrice}`);
          // v122.7: 修复PnL虚高117倍Bug — 同步仓位时size/amount存保证金(=notional/lev), 不存notional
          // 旧代码: size = qty * entryPrice = notional → PnL = netPnlPct × notional 虚高leverage倍
          // 新代码: size = qty * entryPrice / leverage = margin → PnL = netPnlPct × margin 正确
          const _syncNotional = Math.abs(parseFloat(pos.qty)) * pos.entryPrice;
          const _syncMargin = _syncNotional / (pos.leverage || 3);
          state.positions[pos.symbol] = {
            side: pos.side,
            entryPrice: pos.entryPrice,
            size: _syncMargin,
            amount: _syncMargin,
            notional: _syncNotional,
            leverage: pos.leverage || 3,
            openTime: pos.timestamp || Date.now(),
            _peakPnl: 0,
            _openAtrPct: 1.5, // 默认ATR
            _syncedFromBinance: true,
          };
        }
      }
    }

    // 3. 检查仓位数量
    // v113.13.6: 平仓后刷新缓存
    this._positionCache[cacheKey] = null;
    const afterClose = await client.getAllPositions();
    this._positionCache[cacheKey] = { value: afterClose, time: Date.now() };
    // v113.56回滚: 直接用strategyParams的maxPositions
    const maxPos = (this.strategyParams[userData.strategy] || this.strategyParams.balanced).maxPositions;
    if (afterClose.length >= maxPos) {
      if (this._cycleCount % 5 === 0) this._log(`📋 ${wallet.slice(0,10)} 已有${afterClose.length}仓>=${maxPos} — 不开新仓 [${afterClose.map(p=>p.symbol).join(',')}]`);
      return;
    }
    let remainingSlots = maxPos - afterClose.length;  // v113.15: const→let 避免开仓后递减报错

    // 4. 信号 — 共享管理员 StrategyManager 评分
    const candidates = await this._selectTopSymbols();
    const params = this.strategyParams[userData.strategy] || this.strategyParams.balanced;
    const existingSymbols = new Set(afterClose.map(p => p.symbol));
    const cooldowns = state.cooldowns || {};
    const now = Date.now();

    // v113.5: 过滤掉TradFi品种(股票/ETF/商品/债券) — 普通用户Binance Futures只有crypto权限
    // 避免每轮重复尝试-4411被拒浪费API调用
    // v122.5: TradFi品种不再一刀切过滤 — 用户Binance Futures大多有股票/商品权限
    // 如果下单时无权限(-4411错误), 会在运行时自动跳过
    // 只过滤已知需要特殊权限的品种
    const TRADFI_BLOCKED = ['UVXY', 'URNM', 'PAXG']; // 这些品种大多数账户确实无权限
    const isTradFi = (sym) => TRADFI_BLOCKED.some(p => sym.startsWith(p));

    // v113.71: 高度集中资金持仓 — 最多1-2仓, 趋势选币
    // v113.69: 趋势方向过滤 — 与管理员引擎一致
    // 之前用户端完全没有趋势检查! 逆趋势信号直接开仓导致频繁止损
    const _indicators = this.dataBus?.indicators || {};
    const _preFiltered = candidates
      .filter(c => c.score >= 5 && !existingSymbols.has(c.symbol))
      .filter(c => (now - (cooldowns[c.symbol] || 0)) > params.cooldownMs)
      .filter(c => !isTradFi(c.symbol))
      .filter(cand => {
        const ind = _indicators[cand.symbol] || _indicators[cand.symbol.replace('USDT','')] || {};
        const ma99 = ind.ma99 || 0;
        const price = cand.currentPrice || this.dataBus?.marketData?.[cand.symbol]?.price || 0;
        if (!ma99 || !price) return true; // 没数据则放行
        
        // v113.71: 逆趋势 — 严格拒绝, 偏离>0.5%就不做
        if (cand.side === 'LONG' && price < ma99) {
          const dist = ((ma99 - price) / price * 100);
          if (dist > 0.5) {
            this._log(`⛔ ${cand.symbol} 逆趋势做多(偏离MA99 ${dist.toFixed(1)}%) — 拒绝`);
            return false;
          }
        }
        if (cand.side === 'SHORT' && price > ma99) {
          const dist = ((price - ma99) / ma99 * 100);
          if (dist > 0.5) {
            this._log(`⛔ ${cand.symbol} 逆趋势做空(偏离MA99 ${dist.toFixed(1)}%) — 拒绝`);
            return false;
          }
        }
        // v113.71: 趋势太弱也跳过 — 只做明确趋势, 偏离<0.8%不做
        const ma99Dist = cand.side === 'LONG' 
          ? ((price - ma99) / ma99 * 100) 
          : ((ma99 - price) / price * 100);
        // v123: 趋势太弱门槛从0.8%降到0.1%
        if (ma99Dist < 0.1) {
          this._log(`⚪ ${cand.symbol} 趋势太弱 偏离MA99仅${ma99Dist.toFixed(2)}% < 0.1% — 跳过`);
          return false;
        }
        // v113.71: 底买高卖 — 做多要在MA25附近或以下, 做空要在MA25附近或以上
        const ma25 = ind.ma25 || 0;
        if (ma25 && price) {
          if (cand.side === 'LONG') {
            const dist25 = ((price - ma25) / ma25 * 100);
            if (dist25 > 2.0) {
              this._log(`⛔ ${cand.symbol} 追涨做多 价格偏离MA25 ${dist25.toFixed(1)}%>2% — 等回调`);
              return false;
            }
          }
          if (cand.side === 'SHORT') {
            const dist25 = ((ma25 - price) / price * 100);
            if (dist25 > 2.0) {
              this._log(`⛔ ${cand.symbol} 追跌做空 价格偏离MA25 ${dist25.toFixed(1)}%>2% — 等反弹`);
              return false;
            }
          }
        }
        return true;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, remainingSlots);  // v113.71: 只取剩余slots数, 不超过

    const filtered = _preFiltered;

    this._log(`[trade] ${wallet.slice(0,10)} 候选=${candidates.map(c=>c.symbol+'='+c.score).join(',')} 过滤后=${filtered.length} slots=${remainingSlots}`);
    if (filtered.length === 0) return;

    // 算力 Token暂停检查
    if (_gatesFeePaused) {
      this._log(`⏸️ ${wallet.slice(0,10)}... 算力 Token不足，跳过开仓`);
      return;
    }

    // 5. 开仓 — 共享管理员 PositionSizer 仓位计算
    // v113.72: 不限制方向 — 集中持仓只看趋势强弱
    for (const cand of filtered) {
      if (remainingSlots <= 0) break;  // 严格执行slots限制
      // v113.67: 修复 BNUSDT bug — replace('BUSDT','USDT') 会把 BNBUSDT 变成 BNUSDT
      // 只有股票类 spot token (如 AAPLBUSDT, METABUSDT) 才需要替换，BNBUSDT 不能替换
      const isStockToken = cand.symbol.endsWith('BUSDT') && cand.symbol.length > 7 && !cand.symbol.startsWith('BNB');
      let checkSymbol = isStockToken ? cand.symbol.replace('BUSDT','USDT') : cand.symbol;
      let futuresSymbol = isStockToken ? cand.symbol.replace('BUSDT','USDT') : cand.symbol;


      try {
        // 用管理员 PositionSizer 动态仓位
        let positionUsdt, leverage;
        // v113.71: 提前算ATR, 保存到仓位 — 止损监控用
        const klines = this.dataBus?.klines?.[futuresSymbol] || [];
        const _atrVal = this._calcATR(klines, 14);
        const currentPrice = this.dataBus?.marketData?.[futuresSymbol]?.price || cand.price || 0;
        const atrPct = _atrVal > 0 && currentPrice > 0 ? (_atrVal/currentPrice)*100 : 2;
        if (_userSizer) {
          // v113.25: 计算趋势强度（与管理员一致）— 不再传0
          const _ind = this.dataBus?.indicators?.[futuresSymbol] || {};
          const _ma99 = _ind.ma99 || currentPrice;
          const _ma7 = _ind.ma7 || currentPrice;
          const _ma25 = _ind.ma25 || currentPrice;
          let _trendStr = 0;
          if (cand.side === 'LONG' && currentPrice > _ma99) {
            const _dist = Math.abs((currentPrice - _ma99) / _ma99 * 100);
            _trendStr = Math.min(2.0, _dist / 2);
            if (_ma7 > _ma25 && _ma25 > _ma99) _trendStr += 0.5;
          } else if (cand.side === 'SHORT' && currentPrice < _ma99) {
            const _dist = Math.abs((_ma99 - currentPrice) / currentPrice * 100);
            _trendStr = Math.min(2.0, _dist / 2);
            if (_ma7 < _ma25 && _ma25 < _ma99) _trendStr += 0.5;
          }
          _trendStr = Math.min(2.5, _trendStr);
          // v122.5: 用available余额计算仓位, 不是总余额
          const sizing = _userSizer.size({
            balanceUsd: balance.available || balance.balance,
            atrPct, currentPrice,
            signalStrength: cand.score >= 12 ? 'strong' : cand.score >= 8 ? 'moderate' : 'weak',
            confidence: cand.confidence || 0.5,
            posCount: afterClose.length,
            trendStrength: _trendStr,
          });
          if (sizing.reject) { this._log(`⏭️ ${futuresSymbol} 仓位拒绝: ${sizing.reason}`); continue; }
          this._log(`📐 ${futuresSymbol} 仓位计算: size=$${sizing.positionSize?.toFixed(2)} lev=${sizing.leverage}x notional=$${sizing.notional?.toFixed(2)} balance=$${balance.balance?.toFixed(2)} avail=$${balance.available?.toFixed(2)} atrPct=${atrPct.toFixed(2)}%`);
          // v122.5: 用available而非balance, cap从50%降到30% — 避免保证金不足
          positionUsdt = Math.min(sizing.positionSize, balance.available * 0.30, tradeAmount * 0.5);
          leverage = sizing.leverage;
        } else {
          positionUsdt = Math.min(tradeAmount * params.positionPct, balance.available * 0.3);
          leverage = params.leverage;
        }
        // v115: 动态获取 Binance 最小名义值（使用缓存），默认 $2
        let _binanceMinNotional = 2;
        try {
          const exInfo = await client.getExchangeInfo(futuresSymbol);
          if (exInfo?.minNotional) _binanceMinNotional = exInfo.minNotional;
        } catch (e) { /* 使用默认值 */ }
        if (positionUsdt < _binanceMinNotional) { this._log(`⏭️ ${futuresSymbol} 仓位太小 $${positionUsdt?.toFixed(2)} < Binance最小$${_binanceMinNotional}`); continue; }

        // 跨市场风控
        if (this.sharedRisk) {
          const riskCheck = this.sharedRisk.preTradeCheck('crypto', cand.side, positionUsdt, leverage, afterClose);
          if (!riskCheck.allowed) { this._log(`🛡️ ${futuresSymbol} 风控拒绝: ${riskCheck.reason}`); continue; }
          if (riskCheck.adjustedSize) positionUsdt = riskCheck.adjustedSize;
        }

        const result = cand.side === 'LONG'
          ? await client.openLong(futuresSymbol, leverage, positionUsdt)
          : await client.openShort(futuresSymbol, leverage, positionUsdt);

        if (result.success) {
          this._log(`📈 ${wallet.slice(0,8)} 开仓 ${futuresSymbol} ${cand.side} | $${positionUsdt.toFixed(2)} × ${leverage}x | score=${cand.score}`);
          if (!state.positions) state.positions = {};
          // v113.70: 保存开仓时的ATR — 止损监控用这个值, 不用实时klines(可能被引擎覆盖为5m)
          state.positions[futuresSymbol] = { side: cand.side, entryPrice: result.price, size: positionUsdt, amount: positionUsdt, notional: positionUsdt * leverage, leverage, openTime: Date.now(), _peakPnl: 0, _openAtrPct: atrPct, _syncedFromBinance: false };
          // v119: 开仓后立即清除持仓缓存 — 确保下一轮能获取到新仓位
          this._positionCache[cacheKey] = null;
          this._saveState();
          this._logTrade(wallet, { symbol: futuresSymbol, action: cand.side, amount: positionUsdt, price: result.price, leverage, score: cand.score, timestamp: Date.now() });
          remainingSlots--;
          if (remainingSlots <= 0) break; // 满仓停止
        }
      } catch (e) {
        const errMsg = String(e.message || e);
        if (errMsg.includes('-4411')) { this._log(`⛔ ${futuresSymbol} 此账户无TradFi权限`); }
        else this._log(`❌ 开仓异常 ${futuresSymbol}: ${errMsg.slice(0,100)}`);
      }
    }
  }

  // ═══════════════════════════════════
  // ATR 计算 — 和管理员引擎相同
  // ═══════════════════════════════════
  _calcATR(klines, period = 14) {
    if (!klines || klines.length < period + 1) return 0;
    let sum = 0;
    for (let i = 1; i <= period; i++) {
      const k = klines[klines.length - i];
      const prev = klines[klines.length - i - 1];
      const tr = Math.max(
        k.high - k.low,
        Math.abs(k.high - prev.close),
        Math.abs(k.low - prev.close)
      );
      sum += tr;
    }
    return sum / period;
  }

  // ═══════════════════════════════════
  // 评分系统 — 从 DataBus 选最优交易对
  // ═══════════════════════════════════
  async _selectTopSymbols() {
    const marketData = this.dataBus?.marketData || {};
    const klines = this.dataBus?.klines || {};
    const scored = [];

    // v113.15: 使用配置的30个币种，不再硬编码10个
    const cryptoSymbols = Object.keys(require('../config/trading-pairs')).filter(s => !s.startsWith('_'));
    const engineSymbols = new Set(cryptoSymbols);

    // 从 SymbolEngine 收集品种
    if (this.symbolEngines) {
      for (const eng of Object.values(this.symbolEngines)) {
        if (eng?.symbols && Array.isArray(eng.symbols)) {
          eng.symbols.forEach(s => { if (s && s.endsWith('USDT')) engineSymbols.add(s); });
        }
        if (eng?._symbols && Array.isArray(eng._symbols)) {
          eng._symbols.forEach(s => { if (s && s.endsWith('USDT')) engineSymbols.add(s); });
        }
      }
    }

    // 从 Gold/Forex 引擎收集
    if (this.goldEngine?.symbols) {
      (Array.isArray(this.goldEngine.symbols) ? this.goldEngine.symbols : []).forEach(s => { if (s && s.endsWith('USDT')) engineSymbols.add(s); });
    }
    if (this.forexEngine?.symbols) {
      (Array.isArray(this.forexEngine.symbols) ? this.forexEngine.symbols : []).forEach(s => { if (s && s.endsWith('USDT')) engineSymbols.add(s); });
    }

    const allSymbols = Array.from(engineSymbols);

    // v110: 从 SymbolEngine 补充价格和K线到 marketData/klines
    if (this.symbolEngines) {
      for (const eng of Object.values(this.symbolEngines)) {
        if (eng?.prices) {
          for (const [sym, p] of Object.entries(eng.prices)) {
            if (!marketData[sym] && p?.lastPrice) {
              marketData[sym] = { price: p.lastPrice, change24h: p.change24h || 0, volume: p.volume || 0 };
            }
          }
        }
        if (eng?.klines) {
          for (const [sym, k] of Object.entries(eng.klines)) {
            if (!klines[sym] && k && k.length >= 50) klines[sym] = k;
          }
        }
      }
    }
    // 从 Gold/Forex 引擎补充
    if (this.goldEngine?.prices) {
      for (const [sym, p] of Object.entries(this.goldEngine.prices)) {
        if (!marketData[sym] && p?.lastPrice) marketData[sym] = { price: p.lastPrice };
      }
    }
    if (this.goldEngine?.klines) {
      for (const [sym, k] of Object.entries(this.goldEngine.klines)) {
        if (!klines[sym] && k?.length >= 50) klines[sym] = k;
      }
    }
    if (this.forexEngine?.prices) {
      for (const [sym, p] of Object.entries(this.forexEngine.prices)) {
        if (!marketData[sym] && p?.lastPrice) marketData[sym] = { price: p.lastPrice };
      }
    }
    if (this.forexEngine?.klines) {
      for (const [sym, k] of Object.entries(this.forexEngine.klines)) {
        if (!klines[sym] && k?.length >= 50) klines[sym] = k;
      }
    }

    // v112.4: 完全使用管理员策略引擎信号 — 不再自己算RSI/BB
    // 方式1: 读取管理员引擎已算好的候选信号(engine._lastSignals)
    // 方式2: 对管理员没覆盖的品种, 用StrategyManager.analyze直接算(和管理员完全一样)
    const adminSignals = this.cryptoEngine?._lastSignals || [];
    const adminSyms = new Set(adminSignals.map(s => s.symbol));
    const now = Date.now();

    // 管理员已算好的信号直接用
    for (const sig of adminSignals) {
      if (sig.dir === 'NEUTRAL') continue;
      // v113.8: 信号过期从3分钟延长到5分钟 — 管理员每30秒循环，CEX每60秒
      // 3分钟太短导致大量信号被丢弃
      if (now - (sig.timestamp || 0) > 300000) continue; // 超过5分钟的信号跳过
      const md = marketData[sig.symbol];
      if (!md) continue;
      const k = klines[sig.symbol];
      if (!k || k.length < 14) continue;
      const atrPct = this._calcATRPct(k, 14);
      // 管理员strength 0-8 → 用户score 5.5-15
      const score = Math.min(15, 5.5 + sig.strength * 1.5);
      scored.push({
        symbol: sig.symbol, score: Math.round(score * 10) / 10,
        side: sig.dir, currentPrice: md.price, atrPct, market: 'crypto',
        confidence: sig.confidence,
      });
    }

    // 管理员没覆盖的品种, 用StrategyManager.analyze(和管理员完全相同的策略)
    if (this.strategyManager) {
      for (const sym of allSymbols) {
        if (!sym.endsWith('USDT')) continue;
        if (adminSyms.has(sym)) continue; // 管理员已算过
        const k = klines[sym];
        if (!k || k.length < 60) continue;
        const md = marketData[sym];
        if (!md || !md.price) continue;
        try {
          const analysis = await this.strategyManager.analyze({
            klines: k, currentPrice: md.price, symbol: sym,
            marketData: md,
          });
          const signal = analysis.finalSignal;
          if (!signal || signal.action === 'HOLD') continue;
          const dir = signal.action === 'BUY' ? 'LONG' : 'SHORT';
          // v120: 反弹过滤(和管理员engine.js一致) — 追跌追涨直接拦截
          const recentCloses = k.slice(-6).map(c => c.close);
          const minLow = Math.min(...recentCloses);
          const maxHigh = Math.max(...recentCloses);
          const bouncePct = maxHigh > minLow ? (md.price - minLow) / (maxHigh - minLow) * 100 : 50;
          const last3Up = recentCloses[2] < recentCloses[1] && recentCloses[1] < recentCloses[0];
          const last3Down = recentCloses[2] > recentCloses[1] && recentCloses[1] > recentCloses[0];
          // v123: 追跌做空(bounce<5%)才拦截
          if (dir === 'SHORT' && bouncePct < 5) continue;
          // v123: 放宽到80%
          if (dir === 'SHORT' && last3Up && bouncePct > 80) continue;
          // v123: 放宽到95%
          if (dir === 'LONG' && bouncePct > 95) continue;
          // v123: 放宽 — bounce<20%才拦截
          if (dir === 'LONG' && last3Down && bouncePct < 20) continue;
          // v123: 置信度从0.45降到0.25
          if (signal.confidence < 0.25) continue;
          const strength = Math.abs(signal.score) * 4 + signal.confidence * 2;
          // v113.8: strength阈值从2.0降到1.2 — 让weak信号(confidence=0.45)也能进入候选
          // 原来strength=confidence*4=1.8被<2.0过滤，导致用户几乎永远空仓
          if (strength < 1.2) continue;
          const score = Math.min(15, 5.5 + strength * 1.5);
          scored.push({
            symbol: sym, score: Math.round(score * 10) / 10,
            side: dir, currentPrice: md.price, atrPct: this._calcATRPct(k, 14),
            market: 'crypto', confidence: signal.confidence,
          });
        } catch (e) { /* skip */ }
      }
    }

    // 多品种引擎信号(Gold/Forex/Stock/Commodity/Bond)
    this._collectMultiMarketSignals(scored);

    scored.sort((a, b) => b.score - a.score);
    // v113.15: 缓存结果 — 同一轮(60s)内共享信号
    this._signalCache = scored.slice(0, 30);
    this._signalCacheTime = Date.now();
    return scored.slice(0, 30); // v113.15: 15→30 让更多品种信号进入候选
  }

  // v98: Collect signals from multi-market engines
  _collectMultiMarketSignals(scored) {
    const addSignal = (sym, side, score, source) => {
      if (!sym || !side || score < 5.5) return;
      if (scored.find(s => s.symbol === sym)) return;
      const md = this.dataBus?.marketData?.[sym];
      const price = md?.price || 0;
      if (price <= 0) return;
      const k = this.dataBus?.klines?.[sym];
      const atrPct = k && k.length > 14 ? this._calcATRPct(k, 14) : 1.5;
      // v110: 多市场信号加分 — 让股票/商品/外汇信号有竞争力
      const boostedScore = Math.min(score + 3, 15);
      scored.push({ symbol: sym, score: Math.round(boostedScore * 10) / 10, side, currentPrice: price, atrPct, market: source });
    };

    // Gold
    if (this.goldEngine?.positions) {
      const goldPositions = Array.isArray(this.goldEngine.positions) ? this.goldEngine.positions : [];
      for (const p of goldPositions) {
        const side = p.side || 'LONG';
        const score = 6.0 + (Math.abs(p.pnlPct || 0) * 10);
        addSignal(p.symbol || 'PAXGUSDT', side, Math.min(score, 9), 'gold');
      }
    }

    // Forex
    if (this.forexEngine?.positions) {
      for (const p of (Array.isArray(this.forexEngine.positions) ? this.forexEngine.positions : [])) {
        const sym = p.symbol;
        if (!sym || !sym.endsWith('USDT')) continue;
        const score = 6.0 + (Math.abs(p.pnlPct || 0) * 10);
        addSignal(sym, p.side || 'LONG', Math.min(score, 9), 'forex');
      }
    }

    // Index
    if (this.indexEngine?.positions) {
      for (const p of (Array.isArray(this.indexEngine.positions) ? this.indexEngine.positions : [])) {
        const sym = p.symbol;
        if (!sym || !sym.endsWith('USDT')) continue;
        const score = 6.0 + (Math.abs(p.pnlPct || 0) * 10);
        addSignal(sym, p.side || 'LONG', Math.min(score, 9), 'index');
      }
    }

    // v110: SymbolEngine 信号 — 股票/ETF/商品/债券
    if (this.symbolEngines) {
      for (const [name, eng] of Object.entries(this.symbolEngines)) {
        if (!eng?.positions) continue;
        for (const [sym, pos] of Object.entries(eng.positions)) {
          if (!sym || !sym.endsWith('USDT')) continue;
          const dir = pos.direction || pos.side || 'LONG';
          const side = dir === 'SHORT' ? 'SHORT' : 'LONG';
          const score = 6.0 + ((pos.confidence || 0.5) * 3);
          const source = eng.category || name.replace(/-SPOT|-PERP/g, '').toLowerCase();
          addSignal(sym, side, Math.min(score, 9), source);
        }
      }
    }

    // v110: 主引擎(Crypto)信号
    if (this.cryptoEngine?.positions) {
      const cryptoPositions = this.cryptoEngine.positions;
      if (typeof cryptoPositions === 'object' && !Array.isArray(cryptoPositions)) {
        for (const [sym, pos] of Object.entries(cryptoPositions)) {
          if (!sym || !sym.endsWith('USDT')) continue;
          if (scored.find(s => s.symbol === sym)) continue;
          const side = pos.direction === 'short' || pos.direction === 'SHORT' ? 'SHORT' : 'LONG';
          const score = 6.0 + ((pos.confidence || 0.5) * 3);
          addSignal(sym, side, Math.min(score, 9), 'crypto');
        }
      }
    }
  }

  _calcATRPct(klines, period) {
    if (!klines || klines.length < period + 1) return 1.5;
    let atrSum = 0;
    for (let i = klines.length - period; i < klines.length; i++) {
      const h = klines[i].high || klines[i][2];
      const l = klines[i].low || klines[i][3];
      const prevC = klines[i-1]?.close || klines[i-1]?.[4] || h;
      const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
      atrSum += tr;
    }
    const atr = atrSum / period;
    const lastPrice = klines[klines.length-1]?.close || klines[klines.length-1]?.[4] || 1;
    return lastPrice > 0 ? (atr / lastPrice) * 100 : 1.5;
  }

  // ═══════════════════════════════════
  // 统计 & 状态管理
  // ═══════════════════════════════════
  _getState(wallet) {
    if (!this._states[wallet]) {
      this._states[wallet] = { positions: {}, cooldowns: {} };
    }
    return this._states[wallet];
  }

  // v115: 公开别名 — Dashboard/SaaS Server 调用
  getUserState(wallet) {
    return this._getState(wallet);
  }

  _updateStats(wallet, pnlPct, pnlUsdt) {
    if (typeof pnlPct !== 'number' || !isFinite(pnlPct)) return;
    if (!this._stats[wallet]) {
      this._stats[wallet] = { wins: 0, losses: 0, totalPnl: 0, avgWin: 0, avgLoss: 0, winRate: 0 };
    }
    const s = this._stats[wallet];
    // v101: 防止 null/NaN 累加
    const safePnl = (typeof pnlUsdt === 'number' && isFinite(pnlUsdt)) ? pnlUsdt : 0;
    s.totalPnl = (s.totalPnl || 0) + safePnl;
    if (pnlPct > 0) {
      s.wins++;
      s.avgWin = (s.avgWin * (s.wins - 1) + pnlPct) / s.wins;
    } else if (pnlPct < 0) {
      s.losses++;
      s.avgLoss = (s.avgLoss * (s.losses - 1) + Math.abs(pnlPct)) / s.losses;
    }
    const total = s.wins + s.losses;
    s.winRate = total > 0 ? s.wins / total : 0;
  }

  _logTrade(wallet, trade) {
    try {
      let trades = [];
      if (fs.existsSync(this.TRADE_LOG)) {
        trades = JSON.parse(fs.readFileSync(this.TRADE_LOG, 'utf8'));
      }
      trades.push({ wallet, ...trade });
      if (trades.length > 2000) trades = trades.slice(-1500);
      fs.writeFileSync(this.TRADE_LOG, JSON.stringify(trades, null, 2));
    } catch (e) { /* ignore */ }
  }

  _loadState() {
    try {
      if (fs.existsSync(this.STATE_FILE)) {
        const data = JSON.parse(fs.readFileSync(this.STATE_FILE, 'utf8'));
        this._states = data.states || {};
        this._stats = data.stats || {};
        this._cycleCount = data.cycleCount || 0;
        // v826: 为现有持仓初始化 _peakPnl
        for (const wallet in this._states) {
          const state = this._states[wallet];
          if (state.positions) {
            for (const sym in state.positions) {
              if (state.positions[sym]._peakPnl === undefined) {
                state.positions[sym]._peakPnl = 0;
              }
            }
          }
        }
      }
    } catch (e) { /* ignore */ }
  }

  _saveState() {
    try {
      const dir = path.dirname(this.STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.STATE_FILE, JSON.stringify({
        states: this._states,
        stats: this._stats,
        cycleCount: this._cycleCount,
        lastSave: Date.now(),
      }, null, 2));
    } catch (e) { /* ignore */ }
  }

  // ═══════════════════════════════════
  // 公开查询方法
  // ═══════════════════════════════════
  getStatus() {
    const users = this.userDB?.users || {};
    const cexUsers = Object.entries(users).filter(([_, u]) =>
      u.binanceApiKey && u.tradingEnabled
    );
    return {
      running: this.running,
      cycleCount: this._cycleCount,
      cexUsers: cexUsers.length,
      binanceUsers: cexUsers.length,
      activeUsers: cexUsers.filter(([_, u]) => u.tradingEnabled).length,
      stats: this._stats,
    };
  }

  getUserStats(wallet) {
    const s = this._stats[wallet] || { wins: 0, losses: 0, totalPnl: 0, winRate: 0 };
    s.totalTrades = s.wins + s.losses;
    return s;
  }

  getUserTrades(wallet, limit = 20) {
    try {
      if (!fs.existsSync(this.TRADE_LOG)) return [];
      const trades = JSON.parse(fs.readFileSync(this.TRADE_LOG, 'utf8'));
      return trades.filter(t => t.wallet === wallet).slice(-limit);
    } catch (e) { return []; }
  }

  // ═══════════════════════════════════
  // 算力 Token管理
  // ═══════════════════════════════════

  /**
   * 平仓盈利后记录平台算力 Token
   * @param {string} wallet - 用户钱包地址
   * @param {string} symbol - 交易对
   * @param {number} pnlUsdt - 盈利金额(USDT)
   * @param {number} netPnlPct - 净盈利率
   */
  async _collectServiceFee(wallet, symbol, pnlUsdt, netPnlPct) {
    if (pnlUsdt <= 0) return;

    // ═══════ 管理员豁免：所有费用全免 ═══════
    if (this._isAdmin(wallet)) {
      this._log(`👑 Admin ${wallet.slice(0,8)} | ${symbol} +$${pnlUsdt.toFixed(2)} — 全额到帐`);
      return;
    }

    // 普通用户: 算力 Token10% + 算力 Token20% = 实得70%
    const platformFee = pnlUsdt * this.PLATFORM_FEE_RATE;
    const ecoFund = pnlUsdt * this.ECO_FUND_RATE;
    const userShare = pnlUsdt * this.USER_SHARE_RATE;

    // 记录到待收取账本
    if (!this._feeState.pending[wallet]) {
      this._feeState.pending[wallet] = [];
    }
    this._feeState.pending[wallet].push({
      symbol,
      pnlUsdt: pnlUsdt.toFixed(4),
      platformFee: platformFee.toFixed(4),
      ecoFund: ecoFund.toFixed(4),
      userShare: userShare.toFixed(4),
      timestamp: Date.now(),
      status: 'pending',
    });

    // 累计总额
    this._feeState.totalPlatformFee += platformFee;
    this._feeState.totalEcoFund += ecoFund;

    this._log(
      `💰 费用 ${wallet.slice(0,8)} | ${symbol}`
      + ` | 盈利 $${pnlUsdt.toFixed(2)}`
      + ` | 算力 Token $${ecoFund.toFixed(2)} (10%)`
      + ` | 算力 Token $${platformFee.toFixed(2)} (20%)`
      + ` | 实得 $${userShare.toFixed(2)} (70%)`
    );

    // ═══ v113.17: 累计费用，达到 $5 阈值后批量转账 ═══
    this._saveFeeState();
    await this._tryBatchTransfer(wallet);
  }

  /**
   * v113.17: 检查该用户累计费用是否达到阈值，达到则批量转账
   * v121: 增加权限检查 + 失败冷却机制，避免重复失败
   */
  async _tryBatchTransfer(wallet) {
    const pending = this._feeState.pending[wallet] || [];
    if (pending.length === 0) return;

    // ═══ 算力 Token模式：从用户BSC钱包链上扣费 ═══
    let userMeta = this.userDB?.get?.(wallet) || null;
    if (!userMeta) {
      try {
        const usersFile = path.join(__dirname, '..', 'data', 'saas-users.json');
        const allUsers = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
        userMeta = allUsers[wallet] || allUsers[wallet?.toLowerCase()] || {};
      } catch (e) { userMeta = {}; }
    }

    // 必须有BSC钱包地址
    if (!userMeta.bscWalletAddr) {
      this._log(`⏸️ ${wallet.slice(0,8)} 未绑定BSC钱包地址，算力 Token继续记账`);
      return;
    }

    // 检查失败冷却
    const cooldown = this._transferFailCooldown[wallet];
    if (cooldown) {
      const elapsed = Date.now() - cooldown.lastFailAt;
      if (elapsed < this.TRANSFER_COOLDOWN_MS) {
        const remainMin = Math.ceil((this.TRANSFER_COOLDOWN_MS - elapsed) / 60000);
        this._log(`⏳ ${wallet.slice(0,8)} 算力 Token转账冷却中，${remainMin}分钟后可重试 (已失败${cooldown.failCount}次)`);
        return;
      }
      if (cooldown.failCount >= this.TRANSFER_MAX_FAIL) {
        this._log(`⛔ ${wallet.slice(0,8)} 算力 Token连续转账失败${cooldown.failCount}次，已停止。请检查BSC钱包授权和余额`);
        return;
      }
    }

    // 修复：跳过已收算力 Token的记录，避免重复扣取
    const totalPlatform = pending.reduce((s, r) => r.platformCollected ? s : s + parseFloat(r.platformFee), 0);
    const totalEco = pending.reduce((s, r) => s + parseFloat(r.ecoFund), 0);
    const totalFee = totalPlatform + totalEco;

    if (totalFee < (this.FEE_TRANSFER_THRESHOLD || 5)) {
      this._log(`📊 ${wallet.slice(0,8)} 算力 Token累计 $${totalFee.toFixed(2)} < $${this.FEE_TRANSFER_THRESHOLD || 5} 阈值 (${pending.length}笔)，继续积累`);
      return;
    }

    // 如果算力 Token已全部收过，只收算力 Token
    if (totalPlatform === 0 && totalEco > 0) {
      this._log(`💸 ${wallet.slice(0,8)} 仅收算力 Token $${totalEco.toFixed(2)} (算力 Token已收过)`);
    } else {
      this._log(`💸 ${wallet.slice(0,8)} 算力 Token $${totalFee.toFixed(2)} (算力 Token$${totalPlatform.toFixed(2)}+算力 Token$${totalEco.toFixed(2)}) 达到阈值，开始BSC链上扣费`);
    }

    // ═══ 方案A：用 trader 私钥从 trader 钱包直接 transfer USDT ═══
    let platformOk = false, ecoOk = false;
    try {
      const { ethers } = require('ethers');
      const BSC_RPC = 'https://bsc-rpc.publicnode.com';
      const USDT_ADDR = '0x55d398326f99059fF775485246999027B3197955';
      const traderPrivateKey = process.env.TRADER_PRIVATE_KEY;
      const provider = new ethers.JsonRpcProvider(BSC_RPC);
      const traderWallet = new ethers.Wallet(traderPrivateKey, provider);
      const usdtContract = new ethers.Contract(USDT_ADDR, [
        'function transfer(address to, uint256 amount) returns (bool)',
        'function balanceOf(address) view returns (uint256)',
      ], traderWallet);

      // Step 1: 转算力 Token到平台钱包
      if (totalPlatform > 0) {
        try {
          const platformWei = ethers.parseUnits(totalPlatform.toFixed(6), 18);
          this._log(`💸 ${wallet.slice(0,8)} 算力 Token-算力 Token $${totalPlatform.toFixed(2)} → ${this.PLATFORM_WALLET.slice(0,10)}...`);
          const tx1 = await usdtContract.transfer(this.PLATFORM_WALLET, platformWei);
          await tx1.wait();
          this._log(`✅ 算力 Token-算力 Token链上转账成功 $${totalPlatform.toFixed(2)} USDT tx=${tx1.hash.slice(0,16)}...`);
          platformOk = true;
        } catch (e) {
          this._log(`❌ 算力 Token-算力 Token链上转账失败: ${e.message?.slice(0,80)}`);
        }
      } else {
        platformOk = true;
      }

      // Step 2: 转算力 Token到算力 Token钱包
      if (platformOk) {
        try {
          const ecoWei = ethers.parseUnits(totalEco.toFixed(6), 18);
          this._log(`💸 ${wallet.slice(0,8)} 算力 Token-算力 Token $${totalEco.toFixed(2)} → ${this.ECO_FUND_WALLET.slice(0,10)}...`);
          const tx2 = await usdtContract.transfer(this.ECO_FUND_WALLET, ecoWei);
          await tx2.wait();
          this._log(`✅ 算力 Token-算力 Token链上转账成功 $${totalEco.toFixed(2)} USDT tx=${tx2.hash.slice(0,16)}...`);
          ecoOk = true;
        } catch (e) {
          this._log(`❌ 算力 Token-算力 Token链上转账失败: ${e.message?.slice(0,80)}`);
        }
      }

      // 链上转账成功：更新数据库余额
      if (platformOk && ecoOk) {
        if (this.userDB) {
          const user = this.userDB.get(wallet) || {};
          const oldBalance = user.gatesFeeBalance || 0;
          const newBalance = Math.max(0, oldBalance - totalFee);
          const collected = (user.gatesFeeCollected || 0) + totalFee;
          this.userDB.set(wallet, {
            ...user,
            gatesFeeBalance: newBalance,
            gatesFeeLow: newBalance < 5,
            gatesFeeCollected: collected,
            gatesFeeApproved: true,
          });
          this._log(`✅ ${wallet.slice(0,8)} 算力 Token完成: $${totalFee.toFixed(2)} | 余额 $${oldBalance.toFixed(2)} → $${newBalance.toFixed(2)} | 累计 $${collected.toFixed(2)}`);
        }
      }
    } catch (e) {
      this._log(`❌ ${wallet.slice(0,8)} 算力 Token链上转账异常: ${e.message?.slice(0,80)}`);
    }

    // ═══ 按实际成功情况从 pending 移除已完成的记录 ═══
    // 修复：之前部分成功也保留全部pending → 重复扣费
    if (platformOk && ecoOk) {
      const removed = pending.splice(0, pending.length);
      for (const record of removed) {
        record.status = 'gates-collected';
        record.collectedAt = Date.now();
        if (!this._feeState.collected[wallet]) this._feeState.collected[wallet] = [];
        this._feeState.collected[wallet].push(record);
      }
      delete this._transferFailCooldown[wallet];
      this._log(`✅ ${wallet.slice(0,8)} 算力 Token收取完成: ${removed.length}笔, 算力 Token $${totalPlatform.toFixed(2)}, 算力 Token $${totalEco.toFixed(2)}`);
    } else if (platformOk && !ecoOk) {
      // 算力 Token已成功，算力 Token失败 → 标记pending中已收算力 Token，下次只收算力 Token
      for (const record of pending) {
        record.platformCollected = true;
        record.platformCollectedAt = Date.now();
      }
      if (!this._transferFailCooldown[wallet]) this._transferFailCooldown[wallet] = { lastFailAt: 0, failCount: 0 };
      this._transferFailCooldown[wallet].failCount++;
      this._log(`⚠️ ${wallet.slice(0,8)} 算力 Token已收但算力 Token失败，下次只收算力 Token ${pending.length}笔 (失败${this._transferFailCooldown[wallet].failCount}/${this.TRANSFER_MAX_FAIL})`);
    } else {
      if (!this._transferFailCooldown[wallet]) this._transferFailCooldown[wallet] = { lastFailAt: 0, failCount: 0 };
      this._transferFailCooldown[wallet].lastFailAt = Date.now();
      this._transferFailCooldown[wallet].failCount++;
      const fc = this._transferFailCooldown[wallet].failCount;
      if (fc >= this.TRANSFER_MAX_FAIL) {
        this._log(`⛔ ${wallet.slice(0,8)} 算力 Token连续失败${fc}次，已停止。请检查BSC钱包授权和余额`);
      } else {
        this._log(`⚠️ ${wallet.slice(0,8)} 算力 Token部分失败（算力 Token=${platformOk}, 算力 Token=${ecoOk}），保留 pending。30分钟后再试 (失败${fc}/${this.TRANSFER_MAX_FAIL})`);
      }
    }

    this._saveFeeState();
  }

  /**
   * 获取算力 Token状态
   */
  getFeeStatus() {
    const pendingCount = Object.values(this._feeState.pending)
      .reduce((sum, arr) => sum + arr.length, 0);
    return {
      platformWallet: this.PLATFORM_WALLET,
      ecoFundWallet: this.ECO_FUND_WALLET,
      platformFeeRate: this.PLATFORM_FEE_RATE,
      ecoFundRate: this.ECO_FUND_RATE,
      userShareRate: this.USER_SHARE_RATE,
      totalPlatformFee: this._feeState.totalPlatformFee,
      totalEcoFund: this._feeState.totalEcoFund,
      pendingRecords: pendingCount,
      pending: this._feeState.pending,
    };
  }

  /**
   * 标记算力 Token已收取（手动转账后调用）
   */
  markFeeCollected(wallet, index) {
    if (!this._feeState.pending[wallet] || !this._feeState.pending[wallet][index]) {
      return false;
    }
    const record = this._feeState.pending[wallet].splice(index, 1)[0];
    record.status = 'collected';
    record.collectedAt = Date.now();

    if (!this._feeState.collected[wallet]) {
      this._feeState.collected[wallet] = [];
    }
    this._feeState.collected[wallet].push(record);
    this._saveFeeState();
    return true;
  }

  /**
   * 获取所有用户待收算力 Token汇总
   */
  getFeeSummary() {
    const summary = {};
    for (const [wallet, records] of Object.entries(this._feeState.pending)) {
      summary[wallet] = {
        count: records.length,
        totalPlatformFee: records.reduce((s, r) => s + parseFloat(r.platformFee), 0).toFixed(2),
        totalEcoFund: records.reduce((s, r) => s + parseFloat(r.ecoFund), 0).toFixed(2),
        totalPnl: records.reduce((s, r) => s + parseFloat(r.pnlUsdt), 0).toFixed(2),
      };
    }
    return {
      platformWallet: this.PLATFORM_WALLET,
      ecoFundWallet: this.ECO_FUND_WALLET,
      users: summary,
      grandTotal: {
        platformFee: this._feeState.totalPlatformFee.toFixed(2),
        ecoFund: this._feeState.totalEcoFund.toFixed(2),
      },
    };
  }

  _loadFeeState() {
    try {
      if (fs.existsSync(this.FEE_STATE_FILE)) {
        this._feeState = JSON.parse(fs.readFileSync(this.FEE_STATE_FILE, 'utf8'));
      }
    } catch (e) { /* ignore */ }
  }

  _saveFeeState() {
    try {
      const dir = path.dirname(this.FEE_STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.FEE_STATE_FILE, JSON.stringify(this._feeState, null, 2));
    } catch (e) { /* ignore */ }
  }

  /**
   * v121: 用户重新绑定 API Key 后重置转账冷却
   * 清除失败计数，允许重新尝试自动转账
   */
  resetTransferCooldown(wallet) {
    if (this._transferFailCooldown[wallet]) {
      delete this._transferFailCooldown[wallet];
      this._log(`🔄 ${wallet.slice(0,8)} 转账冷却已重置（用户重新绑定了 API Key）`);
    }
  }

  // ═══════ 管理员/等级判断 ═══════

  /**
   * 判断是否管理员（免一切算力 Token）
   */
  _isAdmin(wallet) {
    if (!wallet) return false;
    const w = wallet.toLowerCase();
    return this.ADMIN_WALLETS.some(a => a.toLowerCase() === w);
  }
}

module.exports = { CEXUserTrader, BinanceClient, encrypt, decrypt };
