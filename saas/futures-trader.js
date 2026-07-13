/**
 * Binance Futures Trader v108.2 — 通用合约交易器
 * 
 * 供 Index(股票代币)/Commodity(商品期货)/Bond 引擎使用
 * 支持：市价开多/开空、市价平仓、查询余额、查询持仓
 * 走 Binance USDT-M 合约 API (fapi.binance.com)
 */

const https = require('https');
const crypto = require('crypto');
const { RateLimiter, globalLimiter } = require('./rate-limiter');

class BinanceFuturesTrader {
  constructor(apiKey, apiSecret) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseURL = 'https://fapi.binance.com';
    this.limiter = globalLimiter;
    this.log = (msg) => console.log(`[FuturesTrader] ${new Date().toISOString()} ${msg}`);
  }

  _sign(queryString) {
    return crypto.createHmac('sha256', this.apiSecret).update(queryString).digest('hex');
  }

  async _request(method, endpoint, params = {}) {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('No API key/secret');
    }
    // 限速：余额5权重，持仓5权重，订单1权重，K线1权重
    const weight = endpoint.includes('balance') ? 5 : endpoint.includes('positionRisk') ? 5 : endpoint.includes('order') ? 1 : 1;
    return this.limiter.schedule(weight, () => this._doRequest(method, endpoint, params));
  }

  _doRequest(method, endpoint, params = {}) {
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
              reject(new Error(`Binance Futures API Error ${result.code}: ${result.msg}`));
            } else {
              resolve(result);
            }
          } catch (e) {
            reject(new Error(`JSON parse error: ${data.substring(0, 200)}`));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('Timeout')));
      req.end();
    });
  }

  /**
   * 获取合约余额
   */
  async getBalance() {
    const result = await this._request('GET', '/fapi/v2/balance');
    const balances = {};
    let totalUSDT = 0;
    for (const bal of result) {
      const balance = parseFloat(bal.balance);
      if (balance > 0) {
        balances[bal.asset] = balance;
        if (bal.asset === 'USDT') totalUSDT = balance;
      }
    }
    return { balances, usdt: balances.USDT || 0, totalUSDT };
  }

  /**
   * 查询当前持仓
   */
  async getPositions(symbol) {
    const params = symbol ? { symbol } : {};
    const result = await this._request('GET', '/fapi/v2/positionRisk', params);
    return result.filter(p => parseFloat(p.positionAmt) !== 0);
  }

  /**
   * 设置杠杆 (开仓前调用, 确保保证金合理)
   */
  async setLeverage(symbol, leverage = 3) {
    try {
      const result = await this._request('POST', '/fapi/v1/leverage', { symbol, leverage });
      this.log(`${symbol} leverage set to ${result.leverage}x`);
      return result;
    } catch (e) {
      this.log(`${symbol} setLeverage failed: ${e.message}`);
      return null;
    }
  }

  /**
   * 市价开多
   */
  async marketLong(symbol, quantity, leverage = 3) {
    quantity = await this._fixQty(symbol, quantity);
    if (!quantity) return { success: false, error: 'qty too small' };
    // v113.59: 开仓前设置杠杆, 避免Binance默认20x导致保证金太小
    await this.setLeverage(symbol, leverage);
    this.log(`LONG ${symbol} qty=${quantity} MARKET lev=${leverage}x`);
    const result = await this._request('POST', '/fapi/v1/order', {
      symbol, side: 'BUY', type: 'MARKET', quantity,
    });
    this.log(`✅ ${symbol} LONG filled orderId=${result.orderId}`);
    return { success: true, orderId: result.orderId, raw: result };
  }

  /**
   * 市价开空
   */
  async marketShort(symbol, quantity, leverage = 3) {
    quantity = await this._fixQty(symbol, quantity);
    if (!quantity) return { success: false, error: 'qty too small' };
    // v113.59: 开仓前设置杠杆, 避免Binance默认20x导致保证金太小
    await this.setLeverage(symbol, leverage);
    this.log(`SHORT ${symbol} qty=${quantity} MARKET lev=${leverage}x`);
    const result = await this._request('POST', '/fapi/v1/order', {
      symbol, side: 'SELL', type: 'MARKET', quantity,
    });
    this.log(`✅ ${symbol} SHORT filled orderId=${result.orderId}`);
    return { success: true, orderId: result.orderId, raw: result };
  }

  /**
   * 平多 — 卖出等量
   */
  async closeLong(symbol, quantity) {
    quantity = await this._fixQty(symbol, quantity);
    if (!quantity) return { success: false, error: 'qty too small' };
    this.log(`CLOSE LONG ${symbol} qty=${quantity}`);
    const result = await this._request('POST', '/fapi/v1/order', {
      symbol, side: 'SELL', type: 'MARKET', quantity, reduceOnly: 'true',
    });
    this.log(`✅ ${symbol} CLOSE LONG filled orderId=${result.orderId}`);
    return { success: true, orderId: result.orderId, raw: result };
  }

  /**
   * 平空 — 买入等量
   */
  async closeShort(symbol, quantity) {
    quantity = await this._fixQty(symbol, quantity);
    if (!quantity) return { success: false, error: 'qty too small' };
    this.log(`CLOSE SHORT ${symbol} qty=${quantity}`);
    const result = await this._request('POST', '/fapi/v1/order', {
      symbol, side: 'BUY', type: 'MARKET', quantity, reduceOnly: 'true',
    });
    this.log(`✅ ${symbol} CLOSE SHORT filled orderId=${result.orderId}`);
    return { success: true, orderId: result.orderId, raw: result };
  }

  /**
   * 获取合约精度
   */
  async _fixQty(symbol, qty) {
    // v108.3: 硬编码已知精度表 + stepSize fallback
    // Binance exchangeInfo 的 quantityPrecision/stepSize 都不可靠
    const KNOWN_PRECISION = {
      'COPPERUSDT': 1, 'NATGASUSDT': 1,  // 商品期货实际只接受1位
      'XAGUSDT': 3, 'XAUUSDT': 3, 'PAXGUSDT': 3,
      'TSLAUSDT': 2, 'SPYUSDT': 2, 'QQQUSDT': 2, 'NVDAUSDT': 2,
      'METAUSDT': 2, 'MSFTUSDT': 2, 'GOOGLUSDT': 2, 'COINUSDT': 2,
      'MSTRUSDT': 2, 'PLTRUSDT': 2, 'AAPLUSDT': 2,
      'USDCUSDT': 0, 'UVXYUSDT': 2, 'URNMUSDT': 2, 'IWMUSDT': 2, 'XLEUSDT': 2,
      'BTCUSDT': 3, 'ETHUSDT': 3, 'SOLUSDT': 2, 'BNBUSDT': 2,
      'AVAXUSDT': 1, 'DOTUSDT': 2, 'LINKUSDT': 2,
    };
    let precision = KNOWN_PRECISION[symbol];
    if (precision === undefined) precision = 2;
    return parseFloat(qty.toFixed(precision));
  }

  /**
   * 获取价格
   */
  _getTickerPrice(symbol) {
    return new Promise((resolve) => {
      https.get(`${this.baseURL}/fapi/v1/ticker/price?symbol=${symbol}`, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(parseFloat(JSON.parse(data).price)); }
          catch (e) { resolve(null); }
        });
      }).on('error', () => resolve(null));
    });
  }
}

module.exports = BinanceFuturesTrader;
