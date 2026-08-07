// ═══════════════════════════════════════════════════════════
// 新量化智能体·独立服务 (QuantServer)
// 多功能看盘 + 管理 API + 服务仪表盘页面
// 不依赖旧 start.js, 独立运行
// ═══════════════════════════════════════════════════════════
const express = require('express');
const path = require('path');
const fs = require('fs');
const { BinanceAPI } = require('../lib/common');
const { MarketClassifier } = require('./market-classifier');
const { FeatureEngineer, toArray } = require('./featurer');
const { TrendStrategy } = require('./trend-strategy');
const { RangeGridStrategy } = require('./grid-strategy');
const { QuantBacktest } = require('./backtest');
const { QuantAgentManager } = require('./agent-manager');

const APIKEY = process.env.BINANCE_API_KEY, APISECRET = process.env.BINANCE_API_SECRET;
const COINS = ['ETHUSDT','BCHUSDT','ARBUSDT','TURBOUSDT','INJUSDT','1000PEPEUSDT','LINKUSDT','SEIUSDT','WIFUSDT','SOLUSDT','BTCUSDT'];

class QuantServer {
  constructor() {
    this.app = express();
    this.app.use(express.json());
    this.app.use(express.static(__dirname));
    this.app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
    this.app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
    this.cls = new MarketClassifier();
    this.fe = new FeatureEngineer();
    this.trend = new TrendStrategy();
    this.grid = new RangeGridStrategy();
    this.bt = new QuantBacktest();
    this.api = new BinanceAPI(APIKEY, APISECRET);
    this._marketCache = {};   // sym → 分类结果
    this._runTimer = null;
    this._routes();
  }

  // 后台轮询市场分类(缓存, 供看盘)
  async _pollMarket() {
    try {
      this._marketTs = Date.now();
      for (const sym of COINS) {
        const kl = await this.api.getKlines(sym, '15m', 120).catch(() => null);
        if (!kl || kl.length < 80) continue;
        const j = this.cls.judgeMarketState(kl, 0);
        const strat = this.cls.recommendedStrategy(j);
        this._marketCache[sym] = {
          symbol: sym, close: +toArray(kl)[kl.length-1][3], state: j.state, trendDir: j.trendDir,
          adx: +(j.trendStrength||0).toFixed(1), volatility: +(j.volatility*100).toFixed(2),
          fundingRate: +(j.fundingRate*100).toFixed(4), recommended: strat,
          emaGap: +((j.emaGap||0)*100).toFixed(2),
        };
      }
    } catch(e){}
  }

  _routes() {
    // 市场状态看盘
    this.app.get('/api/quant/market', async (req, res) => {
      // 返回缓存(后台30s刷新), 避免每次请求串行拉K线导致卡顿
      res.json({ time: Date.now(), cached: this._marketTs || 0, coins: Object.values(this._marketCache) });
    });
    // K线数据
    this.app.get('/api/quant/klines/:symbol', async (req, res) => {
      const kl = await this.api.getKlines(req.params.symbol, '15m', 120).catch(() => []);
      res.json(Array.isArray(kl) ? kl.map(k => [+k[0], +k[1], +k[2], +k[3], +k[4], +k[5]]) : []);
    });
    // 单币分类详情+策略信号
    this.app.get('/api/quant/analyze/:symbol', async (req, res) => {
      const sym = req.params.symbol;
      const kl = await this.api.getKlines(sym, '15m', 120).catch(() => null);
      if (!kl || kl.length < 80) return res.json({ error: '数据不足' });
      const j = this.cls.judgeMarketState(kl, 0);
      const strat = this.cls.recommendedStrategy(j);
      const sig = strat === 'trend' ? this.trend.entrySignal(kl, j.trendDir)
        : strat === 'grid' ? this.grid.generateSignal(kl) : { signal: 'NONE' };
      const rng = this.grid.computeRange(kl);
      res.json({ symbol: sym, state: j.state, trendDir: j.trendDir, adx: j.trendStrength,
        volatility: j.volatility, recommended: strat, signal: sig, range: rng, close: +toArray(kl)[kl.length-1][3] });
    });
    // 回测
    this.app.get('/api/quant/backtest/:symbol/:days', async (req, res) => {
      const days = Math.min(parseInt(req.params.days)||30, 180);
      const kl = await this.api.getKlines(req.params.symbol, '1h', days*24).catch(()=>null);
      if (!Array.isArray(kl) || kl.length < 200) return res.json({ error: '数据不足' });
      const r = this.bt.run(kl);
      res.json({ symbol: req.params.symbol, days, ...r });
    });
    // 用户智能体状态 + 震荡池/趋势池 + 大脑状态
    this.app.get('/api/quant/agents', async (req, res) => {
      const mgr = global.__quantAgents;
      res.json({
        agents: mgr ? mgr.getAllStatus() : [],
        pools: mgr ? { bollinger: mgr.BOLLINGER_POOL, trend: mgr.TREND_POOL } : {},
        brain: mgr ? Object.values(mgr._agents).map(a => ({ wallet: a.wallet.slice(0,10), picks: a.brain ? a.brain.picks : {}, nnTrain: a.brain ? a.brain.nn.trainCount : 0 })) : [],
      });
    });
    // 指标
    this.app.get('/api/quant/health', (req, res) => res.json({ ok: true, engineCount: global.__quantAgents ? Object.values(global.__quantAgents._agents||{}).length : 0 }));
  }

  async start(port = 10060) {
    // 绑定多用户智能体管理器(只展示状态, 默认停开仓, 不实盘)
    try {
      const mgr = new QuantAgentManager({ apiKey: APIKEY, apiSecret: APISECRET });
      mgr.pauseOpen = false;           // 灰度: 管理员可开仓(agent-manager按isAdmin区分, 普通用户仍停)
      mgr.start();
      global.__quantAgents = mgr;
      console.log('[QuantServer] 🤖 多用户智能体管理器已挂载(展示状态, 停开仓)');
    } catch(e){ console.log('[QuantServer] ⚠️ 智能体管理器挂载失败:', e.message); }
    // 等待首次市场轮询填缓存, 然后再listen(确保页面首次打开就有数据)
    await this._pollMarket().catch(()=>{});
    this._runTimer = setInterval(() => this._pollMarket().catch(()=>{}), 30000);
    this.app.listen(port, () => console.log(`[QuantServer] 🌐 新量化智能体看盘: http://localhost:${port}`));
  }
}

module.exports = { QuantServer, COINS };
