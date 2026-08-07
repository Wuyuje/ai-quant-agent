// ═══════════════════════════════════════════════════════════
// 第三策略·高频套利 / 波动对冲 (HedgeStrategy)
// 规格: ATR_MULTI_HEDGE=3.0 波动容忍阈值, 暴涨暴跌时高频反向
// 在突发(shock)行情中, 通过小仓位+快速反转套利
// ═══════════════════════════════════════════════════════════
const { FeatureEngineer, toArray } = require('./featurer');

class HedgeStrategy {
  constructor(opts = {}) {
    this.atrMultiHedge = opts.atrMultiHedge || 3.0;  // 规格: 3.0
    this.hedgePositionRatio = opts.hedgePositionRatio || 0.30; // 对冲仓上限(风控)
    this.fe = new FeatureEngineer();
  }

  // 高频套利信号: 在突发波动中, 价格急速偏离(超过3倍ATR) → 反向回归套利
  hedgeSignal(klines) {
    const arr = toArray(klines);
    if (arr.length < 30) return { signal: 0 };
    const closes = arr.map(k => +k[3]);
    const price = closes[closes.length-1];
    const atr = this.fe.calcATR(arr);
    if (atr <= 0) return { signal: 0, reason: '无ATR' };
    // 近N根突发波动: 价格单边急速偏离 MA 超过 hedge*ATR → 触发反向
    const ma = closes.slice(-20).reduce((a,b)=>a+b,0)/20;
    const dev = (price - ma);
    if (dev > atr * this.atrMultiHedge) {
      // 急涨 → 卖出回归(套利)
      return { signal: -1, reason: `高频套利:急涨偏离${(dev/atr).toFixed(1)}ATR>${this.atrMultiHedge},反向卖`, price };
    }
    if (dev < -atr * this.atrMultiHedge) {
      // 急跌 → 买入回归
      return { signal: 1, reason: `高频套利:急跌偏离${(-dev/atr).toFixed(1)}ATR>${this.atrMultiHedge},反向买`, price };
    }
    return { signal: 0, reason: `偏离${(dev/atr).toFixed(1)}ATR未超${this.atrMultiHedge}` };
  }

  // 套利仓位: 小仓位(规格 HEDGE_POSITION_RATIO×权益)
  hedgeSize(capital, price, signal) {
    const notional = Math.max(20, capital * this.hedgePositionRatio);
    return { notional, side: signal > 0 ? 'LONG' : 'SHORT' };
  }
}

module.exports = { HedgeStrategy };
