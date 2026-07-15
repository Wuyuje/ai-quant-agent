// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AgentVaultFactory V3 — Vault 工厂合约（修复版）
 * 
 * 修复：
 *   1. deployVault 内部创建 AgentVaultV2，传入正确的参数
 *   2. Vault 的 owner = user（通过构造函数 Ownable(user)）
 *   3. Factory 只负责部署和记录，不拥有 Vault
 */

import "@openzeppelin/contracts/access/Ownable.sol";
import "./AgentVaultV2.sol";

contract AgentVaultFactoryV2 is Ownable {

    // ============ 状态变量 ============

    address public trader;
    address public platformFeeWallet;
    uint256 public defaultFeeBps;
    address[] public vaults;
    mapping(address => address) public userVaults;

    /// @notice RevenueDistribution 合约地址
    address public revenueDistributor;

    // ============ 事件 ============

    event VaultDeployed(address indexed user, address indexed vault, uint256 index, uint256 timestamp);
    event TraderUpdated(address indexed oldTrader, address indexed newTrader);
    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event DistributorUpdated(address newDistributor);

    // ============ 构造函数 ============

    constructor(
        address _trader,
        address _platformFeeWallet,
        uint256 _defaultFeeBps
    ) Ownable(msg.sender) {
        require(_trader != address(0), "Invalid trader");
        require(_platformFeeWallet != address(0), "Invalid fee wallet");
        require(_defaultFeeBps <= 3000, "Fee too high");

        trader = _trader;
        platformFeeWallet = _platformFeeWallet;
        defaultFeeBps = _defaultFeeBps;
    }

    /**
     * @notice 设置 RevenueDistribution 合约地址
     */
    function setRevenueDistributor(address _distributor) external onlyOwner {
        require(_distributor != address(0), "Invalid distributor");
        revenueDistributor = _distributor;
        emit DistributorUpdated(_distributor);
    }

    // ============ Vault 部署 ============

    /**
     * @notice 为用户部署 Vault
     * @dev Vault 的 owner = user（通过 AgentVaultV2 构造函数 Ownable(_userAddress)）
     */
    function deployVault(address user) external returns (address vault) {
        require(user != address(0), "Invalid user");
        require(userVaults[user] == address(0), "User already has Vault");

        AgentVaultV2 v = new AgentVaultV2(
            user,           // owner = 用户
            trader,         // 平台执行器
            platformFeeWallet, // 平台费钱包
            defaultFeeBps   // 费率
        );
        vault = address(v);

        // 如果设置了 RevenueDistribution，自动配置到新 Vault
        if (revenueDistributor != address(0)) {
            v.setRevenueDistributor(revenueDistributor);
        }

        userVaults[user] = vault;
        vaults.push(vault);

        emit VaultDeployed(user, vault, vaults.length - 1, block.timestamp);
    }

    // ============ 管理函数 ============

    function setTrader(address _trader) external onlyOwner {
        require(_trader != address(0), "Invalid trader");
        address old = trader;
        trader = _trader;
        emit TraderUpdated(old, _trader);
    }

    function setFee(uint256 _feeBps) external onlyOwner {
        require(_feeBps <= 3000, "Fee too high");
        uint256 old = defaultFeeBps;
        defaultFeeBps = _feeBps;
        emit FeeUpdated(old, _feeBps);
    }

    // ============ 查询函数 ============

    function getVault(address user) external view returns (address) {
        return userVaults[user];
    }

    function getVaultCount() external view returns (uint256) {
        return vaults.length;
    }

    function getAllVaults() external view returns (address[] memory) {
        return vaults;
    }

    function getVaultInfo(address user) external view returns (
        address vault,
        uint256 usdtBalance,
        uint256 bnbBalance,
        int256 totalPnl,
        uint256 totalTrades,
        uint256 totalFees,
        bool paused
    ) {
        vault = userVaults[user];
        if (vault == address(0)) return (address(0), 0, 0, 0, 0, 0, false);

        AgentVaultV2 v = AgentVaultV2(payable(vault));
        usdtBalance = v.getUSDTBalance();
        bnbBalance = v.getBNBBalance();
        totalPnl = v.totalPnl();
        totalTrades = v.getTradeCount();
        totalFees = v.totalFeesCollected();
        paused = v.isPaused();
    }
}
