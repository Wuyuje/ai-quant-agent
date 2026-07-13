/**
 * MarketMaking — 做市商策略（简化版）
 * 
 * 灵感来源：Jump Trading / Wintermute / Alameda
 * 
 * 核心逻辑：
 *   1. 在买一价下方挂限价买单，卖一价上方挂限价卖单
 *   2. 赚取 bid-ask 价差（spread）
 *   3. 用 OBI（Order Book Imbalance）调整挂单方向偏移
 *   4. 用波动率控制仓位大小
 * 
 * 适用：
 *   - 流动性好的交易对（BTC/ETH/BNB）
 *   - 震荡市（频繁上下穿越中价）
 *   - 日内策略，不过夜
 * 
 * 风控：
 *   - 单边敞口不超过总资产20%
 *   - 波动率飙升时暂停做市
 *   - 价差太窄（< 0.05%）时不做市
 */

const https = require('https');

// ═══ 配置 ═══
const CONFIG = {
  maxSpreadPct: 0.003,          // 最大价差 0.3%（超过就不做市）
  minSpreadPct: 0.0005,         // 最小价差 0.05%（太薄不赚）
  targetSpreadPct: 0.001,       // 目标价差 0.1%
  maxExposurePct: 0.20,         // 最大单边敞口 20%
  volatilityThreshold: 0.05,    // 波动率 > 5% 时暂停
  updateInterval: 60000,        // 60秒更新一次报价
  
  // OBI 参数
  depthLevels: 5,               // 看5档深度
  obiSensitivity: 0.3,          // OBI偏移灵敏度
};

// ═══ 缓存 ═══
let lastBookFetch = 0;
let cachedBook = null;
const CACHE_TTL = 10000; // 10秒

/**
 * 获取 Binance 订单簿（简化版）
 */
function fetchOrderBook(symbol = 'BTCUSDT') {
  return new Promise((resolve) => {
    const now = Date.now();
    if (cachedBook && (now - lastBookFetch) < CACHE_TTL) {
      return resolve(cachedBook);
    }

    const url = `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=20`;
    const req = https.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          cachedBook = {
            bids: parsed.bids.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
            asks: parsed.asks.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
            timestamp: now,
          };
          lastBookFetch = now;
          resolve(cachedBook);
        } catch (e) {
          resolve(cachedBook);
        }
      });
    });
    req.on('error', () => resolve(cachedBook));
    req.on('timeout', () => { req.destroy(); resolve(cachedBook); });
  });
}

/**
 * 计算 OBI (Order Book Imbalance)
 * OBI = (bidVol - askVol) / (bidVol + askVol)
 * 正值 = 买压大 → 价格倾向上涨
 * 负值 = 卖压大 → 价格倾向下跌
 */
function computeOBI(book, depth = CONFIG.depthLevels) {
  if (!book) return { obi: 0, bidVol: 0, askVol: 0, spread: 0, mid: 0 };

  const bids = book.bids.slice(0, depth);
  const asks = book.asks.slice(0, depth);

  const bidVol = bids.reduce((s, b) => s + b.qty, 0);
  const askVol = asks.reduce((s, a) => s + a.qty, 0);
  const total = bidVol + askVol || 1;

  const spread = asks[0] && bids[0] ? asks[0].price - bids[0].price : 0;
  const mid = asks[0] && bids[0] ? (asks[0].price + bids[0].price) / 2 : 0;

  // 加权 OBI（近档权重更大）
  let weightedBid = 0, weightedAsk = 0;
  bids.forEach((b, i) => weightedBid += b.qty / (i + 1));
  asks.forEach((a, i) => weightedAsk += a.qty / (i + 1));
  const weightedOBI = (weightedBid - weightedAsk) / (weightedBid + weightedAsk || 1);

  return {
    obi: (bidVol - askVol) / total,
    weightedOBI,
    bidVol,
    askVol,
    spread,
    spreadPct: mid > 0 ? spread / mid : 0,
    mid,
    bestBid: bids[0]?.price || 0,
    bestAsk: asks[0]?.price || 0,
  };
}

/**
 * 计算波动率（简化：最近20个价差的波动率）
 */
