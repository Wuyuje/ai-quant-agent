/**
 * v60: 尾部风险控制 (Tail Risk Control)
 * 
 * 识别和保护黑天鹅事件：
 * 1. VaR (Value at Risk) — 95%/99%置信区间最大亏损
 * 2. CVaR (Conditional VaR) — 超过VaR的期望亏损
 * 3. 波动率突变检测 — ATR骤增预警
 * 4. 相关性聚变检测 — 危机时所有币种同跌
 * 5. 熔断机制 — 连续亏损自动停止
 * 6. 资金保护 — 动态回撤限制
 */

class TailRiskControl {
  constructor(config = {}) {
    // VaR参数
    this.varConfidence = config.varConfidence || 0.95;  // 95%置信度
    this.cvarConfidence = config.cvarConfidence || 0.99; // 99% CVaR
    this.lookback = config.lookback || 100;               // 回看周期
    
    // 熔断参数
    this.maxConsecutiveLosses = config.maxConsecutiveLosses || 3;  // 连续3次亏损熔断
    this.maxDailyLossPct = config.maxDailyLossPct || 0.05;         // 日最大亏损5%
    this.maxDrawdownPct = config.maxDrawdownPct || 0.10;           // 最大回撤10%
    this.circuitBreakerMs = config.circuitBreakerMs || 3600000;    // 熔断1小时
    
    // ATR突变检测
    this.atrSpikeThreshold = config.atrSpikeThreshold || 2.5;  // ATR超过均值2.5倍
    
    // 相关性聚变
    this.crisisCorrelationThreshold = config.crisisCorrThreshold || 0.8; // 相关性>0.8
    
    // 状态
    this._consecutiveLosses = 0;
    this._dailyPnl = 0;
    this._dailyResetTime = Date.now();
    this._peakEquity = 0;
    this._currentDrawdown = 0;
    this._circuitBreakerUntil = 0;
    this._atrHistory = [];
    this._lossHistory = [];
    this._returnsHistory = [];
    this._lastVaR = 0;
    this._lastCVaR = 0;
  }

  /**
   * 综合风险评估
   * @param {Object} params - { equity, positions, klines, indicators }
   * @returns {Object} 风险评估结果
   */
  assess(params) {
    const { equity, positions = [], indicators, klines } = params;

    // 更新状态
    this._updateEquity(equity);
    this._updateReturns(klines);
    this._updateATRHistory(indicators);

    // ═══ 1. VaR / CVaR 计算 ═══
    const varResult = this._calcVaR();
    this._lastVaR = varResult.var;
    this._lastCVaR = varResult.cvar;

    // ═══ 2. ATR突变检测 ═══
    const atrSpike = this._checkATRSpike(indicators);

    // ═══ 3. 相关性聚变检测 ═══
    const correlationCrash = this._checkCorrelationCrash(positions);

    // ═══ 4. 熔断检查 ═══
    const circuitBreaker = this._checkCircuitBreaker();

    // ═══ 5. 回撤检查 ═══
    const drawdownCheck = this._checkDrawdown(equity);

    // ═══ 6. 日亏损检查 ═══
    const dailyLossCheck = this._checkDailyLoss();

    // ═══ 综合风险等级 ═══
    const riskLevel = this._calcRiskLevel({
      varResult, atrSpike, correlationCrash, circuitBreaker, drawdownCheck, dailyLossCheck,
    });

    // ═══ 行动建议 ═══
    const action = this._recommendAction(riskLevel, {
      circuitBreaker, drawdownCheck, dailyLossCheck, atrSpike,
    });

    return {
      riskLevel,        // 'safe' | 'caution' | 'danger' | 'critical'
      action,           // 'continue' | 'reduce' | 'stop' | 'liquidate'
      var95: varResult.var,
      cvar99: varResult.cvar,
      currentDrawdown: this._currentDrawdown,
      consecutiveLosses: this._consecutiveLosses,
      dailyPnl: this._dailyPnl,
      atrSpike: atrSpike,
      correlationCrash: correlationCrash,
      circuitBreaker: circuitBreaker,
      reason: action.reason,
    };
  }

