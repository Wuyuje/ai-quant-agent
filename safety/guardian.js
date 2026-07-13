/**
 * Guardian v3 — 多仓位安全守护
 * 
 * 改进：
 *   1. 支持同时持有多个仓位（上限由 config 控制）
 *   2. 不再自动平掉"其他币"仓位
 *   3. 持仓止损/止盈实时跟踪
 *   4. 开仓前全面检查（已有仓位、余额、冷却期）
 */

class Guardian {
  constructor(trader, dataBus, config) {
    this.trader = trader;
    this.dataBus = dataBus;
    this.config = config;
    // 多仓位状态: { symbol: { side, qty, entryPrice, leverage, pnl, openTime } }
    this.positions = {};
    this.suspiciousCount = 0;
    // v83: 同时用主日志记录到app2.log
    const { createLogger } = require('../utils/logger');
    this._logger = createLogger('Guardian');
    this.log = (msg) => {
      console.log(`[Guardian] ${new Date().toISOString()} ${msg}`);
      this._logger.info(msg);
    };
  }

  // ============ 同步链上持仓（v99: 二次验证修复） ============
  async syncAllPositions() {
    try {
      let chainPositions = await this.trader.getAllPositions();
      this.log(`链上 ${chainPositions.length} 个持仓`);
      
      // v99: 链上返回空但本地有持仓 → 等3秒重试一次（防止API瞬时故障）
      if (chainPositions.length === 0 && Object.keys(this.positions).length > 0) {
        this.log(`⚠️ 链上返回0持仓但本地有${Object.keys(this.positions).length}个，3秒后重试...`);
        await new Promise(r => setTimeout(r, 3000));
        chainPositions = await this.trader.getAllPositions();
        this.log(`重试结果: 链上 ${chainPositions.length} 个持仓`);
        
        // 重试后仍为0，逐个验证本地持仓是否真的已平
        if (chainPositions.length === 0) {
          for (const [sym, pos] of Object.entries(this.positions)) {
            const realPos = await this.trader.getRealPosition(sym).catch(() => null);
            if (!realPos) {
              this.log(`🗑️ ${sym} 链上确认已平仓，清理本地状态`);
              delete this.positions[sym];
            } else {
              this.log(`✅ ${sym} 链上仍有持仓，保留: ${realPos.side} ${realPos.qty}`);
            }
          }
          return;
        }
      }
      
      // 清空本地状态，从链上重建（保留已有持仓的 openTime）
      const prevPositions = { ...this.positions };
      this.positions = {};
      for (const pos of chainPositions) {
        this.positions[pos.symbol] = {
          side: pos.side,
          qty: pos.qty,
          entryPrice: pos.entryPrice,
          leverage: pos.leverage,
          pnl: pos.pnl,
          markPrice: pos.markPrice,  // v115: 保存 markPrice 供 _managePositions 使用
          liquidationPrice: pos.liquidationPrice, // v115: 保存强平价
          openTime: prevPositions[pos.symbol]?.openTime || pos.timestamp || (Date.now() - 600000),
          _peakPnlPct: prevPositions[pos.symbol]?._peakPnlPct,  // v115: 保留已追踪的峰值PnL
        };
        this.log(`🔄 同步: ${pos.symbol} ${pos.side} ${pos.qty} @ $${pos.entryPrice} PnL=$${pos.pnl}`);
      }
    } catch(e) {
      this.log(`同步失败: ${e.message}`);
    }
  }

  // ============ 获取指定币种持仓 ============
  getPosition(symbol) {
    return this.positions[symbol] || null;
  }

  // ============ 获取所有持仓 ============
  getAllPositions() {
    return { ...this.positions };
  }

  // ============ 持仓数量 ============
  getPositionCount() {
    return Object.keys(this.positions).length;
  }

