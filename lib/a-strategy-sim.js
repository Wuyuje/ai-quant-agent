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

const CONFIG = {
  // 模拟资金
  initialBalance: 1000,
  leverage: 3,
  maxPositions: 7,         // v7: 提高到7,配合账容守卫放宽让更积极开仓(守卫兜底防超载)
  
  // AI选币门槛
  nnMinConfidence: 0.65,    // 神经网络置信度>65%
  mlMinConfidence: 0.30,    // ML预测强度>0.30
  
  // 传统指标确认
  rsiOversold: 45,           // v4: RSI<45做多确认(从30放宽)
  rsiOverbought: 55,         // v4: RSI>55做空确认(从70放宽)
  macdConfirm: true,         // MACD方向确认
  
  // v6: 止盈止损优化 (盈亏比修正)
  profitTriggerPct: 3.0,     // 浮盈≥3%触发移动止盈
  trailDrawdownPct: 1.8,     // v6: 回撤1.8%锁利(B轻微放宽,让盈利多跑一点)
  totalLossPct: 10,          // v6: 硬止损10%(从15收窄,单笔亏损减半)
  softLossPct: 6,            // v6: 软止损——浮亏≥6%且趋势反向时提前止损(趋势确认)
  minAiScore: 0.50,          // v5: AI分<0.50不开仓(0.50也有+$28.54盈利)
  // v7: 行情过滤 — 大盘普涨时禁止做空(减少逆势空单亏损)
  btcTrendEnabled: true,      // 启用BTC大盘趋势过滤
  btcTrendSymbol: 'BTCUSDT',  // 大盘代表
  btcTrendCacheMs: 60000,     // BTC趋势缓存1分钟
  btcBullDenyShort: true,     // BTC多头时禁止做空
  // v8: 提高胜率/回报率 — 开仓更准
  minAiScore: 0.60,           // v8: AI分门槛0.50→0.60(减少不自信开仓)
  adxMin: 20,                 // v8: ADX>20才开仓(只在有明确趋势时,减少震荡被套)
  profitTriggerPct: 4.0,      // v8: 止盈目标3%→4%(让盈利单跑更多)
  trailDrawdownPct: 2.2,      // v8: 移动止盈回撤1.8%→2.2%(别太早锁利,让利润跑)
  totalLossPct: 8,            // v8: 硬止损10%→8%(普通用户单笔亏损更可控)
  softLossPct: 5,             // v8: 软止损6%→5%(空单等更早止损)
  // v9: 顶尖量化 — 多信号共识 + 盈亏比优先
  minConsensusVotes: 3,       // 至少3路信号同向才开仓(多信号共识减少假信号)
  signalWeights: { ema: 1.2, rsi: 0.8, macd: 0.8, nn: 1.0, ml: 1.0 }, // 信号权重(EMA/趋势权重最高)
  consensusThreshold: 1.8,    // 加权共识分≥1.8才开仓
  // v15: 固定高盈亏比止盈 — 不依赖趋势奔跑(震荡市跑不远)
  profitTriggerPct: 5.0,      // v15: 移动止盈触发(备用,主用固定止盈)
  fixedTakeProfitPct: 10,     // v15: 固定止盈目标10%(到达即平)→ 盈亏比10:5=2:1
  trailDrawdownPct: 4.0,      // v15: 若用移动止盈,回撤4%锁利(备用)
  breakEvenPct: 5.0,          // v15: 保本锁利线
  totalLossPct: 5,            // v15: 硬止损5% → 盈亏比2:1
  softLossPct: 4,             // v15: 软止损4%
  cooldownMs: 7200000,       // v5: 止损后同一币冷却2小时
  maxTradesPerSymbol: 2,     // v5: 单币最多交易2次/天
  
  // 运行
  scanIntervalMs: 60000,
  klineInterval: '5m',
  klineLimit: 200,
  topN: 40,              // v7: 候选池扩大,更多开仓机会
  
  blacklist: ['BANKUSDT', 'BTCUSDT', 'BNBUSDT'],
  
  stateFile: path.join(__dirname, '..', 'data', 'a-strategy-sim-state.json'),
  tradesFile: path.join(__dirname, '..', 'data', 'a-strategy-sim-trades.json'),
  logFile: path.join(__dirname, '..', 'logs', 'a-strategy-sim.log'),
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



  // ═══ 选币: AI预测+传统指标确认 ═══
  async selectSymbols() {
    const tickers = await Promise.race([
      this.api.getAllTickers(),
      new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 15000))
    ]).catch(e => { this._log('⚠️ 选币超时'); return []; });
    
    if (!tickers || !tickers.filter) return [];
    
    const candidates = tickers
      .filter(t => t.symbol.endsWith('USDT') && !CONFIG.blacklist.includes(t.symbol))
      .sort((a, b) => b.volume - a.volume)
      .slice(0, CONFIG.topN)
      .map(t => t.symbol);
    
    return candidates;
  }

  // ═══ AI选币+指标确认 ═══
  async checkSignal(klines, symbol) {
    if (klines.length < 60) return { allowed: false };

    // 1. 神经网络预测(参考,不作为硬性门槛)
    let nnPred = null;
    let nnConfidence = 0;
    try {
      const features = this.nn.extractFeatures(klines);
      if (features) {
        nnPred = this.nn.predict(features);
        nnConfidence = nnPred.confidence || 0;
      }
    } catch(e) {}

    // 2. ML预测(参考)
    let mlPred = null;
    let mlDirection = 0;
    let mlConfidence = 0;
    try {
      mlPred = this.ml.predict(klines, {});
      if (mlPred && mlPred.valid) {
        mlDirection = mlPred.direction;
        mlConfidence = Math.abs(mlPred.confidence || 0);
      }
    } catch(e) {}

    // 3. 传统指标做主力决策
    const closes = klines.map(k => k.close);
    const rsi = this._calcRSI(closes, 14);
    const macd = this._calcMACD(closes);
    const ema20 = Indicators.ema(klines, 20);
    const ema60 = Indicators.ema(klines, 60);
    
    if (!ema20 || !ema60) return { allowed: false, reason: 'EMA数据不足' };
    
    const isUptrend = ema20 > ema60;
    const isDowntrend = ema20 < ema60;

    // v7/v8: 行情过滤 — BTC大盘趋势判断(BTC震荡/逆势禁开仓)
    if (CONFIG.btcTrendEnabled) {
      try {
        const btc = await this._getBtcTrend();
        if (btc) {
          // BTC震荡(ADX低)时禁开新仓,避免在无趋势行情被来回扫
          if (!btc.btcStrong) {
            return { allowed: false, reason: `BTC大盘震荡(ADX${btc.btcAdx.toFixed(0)}),暂不开新仓` };
          }
          // BTC多头时禁止逆势做空
          if (isDowntrend && btc.btcBull) {
            return { allowed: false, reason: 'BTC大盘多头,禁止逆势做空' };
          }
        }
      } catch(e) { /* 行情获取失败不阻塞 */ }
    }

    // v9 多信号共识投票 — 5路信号各自投票,加权求和,达标才开仓(减少单一假信号)
    const W = CONFIG.signalWeights || { ema:1.2, rsi:0.8, macd:0.8, nn:1.0, ml:1.0 };
    // 每路信号给方向: +1做多, -1做空, 0中性
    let longScore=0, shortScore=0, votes=0;
    // 1. EMA趋势(权重最高)
    if (isUptrend) longScore += W.ema; else if (isDowntrend) shortScore += W.ema;
    // 2. RSI
    if (rsi < 45) longScore += W.rsi; else if (rsi > 55) shortScore += W.rsi;
    // 3. MACD
    if (macd.hist > macd.prevHist) longScore += W.macd; else if (macd.hist < macd.prevHist) shortScore += W.macd;
    // 4. 神经网络
    if (nnPred) {
      const nnDir = nnPred.action === 'BUY' ? 1 : (nnPred.action === 'SELL' ? -1 : 0);
      if (nnDir === 1) longScore += W.nn; else if (nnDir === -1) shortScore += W.nn;
    }
    // 5. ML预测
    if (mlDirection === 1) longScore += W.ml; else if (mlDirection === -1) shortScore += W.ml;

    // 共识判定: 看多/看空谁更强,且差距达到阈值
    const thresh = CONFIG.consensusThreshold || 1.8;
    let direction = 0, indicatorReason = '';
    if (longScore >= thresh && longScore - shortScore >= 0.8) {
      direction = 1;
      indicatorReason = `共识做多(±${longScore.toFixed(1)} vs ${shortScore.toFixed(1)})`;
    } else if (shortScore >= thresh && shortScore - longScore >= 0.8) {
      direction = -1;
      indicatorReason = `共识做空(空${shortScore.toFixed(1)} vs 多${longScore.toFixed(1)})`;
    }

    if (direction === 0) {
      return { allowed: false, reason: `信号共识不足(多${longScore.toFixed(1)}/空${shortScore.toFixed(1)},需≥${thresh})` };
    }

    // v8: ADX趋势强度确认 — 只在明确趋势时开仓,减少震荡被套
    if (CONFIG.adxMin > 0) {
      const adx = this._calcADX(klines, 14);
      if (adx != null && adx < CONFIG.adxMin) {
        return { allowed: false, reason: `ADX${adx.toFixed(1)}<${CONFIG.adxMin}(趋势弱,不开仓)` };
      }
    }

    // v4: AI分计算 + 最低分过滤
    let aiScore = 0.5; // 基础分
    if (nnPred) {
      const nnDir = nnPred.action === 'BUY' ? 1 : (nnPred.action === 'SELL' ? -1 : 0);
      if (nnDir === direction) aiScore += 0.2;
    }
    if (mlDirection === direction) aiScore += 0.2;
    aiScore = Math.min(aiScore, 1.0);
    // v7: 做空更谨慎 — 空单AI分门槛更高(≥0.7),避免弱信号逆势做空
    const minScore = direction === -1 ? Math.max(CONFIG.minAiScore, 0.70) : CONFIG.minAiScore;
    if (aiScore < minScore) {
      return { allowed: false, reason: `AI分${aiScore.toFixed(2)}<${minScore.toFixed(2)}(${direction===-1?'空单需更高':'常规'}) 不开仓` };
    }

    // 5. ATR过滤
    const atr = Indicators.atr(klines, 14);
    const lastClose = klines[klines.length - 1].close;
    const atrPct = atr / lastClose * 100;
    if (atrPct < 0.10) return { allowed: false, reason: `ATR${atrPct.toFixed(2)}%过低` };

    const dir = direction === 1 ? 'LONG' : 'SHORT';
    
    return {
      allowed: true,
      direction: dir,
      reason: `${indicatorReason} AI分=${aiScore.toFixed(2)} ATR=${atrPct.toFixed(2)}%`,
      confidence: aiScore,
      atrPct,
    };
  }

  // v8: ADX计算(趋势强度0-100,>25强趋势,>20可用)
  _calcADX(klines, period = 14) {
    try {
      if (!klines || klines.length < period * 3) return null;
      let trSum=0, dmPlusSum=0, dmMinusSum=0;
      // 第一个DI用首段计算,简化用近period根
      const start = klines.length - period - 1;
      for (let i = start+1; i < klines.length; i++) {
        const h=klines[i].high, l=klines[i].low, pc=klines[i-1].close;
        const tr=Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc));
        const up=h-klines[i-1].high, dn=klines[i-1].low-l;
        const dmPlus=(up>dn&&up>0)?up:0;
        const dmMinus=(dn>up&&dn>0)?dn:0;
        trSum+=tr; dmPlusSum+=dmPlus; dmMinusSum+=dmMinus;
      }
      if (trSum<=0) return null;
      const diPlus=100*dmPlusSum/trSum, diMinus=100*dmMinusSum/trSum;
      const diSum=diPlus+diMinus;
      if (diSum<=0) return null;
      const dx=100*Math.abs(diPlus-diMinus)/diSum;
      // 简化ADX≈DX(用一根K线近似,足够判断趋势强弱)
      return dx;
    } catch(e) { return null; }
  }

  _calcRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff > 0) gains += diff; else losses -= diff;
    }
    if (losses === 0) return 100;
    const rs = gains / losses;
    return 100 - (100 / (1 + rs));
  }

  _calcMACD(closes) {
    const ema12 = this._ema(closes, 12);
    const ema26 = this._ema(closes, 26);
    const macdLine = ema12 - ema26;
    const signalLine = this._ema(closes.slice(-9), 9);
    const hist = macdLine - signalLine;
    // 前一根的hist
    const prevEma12 = this._ema(closes.slice(0, -1), 12);
    const prevEma26 = this._ema(closes.slice(0, -1), 26);
    const prevMacd = prevEma12 - prevEma26;
    const prevSignal = this._ema(closes.slice(-10, -1), 9);
    const prevHist = prevMacd - prevSignal;
    return { macdLine, signalLine, hist, prevHist };
  }

  _ema(values, period) {
    if (values.length < period) return values[values.length - 1] || 0;
    const k = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < values.length; i++) {
      ema = values[i] * k + ema * (1 - k);
    }
    return ema;
  }

  // ═══ 止盈: 移动止盈 ═══
  checkTakeProfit(pos) {
    const pnlPct = this._calcPnlPct(pos, pos.currentPrice);
    pos._lastPnlPct = pnlPct;
    
    // v15: 固定止盈优先 —— 浮盈≥fixedTakeProfitPct(10%)直接平仓,锁2:1盈亏比(主力止盈)
    if (CONFIG.fixedTakeProfitPct > 0 && pnlPct >= CONFIG.fixedTakeProfitPct) {
      return { action: 'CLOSE', reason: `固定止盈: 浮盈${pnlPct.toFixed(1)}%≥${CONFIG.fixedTakeProfitPct}%` };
    }
    
    // 保本/锁利保护 — 浮盈达breakEvenPct后,若峰值回吐过半,锁住已得利润(防从盈变亏)
    if (!pos._peakPnlPct) pos._peakPnlPct = pnlPct > 0 ? pnlPct : 0;
    else if (pnlPct > pos._peakPnlPct) pos._peakPnlPct = pnlPct;
    if (CONFIG.breakEvenPct > 0 && pos._peakPnlPct >= CONFIG.breakEvenPct && pnlPct <= pos._peakPnlPct * 0.5 && pnlPct < CONFIG.profitTriggerPct) {
      return { action: 'CLOSE', reason: `保本锁利: 峰值${pos._peakPnlPct.toFixed(1)}%回吐至浮盈${pnlPct.toFixed(1)}%(过半)` };
    }
    
    if (pnlPct < CONFIG.profitTriggerPct) return { action: 'HOLD' };
    
    const drawdown = pos._peakPnlPct - pnlPct;
    
    if (pos._peakPnlPct > CONFIG.profitTriggerPct && drawdown >= CONFIG.trailDrawdownPct) {
      return { action: 'CLOSE', reason: `移动止盈: 峰值${pos._peakPnlPct.toFixed(1)}%回撤${drawdown.toFixed(1)}%` };
    }
    return { action: 'HOLD' };
  }

  // ═══ 止损: 总浮亏 + 趋势确认(A+C) ═══
  // A: 硬止损 totalLossPct(10%) 无条件平仓
  // C: 软止损 softLossPct(6%) + 趋势反向确认 → 提前止损,避免套牢
  checkStopLoss(pos, klines) {
    const pnlPct = this._calcPnlPct(pos, pos.currentPrice);
    // 硬止损: 浮亏≥5%(v10) 无条件全平
    if (pnlPct <= -CONFIG.totalLossPct) {
      return { action: 'CLOSE', reason: `止损: 浮亏${pnlPct.toFixed(1)}%≥-${CONFIG.totalLossPct}%` };
    }
    // 软止损+趋势确认: 浮亏≥softLoss(默认4%) 且趋势对持仓不利 → 先减仓一半(分批止损防假止损)
    const softLoss = pos.side === 'SHORT' ? Math.max(3.5, CONFIG.softLossPct - 0.5) : CONFIG.softLossPct;
    if (pnlPct <= -softLoss && klines && klines.length >= 60) {
      const { Indicators } = require('./common');
      const ema20 = Indicators.ema(klines, 20);
      const ema60 = Indicators.ema(klines, 60);
      if (ema20 && ema60) {
        const trendUp = ema20 > ema60;
        // 做多但趋势已转空 → 减半；做空但趋势已转多 → 减半
        if ((pos.side === 'LONG' && !trendUp) || (pos.side === 'SHORT' && trendUp)) {
          const trendDir = trendUp ? '多头' : '空头';
          return { action: 'HALF', reason: `趋势减半: 浮亏${pnlPct.toFixed(1)}%,EMA现${trendDir}不利${pos.side}(软${softLoss}%)` };
        }
      }
    }
    return { action: 'HOLD' };
  }

  // ═══ 模拟开仓 ═══
  async _simOpen(symbol, direction, signal) {
    if (Object.keys(this.positions).length >= CONFIG.maxPositions) return;
    if (this.positions[symbol]) return;
    
    const price = signal._price;
    const positionPct = this._getPositionSize(signal.confidence, signal.atrPct);
    const leverage = this._getLeverage(signal.atrPct);
    let margin = this.balance * positionPct;
    let notional = margin * leverage;
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
      const withTimeout = (p, ms) => Promise.race([p, new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 10000))]);
      const remote = await withTimeout(this.api.getPositions(), 10000).catch(() => null);
      if (!Array.isArray(remote)) return;

      // 币安有活跃仓的symbol
      const remoteSymbols = new Set(remote.filter(r => Math.abs(parseFloat(r.positionAmt)) > 0).map(r => r.symbol));

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
        const tp = this.checkTakeProfit(pos);
        if (tp.action === 'CLOSE') { await this._simClose(symbol, tp.reason); continue; }
        
        const pnlPct = this._calcPnlPct(pos, pos.currentPrice);
        this._log(`📊 ${symbol} ${pos.side} PnL=${pnlPct.toFixed(1)}% 置信度=${pos._nnConfidence?.toFixed(2)}`);
      } catch(e) { this._log(`⚠️ ${symbol} 异常: ${e.message}`); }
    }
    
    // 选币开仓
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
          signal._price = klines[klines.length - 1].close;
          signal._klines = klines;
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
