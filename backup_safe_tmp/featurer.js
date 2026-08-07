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

// BinanceAPI.getKlines 返回 对象[time,open,high,low,close,volume]; 数组格式兼容
function normKline(k) {
  // 已是标准数组[o,h,l,c,v] → 原样返回(幂等); 对象 → 转数组
  if (Array.isArray(k)) return k;
  return [k.open,k.high,k.low,k.close,k.volume];
}
function toArray(klines){ return (klines||[]).map(normKline); }
// 本地 EMA (数字数组版, 兼容 BinanceAPI 返回对象K线)
function emaArr(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
  return ema;
}
class FeatureEngineer {
  constructor() {}

  // ATR (平均真实波幅)
  calcATR(raw, period = ATR_PERIOD) {
    const klines = toArray(raw);
    if (!klines || klines.length < period + 1) return 0;
    const trs = [];
    for (let i = 1; i < klines.length; i++) {
      const h = +klines[i][1], l = +klines[i][2], pc = +klines[i-1][3];
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
    return emaArr(klines.map(k => +k[4]), period);
  }
  emaArrays(klines) {
    return { short: this.ema(klines, EMA_SHORT), long: this.ema(klines, EMA_LONG) };
  }

  // 波动率 (近N根K线收益的标准差)
  volatility(raw, period = 8) {
    const klines = toArray(raw);
    const closes = klines.map(k => +k[3]);
    const rets = [];
    for (let i = 1; i < closes.length; i++) rets.push((closes[i] - closes[i-1]) / closes[i-1]);
    const r = rets.slice(-period);
    if (!r.length) return 0;
    const mean = r.reduce((a,b)=>a+b,0) / r.length;
    const varr = r.reduce((a,b)=>a+(b-mean)*(b-mean),0) / r.length;
    return Math.sqrt(varr);
  }

  // 成交量检查 (放量/缩量)
  checkVolume(raw) {
    const klines = toArray(raw);
    const vols = klines.map(k => +k[4]);
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
  buildFeatures(raw, fundingRate) {
    const klines = toArray(raw);
    const closes = klines.map(k => +k[3]);
    return {
      atr: this.calcATR(klines),
      atrPct: this.atrPct(klines),
      emaShort: emaArr(closes, EMA_SHORT),
      emaLong: emaArr(closes, EMA_LONG),
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

module.exports = { FeatureEngineer, toArray, emaArr, EMA_SHORT, EMA_LONG, ATR_PERIOD, VOLATILITY_THRESHOLD, ABNORMAL_FUNDING };
