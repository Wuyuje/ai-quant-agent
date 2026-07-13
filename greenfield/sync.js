/**
 * Greenfield 去中心化存储同步模块
 * 功能：备份 AI Quant Agent 代码和状态到 BNB Greenfield
 */

const { Client } = require('@bnb-chain/greenfield-js-sdk');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class GreenfieldSync {
  constructor() {
    this.config = require('../config/greenfield.json');
    this.wallet = null;
    this.client = null;
    this.address = '';
    this.isReady = false;
    this.syncHistory = [];
  }

  async init() {
    try {
      // 1. 从助记词恢复钱包
      this.wallet = ethers.Wallet.fromPhrase(
        this.config.wallet.mnemonics,
        this.config.wallet.derivationPath
      );
      this.address = this.wallet.address;

      // 2. 创建 Greenfield Client
      const chainId = this.config.greenfield.chainId;  // 5600 for testnet
      const rpcUrl = this.config.greenfield.rpcUrl;

      this.client = Client.create(rpcUrl, String(chainId));

      // 3. 验证连接 - 查询账户信息
      try {
        const accountInfo = await this.client.account.getAccount(this.address);
        console.log(`[Greenfield] 钱包地址: ${this.address}`);
        console.log(`[Greenfield] 账户序列号: ${accountInfo.sequence}`);
        console.log('[Greenfield] ✅ 连接成功');
        this.isReady = true;
        return true;
      } catch (e) {
        // 账户可能还没有 Greenfield 余额/序列号
        console.log(`[Greenfield] 钱包地址: ${this.address}`);
        console.log(`[Greenfield] ⚠️  账户查询失败: ${e.message}`);
        console.log('[Greenfield] 需要先给这个地址充值 BNB（Greenfield 测试网水龙头）');
        this.isReady = false;
        return false;
      }
    } catch (err) {
      console.error('[Greenfield] ❌ 初始化失败:', err.message);
      this.isReady = false;
      return false;
    }
  }

  /**
   * 创建 Bucket
   */
  async createBucket() {
    if (!this.isReady) {
      console.log('[Greenfield] ⏸️  未就绪，跳过创建 Bucket');
      return false;
    }

    try {
      const bucketName = this.config.greenfield.bucketName;

      // 检查 bucket 是否已存在
      try {
        await this.client.bucket.headBucket(bucketName);
        console.log(`[Greenfield] Bucket "${bucketName}" 已存在`);
        return true;
      } catch (e) {
        // Bucket 不存在，创建它
        console.log(`[Greenfield] 创建 Bucket "${bucketName}"...`);
      }

      const createBucketTx = await this.client.bucket.createBucket({
        bucketName,
        creator: this.address,
        visibility: 'VISIBILITY_PRIVATE',
        chargedReadQuota: '0',
        tags: { app: 'ai-quant-agent', version: '1.0.0' }
      });

      const simulateInfo = await createBucketTx.simulate({ denom: 'BNB' });

      const broadcastRes = await createBucketTx.broadcast({
        denom: 'BNB',
        gasLimit: Number(simulateInfo.gasLimit),
        gasPrice: simulateInfo.gasPrice,
        payer: this.address,
        privateKey: this.wallet.privateKey,
      });

      console.log(`[Greenfield] ✅ Bucket 创建成功: ${bucketName}`);
      return true;
    } catch (err) {
      console.error('[Greenfield] Bucket 创建失败:', err.message);
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
   * 收集要备份的文件
   */
  collectFiles() {
    const files = [];
    const baseDir = path.resolve(__dirname, '..');

    for (const item of this.config.autoSync.backupItems) {
      const fullPath = path.resolve(baseDir, item);
      if (!fs.existsSync(fullPath)) continue;

      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        files.push({
          localPath: fullPath,
          remotePath: item,
          hash: this.calculateFileHash(fullPath),
          size: stat.size
        });
      } else if (stat.isDirectory()) {
        this._walkDir(fullPath, baseDir, files);
      }
    }
    return files;
  }

  _walkDir(dir, baseDir, files) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', '.git'].includes(entry.name)) continue;
        this._walkDir(fullPath, baseDir, files);
      } else {
        files.push({
          localPath: fullPath,
          remotePath: path.relative(baseDir, fullPath),
          hash: this.calculateFileHash(fullPath),
          size: fs.statSync(fullPath).size
        });
      }
    }
  }

  /**
   * 上传单个文件
   */
  async uploadFile(fileInfo) {
    if (!this.isReady) throw new Error('Greenfield 未初始化');

    const fileContent = fs.readFileSync(fileInfo.localPath);
    const bucketName = this.config.greenfield.bucketName;
    const datePrefix = new Date().toISOString().split('T')[0];
    const objectName = `backup/${datePrefix}/${fileInfo.remotePath}`;

    const putObjectRes = await this.client.sp.putObject(
      { bucketName, objectName, body: fileContent, contentType: 'application/octet-stream' },
      { type: 'ECDSA', privateKey: this.wallet.privateKey }
    );

    console.log(`[Greenfield] ✅ 上传: ${objectName}`);
    return {
      objectName,
      hash: fileInfo.hash,
      size: fileInfo.size,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 完整备份
   */
  async fullBackup() {
    if (!this.isReady) {
      console.log('[Greenfield] ⏸️  未就绪，跳过备份');
      return false;
    }

    console.log('[Greenfield] 🚀 开始完整备份...');
    const startTime = Date.now();

    try {
      const files = this.collectFiles();
      console.log(`[Greenfield] 收集到 ${files.length} 个文件`);

      const results = [];
      for (const file of files) {
        try {
          const result = await this.uploadFile(file);
          results.push(result);
        } catch (err) {
          console.error(`[Greenfield] ❌ ${file.remotePath}: ${err.message}`);
        }
      }

      const elapsed = Date.now() - startTime;
      const summary = {
        timestamp: new Date().toISOString(),
        totalFiles: files.length,
        successFiles: results.length,
        failedFiles: files.length - results.length,
        elapsedMs: elapsed,
        files: results
      };

      this.syncHistory.push(summary);
      console.log(`[Greenfield] ✅ 备份完成: ${results.length}/${files.length} 文件, ${elapsed}ms`);

      this._saveHistory();
      return summary;
    } catch (err) {
      console.error('[Greenfield] ❌ 备份失败:', err.message);
      return false;
    }
  }

  _saveHistory() {
    const historyPath = path.join(__dirname, '../data/greenfield-history.json');
    const dir = path.dirname(historyPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // 只保留最近100条
    if (this.syncHistory.length > 100) this.syncHistory = this.syncHistory.slice(-100);
    fs.writeFileSync(historyPath, JSON.stringify(this.syncHistory, null, 2));
  }

  startAutoSync() {
    if (!this.config.autoSync.enabled) return;
    const ms = this.config.autoSync.intervalMs;
    console.log(`[Greenfield] ⏰ 自动备份已启动，间隔 ${ms / 60000} 分钟`);
    this._timer = setInterval(() => this.fullBackup().catch(() => {}), ms);
  }

  stopAutoSync() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  getStatus() {
    return {
      isReady: this.isReady,
      address: this.address,
      bucketName: this.config.greenfield.bucketName,
      autoSyncEnabled: this.config.autoSync.enabled,
      syncIntervalMin: this.config.autoSync.intervalMs / 60000,
      historyCount: this.syncHistory.length,
      lastSync: this.syncHistory.length > 0 ? this.syncHistory[this.syncHistory.length - 1] : null
    };
  }
}

module.exports = GreenfieldSync;
