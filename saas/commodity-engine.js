/**
 * Commodity Engine v96 — 商品交易引擎 (石油 + 白银 + 大宗商品)
 * 
 * 世界顶尖策略参考:
 * - Trafigura/Vitol: 大宗商品贸易商模式 + 现货溢价交易
 * - Winton Group: 商品期货趋势跟踪
 * - Man AHL: 商品跨期套利 + 动量
 * - AQR: 商品因子投资 (便利收益 + 通胀对冲)
 * 
 * 可交易标的 (Binance):
 * - OILUSDT (石油期货模拟)
 * - 银: 通过XAGPAXG (白银/黄金比) 间接交易
 * - 其他: DOGE, SHIB等作为meme商品
 * 
 * 策略:
 * 1. 趋势跟踪 (AHL): 长周期动量 + 短周期过滤
 * 2. 均值回归 (Trafigura): 季节性模式 + 库存周期
 * 3. 跨商品套利: 原油/天然气比, 金/银比
 * 4. 通胀对冲: 商品vs美元负相关交易
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const FuturesTrader = require('./futures-trader');

class CommodityEngine {
  constructor(apiKey, apiSecret) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseURL = 'https://fapi.binance.com';

    // 可交易商品 (用Binance USDT永续模拟)
    this.symbols = [
      // Binance 合约 — 真实商品期货
      { symbol: 'XAGUSDT', name: 'Silver', correlation: 'silver', weight: 0.25, qtyPrecision: 3 },
      { symbol: 'XAUUSDT', name: 'Gold Futures', correlation: 'gold', weight: 0.25, qtyPrecision: 3 },
      { symbol: 'COPPERUSDT', name: 'Copper', correlation: 'industrial', weight: 0.25, qtyPrecision: 1 },
      { symbol: 'NATGASUSDT', name: 'Natural Gas', correlation: 'energy', weight: 0.25, qtyPrecision: 1 },
    ]

    // 策略参数
    this.strategies = {
      trend: { name: 'AHL Trend', fast: 10, slow: 40, weight: 0.30 },
      meanRev: { name: 'Seasonal MeanRevert', lookback: 24, threshold: 1.5, weight: 0.25 },
      crossCommodity: { name: 'Cross-Commodity Ratio', pairs: [
        { long: 'PAXGUSDT', short: 'BTCUSDT', name: 'Gold/BTC Ratio', zThreshold: 2.0 },
      ], weight: 0.25 },
      inflationHedge: { name: 'Inflation Hedge', weight: 0.20 },
    };

    this.state = {
      positions: {},
      dailyPnl: 0,
      totalTrades: 0,
      lastScan: Date.now(),
      klines: {},
    };

    this.logFile = path.join(__dirname, '..', 'logs', 'commodity.log');
    this.stateFile = path.join(__dirname, '..', 'data', 'commodity-state.json');
    this.trader = new FuturesTrader(apiKey, apiSecret);
    this._loadState();
    this._log('CommodityEngine v96 初始化');
  }

  async start() {
    this._log('🚀 Commodity Engine 启动');
    // 加载K线
    await this._loadKlines();
    // 主循环 (30秒)
    this._interval = setInterval(() => this._tick(), 30000);
  }

  stop() {
    if (this._interval) clearInterval(this._interval);
    this._log('Commodity Engine 停止');
  }

  async _tick() {
    try {
      await this._updatePrices();
      const signals = this._generateSignals();
      await this._executeTrades(signals);
      this._managePositions();
      this._saveState();
    } catch (e) {
      this._log(`❌ Tick错误: ${e.message}`);
    }
  }

  async _loadKlines() {
    for (const item of this.symbols) {
      try {
        const klines = await this._fetchKlines(item.symbol, '1h', 100);
        this.state.klines[item.symbol] = klines;
      } catch (e) {}
    }
    this._log(`K线加载完成: ${Object.keys(this.state.klines).length}/${this.symbols.length}`);
  }

  async _updatePrices() {
    for (const item of this.symbols) {
      try {
        const ticker = await this._fetchTicker(item.symbol);
        if (ticker) {
          if (!this.state.klines[item.symbol]) this.state.klines[item.symbol] = [];
          this.state.klines[item.symbol].push({
            time: Date.now(),
            close: parseFloat(ticker.lastPrice),
            high: parseFloat(ticker.highPrice),
            low: parseFloat(ticker.lowPrice),
            volume: parseFloat(ticker.quoteVolume),
          });
          // 保留最近200根
          if (this.state.klines[item.symbol].length > 200) {
            this.state.klines[item.symbol] = this.state.klines[item.symbol].slice(-200);
          }
        }
      } catch (e) {}
    }
  }

  _generateSignals() {
    const signals = [];

    for (const item of this.symbols) {
      const klines = this.state.klines[item.symbol];
      if (!klines || klines.length < 50) continue;

      const closes = klines.map(k => k.close);
      const volumes = klines.map(k => k.volume);
      const currentPrice = closes[closes.length - 1];

      // 1. AHL Trend (双均线)
      const trend = this._ahlTrend(closes);
      if (trend.direction !== 0) {
        signals.push({
          symbol: item.symbol,
          direction: trend.direction > 0 ? 'LONG' : 'SHORT',
          confidence: trend.strength,
          strategy: 'trend',
          price: currentPrice,
        });
      }

      // 2. Mean Reversion (偏离MA后回归)
      const mr = this._meanReversion(closes);
      if (mr.signal !== 0) {
        signals.push({
          symbol: item.symbol,
          direction: mr.signal > 0 ? 'LONG' : 'SHORT',
          confidence: Math.abs(mr.zScore) / 3,
          strategy: 'meanRev',
          price: currentPrice,
        });
      }
    }

    // 3. Cross-Commodity Ratio
    const ratioSignals = this._crossCommodityRatio();
    signals.push(...ratioSignals);

    // 4. Inflation Hedge (金/美元反向)
    const infSignals = this._inflationHedge();
    signals.push(...infSignals);

    return this._fuseSignals(signals);
  }

  /**
   * AHL趋势跟踪
   */
  _ahlTrend(closes) {
    const fast = this.strategies.trend.fast;
    const slow = this.strategies.trend.slow;
    if (closes.length < slow + 5) return { direction: 0, strength: 0 };

    const maFast = this._sma(closes, fast);
    const maSlow = this._sma(closes, slow);
    const current = closes[closes.length - 1];

    // 趋势强度
    const diff = (maFast - maSlow) / maSlow * 100;
    const atr = this._atr(closes, 14);
    const normalizedDiff = diff / (atr / current * 100);

    // 过滤: 价格必须在均线同侧
    if (Math.abs(normalizedDiff) > 0.5 && current > maSlow === diff > 0) {
      return { direction: diff > 0 ? 1 : -1, strength: Math.min(1, Math.abs(normalizedDiff) / 3) };
    }
    return { direction: 0, strength: 0 };
  }

  /**
   * 均值回归
   */
  _meanReversion(closes) {
    const lookback = this.strategies.meanRev.lookback;
    const threshold = this.strategies.meanRev.threshold;
    if (closes.length < lookback + 5) return { signal: 0, zScore: 0 };

    const recent = closes.slice(-lookback);
    const ma = recent.reduce((s, c) => s + c, 0) / recent.length;
    const std = Math.sqrt(recent.reduce((s, c) => s + (c - ma) ** 2, 0) / recent.length);
    const current = closes[closes.length - 1];
    const zScore = std > 0 ? (current - ma) / std : 0;

    if (zScore > threshold) return { signal: -1, zScore }; // 超买→做空
    if (zScore < -threshold) return { signal: 1, zScore }; // 超卖→做多
    return { signal: 0, zScore };
  }

  /**
   * 跨商品比价套利
   */
  _crossCommodityRatio() {
    const signals = [];
    for (const pair of this.strategies.crossCommodity.pairs) {
      const klinesA = this.state.klines[pair.long];
      const klinesB = this.state.klines[pair.short];
      if (!klinesA || !klinesB || klinesA.length < 50 || klinesB.length < 50) continue;

      const ratios = [];
      const len = Math.min(klinesA.length, klinesB.length);
      for (let i = len - 50; i < len; i++) {
        ratios.push(klinesA[i].close / klinesB[i].close);
      }

      const ma = ratios.reduce((s, r) => s + r, 0) / ratios.length;
      const std = Math.sqrt(ratios.reduce((s, r) => s + (r - ma) ** 2, 0) / ratios.length);
      const currentRatio = ratios[ratios.length - 1];
      const zScore = std > 0 ? (currentRatio - ma) / std : 0;

      if (Math.abs(zScore) > pair.zThreshold) {
        // 比价偏离 → 做回归
        signals.push({
          symbol: pair.long,
          direction: zScore > 0 ? 'LONG' : 'SHORT', // 做回归方向
          confidence: Math.min(1, Math.abs(zScore) / 3),
          strategy: 'crossCommodity',
          desc: `${pair.name} Z=${zScore.toFixed(2)}`,
        });
      }
    }
    return signals;
  }

  /**
   * 通胀对冲 (黄金 vs 美元)
   */
  _inflationHedge() {
    // 简化: 黄金和美元负相关
    const goldKlines = this.state.klines['PAXGUSDT'];
    if (!goldKlines || goldKlines.length < 24) return [];

    const goldChange = (goldKlines[goldKlines.length-1].close - goldKlines[goldKlines.length-24]?.close) / (goldKlines[goldKlines.length-24]?.close || 1) * 100;

    // 黄金急涨 → 可能通胀预期升温 → 做多黄金/商品
    if (goldChange > 2) {
      return [{
        symbol: 'PAXGUSDT',
        direction: 'LONG',
        confidence: 0.6,
        strategy: 'inflationHedge',
        desc: `Gold +${goldChange.toFixed(1)}% 通胀信号`,
      }];
    }
    return [];
  }

  /**
   * 信号融合
   */
  _fuseSignals(signals) {
    const grouped = {};
    for (const s of signals) {
      const key = `${s.symbol}_${s.direction}`;
      if (!grouped[key]) grouped[key] = { ...s, votes: 0, totalConf: 0 };
      grouped[key].votes++;
      grouped[key].totalConf += s.confidence;
    }

    return Object.values(grouped)
      .filter(g => g.votes >= 2 || g.totalConf > 0.6)
      .map(g => ({
        ...g,
        confidence: g.totalConf / g.votes,
        strength: g.votes >= 3 ? 'strong' : g.votes >= 2 ? 'medium' : 'weak',
      }));
  }

  async _executeTrades(signals) {
    for (const sig of signals) {
      if (sig.strength === 'weak') continue;
      if (this.state.positions[sig.symbol]) continue; // 已有仓位

      const notionalUsd = 50; // 小仓位测试
      const price = sig.price;
      const qty = parseFloat((notionalUsd / price).toFixed(6));

      this._log(`📊 ${sig.strategy} 信号: ${sig.symbol} ${sig.direction} conf=${(sig.confidence*100).toFixed(0)}%`);

      // v108: 真实下单
      let orderResult = null;
      try {
        if (sig.direction === 'LONG') {
          orderResult = await this.trader.marketLong(sig.symbol, qty);
        } else {
          orderResult = await this.trader.marketShort(sig.symbol, qty);
        }
      } catch (e) {
        this._log(`❌ COMMODITY下单失败: ${sig.symbol} ${sig.direction} ${e.message}`);
        continue;
      }
      
      this.state.positions[sig.symbol] = {
        direction: sig.direction,
        entryPrice: price,
        qty,
        notionalUsd,
        strategy: sig.strategy,
        entryTime: Date.now(),
        orderId: orderResult?.orderId,
        stopLoss: sig.direction === 'LONG' ? price * 0.97 : price * 1.03,
        takeProfit: sig.direction === 'LONG' ? price * 1.04 : price * 0.96,
      };
      this.state.totalTrades++;
    }
  }

  async _managePositions() {
    for (const [sym, pos] of Object.entries(this.state.positions)) {
      const klines = this.state.klines[sym];
      if (!klines || klines.length === 0) continue;
      
      const currentPrice = klines[klines.length - 1].close;
      const pnlPct = pos.direction === 'LONG'
        ? (currentPrice - pos.entryPrice) / pos.entryPrice * 100
        : (pos.entryPrice - currentPrice) / pos.entryPrice * 100;

      // 止损
      if (pos.direction === 'LONG' && currentPrice <= pos.stopLoss) {
        this._log(`🛑 止损 ${sym}: ${pnlPct.toFixed(2)}%`);
        this._closePosition(sym, pos);
        this.state.dailyPnl += pos.notionalUsd * pnlPct / 100;
        continue;
      }
      if (pos.direction === 'SHORT' && currentPrice >= pos.stopLoss) {
        this._log(`🛑 止损 ${sym}: ${pnlPct.toFixed(2)}%`);
        this._closePosition(sym, pos);
        this.state.dailyPnl += pos.notionalUsd * pnlPct / 100;
        continue;
      }

      // 止盈
      if (pos.direction === 'LONG' && currentPrice >= pos.takeProfit) {
        this._log(`🎯 止盈 ${sym}: +${pnlPct.toFixed(2)}%`);
        this._closePosition(sym, pos);
        this.state.dailyPnl += pos.notionalUsd * pnlPct / 100;
        continue;
      }
      if (pos.direction === 'SHORT' && currentPrice <= pos.takeProfit) {
        this._log(`🎯 止盈 ${sym}: +${pnlPct.toFixed(2)}%`);
        this._closePosition(sym, pos);
        this.state.dailyPnl += pos.notionalUsd * pnlPct / 100;
        continue;
      }
    }
  }

  // v108: 真实平仓
  async _closePosition(symbol, pos) {
    try {
      if (pos.direction === 'LONG') await this.trader.closeLong(symbol, pos.qty);
      else await this.trader.closeShort(symbol, pos.qty);
      this._log(`✅ ${symbol} 平仓成功`);
    } catch (e) { this._log(`❌ ${symbol} 平仓失败: ${e.message}`); }
    delete this.state.positions[symbol];
  }

  // ═══ 辅助函数 ═══
  _sma(data, period) {
    if (data.length < period) return data[data.length - 1];
    return data.slice(-period).reduce((s, c) => s + c, 0) / period;
  }

  _atr(closes, period) {
    if (closes.length < period + 1) return 0;
    let sum = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      sum += Math.abs(closes[i] - closes[i - 1]);
    }
    return sum / period;
  }

  _fetchKlines(symbol, interval, limit) {
    return new Promise((resolve) => {
      const url = `${this.baseURL}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      https.get(url, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const raw = JSON.parse(data);
            resolve(raw.map(k => ({
              time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
              low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
            })));
          } catch (e) { resolve([]); }
        });
      }).on('error', () => resolve([]));
    });
  }

  _fetchTicker(symbol) {
    return new Promise((resolve) => {
      https.get(`${this.baseURL}/fapi/v1/ticker/24hr?symbol=${symbol}`, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
        });
      }).on('error', () => resolve(null));
    });
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

  _loadState() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        this.state = { ...this.state, ...data };
      }
    } catch (e) {}
  }
}

module.exports = CommodityEngine;
