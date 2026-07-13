/**
 * v66: 统计套利/配对交易策略
 * 
 * 基于 Engle-Granger 协整检验的配对交易
 * 1. OLS回归计算对冲比率 (beta)
 * 2. ADF检验残差平稳性
 * 3. Z-score 信号生成
 * 4. 均值回归半衰期估算
 */

class StatArbitrage {
  constructor(config = {}) {
    this.lookbackWindow = config.lookbackWindow || 200;      // 历史数据窗口
    this.zScoreWindow = config.zScoreWindow || 60;            // Z-score滚动窗口
    this.entryThreshold = config.entryThreshold || 2.0;       // 入场Z-score阈值
    this.exitThreshold = config.exitThreshold || 0.5;          // 平仓Z-score阈值
    this.stopLossThreshold = config.stopLossThreshold || 4.0; // 止损Z-score阈值
    this.minHalfLife = config.minHalfLife || 5;                // 最小半衰期
    this.maxHalfLife = config.maxHalfLife || 100;              // 最大半衰期
    this.adfCriticalValue = config.adfCriticalValue || -2.86; // ADF 5%临界值
    this.minCorrelation = config.minCorrelation || 0.5;       // 最低相关系数

    // 状态
    this._pairs = [];          // 已扫描的协整对
    this._activePositions = []; // 活跃配对仓位
    this._priceHistory = {};   // {symbol: [prices]}
    this._scanHistory = [];
    this._totalPnl = 0;
    this._tradeCount = 0;
    this._winCount = 0;
  }

  // ═══════════════════════════════════════════
  // 价格数据更新
  // ═══════════════════════════════════════════
  updatePrice(symbol, price) {
    if (!this._priceHistory[symbol]) this._priceHistory[symbol] = [];
    this._priceHistory[symbol].push(price);
    if (this._priceHistory[symbol].length > this.lookbackWindow) {
      this._priceHistory[symbol].shift();
    }
  }

  // ═══════════════════════════════════════════
  // OLS 回归 — 返回 {beta, alpha, residuals}
  // ═══════════════════════════════════════════
  _olsRegression(y, x) {
    const n = Math.min(y.length, x.length);
    if (n < 30) return null;

    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (let i = 0; i < n; i++) {
      sumX += x[i]; sumY += y[i];
      sumXY += x[i] * y[i]; sumXX += x[i] * x[i];
    }
    const meanX = sumX / n, meanY = sumY / n;
    const denom = sumXX - n * meanX * meanX;
    if (Math.abs(denom) < 1e-12) return null;

    const beta = (sumXY - n * meanX * meanY) / denom;
    const alpha = meanY - beta * meanX;

    const residuals = [];
    for (let i = 0; i < n; i++) {
      residuals.push(y[i] - (alpha + beta * x[i]));
    }

    // R²
    let ssRes = 0, ssTot = 0;
    for (let i = 0; i < n; i++) {
      ssRes += Math.pow(residuals[i], 2);
      ssTot += Math.pow(y[i] - meanY, 2);
    }
    const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;
    const correlation = Math.sqrt(Math.max(0, Math.min(1, rSquared)));

    return { beta, alpha, residuals, rSquared, correlation, n };
  }

  // ═══════════════════════════════════════════
  // ADF 检验 — 返回 {adfStat, pValue, isStationary}
  // ═══════════════════════════════════════════
  _adfTest(series) {
    const n = series.length;
    if (n < 25) return { adfStat: 0, pValue: 1, isStationary: false };

    // Δy_t = α + ρ*y_{t-1} + γ*Δy_{t-1} + ε
    // ADF统计量 = ρ / SE(ρ)
    let prev = series.slice(0, -1);
    let curr = series.slice(1);
    let deltaY = [];
    for (let i = 1; i < n; i++) deltaY.push(series[i] - series[i - 1]);
    let lagDeltaY = deltaY.slice(0, -1);
    let regY = deltaY.slice(1);
    let regX = curr.slice(0, -1); // y_{t-1} for Δy_t

    // 简化ADF: Δy_t = ρ * y_{t-1} + ε
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    const m = regY.length;
    if (m < 3) return { adfStat: 0, pValue: 1, isStationary: false };
    for (let i = 0; i < m; i++) {
      sumX += regX[i]; sumY += regY[i];
      sumXY += regX[i] * regY[i]; sumXX += regX[i] * regX[i];
    }
    const meanX = sumX / m;
    const denom = sumXX - m * meanX * meanX;
    if (Math.abs(denom) < 1e-12) return { adfStat: 0, pValue: 1, isStationary: false };

    const rho = (sumXY - m * meanX * (sumY / m)) / denom;
    // 计算残差和标准误
    const alpha = sumY / m - rho * meanX;
    let ssRes = 0;
    for (let i = 0; i < m; i++) {
      const predicted = alpha + rho * regX[i];
      ssRes += Math.pow(regY[i] - predicted, 2);
    }
    const seRho = Math.sqrt(ssRes / ((m - 2) * denom));
    if (seRho < 1e-12) return { adfStat: 0, pValue: 1, isStationary: false };

    const adfStat = rho / seRho;

    // 近似p值 (MacKinnon临界值近似)
    let pValue;
    if (adfStat < -3.43) pValue = 0.01;
    else if (adfStat < -2.86) pValue = 0.05;
    else if (adfStat < -2.57) pValue = 0.10;
    else pValue = 0.10 + (1 - Math.min(1, adfStat / -2.57)) * 0.4;

    return {
      adfStat,
      pValue: Math.max(0.01, Math.min(1, pValue)),
      isStationary: adfStat < this.adfCriticalValue,
    };
  }

