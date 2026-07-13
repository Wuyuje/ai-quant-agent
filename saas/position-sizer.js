const fs = require('fs');
const path = require('path');

/**
 * PositionSizer — 动态仓位计算器 (v115)
 * 
 * 根据实时余额、市场波动率、当前持仓、信号强度
 * 自动计算：杠杆倍数、仓位大小、持仓数量上限
 * 
 * 核心原则：
 *   1. 余额越多 → 可以持有更多仓位、更大金额
 *   2. 波动率越高 → 降低杠杆、缩小仓位
 *   3. 信号越强 → 可以适当放大仓位
 *   4. 已有持仓越多 → 新仓越小（风险分散）
 *   5. 最大回撤保护 → 连续亏损自动缩仓
 */

class PositionSizer {
  constructor(config = {}) {
    // ═══ 基础参数 ═══
    this.minTradeUsd = config.minTradeUsd || 5;       // 最小交易额（低于此不开仓）
    this.maxTotalExposurePct = config.maxTotalExposurePct || 0.80;  // v116: 80% — 激进模式，留20%缓冲
    this.maxSingleExposurePct = config.maxSingleExposurePct || 0.30;  // v116: 每仓30%保证金（从22%提升）
    this.minSingleExposurePct = config.minSingleExposurePct || 0.18;  // v116: 最小18%
    
    // ═══ 杠杆限制 ═══
    this.maxLeverage = config.maxLeverage || 10;  // v116: 从5x→10x上限，强趋势可达10x
    this.minLeverage = config.minLeverage || 3;   // v116: 最低3x（从1x提升）
    
    // v115: 从 adaptive-params.json 实时读取 Repairbot 设置的风控参数
    this._adaptiveParamsFile = config.adaptiveParamsFile || path.join(__dirname, '..', 'data', 'adaptive-params.json');
    this._adaptiveParamsCache = null;
    this._adaptiveParamsTs = 0;
    
    // ═══ 波动率阈值（ATR%）═══
    this.volLowThreshold = config.volLowThreshold || 0.5;   // 低波动 <0.5%
    this.volMidThreshold = config.volMidThreshold || 1.5;    // 中波动 0.5-1.5%
    this.volHighThreshold = config.volHighThreshold || 3.0;  // 高波动 >3%
    this.volExtremeThreshold = config.volExtremeThreshold || 5.0; // 极端波动 >5%
    
    // ═══ 回撤保护 ═══
    this.consecutiveLosses = 0;
    this.maxConsecutiveLosses = config.maxConsecutiveLosses || 3;
    this.drawdownScalePcts = [1.0, 0.8, 0.6, 0.4, 0.3, 0.2, 0.1]; // 每次亏损后的缩放比例
    
    // v116: 信号强度映射 — 激进模式
    this.signalStrengthMap = {
      strong: 1.0,       // 强信号 → 100%
      moderate: 0.85,    // v116: 0.80→0.85 中等信号仓位加大
      weak: 0.5,         // v116: 0.0→0.5 弱信号也开仓（但仓位小）
    };
    
    // ═══ 统计 ═══
    this.stats = { totalSized: 0, totalRejected: 0 };
  }

  /**
   * v115: 从 adaptive-params.json 读取 Repairbot 设置的风控参数
   * 缓存3秒，避免每次开仓都读文件
   */
  _getAdaptiveParams() {
    const now = Date.now();
    if (this._adaptiveParamsCache && now - this._adaptiveParamsTs < 3000) {
      return this._adaptiveParamsCache;
    }
    try {
      const raw = fs.readFileSync(this._adaptiveParamsFile, 'utf8');
      this._adaptiveParamsCache = JSON.parse(raw);
      this._adaptiveParamsTs = now;
    } catch (e) {
      this._adaptiveParamsCache = this._adaptiveParamsCache || {};
    }
    return this._adaptiveParamsCache;
  }

