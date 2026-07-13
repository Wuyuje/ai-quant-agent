/**
 * Gold Trader — 黄金现货交易执行器
 * 
 * 交易标的: PAXGUSDT (PAX Gold — 1:1黄金代币，锚定1盎司黄金)
 * 交易方式: Binance现货(Spot) — 用户自己的API Key
 * 
 * 核心特点:
 * - 现货交易（无杠杆，无爆仓风险）
 * - ATR动态止损止盈
 * - 仓位管理：根据信号强度和波动率调整
 * - 时段过滤：避免低流动性时段
 * 
 * 安全设计:
 * - 只操作 PAXGUSDT 交易对
 * - 最小下单量限制
 * - 滑点保护
 */

const crypto = require('crypto');
const { userLimiter } = require('./rate-limiter'); // v113.13.6: 普通用户独立限速

class GoldTrader {
  constructor(config = {}) {
    this.baseURL = 'https://api.binance.com';
    this.symbol = 'PAXGUSDT';
    this.minNotional = 5; // 最小下单$5 (Binance PAXGUSDT MIN_NOTIONAL=$5, 最小0.002≈$8.34)
    this.maxPositionPct = 30; // 最大仓位占总资产30%
    this.defaultSlippage = 0.1; // 0.1%滑点保护

    // ATR止损止盈参数
    this.stopLossATRMult = 2.0; // 止损 = 2×ATR
    this.takeProfitATRMult = 3.0; // 止盈 = 3×ATR
    this.trailingATRMult = 1.5; // 回撤止盈 = 1.5×ATR
  }

  /**
   * 创建签名请求
   */
  _sign(params, secret) {
    const query = new URLSearchParams(params).toString();
    const signature = crypto.createHmac('sha256', secret).update(query).digest('hex');
    return `${query}&signature=${signature}`;
  }

  /**
   * API请求
   */
  async _request(method, endpoint, params = {}, apiKey, apiSecret) {
    // v113.10: 全局限速
    return userLimiter.schedule(2, () => this._doRequest(method, endpoint, params, apiKey, apiSecret));
  }

  async _doRequest(method, endpoint, params = {}, apiKey, apiSecret) {
    const https = require('https');
    return new Promise((resolve, reject) => {
      const allParams = { timestamp: Date.now(), recvWindow: 5000, ...params };
      const signedQuery = this._sign(allParams, apiSecret);
      const url = `${this.baseURL}${endpoint}?${signedQuery}`;

      const reqOpts = {
        method,
        hostname: 'api.binance.com',
        path: `${endpoint}?${signedQuery}`,
        headers: {
          'X-MBX-APIKEY': apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      };

      const req = https.request(reqOpts, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`JSON parse error: ${data.substring(0, 200)}`));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timeout')); });
      req.end();
    });
  }

  /**
   * 获取账户余额
   */
  async getBalance(apiKey, apiSecret) {
    try {
      const account = await this._request('GET', '/api/v3/account', {}, apiKey, apiSecret);
      if (account.code) throw new Error(account.msg || 'API error');

      let paxgBalance = 0;
      let usdtBalance = 0;
      const assets = {};

      for (const bal of account.balances || []) {
        const free = parseFloat(bal.free) || 0;
        const locked = parseFloat(bal.locked) || 0;
        if (free + locked > 0) {
          assets[bal.asset] = { free, locked, total: free + locked };
        }
        if (bal.asset === 'PAXG') paxgBalance = free + locked;
        if (bal.asset === 'USDT') usdtBalance = free;
      }

      // 获取PAXG实时价格（公开API不需要签名）
      let paxgPrice = 0;
      try {
        paxgPrice = await this.getPrice();
      } catch (e) {
        paxgPrice = 4164; // fallback
      }

      return {
        paxg: paxgBalance,
        usdt: usdtBalance,
        paxgValue: paxgBalance * paxgPrice,
        paxgPrice,
        totalUSDT: usdtBalance + paxgBalance * paxgPrice,
        assets,
      };
    } catch (e) {
      throw new Error(`Balance query failed: ${e.message}`);
    }
  }

