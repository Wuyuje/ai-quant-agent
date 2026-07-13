/**
 * Shared Risk Layer v97 — 跨市场共享风控层
 * 
 * 核心原则:
 * 1. 独立引擎各自管理仓位/止损/止盈
 * 2. 共享风控层防止跨市场过度暴露
 * 3. 跨市场信号触发时统一调度
 * 
 * 风控规则:
 * ┌──────────────────────────────────────────────────────────┐
 * │ 规则                          │ 阈值        │ 动作      │
 * ├──────────────────────────────────────────────────────────┤
 * │ 总敞口 (所有市场合计)          │ ≤100%余额   │ 超了不开仓│
 * │ 单市场敞口                    │ ≤40%余额    │ 超了不开仓│
 * │ 高相关市场合计                │ ≤60%余额    │ 超了减仓  │
 * │ 日亏损限额                    │ ≤5%余额     │ 停止交易  │
 * │ 单笔亏损限额                  │ ≤2%余额     │ 强制平仓  │
 * │ 净杠杆 (所有市场加权)         │ ≤8x         │ 超了降仓  │
 * │ 流动性检测                    │ 成交额>$1M  │ 不够不开仓│
 * │ 相关性监控                    │ 相关性>0.7  │ 限制同向  │
 * └──────────────────────────────────────────────────────────┘
 * 
 * 跨市场暴露矩阵 (检测同方向风险):
 * - 做多黄金 + 做空美元 = 一致方向 → 加强保护
 * - 做多BTC + 做多ETH + 做多SOL = 一致方向 → 限制总仓位
 * - 做多黄金 + 做多BTC + 做多股指 = 一致方向 → 极端风险集中
 */

const fs = require('fs');
const path = require('path');

class SharedRiskLayer {
  constructor(totalBalance) {
    this.totalBalance = totalBalance || 100;

    // ═══════ 风控阈值 ═══════
    this.limits = {
      maxTotalExposure: 1.00,      // 总敞口≤100%
      maxSingleMarket: 0.90,       // v113.72: 单市场≤90% — 集中持仓2仓保证金90%
      maxCorrelatedPair: 0.90,     // v113.72: 高相关市场≤90%
      maxDailyLoss: 0.05,          // 日亏损≤5%停止
      maxSingleLoss: 0.02,         // 单笔亏损≤2%强制平
      maxLeverage: 8,              // 最大杠杆8x
      minLiquidity24h: 1000000,    // 24h成交额>$1M
      maxCorrelationThreshold: 0.7,// 相关性>0.7限制同向
    };

    // ═══════ 市场间相关性 (动态) ═══════
    this.correlations = {
      'crypto-crypto': 0.85,   // 加密货币之间高相关
      'crypto-gold': 0.25,     // BTC-黄金弱正相关
      'crypto-index': 0.45,    // BTC-股指中等正相关
      'gold-forex': 0.30,      // 黄金-外汇弱相关
      'gold-bond': 0.15,       // 黄金-债券低相关
      'index-forex': 0.20,     // 股指-外汇低相关
      'forex-bond': 0.35,      // 外汇-债券弱正相关
      'commodity-gold': 0.70,  // 商品-黄金高相关
    };

    // ═══════ 各市场暴露度 ═══════
    this.exposure = {
      crypto: { long: 0, short: 0, netLeverage: 0 },
      gold: { long: 0, short: 0, netLeverage: 0 },
      forex: { long: 0, short: 0, netLeverage: 0 },
      index: { long: 0, short: 0, netLeverage: 0 },
      commodity: { long: 0, short: 0, netLeverage: 0 },
      bond: { long: 0, short: 0, netLeverage: 0 },
      arb: { long: 0, short: 0, netLeverage: 0 },
    };

    // ═══════ 日统计 ═══════
    this.dailyPnl = 0;
    this.dailyTrades = 0;
    this.dailyMaxPnl = 0;
    this.tradingHalted = false;
    this.haltReason = '';

    this.logFile = path.join(__dirname, '..', 'logs', 'shared-risk.log');
    this._log('SharedRiskLayer v97 初始化 — 总资金: $' + this.totalBalance.toFixed(2));
  }

