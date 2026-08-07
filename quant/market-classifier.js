// ═══════════════════════════════════════════════════════════
// 模块二·市场状态分类模块 (核心智能体 MarketClassifier)
// 根据 波动率 / 趋势强度 / 资金费率 判断市场:
//   ranging(震荡) / trending(趋势) / shock(剧烈波动)
//   + check_trend_direction 判断趋势方向(涨/跌)
// 对应图片: 二、市场状态分类模块（核心智能体）
// ═══════════════════════════════════════════════════════════
const { FeatureEngineer } = require('./featurer');
const { Indicators } = require('../lib/common');

// ADX (兼容 Binance K线数组格式 [open,high,low,close,volume,...])
function calcADX(rawKlines, period = 14) {
  if (!Array.isArray(rawKlines) || rawKlines.length < period * 2) return 0;
  // 数组 klines: [o,h,l,c,v]
  let plusDM = 0, minusDM = 0, tr = 0;
  const start = rawKlines.length - period;
  for (let i = start; i < rawKlines.length; i++) {
    const up = +rawKlines[i][2] - +rawKlines[i-1][2];      // high diff
    const down = +rawKlines[i-1][3] - +rawKlines[i][3];     // low diff
    const h = +rawKlines[i][2], l = +rawKlines[i][3], pc = +rawKlines[i-1][4];
    tr += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    if (up > down && up > 0) plusDM += up;
    else if (down > up && down > 0) minusDM += down;
  }
  if (tr === 0) return 0;
  const plusDI = plusDM / tr * 100, minusDI = minusDM / tr * 100;
  return Math.abs(plusDI - minusDI) / Math.max(plusDI + minusDI, 0.001) * 100;
}

// 状态阈值 (可调优)
const CONFIG = {
  shockVolatility: 0.025,   // 30根波动率>2.5% → 剧烈波动
  trendStrength: 18,        // ADX≥18 → 有趋势
  emaGapPct: 0.002,         // EMA快慢线差幅>0.2% 视为方向
  rangingBandPct: 0.05,     // 震荡带: 价格在近N根通道内波动<5%
};

class MarketClassifier {
  constructor() {
    this.fe = new FeatureEngineer();
  }

  // 判断趋势方向(用 EMA 快慢线 + ADX)
  checkTrendDirection(klines) {
    const closes = klines.map(k => +k[4]);
    const emaS = Indicators.ema(closes, 7);
    const emaL = Indicators.ema(closes, 25);
    if (!emaS || !emaL) return { dir: 'FLAT', strength: 0 };
    const diff = (emaS - emaL) / Math.abs(emaL || 1);
    const dir = diff > CONFIG.emaGapPct ? 'UP' : diff < -CONFIG.emaGapPct ? 'DOWN' : 'FLAT';
    const adx = calcADX(klines, 14) || 0;
    return { dir, strength: adx };
  }

  // 判断市场状态: 'ranging' | 'trending' | 'shock'
  judgeMarketState(klines, fundingRate) {
    const feats = this.fe.buildFeatures(klines, fundingRate);
    const vol = feats.volatility;
    const adx = calcADX(klines, 14) || 0;
    const emaS = feats.emaShort, emaL = feats.emaLong;
    const emaGap = Math.abs(emaS - emaL) / Math.abs(emaL || 1);
    const fundingAbnormal = feats.fundingAbnormal;

    let state;
    // ① 剧烈波动: 波动率极高 或 资金费率异常
    if (vol > CONFIG.shockVolatility || fundingAbnormal) {
      state = 'shock';
    }
    // ② 趋势: ADX强 且 EMA方向明确
    else if (adx >= CONFIG.trendStrength && emaGap > CONFIG.emaGapPct) {
      state = 'trending';
    }
    // ③ 震荡: 波动低 且 无明确趋势
    else {
      state = 'ranging';
    }

    const trend = this.checkTrendDirection(klines);
    return {
      state,               // ranging/trending/shock
      trendDir: trend.dir,  // UP/DOWN/FLAT
      trendStrength: adx,
      volatility: vol,
      emaGap,
      fundingRate: feats.fundingRate,
      fundingAbnormal,
      raw: feats,
    };
  }

  // 该状态下应启用的策略
  recommendedStrategy(judgeResult) {
    switch (judgeResult.state) {
      case 'trending': return 'trend';       // 趋势→趋势跟踪
      case 'ranging': return 'grid';          // 震荡→网格
      case 'shock': return 'none';           // 剧烈波动→观望(风险高)
      default: return 'none';
    }
  }
}

module.exports = { MarketClassifier, CLASSIFIER_CONFIG: CONFIG };
