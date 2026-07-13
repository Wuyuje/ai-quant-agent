/**
 * v66: 限价单做市策略
 * 
 * 订单簿分析 + 动态价差 + 库存管理
 * 1. 订单簿失衡检测
 * 2. 波动率自适应价差
 * 3. 库存偏移报价
 * 4. 撤单/改单逻辑
 * 5. PnL追踪 (价差捕获 + 库存盈亏)
 */

class MarketMaker {
  constructor(config = {}) {
    this.baseSpreadPct = config.baseSpreadPct || 0.08;     // 基础价差 0.08%
    this.maxSpreadPct = config.maxSpreadPct || 0.5;        // 最大价差 0.5%
    this.volatilityMultiplier = config.volatilityMultiplier || 1.5;
    this.maxInventory = config.maxInventory || 5000;        // 最大库存 $5000
    this.inventoryRiskLimit = config.inventoryRiskLimit || 0.3; // 30%资金
    this.minRequoteIntervalMs = config.minRequoteIntervalMs || 2000;
    this.minPriceMovePct = config.minPriceMovePct || 0.02;
    this.maxOrderAgeMs = config.maxOrderAgeMs || 5000;
    this.maxDrawdownPct = config.maxDrawdownPct || 5;      // 最大回撤 5%
    this.orderSize = config.orderSize || 100;               // 默认下单大小

    // 状态
    this._quotes = {};        // {symbol: {bidPrice, askPrice, bidSize, askSize, time}}
    this._inventory = {};     // {symbol: {netPosition, avgEntryPrice, notional}}
    this._fills = [];         // 成交记录
    this._realizedPnl = 0;
    this._feesPaid = 0;
    this._feeRate = config.feeRate || 0.0004; // 0.04% taker fee
    this._makerFeeRate = config.makerFeeRate || 0.0002; // 0.02% maker fee
    this._peakPnl = 0;
    this._maxDrawdown = 0;
    this._quoteCount = 0;
    this._fillCount = 0;
  }

