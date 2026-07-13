/**
 * v14: 完整 Vault ABI — 包含所有函数 + 事件
 * 用于链上交互、事件解析、日志追踪
 */
module.exports = [
  // ── 查看 ──
  'function owner() view returns (address)',
  'function trader() view returns (address)',
  'function isPaused() view returns (bool)',
  'function usdt() view returns (address)',
  'function getUSDTBalance() view returns (uint256)',
  'function getBNBBalance() view returns (uint256)',
  'function getTradeCount() view returns (uint256)',
  'function totalPnl() view returns (int256)',
  'function maxSingleTradeAmount() view returns (uint256)',
  'function dailyTradeLimit() view returns (uint256)',
  'function dailyVolume() view returns (uint256)',
  'function lastTradeDay() view returns (uint256)',
  'function approvedDexes(address) view returns (bool)',
  'function getApprovedDexes() view returns (address[])',

  // ── 存入 ──
  'function depositUSDT(uint256 amount)',
  'function depositBNB() payable',

  // ── 提取 ──
  'function withdrawUSDT(uint256 amount)',
  'function withdrawBNB(uint256 amount)',
  'function withdrawAllUSDT()',
  'function withdrawAllBNB()',

  // ── 交易（trader only）──
  'function executeSwap(address dex, address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut)',
  'function swapBNBForTokens(address tokenOut, uint256 amountOutMin, address dexRouter) payable',
  'function recordPnl(int256 pnlAmount)',

  // ── 管理 ──
  'function setTrader(address _trader)',
  'function setDexApproval(address dex, bool approved)',
  'function setDexApprovals(address[] calldata dexes, bool[] calldata approvals)',
  'function setTradeLimits(uint256 _maxSingle, uint256 _dailyLimit)',
  'function revokeTrader()',
  'function emergencyPause()',
  'function resume()',

  // ── 事件 ──
  'event TraderUpdated(address indexed oldTrader, address indexed newTrader)',
  'event DexApproved(address indexed dex, bool approved)',
  'event TradeExecuted(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, uint256 pnl)',
  'event UserDeposit(address indexed token, uint256 amount, uint256 timestamp)',
  'event UserWithdraw(address indexed token, uint256 amount, uint256 timestamp)',
  'event EmergencyStop(uint256 timestamp)',
  'event PnLRecorded(int256 pnlAmount, int256 totalPnl)',
];
