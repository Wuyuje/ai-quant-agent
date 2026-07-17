/**
 * DexTrader — DEX (PancakeSwap BSC) 交易引擎
 *
 * 核心职责：
 *   1. 遍历 exchangeMode='dex' 的用户
 *   2. 查询用户 BSC 钱包 USDT 余额
 *   3. 用 Binance 公共 API 获取 K线数据做策略判断
 *   4. 通过 PancakeSwap V2 在 BSC 链上执行 swap（买入/卖出）
 *   5. 策略降级：做空→跳过、杠杆→1x、补仓→分批买入、资金费率→跳过
 *   6. 独立的持仓管理（止盈止损）
 *   7. DEX 服务费：平仓盈利时 20% 转入平台钱包
 *
 * 不影响现有 CEX 用户的任何功能和持仓
 * 不需要 Binance API Key，不需要盖茨费
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

// ═══════════════════════════════════
// BSC 链上配置
// ═══════════════════════════════════
const BSC_RPC_LIST = [
  'https://bsc-rpc.publicnode.com',
  'https://bsc.drpc.org',
  'https://1rpc.io/bnb',
];
let _rpcIndex = 0;
function BSC_RPC() { return BSC_RPC_LIST[_rpcIndex % BSC_RPC_LIST.length]; }
function rotateRpc() { _rpcIndex = (_rpcIndex + 1) % BSC_RPC_LIST.length; }

const PANCAKE_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955';
const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const PLATFORM_WALLET = '0xb6DEb31484353AdDaA5b6A105A2B758Df11bC28A';
const PLATFORM_FEE_BPS = 2000; // 20% 平台服务费
const ECO_FUND_WALLET = '0xeF87e7fD5f0ADC5de82e84Dc9300002D9aC8bD82'; // 生态费钱包
const ECO_FUND_BPS = 1000; // 10% 生态费
const GATES_FEE_THRESHOLD = 5; // 盖茨费累计 $5 才链上扣
const GATES_FEE_COOLDOWN_MS = 30 * 60 * 1000; // 30分钟冷却
const ADMIN_WALLETS = [
  '0xfa3b90c574469909d20848273c06752a22fde74a',
  '0xe6ddf0771c7610dba77eb5a07ba7771dd7f5e91e',
];
const GATES_FEE_MAX_FAIL = 3; // 最多失败3次

const TRADER_PRIVATE_KEY = process.env.TRADER_PRIVATE_KEY;

// PancakeSwap Router ABI
const ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)',
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)',
  'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

const VAULT_ABI = [
  'function executeSwap(address dex, address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut) external returns (uint256)',
  'function withdraw(address token, uint256 amount) external',
];

// BSC 代币地址映射
const BSC_TOKENS = {
  'BTC':  '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c',
  'ETH':  '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
  'BNB':  WBNB_ADDRESS,
  'CAKE': '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
  'SOL':  '0x570a5D26F7765eCB712C0924E4de545B89fd43df',
  'DOGE': '0xbA2aE424d960c24699abC0cDB92F7fA7AFC5d3A1',
  'XRP':  '0x1D2F0da169ceB9Fc7223F0C68519e81474Eb56Ac',
  'ADA':  '0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47',
  'DOT':  '0x7083609fCE4d1d8Dc0C979A8a645C8cD6095f0dD',
  'AVAX': '0x1CE0c2827e83eF82505Ccc8D1e3e8B7BB89f3708',
  'LINK': '0xF8A0BF9cF54Bb92F17374d9e9A3FEA6fCf7157d6',
  'LTC':  '0x4338669C7CE9E7DB0072AAD3b5EBAa0Cf6C6F228',
  'NEAR': '0x1Fa4c7C618Be4f58b2E6D218e4837eDeA0AB86f1',
  'ATOM': '0x0Eb3a7a5701997a04387D3E99cF1C8c2f208b6d7',
  'ARB':  '0x912CE59144191C1204E64559FE8253a0e49E6548',
  'OP':   '0xB45Ae46eFcF3fE9a4510a65F9bC15C9f667d0b5d',
  'SUI':  '0x11eBF116d2AA60e541BbB12e4b3Ed6e7f7D3E6C3',
  'PEPE': '0xbD97531F2f03E18B8A47B8325bE2Ae74d6Cb3A7C',
  'ARK':  '0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D',
  'TRUMP': '0x1B84d25E2877082462243B18130C4101aA21e0A5',
};

// DEX 交易成本常量
const DEX_FEE_BPS = 25;       // 0.25% PancakeSwap 手续费
const SLIPPAGE_BPS = 50;      // 0.5% 默认滑点
const GAS_COST_USD = 0.05;    // ~$0.05 BSC gas
const MAX_POSITIONS = 3;       // DEX 最多持仓3个
const MIN_TRADE_USDT = 10;    // 最小交易金额
const TP_PCT = 0.05;          // 5% 止盈（远超 DEX ~1% 成本）
const SL_PCT = 0.03;          // 3% 止损

// ═══════════════════════════════════
// BSC RPC 调用
// ═══════════════════════════════════
async function bscRpc(method, params = []) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  for (let i = 0; i < 3; i++) {
    try {
      const resp = await fetch(BSC_RPC(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(8000),
      });
      const json = await resp.json();
      if (json.error) throw new Error(json.error.message);
      return json.result;
    } catch (e) {
      rotateRpc();
      if (i === 2) throw e;
    }
  }
}

function getProvider() {
  return new ethers.JsonRpcProvider(BSC_RPC());
}

function getTraderWallet() {
  if (!TRADER_PRIVATE_KEY) throw new Error('TRADER_PRIVATE_KEY not set');
  return new ethers.Wallet(TRADER_PRIVATE_KEY, getProvider());
}

// 查 ERC20 余额
async function erc20Balance(token, walletAddr) {
  const data = '0x70a08231' + walletAddr.slice(2).padStart(64, '0');
  const result = await bscRpc('eth_call', [{ to: token, data }, 'latest']);
  return BigInt(result || '0');
}

// 发送链上交易
async function sendTx(to, data) {
  const wallet = getTraderWallet();
  let gasLimit;
  try {
    const estimated = await wallet.provider.estimateGas({ from: wallet.address, to, data });
    gasLimit = BigInt(Math.ceil(Number(estimated) * 1.3));
  } catch (e) {
    gasLimit = 350000n;
  }
  const nonce = await wallet.provider.getTransactionCount(wallet.address);
  const tx = await wallet.sendTransaction({
    to, data, gasLimit,
    gasPrice: ethers.parseUnits('3', 'gwei'),
    nonce,
    chainId: 56,
  });
  const receipt = await tx.wait(2); // 等2个确认
  return receipt;
}

// ═══════════════════════════════════
// Binance 公共 API — 获取 K线（用于策略判断）
// ═══════════════════════════════════
function binanceGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Parse error')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

async function getKlines(symbol, interval = '5m', limit = 100) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const data = await binanceGet(url);
  return data.map(k => ({
    time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

async function getTopSymbols(limit = 20) {
  const url = 'https://fapi.binance.com/fapi/v1/ticker/24hr';
  const tickers = await binanceGet(url);
  if (!Array.isArray(tickers)) return [];
  // 过滤有 BSC 代币映射的
  const tradeable = tickers
    .filter(t => {
      const base = t.symbol.replace('USDT', '');
      return BSC_TOKENS[base] && parseFloat(t.quoteVolume) > 10000000;
    })
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, limit);
  return tradeable.map(t => ({
    symbol: t.symbol,
    price: parseFloat(t.lastPrice),
    volume24h: parseFloat(t.quoteVolume),
    changePct: parseFloat(t.priceChangePercent),
  }));
}

// ═══════════════════════════════════
// 技术指标
// ═══════════════════════════════════
function sma(data, period) {
  if (data.length < period) return null;
  return data.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function ema(data, period) {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let result = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    result = data[i] * k + result * (1 - k);
  }
  return result;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  return 100 - (100 / (1 + gains / losses));
}

function atr(klines, period = 14) {
  if (klines.length < period + 1) return 0;
  const trs = [];
  for (let i = klines.length - period; i < klines.length; i++) {
    const h = klines[i].high, l = klines[i].low, prevC = klines[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC)));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

// 布林带
function bollinger(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return { upper: 0, mid: 0, lower: 0, pctB: 0.5 };
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = mid + sd * stdDev;
  const lower = mid - sd * stdDev;
  const last = closes[closes.length - 1];
  const pctB = upper === lower ? 0.5 : (last - lower) / (upper - lower);
  return { upper, mid, lower, pctB };
}

// ═══════════════════════════════════
// DEX 交易引擎
// ═══════════════════════════════════
class DexTrader {
  constructor(opts = {}) {
    this.userDB = opts.userDB;
    this.intervalMs = opts.intervalMs || 60000;
    this.running = false;
    this._cycleCount = 0;
    this._timer = null;

    // DEX 持仓状态文件
    this.STATE_FILE = path.join(__dirname, '..', 'data', 'dex-positions.json');
    this.TRADE_LOG = path.join(__dirname, '..', 'data', 'dex-trades.json');
    this._positions = {}; // wallet → { symbol → posData }
    // 盖茨费状态（与 CEX 一致）
    this._feeState = {}; // wallet → { pending: [{ platformFee, ecoFund, ... }], collected: 0 }
    this._transferFailCooldown = {}; // wallet → { failCount, lastFailAt }
    this._loadState();
  }

  _log(msg) {
    console.log(`[DEX-Trader] ${new Date().toISOString().slice(11, 19)} ${msg}`);
  }

  _loadState() {
    try {
      const data = JSON.parse(fs.readFileSync(this.STATE_FILE, 'utf8'));
      this._positions = data.positions || {};
      this._log(`📂 加载DEX持仓状态: ${Object.values(this._positions).reduce((a, p) => a + Object.keys(p).length, 0)}个持仓`);
    } catch (e) {
      this._positions = {};
    }
  }

  _saveState() {
    try {
      fs.writeFileSync(this.STATE_FILE, JSON.stringify({ positions: this._positions }, null, 2));
    } catch (e) {
      this._log(`⚠️ 保存状态失败: ${e.message}`);
    }
  }

  _logTrade(wallet, trade) {
    try {
      const trades = fs.existsSync(this.TRADE_LOG)
        ? JSON.parse(fs.readFileSync(this.TRADE_LOG, 'utf8'))
        : [];
      trades.push({ wallet, ...trade, timestamp: Date.now() });
      // 保留最近1000条
      if (trades.length > 1000) trades.shift();
      fs.writeFileSync(this.TRADE_LOG, JSON.stringify(trades, null, 2));
    } catch (e) {}
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._log('🚀 DEX Trader 启动');
    this._timer = setInterval(() => this._cycle().catch(e => this._log(`❌ 循环错误: ${e.message}`)), this.intervalMs);
    // 启动后立即跑一轮
    this._cycle().catch(e => this._log(`❌ 首轮错误: ${e.message}`));
  }

  stop() {
    this.running = false;
    if (this._timer) clearInterval(this._timer);
    this._saveState();
    this._log('🛑 DEX Trader 停止');
  }

  async _cycle() {
    this._cycleCount++;

    // 收集 DEX 用户
    const users = this.userDB?.users || {};
    const dexUsers = Object.entries(users).filter(([_, u]) =>
      u.exchangeMode === 'dex' && u.tradingEnabled
    );

    // 管理员如果切换到 DEX 模式也加入（即使 tradingEnabled=false）
    for (const adminW of ADMIN_WALLETS) {
      const adminUser = users[adminW] || users[adminW.toLowerCase()];
      if (adminUser?.exchangeMode === 'dex' && !dexUsers.find(([w]) => w.toLowerCase() === adminW.toLowerCase())) {
        dexUsers.push([adminW, { ...adminUser, tradingEnabled: true, isAdmin: true }]);
      }
    }

    if (dexUsers.length === 0) {
      if (this._cycleCount % 20 === 0) {
        this._log(`第${this._cycleCount}轮: 无DEX用户`);
      }
      return;
    }

    this._log(`第${this._cycleCount}轮: ${dexUsers.length}个DEX用户`);

    // 选币
    let topSymbols = [];
    try {
      topSymbols = await getTopSymbols(20);
    } catch (e) {
      this._log(`⚠️ 选币失败: ${e.message}`);
      return;
    }

    // 为每个 DEX 用户执行交易
    for (const [wallet, userData] of dexUsers) {
      try {
        await this._tradeForUser(wallet, userData, topSymbols);
      } catch (e) {
        this._log(`❌ ${wallet.slice(0, 10)}... 交易错误: ${e.message}`);
      }
    }
  }

  async _tradeForUser(wallet, userData, topSymbols) {
    const bscWallet = userData.bscWalletAddr || wallet;

    // 1. 查 BSC 钱包 USDT 余额
    let usdtBalance = 0n;
    try {
      usdtBalance = await erc20Balance(USDT_ADDRESS, bscWallet);
    } catch (e) {
      this._log(`⚠️ ${wallet.slice(0, 10)}... 查询余额失败: ${e.message}`);
      return;
    }
    const usdtBalanceNum = Number(usdtBalance) / 1e18;

    // 2. 管理现有持仓
    const userPositions = this._positions[wallet] || {};
    for (const symbol of Object.keys(userPositions)) {
      const pos = userPositions[symbol];
      try {
        await this._managePosition(wallet, bscWallet, symbol, pos, topSymbols);
      } catch (e) {
        this._log(`⚠️ ${wallet.slice(0, 10)}... 管理 ${symbol} 失败: ${e.message}`);
      }
    }

    // 3. 检查是否可以开新仓
    const positionCount = Object.keys(userPositions).length;
    if (positionCount >= MAX_POSITIONS) return;

    // 3.5 检查盖茨费授权 — 未授权不开新仓，但保留持仓监控
    const isAdmin = ADMIN_WALLETS.some(a => a.toLowerCase() === wallet.toLowerCase());
    if (!isAdmin && !userData.gatesFeeApproved) {
      if (this._cycleCount % 10 === 0) {
        this._log(`⏸️ ${wallet.slice(0, 10)}... 盖茨费未授权，暂停开新仓，继续监控持仓`);
      }
      return;
    }

    // 4. 策略选币 + 开仓
    const tradeAmount = Math.min(
      userData.tradeAmount || usdtBalanceNum * 0.3,
      usdtBalanceNum * 0.5, // 单仓不超过余额50%
      Number(usdtBalance) / 1e18
    );

    if (tradeAmount < MIN_TRADE_USDT) {
      if (this._cycleCount % 10 === 0) {
        this._log(`⏭️ ${wallet.slice(0, 10)}... 余额不足 $${usdtBalanceNum.toFixed(2)} (最低$${MIN_TRADE_USDT})`);
      }
      return;
    }

    // 5. 扫描候选币种
    for (const sym of topSymbols) {
      if (userPositions[sym.symbol]) continue; // 已持仓跳过

      try {
        const klines = await getKlines(sym.symbol, '5m', 100);
        if (klines.length < 50) continue;

        const signal = this._getSignal(klines);
        if (!signal || signal.action !== 'BUY') continue;

        // DEX 策略降级：做空→跳过
        if (signal.side === 'SHORT') continue; // DEX 只做多

        // 执行买入
        const success = await this._buy(wallet, bscWallet, sym.symbol, tradeAmount, signal.price);
        if (success) {
          this._log(`📈 ${wallet.slice(0, 10)}... DEX买入 ${sym.symbol} $${tradeAmount.toFixed(2)}`);
          break; // 每轮只开一个新仓
        }
      } catch (e) {
        // 静默跳过
      }
    }
  }

  // ═══ 策略信号生成 ═══
  _getSignal(klines) {
    const closes = klines.map(k => k.close);
    const lastClose = closes[closes.length - 1];
    const ma7 = ema(closes, 7);
    const ma21 = ema(closes, 21);
    const rsiVal = rsi(closes, 14);
    const bb = bollinger(closes, 20, 2);
    const atrVal = atr(klines, 14);
    const atrPct = atrVal / lastClose;

    // 盈亏比检查 — DEX 成本 ~1%
    const totalCostPct = (DEX_FEE_BPS + SLIPPAGE_BPS) / 10000 * 2;
    const minExpectedMove = totalCostPct + 0.02; // 2% 最低预期收益
    const expectedMove = atrPct * 5;
    if (expectedMove < minExpectedMove) return null;

    // 买入条件：MA7 > MA21 + RSI < 70 + 布林带下轨附近
    if (ma7 > ma21 && rsiVal < 70 && bb.pctB < 0.8) {
      return {
        action: 'BUY',
        side: 'LONG',
        price: lastClose,
        atr: atrVal,
        atrPct,
        tp: lastClose * (1 + TP_PCT),
        sl: lastClose * (1 - SL_PCT),
        score: (ma7 > ma21 ? 2 : 0) + (rsiVal < 50 ? 2 : 0) + (bb.pctB < 0.3 ? 2 : 0),
      };
    }

    return null;
  }

  // ═══ 链上买入 (PancakeSwap swap USDT → Token) ═══
  async _buy(wallet, bscWallet, symbol, amountUsdt, entryPrice) {
    const base = symbol.replace('USDT', '');
    const tokenOut = BSC_TOKENS[base];
    if (!tokenOut) {
      this._log(`⚠️ ${symbol} 无BSC代币映射`);
      return false;
    }

    const amountIn = BigInt(Math.round(amountUsdt * 1e18));

    // 1. 查报价
    const routerIface = new ethers.Interface(ROUTER_ABI);
    const quoteData = routerIface.encodeFunctionData('getAmountsOut', [
      amountIn,
      [USDT_ADDRESS, tokenOut],
    ]);
    let quoteRaw;
    try {
      quoteRaw = await bscRpc('eth_call', [{ to: PANCAKE_ROUTER, data: quoteData }, 'latest']);
    } catch (e) {
      this._log(`⚠️ ${symbol} 报价失败: ${e.message?.slice(0, 80)}`);
      return false;
    }
    if (!quoteRaw || quoteRaw === '0x') return false;

    let quoteResult;
    try {
      quoteResult = routerIface.decodeFunctionResult('getAmountsOut', quoteRaw);
    } catch (e) {
      return false;
    }
    const expectedOut = quoteResult[0][1];
    const minOut = expectedOut * BigInt(10000 - SLIPPAGE_BPS) / 10000n;

    // 2. 检查用户是否通过 Vault 合约交易
    const user = this.userDB?.get?.(wallet) || this.userDB?.users?.[wallet];
    const vaultAddress = user?.vaultAddress;

    if (vaultAddress) {
      // 通过 Vault 合约执行 swap
      return await this._swapViaVault(vaultAddress, USDT_ADDRESS, tokenOut, amountIn, minOut, wallet, symbol, 'BUY', entryPrice);
    } else {
      // 直接 swap — 需要 approve 先
      return await this._swapDirect(bscWallet, USDT_ADDRESS, tokenOut, amountIn, minOut, wallet, symbol, 'BUY', entryPrice);
    }
  }

  // 通过 Vault 合约 swap
  async _swapViaVault(vaultAddress, tokenIn, tokenOut, amountIn, minOut, wallet, symbol, action, entryPrice) {
    const vaultIface = new ethers.Interface(VAULT_ABI);
    const data = vaultIface.encodeFunctionData('executeSwap', [
      PANCAKE_ROUTER, tokenIn, tokenOut, amountIn, minOut,
    ]);
    try {
      const receipt = await sendTx(vaultAddress, data);
      if (receipt.status === 1) {
        // 记录持仓
        if (!this._positions[wallet]) this._positions[wallet] = {};
        this._positions[wallet][symbol] = {
          side: 'LONG',
          entryPrice,
          amountUsdt: Number(amountIn) / 1e18,
          tokenOut,
          openTime: Date.now(),
          tp: entryPrice * (1 + TP_PCT),
          sl: entryPrice * (1 - SL_PCT),
          _source: 'dex-vault',
        };
        this._saveState();
        this._logTrade(wallet, { action: 'BUY', symbol, amount: Number(amountIn) / 1e18, price: entryPrice });
        return true;
      }
    } catch (e) {
      this._log(`⚠️ ${symbol} Vault swap失败: ${e.message?.slice(0, 100)}`);
    }
    return false;
  }

  // 直接 swap（无 Vault）
  async _swapDirect(bscWallet, tokenIn, tokenOut, amountIn, minOut, wallet, symbol, action, entryPrice) {
    // 检查 allowance — 管理员私钥需要先 approve
    const erc20 = new ethers.Interface(ERC20_ABI);
    
    // 检查当前 allowance
    const allowanceData = erc20.encodeFunctionData('allowance', [bscWallet, PANCAKE_ROUTER]);
    let allowanceRaw;
    try {
      allowanceRaw = await bscRpc('eth_call', [{ to: tokenIn, data: allowanceData }, 'latest']);
    } catch (e) { return false; }
    const currentAllowance = BigInt(allowanceRaw || '0');

    // 如果 allowance 不足，先 approve
    if (currentAllowance < amountIn) {
      const approveData = erc20.encodeFunctionData('approve', [PANCAKE_ROUTER, ethers.MaxUint256]);
      try {
        await sendTx(tokenIn, approveData);
        this._log(`✅ ${symbol} approve 成功`);
      } catch (e) {
        this._log(`⚠️ ${symbol} approve失败: ${e.message?.slice(0, 80)}`);
        return false;
      }
    }

    // 执行 swap
    const routerIface = new ethers.Interface(ROUTER_ABI);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600); // 10分钟
    const swapData = routerIface.encodeFunctionData('swapExactTokensForTokens', [
      amountIn, minOut, [tokenIn, tokenOut], bscWallet, deadline,
    ]);
    try {
      const receipt = await sendTx(PANCAKE_ROUTER, swapData);
      if (receipt.status === 1) {
        if (!this._positions[wallet]) this._positions[wallet] = {};
        this._positions[wallet][symbol] = {
          side: 'LONG',
          entryPrice,
          amountUsdt: Number(amountIn) / 1e18,
          tokenOut,
          openTime: Date.now(),
          tp: entryPrice * (1 + TP_PCT),
          sl: entryPrice * (1 - SL_PCT),
          _source: 'dex-direct',
        };
        this._saveState();
        this._logTrade(wallet, { action: 'BUY', symbol, amount: Number(amountIn) / 1e18, price: entryPrice });
        return true;
      }
    } catch (e) {
      this._log(`⚠️ ${symbol} swap失败: ${e.message?.slice(0, 100)}`);
    }
    return false;
  }

  // ═══ 管理持仓（止盈止损）═══
  async _managePosition(wallet, bscWallet, symbol, pos, topSymbols) {
    // 获取当前价格
    let currentPrice = 0;
    try {
      const klines = await getKlines(symbol, '5m', 5);
      if (klines.length > 0) currentPrice = klines[klines.length - 1].close;
    } catch (e) { return; }
    if (currentPrice === 0) return;

    const pnlPct = (currentPrice - pos.entryPrice) / pos.entryPrice;
    const holdHours = (Date.now() - pos.openTime) / 3600000;

    // 止盈
    if (currentPrice >= pos.tp) {
      this._log(`🎯 ${wallet.slice(0, 10)}... ${symbol} 止盈 ${(pnlPct * 100).toFixed(2)}% (${holdHours.toFixed(1)}h)`);
      await this._sell(wallet, bscWallet, symbol, pos);
      return;
    }

    // 止损
    if (currentPrice <= pos.sl) {
      this._log(`🔴 ${wallet.slice(0, 10)}... ${symbol} 止损 ${(pnlPct * 100).toFixed(2)}% (${holdHours.toFixed(1)}h)`);
      await this._sell(wallet, bscWallet, symbol, pos);
      return;
    }

    // 最长持仓72小时
    if (holdHours > 72) {
      this._log(`⏰ ${wallet.slice(0, 10)}... ${symbol} 超时平仓 ${(pnlPct * 100).toFixed(2)}% (${holdHours.toFixed(1)}h)`);
      await this._sell(wallet, bscWallet, symbol, pos);
      return;
    }
  }

  // ═══ 链上卖出 (PancakeSwap swap Token → USDT) ═══
  async _sell(wallet, bscWallet, symbol, pos) {
    const tokenIn = pos.tokenOut;
    if (!tokenIn) {
      delete this._positions[wallet]?.[symbol];
      this._saveState();
      return;
    }

    // 查代币余额
    let tokenBalance;
    try {
      tokenBalance = await erc20Balance(tokenIn, bscWallet);
    } catch (e) {
      this._log(`⚠️ ${symbol} 查余额失败: ${e.message}`);
      return;
    }
    if (tokenBalance === 0n) {
      // 无余额，直接清除持仓
      delete this._positions[wallet]?.[symbol];
      this._saveState();
      return;
    }

    // 查报价
    const routerIface = new ethers.Interface(ROUTER_ABI);
    const quoteData = routerIface.encodeFunctionData('getAmountsOut', [
      tokenBalance, [tokenIn, USDT_ADDRESS],
    ]);
    let quoteRaw;
    try {
      quoteRaw = await bscRpc('eth_call', [{ to: PANCAKE_ROUTER, data: quoteData }, 'latest']);
    } catch (e) {
      this._log(`⚠️ ${symbol} 卖出报价失败: ${e.message?.slice(0, 80)}`);
      return;
    }
    if (!quoteRaw || quoteRaw === '0x') return;

    let quoteResult;
    try {
      quoteResult = routerIface.decodeFunctionResult('getAmountsOut', quoteRaw);
    } catch (e) { return; }
    const expectedOut = quoteResult[0][1];
    const minOut = expectedOut * BigInt(10000 - SLIPPAGE_BPS) / 10000n;

    const user = this.userDB?.get?.(wallet) || this.userDB?.users?.[wallet];
    const vaultAddress = user?.vaultAddress;

    let success = false;
    if (vaultAddress) {
      success = await this._swapViaVault(vaultAddress, tokenIn, USDT_ADDRESS, tokenBalance, minOut, wallet, symbol, 'SELL', 0);
    } else {
      success = await this._swapDirect(bscWallet, tokenIn, USDT_ADDRESS, tokenBalance, minOut, wallet, symbol, 'SELL', 0);
    }

    if (success) {
      // 计算盈亏 + 记录盖茨费
      const sellUsdt = Number(expectedOut) / 1e18;
      const pnlUsdt = sellUsdt - pos.amountUsdt;
      this._logTrade(wallet, {
        action: 'SELL', symbol,
        amount: sellUsdt,
        price: 0,
        pnl: pnlUsdt,
        pnlPct: (pnlUsdt / pos.amountUsdt) * 100,
        holdHours: (Date.now() - pos.openTime) / 3600000,
      });

      // ═══ DEX 盖茨费：盈利时收取服务费20% + 生态费10% ═══
      // 管理员豁免：所有费用全免
      const isDexAdmin = ADMIN_WALLETS.some(a => a.toLowerCase() === wallet.toLowerCase());
      if (pnlUsdt > 0 && isDexAdmin) {
        this._log(`👑 DEX Admin ${wallet.slice(0, 10)}... ${symbol} +$${pnlUsdt.toFixed(2)} — 全额到帐，费用全免`);
      } else if (pnlUsdt > 0) {
        const platformFee = pnlUsdt * PLATFORM_FEE_BPS / 10000; // 20% 服务费
        const ecoFund = pnlUsdt * ECO_FUND_BPS / 10000;          // 10% 生态费
        const totalFee = platformFee + ecoFund;

        // 记录到 pending 列表
        if (!this._feeState[wallet]) this._feeState[wallet] = { pending: [], collected: 0 };
        this._feeState[wallet].pending.push({
          platformFee: platformFee.toFixed(6),
          ecoFund: ecoFund.toFixed(6),
          symbol,
          time: Date.now(),
          platformCollected: false,
        });
        this._log(`💰 ${wallet.slice(0, 10)}... ${symbol} 盈利$${pnlUsdt.toFixed(2)} → 服务费$${platformFee.toFixed(2)} + 生态费$${ecoFund.toFixed(2)} (累计待扣$${totalFee.toFixed(2)})`);

        // ═══ 记账模式：盖茨费从数据库直接扣除，不调链上 transferFrom ═══
        this._collectGatesFeeBookkeeping(wallet, bscWallet).catch(e => {
          this._log(`⚠️ ${wallet.slice(0, 10)}... 盖茨费记账扣取失败: ${e.message?.slice(0, 80)}`);
        });
      }

      delete this._positions[wallet]?.[symbol];
      this._saveState();
    }
  }

  // ═══ DEX 盖茨费记账模式：从数据库直接扣除，不调链上 transferFrom ═══
  async _collectGatesFeeBookkeeping(wallet, bscWallet) {
    // 管理员豁免
    if (ADMIN_WALLETS.some(a => a.toLowerCase() === wallet.toLowerCase())) return;

    const feeState = this._feeState[wallet];
    if (!feeState || !feeState.pending || feeState.pending.length === 0) return;

    // 计算待扣总额
    const pending = feeState.pending;
    const totalPlatform = pending.reduce((s, r) => r.platformCollected ? s : s + parseFloat(r.platformFee), 0);
    const totalEco = pending.reduce((s, r) => s + parseFloat(r.ecoFund), 0);
    const totalFee = totalPlatform + totalEco;

    if (totalFee < GATES_FEE_THRESHOLD) {
      this._log(`📊 ${wallet.slice(0, 10)}... 盖茨费累计$${totalFee.toFixed(2)} < $${GATES_FEE_THRESHOLD}阈值，继续积累`);
      return;
    }

    this._log(`💸 ${wallet.slice(0, 10)}... DEX盖茨费 $${totalFee.toFixed(2)} (服务费$${totalPlatform.toFixed(2)}+生态费$${totalEco.toFixed(2)}) 达到阈值，记账扣除`);

    // 记账模式：直接从用户数据库余额扣除
    try {
      if (this.userDB) {
        const user = this.userDB.get(wallet) || {};
        const oldBalance = user.gatesFeeBalance || 0;
        const newBalance = Math.max(0, oldBalance - totalFee);
        const collected = (user.gatesFeeCollected || 0) + totalFee;
        this.userDB.set(wallet, {
          ...user,
          gatesFeeBalance: newBalance,
          gatesFeeLow: newBalance < 5,
          gatesFeeCollected: collected,
          gatesFeeApproved: true,
        });
        this._log(`✅ ${wallet.slice(0, 10)}... DEX盖茨费记账成功: $${totalFee.toFixed(2)} | 余额 $${oldBalance.toFixed(2)} → $${newBalance.toFixed(2)} | 累计收取 $${collected.toFixed(2)}`);
      }

      // 清空 pending
      feeState.pending = [];
      feeState.collected = (feeState.collected || 0) + totalFee;
    } catch (e) {
      this._log(`❌ ${wallet.slice(0, 10)}... DEX盖茨费记账异常: ${e.message?.slice(0, 100)}`);
    }
  }

  // ═══ DEX 盖茨费链上扣取（与 CEX 一致：transferFrom 从用户 BSC 钱包扣）═══
  async _collectGatesFee(wallet, bscWallet) {
    // 管理员豁免
    if (ADMIN_WALLETS.some(a => a.toLowerCase() === wallet.toLowerCase())) return;

    const feeState = this._feeState[wallet];
    if (!feeState || !feeState.pending || feeState.pending.length === 0) return;

    // 检查失败冷却
    const cooldown = this._transferFailCooldown[wallet];
    if (cooldown) {
      const elapsed = Date.now() - cooldown.lastFailAt;
      if (elapsed < GATES_FEE_COOLDOWN_MS) {
        const remainMin = Math.ceil((GATES_FEE_COOLDOWN_MS - elapsed) / 60000);
        this._log(`⏳ ${wallet.slice(0, 10)}... 盖茨费冷却中，${remainMin}分钟后重试`);
        return;
      }
      if (cooldown.failCount >= GATES_FEE_MAX_FAIL) {
        this._log(`⛔ ${wallet.slice(0, 10)}... 盖茨费连续失败${cooldown.failCount}次，已停止`);
        return;
      }
    }

    // 计算待扣总额（跳过已收服务费）
    const pending = feeState.pending;
    const totalPlatform = pending.reduce((s, r) => r.platformCollected ? s : s + parseFloat(r.platformFee), 0);
    const totalEco = pending.reduce((s, r) => s + parseFloat(r.ecoFund), 0);
    const totalFee = totalPlatform + totalEco;

    if (totalFee < GATES_FEE_THRESHOLD) {
      this._log(`📊 ${wallet.slice(0, 10)}... 盖茨费累计$${totalFee.toFixed(2)} < $${GATES_FEE_THRESHOLD}阈值，继续积累`);
      return;
    }

    if (!bscWallet) {
      this._log(`⏸️ ${wallet.slice(0, 10)}... 无 BSC 钱包地址，盖茨费继续记账`);
      return;
    }

    this._log(`💸 ${wallet.slice(0, 10)}... DEX盖茨费 $${totalFee.toFixed(2)} (服务费$${totalPlatform.toFixed(2)}+生态费$${totalEco.toFixed(2)}) 达到阈值，开始链上扣费`);

    let platformOk = false, ecoOk = false;
    try {
      const traderWallet = getTraderWallet();
      const usdtContract = new ethers.Contract(USDT_ADDRESS, [
        'function transferFrom(address from, address to, uint256 amount) returns (bool)',
        'function balanceOf(address) view returns (uint256)',
        'function allowance(address,address) view returns (uint256)',
      ], traderWallet);

      // 检查授权额度和余额
      const allowance = await usdtContract.allowance(bscWallet, traderWallet.address);
      const balance = await usdtContract.balanceOf(bscWallet);
      const totalFeeWei = ethers.parseUnits(totalFee.toFixed(6), 18);

      if (BigInt(allowance) < totalFeeWei) {
        this._log(`❌ ${wallet.slice(0, 10)}... 链上授权不足，请重新授权 USDT`);
        if (this.userDB) { const e = this.userDB.get(wallet) || {}; this.userDB.set(wallet, { ...e, gatesFeeApproved: false }); }
        return;
      }
      if (BigInt(balance) < totalFeeWei) {
        this._log(`❌ ${wallet.slice(0, 10)}... BSC钱包USDT不足 ($${Number(balance) / 1e18})，请充值`);
        if (this.userDB) { const e = this.userDB.get(wallet) || {}; this.userDB.set(wallet, { ...e, gatesFeeLow: true, gatesFeeBalance: Number(balance) / 1e18 }); }
        return;
      }

      // Step 1: 转服务费到平台钱包
      if (totalPlatform > 0) {
        try {
          const platformWei = ethers.parseUnits(totalPlatform.toFixed(6), 18);
          this._log(`💸 ${wallet.slice(0, 10)}... DEX服务费 $${totalPlatform.toFixed(2)} → ${PLATFORM_WALLET.slice(0, 10)}...`);
          const tx1 = await usdtContract.transferFrom(bscWallet, PLATFORM_WALLET, platformWei);
          await tx1.wait();
          this._log(`✅ DEX服务费链上转账成功 $${totalPlatform.toFixed(2)} tx=${tx1.hash.slice(0, 16)}...`);
          platformOk = true;
          // 标记已收
          pending.forEach(r => r.platformCollected = true);
        } catch (e) {
          this._log(`❌ DEX服务费链上转账失败: ${e.message?.slice(0, 80)}`);
        }
      } else {
        platformOk = true; // 服务费已收过
      }

      // Step 2: 转生态费到生态费钱包
      if (platformOk) {
        try {
          const ecoWei = ethers.parseUnits(totalEco.toFixed(6), 18);
          this._log(`💸 ${wallet.slice(0, 10)}... DEX生态费 $${totalEco.toFixed(2)} → ${ECO_FUND_WALLET.slice(0, 10)}...`);
          const tx2 = await usdtContract.transferFrom(bscWallet, ECO_FUND_WALLET, ecoWei);
          await tx2.wait();
          this._log(`✅ DEX生态费链上转账成功 $${totalEco.toFixed(2)} tx=${tx2.hash.slice(0, 16)}...`);
          ecoOk = true;
        } catch (e) {
          this._log(`❌ DEX生态费链上转账失败: ${e.message?.slice(0, 80)}`);
        }
      }

      if (platformOk && ecoOk) {
        // 清空 pending
        feeState.pending = [];
        feeState.collected = (feeState.collected || 0) + totalFee;
        this._log(`🎉 ${wallet.slice(0, 10)}... DEX盖茨费全部收取完成 $${totalFee.toFixed(2)}`);
        // 更新 BSC 钱包余额
        try {
          const newBal = await usdtContract.balanceOf(bscWallet);
          if (this.userDB) { const e = this.userDB.get(wallet) || {}; this.userDB.set(wallet, { ...e, gatesFeeBalance: Number(newBal) / 1e18, gatesFeeLow: false }); }
        } catch (e) {}
      }
    } catch (e) {
      this._log(`❌ ${wallet.slice(0, 10)}... DEX盖茨费扣取异常: ${e.message?.slice(0, 100)}`);
    }

    // 记录失败
    if (!platformOk || !ecoOk) {
      const cd = this._transferFailCooldown[wallet] || { failCount: 0, lastFailAt: 0 };
      cd.failCount++;
      cd.lastFailAt = Date.now();
      this._transferFailCooldown[wallet] = cd;
    } else {
      this._transferFailCooldown[wallet] = { failCount: 0, lastFailAt: 0 };
    }
  }

  // ═══ 获取用户 DEX 持仓（供仪表盘调用）═══
  getUserPositions(wallet) {
    return this._positions[wallet] || {};
  }

  getAllUsersStatus() {
    const result = [];
    for (const [wallet, positions] of Object.entries(this._positions)) {
      const posList = Object.entries(positions).map(([symbol, pos]) => ({
        symbol,
        side: pos.side,
        entryPrice: pos.entryPrice,
        amount: pos.amountUsdt,
        qty: pos.amountUsdt / pos.entryPrice,
        leverage: 1, // DEX 无杠杆
        pnl: 0, // 需要实时价格计算
        openTime: pos.openTime,
        _source: pos._source,
      }));
      result.push({
        wallet,
        positions: posList,
        positionCount: posList.length,
        totalUsdt: posList.reduce((a, p) => a + p.amount, 0),
      });
    }
    return result;
  }
}

module.exports = { DexTrader };
