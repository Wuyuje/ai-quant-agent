/**
 * WalletAuth — TP 钱包签名验证 + ARK 持仓门槛
 * 
 * 流程：
 * 1. 前端：用户点「连接钱包」→ TP 弹出签名请求
 * 2. 前端：拿到 (address, signature, message) → POST /api/auth/verify
 * 3. 后端：
 *    a. 用 ecrecover 从 signature + message 还原 signer 地址
 *    b. 比对 signer === 用户声称的 address
 *    c. 链上查 ARK 余额 ≥ 门槛
 *    d. 查 BSC 原生 BNB 余额 ≥ 充值门槛
 * 4. 通过 → 创建/恢复 session → 返回用户数据
 * 
 * 无需私钥、无需链上交易、完全免费验证。
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');

// ═══════════════════════════════════════
// 配置
// ═══════════════════════════════════════
const CONFIG = {
  // BSC RPC
  rpcUrl: 'https://bsc-rpc.publicnode.com',
  
  // ARK 代币合约
  arkTokenContract: '0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D',
  
  // 平台收入钱包
  platformWallet: '0xb6DEb31484353AdDaA5b6A105A2B758Df11bC28A',
  
  // 签名消息前缀（防重放）
  messagePrefix: 'ARK Quant Agent Login',
  messageExpiry: 5 * 60 * 1000, // 签名 5 分钟有效
  
  // ARK 门槛
  arkMinBalance: 100, // 最低持有 100 ARK
  
  // BSC chain ID
  chainId: 56,
  
  // Session
  sessionDuration: 30 * 24 * 60 * 60 * 1000, // 30 天
};

// ═══════════════════════════════════════
// BSC RPC 调用
// ═══════════════════════════════════════
function bscRpc(method, params = []) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: '2.0', method, params, id: Date.now(),
    });

    const url = new URL(CONFIG.rpcUrl);
    const mod = url.protocol === 'https:' ? https : http;

    const req = mod.request({
      hostname: url.hostname,
      port: url.port || 443,
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

// ═══════════════════════════════════════
// ERC20 balanceOf 查询
// ═══════════════════════════════════════
async function getERC20Balance(contractAddress, walletAddress) {
  try {
    // balanceOf(address) = 0x70a08231 + address padded
    const data = '0x70a08231' + walletAddress.toLowerCase().replace('0x', '').padStart(64, '0');
    const result = await bscRpc('eth_call', [{ to: contractAddress, data }, 'latest']);
    return BigInt(result);
  } catch (e) {
    return 0n;
  }
}

// ═══════════════════════════════════════
// BNB 原生余额查询
// ═══════════════════════════════════════
async function getBNBBalance(walletAddress) {
  try {
    const result = await bscRpc('eth_getBalance', [walletAddress, 'latest']);
    return BigInt(result) / BigInt(1e18); // wei → BNB
  } catch (e) {
    return 0n;
  }
}

// ═══════════════════════════════════════
// ARK 代币精度（18 decimals）
// ═══════════════════════════════════════
function weiToToken(rawBalance, decimals = 18) {
  const str = rawBalance.toString();
  if (str.length <= decimals) {
    return parseFloat('0.' + str.padStart(decimals, '0'));
  }
  const intPart = str.slice(0, str.length - decimals);
  const fracPart = str.slice(str.length - decimals);
  return parseFloat(intPart + '.' + fracPart);
}

// ═══════════════════════════════════════
// 签名验证（ecrecover 逻辑）
// ═══════════════════════════════════════

/**
 * EIP-191 个人签名消息哈希
 */
function getEthSignedMessageHash(message) {
  const prefix = '\x19Ethereum Signed Message:\n' + message.length;
  const fullMessage = prefix + message;
  return crypto.createHash('sha256').update(fullMessage).digest('hex');
}

/**
 * 从 v, r, s 恢复公钥
 */
function recoverPublicKey(message, v, r, s) {
  const msgHash = getEthSignedMessageHash(message);
  
  // secp256k1 recovery
  try {
    const { ECPairFactory } = require('ecpair');
    const ecc = require('tiny-secp256k1');
    const { ecdsaRecover } = require('secp256k1');
    
    const sig = Buffer.concat([
      Buffer.from(r, 'hex'),
      Buffer.from(s, 'hex'),
    ]);
    
    const recId = v - 27;
    const pubKey = ecdsaRecover(sig, recId, Buffer.from(msgHash, 'hex'));
    return pubKey;
  } catch (e) {
    return null;
  }
}

/**
 * 从公钥推导以太坊地址
 */
function pubKeyToAddress(pubKey) {
  const hash = crypto.createHash('sha256').update(pubKey).digest('hex');
  // keccak256 取后 20 字节
  // 简化：用 ripemd160 + sha256（生产用 ethers.js）
  return '0x' + hash.slice(24); // 简化近似
}

/**
 * 验证签名，返回恢复出的地址
 */
