/**
 * v60: ML趋势预测引擎
 * 
 * 不依赖外部库，纯JS实现轻量级ML模型：
 * 1. 指数加权移动平均（EWMA）趋势预测
 * 2. 动量因子模型
 * 3. 均值回归Z-Score
 * 4. 多因子加权预测
 * 
 * 输出：方向概率(0-1) + 预测强度 + 时间衰减
 */

class MLPredictor {
  constructor(config = {}) {
    this.lookback = config.lookback || 60;      // 回看窗口
    this.shortWindow = config.shortWindow || 5;  // 短期窗口
    this.midWindow = config.midWindow || 20;     // 中期窗口
    this.longWindow = config.longWindow || 50;   // 长期窗口
    this.decayFactor = config.decayFactor || 0.94; // EWMA衰减
    this.threshold = config.threshold || 0.30;    // v69: 信号阈值降低(0.55→0.30)
    
    // 在线学习状态
    this._predictions = [];     // 历史预测结果
    this._actuals = [];         // 实际结果
    this._weights = {           // 动态因子权重（初始值）
      momentum: 0.35,
      meanReversion: 0.25,
      trendFollow: 0.25,
      microstructure: 0.15,
    };
    this._accuracy = {           // 各因子准确率追踪
      momentum: 0.5,
      meanReversion: 0.5,
      trendFollow: 0.5,
      microstructure: 0.5,
    };
    this._updateCount = 0;

    // v69: 模型是否已初始化（首次使用时重新训练）
    this._modelTrained = false;
  }

  /**
   * 预测价格方向
   * @param {Array} klines - K线数据
   * @param {Object} indicators - DataBus指标
   * @returns {Object} 预测结果
   */
  predict(klines, indicators) {
    if (!klines || klines.length < this.longWindow + 5) {
      return { valid: false, direction: 0, confidence: 0, reason: '数据不足' };
    }

    const closes = klines.map(k => k.close);
    const volumes = klines.map(k => k.volume || 0);
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);
    const currentPrice = closes[closes.length - 1];

    // ═══ 因子1: 动量预测 ═══
    const momentum = this._calcMomentum(closes, volumes);

    // ═══ 因子2: 均值回归 ═══
    const meanReversion = this._calcMeanReversion(closes, indicators);

    // ═══ 因子3: 趋势跟随 ═══
    const trendFollow = this._calcTrendFollow(closes, indicators);

    // ═══ 因子4: 微观结构（量价关系） ═══
    const microstructure = this._calcMicrostructure(closes, volumes, highs, lows);

    // ═══ 加权融合 ═══
    const fusedScore = 
      momentum.score * this._weights.momentum +
      meanReversion.score * this._weights.meanReversion +
      trendFollow.score * this._weights.trendFollow +
      microstructure.score * this._weights.microstructure;

    // 方向：+1=看多, -1=看空, 0=中性
    const direction = fusedScore > this.threshold ? 1 : 
                      fusedScore < -this.threshold ? -1 : 0;
    
    // 置信度：|fusedScore| 归一化到 0-1
    const confidence = Math.min(1, Math.abs(fusedScore));

    // 各因子一致性检查
    const factors = [momentum, meanReversion, trendFollow, microstructure];
    const agreeCount = factors.filter(f => Math.sign(f.score) === Math.sign(fusedScore) && f.score !== 0).length;
    const consistencyRatio = agreeCount / factors.length;

    // 一致性越高，置信度越高
    const adjustedConfidence = confidence * (0.5 + 0.5 * consistencyRatio);

