/**
 * Trading Pairs Configuration
 * v113.15: 扩展到30个高流动性品种 — 增加交易机会
 * 
 * 分层：
 * - AAA: BTC/ETH/BNB 等顶级流动性，适合大趋势
 * - AA: SOL/XRP/DOGE 等高流动性山寨
 * - A: 中等流动性品种
 * - B: 新增热门品种（波动大但趋势明显时利润厚）
 */
module.exports = {
  // ═══ 核心5品种（原有）═══
  BTCUSDT:   { qtyPrecision: 3, minQty: 0.001,  tickSize: 0.10,    baseAsset: 'BTC',   category: 'major',  liquidity: 'AAA' },
  ETHUSDT:   { qtyPrecision: 3, minQty: 0.001,  tickSize: 0.01,    baseAsset: 'ETH',   category: 'major',  liquidity: 'AAA' },
  SOLUSDT:   { qtyPrecision: 2, minQty: 0.01,   tickSize: 0.01,    baseAsset: 'SOL',   category: 'major',  liquidity: 'AA' },
  BNBUSDT:   { qtyPrecision: 2, minQty: 0.01,   tickSize: 0.01,    baseAsset: 'BNB',   category: 'major',  liquidity: 'AAA' },
  XRPUSDT:   { qtyPrecision: 1, minQty: 0.1,     tickSize: 0.0001,  baseAsset: 'XRP',   category: 'major',  liquidity: 'AA' },
  // ═══ 山寨6品种（原有）═══
  DOGEUSDT:  { qtyPrecision: 0, minQty: 1,      tickSize: 0.00001, baseAsset: 'DOGE',  category: 'meme',   liquidity: 'AA' },
  ADAUSDT:   { qtyPrecision: 1, minQty: 0.1,    tickSize: 0.0001,  baseAsset: 'ADA',   category: 'alt',    liquidity: 'A' },
  AVAXUSDT:  { qtyPrecision: 2, minQty: 0.01,   tickSize: 0.01,    baseAsset: 'AVAX',  category: 'alt',    liquidity: 'A' },
  LINKUSDT:  { qtyPrecision: 2, minQty: 0.01,   tickSize: 0.01,    baseAsset: 'LINK',  category: 'alt',    liquidity: 'A' },
  DOTUSDT:   { qtyPrecision: 2, minQty: 0.01,   tickSize: 0.01,    baseAsset: 'DOT',   category: 'alt',    liquidity: 'A' },
  // ═══ 新增20品种 v113.15 ═══
  // Meme/高波动
  SHIBUSDT:  { qtyPrecision: 0, minQty: 1,      tickSize: 0.00000001, baseAsset: 'SHIB',  category: 'meme',   liquidity: 'AA' },
  PEPEUSDT:  { qtyPrecision: 0, minQty: 1,      tickSize: 0.00000001, baseAsset: 'PEPE',  category: 'meme',   liquidity: 'A' },
  WIFUSDT:   { qtyPrecision: 2, minQty: 0.01,   tickSize: 0.0001,  baseAsset: 'WIF',   category: 'meme',   liquidity: 'A' },
  FLOKIUSDT: { qtyPrecision: 0, minQty: 1,      tickSize: 0.00000001, baseAsset: 'FLOKI', category: 'meme',   liquidity: 'B' },
  BONKUSDT:  { qtyPrecision: 0, minQty: 1,      tickSize: 0.00000001, baseAsset: 'BONK',  category: 'meme',   liquidity: 'B' },
  // L1/L2 公链
  NEARUSDT:  { qtyPrecision: 2, minQty: 0.01,   tickSize: 0.0001,  baseAsset: 'NEAR',  category: 'l1',     liquidity: 'A' },
  APTUSDT:   { qtyPrecision: 2, minQty: 0.01,   tickSize: 0.0001,  baseAsset: 'APT',   category: 'l1',     liquidity: 'A' },
  ARBUSDT:   { qtyPrecision: 2, minQty: 0.01,   tickSize: 0.0001,  baseAsset: 'ARB',   category: 'l2',     liquidity: 'A' },
  OPUSDT:    { qtyPrecision: 2, minQty: 0.01,   tickSize: 0.0001,  baseAsset: 'OP',    category: 'l2',     liquidity: 'A' },
  INJUSDT:   { qtyPrecision: 2, minQty: 0.01,   tickSize: 0.0001,  baseAsset: 'INJ',   category: 'l1',     liquidity: 'A' },
  SUIUSDT:   { qtyPrecision: 2, minQty: 0.01,   tickSize: 0.0001,  baseAsset: 'SUI',   category: 'l1',     liquidity: 'A' },
  SEIUSDT:   { qtyPrecision: 2, minQty: 0.01,   tickSize: 0.0001,  baseAsset: 'SEI',   category: 'l1',     liquidity: 'B' },
  TIAUSDT:   { qtyPrecision: 2, minQty: 0.01,   tickSize: 0.0001,  baseAsset: 'TIA',   category: 'l1',     liquidity: 'B' },
  // DeFi
  AAVEUSDT:  { qtyPrecision: 2, minQty: 0.01,   tickSize: 0.01,    baseAsset: 'AAVE',  category: 'defi',   liquidity: 'A' },
  UNIUSDT:   { qtyPrecision: 2, minQty: 0.01,   tickSize: 0.01,    baseAsset: 'UNI',   category: 'defi',   liquidity: 'A' },
  LDOUSDT:   { qtyPrecision: 2, minQty: 0.01,   tickSize: 0.0001,  baseAsset: 'LDO',   category: 'defi',   liquidity: 'B' },
  // 其他热门
  MATICUSDT: { qtyPrecision: 2, minQty: 0.01,   tickSize: 0.00001, baseAsset: 'MATIC', category: 'alt',    liquidity: 'AA' },
  LTCUSDT:   { qtyPrecision: 3, minQty: 0.001,  tickSize: 0.01,    baseAsset: 'LTC',   category: 'major',  liquidity: 'AA' },
  FILUSDT:   { qtyPrecision: 2, minQty: 0.01,   tickSize: 0.0001,  baseAsset: 'FIL',   category: 'alt',    liquidity: 'A' },
  ATOMUSDT:  { qtyPrecision: 2, minQty: 0.01,   tickSize: 0.001,   baseAsset: 'ATOM',  category: 'alt',    liquidity: 'A' },
};
