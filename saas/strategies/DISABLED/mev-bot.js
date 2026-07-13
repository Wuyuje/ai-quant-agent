/**
 * v66: 链上 MEV 检测策略
 * 
 * Mempool 监控 + 三明治检测 + 抢先交易模拟
 * 1. Mempool 交易过滤 (DEX swap)
 * 2. 三明治机会检测
 * 3. 抢先交易利润模拟
 * 4. 滑点保护计算
 * 5. 盈利性检查
 * 
 * 安全策略: 三明治默认关闭，仅检测和报告
 */

const { ethers } = require('ethers');

const BSC_RPC = 'https://bsc-dataseed1.binance.org/';
const BSC_WS = 'wss://bsc-ws-node.nariox.org';
const PANCAKE_V2_ROUTER = '0x10ED43C718714eb63d5aA27B4B7B6E8FE09E4033';
const PANCAKE_V3_ROUTER = '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4';

const ROUTER_ABI = [
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)',
  'function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)',
  'function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)',
];

class MevBot {
  constructor(config = {}) {
    this.rpcUrl = config.rpcUrl || BSC_RPC;
    this.wsUrl = config.wsUrl || BSC_WS;
    this.provider = new ethers.JsonRpcProvider(this.rpcUrl);
    this.router = new ethers.Contract(PANCAKE_V2_ROUTER, ROUTER_ABI, this.provider);

    this._routerAddresses = new Set([
      PANCAKE_V2_ROUTER.toLowerCase(),
      PANCAKE_V3_ROUTER.toLowerCase(),
    ]);

    this._sandwichEnabled = false;
    this._maxSlippagePct = config.maxSlippagePct || 1.0;
    this._minProfitBNB = config.minProfitBNB || 0.001;
    this._gasPriceBoost = config.gasPriceBoost || 1;

    this._mempoolWatching = false;
    this._wsProvider = null;
    this._opportunities = [];
    this._stats = {
      totalDetected: 0, totalExecuted: 0, totalProfit: 0,
      totalGasSpent: 0, sandwichOpportunities: 0, arbOpportunities: 0,
      lastOpportunityTime: 0,
    };
    this._recentTxs = new Set();
    this._maxRecentTxs = 1000;
  }

  async watchMempool() {
    if (this._mempoolWatching) return { watching: true, message: '已在监控' };
    this._mempoolWatching = true;
    try {
      this._wsProvider = new ethers.WebSocketProvider(this.wsUrl);
      this._wsProvider.on('pending', async (txHash) => {
        if (this._recentTxs.has(txHash)) return;
        this._recentTxs.add(txHash);
        if (this._recentTxs.size > this._maxRecentTxs) {
          const first = this._recentTxs.values().next().value;
          this._recentTxs.delete(first);
        }
        try {
          const tx = await this._wsProvider.getTransaction(txHash);
          if (tx) this._processTx(tx);
        } catch (e) {}
      });
      return { watching: true, message: 'Mempool 监控已启动' };
    } catch (e) {
      this._mempoolWatching = false;
      return { watching: false, error: e.message };
    }
  }

  stopMempool() {
    if (this._wsProvider) { this._wsProvider.removeAllListeners(); this._wsProvider = null; }
    this._mempoolWatching = false;
  }

  async _processTx(tx) {
    if (!tx || !tx.to) return;
    if (!this._routerAddresses.has(tx.to.toLowerCase())) return;
    const swapInfo = this._decodeSwapTx(tx);
    if (!swapInfo) return;

    const sandwich = await this.detectSandwich(swapInfo);
    if (sandwich.valid) {
      this._stats.sandwichOpportunities++;
      this._stats.totalDetected++;
      this._stats.lastOpportunityTime = Date.now();
      this._opportunities.push({ type: 'sandwich', ...sandwich, time: Date.now() });
    }

    const arb = await this.detectArb(swapInfo);
    if (arb.valid) {
      this._stats.arbOpportunities++;
      this._stats.totalDetected++;
      this._stats.lastOpportunityTime = Date.now();
      this._opportunities.push({ type: 'arbitrage', ...arb, time: Date.now() });
    }

    const cutoff = Date.now() - 300000;
    this._opportunities = this._opportunities.filter(o => o.time > cutoff);
  }

