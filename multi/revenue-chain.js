/**
 * RevenueChainClient — BSC 链上收益分配客户端
 * 
 * 负责：
 * 1. 调用 RevenueDistribution 合约的 distribute() 记录收益分配
 * 2. 查询链上收益记录
 * 3. 查询用户钱包余额和收益
 * 4. 提现用户收益
 */

const https = require('https');
const http = require('http');

// RevenueDistribution 合约 ABI（精简版）
const REVENUE_ABI = [
  'function distribute(uint256 userId, int256 pnlAmount) external',
  'function registerUser(uint256 userId, address wallet, uint8 subscription) external',
  'function updateWallet(uint256 userId, address newWallet) external',
  'function withdrawEarnings(uint256 userId) external',
  'function getUserRecord(uint256 userId) external view returns (tuple(address wallet, uint256 totalEarned, uint256 totalFee, uint256 lastDistribution, uint8 subscription, bool exists))',
  'function getUserEarnings(uint256 userId) external view returns (uint256)',
  'function getAllocationInfo() external view returns (uint256, uint256, uint256, address, address)',
  'event RevenueDistributed(uint256 indexed userId, uint256 pnlAmount, uint256 userShare, uint256 platformFee, uint256 ecoFund, uint256 timestamp)',
];

class RevenueChainClient {
  constructor(config = {}) {
    this.rpcUrl = config.rpcUrl || 'https://bsc-dataseed.binance.org';
    this.contractAddress = config.contractAddress || '';
    this.chainId = 56; // BSC Mainnet
    
    this.log = (msg) => console.log(`[RevenueChain] ${new Date().toISOString()} ${msg}`);
  }

  // ============ RPC 调用 ============
  async _rpc(method, params = []) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
        id: Date.now(),
      });

      const url = new URL(this.rpcUrl);
      const mod = url.protocol === 'https:' ? https : http;

      const req = mod.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) reject(new Error(json.error.message));
            else resolve(json.result);
          } catch (e) { reject(e); }
        });
      });

      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('RPC timeout')); });
      req.write(body);
      req.end();
    });
  }

  // ============ 合约交互 ============
  
  /**
   * 编码 distribute(userId, pnlAmount) 调用
   */
  _encodeDistribute(userId, pnlAmount) {
    // function selector: distribute(uint256,int256)
    const funcSig = 'distribute(uint256,int256)';
    const selector = this._functionSelector(funcSig);
    
    // userId (uint256) + pnlAmount (int256)
    const paddedUserId = this._toPaddedHex(userId);
    const paddedPnl = this._toPaddedHex(pnlAmount < 0 ? (BigInt(2) ** BigInt(256)) + BigInt(pnlAmount) : pnlAmount);
    
    return selector + paddedUserId + paddedPnl;
  }

  _functionSelector(sig) {
    // 简单的 keccak256 (生产环境用 ethers/web3)
    const crypto = require('crypto');
    // 这里用简化方式，实际部署时用 ethers.js
    return '0x' + crypto.createHash('sha256').update(sig).digest('hex').slice(0, 8);
  }

  _toPaddedHex(value) {
    const hex = BigInt(value).toString(16).padStart(64, '0');
    return hex;
  }

  /**
   * 记录收益分配到链上（发交易）
   * ⚠️ 需要私钥签名，生产环境用 ethers.js
   */
  async recordDistribution(userId, pnlAmount) {
    if (!this.contractAddress) {
      this.log('⚠️ 合约未部署，跳过链上记录');
      return null;
    }

    try {
      const data = this._encodeDistribute(userId, pnlAmount);
      
      // 获取 nonce
      const nonce = await this._rpc('eth_getTransactionCount', [
        process.env.PLATFORM_WALLET_ADDRESS,
        'latest'
      ]);

      // 构建交易（需要私钥签名后发送）
      const tx = {
        to: this.contractAddress,
        data,
        gas: '100000',
        nonce,
        chainId: '0x38', // BSC Mainnet
      };

      this.log(`📝 链上记录: userId=${userId}, pnl=$${pnlAmount}`);
      return tx; // 返回交易对象，由调用者签名发送
    } catch (e) {
      this.log(`❌ 链上记录失败: ${e.message}`);
      return null;
    }
  }

  /**
   * 查询用户链上收益
   */
  async getUserEarnings(userId) {
    if (!this.contractAddress) return null;
    
    try {
      // getUserEarnings(uint256) selector
      const data = '0x' + this._functionSelector('getUserEarnings(uint256)') + this._toPaddedHex(userId);
      
      const result = await this._rpc('eth_call', [{
        to: this.contractAddress,
        data,
      }, 'latest']);
      
      return BigInt(result);
    } catch (e) {
      this.log(`❌ 查询失败: ${e.message}`);
      return null;
    }
  }

  /**
   * 查询分配比例
   */
  async getAllocationInfo() {
    if (!this.contractAddress) return null;
    
    try {
      const data = '0x' + this._functionSelector('getAllocationInfo()');
      const result = await this._rpc('eth_call', [{
        to: this.contractAddress,
        data,
      }, 'latest']);
      
      return {
        userPct: parseInt(result.slice(0, 66), 16) / 100,
        platformPct: parseInt('0x' + result.slice(66, 130), 16) / 100,
        ecoPct: parseInt('0x' + result.slice(130, 194), 16) / 100,
      };
    } catch (e) {
      this.log(`❌ 查询分配比例失败: ${e.message}`);
      return null;
    }
  }

  /**
   * BSC 测试网水龙头（开发用）
   */
  async getTestnetFaucet(address) {
    // BSC Testnet Faucet
    this.log(`🚰 请求测试网水龙头: ${address}`);
    // 实际调用 BSC Testnet Faucet API
    return { success: false, message: '请访问 https://testnet.bnbchain.org/faucet-smart' };
  }
}

module.exports = RevenueChainClient;