  /**
   * v115: 获取当前有效最大杠杆（受 adaptive-params.json 的 maxLeverage 限制）
   */
  getEffectiveMaxLeverage() {
    const params = this._getAdaptiveParams();
    const adaptiveMaxLev = params.maxLeverage || this.maxLeverage;
    return Math.min(this.maxLeverage, adaptiveMaxLev);
  }

  /**
   * v113.42: 读取Supervisor策略指令 — 三大机器人协作
   * Supervisor分析市场 → 写策略 → PositionSizer/RepairBot执行
   */
  _getSupervisorStrategy() {
    const now = Date.now();
    if (this._supervisorCache && now - this._supervisorTs < 10000) {
      return this._supervisorCache;
    }
    try {
      const strategyPath = path.join(__dirname, '..', 'supervisor', 'strategy', 'current-strategy.json');
      this._supervisorCache = JSON.parse(fs.readFileSync(strategyPath, 'utf8'));
      this._supervisorTs = now;
    } catch (e) {
      this._supervisorCache = this._supervisorCache || null;
      this._supervisorTs = now;
    }
    return this._supervisorCache;
  }

  /**
   * v113.42: 获取Supervisor建议的K线级别
   */
  getRecommendedTimeframe() {
    const strategy = this._getSupervisorStrategy();
    return strategy?.timeframe?.recommended || null;
  }

  /**
   * v113.42: 获取Supervisor的风险等级
   */
  getRiskLevel() {
    const strategy = this._getSupervisorStrategy();
    return strategy?.riskLevel || 'normal';
  }

  /**
   * v113.42: 获取Supervisor建议的选币范围
   */
  getSymbolFocus() {
    const strategy = this._getSupervisorStrategy();
    return {
      focus: strategy?.symbolSelection?.focus || [],
      blacklist: strategy?.symbolSelection?.blacklist || [],
      mode: strategy?.symbolSelection?.mode || 'normal',
    };
  }

  /**
   * 核心：计算仓位参数
   * 
   * @param {Object} ctx
   * @param {number} ctx.balanceUsd      — 可用余额(USDT)
   * @param {number} ctx.atrPct          — 当前ATR百分比（波动率）
   * @param {number} ctx.currentPrice    — 当前价格
   * @param {string} ctx.signalStrength  — 'strong' | 'moderate' | 'weak'
   * @param {number} ctx.confidence      — 信号置信度 0-1
   * @param {number} ctx.posCount        — 当前持仓数
   * @param {Object} ctx.marketCap       — 市值信息（可选）
   * @param {Object} ctx.trendStrength   — 趋势强度 (可选) v113.15: 顺势加杠杆加仓
   * @returns {Object} { leverage, positionSize, notional, maxPositions, reject, reason }
   */
  size(ctx) {
    const {
      balanceUsd = 0,
      atrPct = 2.0,
      currentPrice = 0,
      signalStrength = 'moderate',
      confidence = 0.5,
      posCount = 0,
      trendStrength = 0,  // v113.15: 顺势强度加分 0-2
    } = ctx;

    // ═══ 1. 余额检查 ═══
    if (balanceUsd < this.minTradeUsd) {
      this.stats.totalRejected++;
      return { reject: true, reason: `余额不足 $${balanceUsd.toFixed(2)} < $${this.minTradeUsd}` };
    }

    // ═══ 2. 动态计算最大持仓数 ═══
    // 余额越多 → 可持更多仓位，但有上限
    const maxPositions = this._calcMaxPositions(balanceUsd);

    // ═══ 3. 动态杠杆 ═══
    // 波动率越高 → 杠杆越低；余额越大 → 可以稍微高杠杆（有回旋余地）
    // v115: 受 adaptive-params.json 的 maxLeverage 限制
    // v122.5: ATR阈值从0.5%降到0.25% — 低波动市场也能开仓, 用更紧止损控制风险
    if (atrPct < 0.25) {
      return { reject: true, reason: `ATR=${atrPct.toFixed(2)}%太低(<0.25%) — 波动太小成本吞噬利润` };
    }
    const adaptiveMaxLev = this.getEffectiveMaxLeverage();
    let leverage = this._calcLeverage(atrPct, balanceUsd, confidence, trendStrength);
    // v116: 强趋势加杠杆已经在 _calcLeverage 内部处理，这里不再重复
    // 但保留一个安全上限：不超过 adaptiveMaxLev
    leverage = Math.min(adaptiveMaxLev, leverage);

    // ═══ 4. 动态仓位大小 ═══
    // 基于Kelly思想：置信度越高→仓位越大；波动率越高→仓位越小
    // v113.15: 顺势加仓
    const positionSize = this._calcPositionSize({
      balanceUsd, atrPct, confidence, signalStrength, posCount, maxPositions, trendStrength
    });

    // ═══ 5. 最小交易额检查 ═══
    const notional = positionSize * leverage;
    if (notional < this.minTradeUsd) {
      this.stats.totalRejected++;
      return { reject: true, reason: `名义值 $${notional.toFixed(2)} < $${this.minTradeUsd}` };
    }

    // ═══ 6. 敞口检查 ═══
    const totalExposure = positionSize * posCount;
    const exposurePct = totalExposure / balanceUsd;
    if (exposurePct > this.maxTotalExposurePct) {
      this.stats.totalRejected++;
      return { reject: true, reason: `总敞口 ${(exposurePct * 100).toFixed(0)}% > ${(this.maxTotalExposurePct * 100)}%` };
    }

    this.stats.totalSized++;

    return {
      leverage,
      positionSize: Math.round(positionSize * 100) / 100,
      notional: Math.round(notional * 100) / 100,
      maxPositions,
      reject: false,
      details: {
        balancePct: ((positionSize / balanceUsd) * 100).toFixed(1) + '%',
        volRegime: this._volRegime(atrPct),
        drawdownScale: this._currentDrawdownScale(),
        confidence,
        signalStrength,
      }
    };
  }

