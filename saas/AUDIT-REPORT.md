# 🔍 SaaS 平台全面安全审计报告

**审计时间：** 2026-06-27  
**审计范围：** server.js, user-trader.js, public/index.html, start.js  
**审计人：** MasterD  

---

## 🔴 高危问题（需立即修复）

### 1. [server.js] 管理员密钥明文打印到日志
**行号：** ~1210 (`adminAuth` 中间件)  
**问题：** `console.log('[AdminAuth] got: "${adminKey}" expected: "${ADMIN_KEY}" match: ${adminKey === ADMIN_KEY}')`  
**风险：** 管理员密钥被明文打印到日志，任何能访问日志的人都能获取管理员权限  
**修复：** 移除或脱敏该日志
```js
// 修复后
console.log(`[AdminAuth] match: ${adminKey === ADMIN_KEY}`);
```

### 2. [server.js] CORS 完全开放
**行号：** ~480  
**问题：** `res.header('Access-Control-Allow-Origin', '*')`  
**风险：** 任何网站都可以发起跨域请求调用你的 API。攻击者可以构造恶意页面让已登录用户执行操作  
**修复：** 限制为已知域名
```js
const ALLOWED_ORIGINS = ['http://localhost:8010', '你的公网域名'];
this.app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  // ...
});
```

### 3. [server.js] 余额查询 API 无缓存、无频率限制
**行号：** `/api/dashboard` (~1100行)  
**问题：** 每次仪表盘刷新（前端 5 秒轮询）都查 3 次链上 RPC（ARK + BNB + USDT），17 个用户每 5 秒 = 17×3 = 51 次 RPC 请求/5秒  
**风险：** BSC RPC 限频 → 所有用户仪表盘白屏/报错  
**修复：** 对余额查询做 10 秒缓存
```js
const _balanceCache = new Map(); // wallet → { data, expireAt }
function getCachedBalance(wallet, fn, ttlMs = 10000) {
  const cached = _balanceCache.get(wallet);
  if (cached && Date.now() < cached.expireAt) return Promise.resolve(cached.data);
  return fn().then(data => { _balanceCache.set(wallet, { data, expireAt: Date.now() + ttlMs }); return data; });
}
```

### 4. [server.js] UserDB._save() 同步写大 JSON，可能阻塞事件循环
**行号：** ~192  
**问题：** `fs.writeFileSync(USER_DB, JSON.stringify(this.users, null, 2))` — 每次任何用户操作都同步写入整个用户数据库  
**风险：** 17+ 用户并发操作时，文件 I/O 阻塞所有请求；文件写到一半崩溃 → 数据损坏  
**修复：** 用 debounce + 异步写入
```js
_save() {
  if (this._saveTimer) clearTimeout(this._saveTimer);
  this._saveTimer = setTimeout(async () => {
    const dir = path.dirname(USER_DB);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = USER_DB + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.users, null, 2));
    fs.renameSync(tmp, USER_DB); // 原子替换
  }, 500);
}
```

### 5. [server.js] Session 文件同步写入 + debounce 30 秒可能丢失
**行号：** ~283  
**问题：** `_saveSessions` 用 `setTimeout(30000)` 延迟写入。如果服务器在 30 秒内崩溃，所有新 session 丢失  
**风险：** 重启后大量用户被迫重新登录  
**修复：** 缩短到 5 秒 + 关键操作（登录/登出）立即写入

### 6. [user-trader.js] tx.wait() 使用 ethers v5 API
**行号：** ~445 (`_executeSwapInVault`)  
**问题：** `const receipt = await tx.wait()` — 在 server.js 中已确认 ethers v6 的 `tx.wait()` 有 `url.clone` bug，但 user-trader.js 里没修复  
**风险：** 用户交易执行 100% 失败，资金可能卡在中间状态  
**修复：** 改用与 server.js 相同的轮询方式获取 receipt
```js
// 替换 tx.wait() 为轮询
const MAX_WAIT = 120000;
const start = Date.now();
while (Date.now() - start < MAX_WAIT) {
  await new Promise(r => setTimeout(r, 3000));
  const receipt = await provider.getTransactionReceipt(tx.hash);
  if (receipt) return receipt;
}
throw new Error('Transaction timeout');
```

