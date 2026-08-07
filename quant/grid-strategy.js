// ═══════════════════════════════════════════════════════════
// 模块三·策略 3.1 震荡网格策略 (RangeGridStrategy)
// 震荡行情中低买高卖: 网格下沿买入 / 上沿卖出
// 对应图片: 3.1 震荡网格策略
// ═══════════════════════════════════════════════════════════
const { FeatureEngineer, toArray } = require('./featurer');

class RangeGridStrategy {
  constructor(opts = {}) {
    this.gridCount = opts.gridCount || 5;       // 网格层数
    this.lowerPct = opts.lowerPct || 0.02;       // 下沿距当前价2%
    this.upperPct = opts.upperPct || 0.02;       // 上沿距当前价2%
    this.rangeLookback = opts.rangeLookback || 96; // 看96根K线定箱体
    this.fe = new FeatureEngineer();
  }

  // 计算震荡箱体(用近N根最高/最低)
  computeRange(raw) {
    const klines = toArray(raw);
    const look = Math.min(this.rangeLookback, klines.length);
    const seg = klines.slice(-look);
    const high = Math.max(...seg.map(k => +k[1]));
    const low = Math.min(...seg.map(k => +k[2]));
    return { high, low, mid: (high + low) / 2, range: high - low };
  }

  // 生成信号: 触下沿买 / 触上沿卖
  generateSignal(klines) {
    const feat = this.fe.buildFeatures(klines, 0);
    const price = feat.close;
    // 规格: ATR修正支撑阻力 → 支撑=中轨-ATR*0.8, 阻力=中轨+ATR*0.8
    const med = feat.emaLong;          // 中轨(或MA)
    const atr = feat.atrPct * price;    // ATR绝对值
    const support = med - atr * 0.8;
    const resistance = med + atr * 0.8;
    if (support >= resistance) return { signal: 'NONE', reason: 'ATR区间异常' };
    if (price <= support) return { signal: 'BUY', reason: `网格低买(触支撑${support.toFixed(4)})`, price, side: 'LONG' };
    if (price >= resistance) return { signal: 'SELL', reason: `网格高卖(触阻力${resistance.toFixed(4)})`, price, side: 'SHORT' };
    return { signal: 'NONE', reason: `支撑${support.toFixed(4)}<价<阻力${resistance.toFixed(4)}` };
  }

  // 网格离场: 固定止盈/止损 (常规网格形态, 交易能正常完成)
  // 做多: 涨≥止盈%平(高卖), 跌≥止损%平(认错)
  // 做空: 跌≥止盈%平(低买回), 涨≥止损%平
  gridExit(pos, price, rng) {
    const entry = pos.entryPrice || pos.entry || price;
    const pnlPct = pos.side === 'LONG'
      ? (price - entry) / entry * 100
      : (entry - price) / entry * 100;
    this.tpPct = this.tpPct || 0.8;   // 止盈 0.8% (小网格高频)
    this.slPct = this.slPct || 1.0;   // 止损 1.0%
    if (pnlPct >= this.tpPct) return { action: 'CLOSE', reason: `网格止盈(+${pnlPct.toFixed(1)}%)` };
    if (pnlPct <= -this.slPct) return { action: 'CLOSE', reason: `网格止损(${pnlPct.toFixed(1)}%)` };
    return { action: 'HOLD' };
  }

  // 仓位大小 (按ATR: 波动大仓位小)
  calculatePositionSize(balance, atrPct, leverage) {
    const volFactor = atrPct > 0 ? Math.max(0.3, 1 - atrPct * 10) : 1; // 波动大缩减仓位
    const notional = Math.max(20, balance * leverage * 0.2 * volFactor); // 网格单笔≤20%杠杆额度
    return { notional, margin: notional / leverage, leverage };
  }
}

module.exports = { RangeGridStrategy };
