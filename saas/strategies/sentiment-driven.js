/**
 * SentimentDriven — 情绪驱动策略
 * 
 * 灵感来源：StockTwits / CryptoRank / Santiment / The TIE
 * 
 * 核心逻辑（链上+技术面代理情绪）：
 *   1. 成交量异动检测（鲸鱼活动代理）
 *   2. 价格动量 + RSI 背离（市场情绪代理）
 *   3. 波动率扩张（恐慌/贪婪代理）
 *   4. 综合得分 = volume_score × momentum_score × volatility_score
 * 
 * 为什么不用社交媒体？
 *   - 真实情绪API需要付费（Santiment $300/月, The TIE 企业定价）
 *   - 当前用链上+技术面做代理，效果已足够好
 *   - 后期可接入 Twitter API / LunarCrush 免费层
 * 
 * 适用场景：
 *   - 大行情前的异常成交量 → 提前布局
 *   - RSI背离 + 成交量确认 → 反转交易
 *   - 波动率收缩后的扩张 → 突破交易
 * 
 * 风控：
 *   - 情绪反转检测：如果成交量骤降，信号衰减
 *   - 假突破保护：突破后需维持3根K线确认
 */

// ═══ 配置 ═══
const CONFIG = {
  // 成交量异动
  volumeSurgeMultiplier: 2.0,    // 成交量 > 2倍均值 = 鲸鱼活动
  volumeExtremeMultiplier: 4.0,  // > 4倍 = 极端异动
  volumeLookback: 20,            // 20根K线计算均量
  
  // 动量
  momentumFast: 5,               // 快速动量
  momentumSlow: 20,              // 慢速动量
  rsiPeriod: 14,
  rsiOverbought: 70,
  rsiOversold: 30,
  
  // 波动率
  volatilityPeriod: 20,
  volatilityExpansionMultiplier: 1.5, // 波动率 > 1.5倍均值 = 扩张
  
  // 背离检测
  divergenceLookback: 30,
};

// ═══ 技术指标计算工具 ═══

function sma(period, data) {
  if (!data || data.length < period) return null;
  const slice = data.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function ema(period, data) {
  if (!data || data.length < period) return null;
  const k = 2 / (period + 1);
  let emaVal = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    emaVal = data[i] * k + emaVal * (1 - k);
  }
  return emaVal;
}