  /**
   * v113.61: 阶梯式动态最大持仓数 — 严格数学计算
   *
   * 硬约束:
   *   1. 每仓保证金 >=  (Binance最低下单量)
   *   2. 总敞口 <= 66% (留34%缓冲: 手续费+滑点+资金费+浮亏)
   *   3. 杠杆 <= 5x
   *
   * 计算逻辑:
   *   理想仓位 = floor(余额 * 66% / )  -> 余额越大仓位越多
   *   但仓位越多 -> 单仓敞口越小 -> 不能小于Binance最小下单量
   *   所以实际仓位 = min(理想仓位, 余额/每仓最小保证金)
   *
   * 阶梯表 (按可用余额，确保每仓保证金 >= ):
   *   -9      -> 1仓  (66%*1=66%,   保证金.3-5.9)
   *   0-19    -> 2仓  (33%*2=66%,   每仓.3-6.3) <- 不足时自动降到1仓
   *   0-39    -> 3仓  (22%*3=66%,   每仓.4-8.6) <- 不足时自动降到2仓
   *   0-79    -> 4仓  (16.5%*4=66%, 每仓.6-13)
   *   0-149   -> 5仓  (13.2%*5=66%, 每仓0.6-19.7)
   *   50-299  -> 6仓  (11%*6=66%,   每仓6.5-33)
   *   00-599  -> 7仓  (9.4%*7=66%,  每仓8-56.5)
   *   00-1199 -> 8仓  (8.3%*8=66%,  每仓9.5-99)
   *   200-2499-> 9仓  (7.3%*9=66%,  每仓8-183)
   *   500+    -> 10仓 (6.6%*10=66%, 每仓65+)
   */
  _calcMaxPositions(balance) {
    // v113.56回滚: 用户要求最多3个仓位
    return 3;
  }

