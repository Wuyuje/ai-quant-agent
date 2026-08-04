/**
 * A策略模拟实盘 — AI选币 + 传统指标确认
 * 
 * 完全独立, 不碰B策略(BB+趋势)
 * 只读Binance K线, 不开真实仓位
 * 
 * 选币: 神经网络预测概率>65% + ML预测方向一致 + MACD/RSI确认
 * 资金: 按模型置信度分配(高置信度大仓位)
 * 杠杆: ATR动态调整(低波动高杠杆,高波动低杠杆)
 * 止盈: 浮盈≥3%移动止盈(峰值回撤1.5%)
 * 止损: 总浮亏≥15%含杠杆(价格跌5%)
 */

const { BinanceAPI, Indicators, FEE_CONFIG, isFeeExempted } = require('./common');
const { NeuralNet } = require('../saas/strategies/neural-net');
const { MLPredictor } = require('../saas/strategies/ml-predictor');
const fs = require('fs');
const path = require('path');
const { recordTrade, getPairs } = require('./trade-pair-manager');

const CONFIG = {
  // ★ 大道至简: MA7单均线拐头策略 — 只做3只币
  // 只交易这3个币
  tradeSymbols: ["HFTUSDT","1000SATSUSDT","VICUSDT","BICOUSDT","PTBUSDT","BLESSUSDT","1000RATSUSDT","ARBUSDT"],  // 8只在案(v2夹角回测盈利,可动态回测更新),  // 8只回测盈利(实时回测可调)  // 剔除闲置(BTC/BNB)与低收益(1000SATS)
  // MA7拐头策略
  maPeriod: 7,                  // MA7均线
  klineInterval: '5m',          // 5分钟级别看盘
  klineLimit: 250,
  // 做多: MA7急拐向上 → 逐仓高杠杆; MA7拐向下止盈
  longLeverage: 8,              // 做多高杠杆(逐仓小资金)
  longMarginPct: 0.05,          // 做多单次用5%资金
  // 做空: 做多平仓后趋势形成MA7拐向下 → 做空低杠杆; MA7拐向上平仓
  shortLeverage: 3,             // 做空低杠杆
  shortMarginPct: 0.05,         // 做空单次用5%资金
  // 横盘震荡检测: MA7走平(拐头幅度<阈值)不开仓
  maFlatThreshold: 0.00035,     // MA7变化率<0.035%视为横盘,不开仓
  maTurnThreshold: 0.0008,      // 拐头最低幅度(单段MA7变化, 过滤微抖)
  maTurnAngleDeg: 8,            // 保留兼容(不再使用°角度, 用maAngleRatio同比)
  maPriorPersist: 0.0008,       // 保留兼容
  maAngleRatio: 1.5,            // 拐头角度锐利度: 单段MA7变化≥近期平均单段变化的1.5倍(突然拐,有角度)
  maLowCut: 0.45,               // 低位区: MA7处于近18根底部45%内才可做多
  maHighCut: 0.55,             // 高位区: MA7处于近18根顶部55%外才可做空
  symbolTrendCacheMs: 5*60*1000, // 标的15m趋势缓存5分钟(降API压力)
  requireSymbolTrend: false,    // 关闭15m趋势拦截 — 按你的图: MA7低位上拐就做多/高位下拐就做空, 不看大周期
  hardStopPct: 8,               // 硬止损: 浮亏≥8%强制平仓(MA7拐头平仓优先,此兜底防跳空)
  trailingArmPct: 8,            // 移动止盈启用线: 利润≥8%才启用(避免小波动止盈)
  trailingBackoffPct: 5,        // 移动止盈回撤线: 峰值回撤≥5%锁利 — 趋势交易放宽, 让利润骑行(避免频繁小回撤出局→再开CHURN)
  maxHoldKlines: 48,            // 最多持仓48根5分钟K线(4小时)
  
  // 运行
  scanIntervalMs: 60000,
  maxPositions: 7,             // 每个用户最多同时持仓7仓(固定, 不高于7); 动态20只仅扩充“可选币池”
  
  // 回填(保留原文件路径)
  stateFile: path.join(__dirname, '..', 'data', 'a-strategy-sim-state.json'),
  tradesFile: path.join(__dirname, '..', 'data', 'a-strategy-sim-trades.json'),

};

class AStrategySim {
  constructor(apiKey, apiSecret, opts = {}) {
    this.api = new BinanceAPI(apiKey, apiSecret);
    // 可选: 共享行情缓存（不传入则完全按原样，向后兼容）
    this.sharedMarket = opts.sharedMarket || null;
    // 实盘开关: true=真实币安下单, false=模拟盘(默认,安全)
    this.realTrading = !!opts.realTrading;
    // 账户级总风控(可选注入)
    this.accountGuard = opts.accountGuard || null;
    // 多用户: 该引擎所属的用户wallet + 用户DB(用于算力费扣费)
    this.wallet = opts.wallet || 'admin';
    this._userDB = opts.userDB || null;
    // 多用户: 状态/交易文件按用户隔离(否则所有用户共用一份)
    if (opts.perUserFile) {
      this._stateFile = opts.stateFile || path.join(__dirname, '..', 'data', `a-strategy-${this.wallet.toLowerCase().slice(0,10)}.json`);
      this._tradesFile = opts.tradesFile || path.join(__dirname, '..', 'data', `a-trades-${this.wallet.toLowerCase()}.json`);
      this._logFile = opts.logFile || path.join(__dirname, '..', 'logs', `a-strategy-${this.wallet.toLowerCase().slice(0,10)}.log`);
      this._perUser = true;
    } else {
      // 默认: 共享单一文件(管理员/单实例模式,保持兼容)
      this._stateFile = CONFIG.stateFile;
      this._tradesFile = CONFIG.tradesFile;
      this._logFile = CONFIG.logFile;
      this._perUser = false;
    }
    this.balance = CONFIG.initialBalance;
    this.positions = {};
    this.precisionMap = null;
    this.running = false;
    this._cycleCount = 0;
    // v16: 只平不开模式开关(停止开新仓,保留现有持仓止盈止损平仓)
    this._pauseOpen = !!opts.pauseOpen;
    
    // AI模型
    this.nn = new NeuralNet();
    this.ml = new MLPredictor();
    
    // 模型准确率统计
    this._modelStats = { nnCorrect: 0, nnTotal: 0, mlCorrect: 0, mlTotal: 0 };
    
    // 交易统计
    this._trades = 0;
    this._wins = 0;
    this._losses = 0;
    this._realizedPnl = 0;
    
    this._loadModels();
    this._loadState();
  }

