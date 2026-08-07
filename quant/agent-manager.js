// ═══════════════════════════════════════════════════════════
// 新量化智能体·多用户管理器 (QuantAgentManager)
// 复用一个体: 用户DB / 币安APIkey / 算力费扣款 / 多人独立
// 每个用户独立运行: 数据工具→市场分类→双策略→执行风控
// 保存原系统: 用户注册/APIkey/算力费充值+自动扣/多人互不干扰
// ═══════════════════════════════════════════════════════════
const path = require('path');
const { BinanceAPI } = require('../lib/common');
const { decrypt } = require('../core/crypto-utils');
const { FeatureEngineer, toArray } = require('./featurer');
const { MarketClassifier } = require('./market-classifier');
const { TrendFollowingStrategy } = require('./trend-strategy');
const { RangeGridStrategy } = require('./grid-strategy');
const { TradeExecutionCore } = require('./execution-core');
const { HedgeStrategy } = require('./hedge-strategy');

// 算力费(与旧A策略一致): 盈利按平台0.20+生态0.10=30%扣给管理员
const PLATFORM_FEE_RATE = 0.20;
const ECO_FUND_RATE = 0.10;

class QuantAgent {
  constructor({ wallet, apiKey, apiSecret, isAdmin, userDB, pauseOpen }) {
    this.wallet = wallet;
    this.isAdmin = isAdmin;
    this.userDB = userDB;
    if (typeof pauseOpen === 'boolean') this.pauseOpen = pauseOpen;
    this.api = new BinanceAPI(apiKey, apiSecret);
    this.fe = new FeatureEngineer();
    this.classifier = new MarketClassifier();
    this.trend = new TrendFollowingStrategy();
    this.grid = new RangeGridStrategy();
    this.hedge = new HedgeStrategy();
    this.executor = new TradeExecutionCore({ api: this.api, wallet, logFn: m => this._log(m) });

    this.balance = 0;
    this.positions = {};       // symbol → {side, qty, entryPrice, leverage, _peak, strategy}
    this.closedHistory = [];
    this.pauseOpen = false;
    this._runCount = 0;
    this._logTag = wallet.slice(0,10);
  }

