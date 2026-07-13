// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AI Quant Agent Revenue Distribution Contract
 * @notice 链上收益分配，自动 70/20/10 分配
 * @dev 部署在 BSC，所有交易透明可验证
 * 
 * 分配规则：
 *   用户收益 70% → 用户钱包
 *   平台提成 20% → 平台钱包
 *   生态基金 10% → 生态基金钱包
 * 
 * 特性：
 *   - Owner（你）可以更新分配比例（有上限约束）
 *   - Owner 可以暂停合约
 *   - 用户可以查询自己的收益记录
 *   - 所有分配事件上链，完全透明
 */

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract RevenueDistribution is Ownable, Pausable, ReentrancyGuard {
    
    // ============ 状态变量 ============
    
    address public platformWallet;
    address public ecoFundWallet;
    
    // 分配比例（基点，1bp = 0.01%）
    uint256 public userShareBps = 7000;    // 70%
    uint256 public platformFeeBps = 2000;  // 20%
    uint256 public ecoFundBps = 1000;      // 10%
    
    // 平台月费
    uint256 public monthlyFeeUsd = 2990;   // $29.90 (2位小数)
    
    // 用户记录: userId → { wallet, totalEarned, totalFee, lastDistribution, subscription }
    struct UserRecord {
        address wallet;
        uint256 totalEarned;      // 总收益 (USDT)
        uint256 totalFee;         // 总支付的平台费
        uint256 lastDistribution; // 最后一次分配时间
        uint8  subscription;      // 0=free, 1=basic, 2=pro
        bool   exists;
    }
    
    mapping(uint256 => UserRecord) public users;  // userId => UserRecord
    
    // 收益记录: recordIndex => { userId, amount, distribution, timestamp }
    struct RevenueRecord {
        uint256 userId;
        uint256 pnlAmount;
        uint256 userShare;
        uint256 platformFee;
        uint256 ecoFund;
        uint256 timestamp;
    }
    
    RevenueRecord[] public revenueRecords;
    
    // 统计
    uint256 public totalDistributed;
    uint256 public totalPlatformFees;
    uint256 public totalEcoFund;
    uint256 public totalTrades;
    
    // ============ 事件 ============
    
    event UserRegistered(uint256 indexed userId, address wallet, uint8 subscription);
    event RevenueDistributed(
        uint256 indexed userId,
        uint256 pnlAmount,
        uint256 userShare,
        uint256 platformFee,
        uint256 ecoFund,
        uint256 timestamp
    );
    event WalletUpdated(uint256 indexed userId, address newWallet);
    event SubscriptionUpdated(uint256 indexed userId, uint8 newSubscription);
    event AllocationUpdated(uint256 userBps, uint256 platformBps, uint256 ecoBps);
    
    // ============ 修饰器 ============
    
    modifier onlyPlatform() {
        require(msg.sender == platformWallet || msg.sender == owner(), "Not authorized");
        _;
    }
    
    // ============ 构造函数 ============
    
    constructor(address _platformWallet, address _ecoFundWallet) Ownable(msg.sender) {
        require(_platformWallet != address(0), "Invalid platform wallet");
        require(_ecoFundWallet != address(0), "Invalid eco fund wallet");
        platformWallet = _platformWallet;
        ecoFundWallet = _ecoFundWallet;
    }
    
    // ============ 核心函数 ============
    
    /**
     * @notice 分配收益（由后端 Oracle 调用）
     * @param userId 用户ID
     * @param pnlAmount 盈亏金额（正=盈利，负=亏损）
     */
    function distribute(uint256 userId, int256 pnlAmount) external onlyPlatform whenNotPaused {
        require(pnlAmount > 0, "Only distribute on profit");
        require(users[userId].exists, "User not registered");
        
        uint256 amount = uint256(pnlAmount);
        
        // 计算分配
        uint256 userShare = (amount * userShareBps) / 10000;
        uint256 platformFee = (amount * platformFeeBps) / 10000;
        uint256 ecoFund = (amount * ecoFundBps) / 10000;
        
        // 转账 USDT 到各自钱包
        // 注意：实际部署时需要集成 USDT 合约的 transfer
        // 这里用 BNB 作为示例，生产环境改为 USDT
        
        UserRecord storage user = users[userId];
        user.totalEarned += userShare;
        user.totalFee += platformFee;
        user.lastDistribution = block.timestamp;
        
        totalDistributed += userShare;
        totalPlatformFees += platformFee;
        totalEcoFund += ecoFund;
        totalTrades++;
        
        // 记录
        revenueRecords.push(RevenueRecord({
            userId: userId,
            pnlAmount: amount,
            userShare: userShare,
            platformFee: platformFee,
            ecoFund: ecoFund,
            timestamp: block.timestamp
        }));
        
        emit RevenueDistributed(userId, amount, userShare, platformFee, ecoFund, block.timestamp);
    }
    
    /**
     * @notice 注册用户
     */
    function registerUser(uint256 userId, address wallet, uint8 subscription) external onlyPlatform {
        require(!users[userId].exists, "User already registered");
        require(wallet != address(0), "Invalid wallet");
        
        users[userId] = UserRecord({
            wallet: wallet,
            totalEarned: 0,
            totalFee: 0,
            lastDistribution: 0,
            subscription: subscription,
            exists: true
        });
        
        emit UserRegistered(userId, wallet, subscription);
    }
    
    /**
     * @notice 更新用户钱包地址
     */
    function updateWallet(uint256 userId, address newWallet) external {
        require(users[userId].exists, "User not registered");
        // 只有 owner 或用户本人可以修改
        // 简化：只允许 owner（生产环境用签名验证）
        require(msg.sender == owner(), "Only owner");
        require(newWallet != address(0), "Invalid wallet");
        
        users[userId].wallet = newWallet;
        emit WalletUpdated(userId, newWallet);
    }
    
    /**
     * @notice 提现用户收益
     */
    function withdrawEarnings(uint256 userId) external nonReentrant {
        UserRecord storage user = users[userId];
        require(user.exists, "User not registered");
        require(user.totalEarned > 0, "No earnings");
        
        uint256 amount = user.totalEarned;
        user.totalEarned = 0;
        
        // 转账 USDT 到用户钱包
        // payable(user.wallet).transfer(amount); // BNB
        // 生产环境：IERC20(USDT).transfer(user.wallet, amount);
        
        emit RevenueDistributed(userId, 0, amount, 0, 0, block.timestamp);
    }
    
    // ============ 管理函数 ============
    
    /**
     * @notice 更新分配比例
     * @dev 三个比例之和必须等于 10000 (100%)
     * @dev 单项上限：平台费 ≤ 30%，生态基金 ≤ 20%
     */
    function updateAllocation(uint256 _userBps, uint256 _platformBps, uint256 _ecoBps) external onlyOwner {
        require(_userBps + _platformBps + _ecoBps == 10000, "Must sum to 100%");
        require(_platformBps <= 3000, "Platform fee max 30%");
        require(_ecoBps <= 2000, "Eco fund max 20%");
        
        userShareBps = _userBps;
        platformFeeBps = _platformBps;
        ecoFundBps = _ecoBps;
        
        emit AllocationUpdated(_userBps, _platformBps, _ecoBps);
    }
    
    /**
     * @notice 更新平台钱包
     */
    function updatePlatformWallet(address _newWallet) external onlyOwner {
        require(_newWallet != address(0), "Invalid wallet");
        platformWallet = _newWallet;
    }
    
    /**
     * @notice 更新生态基金钱包
     */
    function updateEcoFundWallet(address _newWallet) external onlyOwner {
        require(_newWallet != address(0), "Invalid wallet");
        ecoFundWallet = _newWallet;
    }
    
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
    
    // ============ 查询函数 ============
    
    function getUserRecord(uint256 userId) external view returns (UserRecord memory) {
        require(users[userId].exists, "User not registered");
        return users[userId];
    }
    
    function getUserEarnings(uint256 userId) external view returns (uint256) {
        return users[userId].totalEarned;
    }
    
    function getRevenueRecord(uint256 index) external view returns (RevenueRecord memory) {
        require(index < revenueRecords.length, "Index out of bounds");
        return revenueRecords[index];
    }
    
    function getRevenueCount() external view returns (uint256) {
        return revenueRecords.length;
    }
    
    /**
     * @notice 获取分配比例信息
     */
    function getAllocationInfo() external view returns (
        uint256 userPct,
        uint256 platformPct,
        uint256 ecoPct,
        address platformWalletAddr,
        address ecoFundWalletAddr
    ) {
        return (userShareBps / 100, platformFeeBps / 100, ecoFundBps / 100, platformWallet, ecoFundWallet);
    }
    
    // 接收 BNB
    receive() external payable {}
}
