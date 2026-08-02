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

const { BinanceAPI, Indicators, FEE_CONFIG, isFeeExempted } = require('./common');
const { ipLimiter } = require('./api-rate-limiter');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  maxPositions: 3,           // 趋势策略基础仓位(运行时按余额动态调整)
  leverage: 3,
  
  positionTiers: [
    { minBalance: 0,   trendMax: 3 },
    { minBalance: 200, trendMax: 4 },
    { minBalance: 500, trendMax: 5 },
  ],
  topN: 10,              // v3: 选币降到10个(防止API限速)
  
  blacklist: [
    'BANKUSDT', 'BTCUSDT', 'BNBUSDT',
  ],
  
  klineInterval: '5m',
  htfInterval: '15m',
  klineLimit: 200,
  
  bbPeriod: 20,
  bbStd: 2.0,
  atrPeriod: 14,
  minAtrPct: 0.10,
  
  // v3: 简化止盈止损 — 只保留移动止盈+总浮亏止损
  profitTriggerPct: 3.0,      // v3: 浮盈≥3%才触发(让利润跑)
  trailDrawdownPct: 1.5,     // 峰值回撤1.5%锁利
  totalLossPct: 20,         // 总浮亏≥20%含杠杆(价格跌6.7%)就止损
  // v3: 单向持仓模式 — 浮亏≥10%全平原仓+开反向新仓
  reverseTriggerPct: 15,    // 浮亏≥15%含杠杆(价格跌5%)全平原仓+开反向新仓
  fullStopPct: 20,          // 浮亏≥20%含杠杆(价格跌6.7%)原仓全平,反向仓继续持有
  cooldownMs: 1800000,      // 平仓后30分钟不再开同一个币
  
  emaGapMax: 1.5,            // v3: EMA间距<1.5%(只在趋势刚启动时开仓)
  adxMin: 20,                 // v3: ADX>20才开仓(只在有明确趋势时)
  adxMax: 50,
  
  scanIntervalMs: 60000,     // 60秒扫描(趋势发展慢,减少API压力)
  // v2: 重启后宽限期 — 启动后10分钟不检查止损(只检查止盈)
  // 防止重启后ATR止损立即触发平仓现有持仓
  gracePeriodMs: 600000, // 10分钟
  
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
    // v3: 降低仓位占比, 防止大余额时单仓过大
    if (atrPct > 0.5) return 0.04;
    if (atrPct > 0.2) return 0.06;
    return 0.08;
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

  // v3: RSI计算
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

  // v3: 设置BB策略仓位(避免接管BB仓)
  setBBPositions(positions) {
    this._bbPositions = positions || {};
  }

  // v3: 获取动态最大仓位
  getDynamicMaxPositions() {
    const tiers = CONFIG.positionTiers;
    let tier = tiers[0];
    for (const t of tiers) {
      if (this.balance >= t.minBalance) tier = t;
    }
    return tier.trendMax;
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

    // v3: RSI过滤 — 做多时RSI<50, 做空时RSI>50
    const closes = klines.map(k => k.close);
    const rsi = this._calcRSI(closes, 14);
    if (isUptrend && rsi >= 50) return { allowed: false, reason: `RSI=${rsi.toFixed(0)}≥50 不做多` };
    if (isDowntrend && rsi <= 50) return { allowed: false, reason: `RSI=${rsi.toFixed(0)}≤50 不做空` };

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
  // v3: 只保留移动止盈 — 浮盈≥2%后峰值回撤1.5%锁利
  checkTakeProfit(klines, pos) {
    const close = klines[klines.length - 1].close;
    const pnlPct = this._calcPnlPct(pos, close);

    if (pnlPct < CONFIG.profitTriggerPct) return { action: 'HOLD' };

    // 记录峰值
    if (!pos._peakPnlPct || pnlPct > pos._peakPnlPct) pos._peakPnlPct = pnlPct;
    const drawdown = pos._peakPnlPct - pnlPct;
    
    // 峰值回撤1.5%锁利
    if (pos._peakPnlPct > CONFIG.profitTriggerPct && drawdown >= CONFIG.trailDrawdownPct) {
      return { action: 'CLOSE', reason: `移动止盈: 峰值${pos._peakPnlPct.toFixed(1)}%回撤${drawdown.toFixed(1)}%` };
    }

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

  // ═══ v2: 防深套补救措施 ═══

  // 总浮亏止损: ≥25%含杠杆就止损
  checkTotalLossStop(pos) {
    const price = pos.currentPrice || pos.entryPrice;
    let lossPct;
    if (pos.side === 'LONG') lossPct = (pos.entryPrice - price) / pos.entryPrice * 100 * pos.leverage;
    else lossPct = (price - pos.entryPrice) / pos.entryPrice * 100 * pos.leverage;
    if (lossPct >= CONFIG.totalLossPct) return { action: 'CLOSE', reason: `总浮亏止损: ${lossPct.toFixed(1)}%≥${CONFIG.totalLossPct}%` };
    return { action: 'HOLD' };
  }

  // 连续亏损止损: 连续N根K线收盘价在开仓价反方向
  checkConsecutiveLoss(klines, pos) {
    const n = CONFIG.consecutiveLossKlines;
    if (klines.length < n) return { action: 'HOLD' };
    const recent = klines.slice(-n);
    // v2: 收盘价必须在开仓价反方向偏离≥consecutiveLossPct%才算亏损方向
    if (pos.side === 'LONG') {
      const threshold = pos.entryPrice * (1 - CONFIG.consecutiveLossPct / 100);
      if (recent.every(k => k.close < threshold)) return { action: 'CLOSE', reason: `连续${n}根K线收盘价低于开仓价${CONFIG.consecutiveLossPct}%` };
    } else {
      const threshold = pos.entryPrice * (1 + CONFIG.consecutiveLossPct / 100);
      if (recent.every(k => k.close > threshold)) return { action: 'CLOSE', reason: `连续${n}根K线收盘价高于开仓价${CONFIG.consecutiveLossPct}%` };
    }
    return { action: 'HOLD' };
  }

  // 强平预警止损
  checkLiquidationWarning(pos) {
    const liqDistance = 1 / pos.leverage;
    const price = pos.currentPrice || pos.entryPrice;
    let priceMovePct;
    if (pos.side === 'LONG') priceMovePct = (pos.entryPrice - price) / pos.entryPrice;
    else priceMovePct = (price - pos.entryPrice) / pos.entryPrice;
    if (priceMovePct >= liqDistance * CONFIG.liquidationWarnPct) return { action: 'CLOSE', reason: `强平预警: 价格变动${(priceMovePct*100).toFixed(1)}%` };
    return { action: 'HOLD' };
  }

  // 时间止损
  checkTimeStop(pos) {
    if (!pos.openTime) return { action: 'HOLD' };
    const holdHours = (Date.now() - pos.openTime) / 3600000;
    if (holdHours < CONFIG.maxHoldHours) return { action: 'HOLD' };
    const price = pos.currentPrice || pos.entryPrice;
    let lossPct;
    if (pos.side === 'LONG') lossPct = (pos.entryPrice - price) / pos.entryPrice * 100 * pos.leverage;
    else lossPct = (price - pos.entryPrice) / pos.entryPrice * 100 * pos.leverage;
    if (lossPct >= CONFIG.maxHoldLossPct) return { action: 'CLOSE', reason: `时间止损: 持仓${holdHours.toFixed(1)}h且浮亏${lossPct.toFixed(1)}%` };
    return { action: 'HOLD' };
  }

  // ═══ 同步远程持仓(只管理趋势仓) ═══
  async _syncPositions(bbPositions) {
    try {
      const withTimeout = (p, ms) => Promise.race([p, new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
      const remote = await withTimeout(this.api.getPositions(), 10000);
      // v3: 先清理本地有但远程已不存在的仓位
      const remoteSymbols = new Set(remote.filter(r => Math.abs(parseFloat(r.positionAmt)) > 0).map(r => r.symbol));
      for (const sym of Object.keys(this.positions)) {
        if (!remoteSymbols.has(sym)) {
          this._log(`📌 ${sym} 远程已平仓, 从Binance拉取真实PnL`);
          // v3: 从Binance拉取真实已实现盈亏
          const closedPos = this.positions[sym];
          if (closedPos) {
            let pnlUsd = 0;
            try {
              const startTime = closedPos.openTime || (Date.now() - 86400000);
              const income = await this.api.getIncome(startTime, Date.now(), 'REALIZED_PNL');
              const symIncome = (income || []).filter(r => r.symbol === sym);
              pnlUsd = symIncome.reduce((s, r) => s + parseFloat(r.income), 0);
              if (symIncome.length > 0) {
                this._log(`📊 ${sym} Binance真实PnL=$${pnlUsd.toFixed(4)}`);
              } else {
                const exitPrice = closedPos.currentPrice || closedPos.entryPrice;
                pnlUsd = this._calcPnlUsd(closedPos, exitPrice);
              }
            } catch(e) {
              const exitPrice = closedPos.currentPrice || closedPos.entryPrice;
              pnlUsd = this._calcPnlUsd(closedPos, exitPrice);
            }
            // 每次平仓都记录到仪表盘(含远程已平仓),保留最近10笔
            this._recordTrade(sym, closedPos, '远程已平仓', pnlUsd);
            this._trades = (this._trades||0)+1;
            this._realizedPnl = (this._realizedPnl||0)+pnlUsd;
            if (pnlUsd > 0) this._wins = (this._wins||0)+1; else this._losses = (this._losses||0)+1;
          }
          delete this.positions[sym];
        }
      }
      // 遍历远程持仓
      for (const r of remote) {
        const sym = r.symbol;
        if (CONFIG.blacklist.includes(sym)) continue;
        const amt = parseFloat(r.positionAmt);
        if (amt === 0) continue;
        // v3: 只更新已有仓位
        if (this.positions[sym]) {
          this.positions[sym].currentPrice = parseFloat(r.markPrice);
          const remoteQty = Math.abs(amt);
          if (Math.abs(remoteQty - this.positions[sym].qty) > this.positions[sym].qty * 0.01) {
            this.positions[sym].qty = remoteQty;
          }
          continue;
        }
        // 跳过BB策略管理的仓位
        if (bbPositions && bbPositions[sym]) continue;
        // v3: 接管新仓位 — 按symbol字母序分配(趋势管后半,BB管前半)
        const symHash = sym.charCodeAt(0) + sym.charCodeAt(1);
        if (symHash % 2 !== 0) {
          const entry = parseFloat(r.entryPrice);
          this.positions[sym] = {
            symbol: sym, side: amt > 0 ? 'LONG' : 'SHORT',
            qty: Math.abs(amt), entryPrice: entry,
            leverage: parseInt(r.leverage) || CONFIG.leverage,
            margin: Math.abs(amt) * entry / (parseInt(r.leverage) || CONFIG.leverage),
            replenishCount: 0, mode: '趋势', _orphan: true,
            openTime: Date.now(), currentPrice: parseFloat(r.markPrice),
          };
          this._log(`📌 ${sym} 趋势接管 ${amt > 0 ? 'LONG' : 'SHORT'}`);
        }
      }
      this._saveState();
    } catch(e) { this._log(`⚠️ 同步失败: ${e.message}`); }
  }

  // ═══ 开仓执行 ═══
  async _openPosition(symbol, direction, klines) {
    if (CONFIG.blacklist.includes(symbol)) return;
    if (this.gatesFeePaused) return;
    if (!this.balance || this.balance <= 0) return;
    // v3: 检查总仓位 — 拉取Binance实际持仓数
    const myCount = Object.keys(this.positions).length;
    let binanceCount = myCount;
    try {
      const remote = await Promise.race([this.api.getPositions(), new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 8000))]).catch(e => null);
      if (remote) binanceCount = remote.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0).length;
    } catch(e) {}
    const myMax = this.getDynamicMaxPositions();
    if (myCount >= myMax || binanceCount >= 10) return;

    const price = klines[klines.length - 1].close;
    const atr = Indicators.atr(klines, CONFIG.atrPeriod);
    const atrPct = atr / price * 100;
    const margin = Math.min(this.balance * this._getPositionPct(atrPct), 30); // v3: 单仓上限$30
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
      // v3: 交易统计
      this._trades = (this._trades || 0) + 1;
      this._realizedPnl = (this._realizedPnl || 0) + pnlUsd;
      if (pnlUsd > 0) this._wins = (this._wins || 0) + 1;
      else this._losses = (this._losses || 0) + 1;
      // v3: 记录交易历史到文件(兼容仪表盘)
      this._recordTrade(symbol, pos, reason, pnlUsd);
      // v3: 记录平仓时间, 用于冷却期
      if (!this._closedTimes) this._closedTimes = {};
      this._closedTimes[symbol] = Date.now();
      // 算力费扣费
      await this._collectServiceFee(symbol, pnlUsd);
      delete this.positions[symbol];
      this._saveState();
    } catch(e) { this._log(`❌ ${symbol} 平仓失败: ${e.message}`); }
  }

  // ═══ 算力费扣费 ═══
  async _collectServiceFee(symbol, pnlUsd) {
    if (pnlUsd <= 0) return;
    if (isFeeExempted(this.wallet)) {
      this._log(`👑 Admin ${symbol} +$${pnlUsd.toFixed(2)} — 全额到账,免算力费`);
      return;
    }
    const platformFee = pnlUsd * FEE_CONFIG.PLATFORM_FEE_RATE;
    const ecoFund = pnlUsd * FEE_CONFIG.ECO_FUND_RATE;
    const userShare = pnlUsd * FEE_CONFIG.USER_SHARE_RATE;
    this._log(`💰 ${symbol} 盈利$${pnlUsd.toFixed(2)} | 算力费$${platformFee.toFixed(2)}(20%) + 算力费$${ecoFund.toFixed(2)}(10%) | 实得$${userShare.toFixed(2)}(70%)`);
    const walletKey = this.wallet || 'admin';
    try {
      let feeState = { pending: {}, collected: {}, totalPlatformFee: 0, totalEcoFund: 0 };
      if (fs.existsSync(FEE_CONFIG.FEE_STATE_FILE)) {
        feeState = JSON.parse(fs.readFileSync(FEE_CONFIG.FEE_STATE_FILE, 'utf8'));
      }
      if (!feeState.pending) feeState.pending = {};
      if (!feeState.pending[walletKey]) feeState.pending[walletKey] = [];
      feeState.pending[walletKey].push({
        symbol, platformFee: platformFee.toFixed(4), ecoFund: ecoFund.toFixed(4),
        platformCollected: false, timestamp: Date.now(),
      });
      fs.writeFileSync(FEE_CONFIG.FEE_STATE_FILE, JSON.stringify(feeState, null, 2));
      if (this._userDB && this.wallet) {
        // v3: 用小写wallet查userDB + 写入saas-users.json
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
        this._log(`📉 ${this.wallet.slice(0,8)} 余额: $${oldBal.toFixed(2)} → $${newBal.toFixed(2)}`);
      }
      await this._tryBatchFeeTransfer(walletKey);
    } catch(e) { this._log(`⚠️ 算力费记录失败: ${e.message}`); }
  }

  async _tryBatchFeeTransfer(walletKey) {
    let feeState;
    try {
      feeState = JSON.parse(fs.readFileSync(FEE_CONFIG.FEE_STATE_FILE, 'utf8'));
    } catch(e) { return; }
    const pending = feeState.pending?.[walletKey] || [];
    if (pending.length === 0) return;
    const totalPlatform = pending.reduce((s,r) => r.platformCollected ? s : s + parseFloat(r.platformFee), 0);
    const totalEco = pending.reduce((s,r) => s + parseFloat(r.ecoFund), 0);
    const totalFee = totalPlatform + totalEco;
    if (totalFee < FEE_CONFIG.FEE_THRESHOLD) return;
    try {
      const { ethers } = require('ethers');
      const provider = new ethers.JsonRpcProvider('https://bsc-rpc.publicnode.com');
      const usdtContract = new ethers.Contract('0x55d398326f99059fF775485246999027B3197955', ['function transfer(address to, uint256 amount) returns (bool)','function balanceOf(address) view returns (uint256)'], new ethers.Wallet(process.env.TRADER_PRIVATE_KEY, provider));
      const GAS_PRICE = ethers.parseUnits('5', 'gwei');
      const traderBal = await usdtContract.balanceOf(new ethers.Wallet(process.env.TRADER_PRIVATE_KEY, provider).address);
      if (BigInt(traderBal) < ethers.parseUnits(totalFee.toFixed(6), 18)) return;
      if (totalPlatform > 0) {
        const tx1 = await usdtContract.transfer(FEE_CONFIG.PLATFORM_WALLET, ethers.parseUnits(totalPlatform.toFixed(6), 18), { gasPrice: GAS_PRICE });
        await tx1.wait();
      }
      const tx2 = await usdtContract.transfer(FEE_CONFIG.ECO_FUND_WALLET, ethers.parseUnits(totalEco.toFixed(6), 18), { gasPrice: GAS_PRICE });
      await tx2.wait();
      for (const r of pending) r.platformCollected = true;
      fs.writeFileSync(FEE_CONFIG.FEE_STATE_FILE, JSON.stringify(feeState, null, 2));
      this._log(`✅ ${walletKey.slice(0,10)} 链上扣费$${totalFee.toFixed(2)}成功`);
    } catch(e) { this._log(`❌ 链上扣费失败: ${e.message.slice(0,100)}`); }
  }

  // v3: 记录交易历史(兼容仪表盘)
  _recordTrade(symbol, pos, reason, pnlUsd) {
    try {
      const walletKey = (this.wallet || 'admin').toLowerCase();
      const tradeFile = path.join(__dirname, '..', 'data', `bb-trades-${walletKey}.json`);
      let trades = [];
      if (fs.existsSync(tradeFile)) {
        try { trades = JSON.parse(fs.readFileSync(tradeFile, 'utf8')); } catch(e) { trades = []; }
      }
      const pnlPct = this._calcPnlPct(pos, pos.currentPrice);
      trades.push({
        symbol, side: pos.side, qty: pos.qty,
        entryPrice: pos.entryPrice, exitPrice: pos.currentPrice,
        pnlUsd: parseFloat(pnlUsd.toFixed(4)),
        pnlPct: parseFloat(pnlPct.toFixed(2)),
        margin: pos.margin, leverage: pos.leverage,
        reason, closeTime: Date.now(),
        wallet: this.wallet, mode: '趋势',
      });
      if (trades.length > 10) trades = trades.slice(-10);
      fs.writeFileSync(tradeFile, JSON.stringify(trades, null, 2));
    } catch(e) { this._log(`⚠️ 交易记录写入失败: ${e.message.slice(0,50)}`); }
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
    this._startTime = Date.now(); // v2: 记录启动时间,用于宽限期
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
      try { await this._scan(this._bbPositions || {}); } catch(e) { this._log(`❌ 扫描异常: ${e.message}`); }
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

        // v2: 重启宽限期 — 启动后10分钟只检查止盈,不检查止损
        // 防止重启后ATR止损立即触发平仓现有持仓
        const inGracePeriod = this._startTime && (Date.now() - this._startTime < CONFIG.gracePeriodMs);

        if (!inGracePeriod) {
        // v3: 计算浮亏
        const tlPrice = pos.currentPrice || pos.entryPrice;
        let tlLoss = 0;
        if (pos.side === 'LONG') tlLoss = (pos.entryPrice - tlPrice) / pos.entryPrice * 100 * pos.leverage;
        else tlLoss = (tlPrice - pos.entryPrice) / pos.entryPrice * 100 * pos.leverage;
        
        // v3: 单向模式 — 浮亏≥15%全平原仓+开反向新仓
        if (!pos._reversed && tlLoss >= CONFIG.reverseTriggerPct) {
          try {
            const origQty = pos.qty;
            const origSide = pos.side;
            const pnlUsd = this._calcPnlUsd(pos, pos.currentPrice);
            // 全平原仓
            if (origSide === 'LONG') await this.api.closeLong(symbol, origQty, this.precisionMap);
            else await this.api.closeShort(symbol, origQty, this.precisionMap);
            this._log(`📉 ${symbol} 原仓${origSide}全平 qty=${origQty.toFixed(4)} PnL=$${pnlUsd.toFixed(2)}`);
            // 记录原仓平仓
            this._recordTrade(symbol, pos, '浮亏反转全平', pnlUsd);
            this._trades = (this._trades||0)+1;
            this._realizedPnl = (this._realizedPnl||0)+pnlUsd;
            if (pnlUsd > 0) this._wins = (this._wins||0)+1; else this._losses = (this._losses||0)+1;
            // 删除原仓
            delete this.positions[symbol];
            // 用释放的保证金开反向新仓(同数量)
            const reverseDir = origSide === 'LONG' ? 'SHORT' : 'LONG';
            const reversePrice = pos.currentPrice;
            if (reverseDir === 'LONG') await this.api.marketLong(symbol, origQty, pos.leverage, this.precisionMap, 0);
            else await this.api.marketShort(symbol, origQty, pos.leverage, this.precisionMap, 0);
            this._log(`🔄 ${symbol} 反向开仓 ${reverseDir} qty=${origQty.toFixed(4)}`);
            // v3: 反向新仓加入positions,让策略管理止盈止损
            this.positions[symbol] = {
              symbol, side: reverseDir, qty: origQty, entryPrice: reversePrice,
              margin: pos.margin, leverage: pos.leverage,
              replenishCount: 0, mode: '趋势',
              openTime: Date.now(), currentPrice: reversePrice,
            };
            this._saveState();
          } catch(e) { this._log(`⚠️ ${symbol} 全平+反向开仓失败: ${e.message}`); }
          continue;
        }
        } // end grace period

        // 止盈始终检查(不受宽限期影响)

        const tp = this.checkTakeProfit(klines, pos);
        if (tp.action === 'CLOSE') { this._log(`✅ ${symbol} ${tp.reason}`); await this._closePosition(symbol, pos, tp.reason); continue; }

        const pnlPct = this._calcPnlPct(pos, pos.currentPrice);
        this._log(`📊 ${symbol} ${pos.side} PnL=${pnlPct.toFixed(1)}%`);
      } catch(e) { this._log(`⚠️ ${symbol} 管理异常: ${e.message}`); }
    }

    // 趋势策略开仓(已恢复)
    // 开新仓 — v3: 拉取Binance实际持仓数检查
    const myCount2 = Object.keys(this.positions).length;
    let binanceCount2 = myCount2;
    try {
      const remote2 = await Promise.race([this.api.getPositions(), new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 8000))]).catch(e => null);
      if (remote2) binanceCount2 = remote2.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0).length;
    } catch(e) {}
    if (myCount2 >= this.getDynamicMaxPositions() || binanceCount2 >= 10) return;
    const symbols = await this.selectSymbols();
    let openedThisRound = 0; // v3: 每轮最多开1个仓
    for (const symbol of symbols) {
      if (openedThisRound >= 1) break; // v3: 每轮最多开1个
      if (this.positions[symbol]) continue;
      if (bbPositions && bbPositions[symbol]) continue; // 同币不冲突
      // v3: 平仓冷却期 — 30分钟内不再开同一个币
      if (this._closedTimes && this._closedTimes[symbol] && (Date.now() - this._closedTimes[symbol] < CONFIG.cooldownMs)) continue;
      if (Object.keys(this.positions).length >= this.getDynamicMaxPositions()) break;
      try {
        const klines = await this.api.getKlines(symbol, CONFIG.klineInterval, CONFIG.klineLimit);
        if (klines.length < 120) continue;
        const changePct = Math.abs((klines[klines.length-1].close - klines[klines.length-1].open) / klines[klines.length-1].open * 100);
        if (changePct > 3) continue;
        const signal = await this.checkOpenCondition(klines, symbol);
        if (signal.allowed) {
          this._log(`🟢 ${symbol} ${signal.direction} ${signal.reason}`);
          await this._openPosition(symbol, signal.direction, klines);
          openedThisRound++; // v3: 计数
        }
      } catch(e) {}
    }
    this._saveState();
    // 趋势开仓已恢复
  }
}

module.exports = { TrendStrategy, CONFIG };
