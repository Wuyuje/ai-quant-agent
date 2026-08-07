// ═══════════════════════════════════════════════════════════
// 模块三·策略 3.1 震荡网格策略 (RangeGridStrategy)
// 震荡行情中低买高卖: 网格下沿买入 / 上沿卖出
// 对应图片: 3.1 震荡网格策略
// ═══════════════════════════════════════════════════════════
const { FeatureEngineer } = require('./featurer');

class RangeGridStrategy {
  constructor(opts = {}) {
    this.gridCount = opts.gridCount || 5;       // 网格层数
    this.lowerPct = opts.lowerPct || 0.02;       // 下沿距当前价2%
    this.upperPct = opts.upperPct || 0.02;       // 上沿距当前价2%
    this.rangeLookback = opts.rangeLookback || 96; // 看96根K线定箱体
    this.fe = new FeatureEngineer();
  }

  // 计算震荡箱体(用近N根最高/最低)
  computeRange(klines) {
    const look = Math.min(this.rangeLookback, klines.length);
    const seg = klines.slice(-look);
    const high = Math.max(...seg.map(k => +k[2]));
    const low = Math.min(...seg.map(k => +k[3]));
    return { high, low, mid: (high + low) / 2, range: high - low };
  }

  // 生成信号: 触下沿买 / 触上沿卖
  generateSignal(klines) {
    const feat = this.fe.buildFeatures(klines, 0);
    const price = feat.close;
    const rng = this.computeRange(klines);
    if (rng.range <= 0) return { signal: 'NONE', reason: '箱体范围0' };

    // 网格栅格: 在箱体内分 gridCount 档
    const step = rng.range / this.gridCount;
    // 当前价在箱体中的档位
    const pos = (price - rng.low) / rng.range;   // 0=底 1=顶

    if (pos <= 1 / (this.gridCount + 1)) {
      // 触底 → 网格买入(低买)
      return { signal: 'BUY', reason: `网格低买(位${(pos*100).toFixed(0)}%箱体底)`, price, side: 'LONG' };
    }
    if (pos >= this.gridCount / (this.gridCount + 1)) {
      // 触顶 → 网格卖出(高卖)
      return { signal: 'SELL', reason: `网格高卖(位${(pos*100).toFixed(0)}%箱体顶)`, price, side: 'SHORT' };
    }
    return { signal: 'NONE', reason: `箱体内位${(pos*100).toFixed(0)}%等待触边`, pos };
  }

  // 网格离场: 买后涨到上沿卖 / 卖后跌到下沿买
  gridExit(pos, price, rng) {
    if (!pos._gridRange) return { action: 'HOLD' };
    const { high, low } = pos._gridRange;
    if (pos.side === 'LONG' && price >= high * (1 - 0.001)) {
      return { action: 'CLOSE', reason: '网格止盈(触上沿卖)' };
    }
    if (pos.side === 'SHORT' && price <= low * (1 + 0.001)) {
      return { action: 'CLOSE', reason: '网格止盈(触下沿买回)' };
    }
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