  /**
   * 记录交易结果（用于连续亏损统计）
   * @param {number} pnl - 盈亏金额
   */
  recordTradeResult(pnl) {
    this._lossHistory.push({ pnl, timestamp: Date.now() });
    if (this._lossHistory.length > 200) this._lossHistory.shift();

    this._dailyPnl += pnl;

    if (pnl < 0) {
      this._consecutiveLosses++;
    } else {
      this._consecutiveLosses = 0;
    }
  }

  /**
   * 重置日统计
   */
  resetDaily() {
    this._dailyPnl = 0;
    this._dailyResetTime = Date.now();
  }

  // ═══ 内部方法 ═══

  _updateEquity(equity) {
    if (equity > this._peakEquity) this._peakEquity = equity;
    this._currentDrawdown = this._peakEquity > 0 
      ? (this._peakEquity - equity) / this._peakEquity 
      : 0;
  }

  _updateReturns(klines) {
    if (!klines || klines.length < 2) return;
    const closes = klines.map(k => k.close);
    for (let i = Math.max(1, closes.length - this.lookback); i < closes.length; i++) {
      const r = (closes[i] - closes[i - 1]) / closes[i - 1];
      this._returnsHistory.push(r);
    }
    if (this._returnsHistory.length > this.lookback) {
      this._returnsHistory = this._returnsHistory.slice(-this.lookback);
    }
  }

  _updateATRHistory(indicators) {
    if (!indicators?.atr) return;
    this._atrHistory.push(indicators.atr);
    if (this._atrHistory.length > 50) this._atrHistory.shift();
  }

  /**
   * VaR计算 — 历史模拟法
   */
  _calcVaR() {
    if (this._returnsHistory.length < 20) {
      return { var: 0, cvar: 0, method: 'insufficient_data' };
    }

    const sorted = [...this._returnsHistory].sort((a, b) => a - b);
    const n = sorted.length;

    // 95% VaR: 第5百分位
    const var95Idx = Math.floor(n * (1 - this.varConfidence));
    const var95 = Math.abs(sorted[var95Idx] || 0);

    // 99% CVaR: 最差1%的均值
    const cvar99Idx = Math.floor(n * (1 - this.cvarConfidence));
    const worstReturns = sorted.slice(0, Math.max(1, cvar99Idx));
    const cvar99 = Math.abs(worstReturns.reduce((a, b) => a + b, 0) / worstReturns.length);

    return { var: var95, cvar: cvar99, method: 'historical' };
  }

  /**
   * ATR突变检测
   */
  _checkATRSpike(indicators) {
    if (!indicators?.atr || this._atrHistory.length < 10) {
      return { isSpike: false };
    }

    const currentATR = indicators.atr;
    const avgATR = this._atrHistory.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, this._atrHistory.length);
    
    if (avgATR <= 0) return { isSpike: false };
    
    const spikeRatio = currentATR / avgATR;
    const isSpike = spikeRatio > this.atrSpikeThreshold;

