/**
 * v85: EnhancedDataBus — 扩展市场数据总线
 * 
 * 在原有K线+MA基础上增加：
 * 1. Orderbook Imbalance (Binance深度)
 * 2. Funding Rate (永续合约资金费率)
 * 3. Volume Profile (成交量分布)
 * 
 * 所有新数据只做加法，不删原有逻辑
 */

class EnhancedDataBus {
  constructor() {
    this.orderbookCache = {};    // symbol → { imbalance, timestamp }
    this.fundingCache = {};      // symbol → { rate, timestamp }
    this.volProfileCache = {};   // symbol → { poc, vaHigh, vaLow, timestamp }
    this.cacheTimeout = 60000;   // 缓存1分钟
  }

  /**
   * 获取Orderbook Imbalance
   * (买一量 - 卖一量) / (买一量 + 卖一量)
   * 范围: -1 (全卖单) ~ +1 (全买单)
   */
  async fetchOrderbookImbalance(symbol) {
    try {
      // 检查缓存
      const cached = this.orderbookCache[symbol];
      if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.imbalance;
      }

      const https = require('https');
      const depth = await new Promise((resolve, reject) => {
        const url = `https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=20`;
        https.get(url, (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(e); }
          });
        }).on('error', reject);
        setTimeout(() => reject(new Error('timeout')), 5000);
      });

      if (!depth || !depth.bids || !depth.asks) return 0;

      // 计算加权imbalance (越靠近盘口权重越大)
      let bidVol = 0, askVol = 0;
      for (let i = 0; i < Math.min(depth.bids.length, 10); i++) {
        const weight = 1 / (i + 1); // 越近权重越高
        bidVol += parseFloat(depth.bids[i][1]) * weight;
      }
      for (let i = 0; i < Math.min(depth.asks.length, 10); i++) {
        const weight = 1 / (i + 1);
        askVol += parseFloat(depth.asks[i][1]) * weight;
      }

      const total = bidVol + askVol;
      const imbalance = total > 0 ? (bidVol - askVol) / total : 0;

      this.orderbookCache[symbol] = { imbalance, timestamp: Date.now() };
      return imbalance;
    } catch (e) {
      return 0;
    }
  }

  /**
   * 获取Funding Rate (永续合约资金费率)
   * 正值 = 多头付空头 (多头拥挤)
   * 负值 = 空头付多头 (空头拥挤)
   */
  async fetchFundingRate(symbol) {
    try {
      const cached = this.fundingCache[symbol];
      if (cached && Date.now() - cached.timestamp < 300000) { // 5分钟缓存
        return cached.rate;
      }

      const https = require('https');
      const data = await new Promise((resolve, reject) => {
        const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`;
        https.get(url, (res) => {
          let body = '';
          res.on('data', (chunk) => body += chunk);
          res.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch (e) { reject(e); }
          });
        }).on('error', reject);
        setTimeout(() => reject(new Error('timeout')), 5000);
      });

      const rate = data && data[0] ? parseFloat(data[0].fundingRate) : 0;
      this.fundingCache[symbol] = { rate, timestamp: Date.now() };
      return rate;
    } catch (e) {
      return 0;
    }
  }

  /**
   * 计算Volume Profile (基于K线)
   * POC: Point of Control (成交量最大的价格)
   * VAH/VAL: Value Area High/Low (70%成交量所在区间)
   */
  calcVolumeProfile(klines, numBins = 24) {
    if (!klines || klines.length < 20) {
      return { poc: 0, vaHigh: 0, vaLow: 0, distribution: [] };
    }

    // 找价格范围
    const prices = klines.map(k => [(k.high + k.low) / 2, k.volume]);
    let minPrice = Infinity, maxPrice = -Infinity;
    for (const [p] of prices) {
      minPrice = Math.min(minPrice, p);
      maxPrice = Math.max(maxPrice, p);
    }

    if (maxPrice === minPrice) return { poc: minPrice, vaHigh: maxPrice, vaLow: minPrice, distribution: [] };

    // 分bin
    const binSize = (maxPrice - minPrice) / numBins;
    const bins = new Array(numBins).fill(0);
    const binPrices = [];
    for (let i = 0; i < numBins; i++) {
      binPrices.push(minPrice + binSize * (i + 0.5));
    }

    for (const [price, vol] of prices) {
      const binIdx = Math.min(Math.floor((price - minPrice) / binSize), numBins - 1);
      bins[binIdx] += vol;
    }

    // POC: 成交量最大的bin
    let pocIdx = 0;
    for (let i = 1; i < bins.length; i++) {
      if (bins[i] > bins[pocIdx]) pocIdx = i;
    }
    const poc = binPrices[pocIdx];

    // VA: 从POC向两边扩展，直到覆盖70%总成交量
    const totalVol = bins.reduce((a, b) => a + b, 0);
    const targetVol = totalVol * 0.7;
    let coveredVol = bins[pocIdx];
    let vaLow = pocIdx, vaHigh = pocIdx;
    
    while (coveredVol < targetVol && (vaLow > 0 || vaHigh < numBins - 1)) {
      const expandDown = vaLow > 0 ? bins[vaLow - 1] : 0;
      const expandUp = vaHigh < numBins - 1 ? bins[vaHigh + 1] : 0;
      if (expandDown >= expandUp && vaLow > 0) {
        vaLow--;
        coveredVol += expandDown;
      } else if (vaHigh < numBins - 1) {
        vaHigh++;
        coveredVol += expandUp;
      } else break;
    }

    return {
      poc: parseFloat(poc.toFixed(8)),
      vaHigh: parseFloat(binPrices[vaHigh].toFixed(8)),
      vaLow: parseFloat(binPrices[vaLow].toFixed(8)),
      distribution: bins.map((vol, i) => ({ price: binPrices[i], volume: vol })),
    };
  }

  /**
   * 获取价格在Volume Profile中的位置
   * @returns {Object} { position, isAbovePOC, isInsideVA, distanceToPOC }
   */
  getPricePosition(currentPrice, profile) {
    if (!profile || profile.poc === 0) {
      return { position: 0.5, isAbovePOC: true, isInsideVA: true, distanceToPOC: 0 };
    }

    const isAbovePOC = currentPrice > profile.poc;
    const isInsideVA = currentPrice >= profile.vaLow && currentPrice <= profile.vaHigh;
    const vaRange = profile.vaHigh - profile.vaLow;
    const distanceToPOC = vaRange > 0 ? (currentPrice - profile.poc) / vaRange : 0;

    // 0 = 最低, 0.5 = POC, 1 = 最高
    const totalRange = profile.vaHigh - profile.vaLow;
    const position = totalRange > 0 ? Math.max(0, Math.min(1, (currentPrice - profile.vaLow) / totalRange)) : 0.5;

    return { position, isAbovePOC, isInsideVA, distanceToPOC: parseFloat(distanceToPOC.toFixed(3)) };
  }

  /**
   * 综合增强数据
   * @param {string} symbol 
   * @param {Array} klines
   * @returns {Object} 增强数据包
   */
  async getEnhancedData(symbol, klines) {
    // 并行获取所有数据
    const [obImbalance, fundingRate] = await Promise.all([
      this.fetchOrderbookImbalance(symbol).catch(() => 0),
      this.fetchFundingRate(symbol).catch(() => 0),
    ]);

    const profile = this.calcVolumeProfile(klines);
    const currentPrice = klines && klines.length > 0 ? klines[klines.length - 1].close : 0;
    const pricePos = this.getPricePosition(currentPrice, profile);

    return {
      orderbookImbalance: parseFloat(obImbalance.toFixed(4)),
      fundingRate: parseFloat((fundingRate * 100).toFixed(4)),  // 转为百分比
      volumeProfile: {
        poc: profile.poc,
        vaHigh: profile.vaHigh,
        vaLow: profile.vaLow,
        pricePosition: pricePos,
      },
      // 综合信号（给ensemble用）
      _signals: {
        // orderbook > 0.2 = 买压强, < -0.2 = 卖压强
        obBullish: obImbalance > 0.2,
        obBearish: obImbalance < -0.2,
        // funding > 0.05% = 多头拥挤(看跌), < -0.05% = 空头拥挤(看涨)
        fundingBearish: fundingRate > 0.0005,
        fundingBullish: fundingRate < -0.0005,
        // 价格在VA内 = 正常, 在VA外 = 超买/超卖
        vpOverbought: pricePos.position > 0.9,
        vpOversold: pricePos.position < 0.1,
      },
    };
  }
}

module.exports = { EnhancedDataBus };