    return {
      valid: true,
      direction,          // 1=多, -1=空, 0=中性
      confidence: adjustedConfidence,
      fusedScore,
      consistency: consistencyRatio,
      factors: {
        momentum: { score: momentum.score, signal: momentum.signal, weight: this._weights.momentum },
        meanReversion: { score: meanReversion.score, signal: meanReversion.signal, weight: this._weights.meanReversion },
        trendFollow: { score: trendFollow.score, signal: trendFollow.signal, weight: this._weights.trendFollow },
        microstructure: { score: microstructure.score, signal: microstructure.signal, weight: this._weights.microstructure },
      },
      predictedPrice: this._predictNextPrice(closes, direction, adjustedConfidence),
      timeHorizon: this._estimateHorizon(closes),
    };
  }

  /**
   * 因子1: 动量预测
   * 使用多周期ROC + 加权动量
   */
  _calcMomentum(closes, volumes) {
    const n = closes.length;
    const price = closes[n - 1];

    // 多周期ROC
    const roc5 = this._roc(closes, 5);
    const roc10 = this._roc(closes, 10);
    const roc20 = this._roc(closes, 20);
    const roc50 = this._roc(closes, 50);

    // 加权动量：短期权重高
    const weightedRoc = roc5 * 0.4 + roc10 * 0.3 + roc20 * 0.2 + roc50 * 0.1;

    // v69: 归一化到 [-1, 1] — 降低放大倍数，使信号更有区分度
    // 日线级别ROC通常0.01-0.05，乘以20后变成0.2-1.0
    const score = Math.max(-1, Math.min(1, weightedRoc * 20));

    let signal = 'NEUTRAL';
    if (score > 0.2) signal = 'BULLISH';
    else if (score < -0.2) signal = 'BEARISH';

    return { score, signal, details: { roc5, roc10, roc20, roc50 } };
  }

  /**
   * 因子2: 均值回归
   * Z-Score偏离度 + RSI
   */
  _calcMeanReversion(closes, ind) {
    const n = closes.length;
    const price = closes[n - 1];

    // Z-Score: (price - mean) / std
    const window = closes.slice(-this.midWindow);
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const variance = window.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / window.length;
    const std = Math.sqrt(variance) || 0.0001;
    const zScore = (price - mean) / std;

    // RSI超买超卖
    const rsi = ind?.rsi || 50;

    // v69: 均值回归逻辑 — 扩大触发范围
    // Z-Score < -1.0 + RSI < 40 → 看多（超卖回归）
    // Z-Score > 1.0 + RSI > 60 → 看空（超买回归）
    let score = 0;
    if (zScore < -1.0 && rsi < 40) {
      score = Math.min(1, Math.abs(zScore) / 2);  // v69: 超卖看多（降低门槛）
    } else if (zScore > 1.0 && rsi > 60) {
      score = -Math.min(1, Math.abs(zScore) / 2);  // v69: 超买卖空
    } else {
      // v69: 中间区域：极轻反向（趋势市场不应反向）
      score = -zScore * 0.08;  // v69: 大幅降低(0.25→0.08)，避免与趋势因子冲突
    }

    let signal = 'NEUTRAL';
    if (score > 0.2) signal = 'OVERSOLD_REVERSION';
    else if (score < -0.2) signal = 'OVERBOUGHT_REVERSION';

    return { score, signal, details: { zScore, rsi, mean, std } };
  }

  /**
   * 因子3: 趋势跟随
   * EWMA + 斜率 + ADX趋势强度
   */
  _calcTrendFollow(closes, ind) {
    const n = closes.length;

    // EWMA
    const ewmaShort = this._ewma(closes, this.shortWindow);
    const ewmaMid = this._ewma(closes, this.midWindow);
    const ewmaLong = this._ewma(closes, this.longWindow);

    // 三线排列
    const bullAlignment = ewmaShort > ewmaMid && ewmaMid > ewmaLong;
    const bearAlignment = ewmaShort < ewmaMid && ewmaMid < ewmaLong;

    // EWMA斜率（趋势加速度）
    const recentEWMA = this._ewma(closes.slice(-10), this.shortWindow);
    const olderEWMA = this._ewma(closes.slice(-20, -10), this.shortWindow);
    const ewmaSlope = recentEWMA && olderEWMA ? (recentEWMA - olderEWMA) / olderEWMA : 0;

    // ADX趋势强度
    const adx = ind?.adx || 0;
    const plusDI = ind?.plusDI || 0;
    const minusDI = ind?.minusDI || 0;

    // v69: 趋势跟随逻辑 — 不要求ADX>20也可产生信号
    let score = 0;
    if (bullAlignment) {
      score = 0.3 + Math.min(0.7, (adx - 10) / 30);  // v69: 基础分0.3，ADX加分
      if (adx > 20 && plusDI > minusDI) score *= 1.2;
    } else if (bearAlignment) {
      score = -0.3 - Math.min(0.7, (adx - 10) / 30);
      if (adx > 20 && minusDI > plusDI) score *= 1.2;
    }

    // 斜率加速度加成
    score += ewmaSlope * 2;
    score = Math.max(-1, Math.min(1, score));

    let signal = 'NEUTRAL';
    if (score > 0.2) signal = 'UPTREND';
    else if (score < -0.2) signal = 'DOWNTREND';

    return { score, signal, details: { ewmaShort, ewmaMid, ewmaLong, adx, plusDI, minusDI, ewmaSlope } };
  }

  /**
   * 因子4: 微观结构
   * 量价关系 + 买卖压力
   */
  _calcMicrostructure(closes, volumes, highs, lows) {
    const n = closes.length;
    const recent = 20;
    
    // 量价相关性
    const recentCloses = closes.slice(-recent);
    const recentVolumes = volumes.slice(-recent);
    
    const avgVol = recentVolumes.reduce((a, b) => a + b, 0) / recent || 1;
    const currentVol = recentVolumes[recentVolumes.length - 1];
    const volRatio = currentVol / avgVol;

    // 上涨时放量 → 看多
    // 下跌时放量 → 看空
    const priceChange = (recentCloses[recentCloses.length - 1] - recentCloses[recentCloses.length - 2]) / recentCloses[recentCloses.length - 2];
    const volConfirm = volRatio > 1.2 ? 1 : volRatio < 0.8 ? 0.5 : 0.8;

    // 上下影线分析
    const lastHigh = highs[n - 1];
    const lastLow = lows[n - 1];
    const lastOpen = closes[n - 2] || lastHigh;
    const lastClose = closes[n - 1];
    const range = lastHigh - lastLow || 0.0001;
    const upperShadow = lastHigh - Math.max(lastOpen, lastClose);
    const lowerShadow = Math.min(lastOpen, lastClose) - lastLow;
    const body = Math.abs(lastClose - lastOpen);

    // 下影线长 + 阳线 → 买盘支撑
    // 上影线长 + 阴线 → 卖盘压力
    let structureScore = 0;
    if (lowerShadow > body * 1.5 && lastClose > lastOpen) {
      structureScore = 0.3 * volConfirm;  // 买盘支撑
    } else if (upperShadow > body * 1.5 && lastClose < lastOpen) {
      structureScore = -0.3 * volConfirm;  // 卖盘压力
    }

    // v69: 微观结构 — 增强量价方向的信号强度
    structureScore += priceChange * volRatio * 8;  // v69: 5→8 增强
    structureScore = Math.max(-1, Math.min(1, structureScore));

    let signal = 'NEUTRAL';
    if (structureScore > 0.2) signal = 'BUY_PRESSURE';
    else if (structureScore < -0.2) signal = 'SELL_PRESSURE';

    return { score: structureScore, signal, details: { volRatio, priceChange, upperShadow, lowerShadow, body } };
  }

  /**
   * 在线学习：根据实际结果更新权重
   * @param {number} predictedDir - 预测方向
   * @param {number} actualDir - 实际方向
   * @param {Object} factorScores - 各因子分数
   */
  learn(predictedDir, actualDir, factorScores) {
    this._predictions.push(predictedDir);
    this._actuals.push(actualDir);
    if (this._predictions.length > 200) {
      this._predictions.shift();
      this._actuals.shift();
    }

    const correct = predictedDir === actualDir ? 1 : 0;
    
    // 更新各因子准确率
    for (const [name, factor] of Object.entries(factorScores || {})) {
      const factorDir = factor.score > 0 ? 1 : factor.score < 0 ? -1 : 0;
      const factorCorrect = factorDir === actualDir ? 1 : 0;
      this._accuracy[name] = this._accuracy[name] * 0.95 + factorCorrect * 0.05;
    }

    // 动态调整权重：准确率高的因子权重增加
    const totalAccuracy = Object.values(this._accuracy).reduce((a, b) => a + b, 0);
    if (totalAccuracy > 0) {
      for (const name of Object.keys(this._weights)) {
        const normalized = this._accuracy[name] / (totalAccuracy / 4);
        // 平滑调整，避免剧烈变化
        this._weights[name] = this._weights[name] * 0.9 + normalized * 0.1;
      }
      // 归一化权重
      const totalWeight = Object.values(this._weights).reduce((a, b) => a + b, 0);
      for (const name of Object.keys(this._weights)) {
        this._weights[name] /= totalWeight;
      }
    }

    this._updateCount++;
  }

  /**
   * 获取学习统计
   */
  getStats() {
    const total = this._predictions.length;
    if (total === 0) return { totalPredictions: 0, accuracy: 0, weights: this._weights };
    const correct = this._predictions.filter((p, i) => p === this._actuals[i]).length;
    return {
      totalPredictions: total,
      accuracy: correct / total,
      factorAccuracy: { ...this._accuracy },
      weights: { ...this._weights },
      updateCount: this._updateCount,
    };
  }

  // ═══ 工具方法 ═══

  _roc(closes, period) {
    if (closes.length <= period) return 0;
    return (closes[closes.length - 1] - closes[closes.length - 1 - period]) / closes[closes.length - 1 - period];
  }

  _ewma(data, period) {
    if (data.length < period) return data[data.length - 1] || 0;
    let ewma = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < data.length; i++) {
      ewma = data[i] * this.decayFactor + ewma * (1 - this.decayFactor);
    }
    return ewma;
  }

  _predictNextPrice(closes, direction, confidence) {
    const price = closes[closes.length - 1];
    const recentVolatility = this._calcVolatility(closes);
    // 预测下一根K线的价格变动
    const movePct = recentVolatility * 0.5 * confidence * direction;
    return price * (1 + movePct);
  }

  _calcVolatility(closes) {
    const window = closes.slice(-20);
    const returns = [];
    for (let i = 1; i < window.length; i++) {
      returns.push((window[i] - window[i - 1]) / window[i - 1]);
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
    return Math.sqrt(variance);
  }

  _estimateHorizon(closes) {
    // 根据波动率估计信号有效时间（K线根数）
    const vol = this._calcVolatility(closes);
    if (vol < 0.005) return 24;   // 低波动：信号持续24根
    if (vol < 0.015) return 12;   // 中波动：12根
    if (vol < 0.03) return 6;     // 高波动：6根
    return 3;                       // 极端波动：3根
  }
}

module.exports = { MLPredictor };