  /**
   * 动态杠杆
   * 核心逻辑：波动率反比 + 余额正比 + 置信度修正
   */
  /**
   * v113.41: 量化计算杠杆 — 基于爆仓距离、ATR、盈亏比
   * 
   * 核心公式：
   *   爆仓距离(价格%) = 100 / 杠杆
   *   止损距离(价格%) = 止损净利% / 杠杆
   *   要求: 止损距离 > 1×ATR（噪音不打止损）
   *   要求: 爆仓距离 > 止损距离 × 3（安全缓冲3倍）
   *   要求: 爆仓距离 > 5%（趋势策略最低安全线）
   * 
   * 推导: 杠杆 ≤ 100 / max(ATR × 1.5, 5)  (止损 > 1.5ATR, 爆仓 > 5%)
   */
  _calcLeverage(atrPct, balance, confidence, trendStrength = 0) {
    const adaptiveMaxLev = this.getEffectiveMaxLeverage();
    
    const slPct = Math.abs(this._getAdaptiveParams().stopLossPct || 5);
    
    // v116: 止损 > 1.0×ATR (保持不变)
    const levFromSl = slPct / (1.0 * Math.max(atrPct, 0.1));
    
    // v116: 爆仓距离 > 5%（价格5%）
    const levFromLiq = 100 / 5;
    
    // 基础杠杆
    let baseLev = Math.floor(Math.min(levFromSl, levFromLiq, adaptiveMaxLev));
    
    // v116: 基础杠杆保底5x
    baseLev = Math.max(5, baseLev);
    
    // v116: 置信度加成
    if (confidence > 0.8) baseLev = Math.min(baseLev + 1, adaptiveMaxLev);
    
    // v116: 强趋势加杠杆 — 核心改动
    // 趋势越强，杠杆越高，最高可达 maxLeverage
    if (trendStrength >= 2.0) {
      baseLev = Math.min(adaptiveMaxLev, baseLev + 5);  // 超强趋势 +5杠杆
    } else if (trendStrength >= 1.5) {
      baseLev = Math.min(adaptiveMaxLev, baseLev + 3);  // 强趋势 +3杠杆
    } else if (trendStrength >= 1.0) {
      baseLev = Math.min(adaptiveMaxLev, baseLev + 2);  // 中等趋势 +2杠杆
    } else if (trendStrength >= 0.5) {
      baseLev = Math.min(adaptiveMaxLev, baseLev + 1);  // 弱趋势 +1杠杆
    }
    
    // 回撤保护：连续亏损降杠杆
    const scale = this._currentDrawdownScale();
    baseLev = Math.max(this.minLeverage, Math.round(baseLev * scale));
    
    // 最终限制
    baseLev = Math.max(this.minLeverage, Math.min(adaptiveMaxLev, baseLev));
    
    return baseLev;
  }

  /**
   * 动态仓位大小
   * Kelly启发：f = confidence * positionFraction * volAdj * drawdownAdj
   */
  /**
   * v113.41: 量化计算仓位 — 基于Kelly公式 + 风险预算
   * 
   * 核心公式：
   *   单笔风险 = 余额 × riskPerTrade%（每次交易最多亏2%余额）
   *   保证金 = 单笔风险 / 止损净利%
   *   保证金比例 = 保证金 / 余额
   * 
   * 推导：
   *   亏止损时亏的保证金 = 保证金 × 止损净利% = 余额 × riskPerTrade%
   *   → 保证金 = 余额 × riskPerTrade% / 止损净利%
   *   → 保证金比例 = riskPerTrade% / 止损净利%
   * 
   * 例如：riskPerTrade=2%, 止损=5% → 保证金比例 = 2/5 = 40%
   *      riskPerTrade=2%, 止损=10% → 保证金比例 = 2/10 = 20%
   */
  _calcPositionSize({ balanceUsd, atrPct, confidence, signalStrength, posCount, maxPositions, trendStrength = 0 }) {
    const params = this._getAdaptiveParams();
    const slPct = Math.abs(params.stopLossPct || 5);
    
    // 单笔风险：每次交易最多亏余额的2%
    // 连续亏损时自动缩减
    const baseRisk = 0.012; // v113.54: 1.2% — 3仓分散后单笔风险降低，总风险仍=3.6%
    const drawdownScale = this._currentDrawdownScale();
    let riskPerTrade = baseRisk * drawdownScale;
    
    // 信号强度修正风险：强信号多冒一点险，弱信号少冒
    const strengthMult = this.signalStrengthMap[signalStrength] ?? 0.5;
    riskPerTrade *= strengthMult;
    
    // 置信度修正：高置信度适当增加风险
    riskPerTrade *= (0.7 + confidence * 0.3); // conf=0.5→0.85, conf=1.0→1.0
    
    // 保证金 = 余额 × riskPerTrade / 止损净利%
    let fraction = riskPerTrade / (slPct / 100);
    
    // v116: 趋势加成放大 — 顺势加仓更激进
    if (trendStrength > 0) {
      const trendBoost = 1 + Math.min(0.5, trendStrength * 0.2); // 1.0~1.5（从0.3提到0.5）
      fraction *= trendBoost;
    }
    
    // 限制在最小-最大之间
    fraction = Math.max(this.minSingleExposurePct, Math.min(this.maxSingleExposurePct, fraction));
    
    return balanceUsd * fraction;
  }

