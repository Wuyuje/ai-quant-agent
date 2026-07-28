/**
 * 纯BB布林带策略模块 — 独立运行
 * 
 * 开仓: 带宽<85% + 2根收窄 + 触轨 + EMA顺向
 * 止盈: 浮盈≥1.5% + 移动止盈(峰值回撤0.5%) + 中轨止盈 + 反向轨道兜底
 * 止损: ATR止损2.0 + 单K止损2%(不含杠杆) + 终极止损15%(不含杠杆, 所有仓位生效)
 * 补仓: 收口后3根K线, 40%/20% 两次
 * 
 * 仓位: 最多3仓(和趋势策略分开名额)
 * 互不干扰: 不管理mode='趋势'的仓位
 */

const { BinanceAPI, Indicators } = require('./common');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  maxPositions: 3,           // BB策略最多3仓
  leverage: 3,
  topN: 50,
  
  blacklist: [
    'BANKUSDT', 'BTCUSDT', 'BNBUSDT',
    'TSLAUSDT', 'NVDAUSDT', 'AAPLUSDT', 'METAUSDT', 'MSFTUSDT',
    'GOOGLUSDT', 'SPYUSDT', 'QQQUSDT',
    'XAGUSDT', 'XAUUSDT', 'COPPERUSDT', 'NATGASUSDT',
    'UVXYUSDT', 'URNMUSDT',
  ],
  
  orphanAllowPrefixes: ['*'],
  
  klineInterval: '5m',
  klineLimit: 200,
  bbPeriod: 20,
  bbStd: 2.0,
  
  bandwidthPercentileLookback: 100,
  bandwidthOpenBlock: 90,
  bandwidthOpenAllow: 85,
  narrowCount: 2,
  
  profitTriggerPct: 1.5,
  
  adxThreshold: 20,
  atrPeriod: 14,
  minAtrPct: 0.10,
  atrStopMultiplier: 2.0,
  
  maxReplenish: 2,
  replenishInterval: 3,
  replenishRatios: [0.40, 0.20],
  
  singleKLossPct: 2,
  ultimateLossPct: 15,
  
  fundingPauseMin: 15,
  scanIntervalMs: 30000,
  
  stateFile: path.join(__dirname, '..', 'data', 'bb-strategy-state.json'),
  logFile: path.join(__dirname, '..', 'logs', 'bb-strategy.log'),
};

class BBStrategy {
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
    const line = `[BB] ${ts} ${msg}`;
    console.log(line);
    try {
      const dir = path.dirname(CONFIG.logFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(CONFIG.logFile, line + '\n');
    } catch(e) {}
  }

