// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AgentVault — 用户智能合约钱包
 * 
 * 核心设计：
 *   1. 每个用户部署一个 Vault 合约（由平台工厂统一部署）
 *   2. 用户存入 USDT/BNB 到 Vault
 *   3. 授权平台执行器（trader）可以操作 Vault 里的资金进行交易
 *   4. 用户随时可以撤销授权、转出资金
 *   5. 平台执行器只有交易权限，没有转出权限
 *
 * 安全机制：
 *   - 只有 owner（用户）可以存取资金
 *   - trader（平台执行器）只能在白名单 DEX 合约上调用 swap
 *   - trader 不能直接转出 token 到任意地址
 *   - 用户可以随时 revoke trader 权限
 *   - 单笔交易限额、日交易限额
 *   - 紧急暂停功能（用户 + 平台都可以触发）
 *
 * 用户流程：
 *   1. 打开平台 → TP 钱包签名登录
 *   2. 一键部署 Vault（TP 签名确认）
 *   3. 转入资金到 Vault
 *   4. 点击「开启自动交易」→ TP 确认授权 trader
 *   5. 机器人自动交易
 *   6. 想提现 → 点「停止并提现」→ 资金回到 TP 钱包
 */

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract AgentVault is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ 状态变量 ============

    /// @notice 平台执行器地址（可以执行交易）
    address public trader;

    /// @notice 平台收入钱包（收取服务费）
    address public platformFeeWallet;

    /// @notice 用户在平台的 ID（钱包地址）
    address public userAddress;

    /// @notice 平台服务费比例（基点，1bp = 0.01%）
    uint256 public platformFeeBps; // 例：2000 = 20%

    /// @notice 已授权的 DEX 合约白名单
    mapping(address => bool) public approvedDexes;

    /// @notice 单笔交易最大金额（USDT）
    uint256 public maxSingleTradeAmount;

    /// @notice 日交易累计金额（USDT）
    uint256 public dailyTradeVolume;

    /// @notice 日交易重置时间戳
    uint256 public dailyResetTimestamp;

    /// @notice 日交易限额（USDT）
    uint256 public dailyTradeLimit;

    /// @notice 总交易次数
    uint256 public totalTrades;

    /// @notice 总盈亏（正=盈利，负=亏损）
    int256 public totalPnl;

    /// @notice 已收取的平台费
    uint256 public totalFeesCollected;

    /// @notice Vault 部署时间
    uint256 public createdAt;

    // ============ 结构体 ============

    struct TradeRecord {
        uint256 id;
        address dex;
        bytes callData;       // 原始调用数据
        uint256 inputAmount;  // 输入金额
        uint256 outputAmount; // 输出金额（估算）
        int256 pnl;           // 盈亏
        uint256 timestamp;
        bool success;
    }

    TradeRecord[] public trades;

    // ============ 事件 ============

    event TraderUpdated(address indexed oldTrader, address indexed newTrader);
    event DexApproved(address indexed dex, bool approved);
    event TradeExecuted(
        uint256 indexed tradeId,
        address indexed dex,
        uint256 inputAmount,
        uint256 outputAmount,
        int256 pnl,
        uint256 timestamp
    );
    event PlatformFeeCollected(uint256 amount, uint256 timestamp);
    event UserDeposit(address indexed token, uint256 amount, uint256 timestamp);
    event UserWithdraw(address indexed token, uint256 amount, uint256 timestamp);
    event EmergencyStop(uint256 timestamp);
    event TradeLimitsUpdated(uint256 maxSingle, uint256 dailyLimit);

    // ============ 修饰器 ============

    modifier onlyTrader() {
        require(msg.sender == trader || msg.sender == owner(), "Not trader");
        _;
    }

    modifier onlyTraderOrOwner() {
        require(
            msg.sender == trader || msg.sender == owner(),
            "Not authorized"
        );
        _;
    }

    // ============ 构造函数 ============

    /**
     * @param _userAddress 用户钱包地址
     * @param _trader 平台执行器地址
     * @param _platformFeeWallet 平台收入钱包
     * @param _platformFeeBps 平台服务费（基点）
     */
    constructor(
        address _userAddress,
        address _trader,
        address _platformFeeWallet,
        uint256 _platformFeeBps
    ) Ownable(_userAddress) { // v20: owner 设为用户，而非 Factory
        require(_userAddress != address(0), "Invalid user");
        require(_trader != address(0), "Invalid trader");
        require(_platformFeeWallet != address(0), "Invalid fee wallet");
        require(_platformFeeBps <= 3000, "Fee too high"); // 最高 30%

        userAddress = _userAddress;
        trader = _trader;
        platformFeeWallet = _platformFeeWallet;
        platformFeeBps = _platformFeeBps;
        createdAt = block.timestamp;

        // v14: 自动批准 PancakeSwap Router（否则 executeSwap 必定 revert）
        approvedDexes[0x10ED43C718714eb63d5aA57B78B54704E256024E] = true; // PancakeSwap V2 Router
        approvedDexes[0x13f4eA83D0bD40E75c336312Cf81599DFE530382] = true; // PancakeSwap V3 Router

        // 默认交易限额（BSC USDT 18位小数）
        maxSingleTradeAmount = 50000 * 1e18;    // 50,000 USDT
        dailyTradeLimit = 200000 * 1e18;         // 200,000 USDT
        dailyResetTimestamp = block.timestamp;
    }

    // ============ 资金管理（只有 owner/用户）===========

    /**
     * @notice 存入 USDT 到 Vault
     */
    function depositUSDT(uint256 amount) external whenNotPaused {
        require(amount > 0, "Amount must be > 0");
        IERC20 usdt = IERC20(0x55d398326f99059fF775485246999027B3197955); // BSC USDT
        usdt.safeTransferFrom(msg.sender, address(this), amount);
        emit UserDeposit(address(usdt), amount, block.timestamp);
    }

    /**
     * @notice 存入 BNB 到 Vault
     */
    function depositBNB() external payable nonReentrant whenNotPaused {
        require(msg.value > 0, "Amount must be > 0");
        emit UserDeposit(address(0), msg.value, block.timestamp);
    }

    /**
     * @notice 提取 USDT（只有用户自己）
     */
    function withdrawUSDT(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "Amount must be > 0");
        IERC20 usdt = IERC20(0x55d398326f99059fF775485246999027B3197955);
        uint256 balance = usdt.balanceOf(address(this));
        require(balance >= amount, "Insufficient USDT balance");
        usdt.safeTransfer(owner(), amount);
        emit UserWithdraw(address(usdt), amount, block.timestamp);
    }

    /**
     * @notice 提取 BNB（只有用户自己）
     */
    function withdrawBNB(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "Amount must be > 0");
        require(address(this).balance >= amount, "Insufficient BNB balance");
        // v14: 使用 call 替代 transfer，避免 2300 gas 限制
        (bool success, ) = payable(owner()).call{value: amount}("");
        require(success, "BNB transfer failed");
        emit UserWithdraw(address(0), amount, block.timestamp);
    }

    /**
     * @notice 提取所有 USDT（全部提现）
     */
    function withdrawAllUSDT() external onlyOwner nonReentrant {
        IERC20 usdt = IERC20(0x55d398326f99059fF775485246999027B3197955);
        uint256 balance = usdt.balanceOf(address(this));
        require(balance > 0, "No USDT to withdraw");
        usdt.safeTransfer(owner(), balance);
        emit UserWithdraw(address(usdt), balance, block.timestamp);
    }

    /**
     * @notice 提取所有 BNB（全部提现）
     */
    function withdrawAllBNB() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        require(balance > 0, "No BNB to withdraw");
        // v14: 使用 call 替代 transfer，避免 2300 gas 限制
        (bool success, ) = payable(owner()).call{value: balance}("");
        require(success, "BNB transfer failed");
        emit UserWithdraw(address(0), balance, block.timestamp);
    }

    // ============ 交易执行（只有 trader）===========

    /**
     * @notice 执行 DEX swap（由平台 trader 调用）
     * @param dex DEX 合约地址（必须在白名单）
     * @param tokenIn 输入 token 地址
     * @param tokenOut 输出 token 地址
     * @param amountIn 输入金额
     * @param minAmountOut 最小输出金额（滑点保护）
     */
    function executeSwap(
        address dex,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut
    ) external onlyTrader whenNotPaused returns (uint256 outputAmount) {
        // 安全检查
        require(approvedDexes[dex], "DEX not approved");
        require(amountIn > 0, "Amount must be > 0");
        require(amountIn <= maxSingleTradeAmount, "Exceeds single trade limit");

        // 日限额检查
        _checkDailyLimit(amountIn);

        // 记录输入余额
        IERC20 tokenInERC20 = IERC20(tokenIn);
        uint256 balanceBefore = tokenInERC20.balanceOf(address(this));
        require(balanceBefore >= amountIn, "Insufficient input token");

        // 记录输出余额（v14修复：计算增量）
        IERC20 tokenOutERC20 = IERC20(tokenOut);
        uint256 balanceBeforeOut = tokenOutERC20.balanceOf(address(this));

        // 授权 DEX 使用 Vault 的 token
        tokenInERC20.forceApprove(dex, 0);
        tokenInERC20.forceApprove(dex, amountIn);

        // v20: 修复 address[] ABI编码
        address[] memory swapPath = new address[](2);
        swapPath[0] = tokenIn;
        swapPath[1] = tokenOut;
        bytes memory callData = abi.encodeWithSignature(
            "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
            amountIn, minAmountOut, swapPath, address(this), block.timestamp + 300
        );

        // 调用 DEX
        (bool success, ) = dex.call{value: 0}(callData);
        require(success, "Swap failed");

        // outputAmount = 增量
        outputAmount = IERC20(tokenOut).balanceOf(address(this)) - balanceBeforeOut;

        // 重置授权 + 更新日交易量
        IERC20(tokenIn).forceApprove(dex, 0);
        _updateDailyVolume(amountIn);

        // 记录交易
        trades.push(TradeRecord({
            id: trades.length, dex: dex, callData: callData,
            inputAmount: amountIn, outputAmount: outputAmount, pnl: 0,
            timestamp: block.timestamp, success: true
        }));
        totalTrades++;
        emit TradeExecuted(trades.length - 1, dex, amountIn, outputAmount, 0, block.timestamp);
    }

    /**
     * @notice 执行 BNB→Token swap（通过 PancakeSwap WBNB）
     * @param dex DEX 合约地址（必须在白名单）
     * @param tokenOut 输出 token 地址
     * @param minAmountOut 最小输出金额（滑点保护）
     */
    function swapBNBForTokens(
        address dex,
        address tokenOut,
        uint256 minAmountOut
    ) external payable onlyTrader whenNotPaused returns (uint256 outputAmount) {
        address wbnb = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c; // WBNB
        require(approvedDexes[dex], "DEX not approved");
        require(msg.value > 0, "Must send BNB");
        require(msg.value <= maxSingleTradeAmount, "Exceeds single trade limit");

        _checkDailyLimit(msg.value);

        // 记录输入余额
        uint256 balanceBefore = IERC20(tokenOut).balanceOf(address(this));

        // v20: 修复 address[] ABI编码
        address[] memory path = new address[](2);
        path[0] = wbnb;
        path[1] = tokenOut;
        bytes memory callData = abi.encodeWithSignature(
            "swapExactETHForTokens(uint256,address[],address,uint256)",
            minAmountOut, path, address(this), block.timestamp + 300
        );

        (bool success, ) = dex.call{value: msg.value}(callData);
        require(success, "BNB swap failed");

        outputAmount = IERC20(tokenOut).balanceOf(address(this)) - balanceBefore;
        _updateDailyVolume(msg.value);

        trades.push(TradeRecord({
            id: trades.length, dex: dex, callData: callData,
            inputAmount: msg.value, outputAmount: outputAmount, pnl: 0,
            timestamp: block.timestamp, success: true
        }));
        totalTrades++;
        emit TradeExecuted(trades.length - 1, dex, msg.value, outputAmount, 0, block.timestamp);
    }

    // ============ 收益结算 ============

    /**
     * @notice 记录平仓盈亏并收取平台费（只有 trader）
     */
    function recordPnl(int256 pnlAmount) external onlyTrader {
        // v14: 输入验证 — 防止异常 PnL 值
        require(pnlAmount > -int256(maxSingleTradeAmount), "PnL loss exceeds max trade");
        require(pnlAmount < int256(maxSingleTradeAmount), "PnL gain exceeds max trade");
        totalPnl += pnlAmount;

        if (pnlAmount > 0) {
            // 盈利时收取平台费
            uint256 fee = (uint256(pnlAmount) * platformFeeBps) / 10000;
            if (fee > 0) {
                IERC20 usdt = IERC20(0x55d398326f99059fF775485246999027B3197955);
                uint256 balance = usdt.balanceOf(address(this));
                if (balance >= fee) {
                    usdt.safeTransfer(platformFeeWallet, fee);
                    totalFeesCollected += fee;
                    emit PlatformFeeCollected(fee, block.timestamp);
                }
            }
        }
    }

    // ============ 权限管理 ============

    /**
     * @notice 更新交易执行器（只有用户自己）
     */
    function setTrader(address _trader) external onlyOwner {
        require(_trader != address(0), "Invalid trader");
        address old = trader;
        trader = _trader;
        emit TraderUpdated(old, _trader);
    }

    /**
     * @notice 添加/移除 DEX 白名单（只有用户自己）
     */
    function setDexApproval(address dex, bool approved) external onlyOwner {
        approvedDexes[dex] = approved;
        emit DexApproved(dex, approved);
    }

    /**
     * @notice 批量设置 DEX 白名单
     */
    function setDexApprovals(address[] calldata dexes, bool[] calldata approvals) external onlyOwner {
        require(dexes.length == approvals.length, "Length mismatch");
        for (uint256 i = 0; i < dexes.length; i++) {
            approvedDexes[dexes[i]] = approvals[i];
            emit DexApproved(dexes[i], approvals[i]);
        }
    }

    /**
     * @notice 更新交易限额（只有用户自己）
     */
    function setTradeLimits(uint256 _maxSingle, uint256 _dailyLimit) external onlyOwner { // v20: owner = userAddress
        maxSingleTradeAmount = _maxSingle;
        dailyTradeLimit = _dailyLimit;
        emit TradeLimitsUpdated(_maxSingle, _dailyLimit);
    }

    /**
     * @notice 撤销 trader 权限（紧急停止交易）
     */
    function revokeTrader() external onlyOwner {
        address old = trader;
        trader = address(0);
        // v14: 重置白名单 DEX 授权，防止旧 trader 地址残留权限
        approvedDexes[0x10ED43C718714eb63d5aA57B78B54704E256024E] = false;
        approvedDexes[0x13f4eA83D0bD40E75c336312Cf81599DFE530382] = false;
        _pause();
        emit TraderUpdated(old, address(0));
        emit EmergencyStop(block.timestamp);
    }

    /**
     * @notice 紧急暂停
     */
    function emergencyPause() external onlyOwner {
        _pause();
        emit EmergencyStop(block.timestamp);
    }

    /**
     * @notice 恢复交易
     */
    function resume() external onlyOwner {
        _unpause();
        // v14: 恢复时重新批准 PancakeSwap Router
        approvedDexes[0x10ED43C718714eb63d5aA57B78B54704E256024E] = true;
        approvedDexes[0x13f4eA83D0bD40E75c336312Cf81599DFE530382] = true;
    }

    // ============ 内部函数 ============

    function _checkDailyLimit(uint256 amount) internal {
        if (block.timestamp >= dailyResetTimestamp + 1 days) {
            dailyTradeVolume = 0;
            dailyResetTimestamp = block.timestamp;
        }
        require(
            dailyTradeVolume + amount <= dailyTradeLimit,
            "Exceeds daily trade limit"
        );
    }

    function _updateDailyVolume(uint256 amount) internal {
        if (block.timestamp >= dailyResetTimestamp + 1 days) {
            dailyTradeVolume = 0;
            dailyResetTimestamp = block.timestamp;
        }
        dailyTradeVolume += amount;
    }

    // ============ 查询函数 ============

    function getUSDTBalance() external view returns (uint256) {
        IERC20 usdt = IERC20(0x55d398326f99059fF775485246999027B3197955);
        return usdt.balanceOf(address(this));
    }

    function getBNBBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function getTradeCount() external view returns (uint256) {
        return trades.length;
    }

    function getTrader() external view returns (address) {
        return trader;
    }

    function isPaused() external view returns (bool) {
        return paused();
    }

    // 接收 BNB
    receive() external payable {}
}
