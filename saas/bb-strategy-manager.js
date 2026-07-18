/**
 * BBStrategyManager — 多用户布林带策略管理器
 * 
 * 核心设计：
 *   - 每个用户独立的 BBEngine 实例（独立 API Key、独立持仓、独立状态）
 *   - 共享策略逻辑（选币、布林带计算、插针过滤等）
 *   - 共享 Binance 公开行情数据（24h ticker、K线）— 减少API调用
 *   - 用户之间互不干扰
 *   - 管理员也是普通用户之一（用管理员 API Key）
 * 
 * 集成方式：
 *   - 被 saas/start.js 启动
 *   - 被 saas/server.js 的 /api/dashboard 调用获取用户BB持仓
 *   - 被 dashboard/server.js 的 /api/bb-strategy 调用获取管理员+所有用户BB数据
 */

const fs = require('fs');
const path = require('path');
const { BBEngine, BinanceAPI, Indicators, CONFIG } = require('../bb-engine');

// 加密/解密
const { decrypt } = require('../core/crypto-utils');

// ════════════════════════════════════════
//  共享行情缓存 — 所有用户共用
// ════════════════════════════════════════
class SharedMarketData {
  constructor() {
    this._tickers = null;
    this._tickersTime = 0;
    this._klineCache = {}; // symbol → { data, time }
    this._precisionMap = null;
    this._precisionTime = 0;
    this.TICKER_TTL = 60000;   // 60秒缓存（增大减少API请求）
    this.KLINE_TTL = 120000;   // 120秒缓存（5分钟K线，2分钟缓存不影响信号）
    this.PRECISION_TTL = 3600000; // 1小时缓存
  }

  async getAllTickers() {
    const now = Date.now();
    if (this._tickers && now - this._tickersTime < this.TICKER_TTL) {
      return this._tickers;
    }
    try {
      const data = await this._get('/fapi/v1/ticker/24hr');
      if (Array.isArray(data)) {
        this._tickers = data;
        this._tickersTime = now;
      }
      return this._tickers || data;
    } catch (e) {
      // API失败时返回旧缓存（如果有）
      if (this._tickers) {
        return this._tickers;
      }
      throw e;
    }
  }

  async getKlines(symbol, interval, limit) {
    const key = `${symbol}_${interval}_${limit}`;
    const now = Date.now();
    const cached = this._klineCache[key];
    if (cached && now - cached.time < this.KLINE_TTL) {
      return cached.data;
    }
    try {
      const data = await this._get(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
      if (!Array.isArray(data)) throw new Error('klines data invalid');
      const parsed = data.map(k => ({
        time: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }));
      this._klineCache[key] = { data: parsed, time: now };
      return parsed;
    } catch (e) {
      if (cached) return cached.data;
      throw e;
    }
  }

  async getExchangeInfo() {
    const now = Date.now();
    if (this._precisionMap && now - this._precisionTime < this.PRECISION_TTL) {
      return this._precisionMap;
    }
    try {
      const info = await this._get('/fapi/v1/exchangeInfo');
      if (!info || !info.symbols || !Array.isArray(info.symbols)) {
        throw new Error('exchangeInfo data invalid');
      }
      const precisionMap = {};
      for (const s of info.symbols) {
        const stepSize = s.filters.find(f => f.filterType === 'LOT_SIZE')?.stepSize || '0.001';
        precisionMap[s.symbol] = { stepSize, qtyPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision };
      }
      this._precisionMap = precisionMap;
      this._precisionTime = now;
      return precisionMap;
    } catch (e) {
      // API失败时返回旧缓存
      if (this._precisionMap) {
        return this._precisionMap;
      }
      throw e;
    }
  }

  _get(endpoint) {
    return new Promise((resolve, reject) => {
      const https = require('https');
      const url = `https://fapi.binance.com${endpoint}`;
      https.get(url, { timeout: 10000 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`Parse error: ${data.substring(0, 100)}`)); }
        });
      }).on('error', reject);
    });
  }
}

// ════════════════════════════════════════
//  单用户 BB Engine 实例
//  继承 BBEngine，覆盖 API 调用使用共享行情
// ════════════════════════════════════════
class UserBBEngine extends BBEngine {
  constructor(apiKey, apiSecret, wallet, sharedData) {
    super(apiKey, apiSecret);
    this.wallet = wallet;
    this.sharedData = sharedData;
    
    // 独立状态文件（每用户一个）
    this._stateFile = path.join(__dirname, '..', 'data', `bb-user-${wallet.slice(0, 10)}.json`);
    
    // 覆盖 CONFIG 的 stateFile
    this._log(`UserBBEngine 初始化 | wallet=${wallet.slice(0, 10)}...`);
  }

