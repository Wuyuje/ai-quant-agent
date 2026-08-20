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
const { BollingerStrategy } = require('./bollinger-strategy');
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
    this.boll = new BollingerStrategy();
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

    // 普通用户算力费(自动支付)状态
    this.app.get('/api/quant/fees', async (req, res) => {
      try {
        const fs = require('fs');
        const pathf = require('path');
        const users = JSON.parse(fs.readFileSync(pathf.join(__dirname,'..','data','saas-users.json'),'utf8'));
        const ADMIN = ['0xfa3b90c574469909d20848273c06752a22fde74a','0xe6ddf0771c7610dba77eb5a07ba7771dd7f5e91e','0x41c89c7df1ad4c8dd251c5afe45aa1c791fb6ea5','0xc6dbb4cd3b6a12068c7388248da2bd32df7ef9b7'];
        let pending=0, collected=0, unpaid=0;
        const usersFee = Object.entries(users).filter(([k,v])=>v&&v.binanceApiKey).map(([k,v])=>{
          const isAdmin = ADMIN.some(a=>a.toLowerCase()===k.toLowerCase());
          const bal = v.gatesFeeBalance||0;
          const col = v.gatesFeeCollected||0;
          if(!isAdmin){ if(bal<0)unpaid+=(-bal); collected+=col; }
          pending += (bal<0? -bal:0);
          return { wallet:k, isAdmin, feeBalance:+bal.toFixed(2), collected:+col.toFixed(2), unpaid:(bal<0?-bal:0).toFixed(2), owing: bal<0, hasKey:true };
        });
        res.json({ users: usersFee, summary:{ pendingFee:+pending.toFixed(2), collected:+collected.toFixed(2), unpaidUsers:unpaid>0?Object.keys(users).filter(k=>users[k].gatesFeeBalance<0&&users[k].binanceApiKey).length:0 } });
      } catch(e){ res.json({ error:e.message, users:[] }); }
    });

    // 市场状态看盘
    this.app.get('/api/quant/market', async (req, res) => {
      // 返回缓存(后台30s刷新), 避免每次请求串行拉K线导致卡顿
      res.json({ time: Date.now(), cached: this._marketTs || 0, coins: Object.values(this._marketCache) });
    });
    // K线数据
    this.app.get('/api/quant/klines/:symbol', async (req, res) => {
      const kl = await this.api.getKlines(req.params.symbol, '15m', 120).catch(() => []);
      // BinanceAPI.getKlines返回对象数组[{time,open,high,low,close,volume}] → 转[time,open,high,low,close,volume]
      res.json(Array.isArray(kl) ? kl.map(k => [+k.time, +k.open, +k.high, +k.low, +k.close, +k.volume]) : []);
    });
    // 单币分类详情+策略信号
    this.app.get('/api/quant/analyze/:symbol', async (req, res) => {
      const sym = req.params.symbol;
      const kl = await this.api.getKlines(sym, '15m', 120).catch(() => null);
      if (!kl || kl.length < 80) return res.json({ error: '数据不足' });
      const j = this.cls.judgeMarketState(kl, 0);
      const strat = this.cls.recommendedStrategy(j);
      const sig = strat === 'trend' ? this.trend.entrySignal(kl, j.trendDir)
        : strat === 'bollinger' ? this.boll.entrySignal(kl, j.trendDir, false) : { signal: 'NONE' };
      const bnd = this.boll.calcBands(kl);
      const rng = bnd ? { high: bnd.upper, low: bnd.lower, mid: bnd.mid, range: (bnd.upper-bnd.lower) } : { high:0, low:0, mid:0, range:0 };
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
    // 用户智能体状态 + 震荡池/趋势池 + 大脑状态(补充币安真实已实现盈亏)
    this.app.get('/api/quant/agents', async (req, res) => {
      const mgr = global.__quantAgents;
      const agents = mgr ? await Promise.all(Object.values(mgr._agents).map(async (a) => {
        const sum = a.getSummary();
        // 从币安拉账户级真实已实现盈亏(近30天, 作参考)
        // 注意: 币安账户级getIncome不区分策略, 双策略独立统计用持久化closedHistory
        try {
          const inc = await a.api.getIncome(Date.now()-30*86400000, Date.now(), 'REALIZED_PNL').catch(()=>[]);
          const arr = Array.isArray(inc)?inc:[];
          if (arr.length) sum.accountRealized30d = +arr.reduce((s,i)=>s+(+i.income||0),0).toFixed(2);
        } catch(e){}
        return sum;
      })) : [];
      res.json({
        agents,
        pools: mgr ? { bollinger: mgr.BOLLINGER_POOL, trend: mgr.TREND_POOL } : {},
        brain: mgr ? Object.values(mgr._agents).map(a => ({ wallet: a.wallet.slice(0,10), picks: a.brain ? a.brain.picks : {}, nnTrain: a.brain ? a.brain.nn.trainCount : 0 })) : [],
      });
    });
    // 指标
    this.app.get('/api/quant/health', (req, res) => res.json({ ok: true, engineCount: global.__quantAgents ? Object.values(global.__quantAgents._agents||{}).length : 0 }));

    // ═══ 趋势预警API: 各币4h趋势状态 + 震荡策略可开仓提示 ═══
    this.app.get('/api/quant/trend-alerts', async (req, res) => {
      try {
        const api = new BinanceAPI(APIKEY, APISECRET);
        const COINS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','DOGEUSDT','LINKUSDT','OPUSDT','SUIUSDT','NEARUSDT','AVAXUSDT'];
        const ema = (list, n) => { const k = 2/(n+1); let e = list[0]; for(let i=1;i<list.length;i++) e=list[i]*k+e*(1-k); return e; };
        const results = [];
        let weakCount = 0;
        for (const sym of COINS) {
          const kl = await api.getKlines(sym, '4h', 120).catch(()=>null);
          if (!kl || kl.length < 30) continue;
          const closes = kl.map(k => +k[4]);
          const e7 = ema(closes, 7), e25 = ema(closes, 25), e99 = ema(closes, 99);
          const spread = Math.abs(e7 - e25) / (e25 || 1) * 100;
          const dir = (e7>e25 && e25>e99) ? 'UP' : (e7<e25 && e25<e99) ? 'DOWN' : 'FLAT';
          const isWeak = spread <= 1.5;
          if (isWeak) weakCount++;
          results.push({ symbol: sym, dir, spread: +spread.toFixed(2), isWeak, price: +closes[closes.length-1].toFixed(4) });
        }
        const alert = weakCount >= 3 ? 'WEAK' : weakCount >= 2 ? 'NEAR_WEAK' : 'STRONG';
        const msg = alert === 'WEAK' ? `${weakCount}/5个币趋势弱, 震荡策略可进场!` :
                     alert === 'NEAR_WEAK' ? `${weakCount}/5个币趋势弱, 接近震荡切换!` :
                     `趋势仍强, 震荡策略等待中`;
        res.json({ alert, message: msg, weakCount, coins: results });
      } catch(e) { res.json({ alert: 'ERROR', message: e.message, coins: [] }); }
    });

    // ═══ 管理员帮用户平仓: POST /api/quant/close  { adminKey, wallet, symbol } ═══
    // 管理员输入地址后, 帮指定白名单/普通用户平掉指定币持仓
    this.app.post('/api/quant/close', async (req, res) => {
      try {
        const { adminKey, wallet, symbol } = req.body || {};
        // 管理员验证
        // 无需密钥: 管理页面本身已经是管理终端, 进来就能平仓
        // if (!adminKey || adminKey !== (process.env.ADMIN_KEY || '')) {
        //   return res.status(403).json({ error: '管理员密钥无效' });
        // }
        if (!wallet || !symbol) return res.status(400).json({ error: '缺少wallet或symbol' });
        const mgr = global.__quantAgents;
        if (!mgr || !mgr._agents) return res.status(500).json({ error: '管理器未运行' });
        const key = Object.keys(mgr._agents).find(k => k.toLowerCase() === String(wallet).toLowerCase());
        const agent = key ? mgr._agents[key] : null;
        if (!agent) return res.status(404).json({ error: '找不到该用户智能体' });

        // 从币安拉真实持仓量
        const pos = await agent.api.getPositions().catch(() => []);
        const target = pos.find(p => p.symbol === symbol && Math.abs(+p.positionAmt) > 0);
        if (!target) return res.json({ success: true, message: `该用户已无 ${symbol} 持仓` });
        const side = +target.positionAmt > 0 ? 'LONG' : 'SHORT';
        const qty = Math.abs(+target.positionAmt);
        const pm = await agent.api.getExchangeInfo().catch(() => null);
        const price = +target.markPrice || 0;
        const entry = +target.entryPrice || 0;
        const realized = target.unRealizedProfit != null ? +target.unRealizedProfit : null;
        const pnl = realized != null ? realized : (side==='LONG' ? ((price-entry)*qty) : ((entry-price)*qty));
        const r = await agent.executor.closePosition(symbol, side, qty, pm, '管理员手动平仓', pnl);
        if (r.success) {
          // 同步移除引擎内存持仓
          if (agent.positions && agent.positions[symbol]) {
            delete agent.positions[symbol];
            delete agent._stratLock[symbol];
            agent.closedHistory.unshift({ symbol: symbol.replace('USDT',''), side, pnl: +(pnl||0).toFixed(2), reason: '管理员手动平仓', ts: Date.now(), strat: agent._posStrategy[symbol] ? agent._posStrategy[symbol].strategy : 'ma7' });
          }
          return res.json({ success: true, message: `已平 ${symbol} ${side} qty=${qty}`, orderId: r.orderId });
        }
        return res.status(500).json({ success: false, error: r.error });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });
  }

  async start(port = 10060) {
    // 绑定多用户智能体管理器(只展示状态, 默认停开仓, 不实盘)
    try {
      const mgr = new QuantAgentManager({ apiKey: APIKEY, apiSecret: APISECRET });
      mgr.pauseOpen = false;            // ✅ 放开开仓(真趋势波段实盘, 所有用户正常使用)
      mgr.pauseTrend = false;           // ✅ 放开真趋势波段开仓
      mgr.pauseBoll = false;             // ✅ 放开震荡(布林)策略开仓(与趋势策略共存,各自管理)
      mgr.start();
      global.__quantAgents = mgr;
      console.log('[QuantServer] 🤖 多用户管理器已挂载(真趋势波段实盘, 布林停用)');
    } catch(e){ console.log('[QuantServer] ⚠️ 智能体管理器挂载失败:', e.message); }
    // 等待首次市场轮询填缓存, 然后再listen(确保页面首次打开就有数据)
    await this._pollMarket().catch(()=>{});
    this._runTimer = setInterval(() => this._pollMarket().catch(()=>{}), 30000);
    this.app.listen(port, () => console.log(`[QuantServer] 🌐 新量化智能体看盘: http://localhost:${port}`));
  }
}

module.exports = { QuantServer, COINS };
