/**
 * DeltaNeutral — Delta 中性对冲策略
 * 
 * 灵感来源：Jump Trading / Citadel / Millennium Management
 * 
 * 核心逻辑：
 *   1. 同时做多现货 + 做空永续（或反向），使 delta ≈ 0
 *   2. 利润来源：
 *      a) 正 funding 时做空永续收取资金费
 *      b) 基差收敛（永续溢价回归均值）
 *      c) 波动率收益（两边同时持有，波动越大价差越大）
 *   3. 退出：基差正常化 or funding 反转
 * 
 * 适用场景：
 *   - 牛市末期（funding极高 + 永续溢价大）
 *   - 震荡市（基差反复扩张收缩）
 *   - 不适合：单边暴跌（基差剧烈波动可能穿仓）
 * 
 * 风控：
 *   - 维持保证金充足（两边仓位大小匹配）
 *   - 基差反向扩大 > 0.5% 时紧急平仓
 *   - 单次持仓时间上限 72h
 */

const https = require('https');

// ═══ 配置 ═══
const CONFIG = {
  // 基差参数
  basisThreshold: 0.001,         // 0.1% 基差阈值（永续溢价 vs 现货）
  strongBasis: 0.003,            // 0.3% 强基差
  basisExitThreshold: 0.0005,    // 0.05% 基差正常化退出
  
  // Funding 参数
  fundingThreshold: 0.0002,      // 0.02% funding 阈值
  
  // 风控
  maxBasisAdverse: 0.005,        // 0.5% 基差反向扩大 → 紧急平仓
  maxHoldHours: 72,              // 最大持仓时间
  
  // 缓存
  cacheTTL: 3 * 60 * 1000,      // 3分钟缓存
  fundingApiUrl: 'https://fapi.binance.com/fapi/v1/premiumIndex',
  tickerApiUrl: 'https://fapi.binance.com/fapi/v1/ticker/24hr',
};

// ═══ 缓存 ═══
let cachedMarketData = null;
let lastFetchTime = 0;

function fetchMarketData() {
  return new Promise((resolve) => {
    const now = Date.now();
    if (cachedMarketData && (now - lastFetchTime) < CONFIG.cacheTTL) {
      return resolve(cachedMarketData);
    }

    // 并行请求 funding + ticker
    let fundingData = null;
    let tickerData = null;
    let completed = 0;

    function checkDone() {
      completed++;
      if (completed >= 2) {
        if (fundingData && tickerData) {
          cachedMarketData = { funding: fundingData, ticker: tickerData, timestamp: now };
          lastFetchTime = now;
        }
        resolve(cachedMarketData);
      }
    }

    // Funding rate
    const req1 = https.get(CONFIG.fundingApiUrl, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          fundingData = parsed.find(p => p.symbol === 'BTCUSDT') || parsed[0];
        } catch (e) {}
        checkDone();
      });
    });
    req1.on('error', checkDone);
    req1.on('timeout', () => { req1.destroy(); checkDone(); });

    // 24h ticker (获取 markPrice 和 lastPrice)
    const req2 = https.get(`${CONFIG.tickerApiUrl}?symbol=BTCUSDT`, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          tickerData = JSON.parse(data);
        } catch (e) {}
        checkDone();
      });
    });
    req2.on('error', checkDone);
    req2.on('timeout', () => { req2.destroy(); checkDone(); });
  });
}

/**
 * 分析 Delta Neutral 机会
 * @param {Object} data - { price, prices, timestamp }
 * @returns {{ signal: number, direction: string, reasons: string[], strategyType: string }}
 */
