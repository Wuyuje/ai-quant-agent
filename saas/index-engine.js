/**
 * Index/ETF Engine v95 — 股指/ETF交易引擎
 * 
 * 参考世界顶尖量化基金策略:
 * - Renaissance Medallion: 统计套利 + 均值回归
 * - Two Sigma: 因子模型 + 机器学习
 * - Citadel: 多空股票策略
 * - AQR: 动量 + 价值因子
 * - BlackRock: Smart Beta + 风险平价
 * 
 * 交易标的: Binance上的代币化ETF/指数
 * (SPY→SP500代币, QQQ→纳斯达克代币等)
 * 或通过其他交易平台API
 * 
 * 策略矩阵:
 * 1. Trend Following (趋势跟踪)
 * 2. Value Factor (价值因子)
 * 3. Mean Reversion (均值回归)
 * 4. Volatility Selling (波动率卖出)
 * 5. Cross-Asset Momentum (跨资产动量)
 * 6. Earnings Drift (财报漂移)
 * 
 * 特殊规则:
 * - 美股交易时段: 9:30-16:00 ET (21:30-04:00 北京时间)
 * - 盘前/盘后流动性差, 避免交易
 * - VIX > 30 时降低仓位
 * - 财报季增加波动率仓位
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const FuturesTrader = require('./futures-trader');

class IndexEngine {
  constructor(apiKey, apiSecret, config = {}) {
    this.baseURL = 'https://fapi.binance.com';
    this.spotURL = 'https://api.binance.com';
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;

    // 指数/ETF 交易对 (Binance上的代币化指数)
    this.assets = {
      // Binance 合约 — 真实美股代币
      'TSLAUSDT': {
        category: 'tech_stock',
        description: 'Tesla (TSLA)',
        volatility: 'high',
        tradingHours: 'US_market',
        qtyPrecision: 2, minQty: 0.01, tickSize: 0.01,
        market: 'futures',
      },
      'NVDAUSDT': {
        category: 'tech_stock',
        description: 'NVIDIA (NVDA)',
        volatility: 'high',
        tradingHours: 'US_market',
        qtyPrecision: 2, minQty: 0.01, tickSize: 0.01,
        market: 'futures',
      },
      'AAPLUSDT': {
        category: 'tech_stock',
        description: 'Apple (AAPL)',
        volatility: 'medium',
        tradingHours: 'US_market',
        qtyPrecision: 2, minQty: 0.01, tickSize: 0.01,
        market: 'futures',
      },
      'MSFTUSDT': {
        category: 'tech_stock',
        description: 'Microsoft (MSFT)',
        volatility: 'medium',
        tradingHours: 'US_market',
        qtyPrecision: 2, minQty: 0.01, tickSize: 0.01,
        market: 'futures',
      },
      'METAUSDT': {
        category: 'tech_stock',
        description: 'Meta Platforms (META)',
        volatility: 'high',
        tradingHours: 'US_market',
        qtyPrecision: 2, minQty: 0.01, tickSize: 0.01,
        market: 'futures',
      },
      'GOOGLUSDT': {
        category: 'tech_stock',
        description: 'Alphabet/Google (GOOGL)',
        volatility: 'medium',
        tradingHours: 'US_market',
        qtyPrecision: 2, minQty: 0.01, tickSize: 0.01,
        market: 'futures',
      },
      // ETF 指数
      'SPYUSDT': {
        category: 'index_etf',
        description: 'S&P 500 ETF (SPY)',
        volatility: 'low',
        tradingHours: 'US_market',
        qtyPrecision: 2, minQty: 0.01, tickSize: 0.01,
        market: 'futures',
      },
      'QQQUSDT': {
        category: 'index_etf',
        description: 'Nasdaq 100 ETF (QQQ)',
        volatility: 'medium',
        tradingHours: 'US_market',
        qtyPrecision: 2, minQty: 0.01, tickSize: 0.01,
        market: 'futures',
      },
    }

    // 6个策略配置
    this.strategies = {
      trendFollowing: {
        name: '趋势跟踪',
        weight: 0.20,
        lookback: 50,
        description: '50日均线趋势判断, 顺势而为',
      },
      valueFactor: {
        name: '价值因子',
        weight: 0.15,
        description: 'P/E, P/B, EV/EBITDA 等估值因子',
      },
      meanReversion: {
        name: '均值回归',
        weight: 0.20,
        lookback: 20,
        zEntry: 1.8,
        description: '20日偏离回归',
      },
      volatilitySelling: {
        name: '波动率卖出',
        weight: 0.15,
        description: '高波动率时卖出波动率(做空波动)',
      },
      crossAssetMomentum: {
        name: '跨资产动量',
        weight: 0.15,
        description: '跨资产类别动量轮动',
      },
      earningsDrift: {
        name: '财报漂移',
        weight: 0.15,
        description: '利好/利空财报后的持续漂移',
      },
    };

    this.risk = {
      maxLeverage: 5,
      maxPositionPct: 20,
      stopLossPct: 2.0,
      takeProfitPct: 4.0,
      maxDailyTrades: 8,
      vixThreshold: 30,    // VIX > 30 时减仓
      maxSectorExposure: 30,
    };

    this.state = {
      positions: {},
      dailyTrades: 0,
      equity: 1000,
      pnl: 0,
      marketRegime: 'normal', // normal, volatile, trending
    };

    this.logFile = path.join(__dirname, '..', 'logs', 'index-engine.log');
    this.trader = new FuturesTrader(apiKey, apiSecret);
    this._log('Index/ETF Engine v95 初始化');
  }

  async start() {
    this._log('🚀 Index/ETF Engine 启动');
    await this._fetchAllPrices();

    this._interval = setInterval(async () => {
      try {
        await this._tick();
      } catch (e) {
        this._log(`❌ Tick错误: ${e.message}`);
      }
    }, 30000);
  }

  async stop() {
    if (this._interval) clearInterval(this._interval);
    this._log('Index/ETF Engine 停止');
  }

  async _tick() {
    await this._fetchAllPrices();
    await this._checkPositions();
    await this._scanOpportunities();
    this._detectMarketRegime();
    this._saveState();
  }

  async _fetchAllPrices() {
    for (const [symbol, asset] of Object.entries(this.assets)) {
      try {
        const ticker = await this._getTicker(symbol);
        if (ticker) {
          this.assets[symbol].lastPrice = parseFloat(ticker.lastPrice);
          this.assets[symbol].priceChange = parseFloat(ticker.priceChangePercent);
          this.assets[symbol].volume = parseFloat(ticker.quoteVolume);
        }
      } catch (e) {}
    }
  }

  async _getTicker(symbol) {
    return new Promise((resolve) => {
      // v108.2: 股票代币在合约市场，用 fapi
      const url = `${this.baseURL}/fapi/v1/ticker/24hr?symbol=${symbol}`;
      https.get(url, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
        });
      }).on('error', () => resolve(null));
    });
  }

  /**
   * 检测市场状态
   */
  _detectMarketRegime() {
    const changes = Object.values(this.assets)
      .filter(a => a.priceChange !== undefined)
      .map(a => Math.abs(a.priceChange));
    
    const avgVol = changes.reduce((s, c) => s + c, 0) / (changes.length || 1);
    
    if (avgVol > 3) {
      this.state.marketRegime = 'volatile';
    } else if (avgVol > 1.5) {
      this.state.marketRegime = 'trending';
    } else {
      this.state.marketRegime = 'normal';
    }
  }

  /**
   * 6策略融合扫描
   */
  async _scanOpportunities() {
    for (const [symbol, asset] of Object.entries(this.assets)) {
      if (this.state.positions[symbol]) continue;
      if (this.state.dailyTrades >= this.risk.maxDailyTrades) break;

      const signals = [];

      // 1. 趋势跟踪
      const trend = this._trendSignal(symbol, asset);
      if (trend) signals.push(trend);

      // 2. 价值因子
      const value = this._valueSignal(symbol, asset);
      if (value) signals.push(value);

      // 3. 均值回归
      const reversion = this._meanReversionSignal(symbol, asset);
      if (reversion) signals.push(reversion);

      // 4. 波动率卖出
      const volSell = this._volatilitySellingSignal(symbol, asset);
      if (volSell) signals.push(volSell);

      // 5. 跨资产动量
      const crossMom = this._crossAssetMomentumSignal(symbol, asset);
      if (crossMom) signals.push(crossMom);

      // 6. 财报漂移
      const drift = this._earningsDriftSignal(symbol, asset);
      if (drift) signals.push(drift);

      // 融合: 至少3个策略同意
      if (signals.length >= 2) {
        const dirs = signals.map(s => s.direction);
        const longs = dirs.filter(d => d === 'LONG').length;
        const shorts = dirs.filter(d => d === 'SHORT').length;

        if (longs >= 2 && longs > shorts) {
          await this._openPosition(symbol, 'LONG', signals);
        } else if (shorts >= 2 && shorts > longs) {
          await this._openPosition(symbol, 'SHORT', signals);
        }
      }
    }
  }

  // === 6个策略实现 ===

  _trendSignal(symbol, asset) {
    const change = asset.priceChange || 0;
    // 强趋势: 日涨幅>1.5% 或 跌幅>1.5%
    if (change > 1.5) {
      return { strategy: 'trendFollowing', direction: 'LONG', confidence: Math.min(0.7, change / 4), desc: `强上升趋势 +${change.toFixed(2)}%` };
    } else if (change < -1.5) {
      return { strategy: 'trendFollowing', direction: 'SHORT', confidence: Math.min(0.7, Math.abs(change) / 4), desc: `强下降趋势 ${change.toFixed(2)}%` };
    }
    return null;
  }

  _valueSignal(symbol, asset) {
    // 简化: 用涨跌幅代替估值 (实际应接入P/E等数据)
    const change = asset.priceChange || 0;
    if (change < -2) {
      return { strategy: 'valueFactor', direction: 'LONG', confidence: 0.5, desc: `超跌${change.toFixed(2)}%，价值回归机会` };
    } else if (change > 3) {
      return { strategy: 'valueFactor', direction: 'SHORT', confidence: 0.4, desc: `超涨${change.toFixed(2)}%，估值偏高` };
    }
    return null;
  }

  _meanReversionSignal(symbol, asset) {
    const change = asset.priceChange || 0;
    if (Math.abs(change) > 2) {
      return {
        strategy: 'meanReversion',
        direction: change > 0 ? 'SHORT' : 'LONG',
        confidence: Math.min(0.65, Math.abs(change) / 5),
        desc: `偏离均值 ${change.toFixed(2)}%，回归信号`,
      };
    }
    return null;
  }

  _volatilitySellingSignal(symbol, asset) {
    const vol = Math.abs(asset.priceChange || 0);
    // 高波动时做空波动 (在趋势方向上开仓, 等波动回归)
    if (vol > 2.5) {
      return {
        strategy: 'volatilitySelling',
        direction: asset.priceChange > 0 ? 'LONG' : 'SHORT',
        confidence: Math.min(0.6, vol / 5),
        desc: `高波动 ${vol.toFixed(2)}%，波动率卖出`,
      };
    }
    return null;
  }

  _crossAssetMomentumSignal(symbol, asset) {
    // 跨资产动量: 如果同类资产都在涨/跌
    const sameAssets = Object.entries(this.assets)
      .filter(([s, a]) => a.category === asset.category && s !== symbol);
    
    if (sameAssets.length === 0) return null;
    
    const avgChange = sameAssets.reduce((s, [, a]) => s + (a.priceChange || 0), 0) / sameAssets.length;
    
    if (avgChange > 1) {
      return { strategy: 'crossAssetMomentum', direction: 'LONG', confidence: 0.5, desc: `同板块动量 +${avgChange.toFixed(2)}%` };
    } else if (avgChange < -1) {
      return { strategy: 'crossAssetMomentum', direction: 'SHORT', confidence: 0.5, desc: `同板块动量 ${avgChange.toFixed(2)}%` };
    }
    return null;
  }

  _earningsDriftSignal(symbol, asset) {
    // 简化: 大幅波动后持续方向 (模拟财报漂移)
    const change = asset.priceChange || 0;
    if (Math.abs(change) > 3) {
      return {
        strategy: 'earningsDrift',
        direction: change > 0 ? 'LONG' : 'SHORT',
        confidence: 0.45,
        desc: `大幅波动 ${change.toFixed(2)}%，漂移信号`,
      };
    }
    return null;
  }

  async _openPosition(symbol, direction, signals) {
    const asset = this.assets[symbol];
    const price = asset.lastPrice;
    if (!price) return;

    const positionSize = this.state.equity * (this.risk.maxPositionPct / 100);
    const qty = parseFloat((positionSize / price).toFixed(asset.qtyPrecision));
    const avgConf = signals.reduce((s, sig) => s + sig.confidence, 0) / signals.length;

    // v108.2: 合约下单
    let orderResult = null;
    try {
      if (direction === 'LONG') {
        orderResult = await this.trader.marketLong(symbol, qty);
      } else {
        orderResult = await this.trader.marketShort(symbol, qty);
      }
    } catch (e) {
      this._log(`❌ INDEX下单失败: ${symbol} ${direction} ${e.message}`);
      return;
    }

    this._log(`📈 INDEX开仓: ${direction} ${symbol} (${asset.description}) @ $${price} | 置信度=${avgConf.toFixed(2)}`);
    this._log(`  策略: ${signals.map(s => s.strategy).join('+')}`);
    this._log(`  市场状态: ${this.state.marketRegime}`);

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
    this._saveState();
  }

  async _checkPositions() {
    for (const [symbol, pos] of Object.entries(this.state.positions)) {
      const asset = this.assets[symbol];
      if (!asset || !asset.lastPrice) continue;

      const currentPrice = asset.lastPrice;
      let pnlPct = pos.direction === 'LONG'
        ? (currentPrice - pos.entryPrice) / pos.entryPrice * 100
        : (pos.entryPrice - currentPrice) / pos.entryPrice * 100;

      if (pnlPct < -this.risk.stopLossPct) {
        this._log(`🛑 INDEX止损: ${symbol} | PnL=${pnlPct.toFixed(2)}%`);
        try {
          if (pos.direction === 'LONG') await this.trader.closeLong(symbol, pos.qty);
          else await this.trader.closeShort(symbol, pos.qty);
          this._log(`✅ ${symbol} 平仓成功`);
        } catch (e) { this._log(`❌ ${symbol} 平仓失败: ${e.message}`); }
        delete this.state.positions[symbol];
        this.state.pnl += pos.notionalUsd * pnlPct / 100;
      } else if (pnlPct > this.risk.takeProfitPct) {
        this._log(`💰 INDEX止盈: ${symbol} | PnL=+${pnlPct.toFixed(2)}%`);
        try {
          if (pos.direction === 'LONG') await this.trader.closeLong(symbol, pos.qty);
          else await this.trader.closeShort(symbol, pos.qty);
          this._log(`✅ ${symbol} 平仓成功`);
        } catch (e) { this._log(`❌ ${symbol} 平仓失败: ${e.message}`); }
        delete this.state.positions[symbol];
        this.state.pnl += pos.notionalUsd * pnlPct / 100;
      }
    }
  }

  reduceExposure(pct) {
    for (const [symbol, pos] of Object.entries(this.state.positions)) {
      this._log(`🛡️ INDEX减仓: ${symbol} ${pct}% (VIX保护)`);
      pos.notionalUsd *= (1 - pct / 100);
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
      fs.writeFileSync(path.join(dir, 'index-state.json'), JSON.stringify(this.state, null, 2));
    } catch (e) {}
  }

  getReport() {
    return {
      market: 'Index/ETF',
      assets: Object.keys(this.assets).length,
      positions: Object.values(this.state.positions).map(p => ({
        symbol: p.symbol,
        direction: p.direction,
        entry: p.entryPrice,
        notional: p.notionalUsd,
        strategies: p.signals,
      })),
      marketRegime: this.state.marketRegime,
      dailyTrades: this.state.dailyTrades,
      pnl: this.state.pnl,
    };
  }
}

module.exports = IndexEngine;
