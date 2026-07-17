/**
 * SaaS Platform v92 — 纯 CEX 模式
 *
 * 用户流程：
 *   1. 注册账号（钱包地址+密码）
 *   2. 绑定 Binance API Key
 *   3. 充值 USDT 到 Binance 合约账户
 *   4. 开启自动交易
 *   5. 全自动交易
 *
 * v92: 链上合约已分离，后期新合约部署后可重新接入
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

// ═══ AES-256-GCM 加密/解密（用于 API Key 存储）═══
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || process.env.ENCRYPT_KEY; // 统一用 ENCRYPTION_KEY
if (!ENCRYPTION_KEY) { console.error('[FATAL] ENCRYPTION_KEY not set in .env'); process.exit(1); }
function encryptText(plaintext) {
  if (!plaintext) return plaintext;
  try {
    const iv = crypto.randomBytes(12);
    const key = Buffer.from(ENCRYPTION_KEY, 'hex');
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted.toString('hex');
  } catch (e) { return plaintext; }
}
function decryptText(ciphertext) {
  if (!ENCRYPTION_KEY || !ciphertext) return ciphertext;
  // 如果不是加密格式（旧数据明文），直接返回
  const parts = ciphertext.split(':');
  if (parts.length !== 3) return ciphertext;
  try {
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const encrypted = Buffer.from(parts[2], 'hex');
    const key = Buffer.from(ENCRYPTION_KEY, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted, undefined, 'utf8') + decipher.final('utf8');
  } catch (e) { return ciphertext; }
}
function isEncrypted(text) {
  return text && typeof text === 'string' && text.split(':').length === 3;
}

// v14: nonce 防重放
const _usedNonces = new Map(); // nonce → expireTime
function isNonceUsed(nonce) {
  return _usedNonces.has(nonce);
}
function markNonceUsed(nonce) {
  _usedNonces.set(nonce, Date.now() + 300000); // 5分钟过期
  // 清理旧 nonce
  if (_usedNonces.size > 100) {
    const now = Date.now();
    for (const [k, v] of _usedNonces) { if (v < now) _usedNonces.delete(k); }
  }
}
// [audit#16] 定时清理 nonce，防止内存泄漏
setInterval(() => {
  if (_usedNonces.size > 0) {
    const now = Date.now();
    for (const [k, v] of _usedNonces) { if (v < now) _usedNonces.delete(k); }
  }
}, 300000); // 每5分钟清理

// v14: 简易内存限流器 (IP → {count, resetAt})
const _rateLimits = new Map();
function rateLimit(key, maxHits = 10, windowMs = 60000) {
  const now = Date.now();
  const entry = _rateLimits.get(key);
  if (!entry || now > entry.resetAt) {
    _rateLimits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  entry.count++;
  if (entry.count > maxHits) return false;
  return true;
}

// ─── 账号级暴力破解保护 ───
const _loginFailures = new Map(); // username → { count, lockUntil }
function checkAccountLock(username) {
  const entry = _loginFailures.get(username);
  if (!entry) return { locked: false };
  if (entry.lockUntil && Date.now() < entry.lockUntil) {
    const remainMin = Math.ceil((entry.lockUntil - Date.now()) / 60000);
    return { locked: true, remainMin };
  }
  if (entry.lockUntil && Date.now() >= entry.lockUntil) {
    _loginFailures.delete(username); // 锁定过期，清除
    return { locked: false };
  }
  return { locked: false };
}
function recordLoginFailure(username) {
  const entry = _loginFailures.get(username) || { count: 0 };
  entry.count++;
  if (entry.count >= 5) {
    entry.lockUntil = Date.now() + 15 * 60 * 1000; // 5次失败锁定15分钟
    console.log(`[Security] 🔒 账号 ${username.slice(0,10)}... 锁定15分钟 (连续${entry.count}次失败)`);
  }
  _loginFailures.set(username, entry);
}
function clearLoginFailure(username) {
  _loginFailures.delete(username);
}
// 定时清理过期锁定
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _loginFailures) {
    if (v.lockUntil && now >= v.lockUntil) _loginFailures.delete(k);
  }
}, 300000);

// ─── 待充值列表（部署失败时记录，充值成功后清除） ───
const pendingFundRequests = new Map(); // userAddress → { wallet, amount, reason, timestamp }

// ─── 配置 ───
const BSC_RPC_LIST = [
  'https://bsc-rpc.publicnode.com',
  'https://bsc.drpc.org',
  'https://1rpc.io/bnb',
];
let _rpcIndex = 0;
function BSC_RPC() { return BSC_RPC_LIST[_rpcIndex % BSC_RPC_LIST.length]; }
function rotateRpc() { _rpcIndex = (_rpcIndex + 1) % BSC_RPC_LIST.length; }
// [audit#26] ethers v6 url.clone bug workaround
const { ethers: _ethers } = require('ethers');
class BscRpcProvider extends _ethers.JsonRpcProvider {
  constructor(url) { super(url); }
  async _send(rpcReq) {
    const url = this._getConnection().url;
    const resp = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rpcReq),
    });
    return await resp.json();
  }
}
function getProvider() { return new BscRpcProvider(BSC_RPC()); }
const PANCAKE_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955';
const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const ARK_TOKEN = '0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D';
const PLATFORM_WALLET = '0xb6DEb31484353AdDaA5b6A105A2B758Df11bC28A';  // 服务费接收地址
const PLATFORM_FEE_BPS = 2000; // 20%
// Vault Factory 合约（V3: 完全修复版 — encodePacked bug + 18位小数 + ownership 归用户）
const VAULT_FACTORY = process.env.VAULT_FACTORY_ADDRESS || '0x2A38B82Dd59cBDF8DE7e61338f88B3dA225b8A3d';
// RevenueDistribution 合约（盖茨费自动分配: 20%服务费 + 10%生态费）
const REVENUE_DISTRIBUTION = process.env.REVENUE_DISTRIBUTION_ADDRESS || '';
// 生态基金钱包（10%）
const ECO_FUND_WALLET = '0xeF87e7fD5f0ADC5de82e84Dc9300002D9aC8bD82';
// 平台执行器私钥（用于签名交易，存在环境变量里）
// [SECURITY#1-HIGH] 私钥不应硬编码在源码中，生产环境必须通过环境变量注入
const TRADER_PRIVATE_KEY = process.env.TRADER_PRIVATE_KEY;
if (!TRADER_PRIVATE_KEY) { console.error('[FATAL] TRADER_PRIVATE_KEY not set in .env'); process.exit(1); }
if (!TRADER_PRIVATE_KEY) { console.error('❌ TRADER_PRIVATE_KEY 未配置！请设置环境变量。'); }
// v16: 管理员密钥
// [SECURITY#2-MEDIUM] 管理员密钥硬编码，生产环境应改用JWT+数据库存储
const ADMIN_KEY = process.env.ADMIN_KEY;
if (!ADMIN_KEY) { console.error('[FATAL] ADMIN_KEY not set in .env'); process.exit(1); }

// 用户数据库
const USER_DB = path.join(__dirname, '..', 'data', 'saas-users.json');
// v83: DataStore 抽象层（JSON ↔ Redis 无缝切换）
const { getDataStore } = require('./data-store');
const _store = getDataStore({ dir: path.join(__dirname, '..', 'data') });

// ═══════════════════════════════════
// BSC RPC 工具
// ═══════════════════════════════════
function bscRpc(method, params = [], rpcUrl) {
  return new Promise((resolve, reject) => {
    const targetUrl = rpcUrl || BSC_RPC();
    const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: Date.now() });
    const url = new URL(targetUrl);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: url.hostname, port: url.port || 443, path: url.pathname,
      method: 'POST', headers: { 'Content-Type': 'application/json' },
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
    req.on('error', (err) => {
      // [audit#18] 只在限频和超时时旋转 RPC
      const isRateLimit = err.message?.includes('Way too many') || err.message?.includes('banned');
      const isTimeout = err.message?.includes('timeout') || err.code === 'ETIMEDOUT';
      if (isRateLimit || isTimeout) rotateRpc();
      reject(err);
    });
    req.setTimeout(10000, () => { req.destroy(); rotateRpc(); reject(new Error('RPC timeout')); });
    req.write(body);
    req.end();
  });
}

// 查询 ERC20 余额
async function erc20Balance(token, wallet, rpcUrl) {
  const data = '0x70a08231' + wallet.toLowerCase().replace('0x', '').padStart(64, '0');
  const raw = await bscRpc('eth_call', [{ to: token, data }, 'latest'], rpcUrl);
  return BigInt(raw);
}

// [audit#3] 余额查询缓存（10秒TTL，避免RPC限频）
const _balanceCache = new Map(); // key: `${wallet}:${token}` → { data, expireAt }
async function cachedErc20Balance(token, wallet, rpcUrl, ttlMs = 10000) {
  const key = `${wallet.toLowerCase()}:${token}`;
  const cached = _balanceCache.get(key);
  if (cached && Date.now() < cached.expireAt) return cached.data;
  const data = await erc20Balance(token, wallet, rpcUrl);
  _balanceCache.set(key, { data, expireAt: Date.now() + ttlMs });
  return data;
}
async function cachedBnbBalance(wallet, ttlMs = 10000) {
  const key = `${wallet.toLowerCase()}:bnb`;
  const cached = _balanceCache.get(key);
  if (cached && Date.now() < cached.expireAt) return cached.data;
  const rawBnb = await bscRpc('eth_getBalance', [wallet, 'latest']);
  const data = Number(BigInt(rawBnb)) / 1e18;
  _balanceCache.set(key, { data, expireAt: Date.now() + ttlMs });
  return data;
}

// ethers v6 地址 checksum 兼容：先把地址统一成小写再 checksum，避免 INVALID_ARGUMENT
function fixAddr(addr) {
  if (!addr || typeof addr !== 'string') return addr;
  try { return require('ethers').getAddress(addr); } catch { return addr; }
}
// 递归修复 args 中的所有地址字符串（0x 开头 42 字符）
function fixArgs(args) {
  return (args || []).map(a => (typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)) ? fixAddr(a) : a);
}

// 查询合约方法（view/pure）
async function callContract(to, iface, method, args) {
  const { ethers } = require('ethers');
  const coder = new ethers.Interface(iface);
  const data = coder.encodeFunctionData(method, fixArgs(args));
  const raw = await bscRpc('eth_call', [{ to, data }, 'latest']);
  return coder.decodeFunctionResult(method, raw);
}

// 发送交易（需要私钥）
// [audit#23] 全局交易并发限制
const _sendTxQueue = [];
let _sendTxActive = 0;
const MAX_CONCURRENT_TX = 3;
async function sendTx(to, data, value = 0n) {
  if (_sendTxActive >= MAX_CONCURRENT_TX) {
    // 排队等待
    await new Promise(r => _sendTxQueue.push(r));
  }
  _sendTxActive++;
  try {
    return await _doSendTx(to, data, value);
  } finally {
    _sendTxActive--;
    if (_sendTxQueue.length > 0) _sendTxQueue.shift()();
  }
}
async function _doSendTx(to, data, value = 0n) {
  if (!TRADER_PRIVATE_KEY) throw new Error('TRADER_PRIVATE_KEY not set');
  const { ethers } = require('ethers');
  const provider = getProvider();
  const wallet = new ethers.Wallet(TRADER_PRIVATE_KEY, provider);

  // v20: 用 signTransaction + eth_sendRawTransaction 绕过 ethers v6 sendTransaction data bug
  let gasLimit;
  try {
    const estimated = await provider.estimateGas({ from: wallet.address, to, data, value });
    gasLimit = BigInt(Math.ceil(Number(estimated) * 1.3));
    console.log(`[sendTx] gas: ${estimated} → limit: ${gasLimit}`);
  } catch (e) {
    gasLimit = 3000000n;
    console.log(`[sendTx] gas fallback: ${e.message?.slice(0,80)}`);
  }

  const chainId = 56; // BSC
  const nonce = await provider.getTransactionCount(wallet.address);
  const tx = {
    type: 0,
    nonce,
    gasPrice: ethers.parseUnits('3', 'gwei'),
    gasLimit,
    to,
    value,
    data,
    chainId,
  };

  const signedTx = await wallet.signTransaction(tx);
  const sendResult = await bscRpc('eth_sendRawTransaction', [signedTx]);
  if (sendResult.error) throw new Error('Raw tx failed: ' + sendResult.error.message);
  const txHash = sendResult.result;
  console.log(`[sendTx] sent (raw): ${txHash}`);

  // 轮询等待确认
  const MAX_WAIT = 120000;
  const INTERVAL = 3000;
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT) {
    await new Promise(r => setTimeout(r, INTERVAL));
    try {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt) {
        console.log(`[sendTx] confirmed: status=${receipt.status} gas=${receipt.gasUsed}`);
        return receipt;
      }
    } catch (e) {
      console.log(`[sendTx] poll err: ${e.message?.slice(0,60)}`);
    }
  }
  throw new Error('Transaction timeout: not confirmed within 120s');
}

// ═══════════════════════════════════
// 用户数据库
// ═══════════════════════════════════
class UserDB {
  constructor() {
    this.users = {};
    this._load();
  }
  async _load() {
    try {
      // v83: 优先用 DataStore（Redis/JSON）
      const data = await _store.get('saas-users');
      if (data) { this.users = data; return; }
      // 回退：兼容旧文件
      if (fs.existsSync(USER_DB)) {
        this.users = JSON.parse(fs.readFileSync(USER_DB, 'utf8'));
        await _store.set('saas-users', this.users);
      }
    } catch (e) { console.error(`[SaaS] UserDB._load FAILED: ${e.message}`); }
  }
  async _save() {
    // v83: 通过 DataStore 保存（支持 JSON/Redis）
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(async () => {
      try {
        await _store.set('saas-users', this.users);
      } catch (e) { console.error(`[SaaS] UserDB._save FAILED: ${e.message}`); }
    }, 500);
  }
  get(wallet) {
    return this.users[wallet.toLowerCase()] || null;
  }
  set(wallet, data) {
    const key = wallet.toLowerCase();
    if (!this.users[key]) {
      this.users[key] = { createdAt: Date.now(), ...data };
    } else {
      Object.assign(this.users[key], data, { lastActive: Date.now() });
    }
    this._save();
    return this.users[key];
  }
  // v19: 用户名登录相关方法
  getByUsername(username) {
    const key = username.toLowerCase();
    for (const [wallet, user] of Object.entries(this.users)) {
      if (user.username && user.username.toLowerCase() === key) return user;
    }
    return null;
  }
  createWithAuth(username, salt, hash, token, walletAddress) {
    // 如果没有提供钱包地址，生成一个虚拟地址用于标识
    const addr = (walletAddress || '0x' + crypto.randomBytes(20).toString('hex')).toLowerCase();
    this.users[addr] = {
      createdAt: Date.now(),
      username,
      salt,
      passwordHash: hash,
      authToken: token,
      walletAddress: addr,
      // 注册的钱包地址自动作为BSC钱包地址（用于盖茨费）
      bscWalletAddr: addr,
      strategy: 'bb',
      tradingEnabled: false,
      withdrawConsent: false,
    };
    this._save();
    return this.users[addr];
  }
  updateToken(username, token) {
    for (const [wallet, user] of Object.entries(this.users)) {
      if (user.username && user.username.toLowerCase() === username.toLowerCase()) {
        user.authToken = token;
        this._save();
        return;
      }
    }
  }
}

// ═══════════════════════════════════
// Session 管理（v17: 文件持久化）
// ═══════════════════════════════════
const SESSION_FILE = path.join(__dirname, '..', 'data', 'saas-sessions.json');
const sessions = new Map();

async function _loadSessions() {
  try {
    // v83: 优先用 DataStore
    const data = await _store.get('saas-sessions');
    if (data) {
      const now = Date.now();
      for (const [k, v] of Object.entries(data)) {
        if (v.createdAt && now - v.createdAt < 30 * 24 * 60 * 60 * 1000) sessions.set(k, v);
      }
      console.log(`[SaaS] 恢复 ${sessions.size} 个 session`);
      return;
    }
    // 回退：兼容旧文件
    if (fs.existsSync(SESSION_FILE)) {
      const data2 = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      const now = Date.now();
      for (const [k, v] of Object.entries(data2)) {
        if (v.createdAt && now - v.createdAt < 30 * 24 * 60 * 60 * 1000) sessions.set(k, v);
      }
      console.log(`[SaaS] 恢复 ${sessions.size} 个 session`);
    }
  } catch(e) { console.error(`[SaaS] 加载 session 失败: ${e.message}`); }
}
let _sessionSaveTimer = null;
function _saveSessions(debounceMs = 5000) {
  if (_sessionSaveTimer) clearTimeout(_sessionSaveTimer);
  _sessionSaveTimer = setTimeout(() => {
    _sessionSaveTimer = null;
    _doSaveSessions();
  }, debounceMs);
}
// [audit#5] 立即写入（用于登录/登出等关键操作）
function _saveSessionsImmediate() {
  if (_sessionSaveTimer) clearTimeout(_sessionSaveTimer);
  _sessionSaveTimer = null;
  _doSaveSessions();
}
async function _doSaveSessions() {
  try {
    const obj = {};
    for (const [k, v] of sessions) obj[k] = v;
    // v83: 通过 DataStore 保存
    await _store.set('saas-sessions', obj);
  } catch(e) { console.error(`[SaaS] 保存 session 失败: ${e.message}`); }
}
_loadSessions().catch(e => console.error('[SaaS] session init error:', e.message));

// v18: 定时清理过期 session（每 10 分钟）
setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 24 * 60 * 60 * 1000;
  let cleaned = 0;
  for (const [k, v] of sessions) {
    if (v.createdAt && now - v.createdAt > maxAge) { sessions.delete(k); cleaned++; }
  }
  if (cleaned > 0) { console.log(`[SaaS] 清理 ${cleaned} 个过期 session`); _saveSessions(); }
}, 600000);

function createSession(wallet, userData) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { wallet: wallet.toLowerCase(), ...userData, createdAt: Date.now() });
  _saveSessionsImmediate(); // [audit#5] 登录时立即写入
  return token;
}
function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > 24 * 60 * 60 * 1000) { sessions.delete(token); _saveSessions(); return null; } // 24h 过期
  return s;
}

// v113.66: 暴露 getSession 到全局，让 dashboard/server.js 也能验证用户 token
global.getSession = getSession;
global._saasSessions = sessions;

// ═══════════════════════════════════
// 签名验证
// ═══════════════════════════════════
function verifyEthereumSignature(message, signature, expectedAddress) {
  try {
    const { ethers } = require('ethers');
    if (typeof signature !== 'string' || !signature.startsWith('0x')) {
      console.log('[签名] signature 格式无效:', typeof signature, signature?.substring(0, 10));
      return false;
    }
    const expected = expectedAddress.toLowerCase();

    // v19: 增强签名验证 — 支持所有主流钱包（TP/MetaMask/OKX/BSC Wallet/Trust）

    // 方法1: ethers v6 verifyMessage（标准 EIP-191 personal_sign）
    // MetaMask personal_sign、Trust Wallet、新版 TP 都用这个
    try {
      const recovered = ethers.verifyMessage(message, signature);
      if (recovered.toLowerCase() === expected) {
        console.log('[签名] ✅ 方法1 verifyMessage 匹配');
        return true;
      }
    } catch(e) { /* 继续 */ }

    // 方法2: 有些 TP/OKX 钱包会返回带 v=0/1（而非 v=27/28）的签名
    // ethers 会自动处理，但如果方法1失败，尝试调整 v 值
    try {
      const sigBytes = ethers.getBytes(signature);
      if (sigBytes.length === 65) {
        let v = sigBytes[64];
        if (v < 27) {
          const adjusted = ethers.hexlify(new Uint8Array([...sigBytes.slice(0, 64), v + 27]));
          const recovered = ethers.verifyMessage(message, adjusted);
          if (recovered.toLowerCase() === expected) {
            console.log('[签名] ✅ 方法2 v值调整后匹配');
            return true;
          }
        }
      }
    } catch(e) { /* 继续 */ }

    // 方法3: 部分老钱包用 eth_sign（对消息的 hash 签名，不加 EIP-191 前缀）
    // 即: sig = sign(keccak256(message))
    try {
      const msgHash = ethers.id(message);  // keccak256(message)
      const recovered = ethers.recoverAddress(msgHash, signature);
      if (recovered.toLowerCase() === expected) {
        console.log('[签名] ✅ 方法3 hash recover 匹配');
        return true;
      }
    } catch(e) { /* 继续 */ }

    // 方法4: 部分钱包用 keccak256(UTF8) 签名但 ethers.verifyMessage 的前缀长度算法不同
    // 尝试手动构建 EIP-191 前缀并恢复
    try {
      const msgBytes = ethers.toUtf8Bytes(message);
      const prefix = ethers.toUtf8Bytes('\x19Ethereum Signed Message:\n' + msgBytes.length);
      const hash = ethers.keccak256(ethers.concat([prefix, msgBytes]));
      const recovered = ethers.recoverAddress(hash, signature);
      if (recovered.toLowerCase() === expected) {
        console.log('[签名] ✅ 方法4 手动前缀匹配');
        return true;
      }
    } catch(e) { /* 继续 */ }

    // 方法5: 部分钱包可能对 trimmed message（去掉了换行符）签名
    try {
      const trimmed = message.replace(/\r\n/g, '\n').trim();
      if (trimmed !== message) {
        const recovered = ethers.verifyMessage(trimmed, signature);
        if (recovered.toLowerCase() === expected) {
          console.log('[签名] ✅ 方法5 trimmed message 匹配');
          return true;
        }
      }
    } catch(e) { /* 继续 */ }

    console.log('[签名] ❌ 所有5种验证方法均失败');
    console.log('[签名]   expected:', expected);
    console.log('[签名]   message length:', message.length);
    console.log('[签名]   signature length:', signature.length);
    console.log('[签名]   message preview:', message.substring(0, 60).replace(/\n/g, '\\n'));
    return false;
  } catch (e) {
    console.log('[签名] 验证异常:', e.message);
    return false;
  }
}

