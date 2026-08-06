/**
 * 独立一分钟级量化引擎 — 布林高抛低吸 (NEW BOLL %B)
 * 完全独立于大道至简A策略, 不共享持仓/状态, 互不干扰
 *
 * 核心(1分钟K线):
 *   波动曲线 = 布林%B = (价格 - 窗口SMA) / 窗口STD   → 值≈±2
 *   下轨 = 窗口标准差×(-T), 上轨 = 窗口标准差×(+T)   (T默认1.0, %B值)
 *   波动曲线上穿下轨 → 买入(正T低买)
 *   波动曲线下穿上轨 → 平多/卖出(反T高卖)
 *
 * 资金/杠杆自动配备; 普通用户自动扣算力费; 独立状态/持仓
 */
const fs = require('fs');
const path = require('path');
const { BinanceAPI } = require('./common');

const FEE_RATE = 0.001;   // 手续费0.1%每边

class BBScalpEngine {
  constructor(apiKey, apiSecret, opts = {}) {
    this.api = new BinanceAPI(apiKey, apiSecret);
    this.wallet = opts.wallet || 'admin';
    this.isAdmin = !!opts.isAdmin;
    this.realTrading = !!opts.realTrading;
    this.balance = opts.balance || 0;
    this.userDB = opts.userDB || null;
    this.running = false;
    this._pauseOpen = !!opts.pauseOpen;
    this.positions = {};
    this._trades = 0; this._wins = 0; this._losses = 0; this._realizedPnl = 0;
    this.scanMs = opts.scanMs || 15000;          // 扫盘间隔(1分钟级, 15s看新K线)
    this.N = opts.bbN || 20;                       // 布林周期(1分钟K线x20)
    this.T = opts.bbT || 1.0;                      // 轨道阈值(%B值, 截图下轨≈-1上轨≈+1)
    this.maxPositions = opts.maxPositions || 5;    // 最多5仓
    this.longLev = opts.longLev || 3;              // 布林高抛低吸用低杠杆(1分钟级)
    this.shortLev = opts.shortLev || 3;
    this.marginPct = opts.marginPct || 0.10;       // 每仓10%资金
    this._stateFile = opts.stateFile || path.join(__dirname, '..', 'data', `bb-scalp-${(this.wallet||'x').toLowerCase().slice(0,10)}.json`);
    this._load();
  }

  _log(m){ console.log(`[BB-Scalp ${(this.wallet||'').slice(0,8)}] ${new Date().toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'})} ${m}`); }

  // 拉1分钟K线
  async _get1m(symbol, limit) {
    const kl = await Promise.race([
      this.api.getKlines(symbol, '1m', limit || 60),
      new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')), 10000))
    ]).catch(()=>null);
    return kl;
  }

  // 布林%B 和 轨道(动态%价格)
  _computeBB(closes) {
    if (closes.length < this.N + 1) return null;
    const seg = closes.slice(-this.N);
    const mid = seg.reduce((a,b)=>a+b,0)/this.N;
    const sd = Math.sqrt(seg.reduce((a,v)=>a+(v-mid)*(v-mid),0)/this.N) || 0.000001;
    const prev = closes[closes.length-2], cur = closes[closes.length-1];
    const bb = (cur - mid) / sd;          // %B
    const prevBB = (prev - mid) / sd;
    return { mid, sd, bb, prevBB, upper: this.T, lower: -this.T };
  }

  _calcPnlUsdPos(pos, price) {
    if (pos.side === 'LONG') return (price - pos.entryPrice) * pos.qty;
    return (pos.entryPrice - price) * pos.qty;
  }

  // 核心循环: 扫描固定币池, 算信号, 买卖
  async _cycle() {
    const pool = (this.coinPool || ['HFTUSDT','VICUSDT','COTIUSDT','BICOUSDT','PTBUSDT','BLESSUSDT','1000RATSUSDT','DOGEUSDT','SUIUSDT','AVAXUSDT']).slice(0, this.maxPositions);
    for (const symbol of pool) {
      try {
        const kl = await this._get1m(symbol, 60);
        if (!kl || kl.length < this.N + 2) continue;
        const c = kl.map(k=>k.close);
        const bb = this._computeBB(c);
        if (!bb) continue;
        const price = kl[kl.length-1].close;
        const hasPos = !!this.positions[symbol];

        // 已有持仓 → 平仓判断
        if (hasPos) {
          const pos = this.positions[symbol];
          // 平多: 波动下穿上轨(高抛)
          if (pos.side === 'LONG' && bb.prevBB >= bb.upper && bb.bb < bb.upper) {
            const usd = this._calcPnlUsdPos(pos, price);
            const feePct = FEE_RATE * 100 * 2;
            const pnlPct = (pos.side==='LONG'?(price-pos.entryPrice)/pos.entryPrice:(pos.entryPrice-price)/pos.entryPrice)*pos.lev*100;
            const netPnl = usd; // 简化
            await this._closePos(symbol, `波动下穿上轨平多高抛(%B ${bb.bb.toFixed(2)},PnL${pnlPct.toFixed(1)}%)`);
            continue;
          }
          // 平空: 波动上穿下轨(低买/止盈)
          if (pos.side === 'SHORT' && bb.prevBB <= bb.lower && bb.bb > bb.lower) {
            await this._closePos(symbol, `波动上穿下轨平空低买(%B ${bb.bb.toFixed(2)})`);
            continue;
          }
          // 更新持仓价
          pos.currentPrice = price;
        } else {
          // 无持仓 → 开仓判断 + 仓位上限
          if (Object.keys(this.positions).length >= this.maxPositions) break;
          if (this._pauseOpen) break;
          // 买入: 波动上穿下轨(正T低买) → 做多
          if (bb.prevBB <= bb.lower && bb.bb > bb.lower) {
            await this._openPos(symbol, 'LONG', price, '波动上穿下轨买入(%B '+bb.bb.toFixed(2)+')');
            continue;
          }
          // 做空: 波动下穿上轨(反T高卖) → 做空
          if (bb.prevBB >= bb.upper && bb.bb < bb.upper) {
            await this._openPos(symbol, 'SHORT', price, '波动下穿上轨做空(%B '+bb.bb.toFixed(2)+')');
            continue;
          }
        }
      } catch(e) { /* 单币异常跳过 */ }
    }
    this._save();
  }

