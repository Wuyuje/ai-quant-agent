// 回测: 大脑中枢自动切换 趋势(MA7) / 震荡(布林带) — 不含网格
const { toArray } = require('./featurer');
const { MarketClassifier } = require('./market-classifier');
const { TrendStrategy } = require('./trend-strategy');
const { BollingerStrategy } = require('./bollinger-strategy');

const TFEE = 0.0005, LONG_LEV=5, SHORT_LEV=3, PR=0.15;

class QuantBacktest {
  constructor() {
    this.cls = new MarketClassifier();
    this.trend = new TrendStrategy();
    this.boll = new BollingerStrategy();
  }

  run(klines, startBal = 1000) {
    let bal = startBal, nT = 0, nW = 0, nL = 0;
    let pos = null;
    const trades = [];
    for (let i = 300; i < klines.length; i++) {
      const win = klines.slice(0, i + 1);
      const price = +toArray(win)[win.length-1][3];
      const closes = toArray(win).map(k=>+k[3]);

      if (pos) {
        const lev = pos.side==='LONG'?LONG_LEV:SHORT_LEV;
        let cr = null;
        if (pos.strategy === 'trend') {
          const tp = this.trend.takeProfit(pos, price, closes);
          if (tp.action === 'CLOSE') cr = tp.reason;
          else { const sl = this.trend.stopLoss(pos, price, closes); if (sl.action==='CLOSE') cr = sl.reason; }
        } else if (pos.strategy === 'bollinger') {
          const tp = this.boll.checkTakeProfit(pos, win);
          if (tp.action === 'CLOSE') cr = tp.reason;
          else { const hs = this.boll.checkHardStop(pos, win, bal); if (hs.stop) cr = hs.reason; }
        }
        if (cr) {
          const raw = pos.side==='LONG'?(price-pos.entry)/pos.entry*100:(pos.entry-price)/pos.entry*100;
          const cp = raw*lev*PR - TFEE*200*PR;
          bal += cp; nT++; if (cp>0) nW++; else if (cp<0) nL++;
          trades.push({ result: +cp.toFixed(2), reason: cr.slice(0,20) });
          pos = null;
        }
      } else {
        const j = this.cls.judgeMarketState(closes, 0);
        const strat = this.cls.recommendedStrategy(j);  // trend/bollinger
        if (strat === 'trend') {
          const sig = this.trend.entrySignal(win, 'FLAT');
          if (sig.signal === 'LONG' || sig.signal === 'SHORT') pos = { side: sig.signal, strategy:'trend', entry: price };
        } else if (strat === 'bollinger') {
          const g = this.boll.canOpen(win);
          if (g.allowed) {
            const es = this.boll.entrySignal(win, 'FLAT', false);
            if (es.signal === 'LONG' || es.signal === 'SHORT') pos = { side: es.signal, strategy:'bollinger', entry: price };
          }
        }
      }
    }
    return { ret: +(bal-startBal)/startBal*100, endBal: bal, nT, nW, nL, rate: nT?Math.round(nW/nT*100):0, trades };
  }
}

module.exports = { QuantBacktest };
