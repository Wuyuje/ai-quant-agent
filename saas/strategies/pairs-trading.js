/**
 * PairsTrading — 均值回归配对交易策略
 * 
 * 灵感来源：Renaissance Technologies (Medallion Fund) / D.E. Shaw
 * 
 * 核心逻辑：
 *   1. 检测价格序列的均值回归特性（简化协整检验）
 *   2. 计算 Z-Score（当前价与移动均值的偏离度）
 *   3. Z-Score > 2: 过贵 → 做空 / Z-Score < -2: 过便宜 → 做多
 *   4. Z-Score 回归 0 附近 → 平仓
 * 
 * 适用：
 *   - BTC/ETH 高度相关的配对
 *   - 同生态代币（SOL/AVAX/ADA）
 *   - ARK/BSC 生态相关资产
 * 
 * 风控：
 *   - Z-Score > 3.5 止损（回归可能失效）
 *   - 半衰期 > 120根K线 → 不交易（无均值回归特性）
 *   - 最大持仓时间：均值回归需要耐心
 */

// ═══ 配置 ═══
const CONFIG = {
  lookback: 60,          // Z-Score 计算窗口
  halfLifeWindow: 100,   // 半衰期估计窗口
  zEntry: 2.0,           // 进场阈值
  zExit: 0.5,            // 出场阈值
  zStop: 3.5,            // 止损阈值
  maxHalfLife: 120,      // 最大允许半衰期
  minCorrelation: 0.6,   // 最低相关性
};

/**
 * 计算两个价格序列的相关性
 */
function correlation(pricesA, pricesB) {
  const n = Math.min(pricesA.length, pricesB.length);
  if (n < 10) return 0;

  const a = pricesA.slice(-n);
  const b = pricesB.slice(-n);
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;

  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }

  const denom = Math.sqrt(varA * varB);
  return denom > 0 ? cov / denom : 0;
}

/**
 * 计算价差序列
 */
function computeSpread(pricesA, pricesB, hedgeRatio) {
  const n = Math.min(pricesA.length, pricesB.length);
  const spread = [];
  for (let i = 0; i < n; i++) {
    spread.push(pricesA[pricesA.length - n + i] - hedgeRatio * pricesB[pricesB.length - n + i]);
  }
  return spread;
}

/**
 * 估计均值回归半衰期（简化 OLS）
 * 半衰期 = -ln(2) / β，其中 β 来自 AR(1) 回归
 */
function estimateHalfLife(spreads) {
  if (spreads.length < 20) return Infinity;

  const lag = spreads.slice(0, -1);
  const diff = [];
  for (let i = 1; i < spreads.length; i++) {
    diff.push(spreads[i] - spreads[i - 1]);
  }

  // OLS: diff = α + β * lag
  let sumXY = 0, sumX2 = 0;
  for (let i = 0; i < lag.length; i++) {
    sumXY += lag[i] * diff[i];
    sumX2 += lag[i] * lag[i];
  }

  const beta = sumX2 > 0 ? sumXY / sumX2 : 0;
  if (beta >= 0) return Infinity; // 没有均值回归（β必须为负）
  return -Math.log(2) / beta;
}

/**
 * 计算 Z-Score
 */
function computeZScore(spreads, window) {
  const recent = spreads.slice(-window);
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const variance = recent.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / recent.length;
  const std = Math.sqrt(variance);

  const currentSpread = spreads[spreads.length - 1];
  const z = std > 0 ? (currentSpread - mean) / std : 0;

  return { z, mean, std, currentSpread };
}

/**
 * 策略分析
 * @param {Object} data - { price, prices, volumes, timestamp, pricesB? }
 * @returns {{ signal, direction, reasons }}
 */