  // 开仓
  async _openPos(symbol, side, price, reason) {
    const lev = side === 'LONG' ? this.longLev : this.shortLev;
    let margin = Math.max((this.balance||0)*this.marginPct, 3);
    let notional = margin * lev;
    if (notional < 20) { notional = 20; margin = 20 / lev; }
    const qty = notional / price;
    if (this.realTrading) {
      try {
        let r = side==='LONG' ? await this.api.marketLong(symbol, qty, lev) : await this.api.marketShort(symbol, qty, lev);
        if (!r.success) { this._log(`⚠️ ${symbol} 开仓失败: ${r.error}`); return; }
      } catch(e) { this._log(`⚠️ ${symbol} 开仓异常: ${e.message.slice(0,30)}`); return; }
    }
    this.positions[symbol] = { symbol, side, qty, entryPrice: price, currentPrice: price, margin, leverage: lev, openTime: Date.now() };
    this._log(`🟢 ${symbol} ${side} 开仓(${reason}) qty=${qty.toFixed(4)} lev=${lev}x`);
    this._save();
  }

  // 平仓
  async _closePos(symbol, reason) {
    const pos = this.positions[symbol];
    if (!pos) return;
    if (this.realTrading) {
      try {
        if (pos.side === 'LONG') await this.api.closeLong(symbol, pos.qty);
        else await this.api.closeShort(symbol, pos.qty);
      } catch(e) { this._log(`⚠️ ${symbol} 平仓异常: ${e.message.slice(0,30)}`); }
    }
    const price = pos.currentPrice || pos.entryPrice;
    const pnlUsd = this._calcPnlUsdPos(pos, price);
    const pnlPct = (pos.side==='LONG'?(price-pos.entryPrice)/pos.entryPrice:(pos.entryPrice-price)/pos.entryPrice)*pos.lev*100;
    // 算力费(普通用户盈利扣30%)
    let feeCharge = 0;
    if (pnlUsd > 0 && this.realTrading && !this.isAdmin) feeCharge = pnlUsd * 0.30;
    const netPnl = pnlUsd - feeCharge;
    this.balance += netPnl;
    this._trades++; if (netPnl > 0) this._wins++; else this._losses++;
    this._realizedPnl += netPnl;
    delete this.positions[symbol];
    this._log(`🔴 ${symbol} 平仓(${reason}) PnL$${netPnl.toFixed(2)}(${pnlPct.toFixed(1)}%)`);
    this._save();
  }

  start() { if(this.running)return; this.running=true; this._log('🚀 布林高抛低吸引擎启动'); this._loop(); }
  async _loop(){ if(!this.running)return; try{await this._cycle();}catch(e){this._log('⚠️ '+e.message.slice(0,40));} this._timer=setTimeout(()=>this._loop(), this.scanMs); }
  stop(){ this.running=false; if(this._timer)clearTimeout(this._timer); this._log('🛑 停止'); }

  _load(){ try{ if(fs.existsSync(this._stateFile)){ const d=JSON.parse(fs.readFileSync(this._stateFile,'utf8')); this.balance=d.balance||this.balance; this.positions=d.positions||{}; this._trades=d.trades||0; this._wins=d.wins||0; this._losses=d.losses||0; this._realizedPnl=d.realizedPnl||0; } }catch(e){} }
  _save(){ try{ fs.writeFileSync(this._stateFile, JSON.stringify({balance:this.balance, positions:this.positions, trades:this._trades, wins:this._wins, losses:this._losses, realizedPnl:this._realizedPnl},null,2)); }catch(e){} }

  getSummary(){ return { wallet:this.wallet, isAdmin:this.isAdmin, balance:+this.balance.toFixed(2), positionCount:Object.keys(this.positions).length, trades:this._trades, wins:this._wins, losses:this._losses, realizedPnl:+this._realizedPnl.toFixed(2), positions: this.positions }; }
}

module.exports = { BBScalpEngine };