  /**
   * ═══ 核心: 开仓前检查 ═══
   * 返回 { allowed: boolean, reason: string, adjustedSize?: number }
   */
  preTradeCheck(market, direction, sizeUsd, leverage, positions) {
    // 1. 日亏损熔断
    if (this.tradingHalted) {
      return { allowed: false, reason: `交易暂停: ${this.haltReason}` };
    }

    // 2. 日亏损限额
    const dailyLossPct = Math.abs(Math.min(0, this.dailyPnl)) / this.totalBalance;
    if (dailyLossPct >= this.limits.maxDailyLoss) {
      this.tradingHalted = true;
      this.haltReason = `日亏损 ${(dailyLossPct * 100).toFixed(2)}% 达到限额 ${(this.limits.maxDailyLoss * 100).toFixed(0)}%`;
      this._log(`🚨 熔断: ${this.haltReason}`);
      return { allowed: false, reason: this.haltReason };
    }

    // 3. 单笔亏损限额 (v113.72: 用保证金×止损% 算风险, 不是notional)
    const maxLossUsd = this.totalBalance * this.limits.maxSingleLoss;
    const potentialLoss = sizeUsd * 0.05; // 假设5%止损(保证金亏损)
    if (potentialLoss > maxLossUsd) {
      const adjustedSize = maxLossUsd / 0.05;
      this._log(`⚠️ ${market}: 单笔风险 $${potentialLoss.toFixed(2)} > 限额 $${maxLossUsd.toFixed(2)} → 缩小到 $${adjustedSize.toFixed(2)}`);
      return { allowed: true, adjustedSize, reason: `单笔限额调整: $${sizeUsd} → $${adjustedSize.toFixed(2)}` };
    }

    // 4. 单市场敞口 (v113.72: 用保证金比较)
    const exp = this.exposure[market] || { long: 0, short: 0 };
    const marketExposure = Math.abs(exp.long) + Math.abs(exp.short);
    const marketPct = marketExposure / this.totalBalance;
    if (marketPct >= this.limits.maxSingleMarket) {
      const available = this.totalBalance * this.limits.maxSingleMarket - marketExposure;
      if (available <= 0) {
        return { allowed: false, reason: `${market} 保证金占用 ${(marketPct * 100).toFixed(1)}% 达上限 ${(this.limits.maxSingleMarket * 100)}%` };
      }
      const adjustedSize = Math.min(sizeUsd, available);
      return { allowed: true, adjustedSize, reason: `${market} 限额调整 → $${adjustedSize.toFixed(2)}` };
    }

    // 5. 总敞口 (v113.72: 用保证金比较)
    let totalExposure = 0;
    for (const [, e] of Object.entries(this.exposure)) {
      totalExposure += Math.abs(e.long) + Math.abs(e.short);
    }
    const totalPct = totalExposure / this.totalBalance;
    if (totalPct >= this.limits.maxTotalExposure) {
      const available = this.totalBalance * this.limits.maxTotalExposure - totalExposure;
      if (available <= 0) {
        return { allowed: false, reason: `总保证金占用 ${(totalPct * 100).toFixed(1)}% 达上限` };
      }
      const adjustedSize = Math.min(sizeUsd, available);
      return { allowed: true, adjustedSize, reason: `总限额调整 → $${adjustedSize.toFixed(2)}` };
    }

    // 6. 净杠杆
    let totalWeightedLeverage = 0;
    let totalNotional = 0;
    for (const [m, e] of Object.entries(this.exposure)) {
      const notional = Math.abs(e.long) + Math.abs(e.short);
      if (notional > 0 && e.netLeverage) {
        totalWeightedLeverage += e.netLeverage * notional;
        totalNotional += notional;
      }
    }
    const avgLeverage = totalNotional > 0 ? totalWeightedLeverage / totalNotional : 0;
    if (avgLeverage > this.limits.maxLeverage) {
      return { allowed: false, reason: `加权杠杆 ${avgLeverage.toFixed(1)}x > 限额 ${this.limits.maxLeverage}x` };
    }

    // 7. 相关性暴露检查
    const corrCheck = this._checkCorrelationExposure(market, direction, sizeUsd);
    if (!corrCheck.allowed) {
      return corrCheck;
    }

    return { allowed: true, reason: '通过' };
  }