  _log(msg) {
    const ts = new Date().toISOString();
    const line = `[A-SIM] ${ts} ${msg}`;
    console.log(line);
    try {
      const dir = path.dirname(this._logFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this._logFile, line + '\n');
    } catch(e) {}
  }

  _loadModels() {
    try {
      const modelFile = path.join(__dirname, '..', 'data', 'neural-model.json');
      if (fs.existsSync(modelFile)) {
        this.nn.load(modelFile);
        this._log('🧠 神经网络模型已加载');
      } else {
        this._log('🧠 神经网络模型不存在,使用未训练模型');
      }
    } catch(e) { this._log(`⚠️ 神经网络加载失败: ${e.message}`); }
  }

  _loadState() {
    try {
      if (fs.existsSync(this._stateFile)) {
        const d = JSON.parse(fs.readFileSync(this._stateFile, 'utf8'));
        this.balance = d.balance || CONFIG.initialBalance;
        this.positions = d.positions || {};
        this._trades = d.trades || 0;
        this._wins = d.wins || 0;
        this._losses = d.losses || 0;
        this._realizedPnl = d.realizedPnl || 0;
        this._modelStats = d.modelStats || this._modelStats;
        // v11fix: 恢复冷却期记录(防止重启后同一币反复交易)
        if (d._closedTimes) this._closedTimes = d._closedTimes;
        if (d._dailyTrades) this._dailyTrades = d._dailyTrades;
        this._log(`📂 加载状态: 余额$${this.balance.toFixed(2)} ${Object.keys(this.positions).length}仓 ${this._trades}笔`);
      }
    } catch(e) {}
  }

  _saveState() {
    try {
      const dir = path.dirname(this._stateFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._stateFile, JSON.stringify({
        balance: this.balance, positions: this.positions,
        trades: this._trades, wins: this._wins, losses: this._losses,
        realizedPnl: this._realizedPnl, modelStats: this._modelStats,
        _closedTimes: this._closedTimes || {}, _dailyTrades: this._dailyTrades || {},
      }, null, 2));
    } catch(e) {}
  }

  _recordTrade(symbol, pos, reason, pnlUsd) {
    try {
      let trades = [];
      if (fs.existsSync(this._tradesFile)) trades = JSON.parse(fs.readFileSync(this._tradesFile, 'utf8'));
      trades.push({
        symbol, side: pos.side, qty: pos.qty,
        entryPrice: pos.entryPrice, exitPrice: pos.currentPrice,
        pnlUsd: +pnlUsd.toFixed(4), pnlPct: +pos._lastPnlPct.toFixed(2),
        margin: pos.margin, leverage: pos.leverage,
        reason, closeTime: Date.now(),
        nnConfidence: pos._nnConfidence, mlDirection: pos._mlDirection,
      });
      if (trades.length > 200) trades = trades.slice(-200);
      fs.writeFileSync(this._tradesFile, JSON.stringify(trades, null, 2));
    } catch(e) {}
  }

  // ═══ 算力费扣费(多用户: 普通用户盈利→扣算力费到管理员钱包) ═══
  async _collectServiceFee(symbol, pnlUsd) {
    if (pnlUsd <= 0) return;
    if (isFeeExempted(this.wallet)) {
      this._log(`👑 ${this.wallet.slice(0,8)} ${symbol} +$${pnlUsd.toFixed(2)} — 管理员/白名单,免算力费`);
      return;
    }
    const platformFee = pnlUsd * FEE_CONFIG.PLATFORM_FEE_RATE;
    const ecoFund = pnlUsd * FEE_CONFIG.ECO_FUND_RATE;
    const userShare = pnlUsd * FEE_CONFIG.USER_SHARE_RATE;
    const walletKey = this.wallet;
    try {
      let feeState = { pending: {}, collected: {}, totalPlatformFee: 0, totalEcoFund: 0 };
      if (fs.existsSync(FEE_CONFIG.FEE_STATE_FILE)) {
        feeState = JSON.parse(fs.readFileSync(FEE_CONFIG.FEE_STATE_FILE, 'utf8'));
      }
      if (!feeState.pending) feeState.pending = {};
      if (!feeState.pending[walletKey]) feeState.pending[walletKey] = [];
      feeState.pending[walletKey].push({
        symbol, platformFee: platformFee.toFixed(4), ecoFund: ecoFund.toFixed(4),
        platformCollected: false, timestamp: Date.now(), strategy: 'A',
      });
      fs.writeFileSync(FEE_CONFIG.FEE_STATE_FILE, JSON.stringify(feeState, null, 2));
      // 更新用户DB余额(扣减算力费)
      if (this._userDB && this.wallet) {
        const wl = this.wallet.toLowerCase();
        const user = this._userDB.get(wl) || this._userDB.get(this.wallet) || {};
        const oldBal = user.gatesFeeBalance || 0;
        const newBal = oldBal - platformFee - ecoFund;
        this._userDB.set(wl, { ...user, gatesFeeBalance: newBal, gatesFeeLow: newBal < 5, gatesFeeCollected: (user.gatesFeeCollected||0) + platformFee + ecoFund });
        try {
          const usersFile = path.join(__dirname, '..', 'data', 'saas-users.json');
          const allUsers = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
          const userKey = allUsers[wl] ? wl : (allUsers[this.wallet] ? this.wallet : wl);
          if (allUsers[userKey]) {
            allUsers[userKey].gatesFeeBalance = newBal;
            allUsers[userKey].gatesFeeLow = newBal < 5;
            allUsers[userKey].gatesFeeCollected = (allUsers[userKey].gatesFeeCollected||0) + platformFee + ecoFund;
            fs.writeFileSync(usersFile, JSON.stringify(allUsers, null, 2));
          }
        } catch(e) {}
      }
      this._log(`💰 ${symbol} 扣算力费$${(platformFee+ecoFund).toFixed(2)}(平台${platformFee.toFixed(2)}+生态${ecoFund.toFixed(2)}) → 管理员`);
      await this._tryBatchFeeTransfer(walletKey);
    } catch(e) { this._log(`⚠️ 算力费记录失败: ${e.message.slice(0,50)}`); }
  }