  /**
   * 波动率→缩放系数
   * 低波动(1.0) → 中波动(0.85) → 高波动(0.65) → 极端(0.4) → 超极端(0.2)
   */
  _volAdjustment(atrPct) {
    if (atrPct <= this.volLowThreshold) return 1.0;
    if (atrPct <= this.volMidThreshold) return 0.85;
    if (atrPct <= this.volHighThreshold) return 0.65;
    if (atrPct <= this.volExtremeThreshold) return 0.4;
    return 0.2;
  }

  _volRegime(atrPct) {
    if (atrPct <= this.volLowThreshold) return 'low';
    if (atrPct <= this.volMidThreshold) return 'mid';
    if (atrPct <= this.volHighThreshold) return 'high';
    if (atrPct <= this.volExtremeThreshold) return 'extreme';
    return 'crisis';
  }

  /**
   * v113.41: 根据波动率+杠杆+持仓时间，自动选择最优K线级别
   * 
   * 原则：
   *   - K线ATR × 杠杆 > 止损距离 → 否则噪音太大
   *   - K线ATR × 杠杆 < 止盈距离 → 否则一根K线就到止盈了
   *   - MA99覆盖时间要 > 2×持仓预期时间（确认趋势有效）
   */
  selectTimeframe(atrPct, leverage, expectedHoldMinutes) {
    // 各K线级别的ATR和覆盖时间
    // ATR是相对值(%)，基于当前市场1h ATR推算
    const timeframes = [
      { name: '5m',  atrRatio: 0.2,  ma99Hours: 8.25,  barsToTarget: (tp, lev) => tp / lev / (0.2 * atrPct / 100) },
      { name: '15m', atrRatio: 0.45, ma99Hours: 24.75, barsToTarget: (tp, lev) => tp / lev / (0.45 * atrPct / 100) },
      { name: '1h',  atrRatio: 1.0,  ma99Hours: 99,    barsToTarget: (tp, lev) => tp / lev / (1.0 * atrPct / 100) },
      { name: '4h',  atrRatio: 2.5,  ma99Hours: 396,   barsToTarget: (tp, lev) => tp / lev / (2.5 * atrPct / 100) },
    ];

    const tpPct = this._getAdaptiveParams().takeProfitPct || 10;
    const slPct = Math.abs(this._getAdaptiveParams().stopLossPct || 5);
    const expectedHoldHours = expectedHoldMinutes / 60;

    let best = null;
    let bestScore = -Infinity;

    for (const tf of timeframes) {
      // 这个K线级别下，1根K线的ATR是多少（价格%）
      const klineAtr = tf.atrRatio * atrPct / 100;
      
      // 止盈需要几根K线
      const barsToTp = (tpPct / 100) / (klineAtr * leverage || 0.001);
      // 止损需要几根K线（越大越好，说明不容易被噪音打止损）
      const barsToSl = (slPct / 100) / (klineAtr * leverage || 0.001);
      
      // MA99覆盖时间是否足够
      const trendCoversHold = tf.ma99Hours > expectedHoldHours * 2;
      
      // 评分规则：
      // 止盈2-10根K线最佳（太少=太快不稳定，太多=太慢赚不到）
      // 止损>1.5根K线（否则噪音打止损）
      // MA99覆盖时间>持仓时间×2
      let score = 0;
      
      // 止盈评分：2-10根最佳
      if (barsToTp >= 2 && barsToTp <= 10) score += 3;
      else if (barsToTp >= 1 && barsToTp <= 15) score += 1;
      else score -= 3;
      
      // 止损评分：越大越好
      if (barsToSl >= 2) score += 3;
      else if (barsToSl >= 1.5) score += 2;
      else if (barsToSl >= 1) score += 1;
      else score -= 5; // 止损<1根K线=必死
      
      // 趋势确认评分
      if (trendCoversHold) score += 2;
      else if (tf.ma99Hours > expectedHoldHours) score += 1;
      else score -= 2;
      
      // 爆仓距离：20x下爆仓=5%，止损5%
      const liqBars = (5 / 100) / (klineAtr * leverage || 0.001);
      if (liqBars > 5) score += 1; // 5根K线才会爆仓=安全
      
      if (score > bestScore) {
        bestScore = score;
        best = { ...tf, barsToTp: Math.round(barsToTp * 10) / 10, barsToSl: Math.round(barsToSl * 10) / 10, score };
      }
    }

    return best ? best.name : '1h';
  }

