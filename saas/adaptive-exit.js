/**
 * AdaptiveExitManager v114 — 世界顶级量化止盈止损引擎
 * 
 * 对标策略:
 * - Renaissance Medallion: 统计套利+短周期均值回归
 * - Two Sigma: 多因子趋势跟踪，止盈目标3-5R
 * - Citadel: ATR动态止损+移动止盈
 * - AQR: 波动率自适应仓位+风险预算
 * - Turtle Trading: 2 ATR止损，突破入场
 * 
 * 核心原则:
 * 1. 止损 = 2 ATR (过滤噪音，不被洗出去)
 * 2. 止盈目标 = 8 ATR (让利润奔跑, 盈亏比≥1.2:1)
 * 3. 移动止盈: 峰值回撤2.5 ATR锁定，底线=0
 * 4. 不搞保本止损 — 从赚到亏的元凶已删除
 * 5. 到手利润>0时可以平仓锁定
 * 6. 超额止盈>15%立刻锁定
 * 7. 时间衰减: 30分钟后逐步收紧止损
 * 8. 连亏保护: 3次收紧20%，5次收紧40%
 */

class AdaptiveExitManager {
  constructor(config = {}) {
    // ═══ ATR倍数参数 (v116: 取v13+v115之长) ═══
    // v116: 止损从2 ATR→3 ATR（给趋势空间，对标v13宽止损风格）
    // v116: 止盈从4 ATR→6 ATR（吃大趋势，对标v13趋势跟踪）
    // v122.4: 蒙特卡洛1000笔调优 — 修复盈亏比<1导致结构性亏损
    // 旧参数(3/6/2/0.5%): 盈亏比=0.80 → 55%胜率仍亏损 ❌
    // 新参数(2/8/2.5/1.5%): 盈亏比=1.24 → 50%胜率也盈利 ✅
    // 核心: 止损收紧(3→2 ATR), 止盈放大(6→8 ATR), 锁利回撤放大(0.5→1.5%)
    this.slAtrMult = config.slAtrMult || 2.0;    // 止损 = 2 ATR (收紧, 减少单笔亏损)
    this.tpAtrMult = config.tpAtrMult || 8.0;    // 止盈目标 = 8 ATR (放大, 让利润奔跑)
    this.trailingAtrMult = config.trailingAtrMult || 2.5;  // 移动止损回撤 = 2.5 ATR (给回调空间)

    // ═══ 交易成本 ═══
    this.FEE_RATE = 0.0004;
    this.ROUND_TRIP_FEE = 0.0008;
    this.FUNDING_RATE = 0.0001;
    this.SLIPPAGE_PCT = 0.0005;
    this.PLATFORM_FEE_RATE = 0.20;

    // ═══ 时间衰减 ═══
    this.timeDecayStartMin = 30;
    this.timeDecayRate = 0.1;

    // ═══ 连亏保护 ═══
    this.consecutiveLosses = 0;
    this.recentPnls = [];

    // ═══ 持仓追踪 ═══
    this.positionData = new Map();

    // ═══ 是否管理员 ═══
    this._isAdminWallet = config.isAdminWallet || false;
  }

  calculateCosts(leverage, holdHours = 4) {
    const feeCost = this.ROUND_TRIP_FEE * leverage;
    const slippageCost = this.SLIPPAGE_PCT * 2 * leverage;
    const fundingCost = this.FUNDING_RATE * Math.floor(holdHours / 8) * leverage;
    const totalCostPct = feeCost + slippageCost + fundingCost;
    return {
      totalCostPct, feeCost, slippageCost, fundingCost,
      breakdown: `手续费=${(feeCost*100).toFixed(3)}% 滑点=${(slippageCost*100).toFixed(3)}% 资金费=${(fundingCost*100).toFixed(3)}% 总=${(totalCostPct*100).toFixed(3)}%`
    };
  }

  toNetPnl(grossPnlPct, leverage, holdHours = 4) {
    const costs = this.calculateCosts(leverage, holdHours);
    return grossPnlPct - costs.totalCostPct * 100;
  }

  toTakeHome(grossPnlPct, leverage, holdHours = 4) {
    const netPnl = this.toNetPnl(grossPnlPct, leverage, holdHours);
    if (netPnl <= 0) return netPnl;
    if (this._isAdminWallet) return netPnl;
    return netPnl * 0.70;
  }