function analyze(data) {
  const reasons = [];

  if (!data || !data.prices || data.prices.length < CONFIG.lookback) {
    return { signal: 0, direction: 'neutral', reasons: ['数据不足'] };
  }

  const pricesA = data.prices;

  // 如果没有第二组价格，用自身做自相关检测（单资产均值回归）
  // 实际生产中会传入 pricesB（配对资产的价格）
  let pricesB = data.pricesB;
  if (!pricesB) {
    // 自回归检测：用滞后序列模拟
    pricesB = pricesA.map((p, i) => i > 0 ? pricesA[i - 1] : p);
  }

  const corr = correlation(pricesA, pricesB);
  reasons.push(`相关性: ${corr.toFixed(3)}`);

  if (Math.abs(corr) < CONFIG.minCorrelation) {
    return {
      signal: 0,
      direction: 'neutral',
      reasons: [...reasons, `相关性 ${corr.toFixed(3)} < ${CONFIG.minCorrelation}，不适合配对交易`],
    };
  }

  // 计算对冲比率（简化：标准化后的回归系数）
  const n = Math.min(pricesA.length, pricesB.length);
  const aSlice = pricesA.slice(-n);
  const bSlice = pricesB.slice(-n);
  const meanA = aSlice.reduce((s, v) => s + v, 0) / n;
  const meanB = bSlice.reduce((s, v) => s + v, 0) / n;
  let covAB = 0, varB2 = 0;
  for (let i = 0; i < n; i++) {
    covAB += (aSlice[i] - meanA) * (bSlice[i] - meanB);
    varB2 += Math.pow(bSlice[i] - meanB, 2);
  }
  const hedgeRatio = varB2 > 0 ? covAB / varB2 : 1;

  // 计算价差
  const spreads = computeSpread(pricesA, pricesB, hedgeRatio);

  // 半衰期估计
  const halfLife = estimateHalfLife(spreads);
  reasons.push(`半衰期: ${halfLife === Infinity ? '∞ (无回归)' : halfLife.toFixed(0) + '根K线'}`);

  if (halfLife > CONFIG.maxHalfLife) {
    return {
      signal: 0,
      direction: 'neutral',
      reasons: [...reasons, `半衰期 ${halfLife.toFixed(0)} > ${CONFIG.maxHalfLife}，均值回归特性不足`],
    };
  }

  // Z-Score
  const { z, mean, std, currentSpread } = computeZScore(spreads, CONFIG.lookback);
  reasons.push(`Z-Score: ${z.toFixed(2)} (价差: ${currentSpread.toFixed(2)}, σ: ${std.toFixed(2)})`);

  // ═══ 信号生成 ═══
  let signal = 0;
  let direction = 'neutral';

  if (z > CONFIG.zStop) {
    // 止损：价差极端扩张，可能协整失效
    signal = 0.8;
    direction = 'short';
    reasons.push(`⚠️ Z=${z.toFixed(2)} > ${CONFIG.zStop} — 价差极端，止损信号`);
  } else if (z < -CONFIG.zStop) {
    signal = 0.8;
    direction = 'long';
    reasons.push(`⚠️ Z=${z.toFixed(2)} < -${CONFIG.zStop} — 价差极端，止损信号`);
  } else if (z > CONFIG.zEntry) {
    signal = 0.5 + Math.min((z - CONFIG.zEntry) / 2, 0.4);
    direction = 'short';
    reasons.push(`做空价差：Z=${z.toFixed(2)} > ${CONFIG.zEntry}（偏贵，等待回归）`);
  } else if (z < -CONFIG.zEntry) {
    signal = 0.5 + Math.min((-z - CONFIG.zEntry) / 2, 0.4);
    direction = 'long';
    reasons.push(`做多价差：Z=${z.toFixed(2)} < -${CONFIG.zEntry}（偏便宜，等待回归）`);
  } else if (Math.abs(z) < CONFIG.zExit) {
    signal = 0.1;
    direction = 'neutral';
    reasons.push(`Z=${z.toFixed(2)} 接近0 → 平仓/持有`);
  } else {
    signal = 0.2;
    direction = 'neutral';
    reasons.push(`Z=${z.toFixed(2)} 在区间内，等待突破`);
  }

  return {
    signal: Math.min(signal, 0.95),
    direction,
    reasons,
  };
}

module.exports = { name: 'PairsTrading', analyze, correlation, estimateHalfLife };