  /**
   * 连续亏损时的缩放比例
   * 0亏→1.0, 1亏→0.8, 2亏→0.6, 3亏→0.4 ...
   */
  _currentDrawdownScale() {
    const idx = Math.min(this.consecutiveLosses, this.drawdownScalePcts.length - 1);
    return this.drawdownScalePcts[idx];
  }

  /**
   * 记录盈亏（由engine.js平仓时调用）
   */
  recordTradeResult(pnl) {
    if (pnl < 0) {
      this.consecutiveLosses++;
      if (this.consecutiveLosses >= this.maxConsecutiveLosses) {
        console.warn(`[PositionSizer] ⚠️ 连续亏损${this.consecutiveLosses}次，仓位缩至${(this._currentDrawdownScale() * 100).toFixed(0)}%`);
      }
    } else {
      // 盈利则逐步恢复（不是立刻清零，而是减1）
      if (this.consecutiveLosses > 0) this.consecutiveLosses--;
    }
  }

  getStatus() {
    return {
      consecutiveLosses: this.consecutiveLosses,
      currentScale: this._currentDrawdownScale(),
      stats: this.stats,
    };
  }

  // ═══ v113.22: 趋势加仓仓位计算 ═══
  /**
   * 计算加仓金额（基于原始仓位 + 趋势强度 + 可用余额）
   * @param {Object} ctx
   * @param {number} ctx.balanceUsd      — 可用余额
   * @param {number} ctx.currentPosUsd   — 当前持仓名义值(美元)
   * @param {number} ctx.addRatio        — Brain给出的加仓比例 (0.3~0.5)
   * @param {number} ctx.trendStrength   — 趋势强度 0-1
   * @param {number} ctx.atrPct          — 波动率
   * @returns {Object} { addSizeUsd, reject, reason }
   */
  calcAddSize(ctx) {
    const { balanceUsd = 0, currentPosUsd = 0, addRatio = 0.3, trendStrength = 0.5, atrPct = 1.5 } = ctx;

    if (balanceUsd < 5) {
      return { reject: true, reason: `加仓余额不足 $${balanceUsd.toFixed(2)}` };
    }

    // 加仓金额 = 原始仓位金额 × 加仓比例 × 趋势修正
    // 趋势越强，加仓比例越大（最多 ×1.3）
    const trendBoost = 1 + Math.min(0.3, trendStrength * 0.4);
    let addSizeUsd = currentPosUsd * addRatio * trendBoost;

    // 波动率修正：高波动减少加仓
    const volAdj = this._volAdjustment(atrPct);
    addSizeUsd *= Math.max(0.5, volAdj);

    // 回撤保护
    addSizeUsd *= this._currentDrawdownScale();

    // 上限：加仓不超过余额的30%，且加仓后总敞口不超过 maxTotalExposurePct
    const maxAddFromBalance = balanceUsd * 0.30;
    addSizeUsd = Math.min(addSizeUsd, maxAddFromBalance);

    // 加仓后总持仓不能超过最大敞口
    const totalAfterAdd = currentPosUsd + addSizeUsd;
    if (totalAfterAdd > balanceUsd * this.maxTotalExposurePct) {
      addSizeUsd = Math.max(0, balanceUsd * this.maxTotalExposurePct - currentPosUsd);
    }

    // 最小交易额检查
    if (addSizeUsd < this.minTradeUsd) {
      this.stats.totalRejected++;
      return { reject: true, reason: `加仓金额 $${addSizeUsd.toFixed(2)} < $${this.minTradeUsd}` };
    }

    this.stats.totalSized++;
    return {
      addSizeUsd: Math.round(addSizeUsd * 100) / 100,
      reject: false,
      details: {
        originalPos: `$${currentPosUsd.toFixed(2)}`,
        addRatio,
        trendBoost: `x${trendBoost.toFixed(2)}`,
        totalAfter: `$${totalAfterAdd.toFixed(2)}`,
        balancePct: `${((totalAfterAdd / balanceUsd) * 100).toFixed(1)}%`,
      }
    };
  }

