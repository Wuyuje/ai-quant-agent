/**
 * BSC 主网链上同步模块
 * 功能：备份 AI Quant Agent 代码和状态到 BSC 区块链
 * 方案：将文件内容哈希 + 关键数据存储到链上交易中
 * 优点：永久保存、不可篡改、成本极低（gas ≈ $0.001/笔）
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class BSCSync {
  constructor() {
    this.config = require('../config/greenfield.json');
    this.provider = null;
    this.wallet = null;
    this.address = '';
    this.isReady = false;
    this.syncHistory = [];
    this.lastSyncTime = 0;
    this.minSyncInterval = 300000; // 5分钟最小间隔
  }

  async init() {
    try {
      // 1. 连接 BSC 主网
      this.provider = new ethers.JsonRpcProvider('https://bsc-rpc.publicnode.com');

      // 2. 从助记词恢复钱包
      this.wallet = ethers.Wallet.fromPhrase(
        this.config.wallet.mnemonics,
        this.config.wallet.derivationPath
      ).connect(this.provider);
      this.address = this.wallet.address;

      // 3. 检查余额
      const balance = await this.provider.getBalance(this.address);
      const balanceBNB = parseFloat(ethers.formatEther(balance));

      if (balanceBNB < 0.0001) {
        console.log(`[BSCSync] ⚠️  BNB 余额不足: ${balanceBNB.toFixed(6)} BNB`);
        this.isReady = false;
        return false;
      }

      console.log(`[BSCSync] 钱包地址: ${this.address}`);
      console.log(`[BSCSync] BNB 余额: ${balanceBNB.toFixed(6)} BNB`);
      console.log(`[BSCSync] ✅ 连接成功`);
      this.isReady = true;
      return true;
    } catch (err) {
      console.error('[BSCSync] ❌ 初始化失败:', err.message);
      this.isReady = false;
      return false;
    }
  }

  /**
   * 计算文件哈希
   */
  calculateFileHash(filePath) {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * 收集要备份的文件（简化版：只收集关键文件哈希）
   */
  collectKeyFiles() {
    const files = [];
    const baseDir = path.resolve(__dirname, '..');
    const keyFiles = [
      'engine.js', 'index.js', 'package.json',
      'brain/ai-engine.js', 'brain/onchain-brain.js', 'brain/deepseek-brain.js',
      'executor/trader.js', 'safety/guardian.js', 'data/databus.js',
      'config/default.json', 'config/trading-pairs.js'
    ];

    for (const item of keyFiles) {
      const fullPath = path.resolve(baseDir, item);
      if (!fs.existsSync(fullPath)) continue;

      const hash = this.calculateFileHash(fullPath);
      const stat = fs.statSync(fullPath);
      files.push({
        name: item,
        hash: hash,
        size: stat.size,
        modified: stat.mtime.toISOString()
      });
    }
    return files;
  }

  /**
   * 收集运行状态
   */
  collectStatus() {
    const stateFile = path.resolve(__dirname, '../data/engine_state.json');
    let state = {};
    if (fs.existsSync(stateFile)) {
      try {
        state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      } catch (e) { console.error(`[BSCSync] collectStatus parse failed: ${e.message}`); }
    }

    return {
      balance: 0,
      positions: [],
      totalPnl: 0,
      trades: 0,
      ...state
    };
  }

  /**
   * 发送链上备份交易
   */
  async sendBackupTransaction(files, status) {
    if (!this.isReady) throw new Error('BSCSync 未就绪');

    // 构建备份数据
    const backupData = {
      version: '2.0',
      timestamp: new Date().toISOString(),
      agent: 'AI-Quant-Agent',
      files: files.map(f => ({ name: f.name, hash: f.hash, size: f.size })),
      status: {
        totalPnl: status.totalPnl || 0,
        trades: status.trades || 0,
        balance: status.balance || 0
      }
    };

    // 转换为十六进制数据
    const dataStr = JSON.stringify(backupData);
    const dataHex = '0x' + Buffer.from(dataStr).toString('hex');

    // 获取 nonce
    const nonce = await this.provider.getTransactionCount(this.address);
    const gasPrice = await this.provider.getGasPrice();

    // 构建交易（发送给自己，data 字段存储备份）
    const tx = {
      to: this.address,  // 发送给自己
      value: ethers.parseEther('0'),  // 不转 BNB
      gasLimit: 100000,  // 足够的 gas
      gasPrice: gasPrice,
      nonce: nonce,
      data: dataHex,  // 存储备份数据
      chainId: 56  // BSC 主网
    };

    // 签名并发送
    const signedTx = await this.wallet.signTransaction(tx);
    const txResponse = await this.provider.sendTransaction(signedTx);

    console.log(`[BSCSync] 📤 交易已发送: ${txResponse.hash}`);

    // 等待确认
    const receipt = await txResponse.wait(1);
    console.log(`[BSCSync] ✅ 交易确认: 区块 ${receipt.blockNumber}, Gas ${receipt.gasUsed.toString()}`);

    return {
      txHash: txResponse.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 完整备份
   */
  async fullBackup() {
    if (!this.isReady) {
      console.log('[BSCSync] ⏸️  未就绪，跳过备份');
      return false;
    }

    // 检查最小间隔
    const now = Date.now();
    if (now - this.lastSyncTime < this.minSyncInterval) {
      console.log('[BSCSync] ⏸️  距上次备份不足 5 分钟，跳过');
      return false;
    }

    console.log('[BSCSync] 🚀 开始完整备份...');
    const startTime = Date.now();

    try {
      // 1. 收集文件
      const files = this.collectKeyFiles();
      console.log(`[BSCSync] 收集到 ${files.length} 个关键文件`);

      // 2. 收集状态
      const status = this.collectStatus();

      // 3. 发送链上交易
      const txResult = await this.sendBackupTransaction(files, status);

      const elapsed = Date.now() - startTime;
      const summary = {
        timestamp: new Date().toISOString(),
        totalFiles: files.length,
        txHash: txResult.txHash,
        blockNumber: txResult.blockNumber,
        gasUsed: txResult.gasUsed,
        elapsedMs: elapsed,
        files: files.map(f => ({ name: f.name, hash: f.hash }))
      };

      this.syncHistory.push(summary);
      this.lastSyncTime = now;

      // 保留最近 100 条
      if (this.syncHistory.length > 100) {
        this.syncHistory = this.syncHistory.slice(-100);
      }

      console.log(`[BSCSync] ✅ 备份完成: ${summary.totalFiles} 文件, Tx: ${summary.txHash.slice(0,16)}...`);
      this._saveHistory();

      return summary;
    } catch (err) {
      console.error('[BSCSync] ❌ 备份失败:', err.message);
      return false;
    }
  }

  /**
   * 保存同步历史
   */
  _saveHistory() {
    const historyPath = path.join(__dirname, '../data/bsc-sync-history.json');
    const dir = path.dirname(historyPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(historyPath, JSON.stringify(this.syncHistory, null, 2));
  }

  /**
   * 启动自动同步
   */
  startAutoSync(intervalMs = 7200000) { // 默认 2 小时
    if (!this.config.autoSync.enabled) return;
    console.log(`[BSCSync] ⏰ 自动备份已启动，间隔 ${intervalMs / 60000} 分钟`);
    this._timer = setInterval(() => {
      this.fullBackup().catch(() => {});
    }, intervalMs);
  }

  /**
   * 停止自动同步
   */
  stopAutoSync() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      console.log('[BSCSync] ⏸️  自动备份已停止');
    }
  }

  /**
   * 获取状态
   */
  getStatus() {
    return {
      isReady: this.isReady,
      address: this.address,
      network: 'BSC Mainnet',
      historyCount: this.syncHistory.length,
      lastSync: this.syncHistory.length > 0 ? this.syncHistory[this.syncHistory.length - 1] : null,
      autoSyncEnabled: this.config.autoSync.enabled
    };
  }
}

module.exports = BSCSync;
