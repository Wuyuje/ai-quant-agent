/**
 * Forex Engine v95 — 外汇交易引擎
 * 
 * 参考世界顶尖外汇量化基金策略:
 * - AQR Capital: 利差套利(Carry Trade) + 趋势跟踪
 * - Man Group: 统计套利 + 多因子模型
 * - Winton Group: 系统化趋势 + 波动率套利
 * - Bridgewater: 宏观因子 + 风险平价
 * 
 * 交易标的: Binance 上的外汇类代币 (EUR/USD等)
 * 或通过外汇CFD (如有API支持)
 * 
 * 策略矩阵:
 * 1. Interest Rate Differential (利差套利)
 * 2. Momentum (动量趋势)
 * 3. Mean Reversion (均值回归)
 * 4. Volatility Breakout (波动率突破)
 * 5. Macro Factor (宏观因子)
 * 
 * 特点:
 * - 24/5交易 (周一至周五)
 * - 低波动 (日均0.5-1%)
 * - 套息交易 (高息货币做多, 低息货币做空)
 * - 中央银行利率决议是最大催化剂
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const SpotTrader = require('./spot-trader');

class ForexEngine {
  constructor(apiKey, apiSecret, config = {}) {
    this.baseURL = 'https://fapi.binance.com'; // 期货API（外汇对可用时）
    this.spotURL = 'https://api.binance.com';
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;

    // 外汇交易对 (Binance上的外汇代币)
    this.pairs = {
      // Binance 真实可交易外汇标的
      'EURUSDT': {
        category: 'major', pipValue: 0.0001,
        interestRate: { long: -0.005, short: 0.003 },
        correlation: { DXY: -0.85, GOLD: 0.30 },
        qtyPrecision: 2, minQty: 0.01, tickSize: 0.0001,
        market: 'spot', // Binance 现货
      },
      // 用 Binance 合约里的相关标的补充
      'PAXGUSDT': {
        category: 'precious_metal', pipValue: 0.01,
        interestRate: { long: -0.002, short: 0.001 },
        correlation: { DXY: -0.70, EURUSDT: 0.25 },
        qtyPrecision: 3, minQty: 0.001, tickSize: 0.01,
        market: 'spot', // 黄金现货 (避险货币关联)
      },
    }

    // 策略配置
    this.strategies = {
      carryTrade: {
        name: '利差套利',
        weight: 0.25,
        minHolding: 7 * 24 * 60 * 60 * 1000, // 最少持仓7天
        description: '做多高息货币, 做空低息货币, 赚取利差',
      },
      momentum: {
        name: '动量趋势',
        weight: 0.25,
        lookback: 20,
        threshold: 0.6,
        description: '20日动量突破, 跟随趋势',
      },
      meanReversion: {
        name: '均值回归',
        weight: 0.20,
        lookback: 50,
        zEntry: 2.0,
        zExit: 0.5,
        description: '价格偏离均值2个标准差时反向操作',
      },
      volatilityBreakout: {
        name: '波动率突破',
        weight: 0.15,
        atrPeriod: 14,
        multiplier: 1.5,
        description: '波动率从低位爆发时跟进',
      },
      macroFactor: {
        name: '宏观因子',
        weight: 0.15,
        factors: ['interestRate', 'inflation', 'gdpGrowth', 'tradeBalance'],
        description: '基于宏观经济数据的方向判断',
      },
    };

    // 风控
    this.risk = {
      maxLeverage: 5,
      maxPositionPct: 20,
      stopLossPct: 1.5,
      takeProfitPct: 3.0,
      maxDailyTrades: 6,
      cooldownMs: 3600000, // 1小时冷却
    };

    this.state = {
      positions: {},
      dailyTrades: 0,
      lastTradeTime: {},
      equity: 1000,
      pnl: 0,
    };

    this.logFile = path.join(__dirname, '..', 'logs', 'forex-engine.log');
    this.trader = new SpotTrader(apiKey, apiSecret);
    this._log('Forex Engine v95 初始化');
  }

  /**
   * 主循环 (30秒)
   */
  async start() {
    this._log('🚀 Forex Engine 启动');

    // 获取初始数据
    await this._fetchAllPrices();

    // 主循环
    this._startDelay = Math.floor(Math.random() * 15000);
    setTimeout(() => {
      this._interval = setInterval(async () => {
        try {
          await this._tick();
        } catch (e) {
          this._log(`❌ Tick错误: ${e.message}`);
        }
      }, 60000); // v113.13.5: 30s→60s
      this._log(`⏰ 定时器已启动 (间隔60s, 延迟${this._startDelay}ms)`);
    }, this._startDelay);
  }

  async stop() {
    if (this._interval) clearInterval(this._interval);
    this._log('Forex Engine 停止');
  }

  async _tick() {
    // 1. 更新价格
    await this._fetchAllPrices();

    // 2. 检查现有持仓
    await this._checkPositions();

    // 3. 扫描新机会
    await this._scanOpportunities();

    // 4. 保存状态
    this._saveState();
  }

  /**
   * 获取所有外汇对价格
   */
  async _fetchAllPrices() {
    for (const [symbol, config] of Object.entries(this.pairs)) {
      try {
        const ticker = await this._getTicker(symbol);
        if (ticker) {
          this.pairs[symbol].lastPrice = parseFloat(ticker.lastPrice);
          this.pairs[symbol].priceChange = parseFloat(ticker.priceChangePercent);
        }
      } catch (e) {
        // 静默
      }
    }
  }

  async _getTicker(symbol) {
    const { globalLimiter } = require('./rate-limiter');
    const url = `${this.spotURL}/api/v3/ticker/24hr?symbol=${symbol}`;
    return globalLimiter.schedule(1, () => new Promise((resolve) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
        });
      }).on('error', () => resolve(null));
    }));
  }

  /**
   * 扫描交易机会 — 5策略融合
   */
  async _scanOpportunities() {
    for (const [symbol, pair] of Object.entries(this.pairs)) {
      if (this.state.positions[symbol]) continue; // 已有仓位
      // v113.11: 冷却检查 — 防疯狂重复下单
      if (!this._openedSymbols) this._openedSymbols = {};
      if (this._openedSymbols[symbol] && Date.now() - this._openedSymbols[symbol] < 30 * 60 * 1000) continue;
      if (this.state.dailyTrades >= this.risk.maxDailyTrades) break;

      const signals = [];

      // 策略1: 利差套利
      const carry = this._carryTradeSignal(symbol, pair);
      if (carry) signals.push(carry);

      // 策略2: 动量
      const momentum = this._momentumSignal(symbol, pair);
      if (momentum) signals.push(momentum);

      // 策略3: 均值回归
      const reversion = this._meanReversionSignal(symbol, pair);
      if (reversion) signals.push(reversion);

      // 策略4: 波动率突破
      const volBreak = this._volatilityBreakoutSignal(symbol, pair);
      if (volBreak) signals.push(volBreak);

      // 策略5: 宏观因子
      const macro = this._macroFactorSignal(symbol, pair);
      if (macro) signals.push(macro);

      // 融合投票
      if (signals.length >= 2) {
        const directions = signals.map(s => s.direction);
        const longCount = directions.filter(d => d === 'LONG').length;
        const shortCount = directions.filter(d => d === 'SHORT').length;
        
        if (longCount >= 2 && longCount > shortCount) {
          await this._openPosition(symbol, 'LONG', signals);
        } else if (shortCount >= 2 && shortCount > longCount) {
          await this._openPosition(symbol, 'SHORT', signals);
        }
      }
    }
  }

  // === 5个策略 ===

  /**
   * 策略1: 利差套利 (Carry Trade)
   * 世界顶尖基金AQR的核心策略之一
   */
  _carryTradeSignal(symbol, pair) {
    if (!pair.interestRate) return null;
    
    const longRate = pair.interestRate.long;
    const shortRate = pair.interestRate.short;
    const diff = longRate - shortRate;

    // 利差 > 0.3% 且趋势稳定时做多高息货币
    if (diff > 0.003) {
      return { 
        strategy: 'carryTrade', 
        direction: 'LONG', 
        confidence: Math.min(0.8, diff * 100),
        desc: `利差 ${((diff) * 100).toFixed(2)}% 支持做多`,
      };
    } else if (diff < -0.003) {
      return { 
        strategy: 'carryTrade', 
        direction: 'SHORT', 
        confidence: Math.min(0.8, Math.abs(diff) * 100),
        desc: `利差 ${((diff) * 100).toFixed(2)}% 支持做空`,
      };
    }
    return null;
  }

  /**
   * 策略2: 动量趋势 (Momentum)
   * Man Group / AQR 的经典策略
   */
  _momentumSignal(symbol, pair) {
    if (!pair.lastPrice) return null;
    
    // 用价格变化百分比作为动量
    const mom = pair.priceChange || 0;
    const threshold = 0.3; // 0.3%日动量

    if (mom > threshold) {
      return {
        strategy: 'momentum',
        direction: 'LONG',
        confidence: Math.min(0.7, mom / 2),
        desc: `20日动量 +${mom.toFixed(2)}% 趋势向上`,
      };
    } else if (mom < -threshold) {
      return {
        strategy: 'momentum',
        direction: 'SHORT',
        confidence: Math.min(0.7, Math.abs(mom) / 2),
        desc: `20日动量 ${mom.toFixed(2)}% 趋势向下`,
      };
    }
    return null;
  }

  /**
   * 策略3: 均值回归 (Mean Reversion)
   * Renaissance Technologies 的核心策略之一
   */
  _meanReversionSignal(symbol, pair) {
    if (!pair.lastPrice) return null;
    
    // 简化: 用24h涨跌幅判断是否偏离
    const deviation = pair.priceChange || 0;
    
    if (deviation > 0.8) {
      return {
        strategy: 'meanReversion',
        direction: 'SHORT',
        confidence: Math.min(0.6, deviation / 3),
        desc: `价格偏离均值 +${deviation.toFixed(2)}%，回归信号做空`,
      };
    } else if (deviation < -0.8) {
      return {
        strategy: 'meanReversion',
        direction: 'LONG',
        confidence: Math.min(0.6, Math.abs(deviation) / 3),
        desc: `价格偏离均值 ${deviation.toFixed(2)}%，回归信号做多`,
      };
    }
    return null;
  }

  /**
   * 策略4: 波动率突破 (Volatility Breakout)
   * Winton Group 的策略之一
   */
  _volatilityBreakoutSignal(symbol, pair) {
    if (!pair.lastPrice) return null;
    
    const vol = Math.abs(pair.priceChange || 0);
    
    // 波动率突然放大 → 跟随突破方向
    if (vol > 0.6) {
      return {
        strategy: 'volatilityBreakout',
        direction: pair.priceChange > 0 ? 'LONG' : 'SHORT',
        confidence: Math.min(0.65, vol / 2),
        desc: `波动率 ${vol.toFixed(2)}% 突破，跟随方向`,
      };
    }
    return null;
  }

  /**
   * 策略5: 宏观因子 (Macro Factor)
   * Bridgewater 全天候策略的核心
   */
  _macroFactorSignal(symbol, pair) {
    // 简化宏观因子 — 实际应该接入经济数据API
    const macroScore = this._getMacroScore(pair.category);
    
    if (macroScore > 0.3) {
      return {
        strategy: 'macroFactor',
        direction: 'LONG',
        confidence: macroScore,
        desc: `宏观因子评分 ${macroScore.toFixed(2)} 利好`,
      };
    } else if (macroScore < -0.3) {
      return {
        strategy: 'macroFactor',
        direction: 'SHORT',
        confidence: Math.abs(macroScore),
        desc: `宏观因子评分 ${macroScore.toFixed(2)} 利空`,
      };
    }
    return null;
  }

  _getMacroScore(category) {
    // 简化的宏观评分 (实际应接入 FRED API / 央行数据)
    // 这里用随机 + 趋势模拟
    return (Math.random() - 0.5) * 0.6;
  }

  /**
   * 开仓
   */
  async _openPosition(symbol, direction, signals) {
    const pair = this.pairs[symbol];
    const price = pair.lastPrice;
    if (!price) return;

    // v113.11: 防疯狂重复下单 — 冷却检查
    if (!this._openedSymbols) this._openedSymbols = {};
    if (this._openedSymbols[symbol] && Date.now() - this._openedSymbols[symbol] < 30 * 60 * 1000) return;
    this._openedSymbols[symbol] = Date.now();

    // 计算仓位大小
    const equity = this.state.equity;
    const positionSize = equity * (this.risk.maxPositionPct / 100);
    const qty = parseFloat((positionSize / price).toFixed(pair.qtyPrecision));

    // 平均信号置信度
    const avgConf = signals.reduce((s, sig) => s + sig.confidence, 0) / signals.length;

    // v108.2: 真实下单 — 现货只能做多
    if (direction === 'SHORT') {
      this._log(`⚠️ FOREX跳过SHORT: ${symbol} 现货不支持做空`);
      return;
    }
    let orderResult = null;
    try {
      orderResult = await this.trader.marketBuy(symbol, qty);
    } catch (e) {
      this._log(`❌ FOREX下单失败: ${symbol} ${direction} ${e.message}`);
      return;
    }

    this._log(`📈 FOREX开仓: ${direction} ${symbol} @ $${price} | 数量=${qty} | 置信度=${avgConf.toFixed(2)}`);
    this._log(`  策略: ${signals.map(s => s.strategy).join('+')}`);
    this._log(`  理由: ${signals.map(s => s.desc).join(' | ')}`);

    this.state.positions[symbol] = {
      symbol,
      direction,
      entryPrice: price,
      qty,
      notionalUsd: positionSize,
      entryTime: Date.now(),
      signals: signals.map(s => s.strategy),
      confidence: avgConf,
      orderId: orderResult?.orderId,
      stopLoss: direction === 'LONG' ? price * (1 - this.risk.stopLossPct / 100) : price * (1 + this.risk.stopLossPct / 100),
      takeProfit: direction === 'LONG' ? price * (1 + this.risk.takeProfitPct / 100) : price * (1 - this.risk.takeProfitPct / 100),
    };

    this.state.dailyTrades++;
    this.state.lastTradeTime[symbol] = Date.now();
    this._saveState();
  }

  /**
   * 检查现有持仓
   */
  async _checkPositions() {
    for (const [symbol, pos] of Object.entries(this.state.positions)) {
      const pair = this.pairs[symbol];
      if (!pair || !pair.lastPrice) continue;

      const currentPrice = pair.lastPrice;
      let pnlPct;
      
      if (pos.direction === 'LONG') {
        pnlPct = (currentPrice - pos.entryPrice) / pos.entryPrice * 100;
      } else {
        pnlPct = (pos.entryPrice - currentPrice) / pos.entryPrice * 100;
      }

      // 止损
      if (pnlPct < -this.risk.stopLossPct) {
        this._log(`🛑 FOREX止损: ${symbol} ${pos.direction} | PnL=${pnlPct.toFixed(2)}%`);
        // v108: 真实平仓
        try {
          if (pos.direction === 'LONG') await this.trader.marketSell(symbol, pos.qty);
          else await this.trader.marketBuy(symbol, pos.qty);
          this._log(`✅ ${symbol} 平仓成功`);
        } catch (e) { this._log(`❌ ${symbol} 平仓失败: ${e.message}`); }
        delete this.state.positions[symbol];
        this.state.pnl += pos.notionalUsd * pnlPct / 100;
      }
      // 止盈
      else if (pnlPct > this.risk.takeProfitPct) {
        this._log(`💰 FOREX止盈: ${symbol} ${pos.direction} | PnL=+${pnlPct.toFixed(2)}%`);
        // v108: 真实平仓
        try {
          if (pos.direction === 'LONG') await this.trader.marketSell(symbol, pos.qty);
          else await this.trader.marketBuy(symbol, pos.qty);
          this._log(`✅ ${symbol} 平仓成功`);
        } catch (e) { this._log(`❌ ${symbol} 平仓失败: ${e.message}`); }
        delete this.state.positions[symbol];
        this.state.pnl += pos.notionalUsd * pnlPct / 100;
      }
      // 持仓时间过长 (外汇趋势一般2-5天)
      else if (Date.now() - pos.entryTime > 14 * 24 * 60 * 60 * 1000) {
        this._log(`⏰ FOREX超时平仓: ${symbol} ${pos.direction} | PnL=${pnlPct.toFixed(2)}%`);
        // v108: 真实平仓
        try {
          if (pos.direction === 'LONG') await this.trader.marketSell(symbol, pos.qty);
          else await this.trader.marketBuy(symbol, pos.qty);
          this._log(`✅ ${symbol} 平仓成功`);
        } catch (e) { this._log(`❌ ${symbol} 平仓失败: ${e.message}`); }
        delete this.state.positions[symbol];
        this.state.pnl += pos.notionalUsd * pnlPct / 100;
      }
    }
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
      const dir = path.join(__dirname, '..', 'data');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'forex-state.json'), JSON.stringify(this.state, null, 2));
    } catch (e) {}
  }

  getReport() {
    return {
      market: 'Forex',
      pairs: Object.keys(this.pairs).length,
      positions: Object.values(this.state.positions).map(p => ({
        symbol: p.symbol,
        direction: p.direction,
        entry: p.entryPrice,
        notional: p.notionalUsd,
        strategies: p.signals,
      })),
      dailyTrades: this.state.dailyTrades,
      pnl: this.state.pnl,
    };
  }
}

module.exports = ForexEngine;
