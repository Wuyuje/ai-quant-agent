// ═══════════════════════════════════════════════════════════
// 新量化智能体·多用户管理器 (QuantAgentManager)
// 复用一个体: 用户DB / 币安APIkey / 算力费扣款 / 多人独立
// 每个用户独立运行: 数据工具→市场分类→双策略→执行风控
// 保存原系统: 用户注册/APIkey/算力费充值+自动扣/多人互不干扰
// ═══════════════════════════════════════════════════════════
const path = require('path');
const fs = require('fs');
const { BinanceAPI } = require('../lib/common');
const { decrypt } = require('../core/crypto-utils');
const { FeatureEngineer, toArray } = require('./featurer');
const { MarketClassifier } = require('./market-classifier');
const { TrendStrategy } = require('./trend-strategy');  // MA趋势引擎(规格版)
const { TradeExecutionCore } = require('./execution-core');
const { TrendStrategyV4 } = require('./trend-strategy-v4'); // 阿奇日线大周期独立趋势引擎
const { BollingerStrategy } = require('./bollinger-strategy');
const { BrainCore } = require('./brain-core');

// 算力费(与旧A策略一致): 盈利按平台0.20+生态0.10=30%扣给管理员
const PLATFORM_FEE_RATE = 0.20;
const ECO_FUND_RATE = 0.10;

class QuantAgent {
  constructor({ wallet, apiKey, apiSecret, isAdmin, isWhitelist, userDB, pauseOpen }) {
    this.wallet = wallet;
    this.isAdmin = isAdmin;
    this.isWhitelist = isWhitelist || false;
    this.userDB = userDB;
    if (typeof pauseOpen === 'boolean') this.pauseOpen = pauseOpen;
    this.api = new BinanceAPI(apiKey, apiSecret);
    this.fe = new FeatureEngineer();
    this.classifier = new MarketClassifier();
    this.trend = new TrendStrategy();  // MA多空排列趋势引擎(纯MA7, 回测一致无DIF)
    this.trendV4 = new TrendStrategyV4({ minBars: 60 });  // 阿奇日线大周期趋势引擎(实盘测试用)
    this.boll = new BollingerStrategy();      // 新震荡·布林带策略
    this.brain = new BrainCore();             // 大脑中枢(切换+自学习+NN)
    this.executor = new TradeExecutionCore({ api: this.api, wallet, logFn: m => this._log(m) });

    this.balance = 0;
    this.totalWalletBalance = 0;   // 币安合约账户总余额(合约总资金)
    this.positions = {};       // symbol → {side, qty, entryPrice, leverage, _peak, strategy}
    this.closedHistory = [];
    this._stratLock = {};      // symbol → 锁定的策略(trend/bollinger), 防双引擎互博
    this.pauseOpen = false;
    this._runCount = 0;
    this._logTag = wallet.slice(0,10);
    // 状态文件路径: 每个用户独立持久化(closedHistory/balance), 重启不丢
    try { this._stateFile = path.join(__dirname, '..', 'data', 'users', wallet, 'quant-state.json'); fs.mkdirSync(path.dirname(this._stateFile), { recursive: true }); } catch(e){ this._stateFile = null; }
    this._loadState();
  }

