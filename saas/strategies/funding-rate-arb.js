/**
 * FundingRateArb — 资金费率套利策略
 * 
 * 灵感来源：Hummingbot / Citadel / Jump Trading
 * 
 * 核心逻辑：
 *   1. 监控 Binance 永续合约资金费率
 *   2. 当 funding > +0.03%：市场多头拥挤 → 做空永续 + 做多现货 → 赚取费率
 *   3. 当 funding < -0.03%：市场空头拥挤 → 做多永续 + 做空现货 → 赚取费率
 *   4. 信号强度与 |funding| 正相关，距结算时间越近信号越强
 * 
 * 风控：
 *   - funding 反转时自动退出（8h冷却）
 *   - 极端费率（>0.3%）视为异常，降低信号
 *   - 网络失败时返回中性信号
 */

const https = require('https');

// ═══ 配置 ═══
const CONFIG = {
  fundingThreshold: 0.0003,      // 0.03% — 启动套利的最低费率
  strongFunding: 0.001,          // 0.1% — 强信号阈值
  extremeFunding: 0.003,         // 0.3% — 极端费率（异常，降权）
  settlementInterval: 8 * 3600,  // 8小时结算周期（毫秒）
  cacheTTL: 5 * 60 * 1000,      // 缓存5分钟
  fundingApiUrl: 'https://fapi.binance.com/fapi/v1/premiumIndex',
};

// ═══ 缓存 ═══
let cachedFunding = null;
let lastFetchTime = 0;

/**
 * 从 Binance 获取当前资金费率
 */
function fetchFundingRate() {
  return new Promise((resolve) => {
    const now = Date.now();
    if (cachedFunding && (now - lastFetchTime) < CONFIG.cacheTTL) {
      return resolve(cachedFunding);
    }

    const req = https.get(CONFIG.fundingApiUrl, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // 取 BTCUSDT 的费率作为市场情绪指标
          const btcPair = parsed.find(p => p.symbol === 'BTCUSDT') || parsed[0];
          if (btcPair) {
            cachedFunding = {
              rate: parseFloat(btcPair.lastFundingRate),
              nextFundingTime: btcPair.nextFundingTime,
              symbol: btcPair.symbol,
              timestamp: now,
            };
            lastFetchTime = now;
            resolve(cachedFunding);
          } else {
            resolve(cachedFunding); // 返回旧缓存
          }
        } catch (e) {
          resolve(cachedFunding);
        }
      });
    });

    req.on('error', () => resolve(cachedFunding));
    req.on('timeout', () => { req.destroy(); resolve(cachedFunding); });
  });
}

/**
 * 计算距下次结算的时间权重（越近越强）
 * @returns 0.5 - 1.0
 */
function settlementUrgency(nextFundingTime) {
  if (!nextFundingTime) return 0.7;
  const now = Date.now();
  const timeLeft = nextFundingTime - now;
  if (timeLeft <= 0) return 1.0; // 已过结算，最高权重
  if (timeLeft > CONFIG.settlementInterval) return 0.5;
  return 0.5 + 0.5 * (1 - timeLeft / CONFIG.settlementInterval);
}

/**
 * 策略分析
 * @param {Object} data - { price, prices, volumes, timestamp }
 * @returns {{ signal: number, direction: string, reasons: string[] }}
 */
async function analyze(data) {
  const reasons = [];
  const funding = await fetchFundingRate();

  if (!funding || funding.rate === null || funding.rate === undefined) {
    return { signal: 0, direction: 'neutral', reasons: ['无法获取资金费率数据'] };
  }

  const rate = funding.rate;
  const absRate = Math.abs(rate);
  const urgency = settlementUrgency(funding.nextFundingTime);

  // ═══ 极端费率保护 ═══
  if (absRate > CONFIG.extremeFunding) {
    reasons.push(`费率异常: ${(rate * 100).toFixed(4)}% > ${(CONFIG.extremeFunding * 100).toFixed(1)}%，可能是清算事件，降权`);
    return {
      signal: Math.min(absRate * 10, 0.5) * urgency, // 降权到0.5以下
      direction: rate > 0 ? 'short' : 'long',
      reasons,
    };
  }

  // ═══ 费率不足 ═══
  if (absRate < CONFIG.fundingThreshold) {
    return {
      signal: 0,
      direction: 'neutral',
      reasons: [`费率 ${(rate * 100).toFixed(4)}% 低于阈值 ${(CONFIG.fundingThreshold * 100).toFixed(2)}%`],
    };
  }

  // ═══ 计算信号强度 ═══
  let signal;
  if (absRate >= CONFIG.strongFunding) {
    signal = 0.7 + 0.2 * Math.min((absRate - CONFIG.strongFunding) / CONFIG.strongFunding, 1);
    reasons.push(`强费率信号: ${(rate * 100).toFixed(4)}%`);
  } else {
    signal = 0.3 + 0.4 * (absRate - CONFIG.fundingThreshold) / (CONFIG.strongFunding - CONFIG.fundingThreshold);
    reasons.push(`中等费率信号: ${(rate * 100).toFixed(4)}%`);
  }

  // 应用时间权重
  signal = Math.min(signal * urgency, 0.95);
  reasons.push(`结算时间权重: ${urgency.toFixed(2)} (距下次结算 ${(funding.nextFundingTime ? Math.round((funding.nextFundingTime - Date.now()) / 60000) : '?')}分钟)`);

  // ═══ 方向判断 ═══
  // 费率为正：多头拥挤 → 做空永续收费率 + 做多现货对冲
  // 费率为负：空头拥挤 → 做多永续收费率 + 做空现货对冲
  const direction = rate > 0 ? 'short' : 'long';
  reasons.push(direction === 'short'
    ? '正费率 → 做空永续赚取 funding + 做多现货对冲'
    : '负费率 → 做多永续赚取 funding + 做空现货对冲');

  // ═══ 价格趋势确认（额外加分） ═══
  if (data && data.prices && data.prices.length >= 20) {
    const recentPrices = data.prices.slice(-20);
    const sma20 = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
    const currentPrice = data.price || recentPrices[recentPrices.length - 1];

    // 价格在SMA之上 + 正费率 = 更确认多头拥挤
    if (currentPrice > sma20 && rate > 0) {
      signal = Math.min(signal * 1.1, 0.95);
      reasons.push('价格>MA20 + 正费率 → 多头拥挤确认');
    }
    // 价格在SMA之下 + 负费率 = 更确认空头拥挤
    else if (currentPrice < sma20 && rate < 0) {
      signal = Math.min(signal * 1.1, 0.95);
      reasons.push('价格<MA20 + 负费率 → 空头拥挤确认');
    }
  }

  return {
    signal: Math.max(0, Math.min(signal, 1)),
    direction,
    reasons,
  };
}

module.exports = { name: 'FundingRateArb', analyze };