  // ═══ 仓位大小: 按波动率配比 ═══
  _getPositionPct(atrPct) {
    if (atrPct > 0.5) return 0.08;
    if (atrPct > 0.2) return 0.12;
    return 0.15;
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

  _calcLossPct(pos) {
    const price = pos.currentPrice || pos.entryPrice;
    if (pos.side === 'LONG') return Math.max(0, (pos.entryPrice - price) / pos.entryPrice * 100);
    return Math.max(0, (price - pos.entryPrice) / pos.entryPrice * 100);
  }

  // ═══ 选币 ═══
  async selectSymbols() {
    const tickers = await this.api.getAllTickers();
    const usdtPerps = tickers
      .filter(t => t.symbol.endsWith('USDT') && !CONFIG.blacklist.includes(t.symbol))
      .sort((a, b) => b.volume - a.volume)
      .slice(0, CONFIG.topN);
    return usdtPerps.map(t => t.symbol);
  }

  // ═══ 开仓条件 ═══
  checkOpenCondition(klines) {
    const bwPercentile = Indicators.bandwidthPercentile(klines, CONFIG.bandwidthPercentileLookback);
    if (!bwPercentile) return { allowed: false };
    if (bwPercentile > 90) return { allowed: false };

    const adx = Indicators.adx(klines, 14);
    if (!adx || adx < CONFIG.adxThreshold) return { allowed: false };

    if (bwPercentile >= 85) return { allowed: false };
    if (!Indicators.isNarrowing(klines, CONFIG.narrowCount)) return { allowed: false };

    const atr = Indicators.atr(klines, CONFIG.atrPeriod);
    const lastClose = klines[klines.length - 1].close;
    if (atr / lastClose * 100 < CONFIG.minAtrPct) return { allowed: false };

    const bb = Indicators.bollinger(klines, CONFIG.bbPeriod, CONFIG.bbStd);
    if (!bb) return { allowed: false };

    const ema20 = Indicators.ema(klines, 20);
    const ema60 = Indicators.ema(klines, 60);
    if (!ema20 || !ema60) return { allowed: false };

    if (lastClose <= bb.lower && ema20 > ema60) {
      return { allowed: true, direction: 'LONG', reason: `触下轨+EMA多头` };
    }
    if (lastClose >= bb.upper && ema20 < ema60) {
      return { allowed: true, direction: 'SHORT', reason: `触上轨+EMA空头` };
    }
    return { allowed: false };
  }

  // ═══ 止盈 ═══
  checkTakeProfit(klines, pos) {
    const bb = Indicators.bollinger(klines, CONFIG.bbPeriod, CONFIG.bbStd);
    if (!bb) return { action: 'HOLD' };
    const close = klines[klines.length - 1].close;
    const pnlPct = this._calcPnlPct(pos, close);

    if (pnlPct < CONFIG.profitTriggerPct) return { action: 'HOLD' };

    // 移动止盈
    if (!pos._peakPnlPct || pnlPct > pos._peakPnlPct) pos._peakPnlPct = pnlPct;
    const drawdown = pos._peakPnlPct - pnlPct;
    if (pos._peakPnlPct > CONFIG.profitTriggerPct + 0.5 && drawdown >= 0.5) {
      return { action: 'CLOSE', reason: `移动止盈: 峰值${pos._peakPnlPct.toFixed(1)}%回撤${drawdown.toFixed(1)}%` };
    }

    // 中轨止盈
    if (pos.side === 'LONG' && close >= bb.mid) return { action: 'CLOSE', reason: `中轨止盈` };
    if (pos.side === 'SHORT' && close <= bb.mid) return { action: 'CLOSE', reason: `中轨止盈` };

    // 反向轨道兜底
    if (pos.side === 'LONG' && close >= bb.upper) return { action: 'CLOSE', reason: `触上轨兜底` };
    if (pos.side === 'SHORT' && close <= bb.lower) return { action: 'CLOSE', reason: `触下轨兜底` };

    return { action: 'HOLD' };
  }

  // ═══ ATR止损 ═══
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

  // ═══ 终极止损 (不含杠杆, 所有仓位生效) ═══
  checkUltimateStopLoss(pos) {
    const lossPct = this._calcLossPct(pos);
    const threshold = pos._orphan ? 5 : CONFIG.ultimateLossPct;
    if (lossPct >= threshold) return { action: 'CLOSE', reason: pos._orphan ? `孤儿仓止损: ${lossPct.toFixed(1)}%≥5%` : `终极止损: ${lossPct.toFixed(1)}%≥${threshold}%` };
    return { action: 'HOLD' };
  }

  // ═══ 补仓 ═══
  async checkReplenish(klines, pos) {
    if (pos.replenishCount >= CONFIG.maxReplenish) return { action: 'HOLD' };
    if (pos._orphan) return { action: 'HOLD' };

    // 浮亏接近ATR止损线时不补仓
    const atr = Indicators.atr(klines, CONFIG.atrPeriod);
    if (atr) {
      const close = klines[klines.length - 1].close;
      const stopPct = atr / close * 100 * CONFIG.atrStopMultiplier;
      const pnlPct = this._calcPnlPct(pos, close);
      if (pnlPct <= -stopPct * 0.8) return { action: 'HOLD', reason: '接近止损线不补仓' };
    }

    if (!pos.lastNarrowTime) {
      if (Indicators.isContracting && Indicators.isContracting(klines)) {
        pos.lastNarrowTime = Date.now();
        pos.klinesSinceNarrow = 0;
      }
      return { action: 'HOLD' };
    }
    pos.klinesSinceNarrow = (pos.klinesSinceNarrow || 0) + 1;
    if (pos.klinesSinceNarrow < CONFIG.replenishInterval) return { action: 'HOLD' };

    const ratio = CONFIG.replenishRatios[pos.replenishCount];
    pos.replenishCount++;
    pos.klinesSinceNarrow = 0;
    pos.lastNarrowTime = null;
    return { action: 'REPLENISH', amount: pos.margin * ratio, reason: `第${pos.replenishCount}次补仓${ratio*100}%` };
  }

  // ═══ 同步远程持仓 ═══
  async _syncPositions() {
    try {
      const remote = await this.api.getPositions();
      for (const r of remote) {
        const sym = r.symbol;
        if (CONFIG.blacklist.includes(sym)) continue;
        const amt = parseFloat(r.positionAmt);
        if (amt === 0) {
          if (this.positions[sym]) {
            this._log(`📌 ${sym} 远程已平仓`);
            delete this.positions[sym];
            this._saveState();
          }
          continue;
        }
        if (!this.positions[sym]) {
          const entry = parseFloat(r.entryPrice);
          this.positions[sym] = {
            symbol: sym, side: amt > 0 ? 'LONG' : 'SHORT',
            qty: Math.abs(amt), entryPrice: entry,
            leverage: parseInt(r.leverage) || CONFIG.leverage,
            margin: Math.abs(amt) * entry / (parseInt(r.leverage) || CONFIG.leverage),
            replenishCount: 2, mode: '轨道', _orphan: true,
            openTime: Date.now(), currentPrice: entry,
          };
          this._log(`📌 ${sym} 接管孤儿仓位 ${amt > 0 ? 'LONG' : 'SHORT'} qty=${Math.abs(amt)}`);
        }
      }
    } catch(e) { this._log(`⚠️ 同步持仓失败: ${e.message}`); }
  }

  // ═══ 开仓执行 ═══
  async _openPosition(symbol, direction, klines) {
    if (CONFIG.blacklist.includes(symbol)) return;
    if (!this.balance || this.balance <= 0) { this._log(`⏭️ ${symbol} 余额不足`); return; }
    if (Object.keys(this.positions).length >= CONFIG.maxPositions) { this._log(`⏭️ ${symbol} 持仓已满`); return; }

    const price = klines[klines.length - 1].close;
    const atr = Indicators.atr(klines, CONFIG.atrPeriod);
    const atrPct = atr / price * 100;
    const positionPct = this._getPositionPct(atrPct);
    const margin = this.balance * positionPct;
    const notional = margin * CONFIG.leverage;
    const qty = notional / price;

    let result;
    if (direction === 'LONG') result = await this.api.marketLong(symbol, qty, CONFIG.leverage, this.precisionMap, atrPct);
    else result = await this.api.marketShort(symbol, qty, CONFIG.leverage, this.precisionMap, atrPct);

    if (result.success) {
      this.positions[symbol] = {
        symbol, side: direction, qty: result.qty || qty, entryPrice: price,
        margin, leverage: CONFIG.leverage, replenishCount: 0,
        mode: '轨道', openTime: klines[klines.length - 1].time, currentPrice: price,
      };
      this._log(`✅ ${symbol} ${direction} 开仓 qty=${(result.qty||qty).toFixed(4)} margin=$${margin.toFixed(2)}`);
      this._saveState();
    } else {
      this._log(`❌ ${symbol} ${direction} 开仓失败: ${result.error}`);
    }
  }

  // ═══ 平仓执行 ═══
  async _closePosition(symbol, pos, reason) {
    try {
      let result;
      if (pos.side === 'LONG') result = await this.api.closeLong(symbol, pos.qty, this.precisionMap);
      else result = await this.api.closeShort(symbol, pos.qty, this.precisionMap);
      const pnlUsd = this._calcPnlUsd(pos, pos.currentPrice);
      this._log(`✅ ${symbol} 平仓 ${reason} PnL=$${pnlUsd.toFixed(2)}`);
      delete this.positions[symbol];
      this._saveState();
    } catch(e) { this._log(`❌ ${symbol} 平仓失败: ${e.message}`); }
  }

  // ═══ 补仓执行 ═══
  async _replenishPosition(symbol, pos, amount) {
    try {
      const price = pos.currentPrice;
      const addQty = amount * CONFIG.leverage / price;
      let result;
      if (pos.side === 'LONG') result = await this.api.marketLong(symbol, addQty, CONFIG.leverage, this.precisionMap, 0);
      else result = await this.api.marketShort(symbol, addQty, CONFIG.leverage, this.precisionMap, 0);
      if (result.success) {
        const totalQty = pos.qty + (result.qty || addQty);
        pos.entryPrice = (pos.entryPrice * pos.qty + price * (result.qty || addQty)) / totalQty;
        pos.qty = totalQty;
        pos.margin += amount;
        this._log(`📈 ${symbol} 补仓 +${(result.qty||addQty).toFixed(4)} 总仓位=${totalQty.toFixed(4)}`);
        this._saveState();
      }
    } catch(e) { this._log(`❌ ${symbol} 补仓失败: ${e.message}`); }
  }

  // ═══ 状态持久化 ═══
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

  // ═══ 统计 ═══
  getSummary() {
    const positions = [];
    let totalPnlUsd = 0;
    for (const [sym, pos] of Object.entries(this.positions)) {
      const pnlUsd = this._calcPnlUsd(pos, pos.currentPrice || pos.entryPrice);
      const pnlPct = this._calcPnlPct(pos, pos.currentPrice || pos.entryPrice);
      totalPnlUsd += pnlUsd;
      positions.push({ symbol: sym, side: pos.side, qty: pos.qty, entryPrice: pos.entryPrice, currentPrice: pos.currentPrice, pnlPct: +pnlPct.toFixed(2), pnlUsd: +pnlUsd.toFixed(2), mode: 'BB', margin: pos.margin, leverage: pos.leverage, replenishCount: pos.replenishCount });
    }
    return { wallet: this.wallet, balance: this.balance, positionCount: positions.length, maxPositions: CONFIG.maxPositions, positions, totalPnlUsd: +totalPnlUsd.toFixed(2), running: this.running, strategy: 'BB' };
  }

  // ═══ 主循环 ═══
  async start() {
    this.running = true;
    this._log('🚀 BB策略启动');
    this._loadState();
    try { this.precisionMap = await this.api.getExchangeInfo(); } catch(e) {}
    this.balance = await this.api.getBalance();
    this._log(`💰 余额: $${this.balance.toFixed(2)}`);
    await this._syncPositions();
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
    if (this._cycleCount % 10 === 0 || !this.precisionMap) {
      try { this.precisionMap = await this.api.getExchangeInfo(); } catch(e) {}
    }

    // 每5轮刷新余额
    if (this._cycleCount % 5 === 0) {
      try { this.balance = await this.api.getBalance(); } catch(e) {}
    }

    await this._syncPositions();

    // 管理现有持仓 — 止损止盈不受插针过滤影响
    for (const symbol of Object.keys(this.positions)) {
      const pos = this.positions[symbol];
      try {
        const klines = await this.api.getKlines(symbol, CONFIG.klineInterval, CONFIG.klineLimit);
        if (klines.length < 60) continue;
        pos.currentPrice = klines[klines.length - 1].close;

        // ATR止损(先检查)
        const atrStop = this.checkAtrStopLoss(klines, pos);
        if (atrStop.action === 'CLOSE') { this._log(`🔴 ${symbol} ${atrStop.reason}`); await this._closePosition(symbol, pos, atrStop.reason); continue; }

        // 单K止损
        const sl = this.checkSingleKStopLoss(klines, pos);
        if (sl.action === 'CLOSE') { this._log(`🔴 ${symbol} ${sl.reason}`); await this._closePosition(symbol, pos, sl.reason); continue; }

        // 终极止损
        const ult = this.checkUltimateStopLoss(pos);
        if (ult.action === 'CLOSE') { this._log(`🔴 ${symbol} ${ult.reason}`); await this._closePosition(symbol, pos, ult.reason); continue; }

        // 止盈
        const tp = this.checkTakeProfit(klines, pos);
        if (tp.action === 'CLOSE') { this._log(`✅ ${symbol} ${tp.reason}`); await this._closePosition(symbol, pos, tp.reason); continue; }

        // 补仓
        const rep = await this.checkReplenish(klines, pos);
        if (rep.action === 'REPLENISH') { this._log(`📈 ${symbol} ${rep.reason}`); await this._replenishPosition(symbol, pos, rep.amount); continue; }

        const pnlPct = this._calcPnlPct(pos, pos.currentPrice);
        this._log(`📊 ${symbol} ${pos.side} PnL=${pnlPct.toFixed(1)}% 补仓=${pos.replenishCount}/${CONFIG.maxReplenish}`);
      } catch(e) { this._log(`⚠️ ${symbol} 管理异常: ${e.message}`); }
    }

    // 开新仓
    if (Object.keys(this.positions).length >= CONFIG.maxPositions) return;
    const symbols = await this.selectSymbols();
    for (const symbol of symbols) {
      if (this.positions[symbol]) continue;
      if (Object.keys(this.positions).length >= CONFIG.maxPositions) break;
      try {
        const klines = await this.api.getKlines(symbol, CONFIG.klineInterval, CONFIG.klineLimit);
        if (klines.length < 120) continue;
        // 插针过滤(只过滤开仓信号)
        const changePct = Math.abs((klines[klines.length-1].close - klines[klines.length-1].open) / klines[klines.length-1].open * 100);
        if (changePct > 3) continue;
        const signal = this.checkOpenCondition(klines);
        if (signal.allowed) {
          this._log(`🟢 ${symbol} ${signal.direction} 信号: ${signal.reason}`);
          await this._openPosition(symbol, signal.direction, klines);
        }
      } catch(e) {}
    }
    this._saveState();
  }
}

module.exports = { BBStrategy, CONFIG };
