/**
 * Binance Spot Trader v108 — 通用现货交易器
 * 
 * 供 Forex/Index/Commodity/Bond 引擎使用
 * 支持：市价单、限价单、查询余额、查询持仓
 */

const https = require('https');
const crypto = require('crypto');
const { globalLimiter } = require('./rate-limiter'); // v113.10: 全局限速

class BinanceSpotTrader {
  constructor(apiKey, apiSecret) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseURL = 'https://api.binance.com';
    this.log = (msg) => console.log(`[SpotTrader] ${new Date().toISOString()} ${msg}`);
  }

  /**
   * 签名请求
   */
  _sign(queryString) {
    return crypto.createHmac('sha256', this.apiSecret).update(queryString).digest('hex');
  }

  /**
   * 发送 Binance API 请求
   */
  async _request(method, endpoint, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.apiKey || !this.apiSecret) {
        reject(new Error('No API key/secret'));
        return;
      }

      const timestamp = Date.now();
      const allParams = { ...params, timestamp, recvWindow: 10000 };
      const queryString = Object.entries(allParams)
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
      const signature = this._sign(queryString);

      const url = `${this.baseURL}${endpoint}?${queryString}&signature=${signature}`;

      const req = https.request(url, {
        method,
        headers: { 'X-MBX-APIKEY': this.apiKey },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.code) {
              reject(new Error(`Binance API Error ${result.code}: ${result.msg}`));
            } else {
              resolve(result);
            }
          } catch (e) {
            reject(new Error(`JSON parse error: ${data.substring(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(10000, () => {
        req.destroy(new Error('Timeout'));
      });
      req.end();
    });
  }

  // v113.10: 限速包裹
  async _rateLimitedRequest(method, endpoint, params = {}, weight = 2) {
    return globalLimiter.schedule(weight, () => this._request(method, endpoint, params));
  }

  /**
   * 获取余额
   */
  async getBalance() {
    const account = await this._rateLimitedRequest('GET', '/api/v3/account');
    const balances = {};
    let totalUSDT = 0;

    for (const bal of account.balances) {
      const free = parseFloat(bal.free);
      if (free > 0) {
        balances[bal.asset] = free;
        if (bal.asset === 'USDT') totalUSDT += free;
      }
    }

    // 估算其他币种价值
    for (const [asset, amount] of Object.entries(balances)) {
      if (asset === 'USDT') continue;
      try {
        const ticker = await this._getTickerPrice(`${asset}USDT`);
        if (ticker) totalUSDT += amount * ticker;
      } catch (e) {}
    }

    return {
      balances,
      usdt: balances.USDT || 0,
      totalUSDT,
    };
  }

  /**
   * 获取价格
   */
  _getTickerPrice(symbol) {
    return new Promise((resolve) => {
      const url = `${this.baseURL}/api/v3/ticker/price?symbol=${symbol}`;
      https.get(url, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            resolve(parseFloat(JSON.parse(data).price));
          } catch (e) { resolve(null); }
        });
      }).on('error', () => resolve(null));
    });
  }

  /**
   * 市价买入
   */
  async marketBuy(symbol, quantity) {
    // v108: 自动获取精度并截断
    quantity = await this._fixQty(symbol, quantity);
    if (!quantity) return { success: false, error: 'qty too small' };
    this.log(`BUY ${symbol} qty=${quantity} MARKET`);
    const result = await this._rateLimitedRequest('POST', '/api/v3/order', {
      symbol,
      side: 'BUY',
      type: 'MARKET',
      quantity,
    });
    this.log(`✅ ${symbol} BUY filled orderId=${result.orderId}`);
    return { success: true, orderId: result.orderId, raw: result };
  }

  /**
   * 市价卖出（平仓）
   */
  async marketSell(symbol, quantity) {
    quantity = await this._fixQty(symbol, quantity);
    if (!quantity) return { success: false, error: 'qty too small' };
    this.log(`SELL ${symbol} qty=${quantity} MARKET`);
    const result = await this._rateLimitedRequest('POST', '/api/v3/order', {
      symbol,
      side: 'SELL',
      type: 'MARKET',
      quantity,
    });
    this.log(`✅ ${symbol} SELL filled orderId=${result.orderId}`);
    return { success: true, orderId: result.orderId, raw: result };
  }

  /**
   * v108: 获取交易精度并截断数量
   */
  async _fixQty(symbol, qty) {
    try {
      const info = await this.getExchangeInfo(symbol);
      if (info && info.stepSize) {
        const step = parseFloat(info.stepSize);
        const precision = info.stepSize.includes('.') ? info.stepSize.split('.')[1].replace(/0+$/, '').length : 0;
        const fixed = Math.floor(qty / step) * step;
        return parseFloat(fixed.toFixed(precision));
      }
    } catch (e) {}
    // fallback: 6 位小数
    return parseFloat(qty.toFixed(6));
  }

  /**
   * 获取交易规则（精度）
   */
  async getExchangeInfo(symbol) {
    return new Promise((resolve) => {
      const url = `${this.baseURL}/api/v3/exchangeInfo?symbol=${symbol}`;
      https.get(url, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const info = JSON.parse(data);
            const filters = info.symbols[0]?.filters || [];
            const lotSize = filters.find(f => f.filterType === 'LOT_SIZE');
            const minNotional = filters.find(f => f.filterType === 'MIN_NOTIONAL');
            resolve({
              symbol,
              stepSize: lotSize?.stepSize || '0.001',
              minQty: lotSize?.minQty || '0.001',
              minNotional: minNotional?.minNotional || '10',
            });
          } catch (e) { resolve(null); }
        });
      }).on('error', () => resolve(null));
    });
  }
}

module.exports = BinanceSpotTrader;