  // ============ 开仓前验证 ============
  async preOpenCheck(symbol) {
    // 1. 该币种是否已有仓
    if (this.positions[symbol]) {
      this.log(`⛔ ${symbol} 已有持仓 ${this.positions[symbol].side} ${this.positions[symbol].qty}`);
      return { allowed: false, reason: 'already_has_position' };
    }

    // 2. 持仓数量是否达上限
    const maxPositions = this.config.trading?.maxPositions || 10; // v113.61: 阶梯式仓位由PositionSizer控制，这里只做最终上限
    if (this.getPositionCount() >= maxPositions) {
      this.log(`⛔ 已有 ${this.getPositionCount()} 个持仓 (上限 ${maxPositions})`);
      return { allowed: false, reason: 'max_positions_reached' };
    }

    // 3. 余额检查（最低$5可用于开仓，足够Binance最小下单量即可）
    const balance = await this.trader.getBalance();
    if (!balance || balance.available < 5) {
      this.log(`⛔ 余额不足 available=$${balance?.available?.toFixed(2) || 0}`);
      return { allowed: false, reason: 'insufficient_balance' };
    }

    // 4. 链上验证（防止本地状态和链上不同步）
    const realPos = await this.trader.getRealPosition(symbol);
    if (realPos) {
      this.log(`⛔ 链上已有 ${symbol} 持仓 ${realPos.side} ${realPos.qty}`);
      // v113.60: 修复 prevPositions 未定义 — 用 this.positions 获取已有 openTime
      this.positions[symbol] = {
        side: realPos.side,
        qty: realPos.qty,
        entryPrice: realPos.entryPrice,
        leverage: realPos.leverage,
        pnl: realPos.pnl,
        openTime: this.positions[symbol]?.openTime || (Date.now() - 600000),
      };
      return { allowed: false, reason: 'chain_has_position' };
    }

    return { allowed: true, balance };
  }

  // ============ 平仓后验证 ============
  async postCloseVerify(symbol) {
    await new Promise(r => setTimeout(r, 2000));
    const realPos = await this.trader.getRealPosition(symbol);
    if (realPos) {
      this.log(`⚠ ${symbol} 平仓后仍有持仓，重试...`);
      await this.trader.closePosition(symbol).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
      const retry = await this.trader.getRealPosition(symbol);
      if (retry) {
        this.log(`❌ ${symbol} 二次平仓仍失败！`);
        return { verified: false };
      }
    }
    delete this.positions[symbol];
    this.log(`✅ ${symbol} 持仓已平`);
    return { verified: true };
  }

  // ============ 执行决策 ============
  async executeDecision(decision, symbol) {
    const { action } = decision;

    if (action === 'WAIT' || action === 'HOLD') {
      return { executed: true, action };
    }

    if (action === 'CLOSE') {
      // v88: 如果本地已无此持仓，先查链上确认
      if (!this.positions[symbol]) {
        const realPos = await this.trader.getRealPosition(symbol).catch(() => null);
        if (!realPos) {
          this.log(`⏭️ ${symbol} 本地和链上均无持仓，跳过平仓`);
          return { executed: true, action: 'CLOSE', pnl: 0, noPosition: true };
        }
      }
      this.log(`📤 平仓 ${symbol}`);
      const result = await this.trader.closePosition(symbol);
      await this.postCloseVerify(symbol);
      return { executed: true, action: 'CLOSE', ...result };
    }

    if (action === 'LONG' || action === 'SHORT') {
      // v88: 已有持仓时不允许加仓 — 每个symbol只允许一个仓位
      const existingPos = this.positions[symbol];
      if (existingPos) {
        this.log(`⛔ ${symbol} 已有${existingPos.side}持仓，跳过开仓`);
        return { executed: false, blocked: true, reason: 'already_has_position' };
      }

      const check = await this.preOpenCheck(symbol);
      if (!check.allowed) {
        this.log(`⛔ 开仓被拦截: ${check.reason}`);
        return { executed: false, blocked: true, reason: check.reason };
      }

      this.log(`📤 开仓 ${action} ${symbol} | Lev=${decision.leverage}x | Size=$${decision.positionSize?.toFixed(2) || '0'}`);

      let result;
      if (action === 'LONG') {
        result = await this.trader.openLong(symbol, decision.leverage, decision.positionSize);
      } else {
        result = await this.trader.openShort(symbol, decision.leverage, decision.positionSize);
      }

      if (result.success) {
        // 验证链上
        await new Promise(r => setTimeout(r, 1500));
        const verify = await this.trader.getRealPosition(symbol);
        if (!verify) {
          this.log(`⚠ 开仓验证失败: 链上无持仓`);
          return { executed: false, reason: 'post_open_verify_failed' };
        }
        this.log(`✅ ${action} 链上确认: ${verify.side} ${verify.qty} @ $${verify.entryPrice}`);
        
        // 更新本地
        this.positions[symbol] = {
          side: action,
          qty: result.qty,
          entryPrice: result.price,
          leverage: decision.leverage,
          pnl: 0,
          openTime: Date.now()
        };
        return { executed: true, action, ...result };
      } else {
        // v84d: 开仓失败时正确返回失败状态和原因
        this.log(`❌ ${action} ${symbol} 失败: ${result.reason || 'unknown'}`);
        return { executed: false, success: false, reason: result.reason || 'open_failed', error: result.error };
      }
    }

    return { executed: false, reason: `未知操作: ${action}` };
  }

