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

const { BinanceAPI, Indicators, FEE_CONFIG, isFeeExempted } = require('./common');
const { ipLimiter } = require('./api-rate-limiter');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  maxPositions: 3,           // BB策略基础仓位(运行时按余额动态调整)
  leverage: 3,
  
  // v3: 资金分级仓位 — 余额多开更多仓
  //   < $200 → 总6仓 (BB3+趋势3)
  //   $200-$500 → 总8仓 (BB4+趋势4)
  //   ≥ $500 → 总10仓 (BB5+趋势5)
  positionTiers: [
    { minBalance: 0,   bbMax: 3, trendMax: 3 },
    { minBalance: 200, bbMax: 4, trendMax: 4 },
    { minBalance: 500, bbMax: 5, trendMax: 5 },
  ],
  topN: 10,              // v3: 选币降到10个(防止API限速)
  floatProfitPct: 1.0,       // 前十浮盈±≤1%选币
  
  blacklist: [
    'BANKUSDT',   // 单笔巨亏
    'BTCUSDT',    // 波动率低，盈利空间小
    'BNBUSDT',    // 波动率低，盈利空间小
  ],
  
  orphanAllowPrefixes: ['*'],
  
  klineInterval: '5m',
  klineLimit: 200,
  bbPeriod: 20,
  bbStd: 2.0,
  
  bandwidthPercentileLookback: 100,
  bandwidthOpenBlock: 90,
  bandwidthOpenAllow: 90,             // v3: <90%解禁(从85放宽,增加开仓机会)
  narrowCount: 2,                     // v3: 连续2根收窄(从3根减少,更快开仓)
  
  profitTriggerPct: 2.0,      // 浮盈≥2%触发止盈
  volumeSpikeRatio: 1.8,      // 放量倍数>1.8
  volumeMaPeriod: 20,         // 20周期均量
  atrTrailMultiplier: 0.3,   // ATR跟踪0.3
  
  adxThreshold: 20,
  atrPeriod: 14,
  minAtrPct: 0.10,
  atrStopMultiplier: 2.0,
  
  maxReplenish: 3,           // 最多补3次
  replenishInterval: 3,      // 收口后间隔3根K线
  replenishRatios: [0.30, 0.20, 0.10], // v3: 降低补仓比例, 防止仓位放大
  
  singleKLossPct: 20,        // 七、单K浮亏≥本金20%止损(含杠杆)
  ultimateLossPct: 70,       // 八、终极止损3次补完+总浮亏≥70%含杠杆
  totalLossPct: 30,         // 兜底: 总浮亏≥30%含杠杆(价格跌10%)就止损
  
  // v3: 单向持仓模式 — 浮亏≥10%全平原仓+开反向新仓
  reverseTriggerPct: 10,    // 浮亏≥10%含杠杆(价格跌3.3%)全平原仓+开反向新仓
  fullStopPct: 20,          // 浮亏≥20%含杠杆(价格跌6.7%)原仓全平,反向仓继续持有
  
  fundingPauseMin: 15,
  scanIntervalMs: 60000,     // v3: 60秒扫描(防止API限速)
  
  // v2: 重启后宽限期 — 启动后10分钟不检查止损(只检查止盈)
  gracePeriodMs: 600000,
  
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
    // v3: 降低仓位占比, 防止大余额时单仓过大
    if (atrPct > 0.5) return 0.05;
    if (atrPct > 0.2) return 0.08;
    return 0.10;
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

  // ═══ 设置趋势策略仓位(避免接管趋势仓) ═══
  setTrendPositions(positions) {
    this._trendPositions = positions || {};
  }

  // v3: 获取当前资金档位
  getPositionTier() {
    const tiers = CONFIG.positionTiers;
    let tier = tiers[0];
    for (const t of tiers) {
      if (this.balance >= t.minBalance) tier = t;
    }
    return tier;
  }

  // v3: 获取动态最大仓位
  getDynamicMaxPositions() {
    return this.getPositionTier().bbMax;
  }

  // ═══ 选币 ═══
  async selectSymbols() {
    const tickers = await Promise.race([this.api.getAllTickers(), new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 15000))]).catch(e => { this._log(`⚠️ 选币超时`); return []; });
    // 前50强流动性币种
    const top50 = tickers
      .filter(t => t.symbol.endsWith('USDT') && !CONFIG.blacklist.includes(t.symbol))
      .sort((a, b) => b.volume - a.volume)
      .slice(0, CONFIG.topN)
      .map(t => ({ symbol: t.symbol, price: t.price, change: t.change }));
    // 前十浮盈±≤1%币种(从top50中筛选)
    const floatProfitSymbols = top50
      .filter(t => Math.abs(t.change || 0) <= CONFIG.floatProfitPct)
      .slice(0, 10)
      .map(t => t.symbol);
    return { top50: top50.map(t => t.symbol), floatProfitSymbols };
  }

  // ═══ 开仓条件 ═══
  checkOpenCondition(klines) {
    const bwPercentile = Indicators.bandwidthPercentile(klines, CONFIG.bandwidthPercentileLookback);
    if (!bwPercentile) return { allowed: false };
    if (bwPercentile > 90) return { allowed: false };

    if (bwPercentile >= CONFIG.bandwidthOpenAllow) return { allowed: false };
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
  // ═══ 双模式止盈: 轨道止盈 + 放量ATR跟踪止盈 ═══
  checkTakeProfit(klines, pos) {
    const bb = Indicators.bollinger(klines, CONFIG.bbPeriod, CONFIG.bbStd);
    if (!bb) return { action: 'HOLD' };
    const lastK = klines[klines.length - 1];
    const close = lastK.close;
    const pnlPct = this._calcPnlPct(pos, close);

    // 统一前提: 浮盈≥2%才触发
    if (pnlPct < CONFIG.profitTriggerPct) return { action: 'HOLD' };

    // 判断放量移动止盈模式: 成交量>20周期均量×1.8 + 带宽扩张
    const volMA = Indicators.volumeMA(klines, CONFIG.volumeMaPeriod);
    const volSpike = lastK.volume > volMA * CONFIG.volumeSpikeRatio;
    const prevBB = Indicators.bollinger(klines.slice(0, -1), CONFIG.bbPeriod, CONFIG.bbStd);
    const bwExpanding = prevBB && bb.bandwidth > prevBB.bandwidth;
    
    if (volSpike && bwExpanding) {
      // 放量移动止盈模式 — ATR跟踪
      pos._atrMode = true;
      const atr = Indicators.atr(klines, CONFIG.atrPeriod);
      if (atr) {
        if (pos.side === 'LONG') {
          const stageLow = this._getStageLow(klines, pos);
          const trailLine = stageLow + atr * CONFIG.atrTrailMultiplier;
          if (close <= trailLine) return { action: 'CLOSE', reason: `放量ATR止盈: 收盘${close.toFixed(6)}≤跟踪线${trailLine.toFixed(6)}(低点+0.3ATR)` };
        } else {
          const stageHigh = this._getStageHigh(klines, pos);
          const trailLine = stageHigh - atr * CONFIG.atrTrailMultiplier;
          if (close >= trailLine) return { action: 'CLOSE', reason: `放量ATR止盈: 收盘${close.toFixed(6)}≥跟踪线${trailLine.toFixed(6)}(高点-0.3ATR)` };
        }
      }
      return { action: 'HOLD' };
    }
    
    // 布林带收口后切回轨道止盈模式
    if (pos._atrMode && Indicators.isContracting && Indicators.isContracting(klines)) {
      pos._atrMode = false;
    }
    if (pos._atrMode) return { action: 'HOLD' };

    // 常态轨道止盈
    // 一级止盈: 收盘触中轨全平
    if (pos.side === 'LONG' && close >= bb.mid) return { action: 'CLOSE', reason: `轨道止盈: 触中轨` };
    if (pos.side === 'SHORT' && close <= bb.mid) return { action: 'CLOSE', reason: `轨道止盈: 触中轨` };

    // 二级兜底: 反向轨道触碰止盈
    if (pos.side === 'LONG' && close >= bb.upper) return { action: 'CLOSE', reason: `二级兜底: 触上轨` };
    if (pos.side === 'SHORT' && close <= bb.lower) return { action: 'CLOSE', reason: `二级兜底: 触下轨` };

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

  // ═══ 单K止损 (含杠杆, ≥本金20%) ═══
  checkSingleKStopLoss(klines, pos) {
    const lastK = klines[klines.length - 1];
    const prevK = klines[klines.length - 2];
    if (!prevK) return { action: 'HOLD' };
    let klineLossPct;
    if (pos.side === 'LONG') klineLossPct = (prevK.close - lastK.close) / prevK.close * 100 * pos.leverage;
    else klineLossPct = (lastK.close - prevK.close) / prevK.close * 100 * pos.leverage;
    if (klineLossPct >= CONFIG.singleKLossPct) return { action: 'CLOSE', reason: `单K止损: ${klineLossPct.toFixed(1)}%≥${CONFIG.singleKLossPct}%` };
    return { action: 'HOLD' };
  }

  // ═══ 终极止损: 3次补完+总浮亏≥70%(含杠杆) ═══
  checkUltimateStopLoss(pos) {
    if (pos.replenishCount < CONFIG.maxReplenish) return { action: 'HOLD' };
    const price = pos.currentPrice || pos.entryPrice;
    let lossPct;
    if (pos.side === 'LONG') lossPct = (pos.entryPrice - price) / pos.entryPrice * 100 * pos.leverage;
    else lossPct = (price - pos.entryPrice) / pos.entryPrice * 100 * pos.leverage;
    if (lossPct >= CONFIG.ultimateLossPct) return { action: 'CLOSE', reason: `终极止损: 3次补完+总浮亏${lossPct.toFixed(1)}%≥${CONFIG.ultimateLossPct}%` };
    return { action: 'HOLD' };
  }

  // ═══ 防深套补救措施 (6个) ═══

  // 1. 总浮亏止损: 不管补没补仓, 总浮亏≥30%含杠杆就止损
  checkTotalLossStop(pos) {
    const price = pos.currentPrice || pos.entryPrice;
    let lossPct;
    if (pos.side === 'LONG') lossPct = (pos.entryPrice - price) / pos.entryPrice * 100 * pos.leverage;
    else lossPct = (price - pos.entryPrice) / pos.entryPrice * 100 * pos.leverage;
    if (lossPct >= CONFIG.totalLossPct) return { action: 'CLOSE', reason: `总浮亏止损: ${lossPct.toFixed(1)}%≥${CONFIG.totalLossPct}%` };
    return { action: 'HOLD' };
  }

  // 2. 连续亏损止损: 连续N根K线收盘价都在开仓价反方向
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

  // 3. 补仓前浮亏检查: 浮亏≥10%含杠杆时不补仓
  checkReplenishLossGuard(pos) {
    const price = pos.currentPrice || pos.entryPrice;
    let lossPct;
    if (pos.side === 'LONG') lossPct = (pos.entryPrice - price) / pos.entryPrice * 100 * pos.leverage;
    else lossPct = (price - pos.entryPrice) / pos.entryPrice * 100 * pos.leverage;
    return lossPct >= CONFIG.noReplenishLossPct;
  }

  // 4. 强平预警止损: 价格接近强平价80%时紧急止损
  checkLiquidationWarning(pos) {
    // 3x杠杆强平价≈开仓价反方向33%
    const liqDistance = 1 / pos.leverage; // 33%
    const price = pos.currentPrice || pos.entryPrice;
    let priceMovePct;
    if (pos.side === 'LONG') priceMovePct = (pos.entryPrice - price) / pos.entryPrice;
    else priceMovePct = (price - pos.entryPrice) / pos.entryPrice;
    // 价格已经走到强平距离的80%
    if (priceMovePct >= liqDistance * CONFIG.liquidationWarnPct) {
      return { action: 'CLOSE', reason: `强平预警: 价格变动${(priceMovePct*100).toFixed(1)}%≥强平距离${(liqDistance*CONFIG.liquidationWarnPct*100).toFixed(1)}%` };
    }
    return { action: 'HOLD' };
  }

  // 5. 时间止损: 持仓>4小时且浮亏>5%
  checkTimeStop(pos) {
    if (!pos.openTime) return { action: 'HOLD' };
    const holdHours = (Date.now() - pos.openTime) / 3600000;
    if (holdHours < CONFIG.maxHoldHours) return { action: 'HOLD' };
    const price = pos.currentPrice || pos.entryPrice;
    let lossPct;
    if (pos.side === 'LONG') lossPct = (pos.entryPrice - price) / pos.entryPrice * 100 * pos.leverage;
    else lossPct = (price - pos.entryPrice) / pos.entryPrice * 100 * pos.leverage;
    if (lossPct >= CONFIG.maxHoldLossPct) return { action: 'CLOSE', reason: `时间止损: 持仓${holdHours.toFixed(1)}h且浮亏${lossPct.toFixed(1)}%≥${CONFIG.maxHoldLossPct}%` };
    return { action: 'HOLD' };
  }

  // 6. 补仓后均价止损: 价格跌破均价5%
  checkAvgPriceStop(pos) {
    if (pos.replenishCount === 0) return { action: 'HOLD' }; // 没补过仓不检查
    const price = pos.currentPrice || pos.entryPrice;
    let priceMovePct;
    if (pos.side === 'LONG') priceMovePct = (pos.entryPrice - price) / pos.entryPrice * 100;
    else priceMovePct = (price - pos.entryPrice) / pos.entryPrice * 100;
    if (priceMovePct >= CONFIG.avgPriceLossPct) return { action: 'CLOSE', reason: `均价止损: 价格偏离均价${priceMovePct.toFixed(1)}%≥${CONFIG.avgPriceLossPct}%` };
    return { action: 'HOLD' };
  }

  // ═══ 补仓 ═══
  async checkReplenish(klines, pos) {
    if (pos.replenishCount >= CONFIG.maxReplenish) return { action: 'HOLD' };
    if (pos._orphan) return { action: 'HOLD' };

    // (图片要求里没有补仓前浮亏检查, 去掉)

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
  async _syncPositions(trendPositions) {
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
              // 拉取最近的REALIZED_PNL记录
              const startTime = closedPos.openTime || (Date.now() - 86400000);
              const income = await this.api.getIncome(startTime, Date.now(), 'REALIZED_PNL');
              // 找到该symbol的盈亏
              const symIncome = (income || []).filter(r => r.symbol === sym);
              pnlUsd = symIncome.reduce((s, r) => s + parseFloat(r.income), 0);
              if (symIncome.length > 0) {
                this._log(`📊 ${sym} Binance真实PnL=$${pnlUsd.toFixed(4)} (${symIncome.length}笔)`);
              } else {
                // 没找到记录,用本地估算
                const exitPrice = closedPos.currentPrice || closedPos.entryPrice;
                pnlUsd = this._calcPnlUsd(closedPos, exitPrice);
                this._log(`⚠️ ${sym} 未找到Binance记录,用本地估算PnL=$${pnlUsd.toFixed(4)}`);
              }
            } catch(e) {
              // API失败用本地估算
              const exitPrice = closedPos.currentPrice || closedPos.entryPrice;
              pnlUsd = this._calcPnlUsd(closedPos, exitPrice);
              this._log(`⚠️ ${sym} 拉取PnL失败,用本地估算: ${e.message.slice(0,30)}`);
            }
            // v3: 不记录远程已平仓到仪表盘
            // this._recordTrade(sym, closedPos, '远程已平仓', pnlUsd);
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
        // 更新已有仓位
        if (this.positions[sym]) {
          this.positions[sym].currentPrice = parseFloat(r.markPrice);
          continue;
        }
        // 跳过趋势策略管理的仓位
        if (trendPositions && trendPositions[sym]) continue;
        // v3: 接管新仓位 — 按symbol字母序分配(BB管前半,趋势管后半)
        // 避免两个策略接管同一个币
        const symHash = sym.charCodeAt(0) + sym.charCodeAt(1);
        if (symHash % 2 === 0) {
          const entry = parseFloat(r.entryPrice);
          this.positions[sym] = {
            symbol: sym, side: amt > 0 ? 'LONG' : 'SHORT',
            qty: Math.abs(amt), entryPrice: entry,
            leverage: parseInt(r.leverage) || CONFIG.leverage,
            margin: Math.abs(amt) * entry / (parseInt(r.leverage) || CONFIG.leverage),
            replenishCount: 3, mode: '轨道', _orphan: true,
            openTime: Date.now(), currentPrice: parseFloat(r.markPrice),
          };
          this._log(`📌 ${sym} BB接管 ${amt > 0 ? 'LONG' : 'SHORT'}`);
        }
      }
      this._saveState();
    } catch(e) { this._log(`⚠️ 同步持仓失败: ${e.message}`); }
  }

  // ═══ 开仓执行 ═══
  async _openPosition(symbol, direction, klines) {
    if (CONFIG.blacklist.includes(symbol)) return;
    if (this.gatesFeePaused) { this._log(`⏭️ ${symbol} 算力费暂停,不开新仓`); return; }
    if (!this.balance || this.balance <= 0) { this._log(`⏭️ ${symbol} 余额不足`); return; }
    // v3: 检查总仓位 — 拉取Binance实际持仓数(包括无主仓位)
    const myCount = Object.keys(this.positions).length;
    let binanceCount = myCount; // 默认用本地
    try {
      const remote = await Promise.race([this.api.getPositions(), new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 8000))]).catch(e => null);
      if (remote) binanceCount = remote.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0).length;
    } catch(e) {}
    const myMax = this.getDynamicMaxPositions();
    if (myCount >= myMax || binanceCount >= 10) { this._log(`⏭️ ${symbol} 持仓已满(我的${myCount}/${myMax} Binance${binanceCount}/10)`); return; }

    const price = klines[klines.length - 1].close;
    const atr = Indicators.atr(klines, CONFIG.atrPeriod);
    const atrPct = atr / price * 100;
    const positionPct = this._getPositionPct(atrPct);
    const margin = Math.min(this.balance * positionPct, 30); // v3: 单仓上限$30
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
  // v3: 单向模式下 — 全平原仓+开反向新仓(用原仓保证金)
  async _closeAndReverse(symbol, pos) {
    try {
      const origQty = pos.qty;
      const origSide = pos.side;
      // 全平原仓
      if (origSide === 'LONG') await this.api.closeLong(symbol, origQty, this.precisionMap);
      else await this.api.closeShort(symbol, origQty, this.precisionMap);
      this._log(`📉 ${symbol} 原仓${origSide}全平 qty=${origQty.toFixed(4)}`);
      // 用释放的保证金开反向新仓(同数量)
      const reverseDir = origSide === 'LONG' ? 'SHORT' : 'LONG';
      if (reverseDir === 'LONG') await this.api.marketLong(symbol, origQty, pos.leverage, this.precisionMap, 0);
      else await this.api.marketShort(symbol, origQty, pos.leverage, this.precisionMap, 0);
      this._log(`🔄 ${symbol} 反向开仓 ${reverseDir} qty=${origQty.toFixed(4)}`);
      pos._reversed = true;
    } catch(e) { this._log(`⚠️ ${symbol} 全平+反向开仓失败: ${e.message}`); }
  }

  async _closePosition(symbol, pos, reason) {
    try {
      let result;
      if (pos.side === 'LONG') result = await this.api.closeLong(symbol, pos.qty, this.precisionMap);
      else result = await this.api.closeShort(symbol, pos.qty, this.precisionMap);
      const pnlUsd = this._calcPnlUsd(pos, pos.currentPrice);
      this._log(`✅ ${symbol} 平仓 ${reason} PnL=$${pnlUsd.toFixed(2)}`);
      // v3: 交易统计
      this._trades = (this._trades || 0) + 1;
      this._realizedPnl = (this._realizedPnl || 0) + pnlUsd;
      if (pnlUsd > 0) this._wins = (this._wins || 0) + 1;
      else this._losses = (this._losses || 0) + 1;
      // v3: 记录交易历史到文件(兼容仪表盘)
      this._recordTrade(symbol, pos, reason, pnlUsd);
      // 算力费扣费
      await this._collectServiceFee(symbol, pnlUsd);
      delete this.positions[symbol];
      this._saveState();
    } catch(e) { this._log(`❌ ${symbol} 平仓失败: ${e.message}`); }
  }

  // v3: 记录交易历史
  // v3: 从Binance同步已实现盈亏, 补充缺失的交易记录
  async _syncIncomeHistory() {
    try {
      // 拉取最近24小时的REALIZED_PNL
      const startTime = Date.now() - 86400000;
      const income = await this.api.getIncome(startTime, Date.now(), 'REALIZED_PNL');
      if (!income || income.length === 0) return;
      
      const walletKey = (this.wallet || 'admin').toLowerCase();
      const tradeFile = path.join(__dirname, '..', 'data', `bb-trades-${walletKey}.json`);
      let trades = [];
      if (fs.existsSync(tradeFile)) trades = JSON.parse(fs.readFileSync(tradeFile, 'utf8'));
      
      // 按symbol+time去重, 已有的不重复记录
      const existingKeys = new Set(trades.map(t => `${t.symbol}_${t.closeTime}`));
      let added = 0;
      
      // 按时间排序
      income.sort((a, b) => parseInt(a.time) - parseInt(b.time));
      
      for (const r of income) {
        const pnl = parseFloat(r.income);
        if (pnl === 0) continue; // 跳过0盈亏(资金费率等)
        const closeTime = parseInt(r.time);
        const key = `${r.symbol}_${closeTime}`;
        if (existingKeys.has(key)) continue;
        
        // 估算方向(从income无法直接获取, 从本地state找)
        let side = 'LONG';
        const localPos = this.positions[r.symbol];
        if (localPos) side = localPos.side;
        
        trades.push({
          symbol: r.symbol, side, qty: 0,
          entryPrice: 0, exitPrice: 0,
          pnlUsd: parseFloat(pnl.toFixed(4)),
          pnlPct: 0, margin: 0, leverage: 3,
          reason: 'Binance同步', closeTime,
          wallet: this.wallet, mode: 'BB',
        });
        existingKeys.add(key);
        added++;
        this._trades = (this._trades||0)+1;
        this._realizedPnl = (this._realizedPnl||0)+pnl;
        if (pnl > 0) this._wins = (this._wins||0)+1; else this._losses = (this._losses||0)+1;
      }
      
      if (added > 0) {
        if (trades.length > 10) trades = trades.slice(-10);
        fs.writeFileSync(tradeFile, JSON.stringify(trades, null, 2));
        this._log(`📊 Binance同步: 补充${added}笔交易记录`);
      }
    } catch(e) { this._log(`⚠️ Binance同步失败: ${e.message.slice(0,50)}`); }
  }

  _recordTrade(symbol, pos, reason, pnlUsd) {
    try {
      const walletKey = (this.wallet || 'admin').toLowerCase();
      const tradeFile = path.join(__dirname, '..', 'data', `bb-trades-${walletKey}.json`);
      // v3: 读-追加-写, 不用锁(BB和趋势不会同时平同一个币)
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
        wallet: this.wallet, mode: 'BB',
      });
      if (trades.length > 10) trades = trades.slice(-10);
      fs.writeFileSync(tradeFile, JSON.stringify(trades, null, 2));
    } catch(e) { this._log(`⚠️ 交易记录写入失败: ${e.message.slice(0,50)}`); }
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
    // 记录待转账
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
      // 更新用户DB余额
      if (this._userDB && this.wallet) {
        // v3: 用小写wallet查userDB,防止大小写不一致
        const wl = this.wallet.toLowerCase();
        const user = this._userDB.get(wl) || this._userDB.get(this.wallet) || {};
        const oldBal = user.gatesFeeBalance || 0;
        const newBal = oldBal - platformFee - ecoFund;
        this._userDB.set(wl, { ...user, gatesFeeBalance: newBal, gatesFeeLow: newBal < 5, gatesFeeCollected: (user.gatesFeeCollected||0) + platformFee + ecoFund });
        // v3: 写入saas-users.json文件
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
        this._log(`📉 ${this.wallet.slice(0,8)} 仪表盘余额: $${oldBal.toFixed(2)} → $${newBal.toFixed(2)} (扣减 $${(platformFee+ecoFund).toFixed(2)})`);
      }
      // 累计≥$5自动转账
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
    if (totalFee < FEE_CONFIG.FEE_THRESHOLD) {
      this._log(`📊 ${walletKey.slice(0,10)} 累计费用$${totalFee.toFixed(2)} < $${FEE_CONFIG.FEE_THRESHOLD}阈值`);
      return;
    }
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
      if (BigInt(traderBal) < totalFeeWei) { this._log(`❌ ${walletKey.slice(0,10)} Trader钱包USDT不足`); return; }
      // 转算力费
      if (totalPlatform > 0) {
        const tx1 = await usdtContract.transfer(FEE_CONFIG.PLATFORM_WALLET, ethers.parseUnits(totalPlatform.toFixed(6), 18), { gasPrice: GAS_PRICE });
        await tx1.wait();
        this._log(`✅ 算力费转账$${totalPlatform.toFixed(2)}`);
      }
      // 转算力费
      const tx2 = await usdtContract.transfer(FEE_CONFIG.ECO_FUND_WALLET, ethers.parseUnits(totalEco.toFixed(6), 18), { gasPrice: GAS_PRICE });
      await tx2.wait();
      this._log(`✅ 算力费转账$${totalEco.toFixed(2)}`);
      // 标记已收
      for (const r of pending) r.platformCollected = true;
      fs.writeFileSync(FEE_CONFIG.FEE_STATE_FILE, JSON.stringify(feeState, null, 2));
    } catch(e) { this._log(`❌ ${walletKey.slice(0,10)} 链上扣费失败: ${e.message.slice(0,100)}`); }
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
    this._startTime = Date.now(); // v2: 记录启动时间
    this._log('🚀 BB策略启动');
    this._loadState();
    try { this.precisionMap = await this.api.getExchangeInfo(); } catch(e) {}
    this.balance = await new Promise((resolve, reject) => { this.api.getBalance().then(resolve).catch(reject); setTimeout(() => reject(new Error('timeout')), 10000); }).catch(e => { this._log(`⚠️ 余额查询超时`); return this.balance || 0; });
    this._log(`💰 余额: $${this.balance.toFixed(2)}`);
    await this._syncPositions(this._trendPositions);
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
    // v2: 加超时保护, 防止API调用卡死
    const withTimeout = (p, ms) => Promise.race([p, new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
    
    if (this._cycleCount % 10 === 0 || !this.precisionMap) {
      try { this.precisionMap = await withTimeout(this.api.getExchangeInfo(), 15000); } catch(e) {}
    }

    // 每5轮刷新余额
    if (this._cycleCount % 5 === 0) {
      try { this.balance = await this.api.getBalance(); } catch(e) {}
    }

    // Binance同步已停用(造成重复记录)

    await this._syncPositions(this._trendPositions);

    // 管理现有持仓
    for (const symbol of Object.keys(this.positions)) {
      const pos = this.positions[symbol];
      try {
        const klines = await Promise.race([this.api.getKlines(symbol, CONFIG.klineInterval, CONFIG.klineLimit), new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 10000))]).catch(e => null);
        if (!klines || klines.length < 60) continue;
        // 插针过滤: 单K>3%该K线所有信号作废, 不执行任何风控动作
        const lastK = klines[klines.length - 1];
        const changePct = Math.abs((lastK.close - lastK.open) / lastK.open * 100);
        if (changePct > 3) { this._log(`⚪ ${symbol} 毛刺K线(${changePct.toFixed(1)}%) 跳过`); continue; }
        pos.currentPrice = klines[klines.length - 1].close;

        // v2: 重启宽限期 — 启动后10分钟只检查止盈,不检查止损
        const inGracePeriod = this._startTime && (Date.now() - this._startTime < CONFIG.gracePeriodMs);

        if (!inGracePeriod) {
        // 七、前置风控: 单K线浮亏≥本金20%止损(含杠杆)
        const sl = this.checkSingleKStopLoss(klines, pos);
        if (sl.action === 'CLOSE') { this._log(`🔴 ${symbol} ${sl.reason}`); await this._closePosition(symbol, pos, sl.reason); continue; }

        // v3: 单向模式 — 浮亏≥10%全平原仓+开反向新仓
        if (!pos._reversed && totalLoss >= CONFIG.reverseTriggerPct) {
          await this._closeAndReverse(symbol, pos);
          continue;
        }

        // 八、终极风控: 3次补完+总浮亏≥70%止损
        const ult = this.checkUltimateStopLoss(pos);
        if (ult.action === 'CLOSE') { this._log(`🔴 ${symbol} ${ult.reason}`); await this._closePosition(symbol, pos, ult.reason); continue; }
        } // end grace period

        // 止盈(始终检查)

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

    // BB策略开仓(已恢复)
    // 开新仓 — v3: 拉取Binance实际持仓数检查
    const myCount3 = Object.keys(this.positions).length;
    let binanceCount3 = myCount3;
    try {
      const remote3 = await Promise.race([this.api.getPositions(), new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 8000))]).catch(e => null);
      if (remote3) binanceCount3 = remote3.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0).length;
    } catch(e) {}
    if (myCount3 >= this.getDynamicMaxPositions() || binanceCount3 >= 10) return;
    const { top50, floatProfitSymbols } = await this.selectSymbols();
    this._log(`📊 选币完成: top50=${top50?.length||0}个 浮盈±1%=${floatProfitSymbols?.length||0}个`);
    // 优先浮盈±≤1%的币, 再用top50补充
    const symbols = [...new Set([...floatProfitSymbols, ...top50])];
    for (const symbol of symbols) {
      if (this.positions[symbol]) continue;
      if (Object.keys(this.positions).length >= this.getDynamicMaxPositions()) break;
      try {
        const klines = await Promise.race([this.api.getKlines(symbol, CONFIG.klineInterval, CONFIG.klineLimit), new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 10000))]).catch(e => null);
        if (!klines || klines.length < 120) continue;
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
    // BB开仓已恢复
  }
}

module.exports = { BBStrategy, CONFIG };