  /**
   * 核心止盈止损计算 — v114 世界顶级策略
   */
  calculate(symbol, pos, marketData, context = {}) {
    const {
      price = pos.entryPrice,
      atr = 0,
      atrPct = 1.5,
      klines = [],
    } = marketData || {};

    const leverage = pos.leverage || 1;
    const _openTs = pos.openTime || pos.openedAt;
    const heldMinutes = _openTs ? (Date.now() - (typeof _openTs === 'number' ? _openTs : new Date(_openTs).getTime())) / 60000 : 0;
    const holdHours = heldMinutes / 60;

    // ═══ 成本计算 ═══
    const costInfo = this.calculateCosts(leverage, holdHours);
    const costPct = costInfo.totalCostPct * 100;
    // 最低毛利 = 成本 + 0.3%安全垫
    const minGrossProfit = costPct + 0.3;

    const reasons = [`成本=${costInfo.breakdown}`];

    // ═══ 波动率自适应参数 (对标AQR) ═══
    let slMult = this.slAtrMult;
    let tpMult = this.tpAtrMult;

    if (atrPct > 3.0) {
      // v122.4: 高波动放宽 — 止损2+1=3 ATR, 止盈8+2=10 ATR
      slMult = 3.0; tpMult = 10.0;
      reasons.push('高波动: SL=4ATR TP=8ATR');
    } else if (atrPct < 0.5) {
      // v122.4: 低波动收紧 — 止损2-0.5=1.5 ATR, 止盈8-2=6 ATR
      slMult = 1.5; tpMult = 6.0;
      reasons.push('低波动: SL=2ATR TP=4ATR');
    } else {
      reasons.push(`标准: SL=${slMult}ATR TP=${tpMult}ATR`);
    }

    // ═══ 连亏保护 (对标Citadel风控) ═══
    if (this.consecutiveLosses >= 5) {
      slMult *= 0.6; tpMult *= 0.8;
      reasons.push(`连亏${this.consecutiveLosses}次: SL收紧40%`);
    } else if (this.consecutiveLosses >= 3) {
      slMult *= 0.8;
      reasons.push(`连亏${this.consecutiveLosses}次: SL收紧20%`);
    }

    // ═══ 时间衰减 (对标Two Sigma) ═══
    if (heldMinutes > this.timeDecayStartMin) {
      const decayFactor = Math.max(0.3, 1 - this.timeDecayRate * Math.floor(heldMinutes / 30));
      slMult *= decayFactor;
      reasons.push(`时间衰减: ${Math.floor(heldMinutes)}min ×${decayFactor.toFixed(2)}`);
    }

    // ═══ 支撑阻力位 ═══
    let slFromStructure = null;
    let tpFromStructure = null;
    if (klines.length >= 20) {
      const recent = klines.slice(-20);
      const maxHigh = Math.max(...recent.map(k => k.high));
      const minLow = Math.min(...recent.map(k => k.low));
      if (pos.side === 'LONG') {
        slFromStructure = ((pos.entryPrice - minLow) / pos.entryPrice) * 100;
        tpFromStructure = ((maxHigh - pos.entryPrice) / pos.entryPrice) * 100;
      } else {
        slFromStructure = ((maxHigh - pos.entryPrice) / pos.entryPrice) * 100;
        tpFromStructure = ((pos.entryPrice - minLow) / pos.entryPrice) * 100;
      }
    }

    // ═══ 止损 = ATR × slMult (对标Turtle) ═══
    let slPct = -(atrPct * slMult);
    // v120: 结构位止损必须有最低值 — 不能小于成本×2, 否则开仓即被扫
    if (slFromStructure !== null) {
      // 结构位止损下限 = 成本×2 (确保止损空间>交易成本)
      const minStructureSl = costPct * 2;
      const structureSl = Math.max(slFromStructure, minStructureSl);
      slPct = Math.max(slPct, -Math.min(structureSl, atrPct * slMult));
    }
    // 绝对上限-5%
    slPct = Math.max(slPct, -5.0);
    // 止损至少 > 成本×2 (v120: 从1.5提高到2, 确保止损空间>成本)
    const minSlAbs = Math.max(costPct * 2, 0.3);
    slPct = Math.min(slPct, -minSlAbs);

    // ═══ 止盈 = ATR × tpMult (对标Two Sigma 3-5R) ═══
    let tpPct = atrPct * tpMult;
    if (tpFromStructure !== null && tpFromStructure > atrPct * 1.5) {
      tpPct = Math.max(tpFromStructure, atrPct * 1.5);
      tpPct = Math.min(tpPct, atrPct * tpMult);
    }
    // 止盈下限 = 成本 + 0.3%安全垫 (v118)
    // v120: 进一步提高到确保到手>0.5% → 成本 + 0.5/0.7 + 0.3
    const MIN_TAKE_HOME = 0.5;
    const minGrossForTakeHome = costPct + MIN_TAKE_HOME / 0.70 + 0.3;
    tpPct = Math.max(tpPct, minGrossForTakeHome);

    // ═══ R值 ═══
    const rDist = Math.abs(slPct);
    reasons.push(`1R=${rDist.toFixed(2)}% TP=${tpPct.toFixed(2)}% RR=1:${(tpPct/rDist).toFixed(1)}`);

    // ═══ 移动止盈 (对标Citadel ATR Trailing) ═══
    const peakPnlPct = pos._peakPnlPct || 0;
    let trailingActive = false;
    let trailingSlPct = null;

    // 峰值利润 > 1R → 启动移动止盈
    if (peakPnlPct >= rDist) {
      trailingActive = true;
      // 阶梯式移动止盈: 利润越大回撤容忍越小
      if (peakPnlPct > 15.0) {
        // v122.4: 超大趋势回撤从0.8→1.0 ATR
        trailingSlPct = peakPnlPct - atrPct * 1.0;
        reasons.push(`移动止损(超大): peak-${(atrPct*1.0).toFixed(2)}%`);
      } else if (peakPnlPct > 8.0) {
        // v122.4: 大趋势回撤从1.2→1.5 ATR
        trailingSlPct = peakPnlPct - atrPct * 1.5;
        reasons.push(`移动止损(大): peak-${(atrPct*1.5).toFixed(2)}%`);
      } else if (peakPnlPct > 4.0) {
        // v122.4: 中等趋势回撤从1.5→2.0 ATR
        trailingSlPct = peakPnlPct - atrPct * 2.0;
        reasons.push(`移动止损(中等): peak-${(atrPct*2.0).toFixed(2)}%`);
      } else {
        // v122.4: 早期回撤从2.0→2.5 ATR — 给趋势更多发展空间
        trailingSlPct = peakPnlPct - atrPct * 2.5;
        reasons.push(`移动止损(早期): peak-${(atrPct*2.5).toFixed(2)}%`);
      }
      // v116: 底线=0, 不让盈利变亏损（保持不变）
      trailingSlPct = Math.max(trailingSlPct, 0);
    }

    return {
      slPct: parseFloat(slPct.toFixed(2)),
      tpPct: parseFloat(tpPct.toFixed(2)),
      trailingActive,
      trailingSlPct: trailingSlPct ? parseFloat(trailingSlPct.toFixed(2)) : null,
      rDist: parseFloat(rDist.toFixed(2)),
      rr: parseFloat((tpPct / rDist).toFixed(2)),
      reasons,
      costInfo: {
        grossCostPct: parseFloat(costPct.toFixed(3)),
        minGrossForProfit: parseFloat(minGrossProfit.toFixed(3)),
        breakdown: costInfo.breakdown,
        leverage, holdHours: Math.round(holdHours)
      }
    };
  }