  // 覆盖：使用共享行情数据
  async _fetchSharedTickers() {
    return this.sharedData.getAllTickers();
  }

  async _fetchSharedKlines(symbol, interval, limit) {
    return this.sharedData.getKlines(symbol, interval, limit);
  }

  async _fetchSharedPrecision() {
    return this.sharedData.getExchangeInfo();
  }

  // 覆盖选币：用共享 ticker
  async selectSymbols() {
    this._log('📊 开始选币...');
    
    const allTickers = await this.sharedData.getAllTickers();
    if (!Array.isArray(allTickers)) {
      this._log('⚠️ 选币失败: tickers数据无效');
      return { top50: [], floatProfitSymbols: [] };
    }
    
    const usdtPerps = allTickers.filter(t => 
      t.symbol.endsWith('USDT') && 
      parseFloat(t.quoteVolume) > 0 &&
      !t.symbol.includes('_')
    );

    usdtPerps.sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
    const top50 = usdtPerps.slice(0, CONFIG.topN).map(t => ({
      symbol: t.symbol,
      volume: parseFloat(t.quoteVolume),
      price: parseFloat(t.lastPrice),
      changePct: parseFloat(t.priceChangePercent),
    }));

    this._log(`✅ 前50强选币完成，Top5: ${top50.slice(0, 5).map(t => t.symbol).join(', ')}`);

    const floatProfitSymbols = [];
    for (const [sym, pos] of Object.entries(this.positions)) {
      const pnlPct = this._calcPnlPct(pos, pos.currentPrice || pos.entryPrice);
      if (Math.abs(pnlPct) <= CONFIG.floatProfitPct) {
        floatProfitSymbols.push(sym);
      }
    }

    return { top50, floatProfitSymbols };
  }

