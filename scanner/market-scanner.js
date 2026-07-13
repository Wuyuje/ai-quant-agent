/**
 * Market Scanner v8 — 动态市场扫描与精选
 * 
 * 核心功能：
 *   1. 扫描 Binance 全量 USDT 永续合约（~500+）
 *   2. 多维度评分：趋势强度 / 波动率 / 流动性 / 资金费率 / RSI区间
 *   3. 成本核算：手续费 + 资金费率 → 要求预期利润 > 成本 x 3
 *   4. 输出精选候选列表（按综合得分排序）
 * 
 * 筛选层级（逐步淘汰）：
 *   Layer 1: 流动性过滤 — 日交易量 > $30M，排除垃圾币
 *   Layer 2: 趋势过滤 — MA方向明确，不选横盘
 *   Layer 3: RSI 过滤 — 不选极端区域（RSI<20 或 >80）
 *   Layer 4: 费率过滤 — 资金费率年化 > 30% 的反向不选
 *   Layer 5: 成本验算 — 预期利润 < 成本x3 的不选
 *   Layer 6: 排序精选 — 综合得分排名，取前 N 个
 */

const https = require('https');

class MarketScanner {
  constructor(config) {
    this.config = config;
    this.baseURL = config.binance?.futuresBase || 'https://fapi.binance.com';
    this.cache = new Map();        // symbol → scan result
    this.cacheTTL = 300000;        // 5分钟缓存
    this.lastScanTime = 0;
    this.lastScanResult = [];
    this.log = (msg) => console.log(`[Scanner] ${new Date().toISOString()} ${msg}`);
  }

