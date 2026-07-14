/**
 * Symbol Engine v108.3 — 单品种独立引擎
 * 
 * 每个品种一个实例，独立运行策略、独立下单、独立风控
 * 品种内的币种可自由配置，支持手动买卖
 * 
 * 用法：
 *   const engine = new SymbolEngine({
 *     name: 'TSLA',
 *     category: 'stock',
 *     symbols: ['TSLAUSDT'],
 *     market: 'futures',  // futures | spot
 *     apiKey, apiSecret,
 *     strategies: { ... },  // 可选，默认内置
 *   });
 *   await engine.start();
 *   engine.manualTrade('TSLAUSDT', 'LONG', 100);  // 手动开多
 *   engine.manualClose('TSLAUSDT');                // 手动平仓
 *   engine.addSymbol('NVDAUSDT');                   // 动态加币种
 *   engine.removeSymbol('TSLAUSDT');                // 动态删币种
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const FuturesTrader = require('./futures-trader');
const SpotTrader = require('./spot-trader');
const signalPool = require('./signal-pool');

class SymbolEngine {
  constructor(config) {
    this.name = config.name || 'UNKNOWN';
    this.category = config.category || 'crypto';
    this.market = config.market || 'futures';
    this.apiKey = config.apiKey || '';
    this.apiSecret = config.apiSecret || '';
    this.symbols = config.symbols || [];
    
    // 交易器
    if (this.market === 'futures') {
      this.trader = new FuturesTrader(this.apiKey, this.apiSecret);
    } else {
      this.trader = new SpotTrader(this.apiKey, this.apiSecret);
    }
    
    // 行情数据
    this.prices = {};        // {symbol: {lastPrice, change24h, volume, high, low}}
    this.klines = {};        // {symbol: [{open,high,low,close,volume,time}]}
    
    // 持仓状态
    this.positions = {};      // {symbol: {direction, entryPrice, qty, notionalUsd, ...}}
    this._openedSymbols = {}; // v113.11: 开仓冷却
    this.positions = {};     // {symbol: {direction, entryPrice, qty, entryTime, stopLoss, takeProfit, strategy}}
    
    // 引擎状态
    this.equity = config.equity || 50;
    this.state = {
      equity: this.equity,
      pnl: 0,
      dailyTrades: 0,
      maxDailyTrades: config.maxDailyTrades || 5,
      lastTradeTime: {},
    };
    
    // 风控参数
    this.risk = {
      maxPositionPct: config.maxPositionPct || 30,    // 单笔占权益比例
      stopLossPct: config.stopLossPct || 3,            // 止损百分比
      takeProfitPct: config.takeProfitPct || 5,        // 止盈百分比
      maxHoldHours: config.maxHoldHours || 72,         // 最大持仓时间
      minSignalConf: config.minSignalConf || 0.5,      // 最低信号置信度
    };
    
    // 策略配置
    this.strategies = config.strategies || {
      trendFollow: { name: '趋势跟踪', weight: 0.30, fast: 5, slow: 20 },
      meanReversion: { name: '均值回归', weight: 0.25, lookback: 20, zEntry: 2.0 },
      momentum: { name: '动量突破', weight: 0.25, lookback: 10, threshold: 0.5 },
      rsi: { name: 'RSI指标', weight: 0.20, period: 14, oversold: 30, overbought: 70 },
    };
    
    // 日志
    this.logFile = path.join(__dirname, '..', 'logs', `symbol-${this.name}.log`);
    this._interval = null;
    this._log(`${this.name} 引擎初始化 | 市场=${this.market} | 标的=${this.symbols.length}个`);
  }

  // ═══ 生命周期 ═══

  async start() {
    this._log(`🚀 ${this.name} 引擎启动`);
    await this._fetchAllData();
    
    // v113.13.5: 错开子引擎启动时间 — 避免同时突发请求
    this._startDelay = Math.floor(Math.random() * 15000); // 0-15秒随机延迟
    setTimeout(() => {
      this._interval = setInterval(async () => {
        try { await this._tick(); }
        catch (e) { this._log(`❌ ${this.name} tick错误: ${e.message}`); }
      }, 60000); // v113.13.5: 30s→60s 降低请求频率
      this._log(`⏰ ${this.name} 定时器已启动 (间隔60s, 延迟${this._startDelay}ms)`);
    }, this._startDelay);
  }

  async stop() {
    if (this._interval) clearInterval(this._interval);
    this._log(`${this.name} 引擎停止`);
  }

  // ═══ 核心 Tick 循环 ═══

  async _tick() {
    // v113.53: 检查 AutoFixer 暂停状态
    if (this._paused) return;
    
    await this._fetchAllData();
    await this._checkPositions();
    this._scanSignals();
    this._saveState();
  }

  // ═══ 行情获取 ═══

  async _fetchAllData() {
    for (const symbol of this.symbols) {
      try {
        await this._fetchTicker(symbol);
        await this._fetchKlines(symbol);
      } catch (e) {}
    }
  }

  _fetchTicker(symbol) {
    const { globalLimiter } = require('./rate-limiter');
    const base = this.market === 'futures' ? 'https://fapi.binance.com/fapi/v1' : 'https://api.binance.com/api/v3';
    const url = `${base}/ticker/24hr?symbol=${symbol}`;
    return globalLimiter.schedule(1, () => new Promise((resolve) => {
      https.get(url, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const t = JSON.parse(d);
            this.prices[symbol] = {
              lastPrice: parseFloat(t.lastPrice),
              change24h: parseFloat(t.priceChangePercent),
              volume: parseFloat(t.quoteVolume),
              high: parseFloat(t.highPrice),
              low: parseFloat(t.lowPrice),
            };
          } catch (e) {}
          resolve();
        });
      }).on('error', () => resolve());
    }));
  }

  _fetchKlines(symbol) {
    const { globalLimiter } = require('./rate-limiter');
    const base = this.market === 'futures' ? 'https://fapi.binance.com/fapi/v1' : 'https://api.binance.com/api/v3';
    const url = `${base}/klines?symbol=${symbol}&interval=5m&limit=100`;
    return globalLimiter.schedule(2, () => new Promise((resolve) => {
      https.get(url, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const raw = JSON.parse(d);
            this.klines[symbol] = raw.map(k => ({
              open: parseFloat(k[1]), high: parseFloat(k[2]),
              low: parseFloat(k[3]), close: parseFloat(k[4]),
              volume: parseFloat(k[5]), time: k[0],
            }));
          } catch (e) {}
          resolve();
        });
      }).on('error', () => resolve());
    }));
  }

  // ═══ 策略信号 ═══

  _scanSignals() {
    this._poolSignals = [];
    for (const symbol of this.symbols) {
      if (this.positions[symbol]) continue;
      if (this.state.dailyTrades >= this.state.maxDailyTrades) break;
      
      const klines = this.klines[symbol];
      if (!klines || klines.length < 30) continue;
      
      // v113.11: 冷却检查 — 防止疯狂重复下单
      if (!this._openedSymbols) this._openedSymbols = {};
      if (this._openedSymbols[symbol] && Date.now() - this._openedSymbols[symbol] < 30 * 60 * 1000) continue;
      // 已持仓的symbol不再开仓
      if (this._hasPosition && this._hasPosition(symbol)) continue;
      
      const signals = this._runStrategies(symbol, klines);
      if (signals.length === 0) continue;
      
      // v113.53: 现货只保留做多信号（做空信号对现货无意义）
      let _signals = signals;
      if (this.market === 'spot') {
        _signals = signals.filter(s => s.direction === 'LONG');
        if (_signals.length === 0) continue;
      }
      
      // 加权平均置信度
      const totalWeight = _signals.reduce((s, sig) => s + sig.weight, 0);
      const avgConf = _signals.reduce((s, sig) => s + sig.confidence * sig.weight, 0) / totalWeight;
      
      // v113.53: 降低现货置信度门槛 0.5→0.35 (现货无杠杆风险更低)
      const minConf = this.market === 'spot' ? 0.35 : this.risk.minSignalConf;
      if (avgConf < minConf) continue;
      
      // 多数投票决定方向
      const longVotes = _signals.filter(s => s.direction === 'LONG').length;
      const shortVotes = _signals.filter(s => s.direction === 'SHORT').length;
      
      let direction = null;
      // v113.53: 现货只需1票做多即可（已过滤做空信号）
      const minVotes = this.market === 'spot' ? 1 : 2;
      if (longVotes > shortVotes && longVotes >= minVotes) direction = 'LONG';
      else if (shortVotes > longVotes && shortVotes >= minVotes) direction = 'SHORT';
      if (!direction) continue;
      
      // 现货不能做空
      if (this.market === 'spot' && direction === 'SHORT') continue;
      
      this._log(`📊 ${this.name} 候选: ${symbol} ${direction} conf=${avgConf.toFixed(2)} votes=${longVotes}L/${shortVotes}S ${_signals.map(s=>s.desc).join(', ')}`);
      
      // v112.5: 写入统一信号池
      this._poolSignals.push({
        symbol, dir: direction, strength: avgConf * 4, confidence: avgConf,
        score: avgConf, market: this.category || this.name, source: this.name, timestamp: Date.now(),
      });
      
      this._openPosition(symbol, direction, avgConf, _signals);
    }
    // v112.5: 把本引擎信号写入统一信号池
    if (this._poolSignals.length > 0) signalPool.collect(this._poolSignals);
  }

  _runStrategies(symbol, klines) {
    const closes = klines.map(k => k.close);
    const signals = [];
    
    // 策略1: 趋势跟踪 (MA交叉)
    const s1 = this._trendSignal(closes);
    if (s1) signals.push(s1);
    
    // 策略2: 均值回归 (Z-score)
    const s2 = this._meanReversionSignal(closes);
    if (s2) signals.push(s2);
    
    // 策略3: 动量突破
    const s3 = this._momentumSignal(closes);
    if (s3) signals.push(s3);
    
    // 策略4: RSI
    const s4 = this._rsiSignal(closes);
    if (s4) signals.push(s4);
    
    return signals;
  }

  _trendSignal(closes) {
    const fast = this.strategies.trendFollow?.fast || 5;
    const slow = this.strategies.trendFollow?.slow || 20;
    if (closes.length < slow + 1) return null;
    
    const fastMA = this._sma(closes.slice(-fast), fast);
    const slowMA = this._sma(closes.slice(-slow), slow);
    const prevFastMA = this._sma(closes.slice(-fast-1, -1), fast);
    const prevSlowMA = this._sma(closes.slice(-slow-1, -1), slow);
    
    if (prevFastMA <= prevSlowMA && fastMA > slowMA) {
      return { strategy: 'trendFollow', direction: 'LONG', confidence: 0.6, weight: 0.30, desc: 'MA金叉' };
    }
    if (prevFastMA >= prevSlowMA && fastMA < slowMA) {
      return { strategy: 'trendFollow', direction: 'SHORT', confidence: 0.6, weight: 0.30, desc: 'MA死叉' };
    }
    if (fastMA > slowMA) {
      return { strategy: 'trendFollow', direction: 'LONG', confidence: 0.50, weight: 0.30, desc: 'MA多头排列' };
    }
    if (fastMA < slowMA) {
      return { strategy: 'trendFollow', direction: 'SHORT', confidence: 0.50, weight: 0.30, desc: 'MA空头排列' };
    }
    return null;
  }

  _meanReversionSignal(closes) {
    const lookback = this.strategies.meanReversion?.lookback || 20;
    if (closes.length < lookback) return null;
    
    const slice = closes.slice(-lookback);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const std = Math.sqrt(slice.reduce((s, c) => s + (c - mean) ** 2, 0) / slice.length);
    if (std === 0) return null;
    
    const z = (closes[closes.length - 1] - mean) / std;
    const zEntry = this.strategies.meanReversion?.zEntry || 2.0;
    
    if (z < -zEntry) return { strategy: 'meanReversion', direction: 'LONG', confidence: 0.55, weight: 0.25, desc: `Z=${z.toFixed(2)} 超卖` };
    if (z > zEntry) return { strategy: 'meanReversion', direction: 'SHORT', confidence: 0.55, weight: 0.25, desc: `Z=${z.toFixed(2)} 超买` };
    return null;
  }

  _momentumSignal(closes) {
    const lookback = this.strategies.momentum?.lookback || 10;
    if (closes.length < lookback + 1) return null;
    
    const momentum = (closes[closes.length - 1] - closes[closes.length - 1 - lookback]) / closes[closes.length - 1 - lookback] * 100;
    const threshold = this.strategies.momentum?.threshold || 0.5;
    
    if (momentum > threshold) return { strategy: 'momentum', direction: 'LONG', confidence: 0.5, weight: 0.25, desc: `动量+${momentum.toFixed(2)}%` };
    if (momentum < -threshold) return { strategy: 'momentum', direction: 'SHORT', confidence: 0.5, weight: 0.25, desc: `动量${momentum.toFixed(2)}%` };
    return null;
  }

  _rsiSignal(closes) {
    const period = this.strategies.rsi?.period || 14;
    if (closes.length < period + 1) return null;
    
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff > 0) gains += diff; else losses -= diff;
    }
    const rs = gains / (losses || 1);
    const rsi = 100 - 100 / (1 + rs);
    const oversold = this.strategies.rsi?.oversold || 30;
    const overbought = this.strategies.rsi?.overbought || 70;
    
    if (rsi < oversold) return { strategy: 'rsi', direction: 'LONG', confidence: 0.5, weight: 0.20, desc: `RSI=${rsi.toFixed(1)} 超卖` };
    if (rsi > overbought) return { strategy: 'rsi', direction: 'SHORT', confidence: 0.5, weight: 0.20, desc: `RSI=${rsi.toFixed(1)} 超买` };
    return null;
  }

  // ═══ 下单执行 ═══

  async _openPosition(symbol, direction, confidence, signals) {
    const price = this.prices[symbol]?.lastPrice;
    if (!price) return;
    
    // v113.11: 防重复下单 — 已有持仓或冷却中则跳过
    if (this.positions[symbol]) return;
    if (!this._openedSymbols) this._openedSymbols = {};
    if (this._openedSymbols[symbol] && Date.now() - this._openedSymbols[symbol] < 30 * 60 * 1000) return;
    
    // v113.53: 下单前检查可用余额，避免不必要的API调用
    let _availBal = 0;
    try {
      const bal = this.market === 'futures' 
        ? await this.trader.getBalance()
        : await this.trader.getBalance();
      _availBal = bal?.usdt || 0;
    } catch(e) {}
    
    const positionSize = Math.min(this.state.equity * (this.risk.maxPositionPct / 100), _availBal * 0.95);
    if (positionSize < 5) {
      this._log(`⏭️ ${this.name} 跳过: 可用USDT=\$${_availBal.toFixed(2)} 不足下单 (需≥\$5)`);
      this._openedSymbols[symbol] = Date.now(); // 标记已尝试,30分钟冷却
      return;
    }
    
    // v113.59: 保证金<$5不开仓, 避免小仓被手续费吃掉 + 占用持仓名额
    const leverage = 3; // 子引擎统一用3x杠杆
    const marginRequired = positionSize / leverage; // 保证金 = 名义值/杠杆
    if (marginRequired < 5) {
      const _qty = positionSize / price;
      this._log(`⏭️ ${this.name} 跳过: 保证金=$${marginRequired.toFixed(2)} < $5 (size=$${positionSize.toFixed(2)} qty=${_qty.toFixed(4)} price=$${price} lev=${leverage}x)`);
      this._openedSymbols[symbol] = Date.now(); // 标记已尝试,30分钟冷却
      return;
    }
    
    this._openedSymbols[symbol] = Date.now();
    const qty = positionSize / price;
    
    let orderResult = null;
    try {
      if (this.market === 'futures') {
        if (direction === 'LONG') orderResult = await this.trader.marketLong(symbol, qty, leverage);
        else orderResult = await this.trader.marketShort(symbol, qty, leverage);
      } else {
        if (direction === 'LONG') orderResult = await this.trader.marketBuy(symbol, qty);
        else return; // 现货不能做空
      }
    } catch (e) {
      this._log(`❌ ${this.name}下单失败: ${symbol} ${direction} ${e.message}`);
      return;
    }
    
    this._log(`📈 ${this.name}开仓: ${direction} ${symbol} @ $${price} | conf=${confidence.toFixed(2)} | ${signals.map(s=>s.desc).join(', ')}`);
    
    this.positions[symbol] = {
      symbol, direction, entryPrice: price, qty,
      notionalUsd: positionSize,
      entryTime: Date.now(),
      confidence,
      strategies: signals.map(s => s.strategy),
      orderId: orderResult?.orderId,
      stopLoss: direction === 'LONG' ? price * (1 - this.risk.stopLossPct / 100) : price * (1 + this.risk.stopLossPct / 100),
      takeProfit: direction === 'LONG' ? price * (1 + this.risk.takeProfitPct / 100) : price * (1 - this.risk.takeProfitPct / 100),
    };
    
    this.state.dailyTrades++;
    this.state.lastTradeTime[symbol] = Date.now();
  }

  async _checkPositions() {
    for (const [symbol, pos] of Object.entries(this.positions)) {
      const currentPrice = this.prices[symbol]?.lastPrice;
      if (!currentPrice) continue;
      
      const pnlPct = pos.direction === 'LONG'
        ? (currentPrice - pos.entryPrice) / pos.entryPrice * 100
        : (pos.entryPrice - currentPrice) / pos.entryPrice * 100;
      
      // 止损
      if (pnlPct < -this.risk.stopLossPct) {
        this._log(`🛑 ${this.name}止损: ${symbol} ${pos.direction} PnL=${pnlPct.toFixed(2)}%`);
        await this._closePosition(symbol, pos);
        this.state.pnl += pos.notionalUsd * pnlPct / 100;
      }
      // 止盈
      else if (pnlPct > this.risk.takeProfitPct) {
        this._log(`💰 ${this.name}止盈: ${symbol} ${pos.direction} PnL=+${pnlPct.toFixed(2)}%`);
        await this._closePosition(symbol, pos);
        this.state.pnl += pos.notionalUsd * pnlPct / 100;
      }
      // 超时
      else if (Date.now() - pos.entryTime > this.risk.maxHoldHours * 3600000) {
        this._log(`⏰ ${this.name}超时平仓: ${symbol} PnL=${pnlPct.toFixed(2)}%`);
        await this._closePosition(symbol, pos);
        this.state.pnl += pos.notionalUsd * pnlPct / 100;
      }
    }
  }

  async _closePosition(symbol, pos) {
    try {
      if (this.market === 'futures') {
        if (pos.direction === 'LONG') await this.trader.closeLong(symbol, pos.qty);
        else await this.trader.closeShort(symbol, pos.qty);
      } else {
        if (pos.direction === 'LONG') await this.trader.marketSell(symbol, pos.qty);
        else await this.trader.marketBuy(symbol, pos.qty);
      }
      this._log(`✅ ${symbol} 平仓成功`);
      delete this.positions[symbol];
    } catch (e) {
      // v113.71: ReduceOnly rejected = Binance上已无此仓位, 本地状态过期
      if (e.message && e.message.includes('-2022')) {
        this._log(`✅ ${symbol} 平仓完成 — ReduceOnly rejected 说明链上已无仓位, 清除本地状态`);
        delete this.positions[symbol];
        return;
      }
      // v113.71: 其他API错误也可能是仓位已不存在
      if (e.message && (e.message.includes('position does not exist') || e.message.includes('position size'))) {
        this._log(`✅ ${symbol} 平仓完成 — 仓位已不存在, 清除本地状态`);
        delete this.positions[symbol];
        return;
      }
      // v123: insufficient balance(-2010) 说明现货没有足够的币卖出, 仓位是虚假的, 清除
      if (e.message && (e.message.includes('-2010') || e.message.includes('insufficient balance'))) {
        this._log(`✅ ${symbol} 平仓完成 — 余额不足说明仓位已不存在, 清除本地状态`);
        delete this.positions[symbol];
        return;
      }
      this._log(`❌ ${symbol} 平仓失败: ${e.message}, 保留持仓继续监控`);
      // v113.59: 平仓失败不删除持仓, 下次继续尝试
    }
  }

  // ═══ 手动交易接口 ═══

  async manualTrade(symbol, direction, usdtAmount) {
    if (!this.symbols.includes(symbol)) {
      this._log(`⚠️ ${symbol} 不在 ${this.name} 引擎的标的中`);
      return { success: false, error: 'symbol not in engine' };
    }
    
    const price = this.prices[symbol]?.lastPrice;
    if (!price) {
      this._log(`⚠️ ${symbol} 无行情数据`);
      return { success: false, error: 'no price data' };
    }
    
    const qty = usdtAmount / price;
    
    // 如果已有仓位，先平
    if (this.positions[symbol]) {
      await this._closePosition(symbol, this.positions[symbol]);
    }
    
    let orderResult = null;
    try {
      if (this.market === 'futures') {
        if (direction === 'LONG') orderResult = await this.trader.marketLong(symbol, qty, 3);
        else orderResult = await this.trader.marketShort(symbol, qty, 3);
      } else {
        if (direction === 'LONG') orderResult = await this.trader.marketBuy(symbol, qty);
        else { this._log('现货不支持做空'); return { success: false, error: 'spot cant short' }; }
      }
    } catch (e) {
      this._log(`❌ 手动下单失败: ${symbol} ${direction} ${e.message}`);
      return { success: false, error: e.message };
    }
    
    this._log(`📝 ${this.name}手动开仓: ${direction} ${symbol} @ $${price} qty=${qty} | orderId=${orderResult?.orderId}`);
    
    this.positions[symbol] = {
      symbol, direction, entryPrice: price, qty,
      notionalUsd: usdtAmount,
      entryTime: Date.now(),
      confidence: 1.0,
      strategies: ['manual'],
      orderId: orderResult?.orderId,
      stopLoss: direction === 'LONG' ? price * (1 - this.risk.stopLossPct / 100) : price * (1 + this.risk.stopLossPct / 100),
      takeProfit: direction === 'LONG' ? price * (1 + this.risk.takeProfitPct / 100) : price * (1 - this.risk.takeProfitPct / 100),
    };
    
    return { success: true, orderId: orderResult?.orderId, entryPrice: price, qty };
  }

  async manualClose(symbol) {
    const pos = this.positions[symbol];
    if (!pos) {
      this._log(`⚠️ ${symbol} 无持仓`);
      return { success: false, error: 'no position' };
    }
    
    const currentPrice = this.prices[symbol]?.lastPrice || pos.entryPrice;
    const pnlPct = pos.direction === 'LONG'
      ? (currentPrice - pos.entryPrice) / pos.entryPrice * 100
      : (pos.entryPrice - currentPrice) / pos.entryPrice * 100;
    
    this._log(`📝 ${this.name}手动平仓: ${symbol} PnL=${pnlPct.toFixed(2)}%`);
    await this._closePosition(symbol, pos);
    this.state.pnl += pos.notionalUsd * pnlPct / 100;
    
    return { success: true, pnlPct };
  }

  // ═══ 动态管理标的 ═══

  addSymbol(symbol) {
    if (!this.symbols.includes(symbol)) {
      this.symbols.push(symbol);
      this._log(`➕ ${this.name} 添加标的: ${symbol}`);
      return true;
    }
    return false;
  }

  removeSymbol(symbol) {
    const idx = this.symbols.indexOf(symbol);
    if (idx >= 0) {
      // 如果有持仓，不平仓但停止监控
      this.symbols.splice(idx, 1);
      this._log(`➖ ${this.name} 移除标的: ${symbol} (已有持仓不受影响)`);
      return true;
    }
    return false;
  }

  // ═══ 状态查询 ═══

  getStatus() {
    const positions = Object.entries(this.positions).map(([symbol, pos]) => {
      const currentPrice = this.prices[symbol]?.lastPrice || pos.entryPrice;
      const pnlPct = pos.direction === 'LONG'
        ? (currentPrice - pos.entryPrice) / pos.entryPrice * 100
        : (pos.entryPrice - currentPrice) / pos.entryPrice * 100;
      return { symbol, ...pos, currentPrice, pnlPct };
    });
    
    return {
      name: this.name,
      category: this.category,
      market: this.market,
      symbols: this.symbols,
      positions,
      equity: this.state.equity,
      pnl: this.state.pnl,
      dailyTrades: this.state.dailyTrades,
      prices: this.prices,
    };
  }

  // ═══ 工具方法 ═══

  _sma(data, period) {
    if (data.length < period) return data[data.length - 1] || 0;
    return data.slice(-period).reduce((s, c) => s + c, 0) / period;
  }

  _saveState() {
    try {
      const stateFile = path.join(__dirname, '..', 'data', `symbol-${this.name}-state.json`);
      const state = {
        positions: this.positions,
        state: this.state,
        symbols: this.symbols,
      };
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    } catch (e) {}
  }

  _loadState() {
    try {
      const stateFile = path.join(__dirname, '..', 'data', `symbol-${this.name}-state.json`);
      if (fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        this.positions = state.positions || {};
        this.state = { ...this.state, ...state.state };
        if (state.symbols) this.symbols = state.symbols;
        this._log(`📂 ${this.name} 状态恢复: ${Object.keys(this.positions).length}个持仓`);
      }
    } catch (e) {}
  }

  _log(msg) {
    const line = `[${new Date().toISOString()}] [${this.name}] ${msg}`;
    console.log(line);
    try {
      const dir = path.dirname(this.logFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.logFile, line + '\n');
    } catch (e) {}
  }
}

module.exports = SymbolEngine;
