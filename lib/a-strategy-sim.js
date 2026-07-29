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
  rsiOversold: 30,           // RSI<30做多确认
  rsiOverbought: 70,         // RSI>70做空确认
  macdConfirm: true,         // MACD方向确认
  
  // 止盈止损
  profitTriggerPct: 3.0,     // 浮盈≥3%触发移动止盈
  trailDrawdownPct: 1.5,     // 峰值回撤1.5%锁利
  totalLossPct: 15,          // 总浮亏≥15%含杠杆止损
  
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
  constructor(apiKey, apiSecret) {
    this.api = new BinanceAPI(apiKey, apiSecret);
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

    // 1. 神经网络预测
    let nnPred = null;
    try {
      const features = this.nn.extractFeatures(klines);
      if (features) {
        nnPred = this.nn.predict(features);
      }
    } catch(e) {}

    if (!nnPred || nnPred.confidence < CONFIG.nnMinConfidence) {
      return { allowed: false, reason: `NN置信度${nnPred?.confidence.toFixed(2) || 0}<${CONFIG.nnMinConfidence}` };
    }

    // 2. ML预测
    let mlPred = null;
    try {
      mlPred = this.ml.predict(klines, {});
    } catch(e) {}

    if (!mlPred || !mlPred.valid) {
      return { allowed: false, reason: 'ML预测无效' };
    }

    // 3. 两个AI方向必须一致
    const nnDirection = nnPred.action === 'BUY' ? 1 : (nnPred.action === 'SELL' ? -1 : 0);
    const mlDirection = mlPred.direction;
    
    if (nnDirection === 0 || mlDirection === 0) {
      return { allowed: false, reason: 'AI方向中性' };
    }
    if (nnDirection !== mlDirection) {
      return { allowed: false, reason: `AI方向矛盾 NN=${nnDirection} ML=${mlDirection}` };
    }

    // 4. 传统指标确认
    const closes = klines.map(k => k.close);
    const rsi = this._calcRSI(closes, 14);
    const macd = this._calcMACD(closes);
    
    let indicatorConfirm = false;
    let indicatorReason = '';
    
    if (nnDirection === 1) { // 做多
      // RSI超卖反弹 或 MACD金叉
      if (rsi < 45) { indicatorConfirm = true; indicatorReason = `RSI=${rsi.toFixed(0)}<45`; }
      else if (macd.hist > 0 && macd.hist > macd.prevHist) { indicatorConfirm = true; indicatorReason = `MACD柱增长`; }
    } else { // 做空
      // RSI超买回落 或 MACD死叉
      if (rsi > 55) { indicatorConfirm = true; indicatorReason = `RSI=${rsi.toFixed(0)}>55`; }
      else if (macd.hist < 0 && macd.hist < macd.prevHist) { indicatorConfirm = true; indicatorReason = `MACD柱减少`; }
    }
    
    if (!indicatorConfirm) {
      return { allowed: false, reason: `指标未确认 RSI=${rsi.toFixed(0)} MACD=${macd.hist.toFixed(6)}` };
    }

    // 5. ATR过滤
    const atr = Indicators.atr(klines, 14);
    const lastClose = klines[klines.length - 1].close;
    const atrPct = atr / lastClose * 100;
    if (atrPct < 0.10) return { allowed: false, reason: `ATR${atrPct.toFixed(2)}%过低` };

    const direction = nnDirection === 1 ? 'LONG' : 'SHORT';
    const avgConfidence = (nnPred.confidence + Math.abs(mlPred.confidence)) / 2;
    
    return {
      allowed: true,
      direction,
      reason: `AI选币: NN=${nnPred.confidence.toFixed(2)} ML=${mlPred.confidence.toFixed(2)} ${indicatorReason} ATR=${atrPct.toFixed(2)}%`,
      confidence: avgConfidence,
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

  // ═══ 止损: 总浮亏 ═══
  checkStopLoss(pos) {
    const pnlPct = this._calcPnlPct(pos, pos.currentPrice);
    if (pnlPct <= -CONFIG.totalLossPct) {
      return { action: 'CLOSE', reason: `止损: 浮亏${pnlPct.toFixed(1)}%≥-${CONFIG.totalLossPct}%` };
    }
    return { action: 'HOLD' };
  }

  // ═══ 模拟开仓 ═══
  _simOpen(symbol, direction, signal) {
    if (Object.keys(this.positions).length >= CONFIG.maxPositions) return;
    if (this.positions[symbol]) return;
    
    const price = signal._price;
    const positionPct = this._getPositionSize(signal.confidence, signal.atrPct);
    const leverage = this._getLeverage(signal.atrPct);
    const margin = this.balance * positionPct;
    const notional = margin * leverage;
    const qty = notional / price;
    
    this.positions[symbol] = {
      symbol, side: direction, qty, entryPrice: price,
      margin, leverage, currentPrice: price,
      _peakPnlPct: 0, _nnConfidence: signal.confidence,
      _mlDirection: direction, openTime: Date.now(),
    };
    this._log(`🟢 ${symbol} ${direction} 模拟开仓 qty=${qty.toFixed(4)} margin=$${margin.toFixed(2)} lev=${leverage}x 置信度=${signal.confidence.toFixed(2)}`);
  }

  // ═══ 模拟平仓 ═══
  _simClose(symbol, reason) {
    const pos = this.positions[symbol];
    if (!pos) return;
    
    const pnlUsd = this._calcPnlUsd(pos, pos.currentPrice);
    this.balance += pnlUsd;
    this._trades++;
    this._realizedPnl += pnlUsd;
    if (pnlUsd > 0) this._wins++;
    else this._losses++;
    
    // 训练神经网络(反馈)
    try {
      const label = pnlUsd > 0 ? (pos.side === 'LONG' ? 'up' : 'down') : (pos.side === 'LONG' ? 'down' : 'up');
      // 这里可以加训练代码
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
    this._log('🚀 A策略模拟实盘启动');
    this._log(`💰 模拟资金: $${this.balance.toFixed(2)}`);
    try { this.precisionMap = await this.api.getExchangeInfo(); } catch(e) {}
    this._loop();
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
        
        // 止损
        const sl = this.checkStopLoss(pos);
        if (sl.action === 'CLOSE') { this._simClose(symbol, sl.reason); continue; }
        
        // 止盈
        const tp = this.checkTakeProfit(pos);
        if (tp.action === 'CLOSE') { this._simClose(symbol, tp.reason); continue; }
        
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
      try {
        const klines = await Promise.race([
          this.api.getKlines(symbol, CONFIG.klineInterval, CONFIG.klineLimit),
          new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 10000))
        ]).catch(e => null);
        if (!klines || klines.length < 120) continue;
        
        const signal = await this.checkSignal(klines, symbol);
        if (signal.allowed) {
          signal._price = klines[klines.length - 1].close;
          this._simOpen(symbol, signal.direction, signal);
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
