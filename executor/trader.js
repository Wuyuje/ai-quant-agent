/**
 * Trader - 交易执行引擎
 * 职责：下单、平仓、仓位同步、精度修正
 * 原则：所有不可逆操作前必须链上验证
 */
const crypto = require('crypto');

class Trader {
  constructor(config, pairConfig) {
    this.config = config;
    this.pairConfig = pairConfig;
    this.log = (msg) => console.log(`[Trader] ${new Date().toISOString()} ${msg}`);
    this.minNotionalCache = {}; // symbol → minNotional
    this.minNotionalFetched = false;
  }

  // ============ 动态获取 MIN_NOTIONAL ============
  async _fetchMinNotionals() {
    if (this.minNotionalFetched) return;
    try {
      const https = require('https');
      const info = await new Promise((resolve, reject) => {
        https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
        }).on('error', reject);
      });
      for (const s of info.symbols) {
        // 缓存所有 USDT 永续合约（不仅限于 pairConfig 中已有的）
        if (!s.symbol.endsWith('USDT')) continue;
        let minNotional = 5;
        for (const f of s.filters) {
          if (f.filterType === 'MIN_NOTIONAL') minNotional = parseFloat(f.notional || f.minNotional || 5);
        }
        const lotSize = s.filters.find(f => f.filterType === 'LOT_SIZE');
        const minQty = lotSize ? parseFloat(lotSize.minQty) : 0.001;
        // 如果 pairConfig 没有，动态添加；如果已有，用 Binance 实际精度更新
        if (!this.pairConfig[s.symbol]) {
          this.pairConfig[s.symbol] = {
            qtyPrecision: s.quantityPrecision,
            minQty,
            tickSize: s.filters.find(f => f.filterType === 'PRICE_FILTER')?.tickSize || '0.01',
            baseAsset: s.baseAsset,
            category: 'dynamic',
            liquidity: 'C'
          };
        } else {
          // v106: 用 Binance exchangeInfo 的实际精度覆盖静态配置
          this.pairConfig[s.symbol].qtyPrecision = s.quantityPrecision;
          this.pairConfig[s.symbol].minQty = minQty;
        }
        this.minNotionalCache[s.symbol] = { minNotional, minQty, qtyPrecision: s.quantityPrecision };
      }
      this.minNotionalFetched = true;
      this.log(`Fetched MIN_NOTIONAL for ${Object.keys(this.minNotionalCache).length} symbols`);
    } catch (e) {
      this.log(`Failed to fetch MIN_NOTIONAL: ${e.message}`);
      // fallback: 用 pairConfig 中的 minQty 估算
    }
  }

  getMinNotional(symbol, price) {
    if (this.minNotionalCache[symbol]) {
      const cached = this.minNotionalCache[symbol];
      return Math.max(cached.minNotional, cached.minQty * price * 1.02);
    }
    const pair = this.pairConfig[symbol];
    if (pair) return Math.max(5, (pair.minQty || 0.001) * price * 1.02);
    return 5;
  }

  _calcMinQty(symbol, price) {
    const minNotional = this.getMinNotional(symbol, price);
    const pair = this.pairConfig[symbol];
    const step = pair ? Math.pow(10, -pair.qtyPrecision) : 0.01;
    // 反推: qty * price >= minNotional → qty >= minNotional / price
    // 再向上取整到 step 精度
    const rawMinQty = minNotional / price;
    const minQty = Math.ceil(rawMinQty / step) * step;
    return minQty;
  }

  // ============ 签名请求 ============
  _sign(params) {
    const query = new URLSearchParams(params).toString();
    const signature = crypto.createHmac('sha256', this.config.binance.apiSecret).update(query).digest('hex');
    return `${query}&signature=${signature}`;
  }

  async _request(method, path, params = {}) {
    const https = require('https');
    return new Promise((resolve, reject) => {
      const allParams = { timestamp: Date.now(), recvWindow: 5000, ...params };
      const signedQuery = this._sign(allParams);

      const reqOpts = {
        method,
        hostname: 'fapi.binance.com',
        path: `${path}?${signedQuery}`,
        headers: {
          'X-MBX-APIKEY': this.config.binance.apiKey
        },
        timeout: 10000
      };

      const timer = setTimeout(() => reject(new Error('Request timeout')), 15000);
      const req = https.request(reqOpts, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          clearTimeout(timer);
          try {
            const parsed = JSON.parse(data);
            if (parsed.code && parsed.code !== 200) reject(new Error(JSON.stringify(parsed)));
            else resolve(parsed);
          } catch (e) { reject(new Error(`Parse error: ${data.slice(0, 200)}`)); }
        });
      });
      req.on('error', e => { clearTimeout(timer); reject(e); });
      req.end();
    });
  }

  // ============ 精度修正 ============
  fixQty(symbol, qty) {
    // v106: 优先使用 Binance exchangeInfo 的实际精度，而非 trading-pairs.js 的静态配置
    let precision, step;
    if (this.minNotionalCache[symbol] && this.minNotionalCache[symbol].qtyPrecision != null) {
      precision = this.minNotionalCache[symbol].qtyPrecision;
      const cachedMinQty = this.minNotionalCache[symbol].minQty;
      step = cachedMinQty || Math.pow(10, -precision);
    } else if (this.pairConfig[symbol]) {
      const pair = this.pairConfig[symbol];
      precision = pair.qtyPrecision;
      step = Math.pow(10, -pair.qtyPrecision);
    } else {
      precision = 3;
      step = 0.001;
    }
    // v107: 修复浮点数精度问题 — 4134.9/0.1=41348.999... 导致 floor 得到 41348 而非 41349
    // 用 round 替代 floor，避免浮点误差导致数量不匹配
    const scaled = qty / step;
    const fixed = (Math.abs(scaled - Math.round(scaled)) < 1e-9 ? Math.round(scaled) : Math.floor(scaled)) * step;
    return parseFloat(fixed.toFixed(precision));
  }

  fixPrice(symbol, price) {
    const pair = this.pairConfig[symbol];
    if (!pair) return price;
    const step = Math.pow(10, -this._getPricePrecision(pair.tickSize));
    const scaled = price / step;
    const fixed = (Math.abs(scaled - Math.round(scaled)) < 1e-9 ? Math.round(scaled) : Math.floor(scaled)) * step;
    return parseFloat(fixed.toFixed(this._getPricePrecision(pair.tickSize)));
  }

  _getPricePrecision(tickSize) {
    const s = String(tickSize);
    const dot = s.indexOf('.');
    if (dot === -1) return 0;
    return s.length - dot - 1;
  }

  // ============ 账户信息 ============
  async getBalance() {
    const data = await this._request('GET', '/fapi/v3/balance');
    const usdt = data.find(b => b.asset === 'USDT');
    return usdt ? {
      balance: parseFloat(usdt.balance),
      available: parseFloat(usdt.availableBalance || usdt.balance),
      unrealizedPnl: parseFloat(usdt.crossUnPnl || 0)
    } : null;
  }

  async getAllPositions() {
    const data = await this._request('GET', '/fapi/v3/positionRisk');
    const positions = data
      .filter(p => parseFloat(p.positionAmt) !== 0)
      .map(p => {
        const notional = Math.abs(parseFloat(p.notional || 0));
        const initMargin = parseFloat(p.initialMargin || 0);
        // Binance v3 不返回 leverage 字段，用 notional/initialMargin 反推
        let leverage = 1;
        if (initMargin > 0 && notional > 0) {
          leverage = Math.round(notional / initMargin);
        } else if (p.leverage) {
          leverage = parseInt(p.leverage);
        } else {
          leverage = this.config.trading?.defaultLeverage || 6;
        }
        return {
          symbol: p.symbol,
          side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
          qty: Math.abs(parseFloat(p.positionAmt)),
          entryPrice: parseFloat(p.entryPrice),
          markPrice: parseFloat(p.markPrice),
          pnl: parseFloat(p.unRealizedProfit),
          leverage,
          marginType: p.marginType,
          liquidationPrice: parseFloat(p.liquidationPrice || 0),
          timestamp: p.updateTime || Date.now(),  // Binance updateTime = 开仓后最后更新时间（毫秒）
        };
      });
    return positions;
  }

  async getRealPosition(symbol) {
    const all = await this.getAllPositions();
    return all.find(p => p.symbol === symbol) || null;
  }

  // ============ 设置杠杆和保证金模式 ============
  async setupLeverage(symbol, leverage) {
    try {
      // v113.30: 先设逐仓模式 — 保障资金安全，单仓爆仓不影响其他仓位
      await this._request('POST', '/fapi/v1/marginType', {
        symbol, marginType: 'ISOLATED',
      }).catch(() => {}); // 多资产模式可能不支持，忽略错误
      // 设杠杆
      const result = await this._request('POST', '/fapi/v1/leverage', {
        symbol, leverage: String(leverage)
      });
      this.log(`${symbol} ISOLATED ${leverage}x`);
      return result;
    } catch (e) {
      this.log(`${symbol} leverage setup failed: ${e.message}`);
      throw e;
    }
  }

  // ============ 下单核心 ============
  async marketOrder(symbol, side, quantity) {
    const fixedQty = this.fixQty(symbol, quantity);
    // 最小数量检查
    const pair = this.pairConfig[symbol];
    const cached = this.minNotionalCache[symbol];
    const minQty = pair?.minQty || cached?.minQty || 0.001;
    if (fixedQty < minQty) {
      throw new Error(`${symbol} quantity ${fixedQty} below min ${minQty}`);
    }
    // 币安 MIN_NOTIONAL 检查: qty * price >= 5 USDT (不含杠杆)
    const currentPrice = this.marketData?.[symbol]?.price || 0;
    if (currentPrice > 0) {
      const notional = fixedQty * currentPrice;
      if (notional < 5) {
        throw new Error(`${symbol} notional $${notional.toFixed(2)} < min $5 (qty=${fixedQty} price=${currentPrice})`);
      }
    }
    this.log(`${symbol} MARKET ${side} ${fixedQty}`);
    return this._request('POST', '/fapi/v1/order', {
      symbol, side, type: 'MARKET', quantity: fixedQty
    });
  }

  // ============ 开仓 ============
  async openLong(symbol, leverage, positionSize, addMode = false) {
  try {
    await this._fetchMinNotionals();
    const realPos = await this.getRealPosition(symbol);
    if (realPos && !addMode) {
      this.log(`${symbol} ALREADY HAS POSITION: ${realPos.side} ${realPos.qty} - REJECT openLong`);
      return { success: false, reason: 'already_has_position', position: realPos };
    }

    await this.setupLeverage(symbol, leverage);

    const price = this.marketData?.[symbol]?.price || 0;
    if (!price || price <= 0) throw new Error(`${symbol} no price data`);

    const minNotional = this.getMinNotional(symbol, price);
    const minQty = this._calcMinQty(symbol, price);
    // effectiveSize 保证金 × leverage = 名义，但不能小于 minNotional
    // 同时 qty 不能小于 minQty，两者取 MAX
    const minSizeByNotional = minNotional / leverage;
    const minSizeByQty = (minQty * price) / leverage;
    const effectiveSize = Math.max(positionSize, minSizeByNotional, minSizeByQty);
    
    const rawQty = effectiveSize * leverage / price;
    const qty = this.fixQty(symbol, rawQty);

    if (qty <= 0) {
      throw new Error(`${symbol} qty=${qty} (size=$${effectiveSize.toFixed(2)} lev=${leverage}x price=${price} minNotional=$${minNotional.toFixed(0)} minQty=${minQty})`);
    }
    
    const finalNotional = qty * price;
    this.log(`${symbol} openLong: qty=${qty} notional=$${finalNotional.toFixed(2)} effectiveSize=$${effectiveSize.toFixed(2)} minNotional=$${minNotional.toFixed(0)}`);

    const result = await this.marketOrder(symbol, 'BUY', qty);
    return { success: true, order: result, side: 'LONG', qty, leverage, price };
  } catch(e) {
    const msg = e.message || String(e);
    if (msg.includes('-1111') || msg.includes('Precision')) {
      this.log(`${symbol} 精度错误: ${msg}`);
      return { success: false, reason: 'precision_error', error: msg };
    }
    throw e;
  }
  }

  async openShort(symbol, leverage, positionSize, addMode = false) {
  try {
    await this._fetchMinNotionals();
    const realPos = await this.getRealPosition(symbol);
    if (realPos && !addMode) {
      this.log(`${symbol} ALREADY HAS POSITION: ${realPos.side} ${realPos.qty} - REJECT openShort`);
      return { success: false, reason: 'already_has_position', position: realPos };
    }

    await this.setupLeverage(symbol, leverage);

    const price = this.marketData?.[symbol]?.price || 0;
    if (!price || price <= 0) throw new Error(`${symbol} no price data`);

    const minNotional = this.getMinNotional(symbol, price);
    const minQty = this._calcMinQty(symbol, price);
    const minSizeByNotional = minNotional / leverage;
    const minSizeByQty = (minQty * price) / leverage;
    const effectiveSize = Math.max(positionSize, minSizeByNotional, minSizeByQty);
    
    const rawQty = effectiveSize * leverage / price;
    const qty = this.fixQty(symbol, rawQty);

    if (qty <= 0) {
      throw new Error(`${symbol} qty=${qty} (size=$${effectiveSize.toFixed(2)} lev=${leverage}x price=${price} minNotional=$${minNotional.toFixed(0)} minQty=${minQty})`);
    }
    
    const finalNotional = qty * price;
    this.log(`${symbol} openShort: qty=${qty} notional=$${finalNotional.toFixed(2)} effectiveSize=$${effectiveSize.toFixed(2)} minNotional=$${minNotional.toFixed(0)}`);

    const result = await this.marketOrder(symbol, 'SELL', qty);
    return { success: true, order: result, side: 'SHORT', qty, leverage, price };
  } catch(e) {
    const msg = e.message || String(e);
    if (msg.includes('-1111') || msg.includes('Precision')) {
      this.log(`${symbol} 精度错误: ${msg}`);
      return { success: false, reason: 'precision_error', error: msg };
    }
    throw e;
  }
  }

  // ============ 平仓（v99: 小仓位reduceOnly修复） ============
  async closePosition(symbol) {
    const realPos = await this.getRealPosition(symbol);
    if (!realPos) {
      this.log(`${symbol} no position to close`);
      return { success: true, reason: 'already_closed' };
    }

    const closeSide = realPos.side === 'LONG' ? 'SELL' : 'BUY';
    
    try {
      // 先尝试正常平仓（但跳过 notional 检查，因为平仓不应被 min notional 限制）
      // v113.57: 直接用 reduceOnly 全平，绕过 marketOrder 的 notional<$5 拦截
      const fixedQty = this.fixQty(symbol, Math.abs(realPos.qty));
      if (fixedQty > 0) {
        try {
          const result = await this._request('POST', '/fapi/v1/order', {
            symbol,
            side: closeSide,
            type: 'MARKET',
            quantity: fixedQty,
            reduceOnly: 'true'
          });
          this.log(`${symbol} position CLOSED (reduceOnly): ${realPos.side} ${fixedQty} PnL=${realPos.pnl}`);
          return { success: true, order: result, closedSide: realPos.side, pnl: realPos.pnl };
        } catch(e1) {
          this.log(`${symbol} reduceOnly平仓失败: ${e1.message}，尝试原marketOrder...`);
        }
      }
      
      // fallback: 正常 marketOrder（有 notional 检查）
      const result = await this.marketOrder(symbol, closeSide, Math.abs(realPos.qty));
      this.log(`${symbol} position CLOSED: ${realPos.side} ${realPos.qty} PnL=${realPos.pnl}`);
      return { success: true, order: result, closedSide: realPos.side, pnl: realPos.pnl };
    } catch(e) {
      // v113.57: reduceOnly 和 marketOrder 都失败了
      // 最终手段：用最小可平 qty + reduceOnly（Binance 不要求 reduceOnly 满足 min notional）
      const msg = e.message || '';
      this.log(`${symbol} 常规平仓失败: ${msg}，尝试最小qty+reduceOnly...`);
      try {
        const cached = this.minNotionalCache[symbol];
        const minQty = cached?.minQty || 0.001;
        // 用 max(残渣量, minQty) 试试
        const tryQty = Math.max(this.fixQty(symbol, Math.abs(realPos.qty)), minQty);
        const result = await this._request('POST', '/fapi/v1/order', {
          symbol,
          side: closeSide,
          type: 'MARKET',
          quantity: tryQty,
          reduceOnly: 'true'
        });
        this.log(`${symbol} 最小qty reduceOnly平仓成功: ${tryQty}`);
        return { success: true, order: result, closedSide: realPos.side, pnl: realPos.pnl };
      } catch(e2) {
        this.log(`${symbol} ❌ 所有平仓方式都失败: ${e2.message}`);
        return { success: false, reason: 'all_close_methods_failed', error: e2.message };
      }
    }
  }

  // ============ 加仓 ============
  async addPosition(symbol, side, quantity) {
    const realPos = await this.getRealPosition(symbol);
    if (!realPos) {
      this.log(`${symbol} no existing position to add to`);
      return { success: false, reason: 'no_position' };
    }
    if (realPos.side !== side) {
      this.log(`${symbol} cannot add ${side} to existing ${realPos.side}`);
      return { success: false, reason: 'wrong_side' };
    }

    const buySide = side === 'LONG' ? 'BUY' : 'SELL';
    const fixedQty = this.fixQty(symbol, quantity);
    const result = await this.marketOrder(symbol, buySide, fixedQty);
    return { success: true, order: result };
  }

  // 设置行情数据引用（开仓用）
  setMarketData(data) {
    this.marketData = data;
  }
}

module.exports = Trader;