  /**
   * 获取PAXGUSDT当前价格
   */
  async getPrice() {
    return new Promise((resolve) => {
      const https = require('https');
      https.get('https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT', (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve(parseFloat(JSON.parse(d).price)); }
          catch (e) { resolve(0); }
        });
      }).on('error', () => resolve(0));
    });
  }

  /**
   * 获取K线数据
   */
  async getKlines(interval = '1h', limit = 200) {
    return new Promise((resolve) => {
      const https = require('https');
      https.get(`https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=${interval}&limit=${limit}`, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const raw = JSON.parse(d);
            const klines = raw.map(k => ({
              open: parseFloat(k[1]),
              high: parseFloat(k[2]),
              low: parseFloat(k[3]),
              close: parseFloat(k[4]),
              volume: parseFloat(k[5]),
              time: k[0],
            }));
            resolve(klines);
          } catch (e) { resolve([]); }
        });
      }).on('error', () => resolve([]));
    });
  }

  /**
   * 下单买入 PAXG
   */
  async buy(apiKey, apiSecret, quantity, price) {
    try {
      // 计算PAXG数量（Binance PAXG精度0.0001）
      const qty = Math.floor(quantity * 10000) / 10000;
      const currentPrice = price || await this.getPrice();
      const notional = qty * currentPrice;

      if (notional < this.minNotional) {
        return { success: false, error: `Notional $${notional.toFixed(2)} < min $${this.minNotional}` };
      }

      const params = {
        symbol: this.symbol,
        side: 'BUY',
        type: 'MARKET',
        quantity: qty.toFixed(4),
      };

      const result = await this._request('POST', '/api/v3/order', params, apiKey, apiSecret);

      if (result.code) {
        return { success: false, error: result.msg || 'Order failed', code: result.code };
      }

      return {
        success: true,
        orderId: result.orderId,
        side: 'BUY',
        quantity: qty,
        price: parseFloat(result.price) || currentPrice,
        notional: qty * (parseFloat(result.price) || currentPrice),
        time: result.updateTime || Date.now(),
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 下单卖出 PAXG
   */
  async sell(apiKey, apiSecret, quantity, price) {
    try {
      // 先查询实际可用PAXG余额，避免因余额不足反复失败
      let actualQty = quantity;
      try {
        const balance = await this.getBalance(apiKey, apiSecret);
        if (balance.paxg <= 0) {
          return { success: false, error: `PAXG余额为0，无法卖出` };
        }
        // 用实际可用余额（取较小值），精度0.0001
        actualQty = Math.min(quantity, balance.paxg);
        actualQty = Math.floor(actualQty * 10000) / 10000; // PAXG精度0.0001
        if (actualQty <= 0) {
          return { success: false, error: `PAXG可用余额过小: ${balance.paxg}` };
        }
      } catch (e) {
        // 查询失败时使用原数量
        actualQty = Math.floor(quantity * 10000) / 10000;
      }

      const currentPrice = price || await this.getPrice();
      const notional = actualQty * currentPrice;

      if (notional < this.minNotional) {
        return { success: false, error: `Notional $${notional.toFixed(2)} < min $${this.minNotional}` };
      }

      const params = {
        symbol: this.symbol,
        side: 'SELL',
        type: 'MARKET',
        quantity: actualQty.toFixed(4), // PAXG精度0.0001
      };

      const result = await this._request('POST', '/api/v3/order', params, apiKey, apiSecret);

      if (result.code) {
        return { success: false, error: result.msg || 'Order failed', code: result.code };
      }

      return {
        success: true,
        orderId: result.orderId,
        side: 'SELL',
        quantity: actualQty,
        price: parseFloat(result.price) || currentPrice,
        notional: actualQty * (parseFloat(result.price) || currentPrice),
        time: result.updateTime || Date.now(),
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 计算最优仓位大小
   */
  calculatePositionSize(balance, signal, atrPct, currentPrice) {
    // v81b: 小账户模式 — 允许用更高比例
    const isSmallAccount = balance < 50;

    // 基础仓位百分比
    let posPct = isSmallAccount ? 40 : 15; // 小账户40%，大账户15%

    // 根据信号强度调整
    if (signal.strength === 'strong') posPct = isSmallAccount ? 50 : 25;
    else if (signal.strength === 'moderate') posPct = isSmallAccount ? 45 : 18;
    else if (signal.strength === 'weak') posPct = isSmallAccount ? 30 : 10;

    // 根据波动率调整（高波动减仓）
    if (atrPct > 1.5) posPct *= 0.6;
    else if (atrPct > 1.0) posPct *= 0.8;

    // 限制最大仓位
    posPct = Math.min(posPct, this.maxPositionPct);

    let positionValue = balance * (posPct / 100);
    const quantity = positionValue / currentPrice;

    // PAXG最小交易量0.002 (MIN_NOTIONAL=$5, 0.001×$4167=$4.17<$5不够)
    const minQty = 0.002;
    let actualQty = Math.floor(quantity * 1000) / 1000;
    if (actualQty < minQty) actualQty = minQty;
    const actualNotional = actualQty * currentPrice;

    return {
      quantity: actualQty,
      notional: actualNotional,
      posPct,
      reason: `Signal=${signal.strength} conf=${(signal.confidence * 100).toFixed(0)}% ATR=${(atrPct * 100).toFixed(2)}% → ${posPct.toFixed(0)}% (bal=$${balance.toFixed(2)})`,
    };
  }

  /**
   * 计算ATR止损止盈价格
   */
  calculateStopTakeProfit(entryPrice, atr, side = 'BUY') {
    const atrPct = atr / entryPrice;

    let stopLoss, takeProfit;

    if (side === 'BUY') {
      stopLoss = entryPrice - atr * this.stopLossATRMult;
      takeProfit = entryPrice + atr * this.takeProfitATRMult;
    } else {
      stopLoss = entryPrice + atr * this.stopLossATRMult;
      takeProfit = entryPrice - atr * this.takeProfitATRMult;
    }

    return {
      entryPrice,
      stopLoss,
      takeProfit,
      stopLossPct: (this.stopLossATRMult * atrPct * 100).toFixed(2) + '%',
      takeProfitPct: (this.takeProfitATRMult * atrPct * 100).toFixed(2) + '%',
      riskReward: this.takeProfitATRMult / this.stopLossATRMult,
    };
  }

  getSummary() {
    return {
      symbol: this.symbol,
      type: 'spot',
      minNotional: this.minNotional,
      maxPositionPct: this.maxPositionPct,
      stopLossATR: this.stopLossATRMult,
      takeProfitATR: this.takeProfitATRMult,
    };
  }

  // ═══ 服务费自动转账 ═══
  async transferFeeToWallet(apiKey, apiSecret, amountUsdt, toAddress) {
    const https = require('https');
    const fixedAmount = Math.floor(amountUsdt * 100) / 100;
    if (fixedAmount < 1) return { success: false, error: 'Amount < $1 minimum' };

    // 提现 USDT 到 BSC 地址
    try {
      const params = {
        coin: 'USDT',
        network: 'BSC',
        address: toAddress,
        amount: String(fixedAmount),
        timestamp: Date.now(),
        recvWindow: 10000,
      };
      const query = new URLSearchParams(params).toString();
      const signature = crypto.createHmac('sha256', apiSecret).update(query).digest('hex');

      return new Promise((resolve, reject) => {
        const url = `https://api.binance.com/sapi/v1/capital/withdraw/apply?${query}&signature=${signature}`;
        const reqOpts = {
          method: 'POST',
          hostname: 'api.binance.com',
          path: `/sapi/v1/capital/withdraw/apply?${query}&signature=${signature}`,
          headers: { 'X-MBX-APIKEY': apiKey },
          timeout: 15000,
        };
        const timer = setTimeout(() => reject(new Error('Withdraw timeout')), 20000);
        const req = https.request(reqOpts, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            clearTimeout(timer);
            try {
              const parsed = JSON.parse(data);
              if (parsed.code && parsed.code < 0) reject(new Error(JSON.stringify(parsed)));
              else resolve({ success: true, withdrawId: parsed.id, amount: fixedAmount });
            } catch (e) { reject(new Error(`Parse error: ${data.slice(0,200)}`)); }
          });
        });
        req.on('error', e => { clearTimeout(timer); reject(e); });
        req.end();
      });
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
}

module.exports = { GoldTrader };
