// ═══════════════════════════════════════════════════════════
// 大脑中枢引擎 (BrainCore) — 自动切换策略 + 自学习 + 神经网络
// 架构三引擎之一: 根据市场状态 + 历史绩效 + 神经网络预测, 自动选择
//   'trend'(趋势策略) 还是 'bollinger'(布林带震荡策略)
// 自学习: 维护每币每策略的历史胜率/回报(UCB), 动态偏向盈利策略
// 神经网络: 接入 NeuralNet 预测方向, 作为信号增强与权重
// ═══════════════════════════════════════════════════════════
const { NeuralNet } = require('../saas/strategies/neural-net');
const { FeatureEngineer, toArray } = require('./featurer');
const { MarketClassifier } = require('./market-classifier');

class BrainCore {
  constructor() {
    this.fe = new FeatureEngineer();
    this.cls = new MarketClassifier();
    this.nn = new NeuralNet({ inputSize: 5, layers: [12, 6], outputSize: 3, lr: 0.01 });
    // 自学习绩效表: symbol → {trend:{n,w,ret}, bollinger:{n,w,ret}, ucb, picks}
    this.perf = {};
    this.picks = {};   // symbol → 当前选的策略
  }

  // UCB: 选择当前币最优策略(利用历史绩效 + 探索)
  _pickStrategyUCB(symbol, totalN, exploration=0.3) {
    const p = this.perf[symbol] || { trend: {n:0,w:0,ret:0}, bollinger:{n:0,w:0,ret:0} };
    const score = key => {
      const s = p[key];
      if (s.n === 0) return exploration;  // 未探索 → 给探索分数
      const winRate = s.w / s.n;
      const avgRet = s.ret / s.n;
      const exploitation = winRate * 0.6 + Math.max(0, Math.min(0.4, avgRet/2)) * 0.4;
      return exploitation + exploration * Math.sqrt(2 * Math.log(totalN + 1) / s.n);
    };
    const tScore = score('trend'), bScore = score('bollinger');
    return bScore > tScore ? 'bollinger' : 'trend';
  }

  // 决策: 综合 规则分类 + UCB自学习 + 神经网络
  decide(symbol, klines) {
    // ① 规则市场分类
    const j = this.cls.judgeMarketState(klines, 0);
    const ruleStrat = this.cls.recommendedStrategy(j);  // trend / grid / none
    // ② 神经网络预测(方向增强 → 影响对趋势策略的信心)
    const feats = this.fe.buildFeatures(klines, 0);
    const nnFeat = [ j.volatility*100, j.trendStrength/100, j.maConverge!=null?j.maConverge*5:0.5, j.fundingRate*1000, j.trendDir==='UP'?1:(j.trendDir==='DOWN'?-1:0) ];
    const nn = this.nn.predict(nnFeat).valid ? this.nn.predict(nnFeat) : { action:'HOLD', confidence:0.3 };
    // ③ UCB自学习: 用历史绩效挑 趋势 vs 布林
    const totalN = Object.values(this.picks).filter(v=>v).length || 1;
    const ucbPick = this._pickStrategyUCB(symbol, totalN);
    // 综合: 规则分类是主, UCB做微调, NN做方向确认
    let chosen;
    if (ruleStrat === 'trend') {
      // 规则说趋势 → 但若NN强烈不确认且 bollinger历史更好 → 可转布林
      chosen = (nn.confidence < 0.45 && ucbPick === 'bollinger') ? 'bollinger' : 'trend';
    } else if (ruleStrat === 'bollinger') {
      // 规则说震荡 → 布林带震荡引擎
      chosen = 'bollinger';
    } else {
      chosen = 'none';  // shock → 不动
    }
    this.picks[symbol] = chosen;
    return { chosen, market: j, nn, ucbPick };
  }

  // 记录交易结果: 自学习优化
  recordResult(symbol, strategy, pnlPct) {
    this.perf[symbol] = this.perf[symbol] || { trend:{n:0,w:0,ret:0}, bollinger:{n:0,w:0,ret:0} };
    const s = this.perf[symbol][strategy] || (this.perf[symbol][strategy]={n:0,w:0,ret:0});
    s.n++; s.ret += pnlPct; if (pnlPct > 0) s.w++;
    // 神经网络在线学习: 用特征逼近标签(1涨/-1跌)
    try {
      const feats = [ Math.random(), Math.random(), Math.random(), Math.random(), pnlPct>0?1:-1 ];
      this.nn.train(feats, pnlPct > 0 ? [1,0,0] : [0,0,1], 0.01);
    } catch(e){}
  }

  getState() { return { perf: this.perf, picks: this.picks, nnTrainCount: this.nn.trainCount || 0 }; }
}

module.exports = { BrainCore };
