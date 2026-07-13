/**
 * 独立登录服务 — 不依赖 Engine/DataBus/DeepSeek
 * 只做：静态文件 + 登录/注册 + dashboard API
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 10020;
const app = express();

app.use(express.json({ limit: '1mb' }));

// ─── 用户数据库 ───
const USER_DB = path.join(__dirname, '..', 'data', 'saas-users.json');
let users = {};
try {
  const raw = JSON.parse(fs.readFileSync(USER_DB, 'utf8'));
  users = Array.isArray(raw) ? {} : raw;
  if (Array.isArray(raw)) {
    raw.forEach(u => { if (u.username) users[u.username.toLowerCase()] = u; });
  }
} catch(e) { console.error('UserDB load failed:', e.message); }

function saveUsers() {
  fs.writeFileSync(USER_DB, JSON.stringify(users, null, 2));
}
function findUser(addr) {
  return users[addr.toLowerCase()] || null;
}

// ─── Session ───
const sessions = new Map();
const SESSION_FILE = path.join(__dirname, '..', 'data', 'saas-sessions.json');
try {
  const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  Object.entries(s).forEach(([k, v]) => sessions.set(k, v));
  console.log(`恢复 ${sessions.size} 个 session`);
} catch(e) {}

function createSession(wallet, data) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { wallet: wallet.toLowerCase(), ...data, createdAt: Date.now() });
  saveSessions();
  return token;
}
function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > 30*24*60*60*1000) { sessions.delete(token); return null; }
  return s;
}
function saveSessions() {
  const obj = {};
  for (const [k, v] of sessions) obj[k] = v;
  fs.writeFileSync(SESSION_FILE, JSON.stringify(obj, null, 2));
}

// ─── Rate limit ───
const _rl = new Map();
function rateLimit(key, max, window) {
  const now = Date.now();
  const e = _rl.get(key);
  if (!e || now > e.reset) { _rl.set(key, { count: 1, reset: now + window }); return true; }
  e.count++;
  return e.count <= max;
}

// ─── CORS ───
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-API-Key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Auth middleware ───
function authMiddleware(req, res, next) {
  const token = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  const session = getSession(token);
  if (!session) return res.status(401).json({ error: '未登录' });
  req.session = session;
  req.wallet = session.wallet;
  next();
}

// ─── 登录 ───
app.post('/api/auth/login', (req, res) => {
  try {
    const ip = req.ip || 'unknown';
    if (!rateLimit(`login:${ip}`, 5, 60000)) return res.status(429).json({ error: '操作频繁' });
    
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: '请输入地址和密码' });
    
    const user = findUser(username);
    if (!user || !user.salt || !user.passwordHash) return res.status(401).json({ error: '地址或密码错误' });
    
    const hash = crypto.scryptSync(password, user.salt, 64).toString('hex');
    if (hash !== user.passwordHash) return res.status(401).json({ error: '地址或密码错误' });
    
    const addr = (user.walletAddress || user.address || username).toLowerCase();
    const token = createSession(addr, {
      username, walletAddress: addr,
      usdtBalance: user.usdtBalance || 0,
      strategy: user.strategy || 'balanced',
    });
    
    console.log(`✅ 登录: ${addr}`);
    res.json({
      success: true, token,
      user: {
        username, address: addr,
        usdtBalance: user.usdtBalance || 0,
        bnbBalance: user.bnbBalance || 0,
        arkBalance: user.arkBalance || 0,
        strategy: user.strategy || 'balanced',
        tradingEnabled: user.tradingEnabled || false,
        cexMode: user.cexMode || false,
      }
    });
  } catch(e) {
    console.error('登录失败:', e.message);
    res.status(500).json({ error: '登录失败' });
  }
});

// ─── 注册 ───
app.post('/api/auth/register', (req, res) => {
  try {
    const ip = req.ip || 'unknown';
    if (!rateLimit(`reg:${ip}`, 3, 60000)) return res.status(429).json({ error: '操作频繁' });
    
    const { username, password, walletAddress } = req.body;
    if (!username || !password) return res.status(400).json({ error: '请输入地址和密码' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
    
    const addr = (walletAddress || username).toLowerCase();
    if (users[addr]) return res.status(409).json({ error: '账号已存在，请直接登录' });
    
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');
    
    users[addr] = {
      username: addr, address: addr, walletAddress: addr,
      salt, passwordHash, strategy: 'balanced',
      tradingEnabled: false, cexMode: false,
      usdtBalance: 0, bnbBalance: 0, arkBalance: 0,
      createdAt: Date.now(),
    };
    saveUsers();
    
    const token = createSession(addr, { username: addr, walletAddress: addr, usdtBalance: 0 });
    console.log(`✅ 注册: ${addr}`);
    res.json({
      success: true, token,
      user: { username: addr, address: addr, usdtBalance: 0, strategy: 'balanced', tradingEnabled: false }
    });
  } catch(e) {
    console.error('注册失败:', e.message);
    res.status(500).json({ error: '注册失败' });
  }
});

// ─── Dashboard ───
app.post('/api/dashboard', authMiddleware, (req, res) => {
  const user = findUser(req.wallet) || {};
  res.json({
    user: {
      address: req.wallet,
      usdtBalance: user.usdtBalance || 0,
      bnbBalance: user.bnbBalance || 0,
      arkBalance: user.arkBalance || 0,
      strategy: user.strategy || 'balanced',
      tradingEnabled: user.tradingEnabled || false,
      cexMode: user.cexMode || false,
    },
    engine: { positions: {}, recentTrades: [] },
    platform: { totalUsers: Object.keys(users).length },
  });
});

// ─── 其他兼容 API（返回空数据，不报错）───
app.post('/api/vault/status', authMiddleware, (req, res) => res.json({ deployed: false, totalPnl: 0, totalTrades: 0 }));
app.get('/api/server-ip', (req, res) => res.json({ ip: 'check dashboard' }));

// ─── CEX API Key 绑定 ───
app.post('/api/vault/cex-key', authMiddleware, (req, res) => {
  const { apiKey, secretKey } = req.body;
  console.log(`[CEX-Key] 收到绑定请求 wallet=${req.wallet?.slice(0,10)} apiKey=${apiKey?.slice(0,8)}... bodyKeys=${Object.keys(req.body||{})}`);
  if (!apiKey || !secretKey) { console.log('[CEX-Key] 缺少参数'); return res.status(400).json({ error: '需要 apiKey 和 secretKey' }); }
  const user = findUser(req.wallet);
  if (!user) return res.status(400).json({ error: '用户不存在' });
  user.binanceApiKey = apiKey;
  user.binanceSecret = secretKey;
  user.cexMode = true;
  user.tradingEnabled = true;
  saveUsers();
  console.log(`✅ ${req.wallet.slice(0,10)}... CEX API Key 已绑定`);
  res.json({ success: true, cexMode: true });
});

app.delete('/api/vault/cex-key', authMiddleware, (req, res) => {
  const user = findUser(req.wallet);
  if (!user) return res.status(400).json({ error: '用户不存在' });
  user.binanceApiKey = '';
  user.binanceSecret = '';
  user.cexMode = false;
  user.tradingEnabled = false;
  saveUsers();
  console.log(`🗑️ ${req.wallet.slice(0,10)}... CEX API Key 已解绑`);
  res.json({ success: true, cexMode: false });
});

// ─── 用户设置 API ───
app.get('/api/vault/user-settings', authMiddleware, (req, res) => {
  const user = findUser(req.wallet);
  res.json({
    success: true,
    strategy: user?.strategy || 'balanced',
    tradeAmount: user?.tradeAmount || 0,
    maxSingle: user?.maxSingle || 50000,
    dailyLimit: user?.dailyLimit || 200000,
  });
});

app.post('/api/vault/strategy', authMiddleware, (req, res) => {
  const { strategy } = req.body;
  if (!['conservative', 'balanced', 'aggressive'].includes(strategy)) {
    return res.status(400).json({ error: '策略必须是 conservative/balanced/aggressive' });
  }
  const user = findUser(req.wallet);
  if (user) { user.strategy = strategy; saveUsers(); }
  res.json({ success: true, strategy });
});

app.post('/api/vault/trade-amount', authMiddleware, (req, res) => {
  const { tradeAmount } = req.body;
  const amt = Number(tradeAmount);
  if (!amt || amt < 0) return res.status(400).json({ error: '金额无效' });
  const user = findUser(req.wallet);
  if (user) { user.tradeAmount = amt; saveUsers(); }
  res.json({ success: true, tradeAmount: amt });
});

app.post('/api/vault/trading', authMiddleware, (req, res) => {
  const { enabled } = req.body;
  const user = findUser(req.wallet);
  if (!user) return res.status(400).json({ error: '用户不存在' });
  if (enabled && !user.vaultAddress && !user.binanceApiKey) {
    return res.status(400).json({ error: '请先绑定 API Key 或部署 Vault' });
  }
  user.tradingEnabled = !!enabled;
  saveUsers();
  res.json({ success: true, tradingEnabled: !!enabled });
});

// ─── 全体用户持仓数据 API ───
app.get('/api/admin/all-users', authMiddleware, (req, res) => {
  try {
    const fs = require('fs');
    const pathMod = require('path');
    
    // 读取最新用户数据
    const usersFile = pathMod.join(__dirname, '..', 'data', 'saas-users.json');
    let freshUsers = {};
    if (fs.existsSync(usersFile)) {
      const raw = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
      freshUsers = raw.users || raw;
    }
    
    // 读取交易状态（链上同步）
    const stateFile = pathMod.join(__dirname, '..', 'data', 'user-trader-state.json');
    let traderState = {};
    if (fs.existsSync(stateFile)) {
      traderState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    }
    
    // 读取CEX交易状态（CEX用户持仓）
    const cexStateFile = pathMod.join(__dirname, '..', 'data', 'cex-user-trader-state.json');
    let cexState = {};
    if (fs.existsSync(cexStateFile)) {
      cexState = JSON.parse(fs.readFileSync(cexStateFile, 'utf8'));
    }
    
    // 读取CEX交易记录
    const tradesFile = pathMod.join(__dirname, '..', 'data', 'cex-user-trades.json');
    let allTrades = [];
    if (fs.existsSync(tradesFile)) {
      allTrades = JSON.parse(fs.readFileSync(tradesFile, 'utf8'));
    }
    
    // 组装用户列表
    const userList = [];
    for (const [wallet, u] of Object.entries(freshUsers)) {
      const stats = traderState.userStats?.[wallet] || cexState.stats?.[wallet] || {};
      const state = traderState.userStates?.[wallet] || {};
      // CEX持仓来自cex-user-trader-state.json
      const cexPositions = cexState.states?.[wallet]?.positions || {};
      const userTrades = allTrades.filter(t => t.wallet === wallet);
      
      // 计算真实持仓（合并链上+CEX）
      const statePositions = state.positions || {};
      const allPositions = { ...statePositions };
      for (const [sym, cp] of Object.entries(cexPositions)) {
        allPositions['CEX_' + sym] = cp;
      }
      const posCount = Object.keys(allPositions).length;
      const totalInvested = Object.values(allPositions).reduce((s, p) => s + (p.amount || 0), 0);
      
      userList.push({
        wallet: wallet,
        addrShort: wallet.slice(0, 6) + '...' + wallet.slice(-4),
        usdtBalance: u.usdtBalance || 0,
        tradeAmount: u.tradeAmount || 0,
        strategy: u.strategy || 'balanced',
        tradingEnabled: u.tradingEnabled || false,
        cexMode: u.cexMode || false,
        hasApiKey: !!(u.binanceApiKey),
        // 持仓
        positionCount: posCount,
        positions: Object.entries(allPositions).map(([key, p]) => ({
          symbol: p.symbol || key.replace('CEX_', ''),
          side: p.side,
          entryPrice: p.entryPrice,
          amount: p.amount,
          leverage: p.leverage,
          sl: p.sl,
          tp: p.tp,
          score: p.score,
          openTime: p.openTime,
          source: key.startsWith('CEX_') ? 'CEX' : 'DEX',
        })),
        // 统计
        wins: stats.wins || 0,
        losses: stats.losses || 0,
        winRate: stats.winRate || 0,
        totalPnl: stats.totalPnl || 0,
        totalTrades: (stats.wins || 0) + (stats.losses || 0),
        tradeCount: userTrades.length,
        recentTrades: userTrades.slice(-5).reverse(),
      });
    }
    
    // 汇总
    const summary = {
      totalUsers: userList.length,
      activeTraders: userList.filter(u => u.tradingEnabled && u.hasApiKey).length,
      totalBalance: userList.reduce((s, u) => s + u.usdtBalance, 0),
      totalInvested: userList.reduce((s, u) => s + u.tradeAmount, 0),
      totalPnl: userList.reduce((s, u) => s + u.totalPnl, 0),
      totalPositions: userList.reduce((s, u) => s + u.positionCount, 0),
      totalTrades: userList.reduce((s, u) => s + u.tradeCount, 0),
      engineCycles: traderState.cycleCount || 0,
    };
    
    res.json({ success: true, summary, users: userList });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ─── 静态文件 ───
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ─── SPA fallback ───
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🌐 独立登录服务: http://localhost:${PORT}`);
  console.log(`📊 用户数: ${Object.keys(users).length}`);
});
