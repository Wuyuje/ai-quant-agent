/**
 * RegimeDetect — 市场状态检测策略（HMM 简化版）
 * 
 * 灵感来源：Two Sigma Venn Analytics / Bridgewater All Weather
 * 
 * 核心逻辑：
 *   1. 根据价格收益分布 + 波动率 + 趋势强度，判断当前处于哪种市场状态：
 *      - BULL（牛市/趋势向上）
 *      - SIDEWAYS（震荡/盘整）
 *      - BEAR（熊市/趋势向下）
 *   2. 每种状态自动调整策略偏好：
 *      - 牛市：趋势跟踪为主（60%），均值回归辅助（20%），现金20%
 *      - 震荡：均值回归为主（60%），趋势辅助（10%），现金30%
 *      - 熊市：现金为主（80%），极度谨慎（5%趋势，15%均值回归）
 *   3. 状态转换使用简化 Viterbi 算法
 * 
 * 适用：
 *   - 为所有其他策略提供"环境上下文"
 *   - 在不同 regime 下自动调整仓位大小和策略权重
 * 
 * 风控：
 *   - 状态转换有概率，不会频繁切换
 *   - 熊市自动降低整体仓位
 */

// ═══ Regime 常量 ═══
const REGIME = {
  BULL: 0,
  SIDEWAYS: 1,
  BEAR: 2,
};

const REGIME_LABELS = ['BULL', 'SIDEWAYS', 'BEAR'];

// ═══ 转移矩阵（简化版 HMM） ═══
// 基于历史统计：牛市容易持续，熊市也容易持续，震荡有随机性
const TRANSITION_MATRIX = [
  [0.92, 0.06, 0.02],  // Bull → Bull/Sideways/Bear
  [0.10, 0.80, 0.10],  // Sideways → Bull/Sideways/Bear
  [0.03, 0.07, 0.90],  // Bear → Bull/Sideways/Bear
];

// ═══ 策略配置 ═══
const CONFIG = {
  lookback: 50,          // 50根K线计算特征
  updateInterval: 10,    // 每10根K线更新一次regime
  
  // 特征阈值（自适应，基于标准化）
  bullTrendThreshold: 0.001,   // 日均收益 > 0.1%
  bearTrendThreshold: -0.001,  // 日均收益 < -0.1%
  highVolThreshold: 0.04,      // 日波动率 > 4%
};

/**
 * 提取市场特征
 * @param {number[]} prices - 价格序列
 * @returns {{ meanReturn, volatility, trend, skewness }}
 */
function extractFeatures(prices) {
  if (!prices || prices.length < 10) {
    return { meanReturn: 0, volatility: 0.03, trend: 0, skewness: 0 };
  }

  // 收益率
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    }
  }

  if (returns.length < 5) {
    return { meanReturn: 0, volatility: 0.03, trend: 0, skewness: 0 };
  }

  const n = returns.length;
  const meanReturn = returns.reduce((a, b) => a + b, 0) / n;
  const variance = returns.reduce((s, r) => s + Math.pow(r - meanReturn, 2), 0) / n;
  const volatility = Math.sqrt(variance);
  const trend = volatility > 0 ? meanReturn / volatility : 0;

  // 偏度
  const skewness = volatility > 0
    ? returns.reduce((s, r) => s + Math.pow((r - meanReturn) / volatility, 3), 0) / n
    : 0;

  return { meanReturn, volatility, trend, skewness };
}

/**
 * 分类当前 regime（简化 Viterbi）
 * @param {{ meanReturn, volatility, trend, skewness }} features
 * @param {number} currentRegime - 当前 regime
 * @returns {{ regime: number, label: string, confidence: number, probabilities: number[] }}
 */
function classify(features, currentRegime) {
  const { meanReturn, volatility, trend } = features;

  // 发射概率（简化高斯模型）
  // Bull: 正收益 + 中低波动 + 正趋势
  const bullEmission =
    Math.exp(-Math.pow(meanReturn - 0.002, 2) / (2 * 0.01 * 0.01)) *
    Math.exp(-Math.pow(volatility - 0.02, 2) / (2 * 0.01 * 0.01)) *
    Math.max(0, Math.min(1, trend * 10 + 0.5));

  // Sideways: 近零收益 + 中等波动 + 趋势弱
  const sidewaysEmission =
    Math.exp(-Math.pow(meanReturn, 2) / (2 * 0.005 * 0.005)) *
    Math.exp(-Math.pow(volatility - 0.035, 2) / (2 * 0.015 * 0.015)) *
    Math.exp(-Math.pow(trend, 2) / (2 * 0.5 * 0.5));

  // Bear: 负收益 + 高波动 + 负趋势
  const bearEmission =
    Math.exp(-Math.pow(meanReturn + 0.003, 2) / (2 * 0.015 * 0.015)) *
    Math.exp(-Math.pow(volatility - 0.05, 2) / (2 * 0.015 * 0.015)) *
    Math.max(0, Math.min(1, -trend * 10 + 0.5));

  const emissions = [bullEmission, sidewaysEmission, bearEmission];
  const totalEmission = emissions.reduce((a, b) => a + b, 0) || 1;
  const probabilities = emissions.map(e => e / totalEmission);

  // Viterbi 更新：transition × emission
  let bestRegime = 0;
  let bestScore = 0;
  for (let r = 0; r < 3; r++) {
    const score = TRANSITION_MATRIX[currentRegime][r] * emissions[r];
    if (score > bestScore) {
      bestScore = score;
      bestRegime = r;
    }
  }

  return {
    regime: bestRegime,
    label: REGIME_LABELS[bestRegime],
    confidence: probabilities[bestRegime],
    probabilities: {
      bull: probabilities[0],
      sideways: probabilities[1],
      bear: probabilities[2],
    },
  };
}