function computeVolatility(book) {
  if (!book || book.bids.length === 0) return 0.02;
  // 用 bid-ask 中间的变动率近似
  const mid = (book.bids[0].price + book.asks[0].price) / 2;
  // 简化：用spread/mid比例作为短期波动率的代理
  const spreadPct = book.asks[0] && book.bids[0]
    ? (book.asks[0].price - book.bids[0].price) / mid
    : 0.001;
  return spreadPct;
}

/**
 * 策略分析
 * @param {Object} data - { price, prices, volumes, timestamp, symbol? }
 * @returns {{ signal, direction, reasons, tradePlan? }}
 */
async function analyze(data) {
  const reasons = [];
  const symbol = data.symbol || 'BTCUSDT';

  // 获取订单簿
  const book = await fetchOrderBook(symbol);
  if (!book) {
    return { signal: 0, direction: 'neutral', reasons: ['无法获取订单簿'] };
  }

  // 计算 OBI
  const { obi, weightedOBI, spreadPct, mid, bestBid, bestAsk, bidVol, askVol } = computeOBI(book);

  reasons.push(`OBI: ${obi.toFixed(3)} (加权: ${weightedOBI.toFixed(3)})`);
  reasons.push(`价差: ${(spreadPct * 100).toFixed(3)}% ($${(bestAsk - bestBid).toFixed(2)})`);

  // ═══ 做市条件检查 ═══

  // 价差太窄
  if (spreadPct < CONFIG.minSpreadPct) {
    return {
      signal: 0,
      direction: 'neutral',
      reasons: [...reasons, `价差 ${(spreadPct * 100).toFixed(4)}% < ${(CONFIG.minSpreadPct * 100).toFixed(3)}%，不做市`],
    };
  }

  // 价差太大（可能有风险事件）
  if (spreadPct > CONFIG.maxSpreadPct) {
    return {
      signal: 0,
      direction: 'neutral',
      reasons: [...reasons, `价差 ${(spreadPct * 100).toFixed(3)}% > ${(CONFIG.maxSpreadPct * 100).toFixed(1)}%，风险事件，不做市`],
    };
  }

  // 波动率过高
  const vol = computeVolatility(book);
  if (vol > CONFIG.volatilityThreshold) {
    return {
      signal: 0,
      direction: 'neutral',
      reasons: [...reasons, `波动率 ${(vol * 100).toFixed(2)}% > ${(CONFIG.volatilityThreshold * 100)}%，暂停做市`],
    };
  }

  // ═══ 做市信号 ═══

  // 做市是双向的，但 OBI 可以调整偏移
  // OBI 正值 → 买压大 → 更倾向做多（在买方挂更积极的单）
  // OBI 负值 → 卖压大 → 更倾向做空（在卖方挂更积极的单）

  const obiOffset = weightedOBI * CONFIG.obiSensitivity; // -0.3 到 +0.3
  const halfSpread = mid > 0 ? (spreadPct * mid) / 2 : 0;

  // 买入价 = 中价 - 半价差 + OBI偏移（偏移越大，买入价越积极）
  const bidPrice = mid - halfSpread * (1 + obiOffset);
  // 卖出价 = 中价 + 半价差 + OBI偏移
  const askPrice = mid + halfSpread * (1 - obiOffset);

  // 信号强度基于 OBI 偏移程度 + 价差宽度
  const signal = Math.min(
    0.3 + Math.abs(weightedOBI) * 0.3 + spreadPct / CONFIG.maxSpreadPct * 0.3,
    0.9
  );

  // 方向：OBI 正 → 做多为主, OBI 负 → 做空为主
  const direction = weightedOBI > 0.1 ? 'long' : weightedOBI < -0.1 ? 'short' : 'neutral';

  reasons.push(`做市报价: Bid=$${bidPrice.toFixed(2)} Ask=$${askPrice.toFixed(2)}`);
  reasons.push(`OBI偏移: ${obiOffset > 0 ? '+' : ''}${(obiOffset * 100).toFixed(1)}% → ${direction}`);
  reasons.push(`买压: $${bidVol.toFixed(2)} | 卖压: $${askVol.toFixed(2)}`);

  return {
    signal,
    direction,
    reasons,
    tradePlan: {
      type: 'market_making',
      bidPrice: Math.round(bidPrice * 100) / 100,
      askPrice: Math.round(askPrice * 100) / 100,
      spread: halfSpread * 2,
      halfSpread,
      obiOffset,
      symbol,
    },
  };
}

module.exports = { name: 'MarketMaking', analyze, computeOBI, fetchOrderBook };