  _log(m) { const ts = new Date().toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}); console.log(`[${this._logTag}] ${ts} ${m}`); }
  // 状态持久化: closedHistory/balance 保存到文件, 重启不丢失(交易/胜率/已实现盈亏)
  _saveState() { try { fs.writeFileSync(this._stateFile, JSON.stringify({ closedHistory: this.closedHistory, balance: this.balance }, null, 1)); } catch(e){} }
  _loadState() { try { if (fs.existsSync(this._stateFile)) { const st = JSON.parse(fs.readFileSync(this._stateFile,'utf8')); if (Array.isArray(st.closedHistory)) {
    // 合理性过滤: 单笔|pnl|超本金1.5倍(物理不可能, 旧_estimatePnl公式污染) → 丢弃
    const bal = typeof st.balance==='number' && st.balance>0 ? st.balance : this.balance;
    const thr = Math.max(30, bal*1.5);
    this.closedHistory = st.closedHistory.filter(c => !c.pnl || Math.abs(c.pnl) <= thr);
    if (this.closedHistory.length < st.closedHistory.length) this._log(`⚠️ 过滤${st.closedHistory.length-this.closedHistory.length}笔异常平仓(旧盈亏公式污染), 保留${this.closedHistory.length}笔`);
  } if (typeof st.balance==='number') this.balance = st.balance; } } catch(e){} }

  // 大盘过滤器: BTC走弱(RISK)时不开新仓, 只管理已有持仓
  _btcRegime(btcKlines) {
    try {
      const arr = toArray(btcKlines); const closes = arr.map(k => +k[3]);
      if (!closes.length) return 'OK';
      const last = closes[closes.length-1];
      const seg = closes.slice(-30); const ma30v = seg.reduce((a,b)=>a+b,0)/seg.length;
      const last6 = closes[Math.max(0,closes.length-6)];
      const mom = (last-last6)/(last6||1)*100;
      const pos300 = (last-ma30v)/(ma30v||1)*100;
      if (pos300 < -0.5 && mom < -0.1) return 'DOWN';   // BTC走弱=下跌
      if (pos300 > 0.5 && mom > 0.1) return 'UP';       // BTC走强=上涨
      return 'OK';
    } catch(e){ return 'OK'; }
  }


  // ═══ 从币安同步真实持仓(引擎内存与币安一致) ═══
  async _syncPositions() {
    try {
      const acc = await this.api._request('GET', '/fapi/v2/positionRisk').catch(() => null);
      if (!Array.isArray(acc)) return;
      const real = acc.filter(p => p.symbol && p.positionAmt && Math.abs(+p.positionAmt) > 0);
      this._unrealizedPnl = real.reduce((s, p) => s + (+p.unRealizedProfit || 0), 0);
      for (const p of real) {
        const sym = p.symbol;
        const amt = +p.positionAmt;
        const side = amt > 0 ? 'LONG' : 'SHORT';
        // 币安有仓但引擎没记录 → 载入(接管)
        if (!this.positions[sym]) {
          const lev = parseInt(p.leverage) || 5;
          this.positions[sym] = {
            symbol: sym, side, qty: Math.abs(amt), entryPrice: +p.entryPrice,
            currentPrice: +p.markPrice, margin: Math.abs(+p.entryPrice)*(+p.markPrice)/lev,
            leverage: lev, _peak: +p.entryPrice, openTime: Date.now(),
            strategy: this._stratLock[sym] || 'trend',   // 接管仓用trend逻辑管理(现有仓多为趋势开)
            _managed: true                                // 标记为接管仓, 开仓配额判断时排除
          };
        } else {
          // 已有记录, 更新价格/数量
          this.positions[sym].currentPrice = +p.markPrice;
          const realQty = Math.abs(amt);
          if (Math.abs(realQty - (this.positions[sym].qty||0)) > (this.positions[sym].qty||0)*0.01) this.positions[sym].qty = realQty;
        }
      }
      // 币安已平的仓(本地还有) → 移除
      const realSyms = new Set(real.map(p=>p.symbol));
      for (const sym of Object.keys(this.positions)) {
        if (!realSyms.has(sym)) { delete this.positions[sym]; delete this._stratLock[sym]; }
      }
    } catch(e){}
  }


  // 主扫描: 每个标的
  async scan(pool) {
    await this._syncPositions();  // 先同步币安真实持仓
    if (this.pauseOpen) { this._manageOnly(); return; }
    // 大盘过滤: 缓存BTC状态(每轮查一次)
    try {
      if (!this._btcCache || Date.now() - this._btcCache.t > 60000) {
        const bkl = await this.api.getKlines('BTCUSDT', '4h', 60).catch(() => null);
        this._btcCache = { t: Date.now(), state: bkl ? this._btcRegime(bkl) : 'OK' };
      }
      this._marketRisk = this._btcCache.state;
    } catch(e){ this._marketRisk = 'OK'; }
    // ① 刷新余额
    try { const bal = await this.api.getBalance(); if (typeof bal === 'number') this.balance = bal; } catch(e){}
    // 合约账户总余额(总资金) 从 /fapi/v2/account 读取
    try { const acc = await this.api._request('GET', '/fapi/v2/account').catch(() => null); if (acc && acc.totalWalletBalance != null) this.totalWalletBalance = +acc.totalWalletBalance; } catch(e){}

    // ② 逐币分析: 分类市场 → 选策略 → 信号
    for (const symbol of pool) {
      // 已有仓位 → 交给平仓管理(趋势移动止损/网格离场)
      if (this.positions[symbol]) continue;

      const kl = await this.api.getKlines(symbol, '15m', 300).catch(() => null);   // 300根够MA7 lookback(288)算位置区间
      if (this.isAdmin && (this._runCount % 1 === 0)) this._log(`🔍scan ${symbol}: kl=${kl?(kl.length||0):'null'}枚`);
      if (!kl || kl.length < 288) { if (this.isAdmin) this._log(`  ⏭️ ${symbol} 数据不足(kl=${kl?(kl.length||0):0})`); continue; }
      // 资金费率
      let fr = 0; try { const f = await this.api.getFundingRate(symbol); fr = Array.isArray(f)&&f[0] ? +f[0].fundingRate : 0; } catch(e){}
      // ═══ 大脑中枢: 提供市场分类/方向(不再用它的'none'拦截池内币) ═══
      const decision = this.brain.decide(symbol, kl);
      // ═══ 分池决定策略: 币在MA7池→ma7, 在V4池→v4, 在震荡池→bollinger ═══
      const inMA7 = this.MA7_POOL && this.MA7_POOL.includes(symbol);
      const inV4  = this.V4_POOL && this.V4_POOL.includes(symbol);
      const inBollP = this.BOLLINGER_POOL && this.BOLLINGER_POOL.includes(symbol);
      let strat;
      if (inMA7) strat = 'trend_ma7';
      else if (inV4) strat = 'trend_v4';
      else if (inBollP) strat = 'bollinger';
      else continue;   // 不在任何池 → 跳过
      if (this.isAdmin) this._log(`🔍分池 ${symbol}: MA7池${inMA7?'✓':'✗'} V4池${inV4?'✓':'✗'} 震荡${inBollP?'✓':'✗'} → ${strat}`);
      // ═══ 各引擎独立仓位配额: 趋势≤3 / 震荡≤5 (互不干涉) ═══
      const trendCount = Object.values(this.positions).filter(p=>p.strategy==='trend' && !p._managed).length;
      const bollCount  = Object.values(this.positions).filter(p=>p.strategy==='bollinger' && !p._managed).length;
      const TREND_MAX = 5, BOLL_MAX = 5;
      if (strat === 'trend' && trendCount >= TREND_MAX) continue;      // 趋势仓满5→不开
      if (strat === 'bollinger' && bollCount >= BOLL_MAX) continue;    // 震荡仓满5→不开
      // 每币单一策略锁: 已锁定则强制一致
      if (this._stratLock[symbol] && this._stratLock[symbol] !== strat) continue;

      const pm = await this.api.getExchangeInfo().catch(()=>null);
      const price = +toArray(kl)[kl.length-1][3];
      let sig;
      if (strat === 'trend_ma7' || strat === 'trend_v4') {
        if (this.pauseTrend) continue;   // 趋势引擎暂停开仓
        if (this.positions[symbol]) continue;   // 同币已持单, 不再开
        // ═══ 分开选池: 币在MA7池只跑MA7(15m), 在V4池只跑V4(日线) ═══
        let sig = null, stg = strat === 'trend_v4' ? 'v4' : 'ma7', stf = strat === 'trend_v4' ? '1d' : '15m';
        if (strat === 'trend_v4') {
          // V4 池币: 只按 V4(日线) 信号
          const kld = await this.api.getKlines(symbol, '1d', 120).catch(()=>null);
          if (kld && kld.length >= 60) {
            const dObj = toArray(kld).map(k => ({ open: k[1], high: k[2], low: k[3], close: k[4], volume: k[5] }));
            sig = this.trendV4.entrySignal(dObj);
          }
        } else {
          // MA7 池币: 只按 MA7(15m) 大道至简低买高卖
          sig = this.trend.entrySignal(kl, decision.market.trendDir);
        }
        if (!sig || sig.signal === 'NONE') { this._log(`🔍 ${symbol} ${stg}信号NONE(${(sig&&sig.reason)||'无'})`); continue; }
        this._log(`🔍 ${symbol} ${stg}信号=${sig.signal} 准备开仓`);
        // 仓位: V4日线30%/MA7 20%
        const posPct = stg === 'v4' ? 0.30 : 0.20;
        const eng = stg === 'v4' ? this.trendV4 : this.trend;
        const bs = eng.positionSize(this.balance, sig.signal, posPct);
        if ((this.balance || 0) < 100) continue;
        const stgHeld = Object.values(this.positions).filter(p=>p.strategy===stg).length;
        const maxPerStg = stg === 'v4' ? 3 : 4;
        if (stgHeld >= maxPerStg) continue;
        const lev = stg === 'v4' ? 5 : 3;
        const r = await this.executor.executeOrder(sig, { symbol, side: sig.signal, notional: bs.notional, leverage: lev, precisionMap: pm, price, balance: this.balance });
        if (r.success) { this.positions[symbol] = { side: sig.signal, qty: r.qty, entryPrice: price, leverage: lev, strategy: stg, _t: stf, _peak: price, openTime: Date.now() }; this._stratLock[symbol]=stg; }
      } else if (strat === 'bollinger') {
        // 多币并仓: 震荡池全部币可开(不限bollTop前5, 提高资金使用)
        if (this.pauseBoll) continue;   // 暂停震荡(布林)策略开仓
        // 布林带策略(规格): 5分钟K线决策
        const bkl = await this.api.getKlines(symbol, '5m', 120).catch(() => null);
        if (!bkl || bkl.length < 40) continue;
        // 截图: 单K±3%毛刺信号作废
        if (this.boll.isSpikeBar(bkl)) continue;
        // 截图: 特殊时间(资金费率结算前15min等)禁新开/补
        const guard = this.boll.tradingGuardAllowed();
        if (!guard.allowed) continue;
        const openGate = this.boll.canOpen(bkl);
        if (!openGate.allowed) continue;   // 带宽>90%禁开 / 未解禁
        const esig = this.boll.entrySignal(bkl, decision.market.trendDir, false);
        if (esig.signal === 'LONG' || esig.signal === 'SHORT') {
          const bs = { notional: Math.max(20, this.balance*0.15*3), margin: Math.max(20,this.balance*0.15*3)/3, leverage: 3 };
          const r = await this.executor.executeOrder(esig, { symbol, side: esig.signal, notional: bs.notional, leverage: 3, precisionMap: pm, price, balance: this.balance });
          if (r.success) { this.positions[symbol] = { side: esig.signal, qty: r.qty, entryPrice: price, leverage: 3, strategy: 'bollinger', _peak: price, _addRound: 0, _lastAddIdx: 0, openTime: Date.now() }; this._stratLock[symbol]='bollinger'; }
        }
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

        if (pos.strategy === 'v4') {
          // V4 阿奇日线趋势: 按周期(tf)拉K线, V4逻辑止损/结构破坏止盈
          const tf = pos._t || '1d';
          const klast = await this.api.getKlines(symbol, tf, 150).catch(() => null);
          if (klast && klast.length >= 40) {
            const dObj = toArray(klast).map(k => ({ open: k[1], high: k[2], low: k[3], close: k[4], volume: k[5] }));
            const sl = this.trendV4.stopLoss(pos, dObj);
            if (sl.action === 'CLOSE') closeReason = sl.reason;
            else { const tp = this.trendV4.takeProfit(pos, dObj); if (tp.action === 'CLOSE') closeReason = tp.reason; }
          }
        }
        if (pos.strategy === 'ma7') {
          // MA7 大道至简: 用15m/5m K线, MA7低买高卖止盈(到顶/到底拐头) + 硬止损
          const mkl = await this.api.getKlines(symbol, '15m', 120).catch(() => null);
          if (mkl && mkl.length >= 40) {
            const mObj = toArray(mkl).map(k => +k[3]);
            const price = mObj[mObj.length - 1];
            const ts = this.trend.takeProfit(pos, price, mObj);
            if (ts.action === 'CLOSE') closeReason = ts.reason;
            else { const sl = this.trend.stopLoss(pos, price, mObj); if (sl.action === 'CLOSE') closeReason = sl.reason; }
          }
        }
        if (pos.strategy === 'bollinger') {
          // 布林带策略止盈/风控(规格): 5min K线
          const bkl = await this.api.getKlines(symbol, '5m', 120).catch(() => null);
          if (bkl && bkl.length >= 30) {
            // 截图: 插针击穿止损/补仓点位但收盘回归 → 不执行风控
            const spike = this.boll.isSpikeBar(bkl);
            const tp = this.boll.checkTakeProfit(pos, bkl);
            if (tp.action === 'CLOSE' && !spike) closeReason = tp.reason;   // 插针不触发止盈
            else if (!spike) {
              // 前置风控: 单K浮亏≥单笔本金20%全平
              const eq = this.balance;  // 单笔本金近似用可用资金
              const hs = this.boll.checkHardStop(pos, bkl, eq);
              if (hs.stop) closeReason = hs.reason;
              else {
                // 终极风控: 3次补仓完成 + 总浮亏≥70%强制全平
                const totalPnlPct = pos.side==='LONG' ? (price-pos.entryPrice)/pos.entryPrice*100 : (pos.entryPrice-price)/pos.entryPrice*100;
                const fs = this.boll.checkFinalStop(pos, totalPnlPct);
                if (fs.stop) closeReason = fs.reason;
                else {
                  // 补仓: 已有同向持仓走补仓, 收口后3根+未到3次
                  if (pos._addRound < 3) {
                    const preCloseIdx = bkl.length - (pos._lastAddIdxFrom0 || 0);
                    const candd = this.boll.checkAdd(bkl, pos);
                    // 补仓时序: 收口后间隔3根K线(简化: 用K线数量近似, 持续多轮后允许)
                    if (candd.canAdd && pos._lastAddRoundTick != null && (bkl.length - pos._lastAddRoundTick) >= 3) {
                      // 执行补仓(同向加仓) — 真实补仓通过增量下单实现, 这里标记轮次
                      pos._addRound = (pos._addRound || 0) + 1;
                      pos._lastAddRoundTick = bkl.length;
                      this._log(`📈 ${symbol} 布林第${pos._addRound}次补仓(收口后3根)持仓${(candd.pct*100).toFixed(0)}%`);
                    } else if (candd.canAdd && pos._lastAddRoundTick == null) {
                      pos._lastAddRoundTick = bkl.length;
                    }
                  }
                }
              }
            }
          }
        }

        if (pos.strategy === 'trend') {
          // 接管仓(旧trend): 新策略接管, 用MA7大道至简逻辑管理(止损/止盈)
          const mkl = await this.api.getKlines(symbol, '15m', 150).catch(() => null);
          if (mkl && mkl.length >= 40) {
            const mObj = toArray(mkl).map(k => +k[3]);
            const price = mObj[mObj.length - 1];
            const ts = this.trend.takeProfit(pos, price, mObj);
            if (ts.action === 'CLOSE') closeReason = ts.reason;
            else { const sl = this.trend.stopLoss(pos, price, mObj); if (sl.action === 'CLOSE') closeReason = sl.reason; }
          }
        }

        if (closeReason) {
          pnlToCount = this._estimatePnl(pos, price);
          const r = await this.executor.closePosition(symbol, pos.side, pos.qty, pm, closeReason, pnlToCount);
          if (r.success) {
            this._settleServiceFee(symbol, pnlToCount);
            this.closedHistory.unshift({ symbol: symbol.replace('USDT',''), side: pos.side, pnl: pnlToCount, reason: closeReason, ts: Date.now(), strat: pos.strategy });
            // ═══ 大脑中枢自学习：每次平仓喂给神经网络+UCB绩效 ═══
            try {
              const notional = (pos.entryPrice || 0) * (pos.qty || 0);
              const pnlPct = notional > 0 ? (pnlToCount / notional) * 100 : 0;
              this.brain.recordResult(symbol.replace('USDT',''), pos.strategy || 'ma7', pnlPct);
            } catch(e2){}
            this._saveState();  // 平仓后持久化统计
            delete this.positions[symbol];
            delete this._stratLock[symbol];  // 平仓后释放策略锁
          }
        }
      } catch(e){ this._log(`⚠️ ${symbol} 管理异常: ${e.message.slice(0,40)}`); }
    }
  }

  _estimatePnl(pos, price) {
    // 正确合约真实盈亏(近似,不含手续费): 方向价差(USD) × 币数量
    // LONG: (exit-entry)*qty ; SHORT: (entry-exit)*qty
    // 注: 不能除以entry(那会把金额放大几百倍, 出过 -$329超本金的bug)
    const dir = pos.side === 'LONG' ? (price - pos.entryPrice) : (pos.entryPrice - price);
    return dir * (pos.qty || 0);
  }

  // 算力费扣款(普通用户盈利扣30% → 管理员钱包累计)
  _settleServiceFee(symbol, pnlUsd) {
    if (!pnlUsd || pnlUsd <= 0 || this.isAdmin || this.isWhitelist) return;   // 管理员/白名单免算力费
    const platformFee = pnlUsd * PLATFORM_FEE_RATE;
    const ecoFund = pnlUsd * ECO_FUND_RATE;
    const feeTotal = platformFee + ecoFund;
    try {
      const feeFile = path.join(__dirname, '..', 'data', 'quant-fee-state.json');
      let st = {}; try { st = JSON.parse(require('fs').readFileSync(feeFile,'utf8')); } catch(e){ st = { totalPlatform:0, totalEco:0, pending:{} }; }
      st.totalPlatform = (st.totalPlatform||0) + platformFee;
      st.totalEco = (st.totalEco||0) + ecoFund;
      st.pending = st.pending || {}; st.pending[this.wallet] = (st.pending[this.wallet]||0) + feeTotal;
      require('fs').writeFileSync(feeFile, JSON.stringify(st, null, 2));
    } catch(e){}
    // 写回 saas-users.json 的用户算力费余额(gatesFeeBalance), 供普通用户仪表盘显示扣减
    try {
      const userFile = path.join(__dirname, '..', 'data', 'saas-users.json');
      const all = JSON.parse(require('fs').readFileSync(userFile,'utf8'));
      const wl = this.wallet.toLowerCase();
      const key = Object.keys(all).find(k => k.toLowerCase() === wl) || wl;
      if (all[key]) {
        const oldBal = all[key].gatesFeeBalance || 0;
        all[key].gatesFeeBalance = oldBal - feeTotal;
        all[key].gatesFeeLow = (oldBal - feeTotal) < 5;
        require('fs').writeFileSync(userFile, JSON.stringify(all, null, 2));
      }
    } catch(e){}
    this._log(`💰 ${symbol} 扣算力费$${feeTotal.toFixed(2)}(平台${platformFee.toFixed(2)}+生态${ecoFund.toFixed(2)}) → 管理员(普通用户)`);
  }

  getSummary() {
    const t = Math.max(1, this.closedHistory.length);
    const wins = this.closedHistory.filter(c => c.pnl > 0).length;
    // ═══ 三策略独立统计(MA7大道至简 / V4阿奇日线 / 布林震荡) ═══
    const ma7T = this.closedHistory.filter(c => c.strat === 'ma7');
    const v4T  = this.closedHistory.filter(c => c.strat === 'v4');
    const bollT= this.closedHistory.filter(c => c.strat === 'bollinger');
    const stratStat = (arr) => ({
      trades: arr.length,
      wins: arr.filter(c => c.pnl > 0).length,
      losses: arr.filter(c => c.pnl < 0).length,
      realizedPnl: +arr.reduce((a,c) => a + (c.pnl||0), 0).toFixed(2),
      winRate: arr.length ? Math.round(arr.filter(c => c.pnl > 0).length / arr.length * 100) : 0
    });
    return {
      wallet: this.wallet, isAdmin: this.isAdmin, isWhitelist: this.isWhitelist, balance: this.balance,
      totalEquity: +(this.totalWalletBalance || ((this.balance||0)+(this._unrealizedPnl||0))).toFixed(2),  // 总资金 = 币安合约账户总余额
      unrealizedPnl: +((this._unrealizedPnl||0)).toFixed(2),
      positionCount: Object.keys(this.positions).length,
      positions: Object.entries(this.positions).map(([s,p]) => ({ symbol: s, side: p.side, strategy: p.strategy, entryPrice: p.entryPrice, currentPrice: p.currentPrice, leverage: p.leverage })),
      trades: this.closedHistory.length, wins, losses: this.closedHistory.length - wins,
      realizedPnl: this.closedHistory.reduce((a,c) => a + (c.pnl||0), 0),
      // 双策略独立统计 + 每次平仓记录
      strategyPnl: { ma7: stratStat(ma7T), v4: stratStat(v4T), bollinger: stratStat(bollT) },
      closedTrades: this.closedHistory.slice(0, 100),
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
    this.pauseTrend = false;
    this.pauseBoll = false;      // 暂停震荡(布林)开仓
    // ═══ 角色区分 ═══
    // 管理员(唯一): fa3b90c5(0xfA3b90c574469909D20848273C06752a22fdE74a)
    this.ADMIN_WALLETS = ['0xfA3b90c574469909D20848273C06752a22fdE74a'];
    // 白名单(免算力费, 非管理员): e6ddf077/41c89c7d/c6dbb4cd等
    this.WHITELIST_WALLETS = ['0xe6ddf0771c7610dba77eb5a07ba7771dd7f5e91e','0x41c89c7df1ad4c8dd251c5afe45aa1c791fb6ea5','0xc6dbb4cd3b6a12068c7388248da2bd32df7ef9b7'];
    this.ALL_WALLETS = [...this.ADMIN_WALLETS, ...this.WHITELIST_WALLETS];
    // ═══ 交易池(分开配置) ═══
    // 震荡行情交易池(专门给 布林带震荡策略引擎 调用) — 布林回测精选优质币
    // WIF/FIL/ETH/APT/TURBO/STX 等(触轨低买高卖胜率高)
    // 震荡行情交易池(布林带引擎) — 修复NaN bug后最优回测精选(交易≥3+胜率100%)
    this.BOLLINGER_POOL = ['LINKUSDT','ORDIUSDT','SOLUSDT','OPUSDT','NEARUSDT','TONUSDT','SUIUSDT','AVAXUSDT','INJUSDT','LTCUSDT'];   // 活跃波动币, 提高布林触轨开仓机会
    // 趋势行情交易池(给趋势策略引擎调用) — 30天趋势回测精选
    // 正期望: LINK/FIL(TIA/ADA等趋势弱负期望不纳入)
    // 趋势行情交易池(给趋势引擎调用) — v6摆动结构90天回测精选(胜率≥50%+正回报)
    // 趋势池(v7大道至简MA7·30天回测正期望精选): AVAX+5%/KAS+2.9%/TIA+1.5%/ADA+0.5%/BTC+0.4%
    this.TREND_POOL = ['AVAXUSDT','KASUSDT','TIAUSDT','ADAUSDT','BTCUSDT'];
    this.MA7_POOL = this.TREND_POOL;   // MA7趋势池(15m大道至简)
    this.V4_POOL = this.TREND_POOL;    // V4趋势池(日线阿奇)
    // 合并扫描池
    this.COIN_POOL = [...new Set([...this.BOLLINGER_POOL, ...this.TREND_POOL])];
  }
  _log(m) { const ts = new Date().toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}); console.log(`[Quant] ${ts} ${m}`); }
  _isAdmin(w) { return this.ADMIN_WALLETS.some(a => a.toLowerCase() === (w||'').toLowerCase()); }
  _isWhitelist(w) { return this.WHITELIST_WALLETS.some(a => a.toLowerCase() === (w||'').toLowerCase()); }

  start() {
    if (this.running) return; this.running = true;
    this._log('🚀 新量化智能体管理器启动(市场分类+趋势/震荡双策略)');
    // ═══ 动态选币: 启动刷新一次 + 根据主流大盘(BTC)行情不定时自动重选 ═══
    this._refreshDynamicPool().catch(()=>{});
    this._lastPoolBTC = null;
    this._poolTimer = setInterval(() => this._checkBTCAndRefresh().catch(()=>{}), 15*60*1000);  // 每15分钟检测大盘, 变化才重选(不固定时间)
    this._loop();
  }

  // ═══ 根据主流大盘(BTC)行情不定时触发重选币 ═══
  // 当BTC日线趋势方向(UP/DOWN/FLAT)或波动发生变化时, 重新动态选币
  async _checkBTCAndRefresh() {
    try {
      const apiInst = new BinanceAPI(this.adminApiKey, this.adminApiSecret);
      const bkl = await apiInst.getKlines('BTCUSDT', '1d', 60).catch(() => null);
      if (!bkl || bkl.length < 40) return;
      const closes = bkl.map(k => +k.close);
      // BTC日线方向(近20日趋势方向)
      const seg = closes.slice(-20); let upN = 0; for (let i = 1; i < seg.length; i++) if (seg[i] > seg[i-1]) upN++;
      const ratio = upN / (seg.length - 1);
      const dir = ratio > 0.62 ? 'UP' : (ratio < 0.38 ? 'DOWN' : 'FLAT');
      const range = (Math.max(...seg) - Math.min(...seg)) / (Math.min(...seg) || 1);
      const state = dir + ':' + (range > 0.05 ? 'WIDE' : 'NARROW');
      // 大盘状态首次 或 与上次不同 → 重新选币(跟随时大盘变化)
      if (this._lastPoolBTC !== state) {
        this._log(`🧠 主流大盘BTC状态变化(${this._lastPoolBTC||'初'}→${state}), 触发重新选币`);
        this._lastPoolBTC = state;
        await this._refreshDynamicPool();
      } else {
        this._log(`🧠 大盘BTC状态不变(${state}), 暂不重选`);
      }
    } catch(e) { /* 忽略 */ }
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
          const isWhitelist = this._isWhitelist(wallet);
          let apiKey, apiSecret;
          // 优先级: 用户有自己的key → 用独立key; 无key的管理员(fa3b90c5)用公用key
          if (u.binanceApiKey && u.binanceSecret) {
            apiKey = decrypt(u.binanceApiKey); apiSecret = decrypt(u.binanceSecret);
            if (!apiKey || apiKey.length !== 64) { if (!isAdmin && !isWhitelist) continue; apiKey=this.adminApiKey; apiSecret=this.adminApiSecret; }
          } else {
            if (!isAdmin && !isWhitelist) continue;
            if (isAdmin) { apiKey = this.adminApiKey; apiSecret = this.adminApiSecret; }
            else continue;  // 白名单无key不交易但保留
          }
          this._agents[wallet] = new QuantAgent({ wallet, apiKey, apiSecret, isAdmin, isWhitelist, userDB: this.userDB, pauseOpen: this.pauseOpen });
          const role = isAdmin ? '管理员' : (isWhitelist ? '白名单' : '普通');
          this._log(`${wallet.slice(0,10)} 智能体启动(${role})`);
        }
      }
      // 全部用户(普通+管理员/白名单)开放开仓
      const agents = Object.values(this._agents);
      for (const a of agents) { a.pauseOpen = !!this.pauseOpen; a.pauseTrend = !!this.pauseTrend; a.pauseBoll = !!this.pauseBoll; 
        // ═══ 同步manager的池给agent(MA7/V4/布林各自独立池) ═══
        a.MA7_POOL = this.MA7_POOL; a.V4_POOL = this.V4_POOL; a.BOLLINGER_POOL = this.BOLLINGER_POOL; a.TREND_POOL = this.TREND_POOL; }
      await Promise.all(agents.map(a => a.scan(this.COIN_POOL).catch(() => {})));
      this._log(`[循环] ${agents.length}个智能体 · 持仓${agents.reduce((s,a)=>s+Object.keys(a.positions).length,0)}`);
    } catch(e) { this._log(`❌ 循环异常: ${e.message}`); }

    if (this.running) this._timer = setTimeout(() => this._loop(), this.intervalMs);
  }

  setPauseOpen(v) { this.pauseOpen = !!v; for (const a of Object.values(this._agents)) a.pauseOpen = this.pauseOpen; }
  setPauseTrend(v) { for (const a of Object.values(this._agents)) a.pauseTrend = !!v; }

  // 分页拉K线(突破limit1500)
  async _pagKlines(api, sym, interval, count) {
    const out = []; const ms = { '5m':300000, '1h':3600000 }[interval] || 300000;
    let start = Date.now() - count * ms;
    while (out.length < count) {
      const kl = await api.getKlines(sym, interval, 1500).catch(() => null);
      if (!Array.isArray(kl) || !kl.length) break;
      out.push(...kl);
      // 用最后一根时间推进
      const lastT = kl[kl.length-1].time || kl[kl.length-1].openTime;
      const curMs = Date.now();
      if (lastT) start = lastT + ms; else break;
      if (kl.length < 1500) break;
    }
    return out;
  }

  // ═══ 大脑中枢·动态选币: 按当前市场+历史回测刷新趋势池/震荡池 ═══
  // 定时(默认6h)对候选币分别用趋势/布林策略回测, 选出最佳进对应池
  async _refreshDynamicPool() {
    try {
      this._log('🧠 动态选币开始...');
      const apiInst = new BinanceAPI(this.adminApiKey, this.adminApiSecret);
      const CANDIDATES = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','LTCUSDT','DOTUSDT','UNIUSDT','APEUSDT','FILUSDT','NEARUSDT','ATOMUSDT','INJUSDT','OPUSDT','ARBUSDT','SUIUSDT','TIAUSDT','SEIUSDT','STXUSDT','KASUSDT','APTUSDT','WLDUSDT','ORDIUSDT','1000PEPEUSDT','JUPUSDT','PENDLEUSDT'];
      const trendPool=[], bollPool=[], trendV4Pool=[];
      for (const sym of CANDIDATES) {
        // 选币用5分钟级K线(近5天≈1440根, 加快选币; 震荡评估足够)
        const kl = await this._fetchKlinesM(sym, '5m', 1440, apiInst).catch(()=>null);
        if (!kl || kl.length < 900) continue;
        const basis = this._assessTrend(kl);              // 基础趋势强度分(保证所有币能排序)
        const tr = this._btTrend(kl);                     // 严格MA7真实回测收益
        // ═══ 核心: 真实回测亏损(ret<0)的币剔除(用户要求), 无样本(n<=0)用基础分, 正收益优先 ═══
        if (tr && tr.n > 0) {
          if (tr.ret > 0) trendPool.push({sym, ret: basis.ret + tr.ret, trRet: tr.ret});  // 真实盈利 → 基础分+奖励
          // 真实亏损(tr.ret<0) → 剔除, 不进趋势池
        } else {
          trendPool.push({sym, ret: basis.ret * 0.5, trRet: 0});   // 无回测样本(严格策略没成交) → 基础分减半排序, 不占奖励
        }
        // ═══ V4阿奇日线趋势评估(独立趋势精选): 日线回测盈利 + 当前正走单边趋势才入选 ═══
        const kld = await apiInst.getKlines(sym, '1d', 200).catch(()=>null);
        if (kld && kld.length >= 80) {
          const v4 = this._btTrendV4Daily(kld);
          // 当前趋势检测: 最近K线V4信号非'横盘/FLAT'(当前正在走单边), 确保选出的币现在可交易
          const nowObj = toArray(kld).map(k => ({ open: k[1], high: k[2], low: k[3], close: k[4], volume: k[5] }));
          const curSig = this._trendV4Now(kld);   // 'UP'有上行趋势/'DOWN'下行/'FLAT'横盘
          if (v4 && v4.n > 0 && v4.ret > 0 && curSig !== 'FLAT') trendV4Pool.push({sym, ret: v4.ret, n: v4.n, rate: v4.rate, cur: curSig});
        }
        const bo = this._btBoll(kl);   // 用最新截图版振荡(BollingerStrategy)真实回测
        if (bo && bo.n > 0 && bo.ret > 0) bollPool.push({sym, ret: bo.ret, boRet: bo.ret});   // 优胜劣汰: 回测盈利才进震荡池, 亏损剔除
      }
      trendV4Pool.sort((a,b)=> b.ret - a.ret);
      this.TREND_V4_POOL = trendV4Pool.slice(0,25).map(x=>x.sym);   // V4日线趋势精选池(独立,25)
      this._log(`🧠 V4日线趋势精选池: ${this.TREND_V4_POOL.join(',')}`);
      trendPool.sort((a,b)=> b.ret - a.ret);
      bollPool.sort((a,b)=> b.ret - a.ret);
      const trendC = trendPool.slice(0,25);      // MA7候选(仅回测盈利)
      const bollC = bollPool.slice(0,25);        // 震荡候选
      // ═══ 分开选池: MA7趋势池(15m) 和 V4趋势池(日线) 各自独立 ═══
      const ma7Sym = trendC.map(x=>x.sym);       // MA7池 = 15m回测盈利币
      const v4Sym  = (this.TREND_V4_POOL && this.TREND_V4_POOL.length) ? this.TREND_V4_POOL : [];   // V4池 = 日线回测盈利币
      const newMA7 = ma7Sym.slice(0,25);
      const newV4  = v4Sym.slice(0,25);
      // 震荡池: 从布林盈利候选剔除进入任一趋势池的币(共同合)
      const allTrend = new Set([...newMA7, ...newV4]);
      const bollAll = bollPool.slice(0,50).filter(x=>!allTrend.has(x.sym)).map(x=>x.sym);
      const newBoll = bollAll.slice(0,25);
      // 只要选出新版就更新池
      if (newMA7.length>=1 && newV4.length>=1 && newBoll.length>=1) {
        this.MA7_POOL = newMA7;
        this.V4_POOL = newV4;
        this.TREND_POOL = [...new Set([...newMA7, ...newV4])];   // 趋势总池(兼容)
        this.BOLLINGER_POOL = newBoll;
        this.COIN_POOL = [...new Set([...newMA7, ...newV4, ...newBoll])];
        // 排名靠前子集(开仓限): 各前5只(按回测性能), 池内排名靠后才开仓
        this.trendTop = [...new Set([...newMA7, ...newV4])].slice(0,5);
        this.bollTop = newBoll.slice(0,5);
        this._log(`🧠 动态选币 → MA7池${newMA7.length}只: ${newMA7.join(',')} | V4池${newV4.length}只: ${newV4.join(',')} | 震荡池${newBoll.length}只(≤20): ${newBoll.join(',')}`);
        this._log(`🟢 开仓限 → MA7/V4 Top: ${this.trendTop.join(',')} | 震荡Top: ${this.bollTop.join(',')}`);
      }
    } catch(e){ this._log(`⚠️ 动态选币失败: ${e.message.slice(0,30)}`); }
  }
  // 趋势适配评估(用1h近30天): ADX高+有方向性 = 适合趋势策略
  // ═══ 动态选币: 分批拉取指定隔离数5m K线(绕过单次limit1500限制) ═══
  async _fetchKlinesM(symbol, interval, target, apiInst) {
    const out = [];
    let endTime = Date.now();
    while (out.length < target) {
      const q = `/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=1000&endTime=${endTime}`;
      const batch = await apiInst._get(q).catch(() => null);
      if (!batch || !batch.length) break;
      const mapped = batch.map(k => ({ time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) }));
      const newOnes = mapped.filter(k => k.time < endTime);
      if (!newOnes.length) break;
      out.unshift(...newOnes.reverse());
      endTime = newOnes[0].time - 1;
      if (batch.length < 1000) break;
    }
    return out;
  }

  _assessTrend(kl){
    try{
      const c=kl.map(k=>+k.close); if(c.length<40)return {ret:-99,n:0,rate:0};
      let adxCnt=0, upCnt=0, dnCnt=0;
      const seg=c.slice(-60);
      const emaS=seg.slice(-7).reduce((a,b)=>a+b,0)/7, emaS2=seg.slice(-30).reduce((a,b)=>a+b,0)/30;
      const spread=Math.abs(emaS-emaS2)/(emaS2||1);
      // 用价格方向性: 近60根涨幅
      const chg=(c[c.length-1]-c[c.length-61])/(c[c.length-61]||1)*100;
      const dir=Math.abs(chg);
      return {ret: dir>10?dir*0.5:(dir>5?dir*0.3:dir*0.1), n: 1, rate: dir>8?100:(dir>5?60:40)};
    }catch(e){return {ret:-99,n:0,rate:0};}
  }
  // 震荡适配评估(用1h近30天): 波动小+区间稳定 = 适合布林震荡
  _assessBoll(kl){
    try{
      const c=kl.map(k=>+k.close); if(c.length<40)return {ret:-99,n:0,rate:0};
      const seg=c.slice(-60);
      const mx=Math.max(...seg),mn=Math.min(...seg);
      const rangePct=(mx-mn)/(mn||1)*100;
      // 震荡: 箱体稳定, 波动小
      return {ret: rangePct<20?30:(rangePct<35?15:5), n:1, rate: rangePct<25?80:(rangePct<40?65:45)};
    }catch(e){return {ret:-99,n:0,rate:0};}
  }
  // (保留原回测方法名兼容, 但用新评估)
  _btTrend(kl){
    try{
      const t=new TrendStrategy(); const c=kl.map(k=>+k.close); // 纯MA7趋势策略(与实盘一致)
      let pos=null,ret=0,n=0,w=0;
      const rel=kl.map(k=>({open:k.open,high:k.high,low:k.low,close:+k.close,volume:k.volume}));
      const arr=rel;
      for(let i=300;i<c.length;i++){
        const price=+arr[i].close,win=arr.slice(0,i+1),cl=win.map(x=>+x.close);
        if(pos){
          const lev=pos.side==='LONG'?5:3;
          const tp=t.takeProfit(pos,price,cl); let cr=null;
          if(tp.action==='CLOSE')cr='tp'; else{const s2=t.stopLoss(pos,price,cl);if(s2.action==='CLOSE')cr='sl';}
          if(cr){const raw=pos.side==='LONG'?(price-pos.entry)/pos.entry*100:(pos.entry-price)/pos.entry*100;const cp=raw*lev*0.15-0.001*0.15*200;ret+=cp;n++;if(cp>0)w++;pos=null;}
        } else { const sig=t.entrySignal(win,'FLAT'); if(sig.signal==='LONG'||sig.signal==='SHORT')pos={side:sig.signal,entry:price}; }
      }
      // 无真实回测成交(n=0): 不值得入选趋势池(可能是横盘/极端波动, 避免靠虚高得分塞币)
      if (n === 0) return { ret: -1, n: 0, rate: 0 };
      return {ret,n,rate:n?Math.round(w/n*100):0};
    }catch(e){return {ret:-99,n:0,rate:0};}
  }
  // 布林回测(1h近30天, 简化)
  _btBoll(kl){
    try{
      const b=new BollingerStrategy(); const arr=kl.map(k=>({open:k.open,high:k.high,low:k.low,close:+k.close,volume:k.volume}));
      const c=arr.map(x=>+x.close);
      let pos=null,ret=0,n=0,w=0;
      for(let i=60;i<c.length;i++){
        const price=+arr[i].close,win=arr.slice(0,i+1);
        const prev=c[i-1]; if(prev>0&&Math.abs(price-prev)/prev>0.03){continue;}
        if(pos){
          const tp=b.checkTakeProfit(pos,win); let cr=null;
          if(tp.action==='CLOSE')cr='tp'; else{const hs=b.checkHardStop(pos,win,0);if(hs.stop)cr='sl';}
          if(cr){const raw=pos.side==='LONG'?(price-pos.entry)/pos.entry*100:(pos.entry-price)/pos.entry*100;const cp=raw*3*0.15-0.001*0.15*200;ret+=cp;n++;if(cp>0)w++;pos=null;}
        } else { const g=b.canOpen(win); if(g.allowed){const es=b.entrySignal(win,'FLAT',false);if(es.signal==='LONG'||es.signal==='SHORT')pos={side:es.signal,entry:price};} }
      }
      return {ret,n,rate:n?Math.round(w/n*100):0};
    }catch(e){return {ret:-99,n:0,rate:0};}
  }

  // ═══ V4 阿奇日线大周期趋势回测(用于日线趋势精选池选币) ═══
  // 日线K线: 横盘不做/收盘站稳突破/回踩/逻辑止损/盈利让跑
  _btTrendV4Daily(kl){
    try{
      const t=new TrendStrategyV4({ minBars:60 }); const arr=kl.map(k=>({open:k.open,high:k.high,low:k.low,close:+k.close,volume:k.volume}));
      const c=arr.map(x=>+x.close);
      let pos=null,ret=0,n=0,w=0;
      for(let i=80;i<c.length;i++){
        const price=+arr[i].close,win=arr.slice(0,i+1);
        if(pos){
          let cr=null;
          const sl=t.stopLoss(pos,win); if(sl.action==='CLOSE')cr='sl';
          if(!cr){const tp=t.takeProfit(pos,win); if(tp.action==='CLOSE')cr='tp';}
          if(cr){const raw=pos.side==='LONG'?(price-pos.entry)/pos.entry*100:(pos.entry-price)/pos.entry*100; const cp=raw*5*0.15-0.001*0.15*200; ret+=cp;n++; if(cp>0)w++; pos=null;}
        } else { const sig=t.entrySignal(win); if(sig.signal==='LONG'||sig.signal==='SHORT')pos={side:sig.signal,entry:price,supportLevel:sig.supportLevel,resistanceLevel:sig.resistanceLevel}; }
      }
      return {ret,n,rate:n?Math.round(w/n*100):0};
    }catch(e){return {ret:-99,n:0,rate:0};}
  }

  // ═══ 当前趋势检测: 近N根日线是否正走单边趋势(UP/DOWN) 还是横盘(FLAT) ═══
  _trendV4Now(kl) {
    try {
      const c = kl.slice(-45).map(k => +k.close);
      if (c.length < 40) return 'FLAT';
      const ups = c.slice(-30).filter((_, i) => i > 0 && c.slice(-30)[i] > c.slice(-30)[i-1]).length;
      const ratio = ups / 29;   // 近30日上涨占比
      const seg = c.slice(-20);
      const amp = (Math.max(...seg) - Math.min(...seg)) / (Math.min(...seg) || 1);
      // 方向性(放宽: 占比>55%上 或 <45%下) + 振幅足(>5%) = 有趋势方向可入V4池
      if (ratio > 0.55 && amp > 0.05) return 'UP';
      if (ratio < 0.45 && amp > 0.05) return 'DOWN';
      return 'FLAT';
    } catch(e) { return 'FLAT'; }
  }

  getAllStatus() { return Object.values(this._agents).map(a => a.getSummary()); }
}

module.exports = { QuantAgentManager, QuantAgent };
