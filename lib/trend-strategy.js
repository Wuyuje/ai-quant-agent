/**
 * 趋势策略模块 — 独立运行
 * 
 * 开仓: EMA20/60排列 + EMA间距<2%(早期) + ADX>15 + ADX上升或EMA间距扩大 + 15min确认
 * 止盈: 浮盈≥2.5% + 移动止盈(峰值回撤1%) + 反向轨道兜底
 * 止损: ATR止损3.0(趋势仓更宽) + 单K止损3%(不含杠杆) + 终极止损15%(不含杠杆)
 * 不补仓: 趋势仓用移动止盈管理
 * 
 * 仓位: 最多2仓(和BB策略分开名额)
 * 互不干扰: 不管理mode='BB'的仓位
 */

const { BinanceAPI, Indicators } = require('./common');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  maxPositions: 2,           // 趋势策略最多2仓
  leverage: 3,
  topN: 50,
  
  blacklist: [
    'BANKUSDT', 'BTCUSDT', 'BNBUSDT',
    'TSLAUSDT', 'NVDAUSDT', 'AAPLUSDT', 'METAUSDT', 'MSFTUSDT',
    'GOOGLUSDT', 'SPYUSDT', 'QQQUSDT',
    'XAGUSDT', 'XAUUSDT', 'COPPERUSDT', 'NATGASUSDT',
    'UVXYUSDT', 'URNMUSDT',
  ],
  
  klineInterval: '5m',
  htfInterval: '15m',
  klineLimit: 200,
  
  bbPeriod: 20,
  bbStd: 2.0,
  atrPeriod: 14,
  minAtrPct: 0.10,
  
  profitTriggerPct: 2.5,      // 趋势仓止盈门槛更高
  trailDrawdownPct: 1.0,     // 峰值回撤1%锁利
  
  adxMin: 15,
  adxMax: 50,
  emaGapMax: 2.0,            // EMA间距<2%=趋势早期
  
  atrStopMultiplier: 3.0,    // 趋势仓ATR止损更宽
  singleKLossPct: 3,         // 单K止损3%(不含杠杆)
  ultimateLossPct: 15,       // 终极止损15%(不含杠杆)
  
  scanIntervalMs: 30000,
  stateFile: path.join(__dirname, '..', 'data', 'trend-strategy-state.json'),
  logFile: path.join(__dirname, '..', 'logs', 'trend-strategy.log'),
};

class TrendStrategy {
  constructor(apiKey, apiSecret, wallet) {
    this.api = new BinanceAPI(apiKey, apiSecret);
    this.wallet = wallet;
    this.positions = {};
    this.precisionMap = null;
    this.balance = 0;
    this.running = false;
    this._cycleCount = 0;
  }

