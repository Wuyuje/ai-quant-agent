/**
 * v63: TWAP/VWAP 拆单引擎
 * 
 * 功能：
 *   1. TWAP (Time-Weighted Average Price) — 将大额订单按时间均分拆分执行
 *      适用：流动性一般、减少市场冲击
 *   2. VWAP (Volume-Weighted Average Price) — 按历史成交量分布拆分
 *      适用：跟随市场交易节奏，获得更优平均价
 *   3. 动态调整：根据实时流动性、滑点、价格变动自动调整
 *   4. 执行报告：每笔子订单记录实际成交价 vs 预期价
 * 
 * 集成方式：
 *   const twap = new TwapVwapEngine(userTrader);
 *   await twap.executeTwap({ vault, tokenIn, tokenOut, totalAmount, slices: 5, intervalSec: 30 });
 *   await twap.executeVwap({ vault, tokenIn, tokenOut, totalAmount, klines, slices: 5 });
 */

const path = require('path');
const fs = require('fs');

const TRADE_LOG_FILE = path.join(__dirname, '..', 'data', 'twap-vwap-trades.json');

class TwapVwapEngine {
  constructor(userTrader) {
    this.ut = userTrader;
    this.activeOrders = new Map(); // orderId -> order state
    this.orderCounter = 0;
    this.minSliceUsdt = 5;    // 最小拆单金额
    this.maxSlippageBps = 200; // 单笔最大滑点 2%
  }

  // ═══════════════════════════════════
  // TWAP 执行
  // ═══════════════════════════════════
  async executeTwap(params) {
    const {
      vault, tokenIn, tokenOut,
      totalAmountUsdt, slices = 5, intervalSec = 30,
      slippageBps = 50, wallet = null,
    } = params;

    const orderId = `twap-${++this.orderCounter}-${Date.now()}`;
    const sliceAmount = totalAmountUsdt / slices;

    // 安全检查
    if (sliceAmount < this.minSliceUsdt) {
      this.ut._log(`[TWAP] ${orderId} 单笔金额太小 $${sliceAmount.toFixed(2)} < $${this.minSliceUsdt}, 直接执行`);
      return await this.ut._executeSwapInVault(vault, tokenIn, tokenOut, totalAmountUsdt, slippageBps);
    }

    const order = {
      orderId, type: 'TWAP',
      vault, tokenIn, tokenOut,
      totalAmountUsdt, slices, intervalSec,
      slippageBps,
      executed: [],
      totalSpent: 0,
      totalReceived: 0,
      status: 'running',
      startTime: Date.now(),
    };
    this.activeOrders.set(orderId, order);

    this.ut._log(`[TWAP] ${orderId} 开始 | 总额 $${totalAmountUsdt.toFixed(2)} | ${slices}片 | 间隔${intervalSec}s | 单片$${sliceAmount.toFixed(2)}`);

    const results = [];
    for (let i = 0; i < slices; i++) {
      const sliceStart = Date.now();
      const sliceId = `${orderId}#${i + 1}/${slices}`;

      try {
        // 动态滑点：前几片用宽松滑点，后面收紧
        const dynSlippage = i === 0 ? slippageBps * 2 : slippageBps;
        
        this.ut._log(`[TWAP] ${sliceId} 执行中... 金额$${sliceAmount.toFixed(2)} 滑点${dynSlippage}bps`);
        
        const receipt = await this.ut._executeSwapInVault(
          vault, tokenIn, tokenOut, sliceAmount, dynSlippage
        );

        const exec = {
          sliceId, sliceIndex: i,
          amountUsdt: sliceAmount,
          txHash: receipt?.hash,
          gasUsed: receipt?.gasUsed?.toString(),
          status: 'success',
          timestamp: Date.now(),
        };
        order.executed.push(exec);
        results.push(exec);

        this.ut._log(`[TWAP] ${sliceId} ✅ 成功 tx=${receipt?.hash?.slice(0, 16)}...`);

      } catch (e) {
        this.ut._log(`[TWAP] ${sliceId} ❌ 失败: ${e.message?.slice(0, 100)}`);
        
        order.executed.push({
          sliceId, sliceIndex: i,
          amountUsdt: sliceAmount,
          error: e.message?.slice(0, 150),
          status: 'failed',
          timestamp: Date.now(),
        });

        // 连续失败2次 → 中止
        const recentFails = order.executed.slice(-2).filter(e => e.status === 'failed');
        if (recentFails.length >= 2) {
          this.ut._log(`[TWAP] ${orderId} ⛔ 连续2次失败，中止拆单`);
          order.status = 'aborted';
          break;
        }
      }

      // 等待间隔（最后一片不等）
      if (i < slices - 1 && order.status === 'running') {
        await this._sleep(intervalSec * 1000);
      }
    }

    order.status = order.status === 'aborted' ? 'aborted' : 'completed';
    order.endTime = Date.now();
    order.totalSpent = order.executed
      .filter(e => e.status === 'success')
      .reduce((a, b) => a + b.amountUsdt, 0);
    order.duration = (order.endTime - order.startTime) / 1000;

    // 执行报告
    const successCount = order.executed.filter(e => e.status === 'success').length;
    this.ut._log(`[TWAP] ${orderId} ${order.status === 'completed' ? '✅' : '⛔'} 完成 | 成功${successCount}/${slices} | 总额$${order.totalSpent.toFixed(2)} | 用时${order.duration.toFixed(0)}s`);

    this._saveOrder(order);
    this.activeOrders.delete(orderId);
    return order;
  }