  // 覆盖扫描中的K线获取：用共享缓存
  async _scan() {
    // ── 0. 定期刷新余额 ──
    // 余额=0时每3轮尝试刷新（避免加剧API限流）
    // 余额正常时每10轮刷新一次
    const needRefresh = (!this.balance || this.balance <= 0) 
      ? (this._scanCount % 3 === 0)
      : (this._scanCount % 10 === 0);
    if (needRefresh) {
      try {
        const newBal = await this.api.getBalance();
        if (newBal !== this.balance) {
          this._log(`💰 余额刷新: $${newBal.toFixed(2)} (原$${(this.balance||0).toFixed(2)})`);
        }
        this.balance = newBal;
      } catch (e) {
        this._log(`⚠️ 余额刷新失败: ${e.message}`);
        // API失败时用fallback余额
        if ((!this.balance || this.balance <= 0) && this._fallbackBalance > 0) {
          this.balance = this._fallbackBalance;
          this._log(`💰 使用缓存余额: $${this.balance.toFixed(2)}`);
        }
      }
    }

    // ── 0.5 定期刷新 precisionMap（精度表，开仓必需）──
    const needPrecision = !this.precisionMap || Object.keys(this.precisionMap).length === 0
      ? (this._scanCount % 3 === 0)
      : (this._scanCount % 30 === 0);
    if (needPrecision) {
      try {
        this.precisionMap = await this.sharedData.getExchangeInfo();
        if (Object.keys(this.precisionMap).length > 0) {
          this._log(`📐 精度表已刷新: ${Object.keys(this.precisionMap).length}个交易对`);
        }
      } catch (e) {
        this._log(`⚠️ 精度表刷新失败: ${e.message}`);
      }
    }

    // ── 1. 选币 ──
    const { top50 } = await this.selectSymbols();
    const candidateSymbols = top50.map(t => t.symbol);

    // ── 2. 同步已有持仓 ──
    await this._syncPositions();

    // ── 3. 管理现有持仓 ──
    const activePositionSymbols = Object.keys(this.positions);
    
    for (const symbol of activePositionSymbols) {
      const pos = this.positions[symbol];
      
      try {
        const klines = await this.sharedData.getKlines(symbol, CONFIG.klineInterval, CONFIG.klineLimit);
        if (klines.length < 60) continue;

        const pinCheck = this.checkPinBar(klines);
        if (!pinCheck.valid) {
          continue;
        }

        const lastClose = klines[klines.length - 1].close;
        pos.currentPrice = lastClose;

        // 单K线止损
        const slResult = this.checkSingleKStopLoss(klines, pos);
        if (slResult.action === 'CLOSE') {
          this._log(`🔴 ${symbol} ${slResult.reason}`);
          await this._closePosition(symbol, pos, slResult.reason);
          continue;
        }

        // 终极止损
        const ultimateResult = this.checkUltimateStopLoss(pos);
        if (ultimateResult.action === 'CLOSE') {
          this._log(`🔴 ${symbol} ${ultimateResult.reason}`);
          await this._closePosition(symbol, pos, ultimateResult.reason);
          continue;
        }

        // 特殊时间检查
        const specialTime = await this.checkSpecialTime(symbol);
        const specialTimeBlocked = specialTime.blocked;

        // 止盈检查
        const tpResult = this.checkTakeProfit(klines, pos);
        if (tpResult.action === 'CLOSE') {
          this._log(`✅ ${symbol} ${tpResult.reason}`);
          await this._closePosition(symbol, pos, tpResult.reason);
          continue;
        }

        // 补仓检查
        if (!specialTimeBlocked) {
          const repResult = await this.checkReplenish(klines, pos);
          if (repResult.action === 'REPLENISH') {
            this._log(`📈 ${symbol} ${repResult.reason}`);
            await this._replenishPosition(symbol, pos, repResult.amount);
            continue;
          }
        }

        // 记录状态
        const pnlPct = this._calcPnlPct(pos, lastClose);
        const pnlUsd = this._calcPnlUsd(pos, lastClose);
        // 减少日志频率：每5轮才打一次
        if (this._scanCount % 5 === 0) {
          this._log(`📊 ${symbol} ${pos.side} PnL=${pnlPct.toFixed(2)}%($${pnlUsd.toFixed(2)}) 补仓=${pos.replenishCount}/3`);
        }

      } catch (e) {
        if (this._scanCount % 10 === 0) {
          this._log(`⚠️ ${symbol} 管理异常: ${e.message}`);
        }
      }
    }

    // ── 4. 开仓新币种 ──
    const positionCount = Object.keys(this.positions).length;
    if (positionCount >= CONFIG.maxPositions) {
      this._saveState();
      return;
    }

    // 盖茨费不足时不开新仓，只管理现有持仓
    if (this.gatesFeePaused) {
      this._saveState();
      return;
    }

    const symbolsToScan = candidateSymbols.filter(s => !this.positions[s]);
    
    for (const symbol of symbolsToScan) {
      if (Object.keys(this.positions).length >= CONFIG.maxPositions) break;

      try {
        const specialTime = await this.checkSpecialTime(symbol);
        if (specialTime.blocked) continue;

        const klines = await this.sharedData.getKlines(symbol, CONFIG.klineInterval, CONFIG.klineLimit);
        if (klines.length < 120) continue;

        const pinCheck = this.checkPinBar(klines);
        if (!pinCheck.valid) continue;

        const openCheck = this.checkOpenCondition(klines);
        if (!openCheck.allowed) continue;

        this._log(`🟢 ${symbol} ${openCheck.direction} 信号: ${openCheck.reason}`);
        await this._openPosition(symbol, openCheck.direction, klines);

      } catch (e) {
        // 静默忽略
      }
    }

    this._saveState();
  }

  // 覆盖 start：使用共享 precisionMap
  async start() {
    this.running = true;
    this._scanCount = 0;
    this._log('🚀 UserBBEngine 启动');

    this._loadState();

    // 用共享 precisionMap
    try {
      this.precisionMap = await this.sharedData.getExchangeInfo();
      this._log(`✅ 交易对精度已加载`);
    } catch (e) {
      this._log(`⚠️ 获取精度失败: ${e.message}`);
      this.precisionMap = {};
    }

    // 余额用各户自己的 API
    try {
      this.balance = await this.api.getBalance();
      this._log(`💰 余额: $${this.balance.toFixed(2)}`);
    } catch (e) {
      this._log(`⚠️ 余额查询失败: ${e.message}`);
      // 使用fallback余额（从saas-users.json读取的usdtBalance）
      this.balance = this._fallbackBalance || 0;
      if (this.balance > 0) {
        this._log(`💰 使用缓存余额: $${this.balance.toFixed(2)}`);
      }
    }

    await this._syncPositions();

    // 启动循环
    this._loop();
  }