### 7. [user-trader.js] recordPnl 中 tx.wait() 同样有 url.clone 问题
**行号：** ~458  
**问题：** `await pnlTx.wait()` 同上  
**风险：** 平仓后无法记录 PnL，平台分润失败  

### 8. [user-trader.js] _executeSwapInVault 使用硬编码 gasLimit
**行号：** ~438  
**问题：** `gasLimit: GAS_LIMIT_SWAP (350000)` — 与 server.js 之前同样的问题  
**风险：** 如果 Vault 合约复杂度变化，交易会 revert  
**修复：** 同样改为自动估算 gas

---

## 🟡 中危问题（建议尽快修复）

### 9. [server.js] 密码登录无速率限制
**行号：** `/api/auth/login` (~530行)  
**问题：** 只有签名登录 (`/api/auth/verify`) 有限流，密码登录没有任何限流  
**风险：** 暴力破解密码  
**修复：** 添加登录限流
```js
if (!rateLimit(`login:${clientIp}`, 5, 60000)) {
  return res.status(429).json({ error: '登录尝试过于频繁' });
}
```

### 10. [server.js] register 无速率限制
**行号：** `/api/auth/register` (~501行)  
**问题：** 任何人可以无限注册用户  
**风险：** 数据库膨胀、潜在滥用  
**修复：** 添加 IP 限流

### 11. [server.js] vault/sync 验证逻辑被 catch 吞掉
**行号：** ~1005  
**问题：** `catch (e) { this.log('⚠️ Vault 链上验证失败'); // 不阻断 }` — 验证失败时仍然保存 vault 地址  
**风险：** 攻击者可以提交任意 vault 地址，绑定到自己的账户后让平台交易器在别人的 Vault 上操作  
**修复：** 验证失败时拒绝同步
```js
} catch (e) {
  return res.status(400).json({ error: 'Vault 链上验证失败' });
}
```

### 12. [server.js] 提现 API 不验证调用者是否是 Vault owner
**行号：** `/api/vault/withdraw` (~1055行)  
**问题：** 任何登录用户可以调用提现，但 `sendTx` 用的是平台 trader 私钥而非用户私钥。如果 Vault 合约的 `withdrawAllUSDT` 不检查 msg.sender == owner/authorized，任何 vault 里的资金都可被提取  
**风险：** 需要确认 Vault 合约的 withdraw 函数有权限检查  
**建议：** 验证 session.wallet 是否是 Vault 的 owner

### 13. [server.js] deploy 路由有调试日志残留
**行号：** ~953-960  
**问题：** `console.log('[deploy] Step 1: ...')` 等调试日志  
**修复：** 移除或改为 debug 级别

### 14. [server.js] vault/trading 启用交易时无条件授权 trader
**行号：** ~810-820  
**问题：** 用户点"开启交易"时，如果链上 trader 不匹配，平台自动调 `setTrader` 授权。但 `sendTx` 用的是平台私钥，而 `setTrader` 需要 Vault owner 调用  
**风险：** 如果 Vault 的 `setTrader` 要求 msg.sender == owner，交易会 revert，但错误被静默处理  
**建议：** 确认 Vault 合约中 `setTrader` 的权限模型

### 15. [user-trader.js] 代币地址映射不完整
**行号：** `_getBscToken()` (~560行)  
**问题：** 缺少 FARTCOIN、PENGU、WIF、TRUMP、NEAR 等当前活跃交易对的地址。虽然日志显示正在交易这些币种  
**风险：** 找不到代币地址 → 返回 null → 跳过交易。或者如果 DataBus 配置了这些交易对但 user-trader 无法交易 → 资源浪费  
**修复：** 补全缺失的代币地址

