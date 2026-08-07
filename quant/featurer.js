// ═══════════════════════════════════════════════════════════
// 模块一·数据源与工具模块 (FeatureEngineer)
// 计算 ATR / EMA / 波动率 / 资金费率 / 成交量等交易指标
// 对应图片: 一、数据源与工具模块
// ═══════════════════════════════════════════════════════════
const { Indicators } = require('../lib/common');

const ATR_PERIOD = 14;
const EMA_SHORT = 7;
const EMA_LONG = 25;
const VOLATILITY_THRESHOLD = 0.03;   // 30min波动率>3% 视为剧烈
const ABNORMAL_FUNDING = 0.001;      // 资金费率>0.1% 异常

class FeatureEngineer {
  constructor() {}

  // ATR (平均真实波幅)
  calcATR(klines, period = ATR_PERIOD) {
    if (!klines || klines.length < period + 1) return 0;
    const trs = [];
    for (let i = 1; i < klines.length; i++) {
      const h = +klines[i][2], l = +klines[i][3], pc = +klines[i-1][4];
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    if (!trs.length) return 0;
    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  }

  // ATR% (相对价格)
  atrPct(klines) {
    const atr = this.calcATR(klines);
    const close = klines.length ? +klines[klines.length-1][4] : 0;
    return close > 0 ? atr / close : 0;
  }

  // EMA 快慢线
  ema(klines, period) {
    const closes = klines.map(k => +k[4]);
    return Indicators.ema(closes, period);
  }
  emaArrays(klines) {
    return {
      short: this.ema(klines, EMA_SHORT),
      long: this.ema(klines, EMA_LONG),
      emaShort: indicatorsEma(klines, EMA_SHORT),
      emaLong: indicatorsEma(klines, EMA_LONG),
    };
  }

  // 波动率 (近N根K线收益的标准差)
  volatility(klines, period = 8) {
    const closes = klines.map(k => +k[4]);
    const rets = [];
    for (let i = 1; i < closes.length; i++) rets.push((closes[i] - closes[i-1]) / closes[i-1]);
    const r = rets.slice(-period);
    if (!r.length) return 0;
    const mean = r.reduce((a,b)=>a+b,0) / r.length;
    const varr = r.reduce((a,b)=>a+(b-mean)*(b-mean),0) / r.length;
    return Math.sqrt(varr);
  }

  // 成交量检查 (放量/缩量)
  checkVolume(klines) {
    const vols = klines.map(k => +k[5]);
    if (vols.length < 20) return { abnormal: false, volRatio: 1 };
    const avg = vols.slice(-20, -1).reduce((a,b)=>a+b,0) / 19;
    const last = vols[vols.length-1];
    const ratio = avg > 0 ? last / avg : 1;
    return { abnormal: ratio > 3, volRatio: ratio };
  }

  // 资金费率检查
  checkFunding(fundingRate) {
    const fr = fundingRate == null ? 0 : +fundingRate;
    return {
      abnormal: Math.abs(fr) > ABNORMAL_FUNDING,
      rate: fr,
    };
  }

  // 综合特征提取
  buildFeatures(klines, fundingRate) {
    const closes = klines.map(k => +k[4]);
    return {
      atr: this.calcATR(klines),
      atrPct: this.atrPct(klines),
      emaShort: Indicators.ema(closes, EMA_SHORT),
      emaLong: Indicators.ema(closes, EMA_LONG),
      volatility: this.volatility(klines),
      volRatio: this.checkVolume(klines).volRatio,
      volumeAbnormal: this.checkVolume(klines).abnormal,
      fundingRate: fundingRate == null ? 0 : +fundingRate,
      fundingAbnormal: this.checkFunding(fundingRate).abnormal,
      close: closes.length ? closes[closes.length-1] : 0,
      change24h: this._change24h(klines),
    };
  }

  _change24h(klines) {
    if (!klines || klines.length < 2) return 0;
    const first = +klines[0][4], last = +klines[klines.length-1][4];
    return first > 0 ? (last - first) / first * 100 : 0;
  }
}

function indicatorsEma(klines, period) {
  const closes = klines.map(k => +k[4]);
  return Indicators.ema(closes, period);
}

module.exports = { FeatureEngineer, EMA_SHORT, EMA_LONG, ATR_PERIOD, VOLATILITY_THRESHOLD, ABNORMAL_FUNDING };