  _decodeSwapTx(tx) {
    if (!tx.data || tx.data.length < 10) return null;
    const methodId = tx.data.slice(0, 10);
    const methodMap = {
      '0x38ed1739': 'swapExactTokensForTokens',
      '0x7ff36ab5': 'swapExactETHForTokens',
      '0x18cbafe5': 'swapExactTokensForETH',
      '0x8803dbee': 'swapTokensForExactTokens',
      '0xfb3bdb41': 'swapETHForExactTokens',
      '0x4a25d94a': 'swapTokensForExactETH',
    };
    const functionName = methodMap[methodId];
    if (!functionName) return null;

    return {
      txHash: tx.hash, from: tx.from, to: tx.to,
      value: tx.value?.toString() || '0',
      gasPrice: tx.gasPrice?.toString() || '0',
      methodId, functionName, rawData: tx.data,
    };
  }

  // AMM: x*y=k, 0.25% fee
  calculateSwapOutput(amountIn, reserveIn, reserveOut, feePct = 0.25) {
    const feeMultiplier = 1 - feePct / 100;
    const amountInWithFee = amountIn * feeMultiplier;
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn + amountInWithFee;
    if (denominator === 0) return 0;
    return numerator / denominator;
  }

  calculatePriceImpact(amountIn, reserveIn, reserveOut, feePct = 0.25) {
    const output = this.calculateSwapOutput(amountIn, reserveIn, reserveOut, feePct);
    if (amountIn === 0 || output === 0) return 0;
    if (reserveIn > 0 && reserveOut > 0) {
      const spotPrice = reserveOut / reserveIn;
      const effectivePrice = output / amountIn;
      if (spotPrice > 0) {
        return ((effectivePrice - spotPrice) / spotPrice) * 100;
      }
    }
    return 0;
  }

  async detectSandwich(swapInfo) {
    if (!this._sandwichEnabled) return { valid: false, reason: '三明治策略已禁用(安全设置)' };

    const victimValue = parseFloat(ethers.formatEther(swapInfo.value || 0));
    if (victimValue < 1.0) return { valid: false, reason: '受害交易金额太小', victimValue };

    const mockReserveIn = 1000;
    const mockReserveOut = 2000000;
    const priceImpact = this.calculatePriceImpact(victimValue, mockReserveIn, mockReserveOut);
    if (priceImpact < 0.5) return { valid: false, reason: '价格影响太小', priceImpact };

    const frontRunSize = victimValue * 0.8;
    const frontRunOutput = this.calculateSwapOutput(frontRunSize, mockReserveIn, mockReserveOut);
    const victimOutput = this.calculateSwapOutput(victimValue, mockReserveIn + frontRunSize * 0.9975, mockReserveOut - frontRunOutput);
    const backRunInput = frontRunOutput * 0.99;
    const backRunOutput = this.calculateSwapOutput(backRunInput, mockReserveOut - frontRunOutput - victimOutput, mockReserveIn + frontRunSize * 0.9975 + victimValue * 0.9975);

    const grossProfit = backRunOutput - frontRunSize;
    const gasCost = this._estimateGasCost(swapInfo.gasPrice);
    const netProfit = grossProfit - gasCost;

    if (!this.isProfitable(netProfit, gasCost, this._minProfitBNB)) {
      return { valid: false, reason: '利润不足', netProfit, gasCost };
    }

    return {
      valid: true, victimTx: swapInfo.txHash, victimValue,
      frontRunSize, expectedProfit: netProfit, gasCost, priceImpact,
      sandwichType: 'BUY_FRONT_SELL_BACK', timestamp: Date.now(),
    };
  }