  // ============ HTTP 工具 ============
  _fetch(url, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${url}`)), timeout);
      https.get(url, { timeout }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
      }).on('error', e => { clearTimeout(timer); reject(e); });
    });
  }

  // ============ Layer 1: 批量拉取基础数据 ============
  async fetchMarketOverview() {
    // 并行拉取 ticker + 资金费率 + 合约信息
    const [tickers, fundingRates, exchangeInfo] = await Promise.all([
      this._fetch(`${this.baseURL}/fapi/v1/ticker/24hr`),
      this._fetch(`${this.baseURL}/fapi/v1/premiumIndex`),
      this._fetch(`${this.baseURL}/fapi/v1/exchangeInfo`),
    ]);

    // 构建 lookup
    const tickerMap = {};
    for (const t of tickers) {
      if (!t.symbol.endsWith('USDT')) continue;
      tickerMap[t.symbol] = {
        price: parseFloat(t.lastPrice),
        volume24h: parseFloat(t.quoteVolume),
        change24h: parseFloat(t.priceChangePercent),
        high24h: parseFloat(t.highPrice),
        low24h: parseFloat(t.lowPrice),
        count: parseInt(t.count),
      };
    }

    const fundingMap = {};
    for (const f of fundingRates) {
      fundingMap[f.symbol] = {
        rate: parseFloat(f.lastFundingRate),
        markPrice: parseFloat(f.markPrice),
      };
    }

    // 构建合约信息
    const contractMap = {};
    for (const s of exchangeInfo.symbols) {
      if (s.contractType !== 'PERPETUAL' || s.quoteAsset !== 'USDT' || s.status !== 'TRADING') continue;
      const lotFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
      const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER');
      const minNotional = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
      contractMap[s.symbol] = {
        baseAsset: s.baseAsset,
        qtyPrecision: s.quantityPrecision,
        pricePrecision: s.pricePrecision,
        minQty: lotFilter ? parseFloat(lotFilter.minQty) : 0,
        stepSize: lotFilter ? parseFloat(lotFilter.stepSize) : 0,
        tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : 0,
        minNotional: minNotional ? parseFloat(minNotional.notional || minNotional.minNotional || 5) : 5,
      };
    }

    return { tickerMap, fundingMap, contractMap };
  }

  // ============ Layer 2: K线批量拉取（分批，避免限速）============
  async fetchKlinesBatch(symbols, interval = '1h', limit = 50) {
    // 每批5个，间隔200ms
    const batchSize = 5;
    const results = {};
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const promises = batch.map(async (sym) => {
        try {
          const url = `${this.baseURL}/fapi/v1/klines?symbol=${sym}&interval=${interval}&limit=${limit}`;
          const data = await this._fetch(url);
          results[sym] = data.map(k => ({
            time: k[0],
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
            trades: parseInt(k[8]),
          }));
        } catch (e) {
          // 跳过失败的
        }
      });
      await Promise.all(promises);
      if (i + batchSize < symbols.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
    return results;
  }

  // ============ 技术指标计算 ============
  _sma(arr, period) {
    if (arr.length < period) return arr[arr.length - 1] || 0;
    const slice = arr.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
  }

  _rsi(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    const changes = [];
    for (let i = closes.length - period; i < closes.length; i++) {
      changes.push(closes[i] - closes[i - 1]);
    }
    const gains = changes.filter(c => c > 0);
    const losses = changes.filter(c => c < 0).map(c => Math.abs(c));
    const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  _atr(highs, lows, period = 14) {
    if (highs.length < 2) return 0;
    const trs = [];
    for (let i = Math.max(1, highs.length - period); i < highs.length; i++) {
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - highs[i - 1]),
        Math.abs(lows[i] - lows[i - 1])
      );
      trs.push(tr);
    }
    return trs.reduce((a, b) => a + b, 0) / trs.length;
  }

  _ema(arr, period) {
    if (arr.length < period) return arr[arr.length - 1] || 0;
    const k = 2 / (period + 1);
    let ema = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < arr.length; i++) {
      ema = arr[i] * k + ema * (1 - k);
    }
    return ema;
  }

  calculateTechScore(klines) {
    if (!klines || klines.length < 30) return null;

    const closes = klines.map(k => k.close);
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);
    const volumes = klines.map(k => k.volume);

    const price = closes[closes.length - 1];
    const ma7 = this._sma(closes, 7);
    const ma25 = this._sma(closes, 25);
    const ema12 = this._ema(closes, 12);
    const ema26 = this._ema(closes, 26);
    const rsi = this._rsi(closes, 14);
    const atr = this._atr(highs, lows, 14);
    const atrPercent = (atr / price) * 100;

    // MA7方向
    const ma7Prev = this._sma(closes.slice(0, -1), 7);
    const ma7Direction = ma7 > ma7Prev * 1.0001 ? 'up' : ma7 < ma7Prev * 0.9999 ? 'down' : 'flat';

    // 价格vs MA
    const priceVsMa7 = price > ma7 ? 'above' : 'below';
    const priceVsMa25 = price > ma25 ? 'above' : 'below';

    // MA7 vs MA25 交叉
    const ma7AboveMa25 = ma7 > ma25;
    const prevMa7 = this._sma(closes.slice(0, -1), 7);
    const prevMa25 = this._sma(closes.slice(0, -1), 25);
    const goldenCross = prevMa7 <= prevMa25 && ma7 > ma25;
    const deathCross = prevMa7 >= prevMa25 && ma7 < ma25;

    // MACD
    const macdLine = ema12 - ema26;
    const prevEma12 = this._ema(closes.slice(0, -1), 12);
    const prevEma26 = this._ema(closes.slice(0, -1), 26);
    const prevMacd = prevEma12 - prevEma26;
    const macdRising = macdLine > prevMacd;

    // 成交量
    const volSma = this._sma(volumes, 20);
    const currentVol = volumes[volumes.length - 1];
    const volRatio = volSma > 0 ? currentVol / volSma : 1;

    // 24h 涨跌幅（从最近24根1h K线算）
    const h24 = klines.slice(-24);
    const change24h = h24.length > 1 ? ((price - h24[0].open) / h24[0].open) * 100 : 0;

    return {
      price, ma7, ma25, rsi, atr, atrPercent,
      ma7Direction, priceVsMa7, priceVsMa25,
      goldenCross, deathCross,
      macdLine, macdRising,
      volRatio, change24h,
      ma7AboveMa25,
    };
  }

  /**
   * 计算趋势得分（0~1）
   */
  _scoreTrend(tech) {
    let score = 0;
    const reasons = [];

    // MA方向一致 (0~0.3)
    if (tech.ma7Direction !== 'flat') score += 0.15;
    if (tech.ma7AboveMa25) { score += 0.1; reasons.push('MA7>MA25'); }
    else { score -= 0.05; }

    // 价格在MA上方/下方 (0~0.15)
    if (tech.priceVsMa7 === 'above' && tech.ma7Direction === 'up') { score += 0.15; reasons.push('多头排列'); }
    else if (tech.priceVsMa7 === 'below' && tech.ma7Direction === 'down') { score += 0.15; reasons.push('空头排列'); }
    else if (tech.priceVsMa7 === 'above') { score += 0.05; }
    else { score -= 0.05; }

    // 金叉/死叉 (0~0.2)
    if (tech.goldenCross) { score += 0.2; reasons.push('金叉'); }
    if (tech.deathCross) { score += 0.2; reasons.push('死叉'); }

    // MACD (0~0.1)
    if (tech.macdRising && tech.macdLine > 0) { score += 0.1; reasons.push('MACD↑'); }
    else if (!tech.macdRising && tech.macdLine < 0) { score += 0.1; reasons.push('MACD↓'); }

    // 成交量确认 (0~0.1)
    if (tech.volRatio > 1.2) { score += 0.1; reasons.push('放量'); }

    // 24h趋势 (0~0.1)
    if (Math.abs(tech.change24h) > 3) { score += 0.1; reasons.push('强趋势'); }
    else if (Math.abs(tech.change24h) > 1) { score += 0.05; }

    return { score: Math.max(0, Math.min(1, score)), reasons };
  }

  /**
   * 计算波动率得分（0~1）— 高波动 = 高得分（有利润空间）
   */
  _scoreVolatility(atrPercent, price) {
    // ATR% 在 1~5% 最佳；太低没利润，太高风险大
    if (atrPercent < 0.3) return 0;     // 太低
    if (atrPercent < 0.8) return 0.3;   // 偏低
    if (atrPercent < 2.0) return 0.8;   // 最佳区间
    if (atrPercent < 4.0) return 0.6;   // 偏高
    if (atrPercent < 8.0) return 0.3;   // 过高
    return 0.1;                          // 极端波动
  }

  /**
   * 计算流动性得分（0~1）
   */
  _scoreLiquidity(volume24h) {
    if (volume24h > 5e9) return 1.0;    // BTC/ETH 级别
    if (volume24h > 1e9) return 0.9;    // SOL 级别
    if (volume24h > 500e6) return 0.8;
    if (volume24h > 200e6) return 0.7;
    if (volume24h > 100e6) return 0.6;
    if (volume24h > 50e6) return 0.5;
    if (volume24h > 30e6) return 0.3;
    return 0.1;
  }

  /**
   * 计算资金费率适配得分
   * 做多时收正费率有利，做空时收负费率有利
   */
  _scoreFunding(fundingRate, direction) {
    // 费率绝对值 > 0.05%（年化 ~55%）就很高
    const annual = Math.abs(fundingRate) * 3 * 365 * 100;
    if (annual > 100) return -0.3;  // 极端费率，成本太高
    if (annual > 50) return -0.15;
    if (annual > 30) return -0.05;

    // 正费率做多要付费，负费率做空要付费
    if (direction === 'LONG' && fundingRate > 0.0005) return -0.1; // 做多 + 高正费率 = 不利
    if (direction === 'SHORT' && fundingRate < -0.0005) return -0.1;

    // 反过来收费率
    if (direction === 'LONG' && fundingRate < -0.0003) return 0.1;  // 做多收负费率
    if (direction === 'SHORT' && fundingRate > 0.0003) return 0.1;  // 做空收正费率

    return 0;
  }

  /**
   * 成本核算：开仓到平仓的预估成本
   */
  estimateCost(price, direction, leverage, holdHours, fundingRate, tradeAmountUsd) {
    // 手续费：taker 0.04% 开 + 0.04% 平 = 0.08%
    const feeOpen = tradeAmountUsd * 0.0004;
    const feeClose = tradeAmountUsd * 0.0004;

    // 资金费率：每8小时收一次
    const fundingCost = tradeAmountUsd * Math.abs(fundingRate) * Math.ceil(holdHours / 8);

    // 滑点估算：小币 0.05%，大币 0.02%
    const slippage = tradeAmountUsd * (tradeAmountUsd < 50 ? 0.0005 : 0.0002);

    const totalCost = feeOpen + feeClose + fundingCost + slippage;
    const costPercent = (totalCost / tradeAmountUsd) * 100;

    return {
      feeOpen,
      feeClose,
      fundingCost,
      slippage,
      totalCost,
      costPercent,
      minProfitPercent: costPercent * 3,  // 最低预期利润 = 成本 x 3
    };
  }

  // ============ 主扫描流程 ============
  /**
   * @param {object} options
   * @param {number} options.minVolume - 最低日交易量 USDT（默认 30M）
   * @param {number} options.maxResults - 最多返回几个（默认 15）
   * @param {number} options.lookbackHours - K线回溯小时数（默认 48）
   * @param {object} options.accountInfo - 账户余额/持仓信息（用于成本核算）
   */
  async scan(options = {}) {
    const {
      minVolume = 30e6,
      maxResults = 15,
      lookbackHours = 48,
      accountInfo = null,
    } = options;

    // 缓存检查（5分钟内不重复扫描）
    if (Date.now() - this.lastScanTime < this.cacheTTL && this.lastScanResult.length > 0) {
      this.log(`使用缓存（${Math.round((Date.now() - this.lastScanTime) / 1000)}秒前扫描，${this.lastScanResult.length}个候选）`);
      return this.lastScanResult;
    }

    const t0 = Date.now();
    this.log('开始全市场扫描...');

    // Layer 1: 拉取全量数据
    const { tickerMap, fundingMap, contractMap } = await this.fetchMarketOverview();

    // 过滤：日交易量 > minVolume 的 USDT 永续合约
    const candidates = Object.keys(tickerMap).filter(sym => {
      if (!sym.endsWith('USDT')) return false;
      const tk = tickerMap[sym];
      if (tk.volume24h < minVolume) return false;
      if (!contractMap[sym]) return false;
      return true;
    });

    this.log(`Layer 1 流动性过滤: ${candidates.length} 个候选（日量 > $${(minVolume / 1e6).toFixed(0)}M）`);

    if (candidates.length === 0) {
      this.log('⚠️ 无候选币');
      return [];
    }

    // Layer 2: 批量拉 K线（4h 周期，趋势更清晰、噪音更少）
    const klines = await this.fetchKlinesBatch(candidates, '4h', lookbackHours * 2);
    this.log(`K线数据获取完成: ${Object.keys(klines).length}/${candidates.length} 个`);

    // Layer 3: 逐个评分
    const scored = [];
    for (const sym of candidates) {
      const tk = tickerMap[sym];
      const fr = fundingMap[sym];
      const ct = contractMap[sym];
      const klineData = klines[sym];

      if (!klineData || klineData.length < 30) continue;

      const tech = this.calculateTechScore(klineData);
      if (!tech) continue;

      // RSI 过滤：极端区域排除（收紧到 20/80）
      if (tech.rsi < 20 || tech.rsi > 80) continue;

      // 计算趋势方向
      let direction = 'WAIT';
      const trendResult = this._scoreTrend(tech);

      if (trendResult.score >= 0.3) {
        // 确定方向
        if (tech.ma7Direction === 'up' && tech.priceVsMa7 === 'above') {
          direction = 'LONG';
        } else if (tech.ma7Direction === 'down' && tech.priceVsMa7 === 'below') {
          direction = 'SHORT';
        } else if (tech.goldenCross) {
          direction = 'LONG';
        } else if (tech.deathCross) {
          direction = 'SHORT';
        }
      }

      if (direction === 'WAIT') continue;

      // RSI 方向一致性
      if (direction === 'LONG' && tech.rsi > 70) continue;
      if (direction === 'SHORT' && tech.rsi < 30) continue;

      const trendScore = trendResult.score;
      const volScore = this._scoreVolatility(tech.atrPercent, tech.price);
      const liqScore = this._scoreLiquidity(tk.volume24h);
      const fundScore = this._scoreFunding(fr?.rate || 0, direction);

      // 成本核算（holdHours=12 匹配 4h K线持仓周期）
      const accountBalance = accountInfo?.balance || 80;
      const tradeAmount = Math.min(accountBalance * 0.1, 50);
      const costInfo = this.estimateCost(
        tech.price, direction, 3, 12,
        fr?.rate || 0, tradeAmount
      );

      // 最小可开金额检查
      const minNotional = ct.minNotional || 5;
      if (tradeAmount < minNotional) continue;

      // 综合得分
      const rawScore = (trendScore * 0.4 + volScore * 0.25 + liqScore * 0.2 + Math.max(0, fundScore) * 0.15);
      // 成本惩罚：成本占比越高，惩罚越大（0.25% 为基准线）
      const costPenalty = costInfo.costPercent > 0.25 ? (costInfo.costPercent - 0.25) * 0.8 : 0;
      // 高波动降权：ATR>6% 扣分
      const volatilityPenalty = tech.atrPercent > 6 ? 0.3 : tech.atrPercent > 4 ? 0.15 : 0;
      // 利润空间硬过滤：预期利润必须 > 成本x3
      const expectedProfitPct = tech.atrPercent * 1.7;
      if (expectedProfitPct < costInfo.minProfitPercent) continue;
      const finalScore = Math.max(0, rawScore - costPenalty - volatilityPenalty);

      if (finalScore < 0.15) continue;

      scored.push({
        symbol: sym,
        direction,
        finalScore,
        trendScore,
        volScore,
        liqScore,
        fundScore,
        rsi: tech.rsi,
        atrPercent: tech.atrPercent,
        price: tech.price,
        ma7Direction: tech.ma7Direction,
        priceVsMa7: tech.priceVsMa7,
        goldenCross: tech.goldenCross,
        deathCross: tech.deathCross,
        volRatio: tech.volRatio,
        change24h: tk.change24h,
        volume24h: tk.volume24h,
        fundingRate: fr?.rate || 0,
        costInfo,
        contractInfo: ct,
        trendReasons: trendResult.reasons,
      });
    }

    // 排序：综合得分降序
    scored.sort((a, b) => b.finalScore - a.finalScore);

    // 不限制候选数量，所有成本核算通过的币都保留（放开频率限制）
    const results = scored;

    const elapsed = Date.now() - t0;
    this.log(`扫描完成: ${elapsed}ms, ${results.length} 个精选候选（成本过滤后）`);

    // 保存状态
    this.lastScanTime = Date.now();
    this.lastScanResult = results;

    return results;
  }

  /**
   * 获取指定币的扫描结果（从缓存）
   */
  getCached(symbol) {
    return this.cache.get(symbol) || null;
  }

  /**
   * 获取扫描摘要（Dashboard 用）
   */
  getSummary() {
    return {
      lastScanTime: this.lastScanTime,
      totalCandidates: this.lastScanResult.length,
      topPicks: this.lastScanResult.slice(0, 5).map(r => ({
        symbol: r.symbol,
        direction: r.direction,
        score: r.finalScore.toFixed(2),
        rsi: r.rsi.toFixed(0),
        volume: (r.volume24h / 1e6).toFixed(0) + 'M',
        funding: (r.fundingRate * 100).toFixed(4) + '%',
        cost: r.costInfo.costPercent.toFixed(3) + '%',
      })),
    };
  }
}

module.exports = MarketScanner;