### 16. [server.js] nonce 清理内存泄漏
**行号：** ~26  
**问题：** `_usedNonces` Map 在超过 500 条时才清理，但只清理过期的。如果攻击者大量发送不同 nonce，Map 会持续增长  
**修复：** 改为定时清理

### 17. [server.js] 静态文件路径暴露源代码
**行号：** ~470  
**问题：** `express.static` 可能暴露 server.js、user-trader.js 等文件（取决于目录结构）  
**风险：** 源代码泄露  
**修复：** 确保只有 `public/` 目录被 static 服务（当前实现是对的，但需确认）

---

## 🟢 低危问题（建议修复）

### 18. [server.js] RPC 旋转不基于错误类型
**行号：** `bscRpc` (~90行)  
**问题：** 所有错误（网络、超时、限频）都触发 RPC 旋转  
**修复：** 只在限频和超时时旋转

### 19. [server.js] erc20Balance 硬编码 USDT 6 位小数
**行号：** `erc20Balance` (~130行)  
**问题：** `Number(rawUsdt) / 1e18` — USDT 在 BSC 上是 18 位小数，但某些代币是 6 位或 8 位  
**修复：** 传入 decimals 参数

### 20. [server.js] 回测 API 无缓存
**行号：** `/api/backtest` (~1160行)  
**问题：** 每次请求都运行回测计算  
**修复：** 缓存 5 分钟

### 21. [user-trader.js] pnlTx.wait() 中的 url.clone 问题
**行号：** ~458  
**问题：** 与 #7 相同，`await pnlTx.wait()` 在 ethers v6 中可能抛 url.clone 错误  

### 22. [server.js] dashboard API 每次都重新加载所有交易日志
**行号：** getUserTrades (~1280行)  
**问题：** 每次刷新都 `JSON.parse(fs.readFileSync(TRADE_LOG_FILE))`  
**修复：** 内存缓存 + debounce 读取

### 23. [server.js] sendTx 轮询 120 秒可能阻塞其他请求
**行号：** `sendTx` (~145行)  
**问题：** sendTx 是 async 但 Express 处理器可能被多个同时的 sendTx 占满  
**风险：** 如果多个用户同时部署/交易，HTTP 服务器可能无响应  
**修复：** 添加全局交易并发限制（如同时最多 3 笔）

### 24. [user-trader.js] 硬编码 BNB 价格
**行号：** ~30  
**问题：** `const BNB_PRICE_USD = 650` — gas 成本估算用了硬编码价格  
**修复：** 从 DataBus 获取实时 BNB 价格

### 25. [server.js] 平台费率硬编码
**行号：** ~70  
**问题：** `PLATFORM_FEE_BPS = 2000` (20%) 无法动态调整  
**修复：** 支持管理员动态设置

---

## 📊 修复优先级

| 优先级 | 问题编号 | 预计工作量 |
|--------|----------|-----------|
| **P0 立即** | #1 密钥日志, #6 tx.wait bug | 10 分钟 |
| **P1 今天** | #3 RPC 限频, #9 登录限流, #10 注册限流, #13 调试日志 | 30 分钟 |
| **P2 本周** | #2 CORS, #4 DB 写入, #5 Session 保存, #11 sync 验证, #12 提现验证, #15 代币地址 | 2 小时 |
| **P3 下周** | 其余低危问题 | 3 小时 |

---

## ✅ 已确认安全的点

1. ✅ 密码使用 scrypt + salt 存储（安全）
2. ✅ Session token 用 crypto.randomBytes(32) 生成（安全）
3. ✅ Nonce 防重放机制已实现
4. ✅ 签名验证有 5 种兼容方法
5. ✅ BSC Chain ID 验证
6. ✅ VAULT_FACTORY 地址从环境变量配置
7. ✅ RPC 有多节点轮询容错
8. ✅ Session 有 30 天自动过期
9. ✅ 部署前检查交易器 BNB 余额
