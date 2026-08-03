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

const { BinanceAPI, Indicators } = require('./common');
const { NeuralNet } = require('../saas/strategies/neural-net');
const { MLPredictor } = require('../saas/strategies/ml-predictor');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  // 模拟资金
  initialBalance: 1000,
  leverage: 3,
  maxPositions: 5,
  
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
  cooldownMs: 7200000,       // v5: 止损后同一币冷却2小时
  maxTradesPerSymbol: 2,     // v5: 单币最多交易2次/天
  
  // 运行
  scanIntervalMs: 60000,
  klineInterval: '5m',
  klineLimit: 200,
  topN: 30,
  
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
      const dir = path.dirname(CONFIG.logFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(CONFIG.logFile, line + '\n');
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
      if (fs.existsSync(CONFIG.stateFile)) {
        const d = JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
        this.balance = d.balance || CONFIG.initialBalance;
        this.positions = d.positions || {};
        this._trades = d.trades || 0;
        this._wins = d.wins || 0;
        this._losses = d.losses || 0;
        this._realizedPnl = d.realizedPnl || 0;
        this._modelStats = d.modelStats || this._modelStats;
        this._log(`📂 加载状态: 余额$${this.balance.toFixed(2)} ${Object.keys(this.positions).length}仓 ${this._trades}笔`);
      }
    } catch(e) {}
  }

  _saveState() {
    try {
      const dir = path.dirname(CONFIG.stateFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CONFIG.stateFile, JSON.stringify({
        balance: this.balance, positions: this.positions,
        trades: this._trades, wins: this._wins, losses: this._losses,
        realizedPnl: this._realizedPnl, modelStats: this._modelStats,
      }, null, 2));
    } catch(e) {}
  }

  _recordTrade(symbol, pos, reason, pnlUsd) {
    try {
      let trades = [];
      if (fs.existsSync(CONFIG.tradesFile)) trades = JSON.parse(fs.readFileSync(CONFIG.tradesFile, 'utf8'));
      trades.push({
        symbol, side: pos.side, qty: pos.qty,
        entryPrice: pos.entryPrice, exitPrice: pos.currentPrice,
        pnlUsd: +pnlUsd.toFixed(4), pnlPct: +pos._lastPnlPct.toFixed(2),
        margin: pos.margin, leverage: pos.leverage,
        reason, closeTime: Date.now(),
        nnConfidence: pos._nnConfidence, mlDirection: pos._mlDirection,
      });
      if (trades.length > 200) trades = trades.slice(-200);
      fs.writeFileSync(CONFIG.tradesFile, JSON.stringify(trades, null, 2));
    } catch(e) {}
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
    
    let direction = 0;
    let indicatorReason = '';
    
    // v4: 做多: EMA多头 + RSI<45 + MACD柱增长
    if (isUptrend && rsi < 45 && macd.hist > macd.prevHist) {
      direction = 1;
      indicatorReason = `EMA多头+RSI=${rsi.toFixed(0)}<45+MACD增长`;
    }
    // v4: 做空: EMA空头 + RSI>55 + MACD柱减少
    else if (isDowntrend && rsi > 55 && macd.hist < macd.prevHist) {
      direction = -1;
      indicatorReason = `EMA空头+RSI=${rsi.toFixed(0)}>55+MACD减少`;
    }
    
    if (direction === 0) {
      return { allowed: false, reason: `指标未确认 RSI=${rsi.toFixed(0)} EMA=${isUptrend?'多':'空'} MACD=${macd.hist.toFixed(6)}` };
    }

    // v4: AI分计算 + 最低分过滤
    let aiScore = 0.5; // 基础分
    if (nnPred) {
      const nnDir = nnPred.action === 'BUY' ? 1 : (nnPred.action === 'SELL' ? -1 : 0);
      if (nnDir === direction) aiScore += 0.2;
    }
    if (mlDirection === direction) aiScore += 0.2;
    aiScore = Math.min(aiScore, 1.0);
    // v4: AI分<0.60不开仓(0.50胜率37.5%,0.70胜率100%)
    if (aiScore < CONFIG.minAiScore) {
      return { allowed: false, reason: `AI分${aiScore.toFixed(2)}<${CONFIG.minAiScore} 不开仓` };
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
    
    if (pnlPct < CONFIG.profitTriggerPct) return { action: 'HOLD' };
    
    if (!pos._peakPnlPct || pnlPct > pos._peakPnlPct) pos._peakPnlPct = pnlPct;
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
    // 硬止损: 浮亏≥10% 无条件止损
    if (pnlPct <= -CONFIG.totalLossPct) {
      return { action: 'CLOSE', reason: `止损: 浮亏${pnlPct.toFixed(1)}%≥-${CONFIG.totalLossPct}%` };
    }
    // 软止损+趋势确认: 浮亏≥6% 且 EMA趋势对持仓不利 → 提前止损
    if (pnlPct <= -CONFIG.softLossPct && klines && klines.length >= 60) {
      const { Indicators } = require('./common');
      const ema20 = Indicators.ema(klines, 20);
      const ema60 = Indicators.ema(klines, 60);
      if (ema20 && ema60) {
        const trendUp = ema20 > ema60;
        // 做多但趋势已转空 → 止损；做空但趋势已转多 → 止损
        if ((pos.side === 'LONG' && !trendUp) || (pos.side === 'SHORT' && trendUp)) {
          const trendDir = trendUp ? '多头' : '空头'; // 当前EMA趋势
          return { action: 'CLOSE', reason: `趋势止损: 浮亏${pnlPct.toFixed(1)}%,EMA现${trendDir}不利${pos.side}` };
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
    this.balance += pnlUsd;
    this._trades++;
    this._realizedPnl += pnlUsd;
    if (pnlUsd > 0) this._wins++;
    else this._losses++;
    
    // v5: 记录平仓时间用于冷却期
    if (!this._closedTimes) this._closedTimes = {};
    this._closedTimes[symbol] = Date.now();
    
    // v3: 训练神经网络(用实际结果反馈)
    try {
      // 重新提取开仓时的特征
      const features = this.nn.extractFeatures(pos._klines || []);
      if (features) {
        // 实际结果: 盈利=方向正确, 亏损=方向错误
        const label = pnlUsd > 0 
          ? (pos.side === 'LONG' ? 1 : -1)   // 盈利: 做多→up, 做空→down
          : (pos.side === 'LONG' ? -1 : 1); // 亏损: 做多→down, 做空→up
        const correct = this.nn.train(features, label);
        // 统计准确率
        this._modelStats.nnTotal = (this._modelStats.nnTotal || 0) + 1;
        if (correct) this._modelStats.nnCorrect = (this._modelStats.nnCorrect || 0) + 1;
        // 每10笔保存一次模型
        if (this._trades % 10 === 0) {
          this.nn.save(path.join(__dirname, '..', 'data', 'neural-model.json'));
          this._log(`🧠 模型已保存(训练${this.nn.trainCount}次 准确率${this._modelStats.nnCorrect}/${this._modelStats.nnTotal})`);
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
    
    this._log(`✅ ${symbol} 模拟平仓 ${reason} PnL=$${pnlUsd.toFixed(2)} 余额=$${this.balance.toFixed(2)}`);
    this._recordTrade(symbol, pos, reason, pnlUsd);
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

  async _scan() {
    this._cycleCount++;
    
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
    
    for (const symbol of symbols) {
      if (this.positions[symbol]) continue;
      if (Object.keys(this.positions).length >= CONFIG.maxPositions) break;
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