  _log(m) { const ts = new Date().toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}); console.log(`[${this._logTag}] ${ts} ${m}`); }

  // 主扫描: 每个标的
  async scan(pool) {
    if (this.pauseOpen) { this._manageOnly(); return; }
    // ① 刷新余额
    try { const bal = await this.api.getBalance(); if (typeof bal === 'number') this.balance = bal; } catch(e){}

    // ② 逐币分析: 分类市场 → 选策略 → 信号
    for (const symbol of pool) {
      // 已有仓位 → 交给平仓管理(趋势移动止损/网格离场)
      if (this.positions[symbol]) continue;
      if (Object.keys(this.positions).length >= 5) break;

      const kl = await this.api.getKlines(symbol, '15m', 120).catch(() => null);
      if (!kl || kl.length < 80) continue;
      // 资金费率
      let fr = 0; try { const f = await this.api.getFundingRate(symbol); fr = Array.isArray(f)&&f[0] ? +f[0].fundingRate : 0; } catch(e){}
      // 市场分类
      const j = this.classifier.judgeMarketState(kl, fr);
      const strat = this.classifier.recommendedStrategy(j);
      if (strat === 'none') continue;   // shock观望

      // 信号
      const pm = await this.api.getExchangeInfo().catch(()=>null);
      const price = +toArray(kl)[kl.length-1][3];
      let sig;
      if (strat === 'trend') {
        sig = this.trend.entrySignal(kl, j.trendDir);
        if (sig.signal === 'NONE') continue;
        const bs = this.trend.positionSize(this.balance, this.fe.atrPct(kl), 5);
        const r = await this.executor.executeOrder(sig, { symbol, side: sig.signal, notional: bs.notional, leverage: 5, precisionMap: pm, price, balance: this.balance });
        if (r.success) this.positions[symbol] = { side: sig.signal, qty: r.qty, entryPrice: price, leverage: 5, strategy: 'trend', _peak: price, openTime: Date.now() };
      } else if (strat === 'grid') {
        sig = this.grid.generateSignal(kl);
        if (sig.signal === 'NONE') continue;
        const bs = this.grid.calculatePositionSize(this.balance, this.fe.atrPct(kl), 3);
        const r = await this.executor.executeOrder(sig, { symbol, side: sig.side, notional: bs.notional, leverage: 3, precisionMap: pm, price, balance: this.balance });
        if (r.success) this.positions[symbol] = { side: sig.side, qty: r.qty, entryPrice: price, leverage: 3, strategy: 'grid', _peak: price, _gridRange: this.grid.computeRange(kl), openTime: Date.now() };
      }
    }
    this._manageOnly();
  }

  // 管理持仓: 移动止损/网格离场/止盈止损
  async _manageOnly() {
    for (const symbol of Object.keys(this.positions)) {
      const pos = this.positions[symbol];
      try {
        const kl = await this.api.getKlines(symbol, '15m', 60).catch(() => null);
        if (!kl || kl.length < 20) continue;
        const price = +toArray(kl)[kl.length-1][3];
        pos.currentPrice = price;
        const pm = await this.api.getExchangeInfo().catch(()=>null);
        let closeReason = null, pnlToCount = null;

        if (pos.strategy === 'trend') {
          const ts = this.trend.trailingStop(pos, price);
          if (ts.action === 'CLOSE') { closeReason = ts.reason; }
          else {
            const atr = this.fe.calcATR(kl);
            const sl = this.trend.stopLoss(pos, price, atr);
            if (sl.action === 'CLOSE') closeReason = sl.reason;
          }
        } else if (pos.strategy === 'grid') {
          const ge = this.grid.gridExit(pos, price, pos._gridRange || {});
          if (ge.action === 'CLOSE') closeReason = ge.reason;
        } else if (pos.strategy === 'hedge') {
          // 套利仓: 回归中轨(价格回到MA附近)就平
          const arr = toArray(kl); const closes = arr.map(k=>+k[3]);
          const ma = closes.length>=20 ? closes.slice(-20).reduce((a,b)=>a+b,0)/20 : price;
          const regained = (pos.side==='LONG' && price>=ma) || (pos.side==='SHORT' && price<=ma);
          if (regained) closeReason = '高频套利:价格回归中轨平仓';
        }

        if (closeReason) {
          pnlToCount = this._estimatePnl(pos, price);
          const r = await this.executor.closePosition(symbol, pos.side, pos.qty, pm, closeReason, pnlToCount);
          if (r.success) {
            this._settleServiceFee(symbol, pnlToCount);
            this.closedHistory.unshift({ symbol: symbol.replace('USDT',''), side: pos.side, pnl: pnlToCount, reason: closeReason, ts: Date.now(), strat: pos.strategy });
            delete this.positions[symbol];
          }
        }
      } catch(e){ this._log(`⚠️ ${symbol} 管理异常: ${e.message.slice(0,40)}`); }
    }
  }

  _estimatePnl(pos, price) {
    const dir = pos.side === 'LONG' ? (price - pos.entryPrice) : (pos.entryPrice - price);
    return dir / pos.entryPrice * pos.qty;   // 直接USD盈亏(近似)
  }

  // 算力费扣款(普通用户盈利扣30% → 管理员钱包累计)
  _settleServiceFee(symbol, pnlUsd) {
    if (!pnlUsd || pnlUsd <= 0 || this.isAdmin) return;   // 管理员免
    const platformFee = pnlUsd * PLATFORM_FEE_RATE;
    const ecoFund = pnlUsd * ECO_FUND_RATE;
    try {
      const feeFile = path.join(__dirname, '..', 'data', 'quant-fee-state.json');
      let st = {}; try { st = JSON.parse(require('fs').readFileSync(feeFile,'utf8')); } catch(e){ st = { totalPlatform:0, totalEco:0, pending:{} }; }
      st.totalPlatform = (st.totalPlatform||0) + platformFee;
      st.totalEco = (st.totalEco||0) + ecoFund;
      st.pending = st.pending || {}; st.pending[this.wallet] = (st.pending[this.wallet]||0) + platformFee + ecoFund;
      require('fs').writeFileSync(feeFile, JSON.stringify(st, null, 2));
      this._log(`💰 ${symbol} 扣算力费$${(platformFee+ecoFund).toFixed(2)}(平台${platformFee.toFixed(2)}+生态${ecoFund.toFixed(2)}) → 管理员`);
    } catch(e){}
  }

  getSummary() {
    const t = Math.max(1, this.closedHistory.length);
    const wins = this.closedHistory.filter(c => c.pnl > 0).length;
    return {
      wallet: this.wallet, isAdmin: this.isAdmin, balance: this.balance,
      positionCount: Object.keys(this.positions).length,
      positions: Object.entries(this.positions).map(([s,p]) => ({ symbol: s, side: p.side, strategy: p.strategy, entryPrice: p.entryPrice, currentPrice: p.currentPrice, leverage: p.leverage })),
      trades: this.closedHistory.length, wins, losses: this.closedHistory.length - wins,
      realizedPnl: this.closedHistory.reduce((a,c) => a + (c.pnl||0), 0),
    };
  }
}