  async _loop() {
    while (this.running) {
      this._scanCount++;
      try {
        await this._scan();
      } catch (e) {
        this._log(`❌ 扫描异常: ${e.message}`);
      }
      await this._sleep(CONFIG.scanIntervalMs);
    }
  }

  // 覆盖状态文件路径
  _saveState() {
    try {
      const dir = path.dirname(this._stateFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._stateFile, JSON.stringify({
        positions: this.positions,
        savedAt: Date.now(),
      }, null, 2));
    } catch (e) { /* ignore */ }
  }

  _loadState() {
    try {
      if (fs.existsSync(this._stateFile)) {
        const data = JSON.parse(fs.readFileSync(this._stateFile, 'utf8'));
        this.positions = data.positions || {};
        this._log(`📂 加载状态: ${Object.keys(this.positions).length}个持仓`);
      }
    } catch (e) { /* ignore */ }
  }

  // 获取状态摘要
  getSummary() {
    const positions = [];
    let totalPnlUsd = 0;
    let totalPnlPct = 0;
    
    for (const [sym, pos] of Object.entries(this.positions)) {
      const pnlPct = this._calcPnlPct(pos, pos.currentPrice || pos.entryPrice);
      const pnlUsd = this._calcPnlUsd(pos, pos.currentPrice || pos.entryPrice);
      totalPnlUsd += pnlUsd;
      totalPnlPct += pnlPct;
      positions.push({
        symbol: sym,
        side: pos.side,
        qty: pos.qty,
        entryPrice: pos.entryPrice,
        currentPrice: pos.currentPrice || pos.entryPrice,
        leverage: pos.leverage,
        pnlPct: parseFloat(pnlPct.toFixed(2)),
        pnlUsd: parseFloat(pnlUsd.toFixed(2)),
        replenishCount: pos.replenishCount,
        mode: pos.mode || '轨道',
        margin: pos.margin,
        openTime: pos.openTime,
      });
    }

    return {
      wallet: this.wallet,
      balance: this.balance,
      positionCount: positions.length,
      maxPositions: CONFIG.maxPositions,
      positions,
      totalPnlUsd: parseFloat(totalPnlUsd.toFixed(2)),
      totalPnlPct: parseFloat(totalPnlPct.toFixed(2)),
      running: this.running,
      gatesFeePaused: !!this.gatesFeePaused,
    };
  }
}

// ════════════════════════════════════════
//  BBStrategyManager — 多用户管理器
// ════════════════════════════════════════
class BBStrategyManager {
  constructor(opts = {}) {
    this.userDB = opts.userDB || null;
    this.intervalMs = opts.intervalMs || 30000;
    this.running = false;
    this._timer = null;
    this._cycleCount = 0;
    
    // 共享行情数据
    this.sharedData = new SharedMarketData();
    
    // 用户引擎实例池 { wallet → UserBBEngine }
    this._engines = {};
    
    // 管理员钱包
    this.ADMIN_WALLETS = [
      '0xfa3b90c574469909d20848273c06752a22fde74a',
      '0xe6ddf0771c7610dba77eb5a07ba7771dd7f5e91e',
    ];
    
    // 管理员 API Key（从 .env）
    this.adminApiKey = process.env.BINANCE_API_KEY || '';
    this.adminApiSecret = process.env.BINANCE_API_SECRET || '';
    
    this.STATE_FILE = path.join(__dirname, '..', 'data', 'bb-strategy-stats.json');
    this.STRATEGY_FILE = path.join(__dirname, '..', 'data', 'active-strategy.json');
    this._stats = {}; // wallet → { wins, losses, totalPnl, trades }
    this._loadStats();
    
    this._log('BBStrategyManager 初始化');
  }

  // 全局策略控制
  getActiveStrategy() {
    try {
      const cfg = JSON.parse(fs.readFileSync(this.STRATEGY_FILE, 'utf8'));
      return cfg.activeStrategy || 'bb';
    } catch (e) { return 'bb'; }
  }
  
  setActiveStrategy(strategy) {
    const cfg = { activeStrategy: strategy, lastSwitch: new Date().toISOString(), switchedBy: 'admin' };
    fs.writeFileSync(this.STRATEGY_FILE, JSON.stringify(cfg, null, 2));
    this._log(`📌 全局策略切换为: ${strategy === 'bb' ? 'B策略' : 'A策略'}`);
    return cfg;
  }
  