async function analyze(data) {
  const reasons = [];
  const market = await fetchMarketData();

  if (!market || !market.funding || !market.ticker) {
    return {
      signal: 0,
      direction: 'neutral',
      reasons: ['无法获取市场数据'],
      strategyType: 'delta-neutral',
    };
  }

  const fundingRate = parseFloat(market.funding.lastFundingRate) || 0;
  const lastPrice = parseFloat(data.price) || 0;
  const markPrice = parseFloat(market.funding.markPrice) || lastPrice;
  
  // 基差 = (永续价格 - 现货价格) / 现货价格
  const basis = lastPrice > 0 ? (markPrice - lastPrice) / lastPrice : 0;
  const absBasis = Math.abs(basis);
  const absFunding = Math.abs(fundingRate);

  // ═══ 条件1：正基差 + 正费率 = 经典做空永续机会 ═══
  if (basis > CONFIG.basisThreshold && fundingRate > CONFIG.fundingThreshold) {
    let signal = 0.4;
    const reasons_detail = [];

    // 基差贡献
    if (absBasis >= CONFIG.strongBasis) {
      signal += 0.3;
      reasons_detail.push(`强基差: ${(basis * 100).toFixed(3)}%`);
    } else {
      signal += 0.15 * (absBasis / CONFIG.strongBasis);
      reasons_detail.push(`中等基差: ${(basis * 100).toFixed(3)}%`);
    }

    // Funding 贡献
    signal += Math.min(absFunding * 200, 0.2); // funding 0.1% 贡献 0.2
    reasons_detail.push(`Funding: ${(fundingRate * 100).toFixed(4)}%`);

    // 基差偏离均值（越大越有机会回归）
    if (data.prices && data.prices.length >= 50) {
      const recentBasis = data.prices.slice(-50);
      const avgPrice = recentBasis.reduce((a, b) => a + b, 0) / recentBasis.length;
      const currentPrice = data.price || recentBasis[recentBasis.length - 1];
      const deviation = Math.abs(currentPrice - avgPrice) / avgPrice;
      if (deviation > 0.02) {
        signal += 0.1;
        reasons_detail.push(`价格偏离均值 ${(deviation * 100).toFixed(2)}%，基差可能收敛`);
      }
    }

    signal = Math.min(signal, 0.95);
    reasons.push('Delta Neutral 机会: 做空永续 + 做多现货');
    reasons.push(...reasons_detail);
    reasons.push('利润来源: funding收取 + 基差收敛');

    return {
      signal,
      direction: 'long', // 整体偏多（现货多头 + 合约空头 = delta中性）
      reasons,
      strategyType: 'delta-neutral',
    };
  }

  // ═══ 条件2：负基差 + 负费率 = 反向机会 ═══
  if (basis < -CONFIG.basisThreshold && fundingRate < -CONFIG.fundingThreshold) {
    let signal = 0.4;
    const reasons_detail = [];

    if (absBasis >= CONFIG.strongBasis) {
      signal += 0.3;
      reasons_detail.push(`强负基差: ${(basis * 100).toFixed(3)}%`);
    } else {
      signal += 0.15 * (absBasis / CONFIG.strongBasis);
      reasons_detail.push(`中等负基差: ${(basis * 100).toFixed(3)}%`);
    }

    signal += Math.min(absFunding * 200, 0.2);
    reasons_detail.push(`负Funding: ${(fundingRate * 100).toFixed(4)}%`);

    signal = Math.min(signal, 0.95);
    reasons.push('Delta Neutral 反向机会: 做多永续 + 做空现货');
    reasons.push(...reasons_detail);

    return {
      signal,
      direction: 'short',
      reasons,
      strategyType: 'delta-neutral',
    };
  }

  // ═══ 条件3：基差正在扩大，准备进场 ═══
  if (absBasis > CONFIG.basisThreshold * 0.5 && absFunding > CONFIG.fundingThreshold * 0.5) {
    return {
      signal: 0.25,
      direction: 'neutral',
      reasons: [
        `基差 ${(basis * 100).toFixed(3)}% + Funding ${(fundingRate * 100).toFixed(4)}% — 接近阈值，观察中`,
        '等待基差进一步扩大后进场',
      ],
      strategyType: 'delta-neutral',
    };
  }

  return {
    signal: 0,
    direction: 'neutral',
    reasons: [
      `基差 ${(basis * 100).toFixed(3)}%, Funding ${(fundingRate * 100).toFixed(4)}%`,
      '无 Delta Neutral 机会',
    ],
    strategyType: 'delta-neutral',
  };
}

module.exports = { name: 'DeltaNeutral', analyze };
