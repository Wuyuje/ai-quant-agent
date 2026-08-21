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
  constructor(wallet) {
    this.fe = new FeatureEngineer();
    this.cls = new MarketClassifier();
    this.nn = new NeuralNet({ inputSize: 5, layers: [12, 6], outputSize: 3, lr: 0.01 });
    this.perf = {};   // symbol → {trend:{n,w,ret}, bollinger:{n,w,ret}, ucb, picks}
    this.picks = {};  // symbol → 当前选的策略
    this.wallet = wallet || '';
    // ═══ 每个用户独立的持久化文件(data/brain/<wallet>.json, 避免6个agent共享一个文件互相覆盖) ═══
    this._stateFile = null;
    try {
      const path = require('path'), fs = require('fs');
      const dir = path.join(__dirname, '..', 'data', 'brain');
      fs.mkdirSync(dir, { recursive: true });
      this._stateFile = path.join(dir, (wallet || 'default').slice(-20) + '.json');
      this._loadState();
    } catch(e) {}
    this._trainErrors = 0;
  }

  _saveState() {
    if (!this._stateFile) return;
    try {
      const state = { perf: this.perf, picks: this.picks, nnTrainCount: this.nn.trainCount || 0, savedAt: new Date().toISOString() };
      require('fs').writeFileSync(this._stateFile, JSON.stringify(state, null, 1));
    } catch(e) {}
  }

  _loadState() {
    if (!this._stateFile) return;
    try {
      if (require('fs').existsSync(this._stateFile)) {
        const state = JSON.parse(require('fs').readFileSync(this._stateFile, 'utf8'));
        if (state.perf) this.perf = state.perf;
        if (state.picks) this.picks = state.picks;
        // 恢复神经网络训练进度(避免重启后trainCount归零损失学习进度)
        const savedTrain = state.nnTrainCount || 0;
        if (savedTrain > (this.nn.trainCount || 0) && this.nn.trainCount !== undefined && this.nn.trainCount !== null) {
          this.nn.trainCount = savedTrain;
        }
        console.log('[Brain] ✅ 加载历史绩效: ' + Object.keys(this.perf).length + '个币种, nnTrain=' + (this.nn.trainCount||0));
      }
    } catch(e) {}
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
  recordResult(symbol, strategy, pnlPct, marketFeat) {
    this.perf[symbol] = this.perf[symbol] || { trend:{n:0,w:0,ret:0}, bollinger:{n:0,w:0,ret:0} };
    const s = this.perf[symbol][strategy] || (this.perf[symbol][strategy]={n:0,w:0,ret:0});
    s.n++; s.ret += pnlPct; if (pnlPct > 0) s.w++;
    // ═══ 神经网络在线学习: 用开仓时的真实市场特征(不decide()里一致), 不再用随机数 ═══
    try {
      const feats = marketFeat || [0, 0, 0.5, 0, 0];  // 无特征时用中性默认值(不用随机数污染训练)
      this.nn.train(feats, pnlPct > 0 ? [1,0,0] : [0,0,1], 0.01);
    } catch(e) {
      this._trainErrors = (this._trainErrors||0) + 1;
      if (this._trainErrors <= 5) console.log('[Brain] ⚠️ NN训练异常(' + this._trainErrors + '次): ' + e.message);
    }
    // 每笔交易都持久化(避免依赖%10倍数条件错过保存)
    this._saveState();
  }

  getState() { return { perf: this.perf, picks: this.picks, nnTrainCount: this.nn.trainCount || 0, trainErrors: this._trainErrors||0 }; }
}

module.exports = { BrainCore };