  /**
   * ═══ 检查相关性暴露 ═══
   * 如果两个高相关市场同方向过度暴露，限制开仓
   */
  _checkCorrelationExposure(market, direction, sizeUsd) {
    for (const [pair, corr] of Object.entries(this.correlations)) {
      if (Math.abs(corr) < this.limits.maxCorrelationThreshold) continue;

      const [m1, m2] = pair.split('-');
      if (m1 !== market && m2 !== market) continue;

      const otherMarket = m1 === market ? m2 : m1;
      const otherExp = this.exposure[otherMarket] || { long: 0, short: 0 };

      // 方向一致 (都是做多或都是做空)
      const sameDirection = (direction === 'LONG' && otherExp.long > otherExp.short) ||
                           (direction === 'SHORT' && otherExp.short > otherExp.long);

      if (sameDirection) {
        const combinedExposure = Math.abs(this.exposure[market]?.long - this.exposure[market]?.short) + Math.abs(otherExp.long - otherExp.short) + sizeUsd;
        const combinedPct = combinedExposure / this.totalBalance;

        if (combinedPct > this.limits.maxCorrelatedPair) {
          return {
            allowed: false,
            reason: `${market}+${otherMarket} 高相关(${(corr*100).toFixed(0)}%) 同向敞口 ${(combinedPct*100).toFixed(1)}% > ${(this.limits.maxCorrelatedPair*100)}%`,
          };
        }
      }
    }
    return { allowed: true };
  }

  /**
   * ═══ 开仓后更新暴露度 ═══
   */
  recordOpen(market, direction, sizeUsd, leverage) {
    if (!this.exposure[market]) {
      this.exposure[market] = { long: 0, short: 0, netLeverage: 0 };
    }
    // v113.72: 存保证金而非notional — 集中持仓策略用保证金占比控制风险
    if (direction === 'LONG') {
      this.exposure[market].long += sizeUsd;
    } else {
      this.exposure[market].short += sizeUsd;
    }
    this.exposure[market].netLeverage = leverage;
    this.dailyTrades++;

    this._log(`📊 开仓 ${market} ${direction} $${sizeUsd} × ${leverage}x | 暴露(保证金): L=$${this.exposure[market].long.toFixed(0)} S=$${this.exposure[market].short.toFixed(0)}`);
  }

  /**
   * ═══ 平仓后更新暴露度 + 记录PnL ═══
   */
  recordClose(market, direction, pnlUsd) {
    if (this.exposure[market]) {
      if (direction === 'LONG') {
        this.exposure[market].long = Math.max(0, this.exposure[market].long - Math.abs(pnlUsd));
      } else {
        this.exposure[market].short = Math.max(0, this.exposure[market].short - Math.abs(pnlUsd));
      }
    }
    this.dailyPnl += pnlUsd;
    this.dailyMaxPnl = Math.max(this.dailyMaxPnl, this.dailyPnl);

    this._log(`💰 平仓 ${market} ${direction} PnL=$${pnlUsd.toFixed(4)} | 日PnL=$${this.dailyPnl.toFixed(4)} | 日交易=${this.dailyTrades}`);
  }