  // ═══════════════════════════════════════════
  // 计算Z-score
  // ═══════════════════════════════════════════
  _calculateZScore(residuals, window) {
    const w = Math.min(window, residuals.length);
    if (w < 10) return 0;
    const slice = residuals.slice(-w);
    const mean = slice.reduce((a, b) => a + b, 0) / w;
    const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / w;
    const std = Math.sqrt(variance);
    if (std < 1e-12) return 0;
    const current = residuals[residuals.length - 1];
    return (current - mean) / std;
  }

  // ═══════════════════════════════════════════
  // 半衰期估算 — AR(1): Δspread_t = α + β*spread_{t-1}
  // 半衰期 = -ln(2) / ln(1 + β)
  // ═══════════════════════════════════════════
  _estimateHalfLife(series) {
    const n = series.length;
    if (n < 20) return 0;

    const deltaY = [];
    const lagY = [];
    for (let i = 1; i < n; i++) {
      deltaY.push(series[i] - series[i - 1]);
      lagY.push(series[i - 1]);
    }

    const m = deltaY.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (let i = 0; i < m; i++) {
      sumX += lagY[i]; sumY += deltaY[i];
      sumXY += lagY[i] * deltaY[i]; sumXX += lagY[i] * lagY[i];
    }
    const meanX = sumX / m;
    const denom = sumXX - m * meanX * meanX;
    if (Math.abs(denom) < 1e-12) return 0;

    const beta = (sumXY - m * meanX * (sumY / m)) / denom;

    if (beta >= 0) return Infinity; // 不均值回归
    const halfLife = -Math.log(2) / Math.log(1 + beta);
    return Math.max(1, Math.min(1000, halfLife));
  }

  // ═══════════════════════════════════════════
  // 扫描所有协整对
  // ═══════════════════════════════════════════
  scanPairs(priceHistory) {
    const symbols = Object.keys(priceHistory).filter(
      s => priceHistory[s] && priceHistory[s].length >= this.lookbackWindow * 0.5
    );
    const results = [];

    for (let i = 0; i < symbols.length; i++) {
      for (let j = i + 1; j < symbols.length; j++) {
        const symA = symbols[i], symB = symbols[j];
        const pricesA = priceHistory[symA];
        const pricesB = priceHistory[symB];
        const n = Math.min(pricesA.length, pricesB.length);
        if (n < 30) continue;

        const alignedA = pricesA.slice(-n);
        const alignedB = pricesB.slice(-n);

        const ols = this._olsRegression(alignedA, alignedB);
        if (!ols || ols.correlation < this.minCorrelation) continue;

        const adf = this._adfTest(ols.residuals);
        if (!adf.isStationary) continue;

        const halfLife = this._estimateHalfLife(ols.residuals);
        if (halfLife < this.minHalfLife || halfLife > this.maxHalfLife) continue;

        const zScore = this._calculateZScore(ols.residuals, this.zScoreWindow);

        results.push({
          symbolA: symA,
          symbolB: symB,
          beta: ols.beta,
          alpha: ols.alpha,
          correlation: ols.correlation,
          rSquared: ols.rSquared,
          adfStat: adf.adfStat,
          pValue: adf.pValue,
          zScore,
          halfLife,
          spread: ols.residuals[ols.residuals.length - 1],
          cointegrationScore: (
            (adf.adfStat < -3.43 ? 3 : adf.adfStat < -2.86 ? 2 : 1) +
            (ols.correlation > 0.8 ? 2 : ols.correlation > 0.6 ? 1 : 0.5) +
            (halfLife > 5 && halfLife < 50 ? 2 : 1)
          ),
        });
      }
    }

    results.sort((a, b) => b.cointegrationScore - a.cointegrationScore);
    this._pairs = results;
    this._scanHistory.push({ time: Date.now(), pairsFound: results.length });
    if (this._scanHistory.length > 50) this._scanHistory.shift();

    return results;
  }

