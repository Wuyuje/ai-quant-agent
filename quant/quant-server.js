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
const { TrendFollowingStrategy } = require('./trend-strategy');
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
    this.cls = new MarketClassifier();
    this.fe = new FeatureEngineer();
    this.trend = new TrendFollowingStrategy();
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
      await this._pollMarket();
      res.json({ time: Date.now(), coins: Object.values(this._marketCache) });
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
    // 用户智能体状态(从agent-manager读)
    this.app.get('/api/quant/agents', async (req, res) => {
      res.json({ agents: global.__quantAgents ? global.__quantAgents.getAllStatus() : [], note: '智能体管理器绑定后实时' });
    });
    // 指标
    this.app.get('/api/quant/health', (req, res) => res.json({ ok: true, engineCount: global.__quantAgents ? Object.values(global.__quantAgents._agents||{}).length : 0 }));
  }

  start(port = 10060) {
    // 启动市场轮询
    this._pollMarket(); this._runTimer = setInterval(() => this._pollMarket(), 30000);
    this.app.listen(port, () => console.log(`[QuantServer] 🌐 新量化智能体看盘: http://localhost:${port}`));
  }
}

module.exports = { QuantServer, COINS };