  _log(msg) {
    const ts = new Date().toISOString();
    const line = `[TREND] ${ts} ${msg}`;
    console.log(line);
    try {
      const dir = path.dirname(CONFIG.logFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(CONFIG.logFile, line + '\n');
    } catch(e) {}
  }

  _getPositionPct(atrPct) {
    if (atrPct > 0.5) return 0.07;
    if (atrPct > 0.2) return 0.10;
    return 0.12;
  }

  _calcPnlPct(pos, price) {
    if (pos.side === 'LONG') return (price - pos.entryPrice) / pos.entryPrice * 100 * pos.leverage;
    return (pos.entryPrice - price) / pos.entryPrice * 100 * pos.leverage;
  }

  _calcPnlUsd(pos, price) {
    if (pos.side === 'LONG') return (price - pos.entryPrice) * pos.qty;
    return (pos.entryPrice - price) * pos.qty;
  }

  _calcLossPct(pos) {
    const price = pos.currentPrice || pos.entryPrice;
    if (pos.side === 'LONG') return Math.max(0, (pos.entryPrice - price) / pos.entryPrice * 100);
    return Math.max(0, (price - pos.entryPrice) / pos.entryPrice * 100);
  }

  // ═══ 选币 ═══
  async selectSymbols() {
    const tickers = await this.api.getAllTickers();
    return tickers
      .filter(t => t.symbol.endsWith('USDT') && !CONFIG.blacklist.includes(t.symbol))
      .sort((a, b) => b.volume - a.volume)
      .slice(0, CONFIG.topN)
      .map(t => t.symbol);
  }

  // ═══ 开仓条件 ═══
  async checkOpenCondition(klines, symbol) {
    const atr = Indicators.atr(klines, CONFIG.atrPeriod);
    const lastClose = klines[klines.length - 1].close;
    if (!atr || atr / lastClose * 100 < CONFIG.minAtrPct) return { allowed: false };

    const ema20 = Indicators.ema(klines, 20);
    const ema60 = Indicators.ema(klines, 60);
    if (!ema20 || !ema60) return { allowed: false };

    const isUptrend = ema20 > ema60;
    const isDowntrend = ema20 < ema60;
    const emaGapPct = Math.abs(ema20 - ema60) / ema60 * 100;
    if (emaGapPct >= CONFIG.emaGapMax) return { allowed: false }; // 趋势已跑远

    const adx = Indicators.adx(klines, 14);
    if (!adx || adx < CONFIG.adxMin || adx > CONFIG.adxMax) return { allowed: false };

    // ADX上升 OR EMA间距在扩大
    const prevAdx = Indicators.adx(klines.slice(0, -1), 14);
    const prevEma20 = Indicators.ema(klines.slice(0, -1), 20);
    const prevEma60 = Indicators.ema(klines.slice(0, -1), 60);
    const prevGap = (prevEma20 && prevEma60) ? Math.abs(prevEma20 - prevEma60) / prevEma60 * 100 : 0;
    const adxGoingUp = (prevAdx && adx > prevAdx) || (emaGapPct > prevGap);
    if (!adxGoingUp) return { allowed: false };

    // 15min确认大方向一致
    let htfConfirmed = true;
    try {
      const htf = await this.api.getKlines(symbol, CONFIG.htfInterval, 100);
      if (htf.length >= 60) {
        const htfEma20 = Indicators.ema(htf, 20);
        const htfEma60 = Indicators.ema(htf, 60);
        if (htfEma20 && htfEma60) {
          if (isUptrend && htfEma20 <= htfEma60) htfConfirmed = false;
          if (isDowntrend && htfEma20 >= htfEma60) htfConfirmed = false;
        }
      }
    } catch(e) {}

    if (!htfConfirmed) return { allowed: false };

    if (isUptrend) return { allowed: true, direction: 'LONG', reason: `趋势做多: EMA多头+间距${emaGapPct.toFixed(2)}%+ADX=${adx.toFixed(1)}` };
    if (isDowntrend) return { allowed: true, direction: 'SHORT', reason: `趋势做空: EMA空头+间距${emaGapPct.toFixed(2)}%+ADX=${adx.toFixed(1)}` };
    return { allowed: false };
  }

  // ═══ 止盈 ═══
  checkTakeProfit(klines, pos) {
    const bb = Indicators.bollinger(klines, CONFIG.bbPeriod, CONFIG.bbStd);
    if (!bb) return { action: 'HOLD' };
    const close = klines[klines.length - 1].close;
    const pnlPct = this._calcPnlPct(pos, close);

    if (pnlPct < CONFIG.profitTriggerPct) return { action: 'HOLD' };

    // 移动止盈 — 峰值回撤1%锁利
    if (!pos._peakPnlPct || pnlPct > pos._peakPnlPct) pos._peakPnlPct = pnlPct;
    const drawdown = pos._peakPnlPct - pnlPct;
    if (pos._peakPnlPct > CONFIG.profitTriggerPct + 0.5 && drawdown >= CONFIG.trailDrawdownPct) {
      return { action: 'CLOSE', reason: `移动止盈: 峰值${pos._peakPnlPct.toFixed(1)}%回撤${drawdown.toFixed(1)}%` };
    }

    // 反向轨道兜底
    if (pos.side === 'LONG' && close >= bb.upper) return { action: 'CLOSE', reason: `触上轨止盈` };
    if (pos.side === 'SHORT' && close <= bb.lower) return { action: 'CLOSE', reason: `触下轨止盈` };

    return { action: 'HOLD' };
  }

  // ═══ ATR止损 (趋势仓3.0ATR更宽) ═══
  checkAtrStopLoss(klines, pos) {
    const atr = Indicators.atr(klines, CONFIG.atrPeriod);
    if (!atr) return { action: 'HOLD' };
    const close = klines[klines.length - 1].close;
    const stopPct = atr / close * 100 * CONFIG.atrStopMultiplier;
    const pnlPct = this._calcPnlPct(pos, close);
    if (pnlPct <= -stopPct) return { action: 'CLOSE', reason: `ATR止损: ${pnlPct.toFixed(1)}%≤-${stopPct.toFixed(1)}%` };
    return { action: 'HOLD' };
  }

  // ═══ 单K止损 (不含杠杆) ═══
  checkSingleKStopLoss(klines, pos) {
    const lastK = klines[klines.length - 1];
    const prevK = klines[klines.length - 2];
    if (!prevK) return { action: 'HOLD' };
    let klineLossPct;
    if (pos.side === 'LONG') klineLossPct = (prevK.close - lastK.close) / prevK.close * 100;
    else klineLossPct = (lastK.close - prevK.close) / prevK.close * 100;
    if (klineLossPct >= CONFIG.singleKLossPct) return { action: 'CLOSE', reason: `单K止损: ${klineLossPct.toFixed(1)}%≥${CONFIG.singleKLossPct}%` };
    return { action: 'HOLD' };
  }

  // ═══ 终极止损 (不含杠杆) ═══
  checkUltimateStopLoss(pos) {
    const lossPct = this._calcLossPct(pos);
    const threshold = pos._orphan ? 5 : CONFIG.ultimateLossPct;
    if (lossPct >= threshold) return { action: 'CLOSE', reason: pos._orphan ? `孤儿仓止损: ${lossPct.toFixed(1)}%≥5%` : `终极止损: ${lossPct.toFixed(1)}%≥${threshold}%` };
    return { action: 'HOLD' };
  }

  // ═══ 同步远程持仓(只管理趋势仓) ═══
  async _syncPositions(bbPositions) {
    try {
      const remote = await this.api.getPositions();
      for (const r of remote) {
        const sym = r.symbol;
        if (CONFIG.blacklist.includes(sym)) continue;
        const amt = parseFloat(r.positionAmt);
        if (amt === 0) {
          if (this.positions[sym]) { delete this.positions[sym]; this._saveState(); }
          continue;
        }
        // 只接管不在BB策略管理中的仓位
        if (!this.positions[sym] && (!bbPositions || !bbPositions[sym])) {
          const entry = parseFloat(r.entryPrice);
          this.positions[sym] = {
            symbol: sym, side: amt > 0 ? 'LONG' : 'SHORT',
            qty: Math.abs(amt), entryPrice: entry,
            leverage: parseInt(r.leverage) || CONFIG.leverage,
            margin: Math.abs(amt) * entry / (parseInt(r.leverage) || CONFIG.leverage),
            replenishCount: 0, mode: '趋势', _orphan: true,
            openTime: Date.now(), currentPrice: entry,
          };
          this._log(`📌 ${sym} 接管孤儿仓位 ${amt > 0 ? 'LONG' : 'SHORT'}`);
        }
      }
    } catch(e) { this._log(`⚠️ 同步失败: ${e.message}`); }
  }

  // ═══ 开仓执行 ═══
  async _openPosition(symbol, direction, klines) {
    if (CONFIG.blacklist.includes(symbol)) return;
    if (!this.balance || this.balance <= 0) return;
    if (Object.keys(this.positions).length >= CONFIG.maxPositions) return;

    const price = klines[klines.length - 1].close;
    const atr = Indicators.atr(klines, CONFIG.atrPeriod);
    const atrPct = atr / price * 100;
    const margin = this.balance * this._getPositionPct(atrPct);
    const notional = margin * CONFIG.leverage;
    const qty = notional / price;

    let result;
    if (direction === 'LONG') result = await this.api.marketLong(symbol, qty, CONFIG.leverage, this.precisionMap, atrPct);
    else result = await this.api.marketShort(symbol, qty, CONFIG.leverage, this.precisionMap, atrPct);

    if (result.success) {
      this.positions[symbol] = {
        symbol, side: direction, qty: result.qty || qty, entryPrice: price,
        margin, leverage: CONFIG.leverage, replenishCount: 0,
        mode: '趋势', openTime: klines[klines.length - 1].time, currentPrice: price,
      };
      this._log(`✅ ${symbol} ${direction} 趋势开仓 qty=${(result.qty||qty).toFixed(4)} margin=$${margin.toFixed(2)}`);
      this._saveState();
    }
  }

  async _closePosition(symbol, pos, reason) {
    try {
      if (pos.side === 'LONG') await this.api.closeLong(symbol, pos.qty, this.precisionMap);
      else await this.api.closeShort(symbol, pos.qty, this.precisionMap);
      const pnlUsd = this._calcPnlUsd(pos, pos.currentPrice);
      this._log(`✅ ${symbol} 平仓 ${reason} PnL=$${pnlUsd.toFixed(2)}`);
      delete this.positions[symbol];
      this._saveState();
    } catch(e) { this._log(`❌ ${symbol} 平仓失败: ${e.message}`); }
  }

  _saveState() {
    try {
      const dir = path.dirname(CONFIG.stateFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CONFIG.stateFile, JSON.stringify({ positions: this.positions, savedAt: Date.now() }));
    } catch(e) {}
  }

  _loadState() {
    try {
      if (fs.existsSync(CONFIG.stateFile)) {
        const d = JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
        this.positions = d.positions || {};
        this._log(`📂 加载状态: ${Object.keys(this.positions).length}个持仓`);
      }
    } catch(e) {}
  }

  getSummary() {
    const positions = [];
    let totalPnlUsd = 0;
    for (const [sym, pos] of Object.entries(this.positions)) {
      const pnlUsd = this._calcPnlUsd(pos, pos.currentPrice || pos.entryPrice);
      const pnlPct = this._calcPnlPct(pos, pos.currentPrice || pos.entryPrice);
      totalPnlUsd += pnlUsd;
      positions.push({ symbol: sym, side: pos.side, qty: pos.qty, entryPrice: pos.entryPrice, currentPrice: pos.currentPrice, pnlPct: +pnlPct.toFixed(2), pnlUsd: +pnlUsd.toFixed(2), mode: '趋势', margin: pos.margin, leverage: pos.leverage });
    }
    return { wallet: this.wallet, balance: this.balance, positionCount: positions.length, maxPositions: CONFIG.maxPositions, positions, totalPnlUsd: +totalPnlUsd.toFixed(2), running: this.running, strategy: 'TREND' };
  }

  // ═══ 主循环 ═══
  async start() {
    this.running = true;
    this._log('🚀 趋势策略启动');
    this._loadState();
    try { this.precisionMap = await this.api.getExchangeInfo(); } catch(e) {}
    this.balance = await this.api.getBalance();
    this._log(`💰 余额: $${this.balance.toFixed(2)}`);
    await this._syncPositions(null);
    this._loop();
  }

  async _loop() {
    while (this.running) {
      try { await this._scan(); } catch(e) { this._log(`❌ 扫描异常: ${e.message}`); }
      await new Promise(r => setTimeout(r, CONFIG.scanIntervalMs));
    }
  }

  async _scan(bbPositions) {
    this._cycleCount++;
    if (this._cycleCount % 10 === 0 || !this.precisionMap) {
      try { this.precisionMap = await this.api.getExchangeInfo(); } catch(e) {}
    }
    if (this._cycleCount % 5 === 0) {
      try { this.balance = await this.api.getBalance(); } catch(e) {}
    }

    await this._syncPositions(bbPositions);

    // 管理持仓 — 止损止盈不跳过
    for (const symbol of Object.keys(this.positions)) {
      const pos = this.positions[symbol];
      try {
        const klines = await this.api.getKlines(symbol, CONFIG.klineInterval, CONFIG.klineLimit);
        if (klines.length < 60) continue;
        pos.currentPrice = klines[klines.length - 1].close;

        const atrStop = this.checkAtrStopLoss(klines, pos);
        if (atrStop.action === 'CLOSE') { this._log(`🔴 ${symbol} ${atrStop.reason}`); await this._closePosition(symbol, pos, atrStop.reason); continue; }

        const sl = this.checkSingleKStopLoss(klines, pos);
        if (sl.action === 'CLOSE') { this._log(`🔴 ${symbol} ${sl.reason}`); await this._closePosition(symbol, pos, sl.reason); continue; }

        const ult = this.checkUltimateStopLoss(pos);
        if (ult.action === 'CLOSE') { this._log(`🔴 ${symbol} ${ult.reason}`); await this._closePosition(symbol, pos, ult.reason); continue; }

        const tp = this.checkTakeProfit(klines, pos);
        if (tp.action === 'CLOSE') { this._log(`✅ ${symbol} ${tp.reason}`); await this._closePosition(symbol, pos, tp.reason); continue; }

        const pnlPct = this._calcPnlPct(pos, pos.currentPrice);
        this._log(`📊 ${symbol} ${pos.side} PnL=${pnlPct.toFixed(1)}%`);
      } catch(e) { this._log(`⚠️ ${symbol} 管理异常: ${e.message}`); }
    }

    // 开新仓
    if (Object.keys(this.positions).length >= CONFIG.maxPositions) return;
    const symbols = await this.selectSymbols();
    for (const symbol of symbols) {
      if (this.positions[symbol]) continue;
      if (bbPositions && bbPositions[symbol]) continue; // 同币不冲突
      if (Object.keys(this.positions).length >= CONFIG.maxPositions) break;
      try {
        const klines = await this.api.getKlines(symbol, CONFIG.klineInterval, CONFIG.klineLimit);
        if (klines.length < 120) continue;
        const changePct = Math.abs((klines[klines.length-1].close - klines[klines.length-1].open) / klines[klines.length-1].open * 100);
        if (changePct > 3) continue;
        const signal = await this.checkOpenCondition(klines, symbol);
        if (signal.allowed) {
          this._log(`🟢 ${symbol} ${signal.direction} ${signal.reason}`);
          await this._openPosition(symbol, signal.direction, klines);
        }
      } catch(e) {}
    }
    this._saveState();
  }
}

module.exports = { TrendStrategy, CONFIG };
