// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AI Quant Agent Revenue Distribution Contract
 * @notice 链上收益分配，自动 30% 盖茨费分配（20% 服务费 + 10% 生态费）
 * @dev 部署在 BSC，所有交易透明可验证
 *
 * 分配规则（盖茨费 = 盈利 × 30%）：
 *   服务费 20% → platformWallet   (0xb6DEb314...)
 *   生态费 10% → ecoFundWallet     (0xeF87e7fD...)
 *   用户实得 70% → 留在用户 Vault
 *
 * 流程：
 *   1. 用户在前端 approve USDT 给 RevenueDistribution 合约
 *   2. 后端检测到盈利 → 调用 collectFee() 从用户 Vault transferFrom USDT
 *   3. 合约自动按比例分配到两个钱包
 *   4. 如果用户 USDT 不足，合约标记暂停
 */

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract RevenueDistribution is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ 常量 ============

    address constant USDT = 0x55d398326f99059fF775485246999027B3197955;

    // ============ 状态变量 ============

    /// @notice 服务费接收钱包（20%）
    address public platformWallet;

    /// @notice 生态基金钱包（10%）
    address public ecoFundWallet;

    /// @notice 平台执行器（可以调用 collectFee）
    address public trader;

    // 盖茨费率（基点）= 30%
    uint256 public constant GATES_FEE_BPS = 3000;
    // 服务费率（基点）= 20%
    uint256 public constant PLATFORM_FEE_BPS = 2000;
    // 生态费率（基点）= 10%
    uint256 public constant ECO_FUND_BPS = 1000;

    /// @notice 单笔盖茨费上限（USDT, 18位小数）
    uint256 public maxFeePerTrade = 10000 * 1e18;

    /// @notice 累计统计
    uint256 public totalCollected;
    uint256 public totalPlatformFee;
    uint256 public totalEcoFund;
    uint256 public totalTrades;

    /// @notice 用户记录: wallet => { exists, totalPaid, lastCollection }
    struct UserRecord {
        bool exists;
        uint256 totalPaid;
        uint256 lastCollection;
    }
    mapping(address => UserRecord) public users;

    /// @notice 已授权的 Vault 地址（Factory 部署的 Vault 可以被授权扣费）
    mapping(address => bool) public approvedVaults;

    /// @notice 盖茨费收集记录
    struct FeeRecord {
        address user;
        address vault;
        uint256 grossAmount;
        uint256 platformFee;
        uint256 ecoFund;
        uint256 timestamp;
    }
    FeeRecord[] public feeRecords;

    // ============ 事件 ============

    event FeeCollected(
        address indexed user,
        address indexed vault,
        uint256 grossAmount,
        uint256 platformFee,
        uint256 ecoFund,
        uint256 timestamp
    );
    event UserRegistered(address indexed user, uint256 timestamp);
    event VaultApproved(address indexed vault, bool approved);
    event WalletsUpdated(address newPlatform, address newEcoFund);
    event TraderUpdated(address newTrader);

    // ============ 修饰器 ============

    modifier onlyTraderOrOwner() {
        require(msg.sender == trader || msg.sender == owner(), "Not authorized");
        _;
    }

    // ============ 构造函数 ============

    constructor(
        address _trader,
        address _platformWallet,
        address _ecoFundWallet
    ) Ownable(msg.sender) {
        require(_trader != address(0), "Invalid trader");
        require(_platformWallet != address(0), "Invalid platform wallet");
        require(_ecoFundWallet != address(0), "Invalid eco fund wallet");

        trader = _trader;
        platformWallet = _platformWallet;
        ecoFundWallet = _ecoFundWallet;
    }

    // ============ 核心函数 ============

    /**
     * @notice 从用户 Vault 收取盖茨费并自动分配
     * @dev 只有 trader 或 owner 可以调用
     * @param userVault 用户 Vault 地址（需要已 approve USDT 给本合约）
     * @param pnlAmount 盈利金额（USDT, 18位小数）
     */
    function collectFee(address userVault, uint256 pnlAmount) external onlyTraderOrOwner nonReentrant whenNotPaused {
        require(userVault != address(0), "Invalid vault");
        require(pnlAmount > 0, "No profit");
        require(approvedVaults[userVault], "Vault not approved");

        IERC20 usdt = IERC20(USDT);

        // 计算盖茨费 = 盈利 × 30%
        uint256 totalFee = (pnlAmount * GATES_FEE_BPS) / 10000;
        if (totalFee == 0) return;

        // 上限检查
        if (totalFee > maxFeePerTrade) {
            totalFee = maxFeePerTrade;
        }

        // 检查 Vault 余额
        uint256 vaultBalance = usdt.balanceOf(userVault);
        if (vaultBalance < totalFee) {
            // 余额不足，收取全部可用余额
            totalFee = vaultBalance;
        }
        if (totalFee == 0) return;

        // 分配比例
        uint256 platformFee = (totalFee * PLATFORM_FEE_BPS) / 3000;  // 2/3 of fee = 20% of profit
        uint256 ecoFund = totalFee - platformFee;                     // 1/3 of fee = 10% of profit

        // 从 Vault transferFrom USDT
        usdt.safeTransferFrom(userVault, address(this), totalFee);

        // 立即转入两个钱包
        if (platformFee > 0) {
            usdt.safeTransfer(platformWallet, platformFee);
        }
        if (ecoFund > 0) {
            usdt.safeTransfer(ecoFundWallet, ecoFund);
        }

        // 更新统计
        totalCollected += totalFee;
        totalPlatformFee += platformFee;
        totalEcoFund += ecoFund;
        totalTrades++;

        // 更新用户记录
        address userAddr = userVault; // 简化，用 vault 地址标识
        if (!users[userAddr].exists) {
            users[userAddr] = UserRecord(true, totalFee, block.timestamp);
        } else {
            users[userAddr].totalPaid += totalFee;
            users[userAddr].lastCollection = block.timestamp;
        }

        // 记录
        feeRecords.push(FeeRecord({
            user: userAddr,
            vault: userVault,
            grossAmount: totalFee,
            platformFee: platformFee,
            ecoFund: ecoFund,
            timestamp: block.timestamp
        }));

        emit FeeCollected(userAddr, userVault, totalFee, platformFee, ecoFund, block.timestamp);
    }

    /**
     * @notice 注册用户
     */
    function registerUser(address user) external onlyTraderOrOwner {
        if (!users[user].exists) {
            users[user] = UserRecord(true, 0, 0);
            emit UserRegistered(user, block.timestamp);
        }
    }

    /**
     * @notice 授权 Vault 可被扣费（由 Factory 调用或 owner 手动）
     */
    function approveVault(address vault, bool approved) external onlyTraderOrOwner {
        approvedVaults[vault] = approved;
        emit VaultApproved(vault, approved);
    }

    /**
     * @notice 批量授权 Vault
     */
    function approveVaults(address[] calldata vaults, bool approved) external onlyTraderOrOwner {
        for (uint256 i = 0; i < vaults.length; i++) {
            approvedVaults[vaults[i]] = approved;
            emit VaultApproved(vaults[i], approved);
        }
    }

    // ============ 管理函数 ============

    function setTrader(address _trader) external onlyOwner {
        require(_trader != address(0), "Invalid trader");
        trader = _trader;
        emit TraderUpdated(_trader);
    }

    function updateWallets(address _platformWallet, address _ecoFundWallet) external onlyOwner {
        require(_platformWallet != address(0), "Invalid platform");
        require(_ecoFundWallet != address(0), "Invalid eco fund");
        platformWallet = _platformWallet;
        ecoFundWallet = _ecoFundWallet;
        emit WalletsUpdated(_platformWallet, _ecoFundWallet);
    }

    function setMaxFeePerTrade(uint256 _max) external onlyOwner {
        maxFeePerTrade = _max;
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /**
     * @notice 紧急提取合约中误转的 USDT
     */
    function emergencyWithdrawUSDT(address to) external onlyOwner {
        require(to != address(0), "Invalid address");
        IERC20 usdt = IERC20(USDT);
        uint256 balance = usdt.balanceOf(address(this));
        if (balance > 0) {
            usdt.safeTransfer(to, balance);
        }
    }

    // ============ 查询函数 ============

    function getFeeRecord(uint256 index) external view returns (FeeRecord memory) {
        require(index < feeRecords.length, "Index out of bounds");
        return feeRecords[index];
    }

    function getFeeRecordCount() external view returns (uint256) {
        return feeRecords.length;
    }

    function getUserRecord(address user) external view returns (UserRecord memory) {
        return users[user];
    }

    function getContractUSDTBalance() external view returns (uint256) {
        return IERC20(USDT).balanceOf(address(this));
    }

    receive() external payable {}
}