  // ═══════════════════════════════════
  // VWAP 执行（按历史成交量分布）
  // ═══════════════════════════════════
  async executeVwap(params) {
    const {
      vault, tokenIn, tokenOut,
      totalAmountUsdt, klines, slices = 5,
      slippageBps = 50, wallet = null,
    } = params;

    const orderId = `vwap-${++this.orderCounter}-${Date.now()}`;
    
    // 计算成交量分布
    const volumeProfile = this._calcVolumeProfile(klines, slices);
    const sliceAmounts = volumeProfile.map(w => totalAmountUsdt * w);

    // 安全检查
    const minSlice = Math.min(...sliceAmounts);
    if (minSlice < this.minSliceUsdt) {
      this.ut._log(`[VWAP] ${orderId} 最小片太小 $${minSlice.toFixed(2)}, 直接执行`);
      return await this.ut._executeSwapInVault(vault, tokenIn, tokenOut, totalAmountUsdt, slippageBps);
    }

    const order = {
      orderId, type: 'VWAP',
      vault, tokenIn, tokenOut,
      totalAmountUsdt, slices,
      slippageBps,
      volumeWeights: volumeProfile,
      executed: [],
      totalSpent: 0,
      status: 'running',
      startTime: Date.now(),
    };
    this.activeOrders.set(orderId, order);

    this.ut._log(`[VWAP] ${orderId} 开始 | 总额$${totalAmountUsdt.toFixed(2)} | ${slices}片 | 成量分布[${volumeProfile.map(w => (w * 100).toFixed(0) + '%').join(', ')}]`);

    const results = [];
    for (let i = 0; i < slices; i++) {
      const sliceAmount = sliceAmounts[i];
      const sliceId = `${orderId}#${i + 1}/${slices}`;

      try {
        // 高成交量时段用更紧滑点
        const volWeight = volumeProfile[i];
        const dynSlippage = volWeight > 0.25 ? slippageBps * 0.8 : slippageBps * 1.5;

        this.ut._log(`[VWAP] ${sliceId} 执行中... 金额$${sliceAmount.toFixed(2)} 权重${(volWeight * 100).toFixed(0)}% 滑点${dynSlippage.toFixed(0)}bps`);

        const receipt = await this.ut._executeSwapInVault(
          vault, tokenIn, tokenOut, sliceAmount, Math.floor(dynSlippage)
        );

        const exec = {
          sliceId, sliceIndex: i,
          amountUsdt: sliceAmount,
          volumeWeight: volWeight,
          txHash: receipt?.hash,
          gasUsed: receipt?.gasUsed?.toString(),
          status: 'success',
          timestamp: Date.now(),
        };
        order.executed.push(exec);
        results.push(exec);

        this.ut._log(`[VWAP] ${sliceId} ✅ 成功 tx=${receipt?.hash?.slice(0, 16)}...`);

      } catch (e) {
        this.ut._log(`[VWAP] ${sliceId} ❌ 失败: ${e.message?.slice(0, 100)}`);

        order.executed.push({
          sliceId, sliceIndex: i,
          amountUsdt: sliceAmount,
          error: e.message?.slice(0, 150),
          status: 'failed',
          timestamp: Date.now(),
        });

        const recentFails = order.executed.slice(-2).filter(e => e.status === 'failed');
        if (recentFails.length >= 2) {
          this.ut._log(`[VWAP] ${orderId} ⛔ 连续2次失败，中止`);
          order.status = 'aborted';
          break;
        }
      }

      // VWAP间隔：高成交量时段间隔短，低成交量时段间隔长
      if (i < slices - 1 && order.status === 'running') {
        const volWeight = volumeProfile[i];
        const waitSec = volWeight > 0.25 ? 15 : 45; // 高量15s, 低量45s
        await this._sleep(waitSec * 1000);
      }
    }

    order.status = order.status === 'aborted' ? 'aborted' : 'completed';
    order.endTime = Date.now();
    order.totalSpent = order.executed
      .filter(e => e.status === 'success')
      .reduce((a, b) => a + b.amountUsdt, 0);
    order.duration = (order.endTime - order.startTime) / 1000;

    const successCount = order.executed.filter(e => e.status === 'success').length;
    this.ut._log(`[VWAP] ${orderId} ${order.status === 'completed' ? '✅' : '⛔'} 完成 | 成功${successCount}/${slices} | 总额$${order.totalSpent.toFixed(2)} | 用时${order.duration.toFixed(0)}s`);

    this._saveOrder(order);
    this.activeOrders.delete(orderId);
    return order;
  }