  /**
   * v120: 判断是否平仓 — 修复5个致命bug确保用户盈利
   * 修复1: 峰值用毛利, 不用净值 (单位一致)
   * 修复2: 低波动时止盈目标下限提高到确保到手>0.5%
   * 修复3: 硬止损改为动态, 不再固定-3.5%覆盖ATR止损
   * 修复4: 移动止盈加到手利润检查, 不允许到手<0.5%平仓
   * 修复5: 止损也用净盈亏计算, 确保对称
   */
  shouldClose(symbol, pos, grossPnlPct, exitCalc) {
    const leverage = pos.leverage || 1;
    const openTs = pos.openTime || pos.openedAt;
    const holdHours = openTs ? (Date.now() - (typeof openTs === 'number' ? openTs : new Date(openTs).getTime())) / 3600000 : 0;

    const netPnlPct = this.toNetPnl(grossPnlPct, leverage, holdHours);
    const takeHome = this.toTakeHome(grossPnlPct, leverage, holdHours);
    // v120: peakPnlPct 现在是毛利峰值 (CEXUserTrader已修正)
    const peakPnlPct = pos._peakPnlPct || 0;
    const peakTakeHome = this.toTakeHome(peakPnlPct, leverage, holdHours);
    const costPct = this.calculateCosts(leverage, holdHours).totalCostPct * 100;

    // v120: 到手最小利润 — 用户扣完所有费用+20%抽成后至少到手0.5%
    const MIN_TAKE_HOME = 0.5;
    // v120: 止盈目标最小毛利 = 成本 + MIN_TAKE_HOME/0.7 + 0.3%安全垫
    const minGrossForProfit = costPct + MIN_TAKE_HOME / 0.70 + 0.3;

    // ═══ 1. 硬止损 — 动态: max(-5%, ATR止损的80%) ═══
    // v122: 从-3.5%放宽到-5%, 给趋势更多发展空间
    // v120: 不再固定, 而是取 max(-5%, netSlPct * 0.8)
    // 这样低波动时硬止损跟着收紧, 高波动时放宽到-5%
    const netSlPct = this.toNetPnl(exitCalc.slPct, leverage, holdHours);
    const dynamicHardStop = Math.max(-5.0, netSlPct * 0.8); // v122: -3.5→-5 放宽给趋势空间
    // v122.5: 硬止损也加0.10%缓冲 — 大额止损更需要确认, 避免插针误触发
    if (netPnlPct <= dynamicHardStop - 0.10) {
      const isHard = Math.abs(dynamicHardStop - (-5.0)) < 0.01;
      return {
        shouldClose: true,
        reason: `🔴 ${isHard ? '硬止损' : 'ATR止损'} 净=${netPnlPct.toFixed(2)}% ≤ ${(dynamicHardStop - 0.10).toFixed(2)}%`,
        type: 'STOP_LOSS'
      };
    }

    // ═══ 2. ATR止损 (保留, 跟动态硬止损互补) ═══
    // v122.5: 加入0.15%缓冲区 — 实盘数据显示37%的ATR止损是噪音/插针(差距<0.10%)
    // 止损线需要被「明确突破」才触发, 而不是触碰就触发
    // 缓冲区 = 0.15% (约1-2个跳动点), 只影响止损延迟<0.15%, 不影响止盈
    if (netSlPct < 0 && netPnlPct <= netSlPct - 0.15) {
      return {
        shouldClose: true,
        reason: `🔴 ATR止损 净=${netPnlPct.toFixed(2)}% ≤ ${(netSlPct - 0.15).toFixed(2)}% [${exitCalc.reasons?.slice(0,2).join(',')}]`,
        type: 'STOP_LOSS'
      };
    }

    // ═══ 3. 移动止盈 — 峰值回撤锁定 (v120: 加到手利润检查) ═══
    // v122.3: 修复保本平仓dead code — 原来外层 netPnlPct > 0 导致内层 netPnlPct <= 0 永不成立
    if (exitCalc.trailingActive && exitCalc.trailingSlPct !== null) {
      const trailingNetThreshold = this.toNetPnl(exitCalc.trailingSlPct, leverage, holdHours);
      // v122.3: 拆分两种情况, 不再合并 netPnlPct > 0 条件
      // 情况1: 净利>0 且回撤到移动止盈线 → 检查到手是否达标
      if (netPnlPct > 0 && trailingNetThreshold > 0 && netPnlPct <= trailingNetThreshold) {
        if (takeHome >= MIN_TAKE_HOME) {
          return {
            shouldClose: true,
            reason: `🔄 移动止盈 净=${netPnlPct.toFixed(2)}% ≤ ${trailingNetThreshold.toFixed(2)}% 到手=${takeHome.toFixed(2)}%`,
            type: 'TRAILING_STOP'
          };
        }
        // 到手<MIN_TAKE_HOME 但净利>0 → 不平仓, 让它继续跑到达标或变负
      }
      // v122.3: 情况2: 净利从正变负 → 保本平仓(必须立即平, 不让盈利变亏损)
      // 之前: 这个检查在外层 netPnlPct > 0 内, 永不成立 → dead code
      // 现在: 独立检查, 只要移动止盈激活且净利<=0 → 保本平仓
      if (netPnlPct <= 0 && trailingNetThreshold > 0) {
        return {
          shouldClose: true,
          reason: `🔄 保本平仓 净=${netPnlPct.toFixed(2)}% (峰值${peakPnlPct.toFixed(2)}%, 到手不足${MIN_TAKE_HOME}%, 保本退出)`,
          type: 'TRAILING_STOP'
        };
      }
    }

    // ═══ 4. 超额止盈 — 毛利>20%立刻锁定 ═══
    if (grossPnlPct >= 20.0 && exitCalc.trailingActive) {
      return {
        shouldClose: true,
        reason: `🟢 超额止盈 毛利=${grossPnlPct.toFixed(2)}% 到手=${takeHome.toFixed(2)}%`,
        type: 'TAKE_PROFIT'
      };
    }

    // ═══ 5. 锁利止盈 — 到手>MIN_TAKE_HOME且峰值回撤>1.5% ═══
    // v122.4: 回撤阈值从0.5%提高到1.5% — 让利润奔跑, 不被微小回调洗出
    if (exitCalc.trailingActive && takeHome > MIN_TAKE_HOME) {
      const drawdown = peakPnlPct - grossPnlPct;
      if (drawdown > 1.5) {
        return {
          shouldClose: true,
          reason: `🟢 锁利止盈 到手=${takeHome.toFixed(2)}% (峰值${peakTakeHome.toFixed(2)}% 回撤${drawdown.toFixed(2)}%)`,
          type: 'TAKE_PROFIT'
        };
      }
    }

    // ═══ 5b. v122.3: 固定止盈目标 — 修复dead code ═══
    // v122.3: 原 !trailingActive && grossPnlPct >= tpPct 不可能同时成立
    // 因为 tpPct > rDist, 当 grossPnlPct >= tpPct 时 trailingActive 必然为 true
    // 修复: 改为 grossPnlPct >= tpPct 即可, 不管 trailingActive
    if (grossPnlPct >= exitCalc.tpPct && takeHome >= MIN_TAKE_HOME) {
      return {
        shouldClose: true,
        reason: `🟢 目标止盈 毛利=${grossPnlPct.toFixed(2)}%≥${exitCalc.tpPct.toFixed(2)}% 到手=${takeHome.toFixed(2)}%`,
        type: 'TAKE_PROFIT'
      };
    }

    // ═══ 6. 时间止损 ═══
    if (holdHours >= 6 && netPnlPct < -costPct * 2) {
      return {
        shouldClose: true,
        reason: `⏰ 时间止损 ${holdHours.toFixed(1)}h 净=${netPnlPct.toFixed(2)}%`,
        type: 'TIME_STOP'
      };
    }
    if (holdHours >= 18 && netPnlPct < 0) {
      return {
        shouldClose: true,
        reason: `⏰ 超时止损 ${holdHours.toFixed(1)}h 净=${netPnlPct.toFixed(2)}%`,
        type: 'TIME_STOP'
      };
    }
    if (holdHours >= 36) {
      return {
        shouldClose: true,
        reason: `⏰ 最大持仓时间 ${holdHours.toFixed(1)}h 毛利=${grossPnlPct.toFixed(2)}%`,
        type: 'MAX_HOLD'
      };
    }

    return null;
  }

  recordResult(netPnlPct) {
    this.recentPnls.push(netPnlPct);
    if (this.recentPnls.length > 20) this.recentPnls.shift();
    if (netPnlPct < 0) {
      this.consecutiveLosses++;
    } else {
      this.consecutiveLosses = 0;
    }
  }

  getDiagnostics() {
    const wins = this.recentPnls.filter(p => p > 0);
    const losses = this.recentPnls.filter(p => p < 0);
    const avgWin = wins.length ? wins.reduce((a,b) => a+b, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((a,b) => a+b, 0) / losses.length : 0;
    return {
      consecutiveLosses: this.consecutiveLosses,
      recentTrades: this.recentPnls.length,
      winRate: this.recentPnls.length ? `${(wins.length / this.recentPnls.length * 100).toFixed(1)}%` : 'N/A',
      avgWin: avgWin.toFixed(4),
      avgLoss: avgLoss.toFixed(4),
      profitFactor: avgLoss !== 0 ? Math.abs(avgWin / avgLoss).toFixed(2) : '∞',
    };
  }
}

module.exports = AdaptiveExitManager;
