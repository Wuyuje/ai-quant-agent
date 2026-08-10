/**
 * Bond Engine v96 — 国债/债券交易引擎
 * 
 * 世界顶尖策略参考:
 * - PIMCO: 全球债券配置 + 利率周期交易
 * - Bridgewater: 全天候策略 (利率+通胀+增长因子)
 * - Two Sigma: 利率趋势跟踪 + 曲线交易
 * - AQR: 债券动量 + 价值因子
 * 
 * 核心逻辑:
 * - 利率上升 → 做空债券(价格下跌)
 * - 利率下降 → 做多债券(价格上涨)
 * - 通胀预期 → 做空长期债, 做多短期债
 * - 经济衰退 → 做多债券(避险)
 * 
 * Binance中可用标的:
 * - 通过USDT永续合约间接交易利率敏感资产
 * - BTC/ETH在利率下降时通常上涨(成长股逻辑)
 * - 稳定币收益 = 隐含利率
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const FuturesTrader = require('./futures-trader');

class BondEngine {
  constructor(apiKey, apiSecret) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseURL = 'https://fapi.binance.com';

    // 利率敏感资产 (在加密市场中的代理)
    this.symbols = [
      // Binance 合约 — 利率敏感型资产 / 固收替代品
      { symbol: 'USDCUSDT', name: 'USD Stablecoin', rateSensitivity: 0.3, type: 'short-duration' },
      { symbol: 'CRCLUSDT', name: 'Money Market Fund', rateSensitivity: 0.5, type: 'short-duration' },
      { symbol: 'UVXYUSDT', name: 'Volatility (VIX)', rateSensitivity: 1.2, type: 'long-duration' },
      { symbol: 'URNMUSDT', name: 'Uranium ETF', rateSensitivity: 1.0, type: 'long-duration' },
    ]

    // 利率因子
    this.rateState = {
      currentRate: 4.25,       // 当前联邦基金利率
      expectedChange: 0,       // 预期变化
      yieldCurve: 'normal',    // normal/inverted/flat
      inflationExpection: 3.2, // 通胀预期
      realRate: 1.05,          // 实际利率
      dxy: 100,                // 美元指数
      vix: 20,                 // VIX
    };

    // Bridgewater全天候策略
    this.strategies = {
      rateCycle: { name: '利率周期', weight: 0.30 },
      yieldCurve: { name: '收益率曲线', weight: 0.25 },
      inflationLinked: { name: '通胀挂钩', weight: 0.25 },
      creditSpread: { name: '信用利差', weight: 0.20 },
    };

    this.state = {
      positions: {},
      dailyPnl: 0,
      totalTrades: 0,
      lastScan: Date.now(),
      klines: {},
    };

    this.logFile = path.join(__dirname, '..', 'logs', 'bond.log');
    this.stateFile = path.join(__dirname, '..', 'data', 'bond-state.json');
    this.trader = new FuturesTrader(apiKey, apiSecret);
    this._loadState();
    this._log('BondEngine v96 初始化 — PIMCO/Bridgewater模式');
  }

  async start() {
    this._log('🚀 Bond Engine 启动');
    await this._loadKlines();
    await this._updateRateState();
    this._interval = setInterval(() => this._tick(), 60000); // 60秒
  }

  stop() {
    if (this._interval) clearInterval(this._interval);
    this._log('Bond Engine 停止');
  }

  async _tick() {
    try {
      await this._updateRateState();
      await this._updatePrices();
      const signals = this._generateSignals();
      await this._executeTrades(signals);
      this._managePositions();
      this._saveState();
    } catch (e) {
      this._log(`❌ Tick错误: ${e.message}`);
    }
  }

  /**
   * 更新利率环境状态
   */
  async _updateRateState() {
    try {
      // DXY (美元指数代理)
      const eurTicker = await this._fetchTicker('EURUSDT');
      if (eurTicker) {
        const eurChange = parseFloat(eurTicker.priceChangePercent);
        this.rateState.dxy = 100 - eurChange * 10;
      }

      // VIX (恐慌指数代理)
      const btcTicker = await this._fetchTicker('BTCUSDT');
      if (btcTicker) {
        const btcVol = Math.abs(parseFloat(btcTicker.priceChangePercent)) * 3;
        this.rateState.vix = Math.min(80, Math.max(10, 15 + btcVol));
      }

      // 利率预期推断
      if (this.rateState.vix > 30) {
        this.rateState.expectedChange = -0.25; // 恐慌 → 降息预期
      } else if (this.rateState.inflationExpection > 4) {
        this.rateState.expectedChange = 0.25; // 高通胀 → 加息预期
      } else {
        this.rateState.expectedChange = 0;
      }

      // 收益率曲线判断
      if (this.rateState.expectedChange < 0) {
        this.rateState.yieldCurve = 'normal'; // 降息 → 曲线变陡
      } else if (this.rateState.expectedChange > 0) {
        this.rateState.yieldCurve = 'inverted'; // 加息 → 曲线倒挂
      } else {
        this.rateState.yieldCurve = 'flat';
      }

      this._log(`📊 利率状态: rate=${this.rateState.currentRate}% curve=${this.rateState.yieldCurve} dxy=${this.rateState.dxy.toFixed(1)} vix=${this.rateState.vix.toFixed(1)}`);
    } catch (e) {}
  }

  async _loadKlines() {
    for (const item of this.symbols) {
      try {
        const klines = await this._fetchKlines(item.symbol, '4h', 100);
        this.state.klines[item.symbol] = klines;
      } catch (e) {}
    }
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

      // 1. 利率周期策略
      const rateSignal = this._rateCycleStrategy(closes, item);
      if (rateSignal) signals.push(rateSignal);

      // 2. 收益率曲线策略
      const curveSignal = this._yieldCurveStrategy(closes, item);
      if (curveSignal) signals.push(curveSignal);

      // 3. 通胀挂钩策略
      const infSignal = this._inflationLinkedStrategy(closes, item);
      if (infSignal) signals.push(infSignal);
    }

    return this._fuseSignals(signals);
  }

  /**
   * 利率周期策略 (PIMCO风格)
   * 降息周期 → 做多利率敏感资产
   * 加息周期 → 做空利率敏感资产
   */
  _rateCycleStrategy(closes, item) {
    const current = closes[closes.length - 1];
    const ma50 = this._sma(closes, 50);
    const ma20 = this._sma(closes, 20);

    // 利率敏感度加权
    const sensitivity = item.rateSensitivity;

    if (this.rateState.expectedChange < 0 && ma20 > ma50 && current > ma20) {
      // 降息预期 + 上升趋势 → 做多
      return {
        symbol: item.symbol,
        direction: 'LONG',
        confidence: 0.65 * sensitivity,
        strategy: 'rateCycle',
        desc: `降息周期做多 ${item.name}`,
      };
    } else if (this.rateState.expectedChange > 0 && ma20 < ma50 && current < ma20) {
      // 加息预期 + 下降趋势 → 做空
      return {
        symbol: item.symbol,
        direction: 'SHORT',
        confidence: 0.65 * sensitivity,
        strategy: 'rateCycle',
        desc: `加息周期做空 ${item.name}`,
      };
    }
    return null;
  }

  /**
   * 收益率曲线策略 (Two Sigma风格)
   */
  _yieldCurveStrategy(closes, item) {
    if (closes.length < 60) return null;
    const current = closes[closes.length - 1];
    const ma20 = this._sma(closes, 20);
    const ma60 = this._sma(closes, 60);

    if (this.rateState.yieldCurve === 'normal') {
      // 正常曲线 → 做多风险资产
      if (current > ma20 && ma20 > ma60) {
        return {
          symbol: item.symbol,
          direction: 'LONG',
          confidence: 0.55,
          strategy: 'yieldCurve',
          desc: `正常曲线做多 ${item.name}`,
        };
      }
    } else if (this.rateState.yieldCurve === 'inverted') {
      // 倒挂曲线 → 做空/防御
      if (current < ma20 && ma20 < ma60) {
        return {
          symbol: item.symbol,
          direction: 'SHORT',
          confidence: 0.55,
          strategy: 'yieldCurve',
          desc: `倒挂曲线做空 ${item.name}`,
        };
      }
    }
    return null;
  }

  /**
   * 通胀挂钩策略 (Bridgewater风格)
   */
  _inflationLinkedStrategy(closes, item) {
    if (closes.length < 30) return null;
    const current = closes[closes.length - 1];
    const ma30 = this._sma(closes, 30);
    const deviation = (current - ma30) / ma30 * 100;

    // 高通胀环境
    if (this.rateState.inflationExpection > 4) {
      // 做多实物资产(黄金/商品)，做空债券
      if (item.symbol === 'PAXGUSDT' && deviation < -2) {
        return {
          symbol: item.symbol,
          direction: 'LONG',
          confidence: 0.60,
          strategy: 'inflationLinked',
          desc: '高通胀做多实物',
        };
      }
    }
    return null;
  }

  _fuseSignals(signals) {
    const grouped = {};
    for (const s of signals) {
      const key = `${s.symbol}_${s.direction}`;
      if (!grouped[key]) grouped[key] = { ...s, votes: 0, totalConf: 0 };
      grouped[key].votes++;
      grouped[key].totalConf += s.confidence;
    }
    return Object.values(grouped)
      .filter(g => g.votes >= 2 || g.totalConf > 0.55)
      .map(g => ({
        ...g,
        confidence: g.totalConf / g.votes,
        strength: g.votes >= 2 ? 'medium' : 'weak',
      }));
  }

  async _executeTrades(signals) {
    for (const sig of signals) {
      if (sig.strength === 'weak') continue;
      if (this.state.positions[sig.symbol]) continue;

      const notionalUsd = 50;
      const entryPrice = parseFloat((await this._fetchTicker(sig.symbol))?.lastPrice || 0);
      if (!entryPrice) continue;
      const qty = parseFloat((notionalUsd / entryPrice).toFixed(6));
      this._log(`📊 ${sig.strategy}: ${sig.symbol} ${sig.direction} conf=${(sig.confidence*100).toFixed(0)}%`);
      
      // v108: 真实下单
      let orderResult = null;
      try {
        if (sig.direction === 'LONG') {
          orderResult = await this.trader.marketLong(sig.symbol, qty);
        } else {
          orderResult = await this.trader.marketShort(sig.symbol, qty);
        }
      } catch (e) {
        this._log(`❌ BOND下单失败: ${sig.symbol} ${sig.direction} ${e.message}`);
        continue;
      }

      this.state.positions[sig.symbol] = {
        direction: sig.direction,
        entryPrice,
        qty,
        notionalUsd,
        strategy: sig.strategy,
        entryTime: Date.now(),
        orderId: orderResult?.orderId,
        stopLoss: sig.direction === 'LONG' ? 0.97 : 1.03,
        takeProfit: sig.direction === 'LONG' ? 1.04 : 0.96,
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
        ? (currentPrice - pos.entryPrice) / pos.entryPrice
        : (pos.entryPrice - currentPrice) / pos.entryPrice;

      const sl = pos.direction === 'LONG' ? pos.stopLoss : (2 - pos.stopLoss);
      const tp = pos.direction === 'LONG' ? pos.takeProfit : (2 - pos.takeProfit);

      if (pos.direction === 'LONG' && currentPrice / pos.entryPrice <= sl) {
        this._log(`🛑 Bond止损 ${sym}: ${(pnlPct*100).toFixed(2)}%`);
        await this._closePosition(sym, pos);
        this.state.dailyPnl += pos.notionalUsd * pnlPct;
      } else if (pos.direction === 'LONG' && currentPrice / pos.entryPrice >= tp) {
        this._log(`🎯 Bond止盈 ${sym}: +${(pnlPct*100).toFixed(2)}%`);
        await this._closePosition(sym, pos);
        this.state.dailyPnl += pos.notionalUsd * pnlPct;
      } else if (pos.direction === 'SHORT' && pos.entryPrice / currentPrice <= sl) {
        this._log(`🛑 Bond止损 ${sym}: ${(pnlPct*100).toFixed(2)}%`);
        await this._closePosition(sym, pos);
        this.state.dailyPnl += pos.notionalUsd * pnlPct;
      } else if (pos.direction === 'SHORT' && pos.entryPrice / currentPrice >= tp) {
        this._log(`🎯 Bond止盈 ${sym}: +${(pnlPct*100).toFixed(2)}%`);
        await this._closePosition(sym, pos);
        this.state.dailyPnl += pos.notionalUsd * pnlPct;
      }
    }
  }

  // v108: 真实平仓
  async _closePosition(symbol, pos) {
    try {
      if (pos.direction === 'LONG') await this.trader.closeLong(symbol, pos.qty);
      else await this.trader.closeShort(symbol, pos.qty);
      this._log(`✅ ${symbol} Bond平仓成功`);
    } catch (e) { this._log(`❌ ${symbol} Bond平仓失败: ${e.message}`); }
    delete this.state.positions[symbol];
  }

  _sma(data, period) {
    if (data.length < period) return data[data.length - 1];
    return data.slice(-period).reduce((s, c) => s + c, 0) / period;
  }

  _fetchKlines(symbol, interval, limit) {
    return new Promise((resolve) => {
      https.get(`${this.baseURL}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data).map(k => ({
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

module.exports = BondEngine;