  async simulateFrontrun(victimTx, frontRunAmount, reserveIn, reserveOut) {
    const frontRunOutput = this.calculateSwapOutput(frontRunAmount, reserveIn, reserveOut);
    const victimImpact = this.calculatePriceImpact(parseFloat(victimTx.value || 0), reserveIn + frontRunAmount * 0.9975, reserveOut - frontRunOutput);
    const backRunOutput = this.calculateSwapOutput(frontRunOutput * 0.99, reserveOut - frontRunOutput, reserveIn + frontRunAmount * 0.9975);
    const profit = backRunOutput - frontRunAmount;
    return { frontRunAmount, frontRunOutput, backRunOutput, profit, victimImpact };
  }

  async detectArb(swapInfo) {
    const victimValue = parseFloat(ethers.formatEther(swapInfo.value || 0));
    if (victimValue < 0.5) return { valid: false, reason: '金额太小' };
    const estimatedSpread = 0.5;
    if (estimatedSpread < 0.3) return { valid: false, reason: '价差不足' };
    const profit = victimValue * estimatedSpread / 100;
    const gasCost = this._estimateGasCost(swapInfo.gasPrice);
    return {
      valid: this.isProfitable(profit, gasCost, this._minProfitBNB),
      victimTx: swapInfo.txHash, estimatedSpread,
      expectedProfit: profit - gasCost, gasCost, arbType: 'CROSS_POOL',
    };
  }

  calculateMaxSlippage(poolReserves, swapAmount) {
    const [reserveIn, reserveOut] = poolReserves;
    const impact = this.calculatePriceImpact(swapAmount, reserveIn, reserveOut);
    return {
      priceImpact: impact,
      maxAllowedSlippage: Math.abs(impact) * 2 + this._maxSlippagePct,
      isSafe: Math.abs(impact) < this._maxSlippagePct,
    };
  }

  _estimateGasCost(gasPriceStr) {
    const gasPrice = parseFloat(gasPriceStr) || 3e9;
    const boostedGasPrice = gasPrice + this._gasPriceBoost * 1e9;
    const gasLimit = 250000;
    return (boostedGasPrice * gasLimit) / 1e18;
  }

  isProfitable(estimatedProfit, gasCost, minProfit) {
    return estimatedProfit > gasCost + (minProfit || this._minProfitBNB);
  }

  setSandwichEnabled(enabled) { this._sandwichEnabled = !!enabled; return this._sandwichEnabled; }
  setMaxSlippagePct(pct) { this._maxSlippagePct = pct; return this._maxSlippagePct; }

  getBestOpportunity() {
    if (!this._opportunities.length) return null;
    return this._opportunities.filter(o => o.valid)
      .sort((a, b) => (b.expectedProfit || 0) - (a.expectedProfit || 0))[0];
  }

  getSignal() {
    const best = this.getBestOpportunity();
    if (!best) return { action: 'WAIT', reason: '无MEV机会', mempoolWatching: this._mempoolWatching, sandwichEnabled: this._sandwichEnabled };
    return { action: best.type === 'sandwich' ? 'SANDWICH' : 'ARBITRAGE', ...best, sandwichEnabled: this._sandwichEnabled };
  }

  getSummary() {
    return {
      ...this._stats,
      activeOpportunities: this._opportunities.filter(o => o.valid).length,
      mempoolWatching: this._mempoolWatching,
      sandwichEnabled: this._sandwichEnabled,
      maxSlippagePct: this._maxSlippagePct,
      successRate: this._stats.totalDetected > 0 ? (this._stats.totalExecuted / this._stats.totalDetected * 100) : 0,
      netProfit: this._stats.totalProfit - this._stats.totalGasSpent,
    };
  }
}

module.exports = { MevBot };