  // ═══════════════════════════════════════════
  // 生成配对交易信号
  // ═══════════════════════════════════════════
  generateSignal(pair) {
    if (!pair) return { action: 'HOLD', reason: '无协整对' };

    const { zScore, symbolA, symbolB, beta } = pair;

    // 检查是否已有持仓
    const existing = this._activePositions.find(
      p => (p.symbolA === symbolA && p.symbolB === symbolB) ||
           (p.symbolA === symbolB && p.symbolB === symbolA)
    );

    if (existing) {
      // 止损
      if (Math.abs(zScore) > this.stopLossThreshold) {
        return {
          action: 'CLOSE_PAIR',
          reason: `止损: Z-score ${zScore.toFixed(2)} 超过 ${this.stopLossThreshold}`,
          pair,
          existing,
        };
      }
      // 平仓
      if (Math.abs(zScore) < this.exitThreshold) {
        return {
          action: 'CLOSE_PAIR',
          reason: `回归均值: Z-score ${zScore.toFixed(2)}`,
          pair,
          existing,
        };
      }
      return { action: 'HOLD_PAIR', reason: `持仓中 Z=${zScore.toFixed(2)}`, pair, existing };
    }

    // 开仓
    if (zScore < -this.entryThreshold) {
      return {
        action: 'LONG_SPREAD',
        direction: 'BUY_A_SELL_B',
        symbolA, symbolB, beta,
        zScore,
        size: Math.min(1, Math.abs(zScore) / 4),
        reason: `Z-score ${zScore.toFixed(2)} < -${this.entryThreshold} → 买入A卖出B`,
        pair,
      };
    }
    if (zScore > this.entryThreshold) {
      return {
        action: 'SHORT_SPREAD',
        direction: 'SELL_A_BUY_B',
        symbolA, symbolB, beta,
        zScore,
        size: Math.min(1, Math.abs(zScore) / 4),
        reason: `Z-score ${zScore.toFixed(2)} > ${this.entryThreshold} → 卖出A买入B`,
        pair,
      };
    }

    return { action: 'HOLD', reason: `Z-score ${zScore.toFixed(2)} 未达阈值`, pair };
  }

  // ═══════════════════════════════════════════
  // 开仓记录
  // ═══════════════════════════════════════════
  openPosition(signal) {
    this._activePositions.push({
      symbolA: signal.symbolA,
      symbolB: signal.symbolB,
      beta: signal.beta,
      entryZScore: signal.zScore,
      entryTime: Date.now(),
      direction: signal.direction,
      pnl: 0,
    });
  }

  // ═══════════════════════════════════════════
  // 平仓记录
  // ═══════════════════════════════════════════
  closePosition(position, pnl) {
    const idx = this._activePositions.indexOf(position);
    if (idx >= 0) {
      this._activePositions.splice(idx, 1);
      this._totalPnl += pnl;
      this._tradeCount++;
      if (pnl > 0) this._winCount++;
    }
  }

  // ═══════════════════════════════════════════
  // 获取最佳信号
  // ═══════════════════════════════════════════
  getSignal() {
    const best = this._pairs[0];
    return this.generateSignal(best);
  }

  // ═══════════════════════════════════════════
  // 汇总
  // ═══════════════════════════════════════════
  getSummary() {
    return {
      totalPairs: this._pairs.length,
      activePositions: this._activePositions.length,
      totalPnl: this._totalPnl,
      tradeCount: this._tradeCount,
      winRate: this._tradeCount > 0 ? (this._winCount / this._tradeCount * 100) : 0,
      bestPair: this._pairs[0] ? `${this._pairs[0].symbolA}/${this._pairs[0].symbolB}` : null,
      bestZScore: this._pairs[0]?.zScore || 0,
      scanCount: this._scanHistory.length,
    };
  }
}

module.exports = { StatArbitrage };
