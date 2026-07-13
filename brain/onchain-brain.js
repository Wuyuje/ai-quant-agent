/**
 * OnChainBrain — 链上智能分析引擎
 * 
 * 零外部 AI API 依赖，纯本地计算
 * 数据源：币安公开 REST API (fapi)
 * 
 * 核心维度：
 *   1. 鲸鱼活动检测 (权重 0.25)
 *   2. 资金费率分析 (权重 0.20)
 *   3. 多空比分析   (权重 0.20)
 *   4. 清算瀑布分析 (权重 0.15)
 *   5. Taker买卖流  (权重 0.10)
 *   6. 持仓量变化   (权重 0.10)
 * 
 * @author MasterD
 * @version 1.0.0
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

// ============================================================
// 常量与配置
// ============================================================

const DEFAULT_CONFIG = {
  baseURL: 'https://fapi.binance.com',
  timeout: 10000,
  whaleMultiplier: 3.0,
  fundingAbnormalThreshold: 0.001,
  liquidationBurstThreshold: 10,
  oiChangeThreshold: 0.05,
  consensusThreshold: 0.45,
  directionThreshold: 0.15,
  confidenceFloor: 0.25,
  maxLeverage: 5,
  minLeverage: 1,
  minPositionPct: 0.05,
  maxPositionPct: 0.15,
  accountBalance: 170,
};

const DIRECTION = { LONG: 'LONG', SHORT: 'SHORT', WAIT: 'WAIT' };

// ============================================================
// 工具函数
// ============================================================

function log(tag, msg) {
  console.log(`[OnChainBrain][${new Date().toISOString()}][${tag}] ${msg}`);
}

function httpGet(urlStr, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(parsed, { timeout }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function mean(arr) { return arr && arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }

function std(arr) {
  if (!arr || arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

function clamp(val, min = -1, max = 1) { return Math.max(min, Math.min(max, val)); }

function trend(arr) {
  if (!arr || arr.length < 2) return 0;
  const half = Math.floor(arr.length / 2);
  const early = mean(arr.slice(0, half));
  const late = mean(arr.slice(half));
  if (early === 0) return late > 0 ? 1 : late < 0 ? -1 : 0;
  return clamp((late - early) / Math.abs(early), -1, 1);
}

// ============================================================
// OnChainBrain
// ============================================================

class OnChainBrain {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.baseURL = this.config.baseURL;
    log('INIT', `引擎初始化完成 baseURL=${this.baseURL}`);
  }

  async analyze(symbol) {
    symbol = (symbol || 'BTCUSDT').toUpperCase();
    log('ANALYZE', `▶ 开始分析 ${symbol}`);
    const startTime = Date.now();

    const [whale, funding, longShort, liquidation, taker, openInterest] = await Promise.allSettled([
      this._whaleActivity(symbol),
      this._fundingAnalysis(symbol),
      this._longShortAnalysis(symbol),
      this._liquidationAnalysis(symbol),
      this._takerFlow(symbol),
      this._openInterestChange(symbol),
    ]);

    const getVal = (r) => r.status === 'fulfilled' ? r.value : { score: 0, detail: `获取失败` };
    const dimensions = {
      whale: getVal(whale), funding: getVal(funding), longShort: getVal(longShort),
      liquidation: getVal(liquidation), taker: getVal(taker), openInterest: getVal(openInterest),
    };

    const smartMoney = this._smartMoneyFlow(dimensions);
    dimensions.smartMoney = smartMoney;

    // 动态权重：失效维度的权重重新分配给有效维度
    const rawWeights = { whale: 0.25, funding: 0.20, longShort: 0.20, liquidation: 0.15, taker: 0.10, openInterest: 0.10 };
    const activeWeights = {};
    let totalActive = 0;
    let deadWeight = 0;
    for (const [dim, w] of Object.entries(rawWeights)) {
      if (dimensions[dim].score !== 0 || dim === 'whale' || dim === 'funding' || dim === 'longShort') {
        activeWeights[dim] = w;
        totalActive += w;
      } else {
        deadWeight += w;
      }
    }
    // 把失效权重按比例分配给有效维度
    for (const dim of Object.keys(activeWeights)) {
      activeWeights[dim] += deadWeight * (activeWeights[dim] / totalActive);
    }

    let rawScore = 0;
    for (const [dim, weight] of Object.entries(activeWeights)) {
      rawScore += (dimensions[dim].score || 0) * weight;
    }
    rawScore += clamp(smartMoney.score * 0.15, -0.1, 0.1);
    rawScore = clamp(rawScore, -1, 1);

    const volatility = dimensions.whale.volatility || 0.5;
    const adjustedScore = this._riskAdjustedScore(rawScore, volatility);
    const consensusResult = this._multiTimeframeConsensus(dimensions);

    let direction = DIRECTION.WAIT;
    let confidence = 0;

    const dirThreshold = this.config.directionThreshold || 0.15;
    if (adjustedScore > dirThreshold) direction = DIRECTION.LONG;
    else if (adjustedScore < -dirThreshold) direction = DIRECTION.SHORT;

    confidence = Math.abs(adjustedScore) * (0.85 + 0.15 * (1 - volatility));
    // 对有明确信号但分数被低估的情况给予信心补偿
    if (direction !== DIRECTION.WAIT && confidence < 0.25) {
      const activeDims = Object.values(dimensions).filter(d => d.score !== 0).length;
      if (activeDims >= 3) confidence = Math.max(confidence, 0.25 + activeDims * 0.03);
    }

    if (consensusResult.agreement < this.config.consensusThreshold && direction !== DIRECTION.WAIT) {
      confidence *= (1 - (1 - consensusResult.agreement) * 0.3);
    }
    if (consensusResult.conflict && direction !== DIRECTION.WAIT) {
      direction = DIRECTION.WAIT;
      confidence *= 0.3;
    }
    const confFloor = this.config.confidenceFloor || 0.25;
    if (confidence < confFloor && direction !== DIRECTION.WAIT) direction = DIRECTION.WAIT;
    confidence = clamp(confidence, 0, 1);

    const suggestedLeverage = this._suggestLeverage(confidence);
    const suggestedPosition = this._suggestPosition(confidence);
    const reasoning = this._generateReasoning(dimensions, smartMoney, consensusResult, direction, confidence);

    const elapsed = Date.now() - startTime;
    log('RESULT', `✅ ${symbol}: ${direction} 信心=${confidence.toFixed(3)} 评分=${adjustedScore.toFixed(4)} 耗时=${elapsed}ms`);

    return {
      score: parseFloat(adjustedScore.toFixed(4)),
      direction, confidence: parseFloat(confidence.toFixed(4)),
      reasoning,
      dimensions: this._formatDimensions(dimensions),
      meta: {
        symbol, rawScore: parseFloat(rawScore.toFixed(4)),
        consensus: consensusResult,
        volatility: parseFloat(volatility.toFixed(4)),
        suggestedLeverage, suggestedPositionPct: parseFloat((suggestedPosition * 100).toFixed(1)),
        suggestedPositionUSD: parseFloat((this.config.accountBalance * suggestedPosition).toFixed(2)),
        accountBalance: this.config.accountBalance,
        elapsed, timestamp: new Date().toISOString(), engine: 'OnChainBrain v1.0',
      },
    };
  }

  // ============ 鲸鱼活动检测 ============
  async _whaleActivity(symbol) {
    const trades = await httpGet(`${this.baseURL}/fapi/v1/trades?symbol=${symbol}&limit=1000`, this.config.timeout);
    if (!Array.isArray(trades) || trades.length === 0) return { score: 0, detail: '无交易数据', volatility: 0.5 };

    const amounts = trades.map(t => parseFloat(t.qty) * parseFloat(t.price));
    const avgAmount = mean(amounts);
    const threshold = avgAmount * this.config.whaleMultiplier;
    const whales = trades.filter((t, i) => amounts[i] >= threshold);
    const whaleBuys = whales.filter(t => !t.isBuyerMaker).length;
    const whaleSells = whales.filter(t => t.isBuyerMaker).length;

    const halfIdx = Math.floor(trades.length / 2);
    const earlyWhales = trades.slice(0, halfIdx).filter((t, i) => amounts[i] >= threshold);
    const lateWhales = trades.slice(halfIdx).filter((t, i) => amounts[halfIdx + i] >= threshold);
    const earlyBuyRatio = earlyWhales.length > 0 ? earlyWhales.filter(t => !t.isBuyerMaker).length / earlyWhales.length : 0.5;
    const lateBuyRatio = lateWhales.length > 0 ? lateWhales.filter(t => !t.isBuyerMaker).length / lateWhales.length : 0.5;

    let score = whales.length > 0 ? (whaleBuys - whaleSells) / whales.length : 0;
    const trendBonus = clamp((lateBuyRatio - earlyBuyRatio) * 0.5, -0.3, 0.3);
    score = clamp(score + trendBonus, -1, 1);
    const volatility = clamp(std(amounts) / (avgAmount || 1) / 3, 0, 1);

    return {
      score: parseFloat(score.toFixed(4)),
      detail: `鲸鱼: ${whales.length}/${trades.length}笔超大单 买=${whaleBuys} 卖=${whaleSells}`,
      volatility, whaleCount: whales.length,
    };
  }

  // ============ 资金费率分析 ============
  async _fundingAnalysis(symbol) {
    const data = await httpGet(`${this.baseURL}/fapi/v1/fundingRate?symbol=${symbol}&limit=30`, this.config.timeout);
    if (!Array.isArray(data) || data.length === 0) return { score: 0, detail: '无费率数据' };

    const rates = data.map(d => parseFloat(d.fundingRate));
    const latestRate = rates[rates.length - 1];
    const avgRate = mean(rates);
    const trendVal = trend(rates);

    let score = -clamp(latestRate / 0.003, -1, 1);
    score += clamp(-trendVal * 0.3, -0.3, 0.3);
    if (latestRate > 0.003) score = clamp(score - 0.2, -1, 1);
    if (latestRate < -0.003) score = clamp(score + 0.2, -1, 1);

    const consecutive = this._consecutiveSameDirection(rates);
    if (consecutive > 3) score = clamp(score - 0.1, -1, 1);
    else if (consecutive < -3) score = clamp(score + 0.1, -1, 1);

    return {
      score: parseFloat(clamp(score, -1, 1).toFixed(4)),
      detail: `费率: 最新=${(latestRate * 100).toFixed(4)}% 均值=${(avgRate * 100).toFixed(4)}% ${latestRate > 0.003 ? '⚠极端高' : latestRate < -0.003 ? '⚠极端低' : '正常'}`,
    };
  }

  // ============ 多空比分析 ============
  async _longShortAnalysis(symbol) {
    // 币安正确端点: /futures/data/*
    const [topAccount, topPosition, retailRatio] = await Promise.all([
      httpGet(`${this.baseURL}/futures/data/topLongShortAccountRatio?symbol=${symbol}&period=1h&limit=24`, this.config.timeout),
      httpGet(`${this.baseURL}/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=1h&limit=24`, this.config.timeout),
      httpGet(`${this.baseURL}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=24`, this.config.timeout),
    ]);

    const extract = d => Array.isArray(d) ? d.map(x => parseFloat(x.longShortRatio)) : [];
    const topAR = extract(topAccount);
    const topPR = extract(topPosition);
    const retR = extract(retailRatio);

    const latestTA = topAR.length > 0 ? topAR[topAR.length - 1] : 1;
    const latestTP = topPR.length > 0 ? topPR[topPR.length - 1] : 1;
    const latestRet = retR.length > 0 ? retR[retR.length - 1] : 1;
    const taTrend = trend(topAR);

    let score = 0;
    if (latestTA > 2.0) score -= 0.4;
    else if (latestTA < 0.5) score += 0.4;
    else score += -(latestTA - 1) * 0.3;

    if (latestTP > 2.0) score -= 0.3;
    else if (latestTP < 0.5) score += 0.3;
    else score += -(latestTP - 1) * 0.2;

    if (latestRet > 2.5) score -= 0.15;
    else if (latestRet < 0.4) score += 0.15;

    const retailTrend = trend(retR);
    const divergence = taTrend * retailTrend < 0;
    if (divergence) score += taTrend > 0 ? 0.15 : -0.15;
    score += clamp(taTrend * 0.15, -0.15, 0.15);

    return {
      score: parseFloat(clamp(score, -1, 1).toFixed(4)),
      detail: `大户=${latestTA.toFixed(3)} 持仓=${latestTP.toFixed(3)} 散户=${latestRet.toFixed(3)} ${divergence ? '⚠背离' : '一致'}`,
    };
  }

  // ============ 清算分析 ============
  async _liquidationAnalysis(symbol) {
    // 注意: allForceOrders 已废弃(400), forceOrders 需要 API key
    // 使用 forceOrders (公开端点) 或回退到 0 分
    let data = [];
    try {
      data = await httpGet(`${this.baseURL}/futures/data/forceOrders?symbol=${symbol}&limit=100`, this.config.timeout);
    } catch (e) {
      // 回退: 用持仓量变化推断清算
      return { score: 0, detail: '清算API不可用' };
    }
    if (!Array.isArray(data) || data.length === 0) return { score: 0, detail: '无清算数据' };

    const longLiq = data.filter(d => d.side === 'BUY');
    const shortLiq = data.filter(d => d.side === 'SELL');
    const totalLongVal = longLiq.reduce((s, d) => s + parseFloat(d.origQty) * parseFloat(d.price), 0);
    const totalShortVal = shortLiq.reduce((s, d) => s + parseFloat(d.origQty) * parseFloat(d.price), 0);
    const totalVal = totalLongVal + totalShortVal;

    let score = 0;
    if (totalVal > 0) score = clamp((totalShortVal - totalLongVal) / totalVal * 0.8, -1, 1);
    if (data.length > this.config.liquidationBurstThreshold) {
      score = longLiq.length > shortLiq.length ? clamp(score + 0.15, -1, 1) : clamp(score - 0.15, -1, 1);
    }

    return {
      score: parseFloat(clamp(score, -1, 1).toFixed(4)),
      detail: `清算: 多头被清=${longLiq.length}笔(${totalLongVal.toFixed(0)}U) 空头被清=${shortLiq.length}笔(${totalShortVal.toFixed(0)}U)`,
    };
  }

  // ============ Taker买卖流 ============
  async _takerFlow(symbol) {
    // 币安正确端点: /futures/data/takerlongshortRatio
    let data = [];
    try {
      data = await httpGet(`${this.baseURL}/futures/data/takerlongshortRatio?symbol=${symbol}&period=1h&limit=24`, this.config.timeout);
    } catch (e) {
      try {
        // 回退到旧端点
        data = await httpGet(`${this.baseURL}/fapi/v1/takerlongshortRatio?symbol=${symbol}&period=1h&limit=24`, this.config.timeout);
      } catch (e2) {
        return { score: 0, detail: 'Taker数据不可用' };
      }
    }
    if (!Array.isArray(data) || data.length === 0) return { score: 0, detail: '无Taker数据' };

    const ratios = data.map(d => parseFloat(d.buySellRatio));
    const latest = ratios[ratios.length - 1];
    const avgRatio = mean(ratios);
    const trendVal = trend(ratios);

    let score = clamp((latest - 1) * 2, -1, 1);
    score += clamp(trendVal * 0.25, -0.25, 0.25);
    const recentTrend = trend(ratios.slice(-5));
    if (Math.abs(recentTrend) > 0.3) score += clamp(recentTrend * 0.15, -0.15, 0.15);

    return {
      score: parseFloat(clamp(score, -1, 1).toFixed(4)),
      detail: `Taker: 买/卖=${latest.toFixed(4)} 均值=${avgRatio.toFixed(4)} 趋势=${trendVal > 0 ? '买↑' : trendVal < 0 ? '卖↓' : '→'}`,
    };
  }

  // ============ 持仓量变化 ============
  async _openInterestChange(symbol) {
    const oiData = await httpGet(`${this.baseURL}/fapi/v1/openInterest?symbol=${symbol}`, this.config.timeout);
    const klines = await httpGet(`${this.baseURL}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=24`, this.config.timeout);
    const currentOI = parseFloat(oiData.openInterest || 0);
    const volumes = Array.isArray(klines) ? klines.map(k => parseFloat(k[5])) : [];
    const closes = Array.isArray(klines) ? klines.map(k => parseFloat(k[4])) : [];
    const priceTrend = trend(closes);

    let score = 0;
    if (volumes.length >= 10) {
      const recentVol = mean(volumes.slice(-5));
      const earlyVol = mean(volumes.slice(0, 5));
      if (earlyVol > 0) {
        const volChange = (recentVol - earlyVol) / earlyVol;
        if (volChange > this.config.oiChangeThreshold && priceTrend < -0.1) score = -0.6;
        else if (volChange > this.config.oiChangeThreshold && priceTrend > 0.1) score = 0.6;
        else if (volChange < -this.config.oiChangeThreshold && priceTrend > 0.1) score = 0.3;
        else if (volChange < -this.config.oiChangeThreshold && priceTrend < -0.1) score = -0.3;
      }
    }

    return {
      score: parseFloat(clamp(score, -1, 1).toFixed(4)),
      detail: `OI: ${currentOI.toFixed(2)} 价趋势=${priceTrend > 0 ? '↑' : priceTrend < 0 ? '↓' : '→'}`,
      currentOI,
    };
  }

  // ============ 智能资金流向 ============
  _smartMoneyFlow(dim) {
    let score = 0;
    const signals = [];
    const w = dim.whale?.score || 0, f = dim.funding?.score || 0, ls = dim.longShort?.score || 0;
    const liq = dim.liquidation?.score || 0, t = dim.taker?.score || 0, oi = dim.openInterest?.score || 0;

    if (w > 0.3 && ls > 0.3) { score += 0.4; signals.push('🐋 鲸鱼买入+空头拥挤→强做多'); }
    if (f < -0.3 && ls < -0.3) { score -= 0.4; signals.push('💰 费率高+多头拥挤→做空'); }
    if (liq > 0.3 && t > 0.3) { score += 0.35; signals.push('🌊 清算+Taker买入→抄底'); }
    if (oi < -0.3 && w < -0.2) { score -= 0.35; signals.push('📉 OI暴增+鲸鱼卖→空头主导'); }

    const pos = [w, f, ls, liq, t, oi].filter(s => s > 0.2).length;
    const neg = [w, f, ls, liq, t, oi].filter(s => s < -0.2).length;
    if (pos >= 4) { score += 0.2; signals.push(`✅ ${pos}/6维度看多`); }
    else if (neg >= 4) { score -= 0.2; signals.push(`✅ ${neg}/6维度看空`); }

    return { score: parseFloat(clamp(score, -1, 1).toFixed(4)), detail: signals.length ? signals : ['无交叉信号'] };
  }

  // ============ 共识检查 ============
  _multiTimeframeConsensus(dim) {
    const scores = [dim.whale?.score||0, dim.funding?.score||0, dim.longShort?.score||0,
                     dim.liquidation?.score||0, dim.taker?.score||0, dim.openInterest?.score||0];
    const pos = scores.filter(s => s > 0.1).length;
    const neg = scores.filter(s => s < -0.1).length;
    const strongPos = scores.filter(s => s > 0.3).length;
    const strongNeg = scores.filter(s => s < -0.3).length;
    return {
      agreement: Math.max(pos, neg) / 6,
      conflict: strongPos >= 2 && strongNeg >= 2,
      detail: `看多=${pos} 看空=${neg} 一致度=${(Math.max(pos, neg) / 6 * 100).toFixed(1)}%`,
    };
  }

  _riskAdjustedScore(rawScore, volatility) {
    return clamp(rawScore * Math.max(0.5, 1 - volatility * 0.3), -1, 1);
  }

  _consecutiveSameDirection(arr) {
    if (!arr || !arr.length) return 0;
    let count = 0;
    const dir = arr[arr.length - 1] >= 0 ? 1 : -1;
    for (let i = arr.length - 1; i >= 0; i--) {
      if ((dir > 0 && arr[i] >= 0) || (dir < 0 && arr[i] < 0)) count++;
      else break;
    }
    return dir * count;
  }

  _suggestLeverage(c) {
    if (c < 0.2) return 2;
    if (c < 0.35) return 3;
    if (c < 0.5) return 3;
    if (c < 0.7) return 4;
    if (c < 0.85) return 5;
    return this.config.maxLeverage;
  }

  _suggestPosition(c) {
    return this.config.minPositionPct + (this.config.maxPositionPct - this.config.minPositionPct) * c;
  }

  _formatDimensions(dim) {
    const r = {};
    for (const [k, v] of Object.entries(dim)) r[k] = { score: v.score, detail: v.detail };
    return r;
  }

  _generateReasoning(dim, smartMoney, consensus, direction, confidence) {
    const lines = [`📊 OnChainBrain: ${direction} (${(confidence*100).toFixed(1)}%)`];
    lines.push(`鲸鱼=${dim.whale.score>0?'+':''}${dim.whale.score.toFixed(2)} 费率=${dim.funding.score>0?'+':''}${dim.funding.score.toFixed(2)} 多空=${dim.longShort.score>0?'+':''}${dim.longShort.score.toFixed(2)}`);
    lines.push(`清算=${dim.liquidation.score>0?'+':''}${dim.liquidation.score.toFixed(2)} Taker=${dim.taker.score>0?'+':''}${dim.taker.score.toFixed(2)} OI=${dim.openInterest.score>0?'+':''}${dim.openInterest.score.toFixed(2)}`);
    if (smartMoney.detail.length) lines.push(smartMoney.detail.join(' | '));
    lines.push(consensus.detail);
    return lines.join('\n');
  }
}

module.exports = OnChainBrain;

if (require.main === module) {
  (async () => {
    const brain = new OnChainBrain({ accountBalance: 170 });
    for (const sym of ['BTCUSDT', 'ETHUSDT']) {
      try {
        const r = await brain.analyze(sym);
        console.log('\n' + '='.repeat(60));
        console.log(r.reasoning);
        console.log('杠杆:', r.meta.suggestedLeverage + 'x', '仓位:', r.meta.suggestedPositionPct + '%');
      } catch (e) { console.error(`❌ ${sym}: ${e.message}`); }
    }
  })();
}
