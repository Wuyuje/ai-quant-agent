// ═══════════════════════════════════════════════════════════
// 模块五·回测 (backtest)
// 用历史K线 检验 市场分类→双策略 的整体表现
// 对应图片: 五、回测与优化建议
// ═══════════════════════════════════════════════════════════
const { FeatureEngineer } = require('./featurer');
const { MarketClassifier } = require('./market-classifier');
const { TrendFollowingStrategy } = require('./trend-strategy');
const { RangeGridStrategy } = require('./grid-strategy');

const TFEE = 0.0005;      // 单边手续费
const LEV = 5;            // 杠杆

class QuantBacktest {
  constructor() {
    this.fe = new FeatureEngineer();
    this.cls = new MarketClassifier();
    this.trend = new TrendFollowingStrategy();
    this.grid = new RangeGridStrategy();
  }

  // 对单个币的K线跑完整回测
  run(klines, startBal = 1000) {
    let bal = startBal, nT = 0, nW = 0, nL = 0;
    let pos = null;      // {side, strategy, entry, _peak, _gridRange}
    const trades = [];

    for (let i = 120; i < klines.length; i++) {
      const win = klines.slice(0, i + 1);
      const price = +win[win.length-1][4];

      // ===== 持仓管理优先 =====
      if (pos) {
        let closeReason = null;
        if (pos.strategy === 'trend') {
          const ts = this.trend.trailingStop(pos, price);
          if (ts.action === 'CLOSE') closeReason = ts.reason;
          else {
            const atr = this.fe.calcATR(win);
            const sl = this.trend.stopLoss(pos, price, atr);
            if (sl.action === 'CLOSE') closeReason = sl.reason;
          }
        } else if (pos.strategy === 'grid') {
          const ge = this.grid.gridExit(pos, price, pos._gridRange);
          if (ge.action === 'CLOSE') closeReason = ge.reason;
        }
        if (closeReason) {
          // 结算
          const rawPct = pos.side === 'LONG' ? (price - pos.entry)/pos.entry*100 : (pos.entry - price)/pos.entry*100;
          const pnl = rawPct * LEV - TFEE * 200;  // 双边手续费(名义%)
          const normPct = pnl * (pos.side === 'LONG' ? 1 : 1);
          bal += pnl; nT++; pnl > 0 ? nW++ : nL++;
          trades.push({ symbol: null, side: pos.side, strategy: pos.strategy, pnlPct: +pnl.toFixed(2), reason: closeReason });
          pos = null;
        }
      }

      // ===== 开仓判定(无持仓时) =====
      if (!pos) {
        const j = this.cls.judgeMarketState(win, 0);
        const strat = this.cls.recommendedStrategy(j);
        if (strat === 'none') continue;
        if (strat === 'trend') {
          const sig = this.trend.entrySignal(win, j.trendDir);
          if (sig.signal !== 'NONE') {
            pos = { side: sig.signal, strategy: 'trend', entry: price, _peak: price };
          }
        } else if (strat === 'grid') {
          const sig = this.grid.generateSignal(win);
          if (sig.signal !== 'NONE' && sig.side) {
            pos = { side: sig.side, strategy: 'grid', entry: price, _peak: price, _gridRange: this.grid.computeRange(win) };
          }
        }
      }
    }

    // 未平仓结算
    if (pos) {
      const price = +klines[klines.length-1][4];
      const rawPct = pos.side === 'LONG' ? (price - pos.entry)/pos.entry*100 : (pos.entry - price)/pos.entry*100;
      const pnl = rawPct * LEV - TFEE * 200;
      bal += pnl; nT++; pnl > 0 ? nW++ : nL++;
    }

    return { ret: (bal - startBal)/startBal*100, endBal: bal, nT, nW, nL, rate: nT ? Math.round(nW/nT*100) : 0, trades };
  }
}

module.exports = { QuantBacktest };
