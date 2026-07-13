/**
 * v63: DEX 聚合器 — 多路由最优价格搜索
 * 
 * 功能：
 *   1. 同时查询 PancakeSwap V2/V3、BiSwap、ApeSwap 等多DEX报价
 *   2. 自动选择最优路由（直接路径 vs 中转路径）
 *   3. 比较各DEX输出金额，选择最优交易路径
 *   4. 支持多跳路由 (USDT → WBNB → TOKEN)
 * 
 * 集成方式：
 *   const agg = new DexAggregator();
 *   const best = await agg.findBestRoute('USDT', 'ETH', amountIn);
 *   // best = { dex, path, expectedOut, price, gasCost }
 */

// ═══════════════════════════════════
// BSC DEX 路由配置
// ═══════════════════════════════════
const DEX_ROUTERS = {
  pancakeV2: {
    name: 'PancakeSwap V2',
    router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
    feeBps: 25,        // 0.25%
    version: 2,
    getAmountsOutSelector: '0xd06ca61f', // getAmountsOut(uint256,address[])
  },
  biswap: {
    name: 'BiSwap',
    router: '0x3a6d8cA21D1CF76F653A67577FA0D2745334dDf1',
    feeBps: 25,
    version: 2,
  },
  apeswap: {
    name: 'ApeSwap',
    router: '0xcF0feBd3f17CEf89b6A711F2b56A4b65B6eC5f14',
    feeBps: 30,        // 0.30%
    version: 2,
  },
  /*mev: {
    name: 'MEV Protocol',
    router: '0x2D99AB3E96079E3f287c7cDD3a9D0393e1f0E340',
    feeBps: 20,
    version: 2,
  },*/
};

// 常用代币地址
const TOKENS = {
  WBNB:  '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  USDT:  '0x55d398326f99059fF775485246999027B3197955',
  USDC:  '0x8AC76A51cc950d9822D68b83fE1D97B92d571530',
  BTCB:  '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c',
  ETH:   '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
  CAKE:  '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
  SOL:   '0x570a5D26F7765eCB712C0924E4de545B89fd43df',
  ADA:   '0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47',
  DOT:   '0x7083609fCE4d1d8Dc0C979A8a645C8cD6095f0dD',
  LINK:  '0xF8A0BF9cF54Bb92F17374d9e9A3FEA6fCf7157d6',
  AVAX:  '0x1CE0c2827e83eF82505Ccc8D1e3e8B7BB89f3708',
  XRP:   '0x1D2F0da169ceB9Fc7223F0C68519e81474Eb56Ac',
  DOGE:  '0xbA2aE424d960c26247Dd6c32eC5PBs9da39B4fCA', // 注意需验证
  NEAR:  '0x1Fa02aA53Be9FbD8608312F4d50984f9EC28c9fE',
  ARB:   '0x81962aD8B6e6967f97aB581f4FfAaAC31e9D07b7',
  SUI:   '0x42C778D88393f8ab623a57a960120a8B9f7E9521',
};

// 中转代币（用于多跳路由）
const HOP_TOKENS = ['WBNB', 'USDT', 'USDC'];

// BSC RPC 列表
const BSC_RPC_LIST = [
  'https://bsc-dataseed1.binance.org/',
  'https://bsc-dataseed2.binance.org/',
  'https://bsc-dataseed3.binance.org/',
  'https://bsc.publicnode.com',
];

class DexAggregator {
  constructor(rpcUrl = null) {
    this.rpcIndex = 0;
    this.cache = new Map(); // quote缓存
    this.cacheTTL = 10000;  // 10秒缓存
  }

  get rpc() {
    return BSC_RPC_LIST[this.rpcIndex % BSC_RPC_LIST.length];
  }

  rotateRpc() {
    this.rpcIndex = (this.rpcIndex + 1) % BSC_RPC_LIST.length;
  }

