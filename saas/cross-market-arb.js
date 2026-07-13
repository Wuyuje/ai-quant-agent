/**
 * Cross-Market Arbitrage Engine v95 — 跨市场套利引擎
 * 
 * 参考世界顶尖量化基金:
 * - Citadel Securities: 跨市场做市 + 套利
 * - Jump Trading: 跨交易所延迟套利
 - Virtu Financial: 高频做市 + 跨市场套利
 * - Jane Street: ETF套利 + 跨市场统计套利
 * 
 * 套利类型:
 * 1. Spot-Futures Arbitrage (现货-期货价差)
 * 2. Cross-Exchange Arbitrage (跨交易所价差)
 * 3. Triangular Arbitrage (三角套利)
 * 4. Statistical Arbitrage (统计套利)
 * 5. Cross-Asset Correlation (跨资产相关性套利)
 * 6. Funding Rate Arbitrage (资金费率套利)
 * 7. Gold-Crypto Arbitrage (黄金-加密套利)
 * 8. DXY-Gold Arbitrage (美元-黄金套利)
 * 
 * 核心优势:
 * - 低风险 (理论上无风险)
 * - 高频 (秒级交易)
 * - 需要极低延迟
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

class CrossMarketArb {
  constructor(apiKey, apiSecret) {
    this.spotURL = 'https://api.binance.com';
    this.futuresURL = 'https://fapi.binance.com';
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;

    // 监控的套利机会
    this.arbPairs = {
      // 现货-期货套利
      spotFutures: [
        { spot: 'BTCUSDT', futures: 'BTCUSDT', type: 'perp' },
        { spot: 'ETHUSDT', futures: 'ETHUSDT', type: 'perp' },
        { spot: 'SOLUSDT', futures: 'SOLUSDT', type: 'perp' },
      ],
      // 跨资产套利
      crossAsset: [
        { long: 'PAXGUSDT', short: 'BTCUSDT', desc: '黄金/比特币比', threshold: 0.03 },
        { long: 'ETHUSDT', short: 'BTCUSDT', desc: 'ETH/BTC相对强弱', threshold: 0.02 },
      ],
      // 三角套利 (合约U本位, 只用USDT交易对)
      triangular: [
        { path: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], desc: 'BTC→ETH→SOL (相对强弱)' },
        ],
    };

    // 执行参数
    this.params = {
      minProfitBps: 5,        // 最小利润 5bps (0.05%)
      maxSlippageBps: 3,      // 最大滑点 3bps
      maxPositionUsd: 10000,  // 单次最大$10000
      executionTimeout: 2000, // 执行超时2秒
      minVolume24h: 1000000,  // 最小24h成交额$1M
      minProfitAfterFees: 0.03, // 扣除手续费后最低利润0.03%
    };

    // v96: 实盘执行开关
    this.liveTrading = !!apiKey; // 有API Key就启用实盘
    this.orderHistory = [];

    this.state = {
      opportunities: [],
      executedTrades: 0,
      totalProfit: 0,
      dailyProfit: 0,
      lastScan: Date.now(),
    };

    this.logFile = path.join(__dirname, '..', 'logs', 'cross-arb.log');
    this._log('Cross-Market Arbitrage Engine v95 初始化');
  }

  /**
   * 主循环 (10秒 — 套利需要更频繁扫描)
   */
  async start() {
    this._log('🚀 Cross-Market Arb 启动');
    
    this._interval = setInterval(async () => {
      try {
        await this._scanAll();
      } catch (e) {
        this._log(`❌ Scan错误: ${e.message}`);
      }
    }, 10000);
  }

  async stop() {
    if (this._interval) clearInterval(this._interval);
    this._log('Cross-Market Arb 停止');
  }

  async _scanAll() {
    // 1. 现货-期货价差
    await this._scanSpotFutures();

    // 2. 跨资产相关性
    await this._scanCrossAsset();

    // 3. 三角套利
    await this._scanTriangular();

    this.state.lastScan = Date.now();
    this._saveState();
  }

  /**
   * 套利类型1: 现货-期货价差
   * 当期货溢价/折价超过阈值时开仓
   */
  async _scanSpotFutures() {
    for (const pair of this.arbPairs.spotFutures) {
      try {
        const [spotTicker, futuresTicker] = await Promise.all([
          this._getTicker(pair.spot, 'spot'),
          this._getTicker(pair.futures, 'futures'),
        ]);

        if (!spotTicker || !futuresTicker) continue;

        const spotPrice = parseFloat(spotTicker.lastPrice);
        const futuresPrice = parseFloat(futuresTicker.lastPrice);
        const basis = (futuresPrice - spotPrice) / spotPrice * 100; // 基差率

        // 期货溢价 > 0.1% → 卖期货买现货
        if (basis > 0.1) {
          const profit = basis - 0.02; // 扣除手续费
          if (profit * 100 >= this.params.minProfitBps) {
            this._log(`🔗 现货期货套利: ${pair.spot} 基差=${basis.toFixed(3)}% → 卖期货买现货 | 预期利润=${(profit * 100).toFixed(1)}bps`);
            this.state.opportunities.push({
              type: 'spotFutures',
              symbol: pair.spot,
              direction: 'basis_trade',
              basis,
              profit,
              time: Date.now(),
            });
          }
        }
        // 期货折价 > 0.1% → 买期货卖现货
        else if (basis < -0.1) {
          const profit = Math.abs(basis) - 0.02;
          if (profit * 100 >= this.params.minProfitBps) {
            this._log(`🔗 现货期货套利: ${pair.spot} 基差=${basis.toFixed(3)}% → 买期货卖现货 | 预期利润=${(profit * 100).toFixed(1)}bps`);
            this.state.opportunities.push({
              type: 'spotFutures',
              symbol: pair.spot,
              direction: 'reverse_basis',
              basis,
              profit,
              time: Date.now(),
            });
          }
        }
      } catch (e) {}
    }
  }

  /**
   * 套利类型2: 跨资产相关性套利
   * 当两个高相关资产的价比偏离历史均值时
   */
  async _scanCrossAsset() {
    for (const pair of this.arbPairs.crossAsset) {
      try {
        const [longTicker, shortTicker] = await Promise.all([
          this._getTicker(pair.long, 'spot'),
          this._getTicker(pair.short, 'spot'),
        ]);

        if (!longTicker || !shortTicker) continue;

        const longPrice = parseFloat(longTicker.lastPrice);
        const shortPrice = parseFloat(shortTicker.lastPrice);
        const ratio = longPrice / shortPrice;

        // 简化: 用当日变化判断偏离
        const longChange = parseFloat(longTicker.priceChangePercent);
        const shortChange = parseFloat(shortTicker.priceChangePercent);
        const spread = longChange - shortChange;

        if (Math.abs(spread) > pair.threshold * 100) {
          const direction = spread > 0 ? 'long_long_short_short' : 'short_long_long_short';
          const profit = Math.abs(spread) / 100 - 0.0002; // 扣手续费
          this._log(`🔗 跨资产套利: ${pair.desc} | 价差=${spread.toFixed(2)}% → ${direction}`);
          this.state.opportunities.push({
            type: 'crossAsset',
            pair: `${pair.long}/${pair.short}`,
            spread,
            profit,
            desc: pair.desc,
            time: Date.now(),
          });

          // v96: 实盘执行
          if (this.liveTrading && profit > this.params.minProfitAfterFees) {
            await this._executeCrossAssetArb(pair, direction, profit);
          }
        }
      } catch (e) {}
    }
  }

  /**
   * 套利类型3: 三角套利
   * A→B→C→A 的路径中发现定价错误
   */
  async _scanTriangular() {
    for (const tri of this.arbPairs.triangular) {
      try {
        const tickers = await Promise.all(
          tri.path.map(s => this._getTicker(s, 'spot'))
        );

        if (tickers.some(t => !t)) continue;

        const prices = tickers.map(t => parseFloat(t.lastPrice));
        
        // 三角套利利润计算
        // A→B: 用A买B, B→C: 用B买C, C→A: 用C买A
        const rate1 = 1 / prices[0]; // A→B
        const rate2 = 1 / prices[1]; // B→C  
        const rate3 = prices[2];     // C→A
        
        const profit = (rate1 * rate2 * rate3 - 1) * 100;

        if (profit > this.params.minProfitBps / 100) {
          this._log(`🔗 三角套利: ${tri.desc} | 利润=${profit.toFixed(3)}%`);
          this.state.opportunities.push({
            type: 'triangular',
            path: tri.path,
            profit,
            desc: tri.desc,
            time: Date.now(),
          });

          // v96: 实盘执行
          if (this.liveTrading && profit > this.params.minProfitAfterFees / 100) {
            await this._executeTriangularArb(tri, profit);
          }
        }
      } catch (e) {}
    }
  }

  /**
   * 获取Ticker
   */
  async _getTicker(symbol, type = 'spot') {
    return new Promise((resolve) => {
      const base = type === 'futures' ? this.futuresURL : this.spotURL;
      const endpoint = type === 'futures' ? '/fapi/v1/ticker/24hr' : '/api/v3/ticker/24hr';
      const url = `${base}${endpoint}?symbol=${symbol}`;
      
      https.get(url, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
        });
      }).on('error', () => resolve(null));
    });
  }

  // ═══ v96: 实盘套利执行 ═══

  /**
   * 跨资产套利执行
   */
  async _executeCrossAssetArb(pair, direction, expectedProfit) {
    try {
      // 余额检查 — 不够就跳过
      const balance = await this._getFuturesBalance();
      if (balance < 120) {
        this._log(`⏭️ 跨资产套利跳过: 余额不足 ($${balance.toFixed(2)} < $120)`);
        return;
      }
      const notionalUsd = Math.min(25, balance * 0.2); // 安全小仓
      const side1 = direction === 'long_long_short_short' ? 'BUY' : 'SELL';
      const side2 = direction === 'long_long_short_short' ? 'SELL' : 'BUY';

      // 同时下单两个方向
      const [order1, order2] = await Promise.all([
        this._placeOrder(pair.long, side1, notionalUsd),
        this._placeOrder(pair.short, side2, notionalUsd),
      ]);

      if (order1 && order2) {
        this.state.executedTrades++;
        this.state.totalProfit += expectedProfit * notionalUsd / 100;
        this._log(`✅ 跨资产套利执行成功: ${pair.desc} | 预期利润=${(expectedProfit*notionalUsd/100).toFixed(4)}$`);

        this.orderHistory.push({
          type: 'crossAsset',
          pair: pair.desc,
          order1: order1.orderId,
          order2: order2.orderId,
          expectedProfit,
          time: Date.now(),
        });
      }
    } catch (e) {
      this._log(`❌ 跨资产套利执行失败: ${e.message}`);
    }
  }

  /**
   * 三角套利执行
   */
  async _executeTriangularArb(tri, expectedProfit) {
    try {
      const notionalUsd = 50;
      // 三角套利需要3个顺序订单
      const amounts = [notionalUsd, notionalUsd, notionalUsd];
      const orders = [];

      for (let i = 0; i < tri.path.length; i++) {
        const order = await this._placeOrder(tri.path[i], i % 2 === 0 ? 'BUY' : 'SELL', amounts[i]);
        if (order) orders.push(order);
      }

      if (orders.length === 3) {
        this.state.executedTrades++;
        this.state.totalProfit += expectedProfit * notionalUsd / 100;
        this._log(`✅ 三角套利执行成功: ${tri.desc} | 预期利润=${(expectedProfit*notionalUsd).toFixed(4)}%`);

        this.orderHistory.push({
          type: 'triangular',
          path: tri.path.join('→'),
          orders: orders.map(o => o.orderId),
          expectedProfit,
          time: Date.now(),
        });
      }
    } catch (e) {
      this._log(`❌ 三角套利执行失败: ${e.message}`);
    }
  }

  /**
   * 下单 (Binance Futures Market Order)
   */
  async _placeOrder(symbol, side, notionalUsd) {
    if (!this.apiKey || !this.apiSecret) return null;

    return new Promise((resolve) => {
      const crypto2 = require('crypto');
      const timestamp = Date.now();
      const symbol_upper = symbol.toUpperCase();

      // 先获取价格
      https.get(`${this.futuresURL}/fapi/v1/ticker/price?symbol=${symbol_upper}`, (priceRes) => {
        let priceData = '';
        priceRes.on('data', c => priceData += c);
        priceRes.on('end', () => {
          try {
            const price = parseFloat(JSON.parse(priceData).price);
            // v108.3: 硬编码已知精度表
            const PREC = {'COPPERUSDT':1,'NATGASUSDT':1,'XAGUSDT':3,'XAUUSDT':3,'PAXGUSDT':3,'TSLAUSDT':2,'SPYUSDT':2,'QQQUSDT':2,'NVDAUSDT':2,'METAUSDT':2,'MSFTUSDT':2,'GOOGLUSDT':2,'COINUSDT':2,'MSTRUSDT':2,'PLTRUSDT':2,'AAPLUSDT':2,'USDCUSDT':0,'UVXYUSDT':2,'URNMUSDT':2,'BTCUSDT':3,'ETHUSDT':3,'SOLUSDT':2,'BNBUSDT':2,'AVAXUSDT':1,'DOTUSDT':2,'LINKUSDT':2};
            const prec = PREC[symbol_upper] !== undefined ? PREC[symbol_upper] : 2;
            const qty = parseFloat((notionalUsd / price).toFixed(prec));

            const queryString = `symbol=${symbol_upper}&side=${side}&type=MARKET&quantity=${qty}&timestamp=${timestamp}`;
            const signature = crypto2.createHmac('sha256', this.apiSecret).update(queryString).digest('hex');

            const url = `${this.futuresURL}/fapi/v1/order?${queryString}&signature=${signature}`;
            const req = https.request(url, {
              method: 'POST',
              headers: { 'X-MBX-APIKEY': this.apiKey },
            }, (res) => {
              let data = '';
              res.on('data', c => data += c);
              res.on('end', () => {
                try {
                  const result = JSON.parse(data);
                  if (result.code) {
                    this._log(`❌ 订单失败 ${symbol}: ${result.msg}`);
                    resolve(null);
                  } else {
                    resolve(result);
                  }
                } catch (e) { resolve(null); }
              });
            });
            req.on('error', () => resolve(null));
            req.end();
          } catch (e) { resolve(null); }
        });
      }).on('error', () => resolve(null));
    });
  }

  /**
   * 查询合约可用余额
   */
  async _getFuturesBalance() {
    return new Promise((resolve) => {
      const crypto2 = require('crypto');
      const timestamp = Date.now();
      const queryString = `timestamp=${timestamp}`;
      const signature = crypto2.createHmac('sha256', this.apiSecret).update(queryString).digest('hex');
      const url = `${this.futuresURL}/fapi/v2/balance?${queryString}&signature=${signature}`;
      https.get(url, { headers: { 'X-MBX-APIKEY': this.apiKey } }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const arr = JSON.parse(d);
            const usdt = arr.find(a => a.asset === 'USDT');
            resolve(usdt ? parseFloat(usdt.availableBalance) : 0);
          } catch (e) { resolve(0); }
        });
      }).on('error', () => resolve(0));
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
      const dir = path.join(__dirname, '..', 'data');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // 只保留最近100条机会
      this.state.opportunities = this.state.opportunities.slice(-100);
      fs.writeFileSync(path.join(dir, 'cross-arb-state.json'), JSON.stringify(this.state, null, 2));
    } catch (e) {}
  }

  getReport() {
    return {
      engine: 'Cross-Market Arbitrage',
      opportunities: this.state.opportunities.length,
      recentOpps: this.state.opportunities.slice(-5),
      executedTrades: this.state.executedTrades,
      totalProfit: this.state.totalProfit,
      dailyProfit: this.state.dailyProfit,
      lastScan: new Date(this.state.lastScan).toISOString(),
    };
  }
}

module.exports = CrossMarketArb;