class QuantAgentManager {
  constructor(opts = {}) {
    this.adminApiKey = opts.apiKey || process.env.BINANCE_API_KEY || '';
    this.adminApiSecret = opts.apiSecret || process.env.BINANCE_API_SECRET || '';
    this.userDB = opts.userDB || null;
    this.intervalMs = opts.intervalMs || 60000;
    this._timer = null;
    this._agents = {};       // wallet → QuantAgent
    this.running = false;
    this.pauseOpen = false;
    this.ADMIN_WALLETS = ['0xfa3b90c574469909d20848273c06752a22fde74a','0xe6ddf0771c7610dba77eb5a07ba7771dd7f5e91e','0x41c89c7df1ad4c8dd251c5afe45aa1c791fb6ea5','0xc6dbb4cd3b6a12068c7388248da2bd32df7ef9b7'];
    // 精选交易池(覆盖震荡币+趋势币, 由市场分类器自动选对应策略)
    // 震荡币(网格): BCH/OP/WIF/SEI/FIL/TIA/BTC/ETH  | 趋势币(趋势): DOT/STX/ALGO/ARB/INJ/APT/TURBO
    this.COIN_POOL = ['BCHUSDT','OPUSDT','WIFUSDT','SEIUSDT','FILUSDT','TIAUSDT','BTCUSDT','ETHUSDT',
                      'DOTUSDT','STXUSDT','ALGOUSDT','ARBUSDT','INJUSDT','APTUSDT','TURBOUSDT'];
  }
  _log(m) { const ts = new Date().toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}); console.log(`[Quant] ${ts} ${m}`); }
  _isAdmin(w) { return this.ADMIN_WALLETS.some(a => a.toLowerCase() === (w||'').toLowerCase()); }

  start() {
    if (this.running) return; this.running = true;
    this._log('🚀 新量化智能体管理器启动(市场分类+趋势/网格双策略)');
    this._loop();
  }

  async _loop() {
    try {
      // 读用户
      let users = {};
      try { users = JSON.parse(require('fs').readFileSync(path.join(__dirname,'..','data','saas-users.json'),'utf8')); } catch(e){}
      // 确保每个用户有智能体(管理员用统一key)
      for (const [wallet, u] of Object.entries(users)) {
        if (!wallet || !wallet.includes('0x')) continue;
        if (!this._agents[wallet]) {
          const isAdmin = this._isAdmin(wallet);
          let apiKey, apiSecret;
          if (isAdmin) { apiKey = this.adminApiKey; apiSecret = this.adminApiSecret; }
          else {
            if (!u.binanceApiKey || !u.binanceSecret) continue;
            apiKey = decrypt(u.binanceApiKey); apiSecret = decrypt(u.binanceSecret);
            if (!apiKey || apiKey.length !== 64) continue;
          }
          this._agents[wallet] = new QuantAgent({ wallet, apiKey, apiSecret, isAdmin, userDB: this.userDB, pauseOpen: this.pauseOpen });
          this._log(`${wallet.slice(0,10)} 智能体启动(${isAdmin?'管理员':'普通'})`);
        }
      }
      // 强制同步停开仓状态到所有agent(安全)
      const agents = Object.values(this._agents);
      for (const a of agents) a.pauseOpen = this.pauseOpen;
      await Promise.all(agents.map(a => a.scan(this.COIN_POOL).catch(() => {})));
      this._log(`[循环] ${agents.length}个智能体 · 持仓${agents.reduce((s,a)=>s+Object.keys(a.positions).length,0)}`);
    } catch(e) { this._log(`❌ 循环异常: ${e.message}`); }

    if (this.running) this._timer = setTimeout(() => this._loop(), this.intervalMs);
  }

  setPauseOpen(v) { this.pauseOpen = !!v; for (const a of Object.values(this._agents)) a.pauseOpen = this.pauseOpen; }
  getAllStatus() { return Object.values(this._agents).map(a => a.getSummary()); }
}

module.exports = { QuantAgentManager, QuantAgent };