    return {
      isSpike,
      spikeRatio,
      currentATR,
      avgATR,
      severity: spikeRatio > 4 ? 'extreme' : spikeRatio > 3 ? 'high' : spikeRatio > 2.5 ? 'medium' : 'low',
    };
  }

  /**
   * 相关性聚变检测
   * 当所有持仓相关性突然升高时，说明市场恐慌
   */
  _checkCorrelationCrash(positions) {
    if (!positions || positions.length < 2) {
      return { isCrash: false };
    }

    // 检查持仓是否全部同方向亏损
    const losingPositions = positions.filter(p => (p.pnl || 0) < 0);
    const losingRatio = losingPositions.length / positions.length;
    
    // 超过80%持仓亏损 = 可能相关性聚变
    const isCrash = losingRatio > this.crisisCorrelationThreshold && positions.length >= 3;

    return {
      isCrash,
      losingRatio,
      totalPositions: positions.length,
      losingPositions: losingPositions.length,
    };
  }

  /**
   * 熔断检查
   */
  _checkCircuitBreaker() {
    const now = Date.now();
    
    // 已在熔断期
    if (now < this._circuitBreakerUntil) {
      return {
        active: true,
        remainingMs: this._circuitBreakerUntil - now,
        reason: '熔断中',
      };
    }

    // 触发熔断
    let triggered = false;
    let reason = '';

    if (this._consecutiveLosses >= this.maxConsecutiveLosses) {
      triggered = true;
      reason = `连续${this._consecutiveLosses}次亏损`;
    }

    if (this._dailyPnl < 0 && Math.abs(this._dailyPnl) > this.maxDailyLossPct) {
      triggered = true;
      reason = `日亏损${(this._dailyPnl * 100).toFixed(1)}%超限`;
    }

    if (triggered) {
      this._circuitBreakerUntil = now + this.circuitBreakerMs;
      return { active: true, remainingMs: this.circuitBreakerMs, reason, triggered: true };
    }

    return { active: false, triggered: false };
  }

  /**
   * 回撤检查
   */
  _checkDrawdown(equity) {
    const isDanger = this._currentDrawdown > this.maxDrawdownPct * 0.7;  // 7%
    const isCritical = this._currentDrawdown > this.maxDrawdownPct;      // 10%
    
    return {
      drawdown: this._currentDrawdown,
      peak: this._peakEquity,
      current: equity,
      isDanger,
      isCritical,
      maxAllowed: this.maxDrawdownPct,
    };
  }

  /**
   * 日亏损检查
   */
  _checkDailyLoss() {
    // 每日重置
    if (Date.now() - this._dailyResetTime > 86400000) this.resetDaily();
    
    const lossPct = this._dailyPnl < 0 ? Math.abs(this._dailyPnl) : 0;
    return {
      dailyPnl: this._dailyPnl,
      lossPct,
      isDanger: lossPct > this.maxDailyLossPct * 0.6,
      isCritical: lossPct > this.maxDailyLossPct,
      maxAllowed: this.maxDailyLossPct,
    };
  }

  /**
   * 综合风险等级
   */
  _calcRiskLevel(checks) {
    const { varResult, atrSpike, correlationCrash, circuitBreaker, drawdownCheck, dailyLossCheck } = checks;

    if (circuitBreaker.active || drawdownCheck.isCritical || dailyLossCheck.isCritical) {
      return 'critical';
    }

    if (drawdownCheck.isDanger || dailyLossCheck.isDanger || 
        (atrSpike.isSpike && atrSpike.severity === 'extreme') ||
        correlationCrash.isCrash) {
      return 'danger';
    }

    if (atrSpike.isSpike || varResult.cvar > 0.05 ||
        this._consecutiveLosses >= this.maxConsecutiveLosses - 1) {
      return 'caution';
    }

    return 'safe';
  }

  /**
   * 行动建议
   */
  _recommendAction(riskLevel, checks) {
    switch (riskLevel) {
      case 'critical':
        return {
          action: 'liquidate',  // 清仓
          reducePct: 1.0,
          allowNewPositions: false,
          reason: `CRITICAL: ${checks.circuitBreaker.reason || checks.drawdownCheck.isCritical ? '回撤超限' : '日亏损超限'}`,
        };
      
      case 'danger':
        return {
          action: 'reduce',     // 减仓50%
          reducePct: 0.5,
          allowNewPositions: false,
          reason: `DANGER: ${checks.atrSpike.isSpike ? 'ATR突变' : checks.correlationCrash.isCrash ? '相关性聚变' : '回撤危险'}`,
        };
      
      case 'caution':
        return {
          action: 'reduce',     // 减仓25%
          reducePct: 0.25,
          allowNewPositions: true,
          maxNewPositionPct: 0.10,  // 限制新仓10%
          reason: `CAUTION: ${checks.atrSpike.isSpike ? '波动率升高' : '连续亏损预警'}`,
        };
      
      default:
        return {
          action: 'continue',
          reducePct: 0,
          allowNewPositions: true,
          reason: 'SAFE',
        };
    }
  }

  /**
   * 获取风险报告
   */
  getReport() {
    return {
      riskLevel: this._currentDrawdown > this.maxDrawdownPct ? 'critical' : 
                  this._currentDrawdown > this.maxDrawdownPct * 0.7 ? 'danger' : 'safe',
      var95: this._lastVaR,
      cvar99: this._lastCVaR,
      drawdown: this._currentDrawdown,
      peakEquity: this._peakEquity,
      consecutiveLosses: this._consecutiveLosses,
      dailyPnl: this._dailyPnl,
      circuitBreakerActive: Date.now() < this._circuitBreakerUntil,
    };
  }
}

module.exports = { TailRiskControl };