  // ═══════════════════════════════════
  // BSC RPC 调用
  // ═══════════════════════════════════
  async bscRpc(method, params = []) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const resp = await fetch(this.rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const data = await resp.json();
      if (data.error) throw new Error(data.error.message?.slice(0, 100));
      return data.result;
    } catch (e) {
      clearTimeout(timeout);
      this.rotateRpc();
      throw e;
    }
  }

  // ═══════════════════════════════════
  // 获取代币地址
  // ═══════════════════════════════════
  getTokenAddress(symbol) {
    const s = symbol.replace('USDT', '').replace('USDC', '');
    if (s === 'USDT' || symbol === 'USDT') return TOKENS.USDT;
    if (s === 'USDC' || symbol === 'USDC') return TOKENS.USDC;
    if (s === 'BNB') return TOKENS.WBNB;
    return TOKENS[s] || null;
  }

  // ═══════════════════════════════════
  // 查询单DEX报价
  // ═══════════════════════════════════
  async getQuote(dexName, tokenInAddr, tokenOutAddr, amountIn) {
    const dex = DEX_ROUTERS[dexName];
    if (!dex) return null;

    // 编码 getAmountsOut(uint256, address[])
    const path = [tokenInAddr, tokenOutAddr];
    
    // 使用 ethers 编码（避免依赖，手工编码）
    const selector = dex.getAmountsOutSelector || '0xd06ca61f';
    const amountInHex = BigInt(amountIn).toString(16).padStart(64, '0');
    const pathOffset = '0000000000000000000000000000000000000000000000000000000000000040'; // offset to array
    const pathLen = '0000000000000000000000000000000000000000000000000000000000000002'; // 2 elements
    const addr1 = tokenInAddr.toLowerCase().replace('0x', '').padStart(64, '0');
    const addr2 = tokenOutAddr.toLowerCase().replace('0x', '').padStart(64, '0');
    
    const data = selector + amountInHex + pathOffset + pathLen + addr1 + addr2;

    try {
      const result = await this.bscRpc('eth_call', [
        { to: dex.router, data },
        'latest',
      ]);
      
      if (!result || result === '0x') return null;
      
      // 解析返回值: ABI编码 uint256[]
      // offset(64 hex) + length(64 hex) + elem0(64 hex) + elem1(64 hex)
      const hex = result.slice(2);
      if (hex.length < 256) return null;
      
      // 输出金额 = 第三个元素 (index=1)
      const outAmountHex = hex.slice(192, 256); // 跳过 offset+length+elem0 = 192
      const outAmount = BigInt('0x' + outAmountHex);
      
      if (outAmount <= 0n) return null;
      
      return {
        dex: dexName,
        dexName: dex.name,
        router: dex.router,
        tokenIn: tokenInAddr,
        tokenOut: tokenOutAddr,
        amountIn: amountIn,
        expectedOut: outAmount.toString(),
        feeBps: dex.feeBps,
        version: dex.version,
      };
    } catch (e) {
      return null;
    }
  }

  // ═══════════════════════════════════
  // 查询多跳路由报价 (tokenIn → hopToken → tokenOut)
  // ═══════════════════════════════════
  async getMultiHopQuote(dexName, tokenInAddr, hopTokenAddr, tokenOutAddr, amountIn) {
    const dex = DEX_ROUTERS[dexName];
    if (!dex) return null;

    const selector = dex.getAmountsOutSelector || '0xd06ca61f';
    const amountInHex = BigInt(amountIn).toString(16).padStart(64, '0');
    const pathOffset = '0000000000000000000000000000000000000000000000000000000000000040';
    const pathLen = '0000000000000000000000000000000000000000000000000000000000000003';
    const addr1 = tokenInAddr.toLowerCase().replace('0x', '').padStart(64, '0');
    const addr2 = hopTokenAddr.toLowerCase().replace('0x', '').padStart(64, '0');
    const addr3 = tokenOutAddr.toLowerCase().replace('0x', '').padStart(64, '0');
    
    const data = selector + amountInHex + pathOffset + pathLen + addr1 + addr2 + addr3;

    try {
      const result = await this.bscRpc('eth_call', [
        { to: dex.router, data },
        'latest',
      ]);
      
      if (!result || result === '0x') return null;
      const hex = result.slice(2);
      // 3跳路径: offset(64) + length(64) + in(64) + hop(64) + out(64) = 320 hex chars
      if (hex.length < 320) return null;
      
      const outAmountHex = hex.slice(256, 320); // 跳过 offset+length+in+hop = 256
      const outAmount = BigInt('0x' + outAmountHex);
      
      if (outAmount <= 0n) return null;
      
      return {
        dex: dexName,
        dexName: dex.name + ' (2-hop)',
        router: dex.router,
        tokenIn: tokenInAddr,
        tokenOut: tokenOutAddr,
        hopToken: hopTokenAddr,
        amountIn: amountIn,
        expectedOut: outAmount.toString(),
        feeBps: dex.feeBps * 2, // 两跳费用
        version: dex.version,
        multiHop: true,
      };
    } catch (e) {
      return null;
    }
  }

  // ═══════════════════════════════════
  // 并行查询所有DEX报价，选最优
  // ═══════════════════════════════════
  async findBestRoute(symbolIn, symbolOut, amountInUsdt) {
    const tokenIn = this.getTokenAddress(symbolIn);
    const tokenOut = this.getTokenAddress(symbolOut);
    
    if (!tokenIn || !tokenOut) {
      return { valid: false, error: '代币地址未找到' };
    }

    // amountIn 转为 wei (USDT 18 decimals)
    const amountIn = BigInt(Math.floor(amountInUsdt * 1e18));

    // 缓存检查
    const cacheKey = `${symbolIn}-${symbolOut}-${amountInUsdt}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.time < this.cacheTTL) {
      return cached.result;
    }

    // 并行查询所有DEX
    const dexNames = Object.keys(DEX_ROUTERS);
    const directQuotes = await Promise.allSettled(
      dexNames.map(dex => this.getQuote(dex, tokenIn, tokenOut, amountIn))
    );

    // 多跳路由查询（通过 WBNB/USDC 中转）
    const hopQuotes = [];
    for (const hopToken of HOP_TOKENS) {
      const hopAddr = TOKENS[hopToken];
      if (hopAddr === tokenIn || hopAddr === tokenOut) continue;
      
      const hops = await Promise.allSettled(
        dexNames.map(dex => this.getMultiHopQuote(dex, tokenIn, hopAddr, tokenOut, amountIn))
      );
      hopQuotes.push(...hops);
    }

    // 收集所有有效报价
    const allQuotes = [];
    for (const result of [...directQuotes, ...hopQuotes]) {
      if (result.status === 'fulfilled' && result.value) {
        allQuotes.push(result.value);
      }
    }

    if (allQuotes.length === 0) {
      return { valid: false, error: '所有DEX报价失败' };
    }

    // 按 expectedOut 降序排序，选最优
    allQuotes.sort((a, b) => {
      const outA = BigInt(a.expectedOut);
      const outB = BigInt(b.expectedOut);
      return outB > outA ? 1 : outB < outA ? -1 : 0;
    });

    const best = allQuotes[0];
    const worst = allQuotes[allQuotes.length - 1];
    
    // 计算节省
    const bestOut = BigInt(best.expectedOut);
    const worstOut = BigInt(worst.expectedOut);
    const savingsPct = worstOut > 0n
      ? Number((bestOut - worstOut) * 10000n / worstOut) / 100
      : 0;

    const result = {
      valid: true,
      best: {
        dex: best.dex,
        dexName: best.dexName,
        router: best.router,
        expectedOut: best.expectedOut,
        multiHop: best.multiHop || false,
        hopToken: best.hopToken || null,
        feeBps: best.feeBps,
      },
      allQuotes: allQuotes.map(q => ({
        dex: q.dex,
        dexName: q.dexName,
        expectedOut: q.expectedOut,
        multiHop: q.multiHop || false,
      })),
      savingsVsWorst: savingsPct,
      totalDexQueried: allQuotes.length,
    };

    // 缓存
    this.cache.set(cacheKey, { result, time: Date.now() });
    return result;
  }

  // ═══════════════════════════════════
  // 生成 Vault.executeSwap 调用参数
  // ═══════════════════════════════════
  buildSwapCall(bestRoute, tokenIn, tokenOut, slippageBps = 50) {
    if (!bestRoute.valid) return null;
    
    const best = bestRoute.best;
    const expectedOut = BigInt(best.expectedOut);
    const minOut = expectedOut * BigInt(10000 - slippageBps) / 10000n;
    
    return {
      dex: best.router,
      tokenIn,
      tokenOut,
      amountIn: null, // 由调用者设置
      minAmountOut: minOut.toString(),
      multiHop: best.multiHop,
      hopToken: best.hopToken,
      dexName: best.dexName,
    };
  }

  // 清空缓存
  clearCache() {
    this.cache.clear();
  }
}

module.exports = { DexAggregator, DEX_ROUTERS, TOKENS };
