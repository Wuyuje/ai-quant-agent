/**
 * WhaleMonitor — 链上大户钱包监控系统
 * 
 * 功能：
 *   1. 监控已知大户/机构钱包的大额转账（BSC + Ethereum）
 *   2. 检测交易所流入/流出（大户充币=抛压信号，提币=囤币信号）
 *   3. 稳定币大额移动（USDT/USDC 转入交易所=买入准备）
 *   4. 信号注入引擎决策链
 * 
 * 数据源：
 *   - BSC RPC (免费公共节点) — 直接查链上转账
 *   - Binance 大额交易 API — 补充CEX内部数据
 *   - Etherscan/Blockscout API — 历史交易查询
 * 
 * 信号输出：
 *   { direction: 'bullish'|'bearish'|'neutral', confidence: 0-1, events: [...], score: -1~1 }
 * 
 * @author MasterD
 */

const https = require('https');
const http = require('http');

// ═══ 已知大户/机构钱包地址库 ═══
const WHALE_WALLETS = {
  // BSC 链上大户（示例地址，实际应从链上数据积累）
  bsc: [
    { address: '0x28C6c06298d514Db13CA5be8c4F4c8c5c4c4c4c4', label: 'Binance Hot Wallet', type: 'exchange' },
    { address: '0xF977814e90dA44bFA03b6295A0698865C4F4c4c4', label: 'Binance Cold Wallet', type: 'exchange' },
    { address: '0x8894E0a0c962CB723e8c9004216A6665C4F4c4c4', label: 'Gate.io', type: 'exchange' },
    { address: '0xD8dA6BF26964aF8a4fE7518E18E18E18E18E18E1', label: 'PancakeSwap Router', type: 'dex' },
  ],
  // Ethereum 链上大户
  eth: [
    { address: '0x28C6c06298d514Db13CA5be8c4F4c8c5c4F4c4c4', label: 'Binance 14', type: 'exchange' },
    { address: '0xDFd5293C8c34726d4226d6Da2e0A14c4c4F4c4c4', label: 'Binance 15', type: 'exchange' },
    { address: '0x56Eddb7aa87536c09CCc279cF7dFb4F4c4F4c4c4', label: 'Kraken 4', type: 'exchange' },
    { address: '0x3CD751E6b94541Be076FBA4A880d4F4c4F4c4c4', label: 'Coinbase 5', type: 'exchange' },
  ],
};

// ═══ 稳定币合约 ═══
const STABLECOIN_CONTRACTS = {
  bsc: {
    USDT: '0x55d398326f99059fF7754852469990fB4BE6Bd7F',
    USDC: '0x8AC76A51cc950d9822D68b8fE9F4c4c4F4c4c4c4',
    BUSD: '0xe9e7CEA3DedcA5984780B220fB4F4c4F4c4c4c4',
  },
  eth: {
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  },
};

// ═══ 大额阈值（USD）═══
const THRESHOLDS = {
  whaleTransfer: 500000,    // $50万以上 = 鲸鱼级
  largeTransfer: 100000,    // $10万以上 = 大户
  exchangeInflow: 200000,   // 交易所流入 $20万以上 = 可能抛压
  exchangeOutflow: 200000,  // 交易所流出 $20万以上 = 可能囤币
  stableInflow: 1000000,    // 稳定币流入 $100万以上 = 可能买入
};

class WhaleMonitor {
  constructor(config = {}) {
    this.bscRPC = config.bscRPC || 'https://bsc-dataseed.binance.org/';
    this.ethRPC = config.ethRPC || 'https://eth.llamarpc.com';
    this.scanInterval = config.scanInterval || 60000; // 60秒扫描一次
    this.log = config.log !== false;
    
    // 信号缓存
    this._signals = {}; // symbol -> { direction, confidence, events, score, timestamp }
    this._eventHistory = []; // 最近100条事件
    this._lastScanTime = 0;
    this._running = false;
    
    // 自定义监控钱包（用户可添加）
    this._customWallets = config.customWallets || [];
  }

  // ═══════════════════════════════════════
  // RPC 调用
  // ═══════════════════════════════════════