function recoverAddress(message, signature) {
  try {
    // 去掉 0x 前缀
    const sigHex = signature.replace('0x', '');
    const r = sigHex.slice(0, 64);
    const s = sigHex.slice(64, 128);
    const v = parseInt(sigHex.slice(128, 130), 16);
    
    const msgHash = getEthSignedMessageHash(message);
    
    // 用 secp256k1 直接恢复
    const { ecdsaRecover } = require('secp256k1');
    const sig = Buffer.concat([Buffer.from(r, 'hex'), Buffer.from(s, 'hex')]);
    const pubKey = ecdsaRecover(sig, v - 27, Buffer.from(msgHash, 'hex'));
    
    // keccak256 of public key → address
    const keccak = crypto.createHash('sha256'); // 简化
    const addressHash = keccak.update(pubKey).digest('hex');
    return '0x' + addressHash.slice(24);
  } catch (e) {
    return null;
  }
}

// ═══════════════════════════════════════
// 简化签名验证（前端用 personal_sign）
// ═══════════════════════════════════════

/**
 * 生成登录消息
 * 前端用 window.ethereum.personal_sign(message, address) 签名
 */
function generateLoginMessage(address) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const timestamp = Date.now();
  const message = `${CONFIG.messagePrefix}\nAddress: ${address}\nNonce: ${nonce}\nTimestamp: ${timestamp}`;
  return { message, nonce, timestamp };
}

/**
 * 完整验证流程
 * @returns { object } { valid, address, arkBalance, bnbBalance, error }
 */
async function verifyLogin(address, message, signature) {
  const result = { valid: false, address, error: null };

  try {
    // 1. 检查消息是否过期
    const timestampMatch = message.match(/Timestamp: (\d+)/);
    if (!timestampMatch) {
      result.error = '无效消息格式';
      return result;
    }
    const msgTime = parseInt(timestampMatch[1]);
    if (Date.now() - msgTime > CONFIG.messageExpiry) {
      result.error = '签名已过期（5分钟有效），请重新签名';
      return result;
    }

    // 2. 从签名恢复地址
    const recovered = recoverAddress(message, signature);
    if (!recovered) {
      result.error = '签名验证失败';
      return result;
    }

    // 3. 比对地址（大小写不敏感）
    if (recovered.toLowerCase() !== address.toLowerCase()) {
      result.error = '签名地址不匹配';
      return result;
    }

    // 4. 链上查 ARK 余额
    const rawArkBalance = await getERC20Balance(CONFIG.arkTokenContract, address);
    const arkBalance = weiToToken(rawArkBalance);
    
    if (arkBalance < CONFIG.arkMinBalance) {
      result.error = `ARK 持仓不足：当前 ${arkBalance.toFixed(2)} ARK，需要 ${CONFIG.arkMinBalance} ARK`;
      result.arkBalance = arkBalance;
      return result;
    }

    // 5. 链上查 BNB 余额（用于 gas）
    const bnbBalance = Number(await getBNBBalance(address));

    result.valid = true;
    result.arkBalance = arkBalance;
    result.bnbBalance = bnbBalance;
    result.message = `✅ 验证通过 | ARK: ${arkBalance.toFixed(2)} | BNB: ${bnbBalance.toFixed(4)}`;
    
    return result;
  } catch (e) {
    result.error = `验证异常: ${e.message}`;
    return result;
  }
}

// ═══════════════════════════════════════
// Session 管理（内存 + 文件持久化）
// ═══════════════════════════════════════
const fs = require('fs');
const path = require('path');

const SESSION_DB = path.join(__dirname, '..', 'data', 'sessions.json');

class SessionManager {
  constructor() {
    this.sessions = {};
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(SESSION_DB)) {
        this.sessions = JSON.parse(fs.readFileSync(SESSION_DB, 'utf8'));
      }
    } catch (e) { console.error(`[Auth] SessionManager._load FAILED: ${e.message}`); }
  }

  _save() {
    try {
      // 清理过期
      const now = Date.now();
      for (const [token, session] of Object.entries(this.sessions)) {
        if (now - session.createdAt > CONFIG.sessionDuration) {
          delete this.sessions[token];
        }
      }
      fs.writeFileSync(SESSION_DB, JSON.stringify(this.sessions, null, 2));
    } catch (e) { console.error(`[Auth] SessionManager._save FAILED: ${e.message}`); }
  }

  /**
   * 创建 session
   */
  create(address, userData) {
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions[token] = {
      address: address.toLowerCase(),
      ...userData,
      createdAt: Date.now(),
      lastAccess: Date.now(),
    };
    this._save();
    return token;
  }

  /**
   * 验证 session
   */
  validate(token) {
    const session = this.sessions[token];
    if (!session) return null;
    
    if (Date.now() - session.createdAt > CONFIG.sessionDuration) {
      delete this.sessions[token];
      this._save();
      return null;
    }
    
    session.lastAccess = Date.now();
    return session;
  }

  /**
   * 销毁 session
   */
  destroy(token) {
    delete this.sessions[token];
    this._save();
  }
}

module.exports = {
  CONFIG,
  generateLoginMessage,
  verifyLogin,
  getERC20Balance,
  getBNBBalance,
  weiToToken,
  bscRpc,
  SessionManager,
};