  // ═══════════════════════════════════════════
  // 订单簿分析
  // ═══════════════════════════════════════════
  analyzeOrderBook(bids, asks, depth = 10) {
    if (!bids?.length || !asks?.length) return null;

    const bidSlice = bids.slice(0, depth);
    const askSlice = asks.slice(0, depth);

    const bestBid = parseFloat(bidSlice[0][0]);
    const bestAsk = parseFloat(askSlice[0][0]);
    const midPrice = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;
    const spreadPct = midPrice > 0 ? (spread / midPrice) * 100 : 0;

    // 成交量
    let bidVolume = 0, askVolume = 0;
    let bidNotional = 0, askNotional = 0;
    for (const [price, qty] of bidSlice) {
      const p = parseFloat(price), q = parseFloat(qty);
      bidVolume += q; bidNotional += p * q;
    }
    for (const [price, qty] of askSlice) {
      const p = parseFloat(price), q = parseFloat(qty);
      askVolume += q; askNotional += p * q;
    }

    const totalVolume = bidVolume + askVolume;
    const imbalance = totalVolume > 0 ? (bidVolume - askVolume) / totalVolume : 0;

    // 加权深度 (距中价越远权重越低)
    let weightedBidDepth = 0, weightedAskDepth = 0;
    for (const [price, qty] of bidSlice) {
      const p = parseFloat(price);
      const dist = midPrice > 0 ? Math.abs(midPrice - p) / midPrice : 1;
      weightedBidDepth += parseFloat(qty) * Math.exp(-dist * 10);
    }
    for (const [price, qty] of askSlice) {
      const p = parseFloat(price);
      const dist = midPrice > 0 ? Math.abs(midPrice - p) / midPrice : 1;
      weightedAskDepth += parseFloat(qty) * Math.exp(-dist * 10);
    }

    // 流动性墙检测
    const avgBidQty = depth > 0 ? bidVolume / depth : 0;
    const avgAskQty = depth > 0 ? askVolume / depth : 0;
    const bidWalls = bidSlice.filter(([, q]) => parseFloat(q) > avgBidQty * 3).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));
    const askWalls = askSlice.filter(([, q]) => parseFloat(q) > avgAskQty * 3).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));

    return {
      midPrice,
      bestBid,
      bestAsk,
      spread,
      spreadPct,
      bidVolume,
      askVolume,
      imbalance,  // -1 ~ +1, 正=买盘多
      bidNotional,
      askNotional,
      weightedBidDepth,
      weightedAskDepth,
      bidWalls,
      askWalls,
      depth: { bids: depth, asks: depth },
    };
  }

  // ═══════════════════════════════════════════
  // 动态价差计算
  // ═══════════════════════════════════════════
  calculateSpread(volatility, imbalance) {
    // 基础价差 + 波动率调整 + 失衡调整
    const volComponent = volatility * this.volatilityMultiplier;
    const imbalanceComponent = Math.abs(imbalance) * 0.05;
    let spreadPct = this.baseSpreadPct + volComponent + imbalanceComponent;
    return Math.min(spreadPct, this.maxSpreadPct);
  }

  // ═══════════════════════════════════════════
  // 生成报价
  // ═══════════════════════════════════════════
  generateQuotes(midPrice, volatility, imbalance, inventory) {
    const spreadPct = this.calculateSpread(volatility, imbalance);
    const halfSpread = (spreadPct / 100) / 2;
    let bidPrice = midPrice * (1 - halfSpread);
    let askPrice = midPrice * (1 + halfSpread);

    // 库存偏移
    let inventorySkew = 0;
    if (inventory) {
      const inventoryRatio = this.maxInventory > 0
        ? inventory.netPosition / this.maxInventory
        : 0;
      // 正库存(多头) → 报价下移 (更想卖出)
      // 负库存(空头) → 报价上移 (更想买入)
      inventorySkew = Math.max(-1, Math.min(1, inventoryRatio)) * halfSpread * 0.5;
      bidPrice = midPrice * (1 - halfSpread + inventorySkew);
      askPrice = midPrice * (1 + halfSpread + inventorySkew);
    }

    // 大小调整: 库存方向那侧减小
    let bidSize = this.orderSize;
    let askSize = this.orderSize;
    if (inventory) {
      if (inventory.netPosition > 0) {
        bidSize *= Math.max(0.2, 1 - Math.abs(inventory.netPosition / this.maxInventory));
      } else if (inventory.netPosition < 0) {
        askSize *= Math.max(0.2, 1 - Math.abs(inventory.netPosition / this.maxInventory));
      }
    }

    return {
      bidPrice,
      askPrice,
      bidSize: Math.max(1, bidSize),
      askSize: Math.max(1, askSize),
      spreadPct,
      inventorySkew,
      time: Date.now(),
    };
  }

  // ═══════════════════════════════════════════
  // 是否需要改单
  // ═══════════════════════════════════════════
  shouldRequote(currentQuote, marketMid, lastRequoteTime, forceInterval = this.minRequoteIntervalMs) {
    if (!currentQuote) return true;

    const now = Date.now();
    if (now - lastRequoteTime < forceInterval) return false;

    // 价格变动超过阈值
    const priceMovePct = currentQuote.bidPrice > 0
      ? Math.abs(marketMid - (currentQuote.bidPrice + currentQuote.askPrice) / 2) /
        ((currentQuote.bidPrice + currentQuote.askPrice) / 2) * 100
      : 100;

    return priceMovePct > this.minPriceMovePct;
  }

  // ═══════════════════════════════════════════
  // 更新报价
  // ═══════════════════════════════════════════
  updateQuote(symbol, quote) {
    quote.symbol = symbol;
    quote.time = Date.now();
    this._quotes[symbol] = quote;
    this._quoteCount++;
    return quote;
  }

  // ═══════════════════════════════════════════
  // 成交处理
  // ═══════════════════════════════════════════
  processFill(symbol, side, price, size, isMaker = true) {
    const fee = price * size * (isMaker ? this._makerFeeRate : this._feeRate);
    this._feesPaid += fee;

    if (!this._inventory[symbol]) {
      this._inventory[symbol] = { netPosition: 0, avgEntryPrice: 0, notional: 0 };
    }
    const inv = this._inventory[symbol];

    const signedSize = side === 'BUY' ? size : -size;
    const newNetPosition = inv.netPosition + signedSize;

    // 更新均价
    if (inv.netPosition === 0 || Math.sign(newNetPosition) !== Math.sign(inv.netPosition)) {
      inv.avgEntryPrice = price;
    } else {
      const totalCost = inv.avgEntryPrice * Math.abs(inv.netPosition) + price * size;
      const totalQty = Math.abs(inv.netPosition) + size;
      inv.avgEntryPrice = totalQty > 0 ? totalCost / totalQty : price;
    }

    inv.netPosition = newNetPosition;
    inv.notional = Math.abs(newNetPosition) * price;

    // 已实现PnL (如果减少仓位)
    let realized = 0;
    if (Math.abs(newNetPosition) < Math.abs(inv.netPosition - signedSize)) {
      const closedSize = Math.min(size, Math.abs(inv.netPosition - signedSize) - Math.abs(newNetPosition));
      realized = (side === 'SELL' ? price - inv.avgEntryPrice : inv.avgEntryPrice - price) * closedSize;
      this._realizedPnl += realized - fee;
    }

    this._fills.push({ symbol, side, price, size, fee, realized, time: Date.now(), isMaker });
    if (this._fills.length > 200) this._fills.shift();
    this._fillCount++;

    // 回撤追踪
    const totalPnl = this._realizedPnl;
    if (totalPnl > this._peakPnl) this._peakPnl = totalPnl;
    const dd = this._peakPnl > 0 ? (this._peakPnl - totalPnl) / this._peakPnl * 100 : 0;
    if (dd > this._maxDrawdown) this._maxDrawdown = dd;

    return { realized, fee, netPosition: inv.netPosition, notional: inv.notional };
  }

  // ═══════════════════════════════════════════
  // 风险检查
  // ═══════════════════════════════════════════
  checkRisk() {
    // 检查库存超限
    for (const [sym, inv] of Object.entries(this._inventory)) {
      if (Math.abs(inv.notional) > this.maxInventory) {
        return { action: 'REDUCE', symbol: sym, reason: `库存超限 $${inv.notional.toFixed(0)} > $${this.maxInventory}` };
      }
    }
    // 回撤检查
    if (this._maxDrawdown > this.maxDrawdownPct) {
      return { action: 'STOP', reason: `最大回撤 ${this._maxDrawdown.toFixed(1)}% > ${this.maxDrawdownPct}%` };
    }
    // 过期报价检查
    const now = Date.now();
    const staleQuotes = [];
    for (const [sym, q] of Object.entries(this._quotes)) {
      if (now - q.time > this.maxOrderAgeMs) {
        staleQuotes.push(sym);
      }
    }
    if (staleQuotes.length > 0) {
      return { action: 'CANCEL_STALE', symbols: staleQuotes };
    }
    return { action: 'OK' };
  }

  // ═══════════════════════════════════════════
  // 获取做市信号
  // ═══════════════════════════════════════════
  getSignal(symbol, orderBook, volatility) {
    const analysis = this.analyzeOrderBook(orderBook.bids, orderBook.asks);
    if (!analysis) return { action: 'HOLD', reason: '无订单簿数据' };

    const inventory = this._inventory[symbol] || { netPosition: 0, avgEntryPrice: 0, notional: 0 };
    const quotes = this.generateQuotes(analysis.midPrice, volatility || 0.5, analysis.imbalance, inventory);
    this.updateQuote(symbol, quotes);

    const risk = this.checkRisk();

    return {
      action: risk.action === 'OK' ? 'QUOTE' : risk.action,
      symbol,
      quotes,
      analysis: {
        midPrice: analysis.midPrice,
        spreadPct: analysis.spreadPct,
        imbalance: analysis.imbalance,
        bidWalls: analysis.bidWalls.length,
        askWalls: analysis.askWalls.length,
      },
      inventory: { netPosition: inventory.netPosition, notional: inventory.notional },
      risk,
    };
  }

  // ═══════════════════════════════════════════
  // 汇总
  // ═══════════════════════════════════════════
  getSummary() {
    let totalNotional = 0;
    let totalPositions = 0;
    for (const inv of Object.values(this._inventory)) {
      totalNotional += inv.notional;
      if (inv.netPosition !== 0) totalPositions++;
    }

    return {
      totalFills: this._fillCount,
      totalQuotes: this._quoteCount,
      captureRate: this._quoteCount > 0 ? (this._fillCount / this._quoteCount * 100) : 0,
      activeSymbols: Object.keys(this._quotes).length,
      inventorySymbols: totalPositions,
      totalInventoryNotional: totalNotional,
      realizedPnl: this._realizedPnl,
      feesPaid: this._feesPaid,
      netPnl: this._realizedPnl,
      maxDrawdown: this._maxDrawdown,
    };
  }
}

module.exports = { MarketMaker };
