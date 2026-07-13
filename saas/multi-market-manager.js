/**
 * Multi-Market Trading Manager v95 — 多市场全资产交易管理器
 * 
 * 世界顶尖量化基金架构:
 * - Citadel: 跨市场套利 + 多策略融合
 * - Two Sigma: 因子投资 + 机器学习信号
 * - Renaissance: 统计套利 + 均值回归
 * - Bridgewater: 全天候策略 + 风险平价
 * 
 * 市场划分:
 * 1. Crypto Futures (BTC/ETH/SOL等, 24/7, 杠杆)
 * 2. Gold Spot (PAXG/XAU, 避险资产)
 * 3. Forex (EUR/USD等, 24/5, 低波动)
 * 4. Index/ETF (SPY/QQQ等, 美股时段)
 * 
 * 架构: 独立引擎 + 共享风控 + 跨市场信号
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class MultiMarketManager {
  constructor(config = {}) {
    this.logFile = path.join(__dirname, '..', 'logs', 'multi-market.log');
    this.stateFile = path.join(__dirname, '..', 'data', 'multi-market-state.json');
    
    // 全局风险参数
    this.risk = {
      maxTotalExposure: 80,        // 总敞口上限 80%
      maxPerMarket: 30,            // 单市场上限 30%
      maxPerAsset: 15,             // 单资产上限 15%
      maxCorrelated: 40,           // 高相关资产合计上限 40%
      maxDrawdown: 10,             // 全局最大回撤 10%
      dailyLossLimit: 3,           // 日亏损限制 3%
      crossMarketCooldown: 300000, // 跨市场信号冷却 5分钟
    };

    // 市场引擎实例 (延迟初始化)
    this.engines = {};
    
    // 跨市场相关性矩阵
    this.correlations = {
      // BTC跟ETH高相关，不能同时重仓做多
      'BTC-ETH': 0.85,
      'BTC-SOL': 0.72,
      'GOLD-DXY': -0.70,  // 黄金跟美元负相关
      'SPY-VIX': -0.80,   // 股指跟VIX负相关
      'EUR-USD': -0.65,   // 欧元跟美元负相关
      'GOLD-BTC': 0.30,   // 黄金跟BTC弱正相关
    };

    // 跨市场信号规则
    this.crossSignals = [
      { trigger: 'VIX spike > 25', action: 'REDUCE_EQUITY', desc: 'VIX飙升→减仓股指' },
      { trigger: 'DXY drop > 1%', action: 'LONG_GOLD', desc: '美元走弱→做多黄金' },
      { trigger: 'US10Y yield spike', action: 'SHORT_BONDS', desc: '利率飙升→做空债券' },
      { trigger: 'BTC dominance drop', action: 'ALTCOIN_SEASON', desc: 'BTC统治率下降→山寨季' },
      { trigger: 'FED dovish signal', action: 'RISK_ON', desc: '美联储鸽派→风险偏好' },
      { trigger: 'FED hawkish signal', action: 'RISK_OFF', desc: '美联储鹰派→风险规避' },
    ];

    this.state = {
      positions: {},        // 所有市场持仓
      exposures: {},        // 各市场敞口
      dailyPnL: 0,
      totalPnL: 0,
      crossSignals: [],
      lastUpdate: Date.now(),
    };

    this._log('Multi-Market Manager v95 初始化');
  }

  /**
   * 初始化所有市场引擎
   */
  async initialize(apiKey, apiSecret) {
    this._log('🚀 初始化多市场引擎...');

    // 1. Crypto Futures Engine
    try {
      const CryptoEngine = require('../engine');
      // Crypto引擎已经在主index.js中运行，这里不重复创建
      this._log('✅ Crypto Futures: 已由主引擎管理');
    } catch (e) {
      this._log('⚠️ Crypto Futures: ' + e.message);
    }

    // 2. Gold Engine
    try {
      const GoldEngine = require('./gold-engine');
      this.engines.gold = new GoldEngine();
      this._log('✅ Gold Spot: PAXG 策略引擎就绪');
    } catch (e) {
      this._log('⚠️ Gold: ' + e.message);
    }

    // 3. Forex Engine (新增)
    try {
      const ForexEngine = require('./forex-engine');
      this.engines.forex = new ForexEngine(apiKey, apiSecret);
      this._log('✅ Forex: EUR/USD, GBP/USD, USD/JPY 策略引擎就绪');
    } catch (e) {
      this._log('⚠️ Forex: ' + e.message);
    }

    // 4. Index/ETF Engine (新增)
    try {
      const IndexEngine = require('./index-engine');
      this.engines.index = new IndexEngine(apiKey, apiSecret);
      this._log('✅ Index/ETF: SPY, QQQ, DIA 策略引擎就绪');
    } catch (e) {
      this._log('⚠️ Index: ' + e.message);
    }

    this._log(`📊 引擎就绪: ${Object.keys(this.engines).length + 1}个市场`);
    return true;
  }

  /**
   * 全局风控检查 — 每次开仓前必须调用
   */
  async globalRiskCheck(market, symbol, direction, notionalUsd) {
    const checks = [];

    // 1. 总敞口检查
    const totalExposure = this._calcTotalExposure();
    if (totalExposure + notionalUsd / this._getTotalEquity() * 100 > this.risk.maxTotalExposure) {
      checks.push({ pass: false, reason: `总敞口 ${totalExposure.toFixed(1)}% 接近上限 ${this.risk.maxTotalExposure}%` });
    }

    // 2. 单市场敞口检查
    const marketExposure = this._calcMarketExposure(market);
    if (marketExposure + notionalUsd / this._getTotalEquity() * 100 > this.risk.maxPerMarket) {
      checks.push({ pass: false, reason: `${market}市场敞口 ${marketExposure.toFixed(1)}% 超限` });
    }

    // 3. 相关性检查 — 防止同方向过度暴露
    const corrCheck = this._checkCorrelation(market, symbol, direction);
    if (!corrCheck.pass) {
      checks.push(corrCheck);
    }

    // 4. 日亏损限制
    const dailyReturn = this.state.dailyPnL / this._getTotalEquity() * 100;
    if (dailyReturn < -this.risk.dailyLossLimit) {
      checks.push({ pass: false, reason: `日亏损 ${dailyReturn.toFixed(2)}% 超过限制 ${this.risk.dailyLossLimit}%` });
    }

    // 5. 全局最大回撤
    const drawdown = this._calcDrawdown();
    if (drawdown > this.risk.maxDrawdown) {
      checks.push({ pass: false, reason: `全局回撤 ${drawdown.toFixed(2)}% 超过限制 ${this.risk.maxDrawdown}%` });
    }

    const failed = checks.filter(c => !c.pass);
    return {
      pass: failed.length === 0,
      checks,
      failed,
      approved: failed.length === 0,
    };
  }

  /**
   * 跨市场信号检测
   */
  async detectCrossSignals(marketData) {
    const signals = [];

    // VIX → 股指
    if (marketData.vix && marketData.vix > 25) {
      signals.push({
        type: 'RISK_OFF',
        source: 'VIX',
        value: marketData.vix,
        action: { reduceIndex: true, reduceLeverage: true },
        desc: `VIX ${marketData.vix.toFixed(1)} > 25，降低风险敞口`,
      });
    }

    // 美元指数 → 黄金/外汇
    if (marketData.dxy && marketData.dxyChange < -1) {
      signals.push({
        type: 'LONG_GOLD',
        source: 'DXY',
        value: marketData.dxy,
        action: { longGold: true, longEUR: true },
        desc: `美元指数下跌 ${marketData.dxyChange.toFixed(2)}%，做多黄金/欧元`,
      });
    }

    // 利率 → 债券/成长股
    if (marketData.us10y && marketData.us10yChange > 0.1) {
      signals.push({
        type: 'BOND_OFF',
        source: 'US10Y',
        value: marketData.us10y,
        action: { shortBonds: true, reduceGrowth: true },
        desc: `10Y利率上升 ${marketData.us10yChange.toFixed(2)}%，减持债券/成长股`,
      });
    }

    // BTC主导率 → 山寨币
    if (marketData.btcDominance && marketData.btcDominance < 40) {
      signals.push({
        type: 'ALT_SEASON',
        source: 'BTC.D',
        value: marketData.btcDominance,
        action: { longAlts: true },
        desc: `BTC主导率 ${marketData.btcDominance.toFixed(1)}% < 40%，山寨币机会`,
      });
    }

    // 黄金/比特币比 → 风险偏好
    if (marketData.goldBtcRatio) {
      if (marketData.goldBtcRatio > 30) {
        signals.push({
          type: 'CRYPTO_FEAR',
          source: 'GOLD/BTC',
          value: marketData.goldBtcRatio,
          action: { reduceCrypto: true },
          desc: `黄金/BTC比率 ${marketData.goldBtcRatio.toFixed(1)} 偏高，市场恐惧`,
        });
      }
    }

    this.state.crossSignals = signals;
    if (signals.length > 0) {
      this._log(`⚡ 跨市场信号: ${signals.map(s => s.desc).join(' | ')}`);
    }

    return signals;
  }

  /**
   * 跨市场对冲 — 当检测到高风险时自动对冲
   */
  async autoHedge(signals) {
    for (const sig of actions) {
      if (sig.type === 'RISK_OFF') {
        // VIX飙升 → 减仓股指 + 增加黄金对冲
        this._log(`🛡️ 对冲: VIX飙升，建议减仓股指，增加黄金对冲`);
        // 通知各引擎执行
        if (this.engines.index) this.engines.index.reduceExposure(50);
        if (this.engines.gold) this.engines.gold.increaseExposure(20);
      }

      if (sig.type === 'LONG_GOLD') {
        // 美元走弱 → 做多黄金
        this._log(`🛡️ 对冲: 美元走弱，建议做多黄金`);
        if (this.engines.gold) this.engines.gold.openSignal('LONG');
      }

      if (sig.type === 'ALT_SEASON') {
        this._log(`🛡️ 信号: 山寨币季节，建议增加山寨币配置`);
        // 通知加密引擎增加山寨币仓位
      }
    }
  }

  /**
   * 全局状态报告
   */
  getReport() {
    const equity = this._getTotalEquity();
    const exposure = this._calcTotalExposure();
    const drawdown = this._calcDrawdown();

    const marketReports = {};
    for (const [name, engine] of Object.entries(this.engines)) {
      if (engine.getReport) {
        marketReports[name] = engine.getReport();
      }
    }

    return {
      totalEquity: equity,
      totalExposure: exposure,
      drawdown,
      dailyPnL: this.state.dailyPnL,
      totalPnL: this.state.totalPnL,
      markets: marketReports,
      crossSignals: this.state.crossSignals,
      riskStatus: {
        totalExposurePct: exposure,
        maxTotalExposure: this.risk.maxTotalExposure,
        dailyLossPct: this.state.dailyPnL / equity * 100,
        dailyLossLimit: this.risk.dailyLossLimit,
      },
      timestamp: Date.now(),
    };
  }

  // === 内部方法 ===

  _calcTotalExposure() {
    let total = 0;
    for (const pos of Object.values(this.state.positions)) {
      total += (pos.notionalUsd || 0);
    }
    return total / this._getTotalEquity() * 100;
  }

  _calcMarketExposure(market) {
    let total = 0;
    for (const [key, pos] of Object.entries(this.state.positions)) {
      if (pos.market === market) {
        total += (pos.notionalUsd || 0);
      }
    }
    return total / this._getTotalEquity() * 100;
  }

  _getTotalEquity() {
    return this.state.totalEquity || 1000;
  }

  _calcDrawdown() {
    return Math.abs(Math.min(0, this.state.dailyPnL) / this._getTotalEquity() * 100);
  }

  _checkCorrelation(market, symbol, direction) {
    // 检查是否跟现有持仓高相关且同方向
    for (const [key, pos] of Object.entries(this.state.positions)) {
      const corrKey = `${symbol}-${pos.symbol}`;
      const corr = this.correlations[corrKey] || this.correlations[`${pos.symbol}-${symbol}`] || 0;
      
      if (Math.abs(corr) > 0.7 && pos.direction === direction) {
        return {
          pass: false,
          reason: `${symbol} 与 ${pos.symbol} 相关性 ${(corr * 100).toFixed(0)}% 且同方向 ${direction}`,
        };
      }
    }
    return { pass: true };
  }

  _log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    try {
      const dir = path.dirname(this.logFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.logFile, line + '\n');
    } catch (e) {}
  }

  _saveState() {
    try {
      const dir = path.dirname(this.stateFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
    } catch (e) {}
  }
}

module.exports = MultiMarketManager;