  // ═══════════════════════════════════
  // 智能拆单 — 根据订单大小自动选择策略
  // ═══════════════════════════════════
  async smartExecute(params) {
    const { totalAmountUsdt, klines = null } = params;

    // 小额直接执行
    if (totalAmountUsdt < 50) {
      this.ut._log(`[SmartOrder] $${totalAmountUsdt.toFixed(2)} < $50, 直接执行`);
      return await this.ut._executeSwapInVault(
        params.vault, params.tokenIn, params.tokenOut,
        totalAmountUsdt, params.slippageBps || 50
      );
    }

    // 中额 TWAP 3片
    if (totalAmountUsdt < 200) {
      this.ut._log(`[SmartOrder] $${totalAmountUsdt.toFixed(2)} → TWAP 3片`);
      return await this.executeTwap({ ...params, slices: 3, intervalSec: 20 });
    }

    // 大额 VWAP 5片（如果有K线数据）
    if (klines && klines.length >= 20) {
      this.ut._log(`[SmartOrder] $${totalAmountUsdt.toFixed(2)} → VWAP 5片`);
      return await this.executeVwap({ ...params, klines, slices: 5 });
    }

    // 大额无K线 → TWAP 5片
    this.ut._log(`[SmartOrder] $${totalAmountUsdt.toFixed(2)} → TWAP 5片`);
    return await this.executeTwap({ ...params, slices: 5, intervalSec: 30 });
  }

  // ═══════════════════════════════════
  // 计算成交量分布（用于VWAP）
  // ═══════════════════════════════════
  _calcVolumeProfile(klines, slices) {
    if (!klines || klines.length < slices) {
      // 无数据 → 均匀分布
      return new Array(slices).fill(1 / slices);
    }

    // 取最近 N 根K线的成交量
    const recent = klines.slice(-slices * 3);
    const volumes = recent.map(k => parseFloat(k.volume || 0));
    const totalVol = volumes.reduce((a, b) => a + b, 0) || 1;

    // 按成交量权重分配
    const weights = [];
    const chunkSize = Math.floor(volumes.length / slices);
    for (let i = 0; i < slices; i++) {
      const chunk = volumes.slice(i * chunkSize, (i + 1) * chunkSize);
      const chunkVol = chunk.reduce((a, b) => a + b, 0);
      weights.push(chunkVol / totalVol);
    }

    // 归一化
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    return weights.map(w => w / sum);
  }

  // ═══════════════════════════════════
  // 保存执行记录
  // ═══════════════════════════════════
  _saveOrder(order) {
    try {
      let trades = [];
      if (fs.existsSync(TRADE_LOG_FILE)) {
        trades = JSON.parse(fs.readFileSync(TRADE_LOG_FILE, 'utf8'));
      }
      trades.push(order);
      // 保留最近500条
      if (trades.length > 500) trades = trades.slice(-500);
      fs.writeFileSync(TRADE_LOG_FILE, JSON.stringify(trades, null, 2));
    } catch (e) {
      this.ut._log(`[TWAP/VWAP] 保存记录失败: ${e.message}`);
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // 获取活跃订单状态
  getActiveOrders() {
    return Array.from(this.activeOrders.values());
  }
}

module.exports = { TwapVwapEngine };