  // ============ v113.22: 减仓 (部分平仓) ============
  /**
   * @param {string} symbol — 交易对
   * @param {number} ratio  — 减仓比例 0.2~0.8
   */
  async reducePosition(symbol, ratio = 0.5) {
    try {
      const pos = this.positions[symbol];
      if (!pos) {
        const realPos = await this.trader.getRealPosition(symbol).catch(() => null);
        if (!realPos) {
          this.log(`⏭️ ${symbol} 无持仓，跳过减仓`);
          return { executed: false, reason: 'no_position' };
        }
        this.positions[symbol] = {
          side: realPos.side, qty: realPos.qty, entryPrice: realPos.entryPrice,
          leverage: realPos.leverage, pnl: realPos.pnl, openTime: Date.now()
        };
      }

      const realPos = await this.trader.getRealPosition(symbol);
      if (!realPos) {
        this.log(`⚠️ ${symbol} 链上无持仓，清理本地状态`);
        delete this.positions[symbol];
        return { executed: false, reason: 'no_chain_position' };
      }

      const closeSide = realPos.side === 'LONG' ? 'SELL' : 'BUY';
      const reduceQty = this.trader.fixQty(symbol, Math.abs(realPos.qty) * ratio);

      // 检查减仓后的名义值是否达标
      const currentPrice = realPos.markPrice || this.dataBus.marketData?.[symbol]?.price || 0;
      const reduceNotional = reduceQty * currentPrice;
      if (reduceNotional < 5) {
        this.log(`⛔ ${symbol} 减仓名义值 $${reduceNotional.toFixed(2)} < $5，跳过`);
        return { executed: false, reason: 'reduce_notional_too_small' };
      }

      // 减仓后剩余仓位也要 ≥ $5
      const remainQty = Math.abs(realPos.qty) - reduceQty;
      const remainNotional = remainQty * currentPrice;
      if (remainNotional < 5) {
        this.log(`⚠️ ${symbol} 减仓后剩余 $${remainNotional.toFixed(2)} < $5，改为全平`);
        const result = await this.trader.closePosition(symbol);
        await this.postCloseVerify(symbol);
        return { executed: true, action: 'CLOSE', ...result, reduceFallback: true };
      }

      this.log(`📤 减仓 ${symbol} ${realPos.side} 平${(ratio * 100).toFixed(0)}% qty=${reduceQty} remaining=${remainQty.toFixed(6)}`);

      const result = await this._requestReduceOnly(symbol, closeSide, reduceQty);
      if (result.success) {
 // 更新本地仓位
        if (this.positions[symbol]) {
          this.positions[symbol].qty = remainQty;
          this.positions[symbol].pnl = 0; // 减仓后重置 PnL 追踪
        }
        this.log(`✅ ${symbol} 减仓成功: 剩余 ${remainQty.toFixed(6)}`);
        return { executed: true, action: 'REDUCE', ratio, reduceQty, remainQty, ...result };
      } else {
        this.log(`❌ ${symbol} 减仓失败: ${result.reason || result.error}`);
        return { executed: false, reason: result.reason || 'reduce_failed', error: result.error };
      }
    } catch(e) {
      this.log(`❌ ${symbol} 减仓异常: ${e.message}`);
      return { executed: false, reason: 'reduce_exception', error: e.message };
    }
  }

  // v113.22: reduceOnly 下单辅助
  async _requestReduceOnly(symbol, side, quantity) {
    try {
      const fixedQty = this.trader.fixQty(symbol, quantity);
      const result = await this.trader._request('POST', '/fapi/v1/order', {
        symbol, side, type: 'MARKET', quantity: fixedQty, reduceOnly: 'true'
      });
      return { success: true, order: result };
    } catch(e) {
      return { success: false, reason: 'reduce_order_failed', error: e.message };
    }
  }