  // ═══ v113.22: 减仓比例计算 ═══
  /**
   * 根据趋势恶化程度计算减仓比例
   * @param {Object} ctx
   * @param {number} ctx.trendStrength    — 逆势趋势强度 0-1
   * @param {number} ctx.netPnlPct       — 当前净利润百分比
   * @param {number} ctx.holdMinutes     — 持仓时间
   * @param {string} ctx.regime          — 市场regime
   * @param {number} ctx.reduceRatio     — Brain建议的基础比例
   * @returns {Object} { reduceRatio, reject, reason }
   */
  calcReduceRatio(ctx) {
    const { trendStrength = 0, netPnlPct = 0, holdMinutes = 0, regime = 'ranging', reduceRatio = 0.3 } = ctx;

    let ratio = reduceRatio;

    // 趋势越恶劣，减仓越多
    if (trendStrength > 0.8) ratio = Math.min(ratio + 0.2, 0.8); // 强逆势 → 最多减80%
    else if (trendStrength > 0.5) ratio = Math.min(ratio + 0.1, 0.6); // 中逆势 → 最多减60%

    // 利润越高，减仓越激进（锁利）
    if (netPnlPct > 2.0) ratio = Math.min(ratio + 0.15, 0.7);
    else if (netPnlPct > 1.0) ratio = Math.min(ratio + 0.1, 0.6);

    // 持仓时间长 + 逆势 → 趋势性减仓
    if (holdMinutes > 180 && regime === 'ranging') ratio = Math.min(ratio + 0.1, 0.6);

    // 不能全部减完，至少保留20%仓位（让利润继续跑）
    ratio = Math.min(ratio, 0.80);
    ratio = Math.max(ratio, 0.20);

    this.stats.totalSized++;
    return {
      reduceRatio: Math.round(ratio * 100) / 100,
      reject: false,
      details: {
        netPnlPct: `${netPnlPct.toFixed(2)}%`,
        trendStrength: trendStrength.toFixed(2),
        regime,
      }
    };
  }

  // 加仓后重置连续亏损计数（加仓=对趋势有信心）
  onAddPosition() {
    if (this.consecutiveLosses > 0) this.consecutiveLosses--;
  }
}

module.exports = { PositionSizer };