/**
 * 获取 regime 对应的策略配置
 * @param {number} regime
 * @returns {{ allocation, positionMultiplier, allowedStrategies }}
 */
function getAllocation(regime) {
  switch (regime) {
    case REGIME.BULL:
      return {
        allocation: { trend: 0.55, meanRev: 0.20, momentum: 0.15, cash: 0.10 },
        positionMultiplier: 1.2,    // 牛市加仓
        allowedStrategies: 'all',
        riskLevel: 'normal',
        stopLossMultiplier: 1.2,    // 牛市止损放宽
        takeProfitMultiplier: 1.3,  // 牛市止盈放宽
      };
    case REGIME.SIDEWAYS:
      return {
        allocation: { trend: 0.10, meanRev: 0.50, grid: 0.20, cash: 0.20 },
        positionMultiplier: 0.8,    // 震荡减仓
        allowedStrategies: ['meanRev', 'grid', 'volatility'],
        riskLevel: 'cautious',
        stopLossMultiplier: 0.8,    // 震荡收紧止损
        takeProfitMultiplier: 0.7,  // 震荡降低止盈
      };
    case REGIME.BEAR:
      return {
        allocation: { cash: 0.80, hedge: 0.15, meanRev: 0.05, trend: 0 },
        positionMultiplier: 0.3,    // 熊市大幅减仓
        allowedStrategies: ['cash', 'hedge'],
        riskLevel: 'defensive',
        stopLossMultiplier: 0.6,    // 熊市最紧止损
        takeProfitMultiplier: 0.5,  // 熊市快进快出
      };
    default:
      return {
        allocation: { cash: 1.0 },
        positionMultiplier: 0,
        allowedStrategies: [],
        riskLevel: 'emergency',
        stopLossMultiplier: 0.5,
        takeProfitMultiplier: 0.5,
      };
  }
}

/**
 * 策略分析入口
 * @param {Object} data - { price, prices, volumes, timestamp }
 * @returns {{ signal, direction, reasons, regime, regimeConfig }}
 */
function analyze(data) {
  const reasons = [];

  if (!data || !data.prices || data.prices.length < CONFIG.lookback) {
    return {
      signal: 0,
      direction: 'neutral',
      reasons: ['数据不足，需要50+根K线'],
      regime: 'UNKNOWN',
    };
  }

  const prices = data.prices;

  // 提取特征
  const features = extractFeatures(prices);

  // 分类 regime（使用最后已知的 regime 作为初始状态）
  // 注意：每次调用都会更新，实际生产中应持久化 currentRegime
  const currentRegime = analyze._lastRegime || REGIME.SIDEWAYS;
  const result = classify(features, currentRegime);
  analyze._lastRegime = result.regime;

  // 获取 regime 配置
  const regimeConfig = getAllocation(result.regime);

  // 构建信号
  // RegimeDetect 本身不开仓，而是为其他策略提供方向偏好
  let signal = result.confidence;
  let direction = 'neutral';

  if (result.regime === REGIME.BULL) {
    direction = 'long';
    reasons.push(`🐂 牛市状态 (${(result.confidence * 100).toFixed(0)}% 置信度)`);
    reasons.push(`趋势: ${(features.trend * 100).toFixed(2)}, 波动率: ${(features.volatility * 100).toFixed(2)}%`);
    reasons.push(`仓位系数: ${regimeConfig.positionMultiplier}x`);
  } else if (result.regime === REGIME.BEAR) {
    direction = 'short';
    reasons.push(`🐻 熊市状态 (${(result.confidence * 100).toFixed(0)}% 置信度)`);
    reasons.push(`趋势: ${(features.trend * 100).toFixed(2)}, 波动率: ${(features.volatility * 100).toFixed(2)}%`);
    reasons.push(`仓位系数: ${regimeConfig.positionMultiplier}x — 大幅减仓`);
  } else {
    direction = 'neutral';
    reasons.push(`↔️ 震荡状态 (${(result.confidence * 100).toFixed(0)}% 置信度)`);
    reasons.push(`趋势: ${(features.trend * 100).toFixed(2)}, 波动率: ${(features.volatility * 100).toFixed(2)}%`);
    reasons.push(`仓位系数: ${regimeConfig.positionMultiplier}x — 偏向均值回归`);
  }

  // 输出 regime 概率分布
  reasons.push(`概率分布: 牛${(result.probabilities.bull * 100).toFixed(0)}% / 平${(result.probabilities.sideways * 100).toFixed(0)}% / 熊${(result.probabilities.bear * 100).toFixed(0)}%`);

  return {
    signal: signal * 0.8, // RegimeDetect 不直接开仓，降低信号
    direction,
    reasons,
    regime: result.label,
    regimeConfig,
  };
}

// 持久化当前 regime（进程内）
analyze._lastRegime = REGIME.SIDEWAYS;

module.exports = { name: 'RegimeDetect', analyze, getAllocation, classify, extractFeatures, REGIME };