  // ============ v113.22: 加仓 ============
  /**
   * @param {string} symbol      — 交易对
   * @param {number} addSizeUsd — 加仓金额(USDT保证金)
   * @param {number} leverage   — 杠杆
   */
  async addPosition(symbol, addSizeUsd, leverage) {
    try {
      const pos = this.positions[symbol];
      if (!pos) {
        this.log(`⏭️ ${symbol} 本地无持仓，跳过加仓`);
        return { executed: false, reason: 'no_local_position' };
      }

      const realPos = await this.trader.getRealPosition(symbol);
      if (!realPos) {
        this.log(`⚠️ ${symbol} 链上无持仓，清理本地状态`);
        delete this.positions[symbol];
        return { executed: false, reason: 'no_chain_position' };
      }

      // 方向必须一致
      if (realPos.side !== pos.side) {
        this.log(`⛔ ${symbol} 方向不一致 local=${pos.side} chain=${realPos.side}`);
        return { executed: false, reason: 'direction_mismatch' };
      }

      this.log(`📤 加仓 ${symbol} ${pos.side} +$${addSizeUsd.toFixed(2)} @ ${leverage}x`);

      // 用 trader.addPosition 加仓
      const result = await this.trader.openLong(
        symbol, leverage, addSizeUsd, true // addMode=true
      ).catch(async (e) => {
        // openLong 失败则用 addPosition
        this.log(`⚠️ ${symbol} openLong(addMode) 失败，尝试 addPosition: ${e.message}`);
        const currentPrice = this.dataBus.marketData?.[symbol]?.price || realPos.markPrice || 0;
        const rawQty = addSizeUsd * leverage / currentPrice;
        return await this.trader.addPosition(symbol, pos.side, rawQty);
      });

      if (result && (result.success || result.order)) {
        // 等待链上确认
        await new Promise(r => setTimeout(r, 1500));
        const verify = await this.trader.getRealPosition(symbol);
        if (verify) {
          this.positions[symbol].qty = verify.qty;
          this.positions[symbol].entryPrice = verify.entryPrice;
          this.log(`✅ ${symbol} 加仓成功: ${verify.qty} @ $${verify.entryPrice}`);
        }
        return { executed: true, action: 'ADD', addSizeUsd, ...result };
      } else {
        this.log(`❌ ${symbol} 加仓失败: ${result?.reason || 'unknown'}`);
        return { executed: false, reason: result?.reason || 'add_failed' };
      }
    } catch(e) {
      this.log(`❌ ${symbol} 加仓异常: ${e.message}`);
      return { executed: false, reason: 'add_exception', error: e.message };
    }
  }

  // ============ 持仓止损止盈检查（v4: 由 aiEngine 管理）============
  async checkStopLossTakeProfit() {
    // v4: 止损止盈逻辑由 aiEngine.managePositions() 处理
    // 这里只做兜底检查（链上已无仓位的清理）
    const actions = [];
    
    for (const [symbol, pos] of Object.entries(this.positions)) {
      try {
        const realPos = await this.trader.getRealPosition(symbol);
        if (!realPos) {
          delete this.positions[symbol];
          continue;
        }

        const currentPrice = realPos.markPrice;
        const entryPrice = realPos.entryPrice;
        const leverage = realPos.leverage || 3;
        const isLong = realPos.side === 'LONG';

        const pnlPct = isLong
          ? ((currentPrice - entryPrice) / entryPrice) * 100 * leverage
          : ((entryPrice - currentPrice) / entryPrice) * 100 * leverage;

        // v4 兜底：极端亏损必须平（杠杆后 > 15%）
        if (pnlPct <= -15) {
          this.log(`🚨 ${symbol} 极端止损! PnL=${pnlPct.toFixed(2)}%`);
          actions.push({ symbol, action: 'CLOSE', reason: `极端止损 PnL=${pnlPct.toFixed(2)}%` });
        }
      } catch(e) { this.log(`⚠️ ${symbol} 链上验证失败: ${e.message}`); }
    }

    return actions;
  }

  getStats() {
    return {
      suspiciousEvents: this.suspiciousCount,
      positions: { ...this.positions },
      positionCount: this.getPositionCount()
    };
  }
}

module.exports = Guardian;