  /**
   * ═══ 跨市场对冲信号 ═══
   * 当某市场触发信号时，检查是否需要在其他市场对冲
   */
  getHedgeSignals(market, direction) {
    const hedges = [];

    // 规则1: BTC暴跌 → 加黄金对冲
    if (market === 'crypto' && direction === 'SHORT') {
      hedges.push({ market: 'gold', action: 'LONG', reason: 'BTC空头→黄金对冲', weight: 0.3 });
    }

    // 规则2: VIX飙升 → 减股指+加黄金
    if (market === 'index' && direction === 'SHORT') {
      hedges.push({ market: 'gold', action: 'LONG', reason: '股指空头→黄金避险', weight: 0.2 });
      hedges.push({ market: 'bond', action: 'LONG', reason: '股指空头→债券避险', weight: 0.2 });
    }

    // 规则3: 美元走强 → 做空新兴市场
    if (market === 'forex' && direction === 'SHORT') {
      // 做空EUR=做多美元 → 新兴市场承压
      hedges.push({ market: 'crypto', action: 'SHORT', reason: '美元强→新兴市场压力', weight: 0.2 });
    }

    // 规则4: 黄金暴涨 → 风险回避
    if (market === 'gold' && direction === 'LONG') {
      hedges.push({ market: 'index', action: 'SHORT', reason: '黄金多头→风险回避', weight: 0.15 });
    }

    // 规则5: 通胀上升 → 做多商品,做空债券
    if (market === 'commodity' && direction === 'LONG') {
      hedges.push({ market: 'bond', action: 'SHORT', reason: '商品多头→通胀→债券空', weight: 0.2 });
    }

    return hedges;
  }

  /**
   * ═══ 日终重置 ═══
   */
  resetDaily() {
    this.dailyPnl = 0;
    this.dailyTrades = 0;
    this.dailyMaxPnl = 0;
    this.tradingHalted = false;
    this.haltReason = '';
    this._log(`🔄 日终重置完成`);
  }

  /**
   * ═══ 更新总资金 ═══
   */
  updateBalance(newBalance) {
    const old = this.totalBalance;
    this.totalBalance = newBalance;
    if (Math.abs(newBalance - old) / old > 0.01) {
      this._log(`💰 资金更新: $${old.toFixed(2)} → $${newBalance.toFixed(2)}`);
    }
  }

  /**
   * ═══ 获取报告 ═══
   */
  getReport() {
    let totalExposure = 0;
    const marketExposures = {};
    for (const [market, exp] of Object.entries(this.exposure)) {
      const net = Math.abs(exp.long) + Math.abs(exp.short);
      totalExposure += net;
      marketExposures[market] = {
        long: exp.long.toFixed(0),
        short: exp.short.toFixed(0),
        net: net.toFixed(0),
        pct: (net / this.totalBalance * 100).toFixed(1) + '%',
      };
    }

    // 加权杠杆
    let weightedLev = 0, totalNotional = 0;
    for (const [, e] of Object.entries(this.exposure)) {
      const n = Math.abs(e.long) + Math.abs(e.short);
      if (n > 0 && e.netLeverage) { weightedLev += e.netLeverage * n; totalNotional += n; }
    }

    return {
      totalBalance: this.totalBalance.toFixed(2),
      totalExposure: totalExposure.toFixed(0),
      totalExposurePct: (totalExposure / this.totalBalance * 100).toFixed(1) + '%',
      avgLeverage: totalNotional > 0 ? (weightedLev / totalNotional).toFixed(1) + 'x' : '0x',
      dailyPnl: this.dailyPnl.toFixed(4),
      dailyTrades: this.dailyTrades,
      tradingHalted: this.tradingHalted,
      haltReason: this.haltReason,
      marketExposures,
      limits: this.limits,
    };
  }

  _log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    try {
      const dir = path.dirname(this.logFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.logFile, line + '\n');
    } catch (e) {}
  }
}

module.exports = SharedRiskLayer;
