/**
 * v66: 期权 Greeks 计算与对冲信号
 * 
 * Black-Scholes 定价 + 全Greeks + 隐含波动率
 * 1. 欧式期权定价 (BSM模型)
 * 2. Delta/Gamma/Vega/Theta/Rho/Vanna/Charm
 * 3. 隐含波动率 (Newton-Raphson)
 * 4. 组合Greeks聚合
 * 5. Delta中性对冲信号
 * 6. Gamma Scalping信号
 * 7. 波动率曲面
 */

// ═══════════════════════════════════════════
// 标准正态分布函数
// ═══════════════════════════════════════════
function _erf(x) {
  // Abramowitz & Stegun 7.1.26 近似
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function _normCDF(x) {
  return 0.5 * (1 + _erf(x / Math.SQRT2));
}

function _normPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

class OptionsGreeks {
  constructor(config = {}) {
    this.riskFreeRate = config.riskFreeRate ?? 0.05;        // 5% 无风险利率
    this.deltaHedgeThreshold = config.deltaHedgeThreshold || 0.1;
    this.gammaScalpThreshold = config.gammaScalpThreshold || 0.05;
    this.vegaThreshold = config.vegaThreshold || 1000;
    this.ivMin = config.ivMin || 0.01;  // 最小IV
    this.ivMax = config.ivMax || 5.0;   // 最大IV
    this.maxIVIterations = config.maxIVIterations || 100;

    this._portfolio = [];  // 持仓
    this._hedgeHistory = [];
    this._totalHedgePnl = 0;
    this._hedgeCount = 0;
  }

  // ═══════════════════════════════════════════
  // Black-Scholes-Merton 定价
  // ═══════════════════════════════════════════
  priceOption(type, S, K, T, r, sigma) {
    if (T <= 0 || sigma <= 0 || S <= 0) {
      // 到期或无效参数 → 内在价值
      if (type === 'call') return Math.max(0, S - K);
      return Math.max(0, K - S);
    }

    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
    const d2 = d1 - sigma * sqrtT;

    const discount = Math.exp(-r * T);

    if (type === 'call') {
      return S * _normCDF(d1) - K * discount * _normCDF(d2);
    } else if (type === 'put') {
      return K * discount * _normCDF(-d2) - S * _normCDF(-d1);
    }
    throw new Error(`Unknown option type: ${type}`);
  }

  // ═══════════════════════════════════════════
  // Greeks 计算
  // ═══════════════════════════════════════════
  calculateGreeks(type, S, K, T, r, sigma) {
    if (T <= 0 || sigma <= 0 || S <= 0) {
      const intrinsic = type === 'call' ? Math.max(0, S - K) : Math.max(0, K - S);
      return {
        delta: intrinsic > 0 ? (type === 'call' ? 1 : -1) : 0,
        gamma: 0, vega: 0, theta: 0, rho: 0, vanna: 0, charm: 0,
        d1: 0, d2: 0,
      };
    }

    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
    const d2 = d1 - sigma * sqrtT;
    const pdfD1 = _normPDF(d1);
    const discount = Math.exp(-r * T);

    // Delta
    const delta = type === 'call' ? _normCDF(d1) : _normCDF(d1) - 1;

    // Gamma (相同 for call/put)
    const gamma = pdfD1 / (S * sigma * sqrtT);

    // Vega (per 1% vol change, same for call/put)
    const vega = S * pdfD1 * sqrtT / 100;

    // Theta (per day)
    const thetaRaw = -(S * pdfD1 * sigma) / (2 * sqrtT);
    let theta;
    if (type === 'call') {
      theta = (thetaRaw - r * K * discount * _normCDF(d2)) / 365;
    } else {
      theta = (thetaRaw + r * K * discount * _normCDF(-d2)) / 365;
    }

    // Rho (per 1% rate change)
    let rho;
    if (type === 'call') {
      rho = K * T * discount * _normCDF(d2) / 100;
    } else {
      rho = -K * T * discount * _normCDF(-d2) / 100;
    }

    // Vanna = ∂Delta/∂σ = -phi(d2) / (S * σ * √T) * (d1/σ√T)
    // 简化: Vanna = -normPDF(d2) * d1 / (sigma * sqrtT)
    const vanna = -_normPDF(d2) * d1 / (sigma * sqrtT);

    // Charm = ∂Delta/∂t (delta decay per day)
    // Charm = -normPDF(d1) * [2*r*T - d2*sigma*sqrtT] / (2*T*sigma*sqrtT) / 365
    const charm = -pdfD1 * (2 * r * T - d2 * sigma * sqrtT) / (2 * T * sigma * sqrtT) / 365;

    return { delta, gamma, vega, theta, rho, vanna, charm, d1, d2 };
  }

  // ═══════════════════════════════════════════
  // 隐含波动率 (Newton-Raphson)
  // ═══════════════════════════════════════════
  impliedVol(marketPrice, type, S, K, T, r) {
    if (T <= 0 || S <= 0 || marketPrice <= 0) return 0;

    // 初始猜测: 30%
    let sigma = 0.3;
    let iteration = 0;

    while (iteration < this.maxIVIterations) {
      const price = this.priceOption(type, S, K, T, r, sigma);
      const diff = price - marketPrice;

      if (Math.abs(diff) < 0.0001) break;

      const greeks = this.calculateGreeks(type, S, K, T, r, sigma);
      const vega = greeks.vega * 100; // vega is per 1%, convert back to per 1.0

      if (Math.abs(vega) < 1e-10) break;

      sigma = sigma - diff / vega;

      // 边界检查
      if (sigma < this.ivMin) { sigma = this.ivMin; break; }
      if (sigma > this.ivMax) { sigma = this.ivMax; break; }

      iteration++;
    }

    return sigma;
  }

  // ═══════════════════════════════════════════
  // 组合 Greeks
  // ═══════════════════════════════════════════
  portfolioGreeks(positions) {
    if (!positions || positions.length === 0) {
      return { delta: 0, gamma: 0, vega: 0, theta: 0, rho: 0, vanna: 0, charm: 0, notional: 0 };
    }

    let totalDelta = 0, totalGamma = 0, totalVega = 0;
    let totalTheta = 0, totalRho = 0, totalVanna = 0, totalCharm = 0;
    let totalNotional = 0;
    const details = [];

    for (const pos of positions) {
      const { type, S, K, T, r = this.riskFreeRate, sigma, quantity } = pos;
      const greeks = this.calculateGreeks(type, S, K, T, r, sigma);

      const signedQty = quantity; // 正=多头, 负=空头
      totalDelta += greeks.delta * signedQty;
      totalGamma += greeks.gamma * signedQty;
      totalVega += greeks.vega * signedQty;
      totalTheta += greeks.theta * signedQty;
      totalRho += greeks.rho * signedQty;
      totalVanna += greeks.vanna * signedQty;
      totalCharm += greeks.charm * signedQty;
      totalNotional += S * Math.abs(quantity);

      details.push({
        type, S, K, T, sigma, quantity,
        ...greeks,
        contribution: {
          delta: greeks.delta * signedQty,
          vega: greeks.vega * signedQty,
          theta: greeks.theta * signedQty,
        },
      });
    }

    return {
      delta: totalDelta,
      gamma: totalGamma,
      vega: totalVega,
      theta: totalTheta,
      rho: totalRho,
      vanna: totalVanna,
      charm: totalCharm,
      notional: totalNotional,
      positionCount: positions.length,
      details,
    };
  }

  // ═══════════════════════════════════════════
  // Delta 对冲信号
  // ═══════════════════════════════════════════
  generateHedgeSignal(portfolioGreeks, spotPrice) {
    const currentDelta = portfolioGreeks.delta;
    const targetDelta = 0;

    // 需要对冲的数量 = -delta (买入/卖出标的)
    const hedgeQuantity = -currentDelta;

    let action = 'HOLD';
    if (Math.abs(currentDelta) > this.deltaHedgeThreshold) {
      action = hedgeQuantity > 0 ? 'BUY' : 'SELL';
    }

    const result = {
      action,
      quantity: Math.abs(hedgeQuantity),
      direction: hedgeQuantity > 0 ? 'BUY' : 'SELL',
      currentDelta,
      targetDelta,
      hedgeNotional: Math.abs(hedgeQuantity) * spotPrice,
      gamma: portfolioGreeks.gamma,
      vega: portfolioGreeks.vega,
      theta: portfolioGreeks.theta,
    };

    // Gamma scalping 检查
    if (Math.abs(portfolioGreeks.gamma) > this.gammaScalpThreshold &&
        Math.abs(currentDelta) > this.deltaHedgeThreshold) {
      result.gammaScalp = true;
      result.suggestion = `Gamma ${portfolioGreeks.gamma.toFixed(4)} 较大, Delta偏离 ${currentDelta.toFixed(4)}, 建议动态对冲`;
    }

    this._hedgeHistory.push({ ...result, time: Date.now() });
    if (this._hedgeHistory.length > 100) this._hedgeHistory.shift();
    if (action !== 'HOLD') this._hedgeCount++;

    return result;
  }

  // ═══════════════════════════════════════════
  // 波动率曲面 (简化: sticky-strike + skew)
  // ═══════════════════════════════════════════
  volSurface(strikes, maturities, spotPrice, baseVol) {
    const surface = [];

    for (const T of maturities) {
      const row = { maturity: T, points: [] };
      for (const K of strikes) {
        const moneyness = spotPrice > 0 ? K / spotPrice : 1;
        // Skew: OTM put 更贵 (更高IV), OTM call 更便宜
        const skewFactor = moneyness < 1
          ? 1 + Math.pow(1 - moneyness, 1.5) * 0.3   // 左偏
          : 1 - Math.pow(moneyness - 1, 1.5) * 0.15;
        // 期限结构: 短期更高IV (波动率期限结构倒挂)
        const termFactor = T < 0.25 ? 1 + (0.25 - T) * 0.5 : 1 + Math.log(T / 0.25) * 0.05;
        const iv = baseVol * skewFactor * termFactor;

        row.points.push({
          strike: K,
          moneyness,
          iv: Math.max(this.ivMin, Math.min(this.ivMax, iv)),
          greeks: this.calculateGreeks('call', spotPrice, K, T, this.riskFreeRate, iv),
        });
      }
      surface.push(row);
    }

    return surface;
  }

  // ═══════════════════════════════════════════
  // 风险指标
  // ═══════════════════════════════════════════
  riskMetrics(portfolioGreeks, spotPrice) {
    return {
      maxGammaExposure: Math.abs(portfolioGreeks.gamma) * spotPrice * 0.1, // 10%价格变动
      thetaDecay: portfolioGreeks.theta,                                    // 每日theta
      vegaExposure: portfolioGreeks.vega,                                   // 每1% IV变动
      deltaExposure: portfolioGreeks.delta * spotPrice,                     // Delta美元敞口
      gammaExposurePct: portfolioGreeks.gamma > 0
        ? (portfolioGreeks.gamma * spotPrice * 0.05) / spotPrice * 100
        : 0,
    };
  }

  // ═══════════════════════════════════════════
  // 汇总
  // ═══════════════════════════════════════════
  getSummary() {
    const pg = this.portfolioGreeks(this._portfolio);
    const hedge = this._hedgeHistory[this._hedgeHistory.length - 1];
    return {
      portfolioDelta: pg.delta,
      portfolioGamma: pg.gamma,
      portfolioVega: pg.vega,
      portfolioTheta: pg.theta,
      positionCount: this._portfolio.length,
      hedgeCount: this._hedgeCount,
      lastHedge: hedge || null,
      riskFreeRate: this.riskFreeRate,
    };
  }

  // ═══════════════════════════════════════════
  // 信号
  // ═══════════════════════════════════════════
  getSignal(spotPrice) {
    if (this._portfolio.length === 0) {
      return { action: 'HOLD', reason: '无期权持仓' };
    }
    const pg = this.portfolioGreeks(this._portfolio);
    return this.generateHedgeSignal(pg, spotPrice);
  }

  // ═══════════════════════════════════════════
  // 持仓管理
  // ═══════════════════════════════════════════
  addPosition(position) {
    this._portfolio.push(position);
  }
  removePosition(index) {
    if (index >= 0 && index < this._portfolio.length) this._portfolio.splice(index, 1);
  }
  clearPositions() {
    this._portfolio = [];
  }
}

module.exports = { OptionsGreeks };