  async _tryBatchFeeTransfer(walletKey) {
    let feeState;
    try { feeState = JSON.parse(fs.readFileSync(FEE_CONFIG.FEE_STATE_FILE, 'utf8')); }
    catch(e) { return; }
    const pending = feeState.pending?.[walletKey] || [];
    if (pending.length === 0) return;
    const totalPlatform = pending.reduce((s,r) => r.platformCollected ? s : s + parseFloat(r.platformFee), 0);
    const totalEco = pending.reduce((s,r) => s + parseFloat(r.ecoFund), 0);
    const totalFee = totalPlatform + totalEco;
    if (totalFee < FEE_CONFIG.FEE_THRESHOLD) return;
    // 链上转账到管理员钱包(仅当达到阈值)
    try {
      const { ethers } = require('ethers');
      const BSC_RPC = 'https://bsc-rpc.publicnode.com';
      const USDT_ADDR = '0x55d398326f99059fF775485246999027B3197955';
      const traderPrivateKey = process.env.TRADER_PRIVATE_KEY;
      if (!traderPrivateKey) return;
      const provider = new ethers.JsonRpcProvider(BSC_RPC);
      const traderWallet = new ethers.Wallet(traderPrivateKey, provider);
      const usdtContract = new ethers.Contract(USDT_ADDR, ['function transfer(address to, uint256 amount) returns (bool)','function balanceOf(address) view returns (uint256)'], traderWallet);
      const GAS_PRICE = ethers.parseUnits('5', 'gwei');
      const traderBal = await usdtContract.balanceOf(traderWallet.address);
      const totalFeeWei = ethers.parseUnits(totalFee.toFixed(6), 18);
      if (BigInt(traderBal) < totalFeeWei) return;
      if (totalPlatform > 0) {
        const tx1 = await usdtContract.transfer(FEE_CONFIG.PLATFORM_WALLET, ethers.parseUnits(totalPlatform.toFixed(6), 18), { gasPrice: GAS_PRICE });
        await tx1.wait();
      }
      const tx2 = await usdtContract.transfer(FEE_CONFIG.ECO_FUND_WALLET, ethers.parseUnits(totalEco.toFixed(6), 18), { gasPrice: GAS_PRICE });
      await tx2.wait();
      for (const r of pending) r.platformCollected = true;
      fs.writeFileSync(FEE_CONFIG.FEE_STATE_FILE, JSON.stringify(feeState, null, 2));
      this._log(`✅ 算力费累计$${totalFee.toFixed(2)} 已转账到管理员钱包`);
    } catch(e) { this._log(`⚠️ 链上扣费失败: ${e.message.slice(0,50)}`); }
  }

  // ═══ 盈亏计算 ═══
  _calcPnlPct(pos, price) {
    if (pos.side === 'LONG') return (price - pos.entryPrice) / pos.entryPrice * 100 * pos.leverage;
    return (pos.entryPrice - price) / pos.entryPrice * 100 * pos.leverage;
  }

  _calcPnlUsd(pos, price) {
    if (pos.side === 'LONG') return (price - pos.entryPrice) * pos.qty;
    return (pos.entryPrice - price) * pos.qty;
  }

  // ═══ 获取仓位大小(按置信度+ATR) ═══
  _getPositionSize(confidence, atrPct) {
    // 置信度越高仓位越大: 65%→5%, 80%→10%, 95%→15%
    const basePct = 0.05;
    const confBonus = Math.max(0, (confidence - 0.65) / 0.35) * 0.10;
    let pct = basePct + confBonus;
    // 高波动降低仓位
    if (atrPct > 0.5) pct *= 0.6;
    else if (atrPct > 0.2) pct *= 0.8;
    return Math.min(pct, 0.15); // 上限15%
  }

  // ═══ 获取杠杆(ATR动态) ═══
  _getLeverage(atrPct) {
    if (atrPct < 0.15) return 5;  // 低波动5x
    if (atrPct < 0.3) return 4;   // 中低波动4x
    if (atrPct < 0.5) return 3;   // 中波动3x
    return 2;                      // 高波动2x
  }