// ═══════════════════════════════════
// 交易执行器（为用户在 PancakeSwap 上交易）
// ═══════════════════════════════════
class SwapExecutor {
  constructor() {
    this.router = PANCAKE_ROUTER;
    this.erc20ABI = [
      'function approve(address spender, uint256 amount) returns (bool)',
      'function allowance(address owner, address spender) view returns (uint256)',
      'function balanceOf(address account) view returns (uint256)',
      'function transfer(address to, uint256 amount) returns (bool)',
    ];
    this.routerABI = [
      'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory amounts)',
      'function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory amounts)',
      'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory amounts)',
      'function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory amounts)',
    ];
  }

  // 获取报价
  async getQuote(tokenIn, tokenOut, amountIn) {
    const { ethers } = require('ethers');
    const router = new ethers.Contract(this.router, this.routerABI, getProvider());
    const amounts = await router.getAmountsOut(amountIn, [tokenIn, tokenOut]);
    return amounts[1];
  }

  // 在 Vault 里执行 swap
  async executeSwapInVault(vaultAddress, vaultABI, tokenIn, tokenOut, amountIn, minOut) {
    const { ethers } = require('ethers');
    // ⚠️ 参数顺序必须和合约一致: executeSwap(dex, tokenIn, tokenOut, amountIn, minAmountOut)
    const coder = new ethers.Interface(vaultABI);
    const data = coder.encodeFunctionData('executeSwap', [
      this.router,   // dex（第1个参数）
      tokenIn,       // tokenIn（第2个参数）
      tokenOut,      // tokenOut（第3个参数）
      amountIn,      // amountIn（第4个参数）
      minOut,        // minAmountOut（第5个参数）
    ]);
    return sendTx(vaultAddress, data);
  }
}

// ═══════════════════════════════════
// SaaS Server 主体
// ═══════════════════════════════════
class SaasServer {
  constructor(engine, port, opts = {}) {
    this.engine = engine;
    this.deps = opts;
    this.userTrader = opts.userTrader || null;
    this.dataBus = opts.dataBus || engine?.dataBus || null;
    this.port = port || 8010;
    this.app = express();
    this.userDB = new UserDB();
    this.swapExecutor = new SwapExecutor();
    this.server = null;
    this.log = (msg) => console.log(`[SaaS] ${new Date().toISOString()} ${msg}`);
  }

  start() {
    this._setupRoutes();
    this._setupArkieRoutes();
    this.server = this.app.listen(this.port, () => {
      this.log(`🌐 SaaS Platform v3.0: http://localhost:${this.port}`);
      this.log(`💰 智能合约钱包模式 — 用户无需 API Key`);
    });
  }

  _setupArkieRoutes() {
    const { ArkieAssistant } = require('../dashboard/arkie-assistant');
    const arkie = new ArkieAssistant(this.engine, {
      cexUserTrader: this.cexUserTrader || null,
      userDB: this.userDB || null,
    });
    this.arkie = arkie;

    this.app.post('/api/arkie/chat', async (req, res) => {
      try {
        const { message, userId } = req.body;
        // v115: 从 session 获取 wallet 和 isAdmin
        const session = req.session || {};
        const wallet = session.wallet || null;
        const isAdmin = !!session.isAdmin || false;
        const result = await arkie.chat(message, { userId: userId || wallet || 'admin', wallet, isAdmin });
        res.json(result);
      } catch (e) {
        res.json({ reply: `出错了：${e.message}`, name: 'Arkie', ts: Date.now() });
      }
    });

    this.app.get('/api/arkie/history', (req, res) => {
      res.json({ history: arkie.conversationHistory });
    });
  }

  stop() {
    if (this.server) this.server.close();
  }