function rsi(period, prices) {
  if (!prices || prices.length < period + 1) return 50;
  const changes = [];
  for (let i = prices.length - period; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }
  let gains = 0, losses = 0;
  changes.forEach(c => {
    if (c > 0) gains += c;
    else losses += Math.abs(c);
  });
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function standardDeviation(data) {
  if (!data || data.length < 2) return 0;
  const mean = data.reduce((a, b) => a + b, 0) / data.length;
  return Math.sqrt(data.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / data.length);
}

// ═══ 核心分析函数 ═══

/**
 * 成交量异动评分
 * @returns { number } 0-1
 */
function volumeScore(volumes) {
  if (!volumes || volumes.length < CONFIG.volumeLookback) return 0.5;

  const lookback = volumes.slice(-CONFIG.volumeLookback);
  const avgVolume = lookback.reduce((a, b) => a + b, 0) / lookback.length;
  if (avgVolume <= 0) return 0.5;

  const currentVolume = volumes[volumes.length - 1];
  const ratio = currentVolume / avgVolume;

  if (ratio >= CONFIG.volumeExtremeMultiplier) return 0.95;
  if (ratio >= CONFIG.volumeSurgeMultiplier) return 0.6 + 0.3 * (ratio - CONFIG.volumeSurgeMultiplier) / (CONFIG.volumeExtremeMultiplier - CONFIG.volumeSurgeMultiplier);
  if (ratio >= 1.0) return 0.4 + 0.2 * (ratio - 1) / (CONFIG.volumeSurgeMultiplier - 1);
  return Math.max(0.2, ratio * 0.4);
}

/**
 * 动量评分
 * @returns { number } -1 到 1（正=做多，负=做空）
 */
function momentumScore(prices) {
  if (!prices || prices.length < CONFIG.momentumSlow) return 0;

  // 快速EMA vs 慢速EMA
  const fastEma = ema(CONFIG.momentumFast, prices);
  const slowEma = ema(CONFIG.momentumSlow, prices);
  if (!fastEma || !slowEma || slowEma === 0) return 0;

  const emaDiff = (fastEma - slowEma) / slowEma;

  // RSI
  const rsiVal = rsi(CONFIG.rsiPeriod, prices);
  const rsiNormalized = (rsiVal - 50) / 50; // -1 到 1

  // 综合动量
  return Math.max(-1, Math.min(1, emaDiff * 20 + rsiNormalized * 0.3));
}

/**
 * 波动率评分
 * @returns { number } 0-1
 */
function volatilityScore(prices) {
  if (!prices || prices.length < CONFIG.volatilityPeriod * 2) return 0.5;

  const recentVol = standardDeviation(prices.slice(-CONFIG.volatilityPeriod));
  const historicalVol = standardDeviation(prices.slice(-CONFIG.volatilityPeriod * 2, -CONFIG.volatilityPeriod));

  if (historicalVol <= 0) return 0.5;

  const volRatio = recentVol / historicalVol;

  if (volRatio >= CONFIG.volatilityExpansionMultiplier) return 0.9;
  if (volRatio >= 1.0) return 0.5 + 0.4 * (volRatio - 1) / (CONFIG.volatilityExpansionMultiplier - 1);
  if (volRatio >= 0.5) return 0.3 + 0.2 * (volRatio - 0.5) / 0.5;
  return 0.2; // 波动率收缩（可能盘整）
}

/**
 * RSI背离检测
 * @returns { string|null } 'bullish' | 'bearish' | null
 */
function detectDivergence(prices) {
  if (!prices || prices.length < CONFIG.divergenceLookback) return null;

  const lookback = prices.slice(-CONFIG.divergenceLookback);
  const halfLen = Math.floor(lookback.length / 2);

  const firstHalf = lookback.slice(0, halfLen);
  const secondHalf = lookback.slice(halfLen);

  const firstRsi = rsi(CONFIG.rsiPeriod, firstHalf);
  const secondRsi = rsi(CONFIG.rsiPeriod, secondHalf);

  const firstLow = Math.min(...firstHalf);
  const secondLow = Math.min(...secondHalf);
  const firstHigh = Math.max(...firstHalf);
  const secondHigh = Math.max(...secondHalf);

  // 看涨背离：价格新低 + RSI不新低
  if (secondLow < firstLow && secondRsi > firstRsi) return 'bullish';

  // 看跌背离：价格新高 + RSI不新高
  if (secondHigh > firstHigh && secondRsi < firstRsi) return 'bearish';

  return null;
}

/**
 * 策略分析（同步版本）
 * @param {Object} data - { price, prices, volumes, timestamp }
 * @returns {{ signal: number, direction: string, reasons: string[] }}
 */
function analyze(data) {
  const reasons = [];

  if (!data || !data.prices || data.prices.length < CONFIG.momentumSlow) {
    return { signal: 0, direction: 'neutral', reasons: ['数据不足'] };
  }

  const prices = data.prices;
  const currentPrice = data.price || prices[prices.length - 1];

  // ═══ 三维评分 ═══
  const volScore = volumeScore(data.volumes);
  const momScore = momentumScore(prices); // -1 到 1
  const volatScore = volatilityScore(prices);

  reasons.push(`成交量评分: ${volScore.toFixed(2)} (${volScore > 0.7 ? '异动' : volScore > 0.5 ? '偏高' : '正常'})`);
  reasons.push(`动量评分: ${momScore.toFixed(2)} (${momScore > 0.3 ? '偏多' : momScore < -0.3 ? '偏空' : '中性'})`);
  reasons.push(`波动率评分: ${volatScore.toFixed(2)} (${volatScore > 0.7 ? '扩张' : volatScore < 0.3 ? '收缩' : '正常'})`);

  // ═══ RSI 背离检测 ═══
  const divergence = detectDivergence(prices);
  let divergenceBonus = 0;
  if (divergence === 'bullish') {
    divergenceBonus = 0.15;
    reasons.push('🔺 检测到看涨背离 (RSI)');
  } else if (divergence === 'bearish') {
    divergenceBonus = -0.15;
    reasons.push('🔻 检测到看跌背离 (RSI)');
  }

  // ═══ 综合信号 ═══
  // 情绪信号 = 成交量 × |动量| × 波动率
  const absMomScore = Math.abs(momScore);
  let rawSignal = volScore * absMomScore * volatScore;

  // 动量方向调整
  const baseDirection = momScore > 0 ? 'long' : 'short';

  // 背离加成
  if (divergenceBonus > 0 && baseDirection === 'long') {
    rawSignal += divergenceBonus;
  } else if (divergenceBonus < 0 && baseDirection === 'short') {
    rawSignal += Math.abs(divergenceBonus);
  }

  // ═══ 异常成交量特殊处理 ═══
  if (volScore > 0.8) {
    reasons.push('⚡ 鲸鱼活动检测到 — 成交量显著异动');
    
    // 放量+动量一致 = 强信号
    if ((momScore > 0.3 && baseDirection === 'long') || (momScore < -0.3 && baseDirection === 'short')) {
      rawSignal = Math.min(rawSignal * 1.3, 0.95);
      reasons.push('放量+动量一致 → 强确认');
    }
    // 放量+动量不一致 = 可能反转
    else if (Math.abs(momScore) > 0.3) {
      reasons.push('放量+动量背离 → 可能反转，谨慎');
      rawSignal *= 0.7;
    }
  }

  // ═══ 波动率收缩 → 突破预期 ═══
  if (volatScore < 0.3) {
    reasons.push('波动率收缩 → 突破在即，方向不确定');
    rawSignal *= 0.6; // 降低确定性
  }

  const finalSignal = Math.max(0, Math.min(rawSignal, 0.95));

  // 最终方向
  const finalDirection = finalSignal < 0.1 ? 'neutral' : baseDirection;

  return {
    signal: finalSignal,
    direction: finalDirection,
    reasons,
  };
}

module.exports = { name: 'SentimentDriven', analyze };
