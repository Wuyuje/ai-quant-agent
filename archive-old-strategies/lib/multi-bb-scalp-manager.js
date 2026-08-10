/**
 * 独立一分钟级布林高抛低吸管理器
 * 与大道至简A策略(5分钟)完全独立并行, 不共享持仓/状态, 互不干扰
 * 复用 saas-users.json 解密加载用户, 为每个用户启动 BBScalpEngine
 * 普通用户盈利自动扣算力费(引擎内实现)
 */
const fs = require('fs');
const path = require('path');
const { decrypt } = require('../core/crypto-utils');
const { BBScalpEngine } = require('./bb-scalp-engine');

class MultiBBScalpManager {
  constructor(opts = {}) {
    this.adminApiKey = opts.apiKey || process.env.BINANCE_API_KEY || '';
    this.adminApiSecret = opts.apiSecret || process.env.BINANCE_API_SECRET || '';
    this.userDB = opts.userDB || null;
    this.running = false;
    this._engines = {};            // wallet → BBScalpEngine
    this.intervalMs = opts.intervalMs || 30000;
    this.pauseOpen = !!opts.pauseOpen;
    this.ADMIN_WALLETS = [
      '0xfa3b90c574469909d20848273c06752a22fde74a',
      '0xe6ddf0771c7610dba77eb5a07ba7771dd7f5e91e',
      '0x41c89c7df1ad4c8dd251c5afe45aa1c791fb6ea5',
      '0xc6dbb4cd3b6a12068c7388248da2bd32df7ef9b7',
    ];
  }

  _log(m){ console.log(`[BB-ScalpMgr] ${new Date().toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'})} ${m}`); }

  start() {
    if (this.running) return;
    this.running = true;
    this._log('🚀 布林高抛低吸管理器启动');
    this._loop();
  }
  stop() {
    this.running = false;
    if (this._timer) clearTimeout(this._timer);
    for (const e of Object.values(this._engines)) e.stop();
    this._log('🛑 布林高抛低吸管理器停止');
  }
  async _loop(){
    if(!this.running)return;
    try{ await this._cycle(); }catch(e){ this._log('⚠️ '+e.message.slice(0,40)); }
    this._timer=setTimeout(()=>this._loop(), this.intervalMs);
  }

  async _cycle() {
    // 读用户
    let users = {};
    try {
      const f = path.join(__dirname,'..','data','saas-users.json');
      if (fs.existsSync(f)) users = JSON.parse(fs.readFileSync(f,'utf8'));
    } catch(e){}
    const active = [];
    for (const [wallet,u] of Object.entries(users)) {
      if (!u || !u.binanceApiKey || !u.binanceSecret) continue;
      const isAdmin = this.ADMIN_WALLETS.includes(wallet.toLowerCase());
      // 管理员用统一key
      active.push({ wallet: isAdmin? wallet : wallet, apiKey: isAdmin? this.adminApiKey : decrypt(u.binanceApiKey), apiSecret: isAdmin? this.adminApiSecret : decrypt(u.binanceSecret), isAdmin });
    }
    // 每个用户一个布林引擎(与大道至简A策略独立并行)
    for (const u of active) {
      const w = u.wallet.toLowerCase();
      if (!this._engines[w]) {
        let initBal = 0;
        try { const bal = await (new (require('./common').BinanceAPI)(u.apiKey,u.apiSecret)).getBalance(); if(typeof bal==='number'&&bal>0) initBal=bal; } catch(e){}
        const eng = new BBScalpEngine(u.apiKey, u.apiSecret, {
          wallet: u.wallet, isAdmin: u.isAdmin, realTrading: true, pauseOpen: true,   // 所有用户布林引擎停止开仓
          userDB: this.userDB, maxPositions: 5, balance: initBal,
        });
        this._engines[w] = eng;
        eng.start();
        this._log(`${u.wallet.slice(0,10)} 布林高抛低吸引擎启动(${u.isAdmin?'管理员':'普通'})`);
      } else {
        this._engines[w]._pauseOpen = true;  // 所有用户布林引擎停止开仓
      }
    }
  }

  getAllUsersStatus() {
    return Object.values(this._engines).map(e => e.getSummary());
  }
}

module.exports = { MultiBBScalpManager };