  _setupRoutes() {
    // 静态文件
    this.app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false, setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); res.setHeader('Pragma', 'no-cache'); res.setHeader('Expires', '0'); } }));
    this.app.use(express.json({ limit: '1mb' }));

    // [audit#2] CORS 头（限制允许的源，不再用 *)
    // [SECURITY#3-MEDIUM] 空origin时不应返回通配符*，改为不设置CORS头
    this.app.use((req, res, next) => {
      const origin = req.headers.origin || '';
      // 允许 localhost（开发）和公网地址、以及空 origin（同源请求/TP钱包）
      const isDev = /^http:\/\/localhost(:\d+)?$/i.test(origin);
      const isTPOrWallet = origin.startsWith('dapp://') || origin.includes('tokenpocket');
      if (isDev || isTPOrWallet) {
        res.header('Access-Control-Allow-Origin', origin);
      } else if (!origin) {
        // 同源请求不设置CORS头（浏览器默认允许）
      }
      res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Admin-Key');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });

    // ═══════ 认证 API ═══════

    // v19: 账号密码注册
    this.app.post('/api/auth/register', async (req, res) => {
      try {
        // [audit#10] 注册限流：每IP 60秒内最多3次
        const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
        if (!rateLimit(`register:${clientIp}`, 3, 60000)) {
          return res.status(429).json({ error: '注册请求过于频繁，请稍后再试' });
        }
        const { username, password, walletAddress, inviteCode } = req.body;
        // v106.4: 邀请码验证 — 防止未授权用户注册
        const VALID_INVITE = process.env.INVITE_CODE || 'ARK2026';
        if (!inviteCode || inviteCode !== VALID_INVITE) {
          return res.status(403).json({ error: '邀请码无效，请联系管理员获取' });
        }
        const actualUsername = username || walletAddress;
        if (!actualUsername || !password) {
          return res.status(400).json({ error: '请输入钱包地址和密码' });
        }
        if (password.length < 8) {
          return res.status(400).json({ error: '密码至少 8 位，需含大小写字母和数字' });
        }
        if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
          return res.status(400).json({ error: '密码需包含大写、小写字母和数字' });
        }
        // 检查用户名是否已存在
        const existing = this.userDB.getByUsername(actualUsername);
        if (existing) {
          return res.status(409).json({ error: '该账号已存在，请直接登录' });
        }
        // 创建用户
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.scryptSync(password, salt, 64).toString('hex');
        const walletAddr = (walletAddress || actualUsername).toLowerCase();
        const user = this.userDB.createWithAuth(actualUsername, salt, hash, '', walletAddr);
        // 注册成功后异步查余额（不阻塞注册响应）
        const sessionToken = createSession(walletAddr, {
          username: actualUsername,
          walletAddress: walletAddr,
          arkBalance: 0, bnbBalance: 0, usdtBalance: 0,
          vaultAddress: null,
          loginMethod: 'password',
        });
        this.userDB.updateToken(actualUsername, sessionToken);
        this.log(`✅ 注册成功: ${actualUsername}, 钱包: ${walletAddr}`);
        res.json({ success: true, token: sessionToken, user: { username: actualUsername, address: walletAddr, walletAddress: walletAddr } });
      } catch (e) {
        this.log('❌ 注册失败: ' + e.message);
        res.status(500).json({ error: '注册失败' });
      }
    });

    // v19: 账号密码登录
    this.app.post('/api/auth/login', async (req, res) => {
      try {
        // [audit#9] 登录限流：每IP 60秒内最多5次
        const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
        if (!rateLimit(`login:${clientIp}`, 5, 60000)) {
          return res.status(429).json({ error: '登录尝试过于频繁，请稍后再试' });
        }
        const { username, password } = req.body;
        if (!username || !password) {
          return res.status(400).json({ error: '请输入用户名和密码' });
        }
        // [SECURITY] 账号级暴力破解保护
        const lockInfo = checkAccountLock(username.toLowerCase());
        if (lockInfo.locked) {
          return res.status(423).json({ error: `账号已锁定，请 ${lockInfo.remainMin} 分钟后再试` });
        }
        const user = this.userDB.getByUsername(username);
        if (!user || !user.salt || !user.passwordHash) {
          recordLoginFailure(username.toLowerCase());
          return res.status(401).json({ error: '用户名或密码错误' });
        }
        // 检查是否已注销
        if (user.deleted) {
          return res.status(403).json({ error: '该账号已被注销，请联系管理员' });
        }
        const hash = crypto.scryptSync(password, user.salt, 64).toString('hex');
        if (hash !== user.passwordHash) {
          recordLoginFailure(username.toLowerCase());
          return res.status(401).json({ error: '用户名或密码错误' });
        }
        // 登录成功，清除失败记录
        clearLoginFailure(username.toLowerCase());
        // 🔍 直接查链上余额（无门槛限制）
        const walletAddr = (user.walletAddress || user.address || username).toLowerCase();
        const arkBalance = user.arkBalance || 0;
        const bnbBalance = user.bnbBalance || 0;
        const usdtBalance = user.usdtBalance || 0;
        // 生成登录 token
        const sessionToken = createSession(walletAddr, {
          username,
          walletAddress: walletAddr,
          arkBalance, bnbBalance, usdtBalance,
          vaultAddress: user.vaultAddress || null,
          loginMethod: 'password',
        });
        // 更新用户 token
        this.userDB.updateToken(username, sessionToken);
        this.log(`✅ 密码登录: ${username}`);
        res.json({
          success: true,
          token: sessionToken,
          user: {
            username,
            address: walletAddr,
            arkBalance, bnbBalance, usdtBalance,
            vaultAddress: user.vaultAddress || null,
            strategy: user.strategy || 'balanced',
            tradingEnabled: user.tradingEnabled || false,
          },
        });
      } catch (e) {
        this.log('❌ 登录失败: ' + e.message);
        res.status(500).json({ error: '登录失败' });
      }
    });

    // 获取登录消息（前端让 TP 签名）
    this.app.get('/api/auth/nonce', (req, res) => {
      const address = req.query.address;
      if (!address || !address.startsWith('0x')) {
        return res.status(400).json({ error: '需要钱包地址' });
      }
      const nonce = crypto.randomBytes(16).toString('hex');
      const timestamp = Date.now();
      const message = `ARK Quant Agent 登录\n\n地址: ${address}\nNonce: ${nonce}\n时间: ${timestamp}\n\n签名此消息以验证您的身份。`;
      res.json({ message, nonce, timestamp });
    });

    // 验证签名 + ARK 门槛 + 部署/获取 Vault
    this.app.post('/api/auth/verify', async (req, res) => {
      try {
        // v14: 限流 — 每 IP 60秒内最多10次认证尝试
        const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
        if (!rateLimit(`auth:${clientIp}`, 10, 60000)) {
          return res.status(429).json({ error: '认证请求过于频繁，请稍后再试' });
        }
        const { address, message, signature, chainId } = req.body;
        if (!address || !message || !signature) {
          return res.status(400).json({ error: '缺少参数' });
        }

        // v19: 标准化地址 — 统一转小写比较，消除 checksum 大小写差异
        const normalizedAddress = address.toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(normalizedAddress)) {
          return res.status(400).json({ error: '钱包地址格式无效' });
        }

        // v14: 链 ID 验证 — 必须在 BSC 主网
        if (chainId && parseInt(chainId) !== 56) {
          return res.status(400).json({ error: '请切换到 BSC 主网 (Chain ID: 56)', expected: 56, received: parseInt(chainId) });
        }

        // v19: 从消息中提取地址用于签名验证 — 确保与签名时的地址完全一致
        const msgAddrMatch = message.match(/地址:\s*(0x[0-9a-fA-F]{40})/);
        const msgAddress = msgAddrMatch ? msgAddrMatch[1] : address;

        // v14: 验证消息时间戳（10分钟有效）+ nonce 防重放
        const tsMatch = message.match(/时间:\s*(\d+)/);
        if (tsMatch) {
          const msgTime = parseInt(tsMatch[1]);
          if (Math.abs(Date.now() - msgTime) > 600000) {
            return res.status(403).json({ error: '签名已过期，请重新签名' });
          }
        }

        // v19: 签名验证 — 先验证签名，通过后再标记 nonce（防止 ARK 不足时浪费 nonce）
        const valid = verifyEthereumSignature(message, signature, msgAddress);
        if (!valid) {
          return res.status(403).json({ error: '签名验证失败' });
        }

        // 签名验证通过后才标记 nonce（避免无效操作消耗 nonce）
        const nonceMatch = message.match(/Nonce:\s*([a-f0-9]+)/);
        if (nonceMatch) {
          const nonce = nonceMatch[1];
          if (isNonceUsed(nonce)) {
            return res.status(403).json({ error: '签名已使用（重放攻击）' });
          }
          markNonceUsed(nonce);
        }

        // 2. 查链上余额（无门槛限制）
        let arkBalance = 0, bnbBalance = 0;
        try { arkBalance = Number(await erc20Balance(ARK_TOKEN, address)) / 1e18; } catch(e) {}
        try {
          const rawBnb = await bscRpc('eth_getBalance', [address, 'latest']);
          bnbBalance = Number(BigInt(rawBnb)) / 1e18;
        } catch (e) { this.log(`⚠️ BNB余额查询失败 ${address.slice(0,10)}: ${e.message}`); }

        // 4. 查或创建 Vault
        let user = this.userDB.get(address);
        let vaultAddress = user?.vaultAddress || null;

        // 如果有 Factory 合约，查链上是否已有 Vault
        if (VAULT_FACTORY && !vaultAddress) {
          try {
            const result = await callContract(
              VAULT_FACTORY,
              ['function getVault(address) view returns (address)'],
              'getVault', [address]
            );
            vaultAddress = result[0];
            if (vaultAddress === '0x0000000000000000000000000000000000000000') {
              vaultAddress = null;
            }
          } catch (e) { this.log(`⚠️ Factory查询Vault失败 ${address.slice(0,10)}: ${e.message}`); }
        }

        // 5. 创建 session
        if (vaultAddress) pendingFundRequests.delete(address); // 有 Vault 则自动清除待充值
        const token = createSession(address, { arkBalance, bnbBalance, vaultAddress });

        // 6. 保存用户
        user = this.userDB.set(address, {
          arkBalance,
          bnbBalance,
          vaultAddress,
          lastLogin: Date.now(),
          strategy: user?.strategy || 'balanced',
          tradingEnabled: user?.tradingEnabled || false,
        });

        this.log(`✅ 登录: ${address.slice(0, 10)}... | ARK: ${arkBalance.toFixed(2)} | Vault: ${vaultAddress || '未部署'}`);

        res.json({
          success: true,
          token,
          user: {
            address,
            arkBalance,
            bnbBalance,
            vaultAddress,
            strategy: user.strategy,
            tradingEnabled: user.tradingEnabled,
            platformFee: PLATFORM_FEE_BPS / 100,
          },
        });
      } catch (e) {
        this.log(`❌ 认证失败: ${e.message}`);
        res.status(500).json({ error: e.message });
      }
    });

    // 登出（销毁 session）
    this.app.post('/api/auth/logout', (req, res) => {
      const token = (req.headers.authorization || '').replace('Bearer ', '');
      if (token) { sessions.delete(token); _saveSessionsImmediate(); } // [audit#5] 登出立即写入
      res.json({ success: true });
    });

    // ═══════ Vault 管理 API ═══════

    // 获取 Vault 状态
    this.app.get('/api/vault/status', async (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });

      const user = this.userDB.get(session.wallet);
      const vaultAddress = user?.vaultAddress;

      if (!vaultAddress) {
        return res.json({
          deployed: false,
          message: '尚未部署 Vault，请先部署',
        });
      }

      // 查链上余额
      let usdtBalance = 0, bnbBalance = 0, totalPnl = 0, totalTrades = 0;
      try {
        const rawUsdt = await erc20Balance(USDT_ADDRESS, vaultAddress);
        usdtBalance = Number(rawUsdt) / 1e18;
      } catch (e) { this.log(`⚠️ Vault USDT余额查询失败: ${e.message}`); }
      try {
        const rawBnb = await bscRpc('eth_getBalance', [vaultAddress, 'latest']);
        bnbBalance = Number(BigInt(rawBnb)) / 1e18;
      } catch (e) { this.log(`⚠️ Vault BNB余额查询失败: ${e.message}`); }
      try {
        const result = await callContract(
          vaultAddress,
          [
            'function totalPnl() view returns (int256)',
            'function getTradeCount() view returns (uint256)',
            'function getTrader() view returns (address)',
            'function isPaused() view returns (bool)',
          ],
          'totalPnl', []
        );
        totalPnl = Number(result[0]) / 1e18;
        // 重新调用其他方法
        const count = await callContract(vaultAddress, ['function getTradeCount() view returns (uint256)'], 'getTradeCount', []);
        totalTrades = Number(count[0]);
      } catch (e) { this.log(`⚠️ Vault合约状态查询失败: ${e.message}`); }

      res.json({
        deployed: true,
        vaultAddress,
        oldVaultAddress: user?.oldVaultAddresses?.[0] || null,
        usdtBalance,
        bnbBalance,
        totalPnl,
        totalTrades,
        tradingEnabled: user?.tradingEnabled || false,
        strategy: user?.strategy || 'balanced',
        platformFee: PLATFORM_FEE_BPS / 100,
      });
    });

    // 启用/禁用自动交易
    this.app.post('/api/vault/trading', async (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });

      const { enabled } = req.body;
      const user = this.userDB.get(session.wallet);
      // CEX模式不需要vaultAddress
      const isCexMode = user?.binanceApiKey && user?.binanceSecret;
      if (!user?.vaultAddress && !isCexMode) {
        return res.status(400).json({ error: '请先部署 Vault 或绑定 Binance API Key' });
      }

      // v17: 启用交易时验证链上 trader 授权状态
      if (enabled && TRADER_PRIVATE_KEY) {
        try {
          const result = await callContract(
            user.vaultAddress,
            ['function getTrader() view returns (address)'],
            'getTrader', []
          );
          const { ethers } = require('ethers');
          const traderAddr = new ethers.Wallet(TRADER_PRIVATE_KEY).address;
          const vaultTrader = result[0];
          if (vaultTrader.toLowerCase() !== traderAddr.toLowerCase()) {
            // 自动调用 setTrader 授权
            this.log(`⚙️ ${session.wallet.slice(0, 10)}... Vault trader 不匹配，自动授权...`);
            const vaultABI = ['function setTrader(address _trader)'];
            const coder = new ethers.Interface(vaultABI);
            const data = coder.encodeFunctionData('setTrader', fixArgs([traderAddr]));
            await sendTx(user.vaultAddress, data);
            this.log(`✅ ${session.wallet.slice(0, 10)}... trader 已授权: ${traderAddr}`);
          }
        } catch (e) {
          this.log(`⚠️ trader 授权检查失败: ${e.message}`);
        }
      }

      this.userDB.set(session.wallet, { tradingEnabled: !!enabled });
      this.log(`📊 ${session.wallet.slice(0, 10)}... 交易${enabled ? '启用' : '禁用'}`);
      res.json({ success: true, tradingEnabled: !!enabled });
    });

    // 设置策略
    this.app.post('/api/vault/strategy', async (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });

      const { strategy } = req.body;
      if (!['conservative', 'balanced', 'aggressive', 'bb', 'bollinger'].includes(strategy)) {
        return res.status(400).json({ error: '策略必须是 conservative/balanced/aggressive/bb' });
      }
      this.userDB.set(session.wallet, { strategy });
      res.json({ success: true, strategy });
    });

    // 设置交易金额（用户想让机器人拿多少钱交易）
    this.app.post('/api/vault/trade-amount', (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });
      const { tradeAmount } = req.body;
      const amt = Number(tradeAmount);
      if (!amt || amt < 0) return res.status(400).json({ error: '金额无效' });
      // [SECURITY#4-MEDIUM] 交易金额上限验证
      if (amt > 100000) return res.status(400).json({ error: '交易金额不能超过 $100,000' });
      this.userDB.set(session.wallet, { tradeAmount: amt });
      this.log(`💰 ${session.wallet.slice(0,10)}... 交易金额设为 $${amt}`);
      res.json({ success: true, tradeAmount: amt });
    });

    // 获取用户设置（包含交易金额）
    this.app.get('/api/vault/user-settings', (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });
      const user = this.userDB.get(session.wallet);
      res.json({
        strategy: user?.strategy || 'balanced',
        tradeAmount: user?.tradeAmount || 0,
        maxSingle: user?.maxSingle || 50000,
        dailyLimit: user?.dailyLimit || 200000,
        exchangeMode: user?.exchangeMode || 'cex', // 'cex' | 'dex'
      });
    });

    // ═══ 交易所切换 (用户独立，互不干扰) ═══
    this.app.post('/api/vault/exchange-mode', (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });
      const { exchangeMode } = req.body;
      if (!['cex', 'dex'].includes(exchangeMode)) {
        return res.status(400).json({ error: '无效模式，只支持 cex 或 dex' });
      }
      this.userDB.set(session.wallet, { exchangeMode });
      this.log(`🔄 ${session.wallet.slice(0,10)}... 交易所切换为 ${exchangeMode.toUpperCase()}`);
      res.json({ success: true, exchangeMode });
    });

    this.app.get('/api/vault/exchange-mode', (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });
      const user = this.userDB.get(session.wallet);
      res.json({ exchangeMode: user?.exchangeMode || 'cex' });
    });

    // 设置交易限额
    this.app.post('/api/vault/limits', async (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });

      const user = this.userDB.get(session.wallet);
      if (!user?.vaultAddress) return res.status(400).json({ error: 'Vault 不存在' });

      const { maxSingle, dailyLimit } = req.body;
      try {
        const { ethers } = require('ethers');
        const vaultABI = [
          'function setTradeLimits(uint256 maxSingle, uint256 dailyLimit)',
        ];
        const coder = new ethers.Interface(vaultABI);
        const data = coder.encodeFunctionData('setTradeLimits', [
          ethers.parseUnits(String(maxSingle || 50000), 18),
          ethers.parseUnits(String(dailyLimit || 200000), 18),
        ]);
        await sendTx(user.vaultAddress, data);
        this.log(`⚙️ ${session.wallet.slice(0, 10)}... 限额更新: 单笔${maxSingle} / 日${dailyLimit}`);
        res.json({ success: true });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // Vault approve — V3 合约已自动 approve Router，此端点仅做查询
    this.app.post('/api/vault/approve-router', async (req, res) => {
      res.json({ success: true, message: 'v92: 链上合约已迁移至CEX模式', migrated: true });
    });

    // v92: 撤销交易权限 → CEX模式下禁用tradingEnabled
    this.app.post('/api/vault/revoke', async (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });
      const user = this.userDB.get(session.wallet);
      if (!user) return res.status(400).json({ error: '用户不存在' });
      user.tradingEnabled = false;
      this.userDB.save(session.wallet, user);
      res.json({ success: true, message: '已停止自动交易' });
      try {
        const { ethers } = require('ethers');
        const vaultABI = ['function revokeTrader()'];
        const coder = new ethers.Interface(vaultABI);
        const data = coder.encodeFunctionData('revokeTrader');
        await sendTx(user.vaultAddress, data);
        this.userDB.set(session.wallet, { tradingEnabled: false });
        this.log(`🛑 ${session.wallet.slice(0, 10)}... 紧急撤销 trader 权限`);
        res.json({ success: true, message: '已撤销交易权限，机器人将停止操作您的资金' });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // ═══════ Vault 部署 API ═══════

    // v92: 部署Vault → 改为CEX模式
    this.app.post('/api/vault/deploy', async (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });
      return res.json({ success: true, migrated: true, message: 'v92: 请绑定 Binance API Key 开始交易', redirect: '/api/vault/cex-key' });

      // === 以下为链上合约代码，已废弃（v92迁移到CEX）===
      const user = this.userDB.get(session.wallet);
      if (user?.vaultAddress) {
        return res.status(400).json({ error: 'Vault 已部署', vaultAddress: user.vaultAddress });
      }
      if (!TRADER_PRIVATE_KEY) {
        return res.status(500).json({ error: '平台交易器未配置，请联系管理员' });
      }
      if (!VAULT_FACTORY) {
        return res.status(500).json({ error: 'Vault Factory 未部署，请联系管理员' });
      }

      // P1修复：部署前检查交易器钱包 BNB 余额，不足则直接记录待充值
      try {
        const traderWallet = new (require('ethers')).Wallet(TRADER_PRIVATE_KEY).address;
        const rawBnb = await bscRpc('eth_getBalance', [traderWallet, 'latest']);
        const traderBnb = Number(BigInt(rawBnb)) / 1e18;
        if (traderBnb < 0.01) {
          this.log(`⚠️ 交易器钱包 BNB 不足: ${traderBnb.toFixed(6)} BNB`);
          pendingFundRequests.set(session.wallet, {
            wallet: traderWallet,
            reason: `Vault 部署需要 gas 费（BNB），交易器余额仅 ${traderBnb.toFixed(6)} BNB`,
            userAddress: session.wallet,
            timestamp: Date.now(),
          });
          return res.status(402).json({ error: '平台交易器钱包余额不足，请联系管理员充值后重试', traderWallet, traderBnb: traderBnb.toFixed(6) });
        }
        this.log(`💰 交易器钱包余额: ${traderBnb.toFixed(6)} BNB — 足够部署`);
      } catch (e) {
        this.log(`⚠️ 交易器余额检查失败（继续部署）: ${e.message}`);
      }

      try {
        const { ethers } = require('ethers');

        // 调用 Factory 部署 Vault
        const factoryABI = [
          'function deployVault(address user) returns (address)',
          'function getVault(address user) view returns (address)'
        ];
        const coder = new ethers.Interface(factoryABI);
        const data = coder.encodeFunctionData('deployVault', fixArgs([session.wallet]));

        const receipt = await sendTx(VAULT_FACTORY, data);
        this.log(`📦 部署 tx 已确认: ${receipt.transactionHash?.slice(0, 18)}...`);

        // 查询链上 Vault 地址
        const result = await callContract(
          VAULT_FACTORY,
          ['function getVault(address) view returns (address)'],
          'getVault', [session.wallet]
        );
        const vaultAddress = result[0];

        if (vaultAddress === '0x0000000000000000000000000000000000000000') {
          throw new Error('Vault 部署失败：链上未找到');
        }

        // 保存到数据库
        this.userDB.set(session.wallet, { vaultAddress });

        this.log(`🚀 ${session.wallet.slice(0, 10)}... Vault 已部署: ${vaultAddress}`);
        res.json({ success: true, vaultAddress });
      } catch (e) {
        // [audit#13] 移除调试日志中的完整堆栈，只保留摘要
        this.log(`❌ 部署失败: ${e.message}`);
        // 记录到待充值列表
        if (e.message && (e.message.includes('insufficient') || e.message.includes('gas') || e.message.includes('insufficient funds') || e.message.includes('not enough'))) {
          const user = this.userDB.get(session.wallet);
          pendingFundRequests.set(session.wallet, {
            wallet: TRADER_PRIVATE_KEY ? new (require('ethers')).Wallet(TRADER_PRIVATE_KEY).address : 'unknown',
            reason: 'Vault 部署需要 gas 费（BNB）',
            userAddress: session.wallet,
            timestamp: Date.now(),
          });
          this.log(`📋 已加入待充值列表: ${session.wallet.slice(0,10)}...`);
        }
        res.status(500).json({ error: '部署失败: ' + e.message });
      }
    });

    // ═══════ Vault 前端链上部署后同步 ═══════
    // 用户通过 TP 钱包在前端直接调用 Factory 部署，成功后同步到后端
    // v92: sync路由保留但CEX模式下不需要
    this.app.post('/api/vault/sync', async (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });
      const { vaultAddress } = req.body;
      if (!vaultAddress || vaultAddress === '0x0000000000000000000000000000000000000000') {
        return res.status(400).json({ error: '无效的 Vault 地址' });
      }
      // v92: CEX模式下同步 vault 地址（兼容旧前端）
      this.userDB.set(session.wallet, { vaultAddress });
      return res.json({ success: true, vaultAddress });

      // 验证链上 Vault 确实属于该用户
      try {
        const { ethers } = require('ethers');
        const provider = new ethers.JsonRpcProvider('https://bsc-rpc.publicnode.com'); // static RPC for balance check
        const vaultContract = new ethers.Contract(vaultAddress, [
          'function owner() view returns (address)',
          'function userAddress() view returns (address)'
        ], provider);
        const owner = await vaultContract.owner();
        if (owner.toLowerCase() !== session.wallet.toLowerCase()) {
          return res.status(403).json({ error: 'Vault 归属验证失败' });
        }
      } catch (e) {
        this.log(`⚠️ Vault 链上验证失败: ${e.message}`);
        return res.status(400).json({ error: 'Vault 链上验证失败，请确认合约地址正确' });
      }

      const user = this.userDB.get(session.wallet) || {};
      user.vaultAddress = vaultAddress;
      this.userDB.set(session.wallet, user);
      pendingFundRequests.delete(session.wallet); // 自动清除待充值
      this.log(`🔗 ${session.wallet.slice(0, 10)}... Vault 已同步: ${vaultAddress}`);
      res.json({ success: true, vaultAddress });
    });

    // ═══════ Vault 入金 API ═══════

    // 查询 Vault 地址（用户用来在 TP 钱包里入金）
    this.app.get('/api/vault/address', async (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });
      const user = this.userDB.get(session.wallet);
      if (!user?.vaultAddress) {
        return res.status(404).json({ error: 'Vault 不存在，请先部署' });
      }
      res.json({ vaultAddress: user.vaultAddress, owner: session.wallet });
    });

    // ═══════ Vault 提现 API（V2: 用户自己签名提现）═══════

    // 提取资金（V2: 用户 TP 钱包直接调用合约，不需要后端代签）
    // 前端直接调用 Vault.withdrawAllUSDT() / withdrawAllBNB()
    // 后端只做余额查询和验证
    this.app.post('/api/vault/withdraw', async (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });

      const { type } = req.body;
      if (!['USDT', 'BNB'].includes(type)) {
        return res.status(400).json({ error: 'type 必须是 USDT 或 BNB' });
      }

      const user = this.userDB.get(session.wallet);
      if (!user?.vaultAddress) {
        return res.status(400).json({ error: 'Vault 不存在，请先部署' });
      }

      try {
        const { ethers } = require('ethers');

        // V2: 验证用户是 Vault 的 owner
        try {
          const ownerAbi = ['function owner() view returns (address)'];
          const ownerResult = await callContract(user.vaultAddress, ownerAbi, 'owner', []);
          const vaultOwner = ownerResult[0];
          if (vaultOwner.toLowerCase() !== session.wallet.toLowerCase()) {
            // 旧合约兼容：如果 owner 不是用户，尝试用 trader 代签
            this.log(`⚠️ Vault owner 不是用户，尝试 trader 代签提现`);
            if (type === 'USDT') {
              const vaultABI = ['function withdrawAllUSDT()'];
              const coder = new ethers.Interface(vaultABI);
              const data = coder.encodeFunctionData('withdrawAllUSDT');
              await sendTx(user.vaultAddress, data);
            } else {
              const vaultABI = ['function withdrawAllBNB()'];
              const coder = new ethers.Interface(vaultABI);
              const data = coder.encodeFunctionData('withdrawAllBNB');
              await sendTx(user.vaultAddress, data);
            }
            this.log(`💸 ${session.wallet.slice(0, 10)}... 代签提取所有 ${type}`);
            return res.json({ success: true, message: `${type} 已提取`, method: 'trader-signed' });
          }
        } catch (e) {
          this.log(`⚠️ owner 验证失败: ${e.message}，尝试 trader 代签`);
          // 兼容旧合约：继续用 trader 代签
          if (type === 'USDT') {
            const vaultABI = ['function withdrawAllUSDT()'];
            const coder = new ethers.Interface(vaultABI);
            const data = coder.encodeFunctionData('withdrawAllUSDT');
            await sendTx(user.vaultAddress, data);
          } else {
            const vaultABI = ['function withdrawAllBNB()'];
            const coder = new ethers.Interface(vaultABI);
            const data = coder.encodeFunctionData('withdrawAllBNB');
            await sendTx(user.vaultAddress, data);
          }
          return res.json({ success: true, message: `${type} 已提取`, method: 'trader-signed' });
        }

        // V2: 用户是 owner → 返回合约信息，让前端用 TP 钱包直接签
        res.json({
          success: true,
          message: '请在 TP 钱包中确认提现交易',
          method: 'user-signed',
          vaultAddress: user.vaultAddress,
          action: type === 'USDT' ? 'withdrawAllUSDT' : 'withdrawAllBNB',
        });
      } catch (e) {
        this.log(`❌ 提现失败: ${e.message}`);
        res.status(500).json({ error: '提现失败: ' + e.message });
      }
    });

    // ═══════ 旧 Vault 迁移 API（用户将资金从旧 Vault 转到新 Vault）═══════
    this.app.post('/api/vault/migrate', async (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });

      const user = this.userDB.get(session.wallet);
      if (!user?.vaultAddress) return res.status(400).json({ error: '没有 Vault' });

      try {
        const { ethers } = require('ethers');
        
        // 检查当前 Vault owner
        const ownerAbi = ['function owner() view returns (address)'];
        const ownerResult = await callContract(user.vaultAddress, ownerAbi, 'owner', []);
        const vaultOwner = ownerResult[0];

        // 如果 owner 已经是用户，不需要迁移
        if (vaultOwner.toLowerCase() === session.wallet.toLowerCase()) {
          return res.json({ success: true, message: 'Vault owner 已经是您，无需迁移', vaultAddress: user.vaultAddress });
        }

        // owner 不是用户 → 旧合约，需要迁移
        // 方案：后端用 trader 私钥调用旧 Vault 的 withdrawAllUSDT/withdrawAllBNB（如果 trader 有权限的话）
        // 实际上旧合约中 trader 不是 owner，所以无法代签提现
        // 因此只能：创建新的 V2 Vault，让用户自己从前端签名转账

        // 检查是否已有新的 V2 Vault
        let newVault = null;
        if (VAULT_FACTORY) {
          try {
            const result = await callContract(
              VAULT_FACTORY,
              ['function getVault(address) view returns (address)'],
              'getVault', [session.wallet]
            );
            const onChainVault = result[0];
            if (onChainVault && onChainVault !== '0x0000000000000000000000000000000000000000') {
              newVault = onChainVault;
            }
          } catch (e) {}
        }

        if (!newVault) {
          // 用新 Factory 为用户部署 V2 Vault
          this.log(`📦 为 ${session.wallet.slice(0,10)}... 迁移到 V2 Vault...`);
          const factoryABI = ['function deployVault(address user) returns (address)'];
          const coder = new ethers.Interface(factoryABI);
          const data = coder.encodeFunctionData('deployVault', fixArgs([session.wallet]));
          const receipt = await sendTx(VAULT_FACTORY, data);
          
          const result = await callContract(
            VAULT_FACTORY,
            ['function getVault(address) view returns (address)'],
            'getVault', [session.wallet]
          );
          newVault = result[0];
        }

        if (!newVault || newVault === '0x0000000000000000000000000000000000000000') {
          throw new Error('新 Vault 部署失败');
        }

        // 更新用户数据
        this.userDB.set(session.wallet, { vaultAddress: newVault });
        
        this.log(`✅ ${session.wallet.slice(0,10)}... 已迁移到新 Vault: ${newVault}`);
        res.json({
          success: true,
          message: '新 Vault 已创建，请将旧 Vault 中的资金手动转入新 Vault',
          oldVault: user.vaultAddress,
          newVault: newVault,
          note: '由于旧 Vault 的 owner 不是您，资金需要您手动从前端签名转账',
        });
      } catch (e) {
        this.log(`❌ 迁移失败: ${e.message}`);
        res.status(500).json({ error: '迁移失败: ' + e.message });
      }
    });

    // ═══════ 仪表盘 API ═══════

    const dashboardHandler = async (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });

      const user = this.userDB.get(session.wallet);
      // userTrader 可能不存在（CEX-only模式），用可选链保护
      const userState = this.userTrader?.getUserState?.(session.wallet) || {};
      const userTrades = this.userTrader?.getUserTrades?.(session.wallet, 10) || [];

      // 🔍 三路余额：Vault合约 + 注册钱包 + 币安账户
      const walletAddr = session.wallet.toLowerCase();
      const vaultAddr = user?.vaultAddress?.toLowerCase();
      let walletUsdt = 0, walletBnb = 0, walletArk = 0;
      let vaultUsdt = 0, vaultBnb = 0;
      let cexUsdt = 0, cexAvailable = 0, cexUnrealizedPnl = 0, cexTotalEquity = 0;
      const cexKey = user?.cexApiKey || user?.binanceApiKey;
      const cexSecret = user?.cexSecretKey || user?.binanceSecret;
      const hasCexKey = !!(cexKey && cexSecret);
      const withTimeout = (p, ms) => Promise.race([p, new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
      
      // 1️⃣ 注册钱包地址余额
      try { walletArk = Number(await withTimeout(cachedErc20Balance(ARK_TOKEN, walletAddr), 8000)) / 1e18; } catch(e) {}
      try { walletBnb = await withTimeout(cachedBnbBalance(walletAddr), 8000); } catch(e) {}
      try { walletUsdt = Number(await withTimeout(cachedErc20Balance(USDT_ADDRESS, walletAddr), 8000)) / 1e18; } catch(e) {}
      
      // 2️⃣ Vault合约余额（部署了Vault的用户）
      if (vaultAddr) {
        try { vaultUsdt = Number(await withTimeout(cachedErc20Balance(USDT_ADDRESS, vaultAddr), 8000)) / 1e18; } catch(e) {}
        try { vaultBnb = await withTimeout(cachedBnbBalance(vaultAddr), 8000); } catch(e) {}
      }
      
      // 3️⃣ 币安账户余额
      if (hasCexKey) {
        try {
          const { BinanceClient } = require('./cex-user-trader');
          const binanceClient = new BinanceClient(cexKey, cexSecret);
          const bal = await binanceClient.getBalance();
          if (bal) {
            cexUsdt = bal.balance || 0;
            cexAvailable = bal.available || 0;
            cexUnrealizedPnl = bal.unrealizedPnl || 0;
            cexTotalEquity = bal.totalEquity || 0;
          }
        } catch(e) { this.log(`⚠️ 币安余额查询失败: ${e.message}`); }
      }

      // v16: 用户持仓优先从 userTrader 获取
      const userPositions = this.userTrader?.getUserState?.(session.wallet)?.positions || {};
      const enrichedUserPositions = {};
      for (const [sym, pos] of Object.entries(userPositions)) {
        const md = this.dataBus?.marketData?.[sym] || {};
        const markPrice = md.price || 0;
        const entryPrice = pos.entryPrice || 0;
        const pnlPct = entryPrice > 0 && markPrice > 0
          ? ((markPrice - entryPrice) / entryPrice * 100)
          : 0;
        enrichedUserPositions[sym] = {
          ...pos,
          markPrice,
          pnlPct,
          side: pos.side || 'LONG',
          leverage: pos.leverage || 3,
        };
      }

      // v113.26: 合并CEX用户持仓 — 必须用 session.wallet 隔离，只显示自己的
      const cexUserPositions = this.cexUserTrader?.getUserState?.(session.wallet)?.positions || {};
      for (const [sym, pos] of Object.entries(cexUserPositions)) {
        const md = this.dataBus?.marketData?.[sym] || {};
        const markPrice = md.price || 0;
        const entryPrice = pos.entryPrice || 0;
        const pnlPct = entryPrice > 0 && markPrice > 0
          ? ((markPrice - entryPrice) / entryPrice * 100 * (pos.leverage || 1))
          : 0;
        const posSize = pos.size || pos.amount || 0;
        const pnlUsdt = posSize ? (pnlPct / 100 * posSize) : 0;
        enrichedUserPositions[sym] = {
          ...pos,
          markPrice,
          pnlPct,
          pnl: pnlUsdt,
          qty: pos.qty || (entryPrice > 0 ? posSize / entryPrice : 0),
          side: pos.side || 'LONG',
          leverage: pos.leverage || 3,
          openTime: pos.openTime,
        };
      }

      // v72: CEX模式状态（hasCexKey已在上方声明）
      const cexUserState = this.cexUserTrader?.getUserState(session.wallet) || {};
      const cexMode = hasCexKey && (cexUserState.trading || user?.cexMode);

      // CEX模式交易统计
      let totalPnl = 0, totalTrades = 0;
      if (hasCexKey && this.cexUserTrader) {
        const cexStats = this.cexUserTrader.getUserStats(session.wallet);
        if (cexStats) {
          totalPnl = cexStats.totalPnl || 0;
          totalTrades = cexStats.totalTrades || 0;
        }
      } else {
        // 链上模式统计
        totalPnl = userState.totalPnl || 0;
        totalTrades = userState.totalTrades || 0;
      }

      // v121: 获取用户提现权限和费用转账状态
      let canWithdraw = user?.canWithdraw || false;
      let feeTransferStatus = null;
      if (this.cexUserTrader) {
        // 从磁盘读取最新用户数据（dashboard绑定路径直接写文件）
        try {
          const freshUsers = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'saas-users.json'), 'utf8'));
          const freshUser = freshUsers[walletAddr] || freshUsers[walletAddr?.toLowerCase()] || {};
          if (freshUser.canWithdraw === true) canWithdraw = true;
        } catch(e) {}
        // 获取费用状态
        const feeState = this.cexUserTrader._feeState?.pending?.[walletAddr] || this.cexUserTrader._feeState?.pending?.[walletAddr?.toLowerCase()] || [];
        const cooldown = this.cexUserTrader._transferFailCooldown?.[walletAddr] || this.cexUserTrader._transferFailCooldown?.[walletAddr?.toLowerCase()];
        const totalPendingPlatform = feeState.reduce((s,r) => s + parseFloat(r.platformFee), 0);
        const totalPendingEco = feeState.reduce((s,r) => s + parseFloat(r.ecoFund), 0);
        feeTransferStatus = {
          hasWithdrawPermission: canWithdraw,
          pendingCount: feeState.length,
          pendingPlatformFee: +totalPendingPlatform.toFixed(2),
          pendingEcoFee: +totalPendingEco.toFixed(2),
          pendingTotal: +(totalPendingPlatform + totalPendingEco).toFixed(2),
          cooldownActive: cooldown ? (Date.now() - cooldown.lastFailAt < (this.cexUserTrader.TRANSFER_COOLDOWN_MS || 1800000)) : false,
          cooldownRemainMin: cooldown ? Math.max(0, Math.ceil(((this.cexUserTrader.TRANSFER_COOLDOWN_MS || 1800000) - (Date.now() - cooldown.lastFailAt)) / 60000)) : 0,
          failCount: cooldown?.failCount || 0,
          maxFail: this.cexUserTrader.TRANSFER_MAX_FAIL || 3,
          permanentlyStopped: cooldown ? cooldown.failCount >= (this.cexUserTrader.TRANSFER_MAX_FAIL || 3) : false,
        };
      }

      res.json({
        success: true,
        user: {
          address: session.wallet,
          strategy: user?.strategy || 'balanced',
          tradingEnabled: user?.tradingEnabled || false,
          vaultAddress: user?.vaultAddress,
          // v121: 提现权限 + 费用转账状态
          canWithdraw,
          feeTransferStatus,
          // 盖茨费状态（方案A：用户充值到Trader钱包，记账余额）
          gatesFee: {
            bscWalletAddr: user?.bscWalletAddr || walletAddr,
            balance: user?.gatesFeeBalance ?? 0,
            low: user?.gatesFeeLow ?? false,
            approved: user?.gatesFeeApproved ?? false,
            threshold: 5,
            traderWalletAddr: TRADER_PRIVATE_KEY ? new ethers.Wallet(TRADER_PRIVATE_KEY).address : '0xe6DDF0771c7610dBA77eB5a07ba7771DD7F5e91e',
          },
          // 1️⃣ Vault合约余额
          vault: {
            usdt: vaultUsdt,
            bnb: vaultBnb,
            address: vaultAddr || null,
          },
          // 2️⃣ 注册钱包余额
          wallet: {
            usdt: walletUsdt,
            bnb: walletBnb,
            ark: walletArk,
            address: walletAddr,
          },
          // 3️⃣ 币安账户余额
          cex: {
            usdt: cexUsdt,
            available: cexAvailable,
            unrealizedPnl: cexUnrealizedPnl,
            totalEquity: cexTotalEquity,
            connected: hasCexKey,
          },
          // 兼容旧字段
          usdtBalance: walletUsdt,
          bnbBalance: walletBnb,
          arkBalance: walletArk,
          cexMode: !!cexMode,
          exchangeMode: user?.exchangeMode || 'cex',
          isAdmin: !!user?.isAdmin || (this.cexUserTrader?._isAdmin?.(walletAddr) ?? false),
          createdAt: user?.createdAt,
          totalPnl, totalTrades,
        },
        engine: {
          running: !!this.userTrader?.running || !!this.cexUserTrader?.running,
          positions: enrichedUserPositions,
          recentTrades: userTrades,
          cycleCount: this.userTrader?._cycleCount || this.cexUserTrader?._cycleCount || 0,
        },
        // B策略 (BB布林带) 持仓
        bbStrategy: this.bbStrategyManager?.getUserStatus?.(session.wallet) || null,
        platform: {
          wallet: PLATFORM_WALLET,
          feePercent: PLATFORM_FEE_BPS / 100,
          totalUsers: Object.keys(this.userDB.users).length,
        },
      });
    };
    this.app.get('/api/dashboard', dashboardHandler);
    this.app.post('/api/dashboard', dashboardHandler);

    // ═══════ v81: 黄金现货引擎 API ═══════
    this.app.get('/api/gold/status', (req, res) => {
      const ge = this.deps.goldEngine;
      if (!ge) return res.json({ success: false, error: 'Gold engine not available' });
      res.json({ success: true, status: ge.getStatus() });
    });
    this.app.get('/api/gold/price', async (req, res) => {
      const ge = this.deps.goldEngine;
      if (!ge) return res.json({ success: false, error: 'Gold engine not available' });
      res.json({ success: true, price: ge.currentPrice, symbol: 'PAXGUSDT' });
    });
    this.app.get('/api/gold/user', (req, res) => {
      const session = this._auth(req);
      if (!session) return res.json({ success: false, error: 'auth required' });
      const ge = this.deps.goldEngine;
      if (!ge) return res.json({ success: false, error: 'Gold engine not available' });
      res.json({ success: true, gold: ge.getUserGoldStatus(session.address) });
    });
    this.app.post('/api/gold/signal', async (req, res) => {
      const session = this._auth(req);
      if (!session) return res.json({ success: false, error: 'auth required' });
      if (session.username !== 'admin') return res.json({ success: false, error: 'admin only' });
      const ge = this.deps.goldEngine;
      if (!ge) return res.json({ success: false, error: 'Gold engine not available' });
      await ge._refreshKlines();
      ge.currentPrice = await ge.trader.getPrice();
      const analysis = await ge.strategyManager.analyze({
        klines: ge.klines, currentPrice: ge.currentPrice, symbol: 'PAXGUSDT'
      });
      res.json({ success: true, analysis });
    });
    this.app.post('/api/gold/pause', (req, res) => {
      const session = this._auth(req);
      if (!session) return res.json({ success: false, error: 'auth required' });
      if (session.username !== 'admin') return res.json({ success: false, error: 'admin only' });
      const ge = this.deps.goldEngine;
      if (!ge) return res.json({ success: false, error: 'Gold engine not available' });
      const paused = ge.togglePause();
      res.json({ success: true, paused });
    });

    // ═══════ 用户 CEX API Key 绑定（v121: 强制检查提现权限）═══════
    // ═══ 盖茨费：绑定BSC钱包地址（在绑定API Key之前）═══
    this.app.post('/api/vault/bsc-wallet', async (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });
      const { bscWalletAddr } = req.body;
      if (!bscWalletAddr || !/^0x[a-fA-F0-9]{40}$/.test(bscWalletAddr)) {
        return res.json({ success: false, error: '请输入有效的BSC钱包地址' });
      }
      // 查询BSC钱包USDT余额
      let gatesFeeBalance = 0;
      try {
        const rawBal = await erc20Balance(USDT_ADDRESS, bscWalletAddr);
        gatesFeeBalance = Number(rawBal) / 1e18;
      } catch (e) { /* ignore */ }
      // 查询链上Approve授权
      let gatesFeeApproved = false;
      try {
        const { ethers } = require('ethers');
        const traderWalletAddr = new ethers.Wallet(TRADER_PRIVATE_KEY).address;
        const allowanceData = '0xdd62ed3e'
          + bscWalletAddr.toLowerCase().replace('0x', '').padStart(64, '0')
          + traderWalletAddr.toLowerCase().replace('0x', '').padStart(64, '0');
        const allowanceResult = await bscRpc('eth_call', [{ to: USDT_ADDRESS, data: allowanceData }, 'latest']);
        const allowance = BigInt(allowanceResult || '0');
        gatesFeeApproved = allowance > BigInt(1000 * 1e18);
      } catch (e) { /* ignore */ }
      // 保存到用户数据
      const existingUser1 = this.userDB.get(session.wallet) || {};
      this.userDB.set(session.wallet, {
        ...existingUser1,
        bscWalletAddr: bscWalletAddr.toLowerCase(),
        gatesFeeBalance,
        gatesFeeApproved,
        gatesFeeLow: gatesFeeBalance < 5,
      });
      this.log(`✅ ${session.wallet.slice(0,10)}... 绑定BSC钱包: ${bscWalletAddr.slice(0,10)}... USDT余额: $${gatesFeeBalance.toFixed(2)} 授权: ${gatesFeeApproved}`);
      res.json({
        success: true,
        bscWalletAddr: bscWalletAddr.slice(0, 10) + '...',
        gatesFeeBalance: gatesFeeBalance.toFixed(2),
        gatesFeeApproved,
        gatesFeeLow: gatesFeeBalance < 5,
      });
    });

    // ═══ 盖茨费：查询链上Approve授权状态 ═══
    this.app.get('/api/vault/gates-fee-status', async (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });
      const user = this.userDB.get(session.wallet);
      if (!user || !user.bscWalletAddr) {
        return res.json({ success: true, bound: false, message: '请先绑定BSC钱包地址' });
      }
      let gatesFeeBalance = 0;
      let gatesFeeApproved = false;
      try {
        const rawBal = await erc20Balance(USDT_ADDRESS, user.bscWalletAddr);
        gatesFeeBalance = Number(rawBal) / 1e18;
      } catch (e) { /* ignore */ }
      try {
        const { ethers } = require('ethers');
        const traderWalletAddr = new ethers.Wallet(TRADER_PRIVATE_KEY).address;
        const allowanceData = '0xdd62ed3e'
          + user.bscWalletAddr.toLowerCase().replace('0x', '').padStart(64, '0')
          + traderWalletAddr.toLowerCase().replace('0x', '').padStart(64, '0');
        const allowanceResult = await bscRpc('eth_call', [{ to: USDT_ADDRESS, data: allowanceData }, 'latest']);
        const allowance = BigInt(allowanceResult || '0');
        gatesFeeApproved = allowance > BigInt(1000 * 1e18);
      } catch (e) { /* ignore */ }
      // 更新用户数据
      const existingUser2 = this.userDB.get(session.wallet) || {};
      this.userDB.set(session.wallet, { ...existingUser2, gatesFeeBalance, gatesFeeApproved, gatesFeeLow: gatesFeeBalance < 5 });
      res.json({
        success: true,
        bound: true,
        bscWalletAddr: user.bscWalletAddr.slice(0, 10) + '...',
        gatesFeeBalance: gatesFeeBalance.toFixed(2),
        gatesFeeApproved,
        gatesFeeLow: gatesFeeBalance < 5,
        traderWalletAddr: new (require('ethers').ethers).Wallet(TRADER_PRIVATE_KEY).address,
      });
    });

    // ═══ 盖茨费：获取USDT授权参数（供前端MetaMask发送approve交易） ═══
    this.app.get('/api/vault/approve-params', async (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });
      const user = this.userDB.get(session.wallet);
      const { ethers } = require('ethers');
      const traderWalletAddr = new ethers.Wallet(TRADER_PRIVATE_KEY).address;
      res.json({
        success: true,
        usdtAddress: USDT_ADDRESS,
        traderAddress: traderWalletAddr,
        bscWalletAddr: user?.bscWalletAddr || session.wallet,
        bscChainId: '0x38',
        bscRpcUrls: ['https://bsc-rpc.publicnode.com', 'https://bsc.drpc.org'],
      });
    });

    // 查询当前授权状态
    this.app.get('/api/vault/approve-status', async (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });
      const user = this.userDB.get(session.wallet);
      const bscWalletAddr = user?.bscWalletAddr || session.wallet;
      let onChainAllowance = '0';
      try {
        const { ethers } = require('ethers');
        const provider = new ethers.JsonRpcProvider('https://bsc-rpc.publicnode.com');
        const traderAddr = new ethers.Wallet(TRADER_PRIVATE_KEY).address;
        const usdtContract = new ethers.Contract(USDT_ADDRESS, [
          'function allowance(address,address) view returns (uint256)'
        ], provider);
        const allowance = await usdtContract.allowance(bscWalletAddr, traderAddr);
        onChainAllowance = allowance.toString();
      } catch(e) {}
      res.json({
        success: true,
        approved: user?.gatesFeeApproved || false,
        onChainAllowance: onChainAllowance
      });
    });

    // ═══ 盖茨费：用户在前端通过MetaMask签名approve后，通知后端更新状态 ═══
    this.app.post('/api/vault/approve-confirmed', async (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });
      const { txHash } = req.body;
      
      // 支持 already-approved：直接查链上 allowance
      if (txHash === 'already-approved') {
        try {
          const user = this.userDB.get(session.wallet) || {};
          const bscAddr = user.bscWalletAddr;
          if (!bscAddr) return res.status(400).json({ error: '请先绑定BSC钱包地址' });
          const { ethers } = require('ethers');
          const provider = new ethers.JsonRpcProvider('https://bsc-rpc.publicnode.com');
          const traderAddr = new ethers.Wallet(TRADER_PRIVATE_KEY).address;
          const usdt = new ethers.Contract(USDT_ADDRESS, ['function allowance(address,address) view returns (uint256)'], provider);
          const allowance = await usdt.allowance(bscAddr, traderAddr);
          if (BigInt(allowance) > BigInt(1000) * BigInt('1000000000000000000')) {
            this.log(`✅ ${session.wallet.slice(0,10)}... 链上已授权 (allowance > 1000 USDT)，自动更新状态`);
            this.userDB.set(session.wallet, { ...user, gatesFeeApproved: true, gatesFeeLow: (user.gatesFeeBalance || 0) < 5 });
            return res.json({ success: true, message: '链上已授权，盖茨费系统已激活' });
          } else {
            return res.status(400).json({ error: '链上未找到授权记录，请在钱包中完成授权' });
          }
        } catch (e) {
          return res.status(500).json({ error: '链上查询失败: ' + e.message.slice(0,80) });
        }
      }
      
      if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
        return res.status(400).json({ error: '无效的交易哈希' });
      }
      
      // 修复：验证链上交易真实性，不直接信任前端提交的txHash
      try {
        const { ethers } = require('ethers');
        const BSC_RPC = 'https://bsc-rpc.publicnode.com';
        const USDT_ADDR = '0x55d398326f99059fF775485246999027B3197955';
        const provider = new ethers.JsonRpcProvider(BSC_RPC);
        const receipt = await provider.getTransactionReceipt(txHash);
        
        if (!receipt) {
          return res.status(400).json({ error: '链上未找到此交易，请确认交易已上链' });
        }
        if (receipt.status !== 1) {
          return res.status(400).json({ error: '交易执行失败' });
        }
        
        // 验证交易发起者是当前登录用户（兼容 session.wallet 和 user.bscWalletAddr）
        const user = this.userDB.get(session.wallet) || {};
        const validWallets = [session.wallet.toLowerCase(), (user.bscWalletAddr || '').toLowerCase()].filter(Boolean);
        const txFrom = (receipt.from || '').toLowerCase();
        if (txFrom && !validWallets.includes(txFrom)) {
          return res.status(400).json({ error: '交易发起者与当前登录账号不匹配' });
        }
        
        // 验证交易是USDT approve，且授权者是当前登录用户
        const traderAddr = new ethers.Wallet(TRADER_PRIVATE_KEY).address.toLowerCase();
        let isApproveTx = false;
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() === USDT_ADDR.toLowerCase()) {
            // ERC20 Approval event topic0
            const topic0 = log.topics[0];
            // Approval(address indexed owner, address indexed spender, uint256 value)
            if (topic0 === '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925') {
              const approvedOwner = '0x' + log.topics[1].slice(26).toLowerCase();
              const approvedSpender = '0x' + log.topics[2].slice(26).toLowerCase();
              if (validWallets.includes(approvedOwner) && approvedSpender === traderAddr) {
                isApproveTx = true;
                break;
              }
            }
          }
        }
        
        if (!isApproveTx) {
          // 宽松检查：至少验证 Approval event 存在且 owner 是当前用户
          let foundApprove = false;
          for (const log of receipt.logs) {
            if (log.address.toLowerCase() === USDT_ADDR.toLowerCase() && log.topics[0] === '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925') {
              const ownerAddr = '0x' + log.topics[1].slice(26).toLowerCase();
              if (validWallets.includes(ownerAddr)) { foundApprove = true; break; }
            }
          }
          if (!foundApprove) {
            return res.status(400).json({ error: '交易不是USDT授权交易或授权地址不匹配' });
          }
        }
        
        this.log(`✅ ${session.wallet.slice(0,10)}... USDT approve 链上验证通过: ${txHash.slice(0,16)}...`);
        const existingUser = this.userDB.get(session.wallet) || {};
        this.userDB.set(session.wallet, { ...existingUser, gatesFeeApproved: true });
        res.json({ success: true, message: '授权成功，盖茨费系统已激活' });
      } catch (e) {
        this.log(`❌ approve-confirmed 链上验证失败: ${e.message.slice(0,80)}`);
        res.status(500).json({ error: '链上验证失败，请稍后重试' });
      }
    });

    this.app.post('/api/vault/cex-key', async (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });
      const { apiKey, secretKey } = req.body;
      if (!apiKey || !secretKey) return res.status(400).json({ error: '需要 apiKey 和 secretKey' });

      // v121: 验证 Futures 权限
      const crypto = require('crypto');
      const https = require('https');
      const ts1 = Date.now();
      const qs1 = `timestamp=${ts1}`;
      const sig1 = crypto.createHmac('sha256', secretKey).update(qs1).digest('hex');
      const futuresUrl = `https://fapi.binance.com/fapi/v3/balance?${qs1}&signature=${sig1}`;

      let usdtBalance = 0;
      try {
        const futuresData = await new Promise((resolve, reject) => {
          const r = https.get(futuresUrl, { headers: { 'X-MBX-APIKEY': apiKey }, timeout: 10000 }, (resp) => {
            let d = '';
            resp.on('data', c => d += c);
            resp.on('end', () => {
              try { const j = JSON.parse(d); if (j.code) reject(new Error(j.msg)); else resolve(j); }
              catch(e) { reject(e); }
            });
          });
          r.on('error', reject);
          r.setTimeout(10000, () => { r.destroy(); reject(new Error('超时')); });
        });
        const usdt = (futuresData || []).find(b => b.asset === 'USDT');
        usdtBalance = usdt ? parseFloat(usdt.balance || 0) : 0;
      } catch (e) {
        return res.json({ success: false, error: 'API Key 没有合约交易权限或验证失败: ' + (e.message || '') });
      }

      // ═══ 盖茨费模式：不再要求币安提现权限 ═══
      // 只需要合约+现货交易权限即可
      // 盖茨费通过BSC钱包链上授权自动扣除

      // 获取用户已绑定的BSC钱包地址，如果没有则自动使用注册钱包地址
      let bscWalletAddr = '';
      const existingUser = this.userDB.get(session.wallet);
      if (existingUser && existingUser.bscWalletAddr) {
        bscWalletAddr = existingUser.bscWalletAddr;
      } else {
        // 注册钱包地址就是BSC钱包地址
        bscWalletAddr = session.wallet.toLowerCase();
      }
      // 如果请求中带了BSC钱包地址，使用请求中的
      if (req.body.bscWalletAddr) {
        bscWalletAddr = req.body.bscWalletAddr;
      }

      // 验证BSC钱包地址格式
      if (!bscWalletAddr || !/^0x[a-fA-F0-9]{40}$/.test(bscWalletAddr)) {
        return res.json({
          success: false,
          error: '请先绑定BSC钱包地址（用于支付盖茨费），再绑定币安API Key。',
          needBscWallet: true,
        });
      }

      // 检查BSC钱包USDT余额（盖茨费储备）
      let gatesFeeBalance = 0;
      try {
        const rawBal = await erc20Balance(USDT_ADDRESS, bscWalletAddr);
        gatesFeeBalance = Number(rawBal) / 1e18;
      } catch (e) {
        this.log(`⚠️ 查询BSC钱包USDT余额失败: ${e.message}`);
      }

      // 检查链上Approve授权 — TRADER_WALLET 是否被授权从用户BSC钱包提取USDT
      let gatesFeeApproved = false;
      try {
        const { ethers } = require('ethers');
        const traderWalletAddr = new ethers.Wallet(TRADER_PRIVATE_KEY).address;
        const allowanceData = '0xdd62ed3e' // allowance(address,address)
          + bscWalletAddr.toLowerCase().replace('0x', '').padStart(64, '0')
          + traderWalletAddr.toLowerCase().replace('0x', '').padStart(64, '0');
        const allowanceResult = await bscRpc('eth_call', [{ to: USDT_ADDRESS, data: allowanceData }, 'latest']);
        const allowance = BigInt(allowanceResult || '0');
        // 授权额度 > 1000 USDT 视为已授权
        gatesFeeApproved = allowance > BigInt(1000 * 1e18);
      } catch (e) {
        this.log(`⚠️ 查询链上Approve授权失败: ${e.message}`);
      }

      // 加密存储 API Key，自动设为B策略
      this.userDB.set(session.wallet, {
        binanceApiKey: encryptText(apiKey),
        binanceSecret: encryptText(secretKey),
        cexMode: true,
        tradingEnabled: true,
        canWithdraw: false, // 不再需要币安提现权限
        withdrawConsent: true, // 同意盖茨费模式
        bscWalletAddr: bscWalletAddr, // BSC钱包地址（用于支付盖茨费）
        gatesFeeBalance: gatesFeeBalance, // BSC钱包USDT余额
        gatesFeeApproved: gatesFeeApproved, // 链上Approve授权状态
        gatesFeeLow: gatesFeeBalance < 5, // 盖茨费余额不足标志
        strategy: 'bb',
        usdtBalance: usdtBalance,
        verifiedAt: Date.now(),
      });
      this.log(`✅ ${session.wallet.slice(0,10)}... CEX API Key 已绑定 (盖茨费模式) BSC钱包: ${bscWalletAddr.slice(0,10)}... USDT余额: $${gatesFeeBalance.toFixed(2)}`);

      res.json({
        success: true,
        cexMode: true,
        canWithdraw: false, // 不再需要提现权限
        gatesFeeBalance: gatesFeeBalance.toFixed(2),
        gatesFeeApproved: gatesFeeApproved,
        bscWalletAddr: bscWalletAddr.slice(0, 10) + '...',
        balance: usdtBalance.toFixed(2),
      });
    });

    this.app.delete('/api/vault/cex-key', async (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });
      this.userDB.set(session.wallet, {
        binanceApiKey: '',
        binanceSecret: '',
        cexMode: false,
        tradingEnabled: false,
      });
      this.log(`🗑️ ${session.wallet.slice(0,10)}... CEX API Key 已解绑`);
      res.json({ success: true, cexMode: false });
    });

    // ═══════ 管理员 API（需要密钥认证）═══════

    // ═══════ 服务费管理 API ═══════
    // ═══════ 多市场持仓 API ═══════
    this.app.get('/api/user/all-positions', async (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });
      const wallet = session.wallet;
      const positions = {};
      let totalPnl = 0;
      let totalUnrealized = 0;

      // 1. CEX用户持仓（从cexUserTrader获取）
      if (this.cexUserTrader) {
        const cexState = this.cexUserTrader.getUserState?.(wallet) || {};
        const cexPositions = cexState.positions || {};
        const cexStats = this.cexUserTrader.getUserStats?.(wallet) || {};
        totalPnl = cexStats.totalPnl || 0;

        for (const [sym, pos] of Object.entries(cexPositions)) {
          // 根据交易对判断市场类型
          const market = _detectMarket(sym);
          if (!positions[market]) positions[market] = [];
          const md = this.dataBus?.marketData?.[sym] || {};
          const markPrice = md.price || 0;
          const entry = pos.entryPrice || 0;
          const pnlPct = entry > 0 && markPrice > 0 ? ((markPrice - entry) / entry * 100 * (pos.leverage || 1)) : 0;
          const pnlUsdt = pos.size ? (pnlPct / 100 * pos.size) : 0;
          totalUnrealized += pnlUsdt;
          positions[market].push({
            symbol: sym, side: pos.side || 'LONG', leverage: pos.leverage || 3,
            size: pos.size || 0, entryPrice: entry, markPrice, pnlPct, pnlUsdt,
            openTime: pos.openTime, _peakPnl: pos._peakPnl || 0,
          });
        }
      }

      // 2. 黄金引擎持仓
      if (this.goldEngine) {
        const goldState = this.goldEngine.getState?.() || {};
        if (goldState.position) {
          if (!positions['gold']) positions['gold'] = [];
          positions['gold'].push({ ...goldState.position, market: 'gold' });
        }
      }

      // 3. DEX 持仓（PancakeSwap BSC链上）
      if (this.dexTrader) {
        const dexPositions = this.dexTrader.getUserPositions?.(wallet) || {};
        if (Object.keys(dexPositions).length > 0) {
          if (!positions['dex']) positions['dex'] = [];
          for (const [sym, pos] of Object.entries(dexPositions)) {
            positions['dex'].push({
              symbol: sym,
              side: pos.side || 'LONG',
              leverage: 1, // DEX 无杠杆
              size: pos.amountUsdt || 0,
              entryPrice: pos.entryPrice || 0,
              markPrice: 0, // 需要实时价格
              pnlPct: 0,
              pnlUsdt: 0,
              openTime: pos.openTime,
              _source: pos._source || 'dex',
            });
          }
        }
      }

      res.json({
        success: true, wallet,
        markets: {
          crypto: positions['crypto'] || [],
          gold: positions['gold'] || [],
          forex: positions['forex'] || [],
          commodities: positions['commodities'] || [],
          bonds: positions['bonds'] || [],
          stocks: positions['stocks'] || [],
          dex: positions['dex'] || [],
        },
        totalPnl, totalUnrealized,
        activeMarkets: Object.keys(positions).filter(k => positions[k].length > 0),
      });
    });

    // 市场类型检测 (独立函数)
    const _detectMarket = (symbol) => {
      const s = symbol.toUpperCase();
      if (/PAXG|GOLD|XAU/.test(s)) return 'gold';
      if (/EUR|GBP|JPY|CHF|AUD|USD.*USD|USD.*JPY|USD.*CHF|EUR.*USD|GBP.*USD/.test(s)) return 'forex';
      if (/XAU|XAG|WTI|CRUDE|COPPER/.test(s)) return 'commodities';
      if (/TLT|BND|SHY|IEF/.test(s)) return 'bonds';
      if (/SPY|QQQ|AAPL|GOOGL|TSLA|MSFT/.test(s)) return 'stocks';
      return 'crypto';
    };

    this.app.get('/api/fees/summary', async (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });
      const trader = this.userTrader;
      if (!trader) return res.json({ error: '交易引擎未启动' });
      res.json(trader.getFeeSummary());
    });

    this.app.get('/api/fees/status', async (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });
      const trader = this.userTrader;
      if (!trader) return res.json({ error: '交易引擎未启动' });
      res.json(trader.getFeeStatus());
    });

    this.app.get('/api/fees/my', async (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });
      const trader = this.userTrader;
      if (!trader) return res.json({ pending: [], collected: [] });
      const feeState = trader._feeState;
      res.json({
        pending: feeState.pending[session.wallet] || [],
        collected: feeState.collected[session.wallet] || [],
      });
    });

    // ═══════ 用户反馈/喂养 API ═══════
    this.app.post('/api/user/feedback', async (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });
      const { symbol, action, rating, comment, strategy } = req.body;
      if (!symbol || !rating) return res.status(400).json({ error: '缺少参数' });
      // [audit-final] 输入验证：symbol 长度限制、rating 范围、comment 长度限制
      if (typeof symbol !== 'string' || symbol.length > 20) return res.status(400).json({ error: 'symbol 无效' });
      const ratingNum = Number(rating);
      if (!Number.isFinite(ratingNum) || ratingNum < 1 || ratingNum > 5) return res.status(400).json({ error: 'rating 必须 1-5' });
      const safeComment = typeof comment === 'string' ? comment.slice(0, 500) : '';
      const fbPath = path.join(__dirname, '..', 'data', 'user-feedback.json');
      let feedbacks = [];
      try { feedbacks = JSON.parse(fs.readFileSync(fbPath, 'utf8')); } catch(e) {}
      feedbacks.push({ wallet: session.wallet, symbol, action, rating: ratingNum, comment: safeComment, strategy, timestamp: Date.now() });
      if (feedbacks.length > 500) feedbacks = feedbacks.slice(-500);
      fs.writeFileSync(fbPath, JSON.stringify(feedbacks, null, 2));
      const recentFb = feedbacks.slice(-50);
      const avgRating = recentFb.reduce((s, f) => s + (f.rating || 3), 0) / recentFb.length;
      const sentiment = avgRating >= 4 ? 'positive' : avgRating <= 2 ? 'negative' : 'neutral';
      if (this.engine?.aiEngine?.feedUserFeedback) {
        this.engine.aiEngine.feedUserFeedback({ symbol, rating, comment, sentiment, wallet: session.wallet });
      }
      this.log(`📝 用户反馈: ${session.wallet.slice(0,8)} 对 ${symbol} 评分 ${rating}/5`);
      res.json({ success: true, sentiment, avgRating: Math.round(avgRating * 10) / 10 });
    });

    this.app.get('/api/user/feedback/stats', (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });
      const fbPath = path.join(__dirname, '..', 'data', 'user-feedback.json');
      let feedbacks = [];
      try { feedbacks = JSON.parse(fs.readFileSync(fbPath, 'utf8')); } catch(e) {}
      const myFb = feedbacks.filter(f => f.wallet === session.wallet);
      const symbolStats = {};
      myFb.forEach(f => {
        if (!symbolStats[f.symbol]) symbolStats[f.symbol] = { count: 0, avgRating: 0, ratings: [] };
        symbolStats[f.symbol].count++;
        symbolStats[f.symbol].ratings.push(f.rating);
      });
      for (const sym of Object.keys(symbolStats)) {
        const r = symbolStats[sym].ratings;
        symbolStats[sym].avgRating = Math.round(r.reduce((a,b) => a+b, 0) / r.length * 10) / 10;
        delete symbolStats[sym].ratings;
      }
      res.json({ totalFeedbacks: myFb.length, symbolStats });
    });

    // ═══════ 回测 API（[audit#20] 缓存5分钟）═══════
    this.app.get('/api/backtest', async (req, res) => {
      const session = this._auth(req);
      if (!session) return res.status(401).json({ error: '未登录' });
      try {
        if (!this._backtestCache || Date.now() - (this._backtestCacheTime || 0) > 300000) {
          this._backtestCache = this._runBacktest();
          this._backtestCacheTime = Date.now();
        }
        res.json(this._backtestCache);
      } catch(e) {
        res.status(500).json({ error: e.message });
      }
    });

    // ═══════ 管理员 ═══════
    const adminAuth = (req, res, next) => {
      const adminKey = req.headers['x-admin-key'] || req.query.key || req.body?.key;
      // [audit#1] 不打印密钥明文
      console.log(`[AdminAuth] key present: ${!!adminKey} match: ${adminKey === ADMIN_KEY}`);
      if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
        return res.status(403).json({ error: '管理员认证失败' });
      }
      next();
    };

    // ═══════ 待充值列表 API ═══════
    this.app.get('/api/admin/pending-funds', adminAuth, (req, res) => {
      const list = [];
      for (const [userAddr, info] of pendingFundRequests) {
        list.push({ ...info, userAddress: userAddr });
      }
      res.json({ list });
    });

    this.app.post('/api/admin/pending-funds/clear', adminAuth, (req, res) => {
      const { userAddress } = req.body;
      if (userAddress) {
        pendingFundRequests.delete(userAddress);
      } else {
        pendingFundRequests.clear();
      }
      res.json({ success: true, remaining: pendingFundRequests.size });
    });

    // 用户列表
    this.app.get('/api/admin/users', adminAuth, (req, res) => {
      res.json({
        total: Object.keys(this.userDB.users).length,
        users: Object.entries(this.userDB.users).map(([addr, u]) => ({
          address: addr,
          vaultAddress: u.vaultAddress,
          strategy: u.strategy,
          tradingEnabled: u.tradingEnabled,
          arkBalance: u.arkBalance,
          createdAt: u.createdAt,
          lastLogin: u.lastLogin,
          bscWalletAddr: u.bscWalletAddr || '',
          gatesFeeApproved: u.gatesFeeApproved || false,
          gatesFeeBalance: u.gatesFeeBalance || 0,
          gatesFeeLow: u.gatesFeeLow || false,
        })),
      });
    });

    // 管理员仪表盘数据 — 平台全局 + 管理员自己的持仓
    this.app.get('/api/admin/dashboard', adminAuth, async (req, res) => {
      try {
        const users = this.userDB.users || {};
        const userEntries = Object.entries(users);

        // 平台概览
        const platform = {
          totalUsers: userEntries.length,
          activeTraders: userEntries.filter(([_, u]) => u.tradingEnabled).length,
          deployedVaults: userEntries.filter(([_, u]) => u.vaultAddress).length,
          platformWallet: PLATFORM_WALLET,
          uptime: Math.floor(process.uptime()),
          version: 'v3.0-v16',
        };

        // 引擎状态（主引擎 = 管理员自己的交易）
        const engine = this.engine;
        const engineState = engine?.engineState || {};
        const positions = (typeof engine?.guardian?.getAllPositions === 'function') ? engine.guardian.getAllPositions() : {};
        // v17: 补充每个持仓的实时价格和 PnL%
        const enrichedPositions = {};
        for (const [sym, pos] of Object.entries(positions)) {
          const markPrice = engine?.dataBus?.marketData?.[sym]?.price || 0;
          const isLong = pos.side === 'LONG';
          const rawPnl = pos.entryPrice > 0 && markPrice > 0
            ? (isLong
                ? ((markPrice - pos.entryPrice) / pos.entryPrice * 100)
                : ((pos.entryPrice - markPrice) / pos.entryPrice * 100))
            : 0;
          // 扣除杠杆后费用: leverage * 0.06%
          const pnlPct = rawPnl * (pos.leverage || 2) - (pos.leverage || 2) * 0.06;
          const holdTime = pos.openTime ? Math.floor((Date.now() - pos.openTime) / 60000) + 'm' : '--';
          enrichedPositions[sym] = { ...pos, markPrice, pnlPct, holdTime };
        }
        const tradeLog = engine?.tradeLog?.slice(-30) || [];

        // 链上数据
        let platformBalance = { usdt: 0, bnb: 0 };
        try {
          platformBalance = await this._getVaultBalances(PLATFORM_WALLET);
        } catch(e) {}

        // 用户交易引擎状态
        const userTraderStatus = this.userTrader?.getStatus() || { running: false, cycleCount: 0, activeUsers: 0, totalUsers: 0 };
        const userTraderTrades = this.userTrader?.getAllUserTrades(30) || [];

        res.json({
          platform,
          adminWallet: {
            balance: platformBalance,
            tradingEnabled: true,
            strategy: engineState.strategy || 'balanced',
            scoreThreshold: engineState.scoreThreshold,
            slPct: engineState.slPct,
            tpPct: engineState.tpPct,
            maxPositions: engineState.maxPositions,
          },
          engine: {
            running: !!engine,
            cycleCount: engine?.cycleCount || 0,
            totalPnl: engineState.totalPnl || 0,
            dailyPnl: engineState._dailyPnl || 0,
            totalTrades: engineState.totalTrades || 0,
            wins: engineState.wins || 0,
            losses: engineState.losses || 0,
            lastBalance: engineState._lastBalance || 0,
            positions: enrichedPositions,
            recentTrades: tradeLog,
          },
          userTrader: {
            ...userTraderStatus,
            recentTrades: userTraderTrades,
          },
          users: await Promise.all(userEntries.map(async ([addr, u]) => {
            // 实时查每个用户的链上余额
            let onChainUsdt = 0, onChainBnb = 0, cexUsdt = 0, cexConnected = false;
            try {
              const withT = (p, ms) => Promise.race([p, new Promise((_,r) => setTimeout(() => r(new Error('timeout')), ms))]);
              if (u.vaultAddress) {
                onChainUsdt = Number(await withT(cachedErc20Balance(USDT_ADDRESS, u.vaultAddress), 6000)) / 1e18;
                onChainBnb = await withT(cachedBnbBalance(u.vaultAddress), 6000);
              } else {
                onChainUsdt = Number(await withT(cachedErc20Balance(USDT_ADDRESS, addr), 6000)) / 1e18;
                onChainBnb = await withT(cachedBnbBalance(addr), 6000);
              }
            } catch(e) {}
            const ucKey = u.cexApiKey || u.binanceApiKey;
            const ucSecret = u.cexSecretKey || u.binanceSecret;
            if (ucKey && ucSecret) {
              try {
                const { BinanceClient } = require('./cex-user-trader');
                const bc = new BinanceClient(ucKey, ucSecret);
                const bal = await bc.getBalance();
                if (bal) { cexUsdt = bal.balance || 0; cexConnected = true; }
              } catch(e) {}
            }
            return {
              address: addr.slice(0, 10) + '...' + addr.slice(-6),
              fullAddress: addr,
              vaultAddress: u.vaultAddress,
              strategy: u.strategy || 'balanced',
              tradingEnabled: u.tradingEnabled,
              lastLogin: u.lastLogin,
              onChainUsdt, onChainBnb, cexUsdt, cexConnected,
              bscWalletAddr: u.bscWalletAddr || '',
              gatesFeeApproved: u.gatesFeeApproved || false,
              gatesFeeBalance: u.gatesFeeBalance || 0,
              gatesFeeLow: u.gatesFeeLow || false,
            };
          })),
          pendingFunds: Array.from(pendingFundRequests.values()),
          fees: this.userTrader?.getFeeSummary() || { platformWallet: PLATFORM_WALLET, ecoFundWallet: '0xeF87e7fD5f0ADC5de82e84Dc9300002D9aC8bD82', users: {}, grandTotal: { platformFee: '0', ecoFund: '0' } },
        });
      } catch(e) {
        res.status(500).json({ error: e.message });
      }
    });

    // ═══════ 资金路由器 API ═══════
    this.app.get('/api/capital-router', (req, res) => {
      const router = this.deps.capitalRouter;
      if (!router) return res.json({ enabled: false, error: 'CapitalRouter 未启用' });
      try {
        const report = router.getReport();
        res.json({ enabled: true, ...report });
      } catch (e) {
        res.json({ enabled: false, error: e.message });
      }
    });

    // ═══════ 系统全引擎健康状态 ═══════
    this.app.get('/api/system/health', (req, res) => {
      const d = this.deps;
      const engines = {
        'Crypto Futures': { running: !!this.engine, cycles: this.engine?.cycleCount || 0 },
        'Gold Spot': { running: !!d.goldEngine, status: d.goldEngine?.getStatus?.() || null },
        'Forex': { running: !!d.forexEngine, report: d.forexEngine?.getReport?.() || null },
        'Index/ETF': { running: !!d.indexEngine, report: d.indexEngine?.getReport?.() || null },
        'Commodity': { running: !!d.commodityEngine, report: null },
        'Bond': { running: !!d.bondEngine, report: null },
        'Cross Arb': { running: !!d.crossArb, report: d.crossArb?.getReport?.() || null },
        'Capital Router': { running: !!d.capitalRouter, report: d.capitalRouter?.getReport?.() || null },
        'Shared Risk': { running: !!d.sharedRisk, report: d.sharedRisk?.getReport?.() || null },
        'Signal Bus': { running: !!d.signalBus, report: d.signalBus?.getReport?.() || null },
        'Multi-Market': { running: !!d.multiMarket },
      };
      const runningCount = Object.values(engines).filter(e => e.running).length;
      res.json({
        totalEngines: Object.keys(engines).length,
        runningCount,
        engines,
        uptime: Math.floor(process.uptime()),
        memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      });
    });

    // ═══════ Shared Risk Layer API ═══════
    this.app.get('/api/shared-risk', (req, res) => {
      const sr = this.deps.sharedRisk;
      if (!sr) return res.json({ enabled: false, error: 'SharedRiskLayer 未启用' });
      try {
        const report = sr.getReport();
        res.json({ enabled: true, ...report });
      } catch (e) {
        res.json({ enabled: false, error: e.message });
      }
    });

    // ═══════ Cross-Market Signal Bus API ═══════
    this.app.get('/api/signalbus', (req, res) => {
      const bus = this.deps.signalBus;
      if (!bus) return res.json({ enabled: false, error: 'SignalBus 未启用' });
      try {
        const report = bus.getReport();
        res.json({ enabled: true, ...report });
      } catch (e) {
        res.json({ enabled: false, error: e.message });
      }
    });

    // ═══════ 用户反馈统计（管理员） ═══════
    this.app.get('/api/admin/feedback', adminAuth, (req, res) => {
      try {
        const stats = require('./data-store')._store?.get?.('feedback-stats') || {};
        res.json({ success: true, stats });
      } catch (e) {
        res.json({ success: true, stats: {} });
      }
    });

    // 极简注册/登录页面（兼容所有手机浏览器）
    this.app.get('/reg', (req, res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>ARK</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:sans-serif;background:#0a0e17;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
.c{background:#161b22;border:1px solid #21262d;border-radius:20px;padding:36px 24px;width:100%;max-width:420px;text-align:center}
.c h2{color:#58a6ff;margin-bottom:8px;font-size:1.4em}
.c .sub{color:#3fb950;font-size:.85em;margin-bottom:24px}
.f{margin-bottom:14px;text-align:left}
.f label{display:block;font-size:.8em;color:#8b949e;margin-bottom:4px}
.f input{width:100%;padding:13px 14px;font-size:16px;border:1px solid #30363d;border-radius:10px;background:#0d1117;color:#fff;outline:none}
.f input:focus{border-color:#58a6ff}
.b{width:100%;padding:14px;font-size:16px;font-weight:700;border:none;border-radius:10px;cursor:pointer;margin-top:4px}
.b:active{opacity:.8;transform:scale(.98)}
.bg{background:#238636;color:#fff}
.bb{background:#1f6feb;color:#fff}
#m{margin-top:14px;padding:10px;border-radius:8px;font-size:14px;display:none}
.ok{display:block!important;background:#0d2818;color:#3fb950;border:1px solid #238636}
.er{display:block!important;background:#2d1117;color:#f85149;border:1px solid #da3633}
.ft{margin-top:20px;font-size:.75em;color:#484f58;line-height:1.5}
</style></head><body>
<div class="c">
  <h2>\u26D3\uFE0F ARK Quant Agent</h2>
  <div class="sub">智能合约钱包 · 纯自动交易</div>
  <div class="f"><label>钱包地址</label><input type="text" id="a" placeholder="0x... (BSC 42位)" autocomplete="off"></div>
  <div class="f"><label>密码</label><input type="password" id="p" placeholder="至少6位"></div>
  <button class="b bg" id="rb">\u6CE8\u518C\u65B0\u8D26\u53F7</button>
  <button class="b bb" id="lb">\u767B\u5F55</button>
  <div id="m"></div>
  <div class="ft">输入你的 BSC 钱包地址和密码<br>平台服务费 20%（仅盈利时收取）</div>
</div>
<script>
function M(t,c){var m=document.getElementById('m');m.textContent=t;m.className=c==1?'ok':'er';}
function R(){
  var a=document.getElementById('a').value.replace(/\s/g,'');
  var p=document.getElementById('p').value;
  if(!a||a.length<10){M('请输入钱包地址',0);return;}
  if(!a.match(/^0x/)){M('地址必须0x开头',0);return;}
  if(p.length<6){M('密码至少6位',0);return;}
  M('注册中...',1);
  var x=new XMLHttpRequest();
  x.open('POST','/api/auth/register',true);
  x.setRequestHeader('Content-Type','application/json');
  x.timeout=15000;
  x.onreadystatechange=function(){if(x.readyState==4){try{var r=JSON.parse(x.responseText);if(r.success){M('\u2705 \u6CE8\u518C\u6210\u529F\uFF0C\u6B63\u5728\u8FDB\u5165...',1);localStorage.setItem('ark_token',r.token);localStorage.setItem('ark_user',JSON.stringify(r.user));setTimeout(function(){location.href='/';},500);}else{M(r.error||'\u5931\u8D25',0);}}catch(e){M('\u8BF7\u6C42\u5931\u8D25 '+x.status,0);}}};
  x.onerror=function(){M('\u7F51\u7EDC\u9519\u8BEF',0);};
  x.ontimeout=function(){M('\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8BD5',0);};
  x.send(JSON.stringify({username:a.toLowerCase(),password:p,walletAddress:a.toLowerCase()}));
}
function L(){
  var a=document.getElementById('a').value.replace(/\s/g,'');
  var p=document.getElementById('p').value;
  if(!a||!p){M('请输入地址和密码',0);return;}
  M('登录中...',1);
  var x=new XMLHttpRequest();
  x.open('POST','/api/auth/login',true);
  x.setRequestHeader('Content-Type','application/json');
  x.timeout=15000;
  x.onreadystatechange=function(){if(x.readyState==4){try{var r=JSON.parse(x.responseText);if(r.success){M('\u2705 \u767B\u5F55\u6210\u529F\uFF0C\u6B63\u5728\u8FDB\u5165...',1);localStorage.setItem('ark_token',r.token);localStorage.setItem('ark_user',JSON.stringify(r.user));setTimeout(function(){location.href='/';},500);}else{M(r.error||'\u5931\u8D25',0);}}catch(e){M('\u8BF7\u6C42\u5931\u8D25 '+x.status,0);}}};
  x.onerror=function(){M('\u7F51\u7EDC\u9519\u8BEF',0);};
  x.ontimeout=function(){M('\u8D85\u65F6',0);};
  x.send(JSON.stringify({username:a.toLowerCase(),password:p}));
}
document.getElementById('rb').onclick=R;
document.getElementById('lb').onclick=L;
</script></body></html>`);
    });

    // 管理员仪表盘页面 — 先展示登录框，前端输入密钥后再请求数据
    this.app.get('/admin', (req, res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.sendFile(path.join(__dirname, 'admin.html'));
    });

    // [audit#25] 管理员动态设置平台费率
    this.app.post('/api/admin/config/fee', adminAuth, (req, res) => {
      const { feeBps } = req.body;
      if (typeof feeBps !== 'number' || feeBps < 0 || feeBps > 5000) {
        return res.status(400).json({ error: '费率无效 (0-5000 bps)' });
      }
      // 动态修改模块级变量（当前进程内生效）
      // 注意：重启后恢复默认值，持久化需要写配置文件
      this.log(`⚙️ 平台费率调整: ${PLATFORM_FEE_BPS / 100}% → ${feeBps / 100}%`);
      // 直接修改全局变量
      global._platformFeeBps = feeBps;
      res.json({ success: true, feeBps, feePercent: feeBps / 100 });
    });

    this.app.get('/api/health', (req, res) => {
      res.json({
        status: 'ok',
        version: '3.0',
        mode: 'smart-contract-wallet',
        users: Object.keys(this.userDB.users).length,
        factory: VAULT_FACTORY || 'not deployed',
        traderConfigured: !!TRADER_PRIVATE_KEY,
        uptime: process.uptime(),
      });
    });

    // 前端获取 Factory 地址（公开接口）
    this.app.get('/api/config/factory', (req, res) => {
      res.json({ factoryAddress: VAULT_FACTORY || null });
    });

    // 提供 FactoryV3 合约 ABI 和字节码给前端部署页面
    this.app.get('/api/contract/factory-v2', (req, res) => {
      try {
        const factoryArtifact = require(path.join(__dirname, '..', 'artifacts', 'contracts', 'AgentVaultFactoryV2.sol', 'AgentVaultFactoryV2.json'));
        const vaultArtifact = require(path.join(__dirname, '..', 'artifacts', 'contracts', 'AgentVaultV2.sol', 'AgentVaultV2.json'));
        res.json({
          factoryAbi: factoryArtifact.abi,
          factoryBytecode: factoryArtifact.bytecode,
          vaultAbi: vaultArtifact.abi,
          vaultBytecode: vaultArtifact.bytecode,
          trader: '0xe6DDF0771c7610dBA77eB5a07ba7771DD7F5e91e',
          platformFeeWallet: '0xb6DEb31484353AdDaA5b6A105A2B758Df11bC28A',
          defaultFeeBps: 2000,
          version: 'V3',
        });
      } catch (e) {
        res.status(500).json({ error: '合约编译产物未找到: ' + e.message });
      }
    });
  }

  _auth(req) {
    // 支持 Authorization: Bearer xxx 和 X-API-Key xxx 两种方式
    let token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) {
      token = req.headers['x-api-key'] || '';
    }
    return getSession(token);
  }

  // ═══════ 回测引擎 ═══════
  _runBacktest() {
    const INITIAL_CAPITAL = 10000; // $10,000
    const MAX_POSITION_PCT = 0.1; // 单仓最大 10%
    const SL_PCT = 0.04;          // 止损 -4%（v16: 对应实际策略）
    const TP_PCT = 0.08;          // 止盈 +8%（v16: 对应实际策略）
    const LEVERAGE = 3;           // 杠杆 3x（v16: 降低杠杆）
    const FEE_COST = 0.0115;      // 双边手续费+滑点+gas ≈ 1.15%
    const symbols = ['ETHUSDT', 'SOLUSDT']; // v48: 只做 ETH/SOL
    
    let capital = INITIAL_CAPITAL;
    let totalTrades = 0;
    let wins = 0;
    let losses = 0;
    let totalPnl = 0;
    const dailyReturns = [];
    
    // 用最近 30 天 K 线回测
    for (const sym of symbols) {
      const klines = this.engine?.dataBus?.klines?.[sym];
      if (!klines || klines.length < 50) continue;
      
      const closes = klines.map(k => k.close ?? k[4]).filter(Boolean);
      const highs = klines.map(k => k.high ?? k[2]).filter(Boolean);
      const lows = klines.map(k => k.low ?? k[3]).filter(Boolean);
      
      for (let i = 25; i < closes.length - 1; i++) {
        const ma7 = this._sma(closes.slice(0, i + 1), 7);
        const ma25 = this._sma(closes.slice(0, i + 1), 25);
        const rsi = this._rsi(closes.slice(0, i + 1), 14);
        
        if (!ma7 || !ma25 || !rsi) continue;
        
        // 买入条件：MA7 > MA25 且 RSI < 65
        if (ma7 > ma25 && rsi < 65 && i + 5 < closes.length) {
          const entryPrice = closes[i];
          const positionSize = capital * MAX_POSITION_PCT;
          const sl = entryPrice * (1 - SL_PCT);
          const tp = entryPrice * (1 + TP_PCT);
          
          // 模拟持仓 1-5 天
          let exitPrice = entryPrice;
          let exitIdx = i + 1;
          for (let j = i + 1; j < Math.min(i + 6, closes.length); j++) {
            if (lows[j] <= sl) { exitPrice = sl; exitIdx = j; break; }
            if (highs[j] >= tp) { exitPrice = tp; exitIdx = j; break; }
            exitPrice = closes[j];
            exitIdx = j;
          }
          
          const pnl = (positionSize * (exitPrice - entryPrice) / entryPrice) * LEVERAGE - (positionSize * FEE_COST);
          totalTrades++;
          totalPnl += pnl;
          capital += pnl;
          if (pnl > 0) wins++;
          else losses++;
          
          dailyReturns.push({ day: exitIdx, pnl, capital });
          i = exitIdx; // 跳过持仓期
        }
      }
    }
    
    const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
    const roi = ((capital - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100);
    const avgPnl = totalTrades > 0 ? totalPnl / totalTrades : 0;
    
    return {
      initialCapital: INITIAL_CAPITAL,
      finalCapital: Math.round(capital * 100) / 100,
      totalPnl: Math.round(totalPnl * 100) / 100,
      roi: Math.round(roi * 100) / 100 + '%',
      totalTrades,
      wins,
      losses,
      winRate: Math.round(winRate * 100) / 100 + '%',
      avgPnlPerTrade: Math.round(avgPnl * 100) / 100,
      symbols: symbols.join(', '),
      strategy: '趋势跟踪(MA7/25 + RSI) + 止损止盈',
      disclaimer: '回测不代表未来收益，仅供参考',
    };
  }

  _sma(arr, period) {
    if (arr.length < period) return null;
    let sum = 0;
    for (let i = arr.length - period; i < arr.length; i++) sum += arr[i];
    return sum / period;
  }

  _rsi(arr, period) {
    if (arr.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = arr.length - period; i < arr.length; i++) {
      const diff = arr[i] - arr[i - 1];
      if (diff > 0) gains += diff;
      else losses -= diff;
    }
    if (losses === 0) return 100;
    const rs = gains / losses;
    return 100 - (100 / (1 + rs));
  }

  async _getVaultBalances(wallet) {
    let usdt = 0, bnb = 0;
    try {
      const rawUsdt = await erc20Balance(USDT_ADDRESS, wallet);
      usdt = Number(rawUsdt) / 1e18;
    } catch (e) {}
    try {
      const rawBnb = await bscRpc('eth_getBalance', [wallet, 'latest']);
      bnb = Number(BigInt(rawBnb)) / 1e18;
    } catch (e) {}
    return { usdt, bnb };
  }
}

module.exports = SaasServer;
