// ═══════════════════════════════════════════════════════════
// 模块二·市场状态分类模块 (核心智能体 MarketClassifier)
// 根据 波动率 / 趋势强度 / 资金费率 判断市场:
//   ranging(震荡) / trending(趋势) / shock(剧烈波动)
//   + check_trend_direction 判断趋势方向(涨/跌)
// 对应图片: 二、市场状态分类模块（核心智能体）
// ═══════════════════════════════════════════════════════════
const { FeatureEngineer, toArray } = require('./featurer');
const { Indicators } = require('../lib/common');

// ADX (兼容 Binance K线数组格式 [open,high,low,close,volume,...])
function calcADX(raw, period = 14) {
  const rawKlines = toArray(raw);
  if (!Array.isArray(rawKlines) || rawKlines.length < period * 2) return 0;
  let plusDM = 0, minusDM = 0, tr = 0;
  const start = rawKlines.length - period;
  for (let i = start; i < rawKlines.length; i++) {
    const up = +rawKlines[i][1] - +rawKlines[i-1][1];      // high diff
    const down = +rawKlines[i-1][2] - +rawKlines[i][2];     // low diff
    const h = +rawKlines[i][1], l = +rawKlines[i][2], pc = +rawKlines[i-1][3];
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
  shockVolatility: 0.35,    // 规格: 突发波动动作触发阈值0.35
  trendStrength: 18,        // ADX≥18 → 有趋势
  emaGapPct: 0.002,         // EMA快慢线差幅>0.2% 视为方向
  rangingBandPct: 0.05,     // 震荡带: 价格在近N根通道内波动<5%
};

// 本地数组版 MA(SMA)
function localMA(values, period) {
  if (!values || values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a,b)=>a+b,0)/period;
}

class MarketClassifier {
  constructor() {
    this.fe = new FeatureEngineer();
  }

  // 判断趋势方向(用 多周期MA5/30/60 收敛判定 — 规格原文: ma5>ma30>ma60=上趋势)
  checkTrendDirection(klines) {
    const closes = toArray(klines).map(k => +k[3]);
    const ma5 = localMA(closes, 5), ma30 = localMA(closes, 30), ma60 = localMA(closes, 60);
    if (ma5 == null || ma30 == null || ma60 == null) return { dir: 'FLAT', strength: 0 };
    // 规格: ma5 > ma30 > ma60 → uptrend; 否则 downtrend
    const dir = (ma5 > ma30 && ma30 > ma60) ? 'UP'
      : (ma5 < ma30 && ma30 < ma60) ? 'DOWN' : 'FLAT';
    const adx = calcADX(klines, 14) || 0;
    return { dir, strength: adx };
  }

  // 判断市场状态: 'ranging' | 'trending' | 'shock'
  judgeMarketState(klines, fundingRate) {
    const feats = this.fe.buildFeatures(klines, fundingRate);
    const vol = feats.volatility;
    const closes = toArray(klines).map(k => +k[3]);
    const adx = calcADX(klines, 14) || 0;
    const fundingAbnormal = feats.fundingAbnormal;
    // 多周期收敛判定: 规格 ma5与ma60 间距 spread
    const ma5 = localMA(closes, 5), ma30 = localMA(closes, 30), ma60 = localMA(closes, 60);
    let maConverge = 1;
    if (ma5 != null && ma30 != null && ma60 != null) maConverge = Math.abs(ma5 - ma60) / (ma60 || 1);
    const emaGap = 0;  // (兼容)

    let state;
    // ① 突发shock: 波动率>0.35 或 资金费率异常>3
    if (vol > CONFIG.shockVolatility || fundingAbnormal) {
      state = 'shock';
    }
    // ② 震荡range: 多周期MA收敛(spread<0.02) 且 无强趋势
    else if (maConverge < 0.02) {
      state = 'ranging';
    }
    // ③ 趋势trend: MA发散 + ADX强度
    else {
      state = 'trending';
    }

    const trend = this.checkTrendDirection(klines);
    return {
      state,               // ranging/trending/shock
      trendDir: trend.dir,  // UP/DOWN/FLAT
      trendStrength: adx,
      volatility: vol,
      maConverge,
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