  // v7: BTC大盘趋势判断(带缓存,返回BTC趋势状态)
  async _getBtcTrend() {
    const btc = CONFIG.btcTrendSymbol || 'BTCUSDT';
    if (this._btcTrend && Date.now() - this._btcCacheTime < CONFIG.btcTrendCacheMs) {
      return this._btcTrend;
    }
    try {
      const klines = await Promise.race([
        this.api.getKlines(btc, '15m', 100),
        new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 10000))
      ]).catch(() => null);
      if (klines && klines.length >= 60) {
        const ema20 = Indicators.ema(klines, 20);
        const ema60 = Indicators.ema(klines, 60);
        const btcBull = !!(ema20 && ema60 && ema20 > ema60);
        // BTC趋势强度(ADX),用于判断大盘是否震荡
        const btcAdx = Math.min(60, this._calcADX(klines, 14) || 0);
        const btcStrong = btcAdx >= 18; // 大盘趋势较强
        this._btcTrend = { btcBull, btcStrong, btcAdx };
        this._btcCacheTime = Date.now();
        return this._btcTrend;
      }
    } catch(e) {}
    this._btcTrend = { btcBull: false, btcStrong: true, btcAdx: 30 };
    this._btcCacheTime = Date.now();
    return this._btcTrend; // 获取失败默认不拦截
  }

  // ★★ 趋势判断核心: 用较大周期(15m)的 EMA20/EMA60 + ADX 判断标的自身趋势方向/强度
  // 趋势交易入口: 只有顺趋势才开仓, 逆势一律不开(避免震荡里频繁反向开仓亏损)
  async _getSymbolTrend(symbol) {
    const cacheKey = 't:' + symbol;
    if (this._symTrendCache && this._symTrendCache[cacheKey] && Date.now() - this._symTrendCache[cacheKey].t < CONFIG.symbolTrendCacheMs) {
      return this._symTrendCache[cacheKey];
    }
    if (!this._symTrendCache) this._symTrendCache = {};
    try {
      const klines = await Promise.race([
        this.api.getKlines(symbol, '15m', 100),
        new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 10000))
      ]).catch(() => null);
      if (klines && klines.length >= 60) {
        const ema20 = Indicators.ema(klines, 20);
        const ema60 = Indicators.ema(klines, 60);
        const adx  = Math.min(60, this._calcADX(klines, 14) || 0);
        // 趋势方向: 多/空/不清(震荡)
        let dir = 'FLAT';
        if (ema20 && ema60) {
          const gap = (ema20 - ema60) / ema60;
          if (gap > 0.002 && ema60 > klines[klines.length-60].close) dir = 'UP';     // EMA20在EMA60上方且EMA60上倾 = 上升趋势
          else if (gap < -0.002 && ema60 < klines[klines.length-60].close) dir = 'DOWN'; // 下降趋势
        }
        const strong = adx >= 18;   // 趋势强度够才追(ADX≥18代表非横盘)
        const res = { dir, adx: +(adx.toFixed(1)), strong, t: Date.now() };
        this._symTrendCache[cacheKey] = res;
        return res;
      }
    } catch(e) {}
    const res = { dir: 'FLAT', adx: 0, strong: false, t: Date.now() };
    this._symTrendCache[cacheKey] = res;
    return res;
  }



  // ═══ 选币: 优先回报率高的币, 动态交易对(可达20只) ═══
  async selectSymbols() {
    // 从动态交易对读取(由refreshPairs按回测回报率选币扩充, 最多20只)
    try {
      const dyn = getPairs().pairs;
      if (dyn && Array.isArray(dyn) && dyn.length > 0) return [...dyn];
    } catch(e) {}
    return [...(CONFIG.tradeSymbols || ['HFTUSDT','1000SATSUSDT','VICUSDT','BICOUSDT','PTBUSDT','BLESSUSDT','1000RATSUSDT','ARBUSDT'])];
  }

  

  // ═══ AI选币+指标确认 ═══
  // (大道至简) MA7单均线拐头策略(5分钟级)
  // (大道至简) MA7单均线拐头策略(5分钟级)
  // (大道至简) MA7单均线拐头策略(5分钟级)
  // (大道至简) MA7单均线拐头策略(5分钟级)
  // (大道至简) MA7单均线拐头策略 — 5分钟级别
  // 做多: MA7急拐向上; 做空: MA7急拐向下(做多平后趋势形成); 横盘不开仓
  // (大道至简) MA7拐头夹角策略 — 必须MA7前段方向明确后反转形成夹角才开仓
  // 做多: MA7前段向下后急转向上(V形金叉夹角)
  // 做空: MA7前段向上后急转向下(Λ形死叉夹角)
  // 横盘/斜率微变不触发(没形成夹角)
  // (大道至简) MA7单线自身夹角策略 — 只看MA7一条线的弯钩/夹角
  // MA7线从下行急升拐走上弯(V形夹角) → 做多
  // MA7线从上行急砸拐下弯(Λ形夹角) → 做空
  // 横盘/平缓不形成夹角 → 不开仓
  // (大道至简) MA7夹角+趋势成形 — 5分钟级别,横盘震荡绝不开仓
  // 开仓须同时满足: ①前段趋势明确(非横盘) ②MA7出现夹角转折 ③趋势已成形(夹角后同向延续)
  // (大道至简v2) MA7拐头夹角 — 量化夹角锐利度,低价币也准确,不受抖动干扰
  // (v3) MA7拐头夹角 — 融合4方法: 斜率加速度+角度+前高低突破+相邻K线实体确认
  // (大道至简最优) MA7夹角 trend确认 — 斜率加速度 + 拐头幅度(趋势明确,能交易)
  async checkSignal(klines, symbol) {
    // (大道至简v8) MA7拐头策略 — 低位上拐做多 / 高位下拐做空 (实测最优)
    // 三条件: 相对位置(低位/高位) + 方向反转(前段反向) + 拐头幅度(过滤横盘微抖)
    if (!klines || klines.length < 80) return { allowed: false, reason: 'K线不足' };
    const closes = klines.map(k => k.close);
    const ma = [];
    for (let i = closes.length-26; i <= closes.length-7; i++) {
      const v = Indicators.sma(closes.slice(i, i+7), 7);
      if (v != null) ma.push(v);
    }
    if (ma.length < 10) return { allowed:false, reason:'MA7不足' };
    const n = ma.length;
    const base = Math.abs(ma[n-1] || 1);
    const curMA = ma[n-1];
    const lookbackMA = ma.slice(-18);
    const maxMA = Math.max(...lookbackMA);
    const minMA = Math.min(...lookbackMA);
    const maRange = (maxMA - minMA) || 1;
    const prior = (ma[n-1] - ma[n-4]) / base;    // 前段方向
    const latest = (ma[n-1] - ma[n-2]) / base;   // 最新单段拐头
    const turnMin = CONFIG.maTurnThreshold || 0.0008;
    const posRatio = (curMA - minMA) / maRange;  // 0=最低,1=最高
    const isLow = posRatio < 0.4;
    const isHigh = posRatio > 0.6;
    // 做多: 低位区 + 前段下行 + 刚转上拐
    if (isLow && prior < 0 && latest > turnMin) {
      return { allowed:true, direction:'LONG', reason:`MA7低位上拐做多(位${(posRatio*100).toFixed(0)}%低 前段${(prior*100).toFixed(2)}%下行后转升)`, confidence:0.72, atrPct:0.4 };
    }
    // 做空: 高位区 + 前段上行 + 刚转下拐
    if (isHigh && prior > 0 && latest < -turnMin) {
      return { allowed:true, direction:'SHORT', reason:`MA7高位下拐做空(位${(posRatio*100).toFixed(0)}%高 前段${(prior*100).toFixed(2)}%上行后转降)`, confidence:0.72, atrPct:0.4 };
    }
    return { allowed:false, reason:`位${(posRatio*100).toFixed(0)}% 前段${(prior*100).toFixed(3)}% 最新${(latest*100).toFixed(3)}%` };
  }

  
  checkTakeProfit(pos, klines) {
    // (大道至简v8) MA7反向拐头即平 — 做多到高位转下拐平多, 做空到底位转上拐平空
    if (!klines || klines.length < 20) return { action: 'HOLD' };
    const closes = klines.map(k => k.close);
    const ma = [];
    for (let i=Math.max(0,closes.length-13); i<=closes.length-7; i++){ const v=Indicators.sma(closes.slice(i,i+7),7); if(v!=null) ma.push(v); }
    if(ma.length<5) return {action:'HOLD'};
    const n=ma.length;
    const m4=ma[n-2], m5=ma[n-1];
    const pnlPct=this._calcPnlPct(pos,pos.currentPrice); pos._lastPnlPct=pnlPct;
    if (pos.side==='LONG') {
      if (m5 < m4) { return {action:'CLOSE', reason:`MA7高位下拐平多${pnlPct>=0?'止盈':'止损'} ${pnlPct.toFixed(1)}%`}; }
    } else if (pos.side==='SHORT') {
      if (m5 > m4) { return {action:'CLOSE', reason:`MA7低位上拐平空${pnlPct>=0?'止盈':'止损'} ${pnlPct.toFixed(1)}%`}; }
    }
    return {action:'HOLD'};
  }

  
  checkStopLoss(pos, klines) {
    const pnlPct=this._calcPnlPct(pos,pos.currentPrice);
    pos._lastPnlPct=pnlPct;
    // 硬止损兜底: 浮亏≥8%强制止损(MA7拐头平仓为主,此兜底防极端跳空扛单)
    if (pnlPct <= -(CONFIG.hardStopPct || 8)) return { action:'CLOSE', reason:`止损: 浮亏${pnlPct.toFixed(1)}%≥${CONFIG.hardStopPct||8}%` };
    // 持仓超过 maxHoldKlines 未平,平仓释放(防深套)
    if (pos.openTime && (Date.now()-pos.openTime) > (CONFIG.maxHoldKlines||48)*5*60*1000) {
      const pnlLabel = pnlPct>=0?'锁利':'止损';
      return { action:'CLOSE', reason:`超时平仓${pnlLabel}(持仓>${(CONFIG.maxHoldKlines||48)*5/60||4}h) ${pnlPct.toFixed(1)}%` };
    }
    return { action:'HOLD' };
  }

  
  async _simOpen(symbol, direction, signal) {
    // v16: 只平不开模式 — 停止开新仓
    if (this._pauseOpen) { this._log(`⏸️ 只平不开模式,${symbol}不开新仓`); return; }
    if (Object.keys(this.positions).length >= CONFIG.maxPositions) return;
    if (this.positions[symbol]) return;
    
    const price = signal._price;
    // 大道至简: 按方向配置逐仓杠杆与仓位
    // 做多: 高杠杆(8x)+小资金(5%); 做空: 低杠杆(3x)+小资金(5%)
    const leverage = (direction === 'LONG' ? (CONFIG.longLeverage||8) : (CONFIG.shortLeverage||3));
    const marginPct = direction === 'LONG' ? (CONFIG.longMarginPct||0.05) : (CONFIG.shortMarginPct||0.05);
    let margin = Math.max(this.balance * marginPct, 3); // 至少3U保证金
    // 确保名义≥币安最小(~20USDT),避免-4164
    let notional = margin * leverage;
    if (notional < 20) { notional = 20; margin = 20 / leverage; }
    let qty = notional / price;

    // ═══ 实盘模式：真实币安下单 + 账容守卫 ═══
    if (this.realTrading) {
      // 账户容量保护(防超载)
      if (this.accountGuard) {
        const cap = await this.accountGuard.checkCanOpen(this.api, notional, symbol);
        if (!cap.allowed) { this._log(`⏭️ ${symbol} 实盘账户容量不足,不开仓: ${cap.reason}`); return; }
        if (cap.limitNotional < notional) {
          margin = Math.max(0, cap.limitNotional / leverage);
          if (margin < 1) { this._log(`⏭️ ${symbol} 实盘剩余容量过小,不开仓`); return; }
          notional = margin * leverage;
          qty = notional / price;
        }
      }
      let result;
      if (direction === 'LONG') result = await this.api.marketLong(symbol, qty, leverage, this.precisionMap);
      else result = await this.api.marketShort(symbol, qty, leverage, this.precisionMap);
      if (!result.success) { this._log(`❌ ${symbol} 实盘开仓失败: ${result.error}`); return; }
      const actualQty = result.qty || qty;
      this.positions[symbol] = {
        symbol, side: direction, qty: actualQty, entryPrice: price,
        margin, leverage, currentPrice: price,
        _peakPnlPct: 0, _nnConfidence: signal.confidence,
        _mlDirection: direction, openTime: Date.now(),
        _klines: signal._klines || [], _real: true,
      };
      this._log(`✅ ${symbol} ${direction} 实盘开仓 qty=${actualQty.toFixed(4)} margin=$${margin.toFixed(2)} lev=${leverage}x 置信度=${signal.confidence.toFixed(2)}`);
      this._saveState();
      return;
    }

    // ═══ 模拟盘模式(默认) ═══
    this.positions[symbol] = {
      symbol, side: direction, qty, entryPrice: price,
      margin, leverage, currentPrice: price,
      _peakPnlPct: 0, _nnConfidence: signal.confidence,
      _mlDirection: direction, openTime: Date.now(),
      _klines: signal._klines || [], // v3: 保存开仓时的K线用于训练
    };
    this._log(`🟢 ${symbol} ${direction} 模拟开仓 qty=${qty.toFixed(4)} margin=$${margin.toFixed(2)} lev=${leverage}x 置信度=${signal.confidence.toFixed(2)}`);
  }

  // ═══ 模拟平仓(实盘仓走真实平仓) ═══
  async _simClose(symbol, reason) {
    const pos = this.positions[symbol];
    if (!pos) return;
    
    let pnlUsd;
    // ═══ 实盘仓: 先真实平仓,用币安真实盈亏 ═══
    if (this.realTrading && pos._real) {
      try {
        if (pos.side === 'LONG') await this.api.closeLong(symbol, pos.qty, this.precisionMap);
        else await this.api.closeShort(symbol, pos.qty, this.precisionMap);
        // 拉取真实已实现盈亏
        const startTime = pos.openTime || (Date.now() - 86400000);
        const income = await this.api.getIncome(startTime, Date.now(), 'REALIZED_PNL');
        const symIncome = (income || []).filter(r => r.symbol === symbol && Math.abs(parseFloat(r.income)) > 0);
        pnlUsd = symIncome.reduce((s, r) => s + parseFloat(r.income), 0);
        if (symIncome.length === 0) pnlUsd = this._calcPnlUsd(pos, pos.currentPrice); // 无真实记录则估算
      } catch(e) {
        pnlUsd = this._calcPnlUsd(pos, pos.currentPrice);
        this._log(`⚠️ ${symbol} 实盘平仓异常: ${e.message.slice(0,30)}`);
      }
    } else {
      // ═══ 模拟仓(默认) ═══
      pnlUsd = this._calcPnlUsd(pos, pos.currentPrice);
    }
    // ★ 把算力费(普通用户30%)计入净盈亏 — 胜率/回报率显示真实扣费后数值
    let feeCost = 0;
    if (pnlUsd > 0 && this.realTrading && this.wallet && !isFeeExempted(this.wallet)) {
      feeCost = pnlUsd * (FEE_CONFIG.PLATFORM_FEE_RATE + FEE_CONFIG.ECO_FUND_RATE); // 30%
    }
    const netPnl = pnlUsd - feeCost; // 扣算力费后的净盈亏
    this._lastNetPnl = netPnl;       // 记录净盈亏(用于胜率/回报率展示)
    this.balance += netPnl;          // 余额用扣费后净盈亏
    this._trades++;
    this._realizedPnl += netPnl;     // 统计扣费后净盈亏
    if (netPnl > 0) this._wins++;    // 扣费后仍盈利才算胜
    else this._losses++;

    // 多用户: 普通用户盈利后自动扣算力费到管理员钱包(管理员/白名单豁免)
    if (this.realTrading && pnlUsd > 0 && this.wallet && !isFeeExempted(this.wallet)) {
      try {
        this._log(`💰 ${symbol} 用户盈利$${pnlUsd.toFixed(2)},扣算力费30%=$${feeCost.toFixed(2)},净得$${netPnl.toFixed(2)}→管理员`);
        await this._collectServiceFee(symbol, pnlUsd);
      } catch(feeErr) {
        this._log(`⚠️ ${symbol} 扣费异常(不阻断冷却期): ${feeErr.message.slice(0,30)}`);
      }
    }
    
    // v5: 记录平仓时间用于冷却期
    if (!this._closedTimes) this._closedTimes = {};
    this._closedTimes[symbol] = Date.now();
    
    // v9: 训练神经网络 + 独立预测验证(真实准确率,非自证100%)
    try {
      const features = this.nn.extractFeatures(pos._klines || []);
      if (features) {
        const label = pnlUsd > 0 
          ? (pos.side === 'LONG' ? 1 : -1)   // 盈利: 方向正确
          : (pos.side === 'LONG' ? -1 : 1); // 亏损: 方向错误
        // 用开仓特征先预测方向,对比实际 → 测真实泛化准确率
        const beforePred = this.nn.predict(features);
        const predAction = beforePred && beforePred.action;
        const predDir = predAction === 'BUY' ? 1 : (predAction === 'SELL' ? -1 : 0);
        const actualDir = label;
        const predCorrect = (predDir === actualDir && predDir !== 0);
        // 训练
        this.nn.train(features, label);
        // 统计预测准确率(独立验证,非训练自证)
        this._modelStats.nnTotal = (this._modelStats.nnTotal || 0) + 1;
        if (predCorrect) this._modelStats.nnCorrect = (this._modelStats.nnCorrect || 0) + 1;
        // 每10笔保存模型
        if (this._trades % 10 === 0) {
          this.nn.save(path.join(__dirname, '..', 'data', 'neural-model.json'));
          const acc = this._modelStats.nnTotal > 0 ? (this._modelStats.nnCorrect / this._modelStats.nnTotal * 100).toFixed(1) : '0';
          this._log(`🧠 模型已保存(训练${this.nn.trainCount}次 预测准确率${acc}%)`);
        }
      }
    } catch(e) {}
    
    // v3: ML预测器反馈
    try {
      if (pos._mlDirection !== undefined) {
        this._modelStats.mlTotal = (this._modelStats.mlTotal || 0) + 1;
        const actualDir = pnlUsd > 0 ? pos._mlDirection : -pos._mlDirection;
        if (actualDir === pos._mlDirection) this._modelStats.mlCorrect = (this._modelStats.mlCorrect || 0) + 1;
      }
    } catch(e) {}
    
    this._log(`✅ ${symbol} 模拟平仓 ${reason} PnL=$${pnlUsd.toFixed(2)}(费$${feeCost.toFixed(2)}) 净$${netPnl.toFixed(2)} 余额=$${this.balance.toFixed(2)}`);
    this._recordTrade(symbol, pos, reason, netPnl); // 记录扣费后净盈亏
    // 记录实际交易表现(供周期性回测选币参考)
    try { recordTrade(symbol, this.wallet||'admin', pos.side, netPnl, this._lastNetPnl||netPnl, 'MA7夹角'); } catch(e) {}
    delete this.positions[symbol];
  }

  // ═══ 统计 ═══
  getSummary() {
    const positions = [];
    let floatPnl = 0;
    for (const [sym, pos] of Object.entries(this.positions)) {
      const pnlUsd = this._calcPnlUsd(pos, pos.currentPrice || pos.entryPrice);
      const pnlPct = this._calcPnlPct(pos, pos.currentPrice || pos.entryPrice);
      floatPnl += pnlUsd;
      positions.push({
        symbol: sym, side: pos.side, qty: pos.qty,
        entryPrice: pos.entryPrice, currentPrice: pos.currentPrice,
        pnlPct: +pnlPct.toFixed(2), pnlUsd: +pnlUsd.toFixed(2),
        margin: pos.margin, leverage: pos.leverage,
        confidence: pos._nnConfidence,
      });
    }
    return {
      running: this.running,
      balance: +this.balance.toFixed(2),
      positionCount: positions.length,
      maxPositions: CONFIG.maxPositions,
      positions,
      floatPnl: +floatPnl.toFixed(2),
      realizedPnl: +this._realizedPnl.toFixed(2),
      totalPnl: +(floatPnl + this._realizedPnl).toFixed(2),
      trades: this._trades,
      wins: this._wins,
      losses: this._losses,
      winRate: this._trades > 0 ? +(this._wins / this._trades * 100).toFixed(1) : 0,
      modelStats: this._modelStats,
      strategy: 'A-SIM',
    };
  }

  // ═══ 主循环 ═══
  async start() {
    this.running = true;
    this._injectSharedMarket();  // 可选: 接入共享行情缓存
    this._log('🚀 A策略模拟实盘启动');
    this._log(`💰 模拟资金: $${this.balance.toFixed(2)}`);
    try { this.precisionMap = await this.api.getExchangeInfo(); } catch(e) {}
    this._loop();
  }

  /**
   * 注入共享行情缓存（百万用户架构，可选）
   * 只覆盖公开行情(getAllTickers选币/getExchangeInfo精度)，
   * 模拟盘本身只读K线不开真实仓位，失败自动回落引擎自己的API。
   */
  _injectSharedMarket() {
    if (!this.sharedMarket || !this.api) return;
    if (this.__sharedInjected) return;
    this.__sharedInjected = true;
    const shared = this.sharedMarket;

    const origGetAllTickers = this.api.getAllTickers && this.api.getAllTickers.bind(this.api);
    this.api.getAllTickers = async () => {
      try {
        const t = await shared.getAllTickers();
        if (Array.isArray(t) && t.length > 0) return t;
      } catch (e) { /* 回落 */ }
      if (origGetAllTickers) return origGetAllTickers();
      throw new Error('getAllTickers failed');
    };

    const origGetExchangeInfo = this.api.getExchangeInfo && this.api.getExchangeInfo.bind(this.api);
    this.api.getExchangeInfo = async () => {
      try {
        const info = await shared.getExchangeInfo();
        if (info) return info;
      } catch (e) { /* 回落 */ }
      if (origGetExchangeInfo) return origGetExchangeInfo();
      throw new Error('getExchangeInfo failed');
    };
    this._log('📡 A策略已接入共享行情缓存(选币/精度共用，不碰B策略)');
  }

  async _loop() {
    while (this.running) {
      try { await this._scan(); } catch(e) { this._log(`❌ 扫描异常: ${e.message}`); }
      await new Promise(r => setTimeout(r, CONFIG.scanIntervalMs));
    }
  }

  /**
   * 从币安同步真实持仓(接管用户账户已有仓+更新价格+清理已平)
   * 多用户实盘：每个用户用各自API key拉取自己账户真实持仓
   */
  async _syncPositions() {
    if (!this.realTrading) return;
    try {
      // 动态交易对管理(由refreshPairs按回测回报率选币, 可达20只); 非交易对仓位一律清理不接管
      let allowedArr;
      try { allowedArr = getPairs().pairs; } catch(e) { allowedArr = null; }
      if (!allowedArr || !Array.isArray(allowedArr) || !allowedArr.length) allowedArr = CONFIG.tradeSymbols || ['HFTUSDT','1000SATSUSDT','VICUSDT','BICOUSDT','PTBUSDT','BLESSUSDT','1000RATSUSDT','ARBUSDT'];
      const allowedSet = new Set(allowedArr);
      const withTimeout = (p, ms) => Promise.race([p, new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 10000))]);
      const remote = await withTimeout(this.api.getPositions(), 10000).catch(() => null);
      if (!Array.isArray(remote)) return;

      // 币安有活跃仓的symbol
      const remoteSymbols = new Set(remote.filter(r => Math.abs(parseFloat(r.positionAmt)) > 0).map(r => r.symbol));

      // ⚠️ 动态交易对扩充后: 不再因币种不在当前交易对强行平仓(会误伤已管理/盈利仓)
      // 持仓由MA7拐头/移动止盈/硬止损自然决定去留, 交易对只决定“开什么”
      // 仅当仓位极小(残留dust)且不在核心交易对时才清理, 避免币安微型残留堆积
      for (const r of remote) {
        const amt = parseFloat(r.positionAmt);
        const notional = Math.abs(amt) * parseFloat(r.markPrice || 0);
        if (amt === 0) continue;
        // 仅在: 仓位极小(<20USD 名义) 且 不在当前交易对 时才平残留dust
        if (!allowedSet.has(r.symbol) && notional < 20) {
          try {
            const qty = Math.abs(amt);
            if (amt < 0) await this.api.closeShort(r.symbol, qty, this.precisionMap);
            else await this.api.closeLong(r.symbol, qty, this.precisionMap);
            this._log(`🧹 ${r.symbol} 非交易对且微小残留(¥${notional.toFixed(1)}),已平掉`);
          } catch(e) { this._log(`⚠️ ${r.symbol} 平残留失败: ${e.message.slice(0,30)}`); }
        }
      }

      // 接管币安真实仓(本地没有的补上,这样A能管理用户账户里已有的仓)
      for (const r of remote) {
        const amt = parseFloat(r.positionAmt);
        if (amt === 0) continue;
        if (this.positions[r.symbol]) {
          // 更新已有仓价格/数量
          this.positions[r.symbol].currentPrice = parseFloat(r.markPrice);
          const remoteQty = Math.abs(amt);
          if (Math.abs(remoteQty - (this.positions[r.symbol].qty || 0)) > (this.positions[r.symbol].qty || 0) * 0.01) {
            this.positions[r.symbol].qty = remoteQty;
          }
          if (!this.positions[r.symbol]._real) this.positions[r.symbol]._real = true;
        } else {
          // v16: 只平不开模式 — 不接管新仓(密钥A策略未开,别再新接入管理)
          if (this._pauseOpen) continue;

          // 接管新持仓
          const side = amt > 0 ? 'LONG' : 'SHORT';
          const leverage = parseInt(r.leverage) || CONFIG.leverage;
          this.positions[r.symbol] = {
            symbol: r.symbol, side, qty: Math.abs(amt),
            entryPrice: parseFloat(r.entryPrice), currentPrice: parseFloat(r.markPrice),
            margin: Math.abs(amt) * parseFloat(r.entryPrice) / leverage,
            leverage, replenishCount: 0,
            _peakPnlPct: 0, _real: true,
            openTime: Date.now(), _klines: [],
            _orphan: true, // 标记为接管仓(非A策略开)
          };
          this._log(`📌 ${r.symbol} ${side} 接管实盘仓(A引擎接入管理)`);
        }
      }

      // 本地有但币安全平掉的 -> 查询真实盈亏并计入统计(不记估算虚账)
      for (const sym of Object.keys(this.positions)) {
        if (!remoteSymbols.has(sym)) {
          const pos = this.positions[sym];
          // 若为A策略开的真实仓,尝试统计真实盈亏(保证胜率/回报率完整)
          if (pos && pos._real && this.realTrading) {
            try {
              const startTime = pos.openTime || (Date.now() - 86400000);
              const income = await this.api.getIncome(startTime, Date.now(), 'REALIZED_PNL');
              const symInc = (income || []).filter(r => r.symbol === sym && Math.abs(parseFloat(r.income)) > 0.0001);
              if (symInc.length > 0) {
                const pnl = symInc.reduce((s, r) => s + parseFloat(r.income), 0);
                let fee = 0;
                if (pnl > 0 && this.wallet && !isFeeExempted(this.wallet)) {
                  fee = pnl * (FEE_CONFIG.PLATFORM_FEE_RATE + FEE_CONFIG.ECO_FUND_RATE);
                }
                const netPnl = pnl - fee;
                this._trades++; this._realizedPnl += netPnl;
                if (netPnl > 0) this._wins++; else this._losses++;
                this._log(`📝 ${sym} 外部平仓已统计 真实PnL=$${pnl.toFixed(2)}(费$${fee.toFixed(2)})净$${netPnl.toFixed(2)}`);
                // 补算力费
                if (pnl > 0 && this.wallet && !isFeeExempted(this.wallet)) {
                  await this._collectServiceFee(sym, pnl);
                }
              }
            } catch(e) { /* 统计失败不阻塞 */ }
          }
          delete this.positions[sym];
        }
      }
    } catch(e) { /* 同步失败不阻塞 */ }
  }

  async _scan() {
    this._cycleCount++;
    
    // 从币安同步真实持仓(接管用户账户已有仓+更新价格)
    await this._syncPositions();

    // 实盘模式: 从币安刷新真实余额(用于正确计算开仓量)
    if (this.realTrading) {
      try {
        const realBal = await Promise.race([
          this.api.getBalance(),
          new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 10000))
        ]).catch(() => null);
        if (typeof realBal === 'number' && realBal >= 0) {
          this.balance = realBal;
        }
      } catch(e) {}
    }

    // 管理现有持仓
    for (const symbol of Object.keys(this.positions)) {
      const pos = this.positions[symbol];
      try {
        const klines = await Promise.race([
          this.api.getKlines(symbol, CONFIG.klineInterval, CONFIG.klineLimit),
          new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 10000))
        ]).catch(e => null);
        if (!klines || klines.length < 60) continue;
        pos.currentPrice = klines[klines.length - 1].close;
        
        // 止损(含趋势确认)
        const sl = this.checkStopLoss(pos, klines);
        if (sl.action === 'CLOSE') { await this._simClose(symbol, sl.reason); continue; }
        // v8: 分批止损 — 软损趋势反向时先平一半(防假止损,留一半看趋势恢复)
        if (sl.action === 'HALF') {
          if (!pos._halved) {
            pos._halved = true;
            this._log(`✂️ ${symbol} ${sl.reason}(减仓一半防假止损)`);
            try {
              if (this.realTrading) {
                const halfQty = pos.qty / 2;
                if (pos.side === 'LONG') await this.api.closeLong(symbol, halfQty, this.precisionMap);
                else await this.api.closeShort(symbol, halfQty, this.precisionMap);
              }
              pos.qty = pos.qty / 2;
              pos.margin = pos.margin / 2;
              this._saveState();
            } catch(e) { this._log(`⚠️ ${symbol} 减半失败: ${e.message.slice(0,30)}`); }
          }
          continue; // 减半后本轮跳过其他操作
        }
        
        // 止盈
        const tp = this.checkTakeProfit(pos, klines);
        if (tp.action === 'CLOSE') { await this._simClose(symbol, tp.reason); continue; }
        
        const pnlPct = this._calcPnlPct(pos, pos.currentPrice);
        this._log(`📊 ${symbol} ${pos.side} PnL=${pnlPct.toFixed(1)}% 置信度=${pos._nnConfidence?.toFixed(2)}`);
      } catch(e) { this._log(`⚠️ ${symbol} 异常: ${e.message}`); }
    }
    
    // 选币开仓
    // v16: 只平不开模式 — 停止开新仓
    if (this._pauseOpen) { this._saveState(); return; }
    if (Object.keys(this.positions).length >= CONFIG.maxPositions) {
      this._saveState();
      return;
    }
    
    const symbols = await this.selectSymbols();
    if (symbols.length === 0) { this._saveState(); return; }
    
    let openedThisRound = 0; // v10fix: 每轮最多开2个仓,避免一次性追涨多个
    for (const symbol of symbols) {
      if (this.positions[symbol]) continue;
      if (Object.keys(this.positions).length >= CONFIG.maxPositions) break;
      // v10fix: 每轮最多开2个仓,避免一次性追涨多个(减少连开被套风险)
      if (openedThisRound >= 2) break;
      // v5: 止损后冷却期检查
      if (this._closedTimes && this._closedTimes[symbol] && (Date.now() - this._closedTimes[symbol] < CONFIG.cooldownMs)) continue;
      // v5: 单币最多交易2次/天
      if (!this._dailyTrades) this._dailyTrades = {};
      const today = new Date().toDateString();
      if (!this._dailyTrades[today]) this._dailyTrades[today] = {};
      if ((this._dailyTrades[today][symbol] || 0) >= CONFIG.maxTradesPerSymbol) continue;
      try {
        const klines = await Promise.race([
          this.api.getKlines(symbol, CONFIG.klineInterval, CONFIG.klineLimit),
          new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 10000))
        ]).catch(e => null);
        if (!klines || klines.length < 120) continue;
        
        const signal = await this.checkSignal(klines, symbol);
        if (signal.allowed) {
          // ★★ 趋势交易: 开仓必须顺标的15m趋势(逆势不开) — 防震荡市频繁反向开仓亏损
          let trendOk = true;
          if (CONFIG.requireSymbolTrend) {
            const tr = await this._getSymbolTrend(symbol);
            if (signal.direction === 'LONG' && tr.dir === 'DOWN') trendOk = false;
            else if (signal.direction === 'SHORT' && tr.dir === 'UP') trendOk = false;
          }
          if (!trendOk) {
            this._log(`◀ ${symbol} ${signal.direction}信号但逆15m趋势(${tr.dir}),不开仓(趋势交易过滤)`);
            continue;
          }
          signal._price = klines[klines.length - 1].close;
          signal._klines = klines;
          this._log(`🟢 ${symbol} ${signal.direction}MA7信号: ${signal.reason}`);
          await this._simOpen(symbol, signal.direction, signal);
          openedThisRound++;
          this._dailyTrades[today][symbol] = (this._dailyTrades[today][symbol] || 0) + 1;
        }
      } catch(e) {}
    }
    
    if (this._cycleCount % 10 === 0) {
      this._log(`第${this._cycleCount}轮: ${Object.keys(this.positions).length}仓 余额$${this.balance.toFixed(2)} ${this._trades}笔 ${this._wins}胜${this._losses}负`);
    }
    
    this._saveState();
  }
}

module.exports = { AStrategySim, CONFIG };
