// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AgentVault V3 — 用户智能合约钱包（完全修复版）
 * 
 * 修复清单：
 *   1. Ownable(_userAddress) — 部署时 ownership 归用户，用户可自由提现和设置
 *   2. executeSwap path 用 address[] 数组编码（不用 encodePacked）
 *   3. 默认限额 1e18（BSC USDT 18位小数）
 *   4. swapBNBForTokens path 同样用 address[]
 *   5. recordPnl 限额验证改用合理范围
 * 
 * 安全机制：
 *   - 只有 owner（用户）可以存取资金、设置限额、撤销 trader
 *   - trader（平台执行器）只能 swap（不能提现）
 *   - 白名单 DEX + 单笔限额 + 日限额
 *   - 紧急暂停功能
 */

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract AgentVaultV2 is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ 常量 ============
    address constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address constant PANCAKE_V2_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address constant PANCAKE_V3_ROUTER = 0x13f4eA83D0bD40E75c336312Cf81599DFE530382;

    // ============ 状态变量 ============

    /// @notice 平台执行器地址（可以执行交易）
    address public trader;

    /// @notice 平台收入钱包（收取服务费）
    address public platformFeeWallet;

    /// @notice 用户钱包地址
    address public userAddress;

    /// @notice 平台服务费比例（基点，2000 = 20%）
    uint256 public platformFeeBps;

    /// @notice 已授权的 DEX 合约白名单
    mapping(address => bool) public approvedDexes;

    /// @notice 单笔交易最大金额（18位小数）
    uint256 public maxSingleTradeAmount;

    /// @notice 日交易累计金额
    uint256 public dailyTradeVolume;

    /// @notice 日交易重置时间戳
    uint256 public dailyResetTimestamp;

    /// @notice 日交易限额（18位小数）
    uint256 public dailyTradeLimit;

    /// @notice 总交易次数
    uint256 public totalTrades;

    /// @notice 总盈亏（正=盈利，负=亏损）
    int256 public totalPnl;

    /// @notice 已收取的平台费
    uint256 public totalFeesCollected;

    /// @notice Vault 部署时间
    uint256 public createdAt;

    /// @notice RevenueDistribution 合约地址（盖茨费自动分配）
    address public revenueDistributor;

    /// @notice 是否已授权 RevenueDistribution 扣费
    bool public distributorApproved;

    // ============ 结构体 ============

    struct TradeRecord {
        uint256 id;
        address dex;
        address tokenIn;
        address tokenOut;
        uint256 inputAmount;
        uint256 outputAmount;
        int256 pnl;
        uint256 timestamp;
        bool success;
    }

    TradeRecord[] public trades;

    // ============ 事件 ============

    event TraderUpdated(address indexed oldTrader, address indexed newTrader);
    event DexApproved(address indexed dex, bool approved);
    event TradeExecuted(uint256 indexed tradeId, address indexed dex, uint256 inputAmount, uint256 outputAmount, uint256 timestamp);
    event PlatformFeeCollected(uint256 amount, uint256 timestamp);
    event UserDeposit(address indexed token, uint256 amount, uint256 timestamp);
    event UserWithdraw(address indexed token, uint256 amount, uint256 timestamp);
    event EmergencyStop(uint256 timestamp);
    event TradeLimitsUpdated(uint256 maxSingle, uint256 dailyLimit);

    // ============ 修饰器 ============

    modifier onlyTrader() {
        require(msg.sender == trader, "Not trader");
        _;
    }

    // ============ 构造函数 ============

    constructor(
        address _userAddress,
        address _trader,
        address _platformFeeWallet,
        uint256 _platformFeeBps
    ) Ownable(_userAddress) {
        require(_userAddress != address(0), "Invalid user");
        require(_trader != address(0), "Invalid trader");
        require(_platformFeeWallet != address(0), "Invalid fee wallet");
        require(_platformFeeBps <= 3000, "Fee too high");

        userAddress = _userAddress;
        trader = _trader;
        platformFeeWallet = _platformFeeWallet;
        platformFeeBps = _platformFeeBps;
        createdAt = block.timestamp;

        // 自动批准 PancakeSwap Router
        approvedDexes[PANCAKE_V2_ROUTER] = true;
        approvedDexes[PANCAKE_V3_ROUTER] = true;

        // 默认交易限额（18位小数）
        maxSingleTradeAmount = 50000 * 1e18;
        dailyTradeLimit = 200000 * 1e18;
        dailyResetTimestamp = block.timestamp;
    }

    // ============ RevenueDistribution 集成 ============

    /**
     * @notice 设置 RevenueDistribution 合约地址（只有 owner）
     */
    function setRevenueDistributor(address _distributor) external onlyOwner {
        require(_distributor != address(0), "Invalid distributor");
        revenueDistributor = _distributor;
    }

    /**
     * @notice 授权 RevenueDistribution 合约从本 Vault 扣 USDT（盖茨费）
     * @dev 用户调用，approve USDT 给 RevenueDistribution 合约
     */
    function approveDistributor(uint256 amount) external onlyOwner {
        require(revenueDistributor != address(0), "No distributor set");
        IERC20(USDT).forceApprove(revenueDistributor, amount);
        distributorApproved = true;
    }

    /**
     * @notice 授权最大额度给 RevenueDistribution（无限授权）
     */
    function approveDistributorMax() external onlyOwner {
        require(revenueDistributor != address(0), "No distributor set");
        IERC20(USDT).forceApprove(revenueDistributor, type(uint256).max);
        distributorApproved = true;
    }

    // ============ 资金管理（只有 owner）===========

    function depositUSDT(uint256 amount) external whenNotPaused {
        require(amount > 0, "Amount must be > 0");
        IERC20(USDT).safeTransferFrom(msg.sender, address(this), amount);
        emit UserDeposit(USDT, amount, block.timestamp);
    }

    function depositBNB() external payable nonReentrant whenNotPaused {
        require(msg.value > 0, "Amount must be > 0");
        emit UserDeposit(address(0), msg.value, block.timestamp);
    }

    function withdrawUSDT(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "Amount must be > 0");
        IERC20 usdt = IERC20(USDT);
        require(usdt.balanceOf(address(this)) >= amount, "Insufficient USDT");
        usdt.safeTransfer(owner(), amount);
        emit UserWithdraw(USDT, amount, block.timestamp);
    }

    function withdrawBNB(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "Amount must be > 0");
        require(address(this).balance >= amount, "Insufficient BNB");
        (bool success, ) = payable(owner()).call{value: amount}("");
        require(success, "BNB transfer failed");
        emit UserWithdraw(address(0), amount, block.timestamp);
    }

    function withdrawAllUSDT() external onlyOwner nonReentrant {
        IERC20 usdt = IERC20(USDT);
        uint256 balance = usdt.balanceOf(address(this));
        require(balance > 0, "No USDT to withdraw");
        usdt.safeTransfer(owner(), balance);
        emit UserWithdraw(USDT, balance, block.timestamp);
    }

    function withdrawAllBNB() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        require(balance > 0, "No BNB to withdraw");
        (bool success, ) = payable(owner()).call{value: balance}("");
        require(success, "BNB transfer failed");
        emit UserWithdraw(address(0), balance, block.timestamp);
    }

    // ============ 交易执行（只有 trader）===========

    /**
     * @notice 执行 Token→Token swap
     * @param dex DEX Router 地址（必须在白名单）
     * @param tokenIn 输入 token
     * @param tokenOut 输出 token
     * @param amountIn 输入金额
     * @param minAmountOut 最小输出（滑点保护）
     */
    function executeSwap(
        address dex,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut
    ) external onlyTrader whenNotPaused returns (uint256 outputAmount) {
        require(approvedDexes[dex], "DEX not approved");
        require(amountIn > 0, "Amount must be > 0");
        require(amountIn <= maxSingleTradeAmount, "Exceeds single trade limit");
        _checkDailyLimit(amountIn);

        IERC20 tokenInERC20 = IERC20(tokenIn);
        require(tokenInERC20.balanceOf(address(this)) >= amountIn, "Insufficient input");

        // 记录输出余额增量
        uint256 balanceBeforeOut = IERC20(tokenOut).balanceOf(address(this));

        // 授权 DEX
        tokenInERC20.forceApprove(dex, 0);
        tokenInERC20.forceApprove(dex, amountIn);

        // ⚠️ 关键修复：path 必须用 address[] 编码，不能用 encodePacked
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        bytes memory callData = abi.encodeWithSignature(
            "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
            amountIn,
            minAmountOut,
            path,
            address(this),
            block.timestamp + 300
        );

        (bool success, ) = dex.call{value: 0}(callData);
        require(success, "Swap failed");

        outputAmount = IERC20(tokenOut).balanceOf(address(this)) - balanceBeforeOut;

        // 重置授权
        tokenInERC20.forceApprove(dex, 0);
        _updateDailyVolume(amountIn);

        uint256 tradeId = trades.length;
        trades.push(TradeRecord({
            id: tradeId, dex: dex, tokenIn: tokenIn, tokenOut: tokenOut,
            inputAmount: amountIn, outputAmount: outputAmount, pnl: 0,
            timestamp: block.timestamp, success: true
        }));
        totalTrades++;
        emit TradeExecuted(tradeId, dex, amountIn, outputAmount, block.timestamp);
    }

    /**
     * @notice 执行 BNB→Token swap
     */
    function swapBNBForTokens(
        address dex,
        address tokenOut,
        uint256 minAmountOut
    ) external payable onlyTrader whenNotPaused returns (uint256 outputAmount) {
        require(approvedDexes[dex], "DEX not approved");
        require(msg.value > 0, "Must send BNB");
        require(msg.value <= maxSingleTradeAmount, "Exceeds single trade limit");
        _checkDailyLimit(msg.value);

        uint256 balanceBefore = IERC20(tokenOut).balanceOf(address(this));

        // ⚠️ 关键修复：path 必须用 address[] 编码
        address[] memory path = new address[](2);
        path[0] = WBNB;
        path[1] = tokenOut;

        bytes memory callData = abi.encodeWithSignature(
            "swapExactETHForTokens(uint256,address[],address,uint256)",
            minAmountOut,
            path,
            address(this),
            block.timestamp + 300
        );

        (bool success, ) = dex.call{value: msg.value}(callData);
        require(success, "BNB swap failed");

        outputAmount = IERC20(tokenOut).balanceOf(address(this)) - balanceBefore;
        _updateDailyVolume(msg.value);

        uint256 tradeId = trades.length;
        trades.push(TradeRecord({
            id: tradeId, dex: dex, tokenIn: WBNB, tokenOut: tokenOut,
            inputAmount: msg.value, outputAmount: outputAmount, pnl: 0,
            timestamp: block.timestamp, success: true
        }));
        totalTrades++;
        emit TradeExecuted(tradeId, dex, msg.value, outputAmount, block.timestamp);
    }

    // ============ 收益结算 ============

    /**
     * @notice 记录盈亏并自动收取盖茨费
     * @dev 如果盈利，通过 RevenueDistribution 合约自动分配 30% 盖茨费
     * @param pnlAmount 盈亏金额（正=盈利，负=亏损，18位小数）
     */
    function recordPnl(int256 pnlAmount) external onlyTrader {
        totalPnl += pnlAmount;

        if (pnlAmount > 0) {
            uint256 profit = uint256(pnlAmount);

            // 如果设置了 RevenueDistribution，通过它自动收取盖茨费
            if (revenueDistributor != address(0) && distributorApproved) {
                // 调用 RevenueDistribution.collectFee(address(this), profit)
                // RevenueDistribution 会从本 Vault transferFrom USDT 并自动分配
                (bool success, ) = revenueDistributor.call(
                    abi.encodeWithSignature("collectFee(address,uint256)", address(this), profit)
                );
                if (success) {
                    uint256 fee = (profit * 3000) / 10000;  // 30% 盖茨费
                    totalFeesCollected += fee;
                    emit PlatformFeeCollected(fee, block.timestamp);
                }
            } else {
                // 降级模式：直接转 20% 给平台钱包（兼容旧逻辑）
                uint256 fee = (profit * platformFeeBps) / 10000;
                if (fee > 0) {
                    IERC20 usdt = IERC20(USDT);
                    uint256 balance = usdt.balanceOf(address(this));
                    if (balance >= fee) {
                        usdt.safeTransfer(platformFeeWallet, fee);
                        totalFeesCollected += fee;
                        emit PlatformFeeCollected(fee, block.timestamp);
                    }
                }
            }
        }
    }

    // ============ 权限管理（只有 owner）===========

    function setTrader(address _trader) external onlyOwner {
        require(_trader != address(0), "Invalid trader");
        address old = trader;
        trader = _trader;
        emit TraderUpdated(old, _trader);
    }

    function setTradeLimits(uint256 _maxSingle, uint256 _dailyLimit) external onlyOwner {
        maxSingleTradeAmount = _maxSingle;
        dailyTradeLimit = _dailyLimit;
        emit TradeLimitsUpdated(_maxSingle, _dailyLimit);
    }

    function setDexApproval(address dex, bool approved) external onlyOwner {
        approvedDexes[dex] = approved;
        emit DexApproved(dex, approved);
    }

    function revokeTrader() external onlyOwner {
        address old = trader;
        trader = address(0);
        approvedDexes[PANCAKE_V2_ROUTER] = false;
        approvedDexes[PANCAKE_V3_ROUTER] = false;
        _pause();
        emit TraderUpdated(old, address(0));
        emit EmergencyStop(block.timestamp);
    }

    function emergencyPause() external onlyOwner {
        _pause();
        emit EmergencyStop(block.timestamp);
    }

    function resume() external onlyOwner {
        _unpause();
        approvedDexes[PANCAKE_V2_ROUTER] = true;
        approvedDexes[PANCAKE_V3_ROUTER] = true;
    }

    // ============ 内部函数 ============

    function _checkDailyLimit(uint256 amount) internal {
        if (block.timestamp >= dailyResetTimestamp + 1 days) {
            dailyTradeVolume = 0;
            dailyResetTimestamp = block.timestamp;
        }
        require(dailyTradeVolume + amount <= dailyTradeLimit, "Exceeds daily trade limit");
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
        return IERC20(USDT).balanceOf(address(this));
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

    receive() external payable {}
}
