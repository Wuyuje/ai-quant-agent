/**
 * v60: CEX-DEX套利信号引擎
 * 
 * 检测 Binance CEX 与 PancakeSwap DEX 之间的价差
 * 当价差超过阈值时生成套利信号
 * 
 * 套利类型：
 * 1. 简单价差套利 — CEX价 < DEX价 或反之
 * 2. 三角套利 — A→B→C→A 循环
 * 3. 延迟套利 — CEX领先DEX价格变动
 */

const { ethers } = require('ethers');

// BSC RPC
const BSC_RPC = 'https://bsc-dataseed1.binance.org/';
// PancakeSwap V2 Router
const PANCAKE_ROUTER = '0x10ED43C718714eb63d5aA27B4B7B6E8FE09E4033';
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const USDT = '0x55d398326f99059fF775485246999027B3197955';

const ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)',
];

class CexDexArbitrage {
  constructor(config = {}) {
    this.minSpreadPct = config.minSpreadPct || 0.5;   // 最小价差0.5%
    this.maxSpreadPct = config.maxSpreadPct || 5.0;    // 最大可信价差5%（超过可能是假流动性）
    this.checkInterval = config.checkInterval || 30000; // 30秒检查一次
    this.provider = new ethers.JsonRpcProvider(BSC_RPC);
    this.router = new ethers.Contract(PANCAKE_ROUTER, ROUTER_ABI, this.provider);
    
    // 价格缓存
    this._cexPrices = {};    // {symbol: price}
    this._dexPrices = {};     // {symbol: price}
    this._spreadHistory = {}; // {symbol: [spreads]}
    this._lastCheck = 0;
    this._opportunities = [];
  }

  /**
   * 更新CEX价格（来自Binance DataBus）
   * @param {string} symbol - 交易对（如 ETHUSDT）
   * @param {number} price - CEX价格
   */
  updateCexPrice(symbol, price) {
    this._cexPrices[symbol] = { price, timestamp: Date.now() };
  }

  /**
   * 批量更新CEX价格
   * @param {Object} prices - { ETHUSDT: 2500.5, ... }
   */
  updateCexPrices(prices) {
    for (const [sym, price] of Object.entries(prices)) {
      this.updateCexPrice(sym, price);
    }
  }

  /**
   * 查询DEX价格（PancakeSwap）
   * @param {string} symbol - 交易对
   * @param {string} tokenAddress - 代币地址
   * @returns {number} DEX价格
   */
  async getDexPrice(tokenAddress) {
    try {
      const amountIn = ethers.parseUnits('1', 18);
      const path = [tokenAddress, USDT];
      const amounts = await this.router.getAmountsOut(amountIn, path);
      const dexPrice = parseFloat(ethers.formatUnits(amounts[1], 18));
      return dexPrice;
    } catch (e) {
      return null;
    }
  }

  /**
   * 检测套利机会
   * @param {Object} tokenMap - { ETH: '0x...', BNB: '0x...' }
   * @returns {Array} 套利机会列表
   */
  async detectOpportunities(tokenMap) {
    const opportunities = [];
    const now = Date.now();

    for (const [base, tokenAddr] of Object.entries(tokenMap)) {
      const symbol = base + 'USDT';
      const cexData = this._cexPrices[symbol];
      
      if (!cexData || now - cexData.timestamp > 60000) continue; // CEX数据过期

      // 查询DEX价格
      let dexPrice;
      try {
        dexPrice = await this.getDexPrice(tokenAddr);
      } catch (e) { continue; }
      
      if (!dexPrice || dexPrice <= 0) continue;

      const cexPrice = cexData.price;
      const spreadPct = ((dexPrice - cexPrice) / cexPrice) * 100;

      // 记录历史
      if (!this._spreadHistory[symbol]) this._spreadHistory[symbol] = [];
      this._spreadHistory[symbol].push(spreadPct);
      if (this._spreadHistory[symbol].length > 50) this._spreadHistory[symbol].shift();

      // 判断套利方向
      const absSpread = Math.abs(spreadPct);
      
      if (absSpread < this.minSpreadPct || absSpread > this.maxSpreadPct) continue;

      // 价差方向
      // spreadPct > 0: DEX > CEX → CEX买，DEX卖
      // spreadPct < 0: CEX > DEX → DEX买，CEX卖
      const direction = spreadPct > 0 ? 'BUY_CEX_SELL_DEX' : 'BUY_DEX_SELL_CEX';

      // 计算历史分位
      const history = this._spreadHistory[symbol];
      const rank = history.filter(s => Math.abs(s) < absSpread).length / history.length;

      opportunities.push({
        symbol,
        base,
        cexPrice,
        dexPrice,
        spreadPct,
        direction,
        rank,          // 当前价差在历史中的分位（0-1，越高越罕见）
        isRare: rank > 0.9,  // 罕见价差 → 更高套利价值
        timestamp: now,
        tokenAddress: tokenAddr,
      });
    }

    // 按价差排序
    opportunities.sort((a, b) => Math.abs(b.spreadPct) - Math.abs(a.spreadPct));
    this._opportunities = opportunities;
    
    return opportunities;
  }

  /**
   * 获取最佳套利机会
   */
  getBestOpportunity() {
    return this._opportunities.length > 0 ? this._opportunities[0] : null;
  }

  /**
   * 生成套利信号（供策略管理器使用）
   * @returns {Object} 套利信号
   */
  getArbitrageSignal() {
    const best = this.getBestOpportunity();
    if (!best) {
      return { action: 'HOLD', reason: '无套利机会' };
    }

    // 信号强度 = 价差 * 罕见度
    const strength = Math.abs(best.spreadPct) * (best.isRare ? 1.5 : 1.0);
    
    return {
      action: 'ARBITRAGE',
      symbol: best.symbol,
      direction: best.direction,
      spreadPct: best.spreadPct,
      strength,
      confidence: Math.min(1, strength / 3),
      details: best,
    };
  }

  /**
   * 延迟套利检测
   * 当CEX价格变动后，DEX价格还没跟上 → 预测DEX方向
   * @param {string} symbol - 交易对
   * @returns {Object} 延迟套利信号
   */
  detectLatencyArbitrage(symbol) {
    const cexData = this._cexPrices[symbol];
    const dexData = this._dexPrices[symbol];
    
    if (!cexData || !dexData) return { valid: false };

    const timeDiff = cexData.timestamp - dexData.timestamp;
    
    // CEX数据比DEX新5秒以上
    if (Math.abs(timeDiff) < 5000) return { valid: false };

    const priceDiff = (cexData.price - dexData.price) / dexData.price * 100;
    
    if (Math.abs(priceDiff) < this.minSpreadPct) return { valid: false };

    // CEX涨了 → DEX预期也会涨
    // CEX跌了 → DEX预期也会跌
    return {
      valid: true,
      symbol,
      cexPrice: cexData.price,
      dexPrice: dexData.price,
      priceDiffPct: priceDiff,
      predictedDexMove: priceDiff > 0 ? 'UP' : 'DOWN',
      confidence: Math.min(1, Math.abs(priceDiff) / 2),
    };
  }

  /**
   * 获取所有机会摘要
   */
  getSummary() {
    return {
      totalOpportunities: this._opportunities.length,
      bestSpread: this._opportunities[0]?.spreadPct || 0,
      bestSymbol: this._opportunities[0]?.symbol || '',
      trackedSymbols: Object.keys(this._cexPrices).length,
      lastCheck: this._lastCheck,
    };
  }
}

module.exports = { CexDexArbitrage };