  // 检查当前是否应该跑BB策略
  isBBActive() {
    return this.getActiveStrategy() === 'bb';
  }

  _log(msg) {
    console.log(`[BB-Strategy] ${new Date().toISOString()} ${msg}`);
  }

  // ═══ 启动/停止 ═══
  start() {
    if (this.running) return;
    this.running = true;
    this._locked = true; // B策略专用模式：锁定，不允许外部停止
    this._log('🚀 BBStrategyManager 启动 (锁定模式 — 不会自动停止)');
    this._loop();
  }

  stop() {
    // B策略专用模式：不允许外部stop
    if (this._locked) {
      this._log('⚠️ stop() 被忽略 — B策略锁定模式，不能停止');
      return;
    }
    this.running = false;
    if (this._timer) clearTimeout(this._timer);
    for (const engine of Object.values(this._engines)) {
      engine.stop();
    }
    this._log('BBStrategyManager 停止');
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

  // ═══ 引擎看门狗：检查所有引擎running状态，停了就自动重启 + 停机告警 ═══
  _watchdog() {
    let revived = 0;
    for (const [wallet, engine] of Object.entries(this._engines)) {
      if (!engine.running) {
        this._log(`🐕 看门狗: ${wallet.slice(0,10)}... 引擎已停，自动重启`);
        engine.start().catch(e => {
          this._log(`❌ 看门狗重启失败 ${wallet.slice(0,10)}...: ${e.message}`);
        });
        revived++;
      }
    }
    if (revived > 0) {
      this._log(`🐕 看门狗: 重启了 ${revived} 个引擎`);
    }
    
    // ═══ 停机告警：检测管理器自身是否正常运行，记录心跳 ═══
    const now = Date.now();
    if (!this._lastHeartbeat) {
      this._lastHeartbeat = now;
      this._heartbeatFile = path.join(__dirname, '..', 'data', 'bb-manager-heartbeat.json');
    }
    // 每5轮写一次心跳文件（约150秒）
    if (this._cycleCount % 5 === 0) {
      try {
        fs.writeFileSync(this._heartbeatFile, JSON.stringify({
          timestamp: now,
          cycleCount: this._cycleCount,
          engineCount: Object.keys(this._engines).length,
          engines: Object.entries(this._engines).map(([w, e]) => ({
            wallet: w.slice(0, 10) + '...',
            running: e.running,
            positions: Object.keys(e.positions || {}).length,
          })),
        }, null, 2));
      } catch (e) { /* ignore */ }
    }
    this._lastHeartbeat = now;
  }

  async _cycle() {
    this._cycleCount++;
    
    // B策略锁定模式：不检查全局策略文件，始终运行BB策略
    // （A策略已停止，不存在切换逻辑）
    if (this._locked) {
      // 跳过策略切换检查，直接执行BB策略
    } else if (!this.isBBActive()) {
      if (this._cycleCount % 20 === 0) {
        this._log(`第${this._cycleCount}轮: 全局策略为A策略，BB引擎暂停`);
      }
      // 清理所有引擎
      for (const [wallet, engine] of Object.entries(this._engines)) {
        this._log(`🛑 停止用户 ${wallet.slice(0, 10)}... BB引擎（切换到A策略）`);
        engine.stop();
        delete this._engines[wallet];
      }
      return;
    }
    
    // 每轮重新读取用户文件
    try {
      const usersFile = path.join(__dirname, '..', 'data', 'saas-users.json');
      if (fs.existsSync(usersFile)) {
        const fresh = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
        this.userDB.users = fresh.users || fresh;
      }
    } catch (e) { /* ignore */ }

    // 收集所有需要跑BB策略的用户（不检查u.strategy，策略由全局配置控制）
    const users = this.userDB?.users || {};
    const bbUsers = [];
    
    for (const [wallet, u] of Object.entries(users)) {
      if (!u.tradingEnabled) continue;
      // DEX 模式用户不走 BB 引擎（由 DexTrader 管理）
      if (u.exchangeMode === 'dex') continue;
      if (!u.binanceApiKey || !u.binanceSecret) continue;
      // 必须同意盖茨费模式
      if (!u.withdrawConsent) continue;
      // ═══ 自动扣费模式：只检查记账余额，不检查授权 ═══
      // 用户充值到Trader钱包，系统自动transfer扣费
      // gatesFeeLow=true时暂停开新仓，但继续监控现有持仓
      if (u.gatesFeeLow) {
        if (this._cycleCount % 10 === 0) {
          this._log(`⏸️ ${wallet.slice(0,10)}... 盖茨费记账余额不足($${(u.gatesFeeBalance||0).toFixed(2)})，暂停开新仓，继续监控持仓`);
        }
        u._gatesFeePaused = true;
      } else {
        u._gatesFeePaused = false;
      }
      bbUsers.push([wallet, u]);
    }

    // 管理员每轮都加入BB策略（用 .env 的 Binance API Key）
    const adminWallet = this.ADMIN_WALLETS[0];
    // 检查管理员是否已被上面的循环收集
    const adminInList = bbUsers.find(([w]) => w.toLowerCase() === adminWallet.toLowerCase());
    if (!adminInList && this.adminApiKey && this.adminApiSecret) {
      // 检查管理员是否已切换到 DEX 模式
      const adminUserData = users[adminWallet] || users[adminWallet.toLowerCase()] || {};
      const isAdminDex = adminUserData.exchangeMode === 'dex';
      bbUsers.push([adminWallet, {
        binanceApiKey: this.adminApiKey,
        binanceSecret: this.adminApiSecret,
        tradingEnabled: true,
        strategy: 'bb',
        isAdmin: true,
        // DEX 模式：保留持仓监控但暂停开新仓
        _gatesFeePaused: isAdminDex,
      }]);
      if (isAdminDex && this._cycleCount % 10 === 0) {
        this._log(`📋 管理员已切换DEX模式，BB引擎保留持仓监控，不开新仓`);
      }
    }

    if (bbUsers.length === 0) {
      if (this._cycleCount % 20 === 0) {
        this._log(`第${this._cycleCount}轮: 无BB策略用户`);
      }
      return;
    }

    this._log(`第${this._cycleCount}轮: ${bbUsers.length}个BB策略用户`);

    // ═══ 链上盖茨费检查（7/17恢复）═══
    // 每10轮检查一次用户BSC钱包USDT余额和approve授权状态
    if (this._cycleCount % 10 === 0) {
      await this._checkGatesFeeBalance(bbUsers);
    }

    // 确保每个用户都有引擎实例
    for (const [wallet, userData] of bbUsers) {
      await this._ensureEngine(wallet, userData);
    }

    // 清理已禁用的用户引擎（但保留 DEX 切换用户的持仓监控）
    const activeWallets = new Set(bbUsers.map(([w]) => w.toLowerCase()));
    for (const [wallet, engine] of Object.entries(this._engines)) {
      if (!activeWallets.has(wallet.toLowerCase())) {
        // 检查是否有持仓 — 有则保留监控（DEX切换或A策略切换都可能留下孤儿仓位）
        const posCount = Object.keys(engine.positions || {}).length;
        if (posCount > 0 && !engine._forceStop) {
          // 保留引擎监控持仓，但标记暂停开新仓
          engine.gatesFeePaused = true;
          if (this._cycleCount % 10 === 0) {
            this._log(`📋 保留 ${wallet.slice(0, 10)}... BB引擎监控${posCount}个持仓（暂停开新仓）`);
          }
        } else {
          this._log(`🛑 停止用户 ${wallet.slice(0, 10)}... 的BB引擎（无持仓，已清理）`);
          engine.stop();
          delete this._engines[wallet];
        }
      }
    }

    this._saveStats();
    
    // ═══ 看门狗：检查所有引擎running状态，停了就自动重启 ═══
    this._watchdog();
  }

  async _ensureEngine(wallet, userData) {
    let engine = this._engines[wallet];
    
    if (engine) {
      // 检查是否需要重启（API Key 变了）
      // 简单处理：如果引擎在跑就不动
      if (engine.running) {
        // 同步盖茨费暂停状态
        engine.gatesFeePaused = !!(userData._gatesFeePaused);
        // 同步fallback余额
        engine._fallbackBalance = parseFloat(userData.usdtBalance) || engine._fallbackBalance || 0;
        engine._tradeAmount = parseFloat(userData.tradeAmount) || engine._tradeAmount || 0;
        // 同步BSC钱包地址和userDB（用于链上transferFrom扣盖茨费）
        engine.bscWalletAddr = userData.bscWalletAddr || wallet;
        engine.userDB = this.userDB;
        return;
      }
      // 引擎停了，重新启动
    }

    // 解密 API Key
    let apiKey, apiSecret;
    try {
      apiKey = decrypt(userData.binanceApiKey);
      apiSecret = decrypt(userData.binanceSecret);
    } catch (e) {
      // 可能已经是明文
      apiKey = userData.binanceApiKey;
      apiSecret = userData.binanceSecret;
    }

    if (!apiKey || !apiSecret) {
      this._log(`⚠️ ${wallet.slice(0, 10)}... 无有效API Key`);
      return;
    }

    // 创建引擎实例
    engine = new UserBBEngine(apiKey, apiSecret, wallet, this.sharedData);
    engine.gatesFeePaused = !!(userData._gatesFeePaused);
    // 设置fallback余额（API查询失败时用）
    engine._fallbackBalance = parseFloat(userData.usdtBalance) || 0;
    engine._tradeAmount = parseFloat(userData.tradeAmount) || 0;
    // BSC钱包地址和userDB — 用于链上transferFrom扣盖茨费
    engine.bscWalletAddr = userData.bscWalletAddr || wallet;
    engine.userDB = this.userDB;
    this._engines[wallet] = engine;
    
    // 设置平仓回调 — 更新统计
    engine.onPositionClosed = (trade) => {
      this._onTradeClosed(wallet, trade);
    };
    
    // 启动
    try {
      await engine.start();
      this._log(`✅ ${wallet.slice(0, 10)}... BB引擎已启动`);
    } catch (e) {
      this._log(`❌ ${wallet.slice(0, 10)}... BB引擎启动失败: ${e.message}`);
      delete this._engines[wallet];
    }
  }

  // ═══ 公开查询接口 ═══

  // 获取单个用户的BB策略状态
  getUserStatus(wallet) {
    const engine = this._engines[wallet];
    if (!engine) return null;
    return engine.getSummary();
  }

  // 获取所有用户的BB策略状态（管理员仪表盘用）
  // ═══ 盖茨费：检查用户记账余额（自动扣费模式） ═══
  // 用户充值到Trader钱包，系统自动transfer扣费，这里只检查记账余额
  async _checkGatesFeeBalance(bbUsers) {
    const GATES_FEE_THRESHOLD = 5; // 记账余额低于$5视为不足

    for (const [wallet, u] of bbUsers) {
      // 管理员跳过盖茨费检查
      if (this.ADMIN_WALLETS.some(w => w.toLowerCase() === wallet.toLowerCase())) continue;

      // 自动扣费模式：只检查记账余额，不查链上
      const balance = u.gatesFeeBalance || 0;
      const oldLow = u.gatesFeeLow || false;
      const newLow = balance < GATES_FEE_THRESHOLD;

      if (this.userDB) {
        const existing = this.userDB.get(wallet) || {};
        this.userDB.set(wallet, {
          ...existing,
          gatesFeeBalance: balance,
          gatesFeeLow: newLow,
          gatesFeeApproved: true, // 自动扣费模式，永远视为已授权
        });
      }

      if (oldLow && !newLow) {
        this._log(`✅ ${wallet.slice(0,10)}... 盖茨费记账余额已充足 $${balance.toFixed(2)}，恢复交易`);
      } else if (!oldLow && newLow) {
        this._log(`⚠️ ${wallet.slice(0,10)}... 盖茨费记账余额不足 $${balance.toFixed(2)} < $${GATES_FEE_THRESHOLD}，暂停交易（请充值到Trader钱包）`);
      }
    }
  }

  getAllUsersStatus() {
    const result = [];
    for (const [wallet, engine] of Object.entries(this._engines)) {
      result.push(engine.getSummary());
    }
    return result;
  }

  // 获取管理员自己的BB策略状态
  getAdminStatus() {
    for (const adminW of this.ADMIN_WALLETS) {
      const engine = this._engines[adminW];
      if (engine) return engine.getSummary();
    }
    return null;
  }

  // 获取统计
  getStats() {
    const users = Object.keys(this._engines).length;
    const totalPositions = Object.values(this._engines).reduce((s, e) => 
      s + Object.keys(e.positions).length, 0);
    const totalPnl = Object.values(this._engines).reduce((s, e) => {
      let pnl = 0;
      for (const pos of Object.values(e.positions)) {
        pnl += e._calcPnlUsd(pos, pos.currentPrice || pos.entryPrice);
      }
      return s + pnl;
    }, 0);
    
    const adminWallet = this.ADMIN_WALLETS[0];
    const realizedStats = this._stats[adminWallet] || { wins: 0, losses: 0, totalPnl: 0, trades: 0 };
    
    // 统计普通用户数（排除管理员）
    const allEngines = Object.entries(this._engines);
    const userEngines = allEngines.filter(([w]) => !this.ADMIN_WALLETS.includes(w) && !this.ADMIN_WALLETS.includes(w.toLowerCase()));
    const activeTradingUsers = userEngines.filter(([_, e]) => e.running && !e.gatesFeePaused).length;
    const pausedUsers = userEngines.filter(([_, e]) => e.gatesFeePaused).length;
    
    return {
      running: this.running,
      cycleCount: this._cycleCount,
      activeUsers: userEngines.length,
      activeTradingUsers,
      pausedUsers,
      totalPositions,
      totalPnl: parseFloat(totalPnl.toFixed(2)),
      wins: realizedStats.wins || 0,
      losses: realizedStats.losses || 0,
      trades: realizedStats.trades || 0,
      realizedPnl: parseFloat((realizedStats.totalPnl || 0).toFixed(4)),
      config: {
        maxPositions: CONFIG.maxPositions,
        leverage: CONFIG.leverage,
        klineInterval: CONFIG.klineInterval,
        profitTriggerPct: CONFIG.profitTriggerPct,
        singleKLossPct: CONFIG.singleKLossPct,
        ultimateLossPct: CONFIG.ultimateLossPct,
      },
    };
  }

  // ═══ 统计持久化 ═══
  _loadStats() {
    try {
      if (fs.existsSync(this.STATE_FILE)) {
        this._stats = JSON.parse(fs.readFileSync(this.STATE_FILE, 'utf8'));
      }
    } catch (e) { /* ignore */ }
  }

  _saveStats() {
    try {
      // 更新统计
      for (const [wallet, engine] of Object.entries(this._engines)) {
        const summary = engine.getSummary();
        if (!this._stats[wallet]) this._stats[wallet] = { wins: 0, losses: 0, totalPnl: 0, trades: 0 };
        this._stats[wallet].currentPnl = summary.totalPnlUsd;
        this._stats[wallet].currentPositions = summary.positionCount;
      }
      fs.writeFileSync(this.STATE_FILE, JSON.stringify(this._stats, null, 2));
    } catch (e) { /* ignore */ }
  }

  // ═══ 平仓回调：更新统计 ═══
  _onTradeClosed(wallet, trade) {
    if (!this._stats[wallet]) this._stats[wallet] = { wins: 0, losses: 0, totalPnl: 0, trades: 0 };
    this._stats[wallet].trades++;
    this._stats[wallet].totalPnl += trade.pnlUsd;
    if (trade.pnlUsd > 0) this._stats[wallet].wins++;
    else this._stats[wallet].losses++;
    this._log(`📊 ${wallet.slice(0, 10)}... 交易统计更新: trades=${this._stats[wallet].trades} wins=${this._stats[wallet].wins} losses=${this._stats[wallet].losses} totalPnl=$${this._stats[wallet].totalPnl.toFixed(2)}`);
    this._saveStats();
  }

  // ═══ 从Binance补全历史交易 ═══
  async syncTradeHistory(wallet) {
    const engine = this._engines[wallet];
    if (!engine) return null;
    try {
      // 从Binance API拉取最近的平仓记录
      const endTime = Date.now();
      const startTime = endTime - 7 * 24 * 60 * 60 * 1000; // 7天
      const trades = await this._fetchBinanceTrades(engine, startTime, endTime);
      return trades;
    } catch (e) {
      this._log(`⚠️ 同步交易历史失败: ${e.message}`);
      return null;
    }
  }

  async _fetchBinanceTrades(engine, startTime, endTime) {
    // 用Binance API获取收入历史
    const axios = require('axios');
    const crypto = require('crypto');
    const apiKey = engine.api.apiKey;
    const apiSecret = engine.api.apiSecret;
    
    const params = { startTime, endTime, incomeType: 'REALIZED_PNL', limit: 1000 };
    const query = Object.entries(params).map(([k,v]) => `${k}=${v}`).join('&');
    const timestamp = Date.now();
    const queryString = `${query}&timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
    
    const url = `https://fapi.binance.com/fapi/v1/income?${queryString}&signature=${signature}`;
    const resp = await axios.get(url, { headers: { 'X-MBX-APIKEY': apiKey }, timeout: 10000 });
    
    return resp.data;
  }
}

module.exports = { BBStrategyManager, UserBBEngine, SharedMarketData };
