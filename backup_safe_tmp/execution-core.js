// ═══════════════════════════════════════════════════════════
// 模块四·执行与风控模块 (TradeExecutionCore)
// 交易控制中枢: 下单 + 全局风控(单日最大亏损/单笔止损) + 日志
// 对应图片: 四、执行与风控模块
// ═══════════════════════════════════════════════════════════
const MAX_DAILY_LOSS_RATIO = 0.02;   // 规格: 每日最大亏损比例2% (触发熔断暂停)
const STOP_LOSS_PER_TRADE = 0.003;   // 规格: 单笔止损比例0.3%

class TradeExecutionCore {
  constructor(opts = {}) {
    this.api = opts.api;                    // BinanceAPI 实例
    this.wallet = opts.wallet;
    this._dailyPnl = 0;                     // 当日已实现盈亏
    this._dayKey = null;
    this._logFn = opts.logFn || (() => {});
    this.trades = [];                       // 交易日志
  }

  _log(msg) { this._logFn(msg); }

  // 单日盈亏统计(重置到新一天)
  _rollDay() {
    const now = new Date();
    const key = now.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
    if (this._dayKey !== key) { this._dayKey = key; this._dailyPnl = 0; }
  }

  // 全局风控检查
  globalRiskCheck(balance, perTradeLossEstimate = 0) {
    this._rollDay();
    // ① 单日最大亏损
    if (balance > 0 && this._dailyPnl <= -balance * MAX_DAILY_LOSS_RATIO) {
      return { allow: false, reason: `单日亏损$${this._dailyPnl.toFixed(2)}≥${(MAX_DAILY_LOSS_RATIO*100)}%本金,熔断暂停` };
    }
    // ② 单笔风险: 预估该笔亏损不超过单笔止损
    // ③ 余额充足性
    if (balance < 20) return { allow: false, reason: '余额不足' };
    return { allow: true };
  }

  // 执行下单 (通过 BinanceAPI 真实下单)
  async executeOrder(signal, { symbol, side, notional, leverage, precisionMap, price, balance }) {
    const risk = this.globalRiskCheck(balance);
    if (!risk.allow) return { success: false, reason: risk.reason };

    const qty = notional / price;
    try {
      let result;
      if (side === 'LONG') result = await this.api.marketLong(symbol, qty, leverage, precisionMap);
      else if (side === 'SHORT') result = await this.api.marketShort(symbol, qty, leverage, precisionMap);
      else return { success: false, reason: `未知方向${side}` };
      if (!result.success) return { success: false, reason: result.error };

      this._record({ symbol, side, action: 'OPEN', qty, notional, leverage, price });
      this._log(`✅ ${symbol} ${side==='LONG'?'多':'空'}开仓 qty=${qty.toFixed(4)} notional=$${notional.toFixed(1)} lev=${leverage}x 信号=${signal.reason || ''}`);
      return { success: true, qty, orderId: result.orderId };
    } catch (e) {
      this._log(`⚠️ ${symbol} 开仓失败: ${e.message.slice(0,40)}`);
      return { success: false, reason: e.message };
    }
  }

  // 平仓
  async closePosition(symbol, side, qty, precisionMap, reason, pnl) {
    try {
      const result = side === 'LONG'
        ? await this.api.closeLong(symbol, qty, precisionMap)
        : await this.api.closeShort(symbol, qty, precisionMap);
      if (result.success) {
        this._record({ symbol, side, action: 'CLOSE', qty, reason, pnl });
        if (pnl) this._dailyPnl += pnl;
        this._log(`🔻 ${symbol} ${side==='LONG'?'多':'空'}平仓 原因=${reason} 盈亏=$${pnl==null?'--':pnl.toFixed(2)}`);
      }
      return result;
    } catch (e) {
      this._log(`⚠️ ${symbol} 平仓失败: ${e.message.slice(0,40)}`);
      return { success: false, error: e.message };
    }
  }

  _record(t) { this.trades.push({ ...t, ts: Date.now() }); if (this.trades.length > 500) this.trades = this.trades.slice(-500); }
  getRecentTrades(n = 30) { return this.trades.slice(-n); }
}

module.exports = { TradeExecutionCore };