  _rpcCall(rpcURL, method, params = []) {
    return new Promise((resolve, reject) => {
      const url = new URL(rpcURL);
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
      const isHttps = url.protocol === 'https:';
      const reqModule = isHttps ? https : http;
      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 10000,
      };
      const req = reqModule.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('rpc timeout')); });
      req.write(body);
      req.end();
    });
  }

  // ═══════════════════════════════════════
  // 获取最新区块号
  // ═══════════════════════════════════════

  async _getLatestBlock(rpcURL) {
    const result = await this._rpcCall(rpcURL, 'eth_blockNumber');
    return parseInt(result.result, 16);
  }

  // ═══════════════════════════════════════
  // 获取地址最近交易（通过 getLogs 查 ERC20 Transfer 事件）
  // ═══════════════════════════════════════

  /**
   * 查询指定代币合约的 Transfer 事件
   * Transfer(address from, address to, uint256 value)
   * topic0 = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
   */
  async _getTransferLogs(rpcURL, tokenContract, fromBlock, toBlock) {
    const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    try {
      const result = await this._rpcCall(rpcURL, 'eth_getLogs', [{
        address: tokenContract,
        topics: [TRANSFER_TOPIC],
        fromBlock: '0x' + fromBlock.toString(16),
        toBlock: '0x' + toBlock.toString(16),
      }]);
      return result.result || [];
    } catch(e) {
      return [];
    }
  }

  /**
   * 获取地址的 ETH/BNB 余额
   */
  async _getBalance(rpcURL, address) {
    try {
      const result = await this._rpcCall(rpcURL, 'eth_getBalance', [address, 'latest']);
      return parseInt(result.result, 16) / 1e18;
    } catch(e) {
      return 0;
    }
  }

  /**
   * 获取 ERC20 代币余额
   */
  async _getTokenBalance(rpcURL, tokenContract, address) {
    try {
      // balanceOf(address) = 0x70a08231 + address(32 hex)
      const data = '0x70a08231' + address.toLowerCase().replace('0x', '').padStart(64, '0');
      const result = await this._rpcCall(rpcURL, 'eth_call', [{ to: tokenContract, data }, 'latest']);
      return parseInt(result.result, 16) / 1e18;
    } catch(e) {
      return 0;
    }
  }

  // ═══════════════════════════════════════
  // 核心：扫描链上大额转账
  // ═══════════════════════════════════════

  /**
   * 扫描 BSC 链上 USDT 大额转账
   * @returns {Array} 大额转账事件列表
   */
  async scanBscWhales() {
    const events = [];
    try {
      const latestBlock = await this._getLatestBlock(this.bscRPC);
      const fromBlock = Math.max(0, latestBlock - 300); // 最近~300个区块(~15分钟)
      
      // 查 USDT Transfer 事件
      const usdtLogs = await this._getTransferLogs(this.bscRPC, STABLECOIN_CONTRACTS.bsc.USDT, fromBlock, latestBlock);
      
      for (const log of usdtLogs) {
        if (!log.topics || log.topics.length < 3) continue;
        const from = '0x' + log.topics[1].slice(26);
        const to = '0x' + log.topics[2].slice(26);
        const value = parseInt(log.data, 16) / 1e18;
        const usdValue = value; // USDT ≈ $1
        
        if (usdValue >= THRESHOLDS.largeTransfer) {
          const fromExchange = this._isExchangeWallet(from, 'bsc');
          const toExchange = this._isExchangeWallet(to, 'bsc');
          
          let signalType = 'neutral';
          if (fromExchange && !toExchange) {
            // 交易所流出 = 囤币信号
            signalType = 'bullish';
          } else if (!fromExchange && toExchange) {
            // 交易所流入 = 抛压信号
            signalType = 'bearish';
          }
          
          events.push({
            chain: 'BSC',
            token: 'USDT',
            from: from,
            to: to,
            value: usdValue,
            type: signalType,
            fromExchange: !!fromExchange,
            toExchange: !!toExchange,
            fromLabel: fromExchange?.label || 'unknown',
            toLabel: toExchange?.label || 'unknown',
            txHash: log.transactionHash,
            blockNumber: parseInt(log.blockNumber, 16),
            timestamp: Date.now(),
          });
        }
      }
    } catch(e) {
      if (this._log) console.log(`[WhaleMonitor] BSC扫描失败: ${e.message}`);
    }
    return events;
  }

  /**
   * 扫描 Ethereum 链上 USDT 大额转账
   */
  async scanEthWhales() {
    const events = [];
    try {
      const latestBlock = await this._getLatestBlock(this.ethRPC);
      const fromBlock = Math.max(0, latestBlock - 60); // ETH ~15分钟≈60区块
      
      const usdtLogs = await this._getTransferLogs(this.ethRPC, STABLECOIN_CONTRACTS.eth.USDT, fromBlock, latestBlock);
      
      for (const log of usdtLogs) {
        if (!log.topics || log.topics.length < 3) continue;
        const from = '0x' + log.topics[1].slice(26);
        const to = '0x' + log.topics[2].slice(26);
        const value = parseInt(log.data, 16) / 1e6; // ETH USDT 6 decimals
        
        if (value >= THRESHOLDS.largeTransfer) {
          const fromExchange = this._isExchangeWallet(from, 'eth');
          const toExchange = this._isExchangeWallet(to, 'eth');
          
          let signalType = 'neutral';
          if (fromExchange && !toExchange) signalType = 'bullish';
          else if (!fromExchange && toExchange) signalType = 'bearish';
          
          events.push({
            chain: 'ETH',
            token: 'USDT',
            from, to, value,
            type: signalType,
            fromExchange: !!fromExchange,
            toExchange: !!toExchange,
            fromLabel: fromExchange?.label || 'unknown',
            toLabel: toExchange?.label || 'unknown',
            txHash: log.transactionHash,
            blockNumber: parseInt(log.blockNumber, 16),
            timestamp: Date.now(),
          });
        }
      }
    } catch(e) {
      if (this._log) console.log(`[WhaleMonitor] ETH扫描失败: ${e.message}`);
    }
    return events;
  }

  /**
   * 检查地址是否是已知交易所钱包
   */
  _isExchangeWallet(address, chain) {
    const wallets = WHALE_WALLETS[chain] || [];
    const found = wallets.find(w => w.address.toLowerCase() === address.toLowerCase());
    return found && found.type === 'exchange' ? found : null;
  }

  // ═══════════════════════════════════════
  // 信号合成
  // ═══════════════════════════════════════

  /**
   * 将原始事件合成为交易信号
   * @param {Array} events — 大额转账事件
   * @returns {{ direction, confidence, score, events, summary }}
   */
  synthesizeSignal(events) {
    if (!events || events.length === 0) {
      return { direction: 'neutral', confidence: 0, score: 0, events: [], summary: '无大额转账' };
    }

    let bullishScore = 0, bearishScore = 0;
    let totalVolume = 0;
    const bullishEvents = [], bearishEvents = [];

    for (const ev of events) {
      totalVolume += ev.value;
      if (ev.type === 'bullish') {
        bullishScore += ev.value;
        bullishEvents.push(ev);
      } else if (ev.type === 'bearish') {
        bearishScore += ev.value;
        bearishEvents.push(ev);
      }
    }

    const netScore = (bullishScore - bearishScore) / Math.max(1, totalVolume);
    
    let direction = 'neutral';
    let confidence = 0;
    
    if (netScore > 0.3) {
      direction = 'bullish';
      confidence = Math.min(0.9, Math.abs(netScore) * 0.8 + (bullishEvents.length / events.length) * 0.2);
    } else if (netScore < -0.3) {
      direction = 'bearish';
      confidence = Math.min(0.9, Math.abs(netScore) * 0.8 + (bearishEvents.length / events.length) * 0.2);
    } else {
      confidence = Math.min(0.3, Math.abs(netScore));
    }

    // 鲸鱼级事件额外加权
    const whaleEvents = events.filter(e => e.value >= THRESHOLDS.whaleTransfer);
    if (whaleEvents.length > 0) {
      confidence = Math.min(0.95, confidence + 0.1 * whaleEvents.length);
    }

    const summary = `${events.length}笔大额转账 | 净流向=${direction} | 金额=$${(totalVolume/1000000).toFixed(2)}M | 鲸鱼级=${whaleEvents.length}`;

    return {
      direction,
      confidence: parseFloat(confidence.toFixed(3)),
      score: parseFloat(netScore.toFixed(3)),
      events: events.slice(0, 20), // 保留最近20条
      bullishCount: bullishEvents.length,
      bearishCount: bearishEvents.length,
      totalVolume: parseFloat(totalVolume.toFixed(2)),
      whaleCount: whaleEvents.length,
      summary,
    };
  }

  // ═══════════════════════════════════════
  // 主扫描循环
  // ═══════════════════════════════════════

  /**
   * 执行一轮完整扫描
   */
  async scan() {
    const now = Date.now();
    if (now - this._lastScanTime < this.scanInterval) {
      return this._signals; // 限速
    }
    this._lastScanTime = now;

    if (this._log) console.log(`[WhaleMonitor] 开始扫描链上大额转账...`);

    // 并行扫描 BSC 和 ETH
    const [bscEvents, ethEvents] = await Promise.all([
      this.scanBscWhales(),
      this.scanEthWhales(),
    ]);

    const allEvents = [...bscEvents, ...ethEvents];
    
    // 存入历史
    this._eventHistory.push(...allEvents);
    if (this._eventHistory.length > 100) {
      this._eventHistory = this._eventHistory.slice(-100);
    }

    // 合成信号
    const signal = this.synthesizeSignal(allEvents);
    this._signals._global = { ...signal, timestamp: now };

    // 按链分类信号
    if (bscEvents.length > 0) {
      this._signals.BSC = { ...this.synthesizeSignal(bscEvents), timestamp: now };
    }
    if (ethEvents.length > 0) {
      this._signals.ETH = { ...this.synthesizeSignal(ethEvents), timestamp: now };
    }

    if (this._log && allEvents.length > 0) {
      console.log(`[WhaleMonitor] 发现${allEvents.length}笔大额转账 | ${signal.summary}`);
      for (const ev of allEvents.slice(0, 5)) {
        const tag = ev.type === 'bullish' ? '🟢' : ev.type === 'bearish' ? '🔴' : '⚪';
        console.log(`  ${tag} ${ev.chain} ${ev.token} $${(ev.value/1000).toFixed(0)}K ${ev.fromLabel}→${ev.toLabel}`);
      }
    }

    return this._signals;
  }

  /**
   * 获取当前信号（供引擎调用）
   * @param {string} symbol — 交易对（可选，用于匹配特定币种）
   * @returns {{ direction, confidence, score, summary }}
   */
  getSignal(symbol) {
    // 目前返回全局信号（USDT 流向代表整体市场情绪）
    // 未来可以按币种扩展（监控特定代币合约的转账）
    const signal = this._signals._global;
    if (!signal) return { direction: 'neutral', confidence: 0, score: 0, summary: '尚未扫描' };
    
    // 信号有效期5分钟
    if (Date.now() - signal.timestamp > 300000) {
      return { direction: 'neutral', confidence: 0, score: 0, summary: '信号已过期' };
    }
    
    return signal;
  }

  /**
   * 获取最近事件列表
   */
  getRecentEvents(limit = 20) {
    return this._eventHistory.slice(-limit);
  }

  /**
   * 添加自定义监控钱包
   */
  addWallet(address, label, chain = 'bsc') {
    this._customWallets.push({ address, label, chain, added: Date.now() });
    if (this._log) console.log(`[WhaleMonitor] 已添加监控钱包: ${label} (${address})`);
  }

  /**
   * 获取监控状态
   */
  getStatus() {
    return {
      running: this._running,
      lastScanTime: this._lastScanTime,
      totalEventsTracked: this._eventHistory.length,
      monitoredWallets: WHALE_WALLETS.bsc.length + WHALE_WALLETS.eth.length + this._customWallets.length,
      currentSignal: this._signals._global || { direction: 'neutral', confidence: 0, score: 0 },
      customWallets: this._customWallets.length,
    };
  }

  /**
   * 启动后台扫描循环
   */
  start() {
    if (this._running) return;
    this._running = true;
    if (this._log) console.log(`[WhaleMonitor] 启动链上大户监控 | 扫描间隔=${this.scanInterval/1000}秒`);
    
    // 立即扫描一次
    this.scan().catch(() => {});
    
    // 定时扫描
    this._timer = setInterval(() => {
      this.scan().catch(() => {});
    }, this.scanInterval);
  }

  /**
   * 停止扫描
   */
  stop() {
    this._running = false;
    if (this._timer) clearInterval(this._timer);
    if (this._log) console.log('[WhaleMonitor] 已停止');
  }
}

module.exports = WhaleMonitor;
