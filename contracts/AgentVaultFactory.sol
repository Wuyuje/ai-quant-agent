// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AgentVaultFactory — Vault 工厂合约
 * 
 * 职责：
 *   1. 为每个用户部署一个独立的 AgentVault 合约
 *   2. 记录所有 Vault 地址
 *   3. 管理平台执行器和费率
 *   4. 提供查询接口
 *
 * 部署在 BSC 主网，用户通过 TP 钱包交互。
 */

import "@openzeppelin/contracts/access/Ownable.sol";
import "./AgentVault.sol";

contract AgentVaultFactory is Ownable {

    // ============ 状态变量 ============

    /// @notice 平台执行器地址（统一的交易机器人地址）
    address public trader;

    /// @notice 平台收入钱包
    address public platformFeeWallet;

    /// @notice 默认平台服务费（基点）
    uint256 public defaultFeeBps;

    /// @notice 已部署的 Vault 列表
    address[] public vaults;

    /// @notice 用户钱包 → Vault 地址
    mapping(address => address) public userVaults;

    /// @notice 平台已批准的 DEX 合约列表
    address[] public approvedDexes;

    /// @notice 已批准的 DEX 映射
    mapping(address => bool) public isApprovedDex;

    /// @notice ARK 代币合约（用于门槛验证）
    address public arkToken;

    /// @notice 最低 ARK 持仓
    uint256 public minArkBalance;

    // ============ 事件 ============

    event VaultDeployed(
        address indexed user,
        address indexed vault,
        uint256 index,
        uint256 timestamp
    );
    event TraderUpdated(address indexed oldTrader, address indexed newTrader);
    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event DexApproved(address indexed dex, bool approved);
    event ArkThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);

    // ============ 构造函数 ============

    constructor(
        address _trader,
        address _platformFeeWallet,
        uint256 _defaultFeeBps,
        address _arkToken,
        uint256 _minArkBalance
    ) Ownable(msg.sender) {
        require(_trader != address(0), "Invalid trader");
        require(_platformFeeWallet != address(0), "Invalid fee wallet");
        require(_defaultFeeBps <= 3000, "Fee too high");

        trader = _trader;
        platformFeeWallet = _platformFeeWallet;
        defaultFeeBps = _defaultFeeBps;
        arkToken = _arkToken;
        minArkBalance = _minArkBalance;
    }

    // ============ Vault 部署 ============

    /**
     * @notice 为新用户部署 Vault
     * @dev 任何人都可以调用（包括后端服务器），但每个用户只能有一个 Vault
     * @param user 用户钱包地址
     */
    function deployVault(address user) external returns (address vault) {
        require(user != address(0), "Invalid user address");
        require(userVaults[user] == address(0), "User already has a Vault");

        AgentVault v = new AgentVault(
            user,
            trader,
            platformFeeWallet,
            defaultFeeBps
        );
        vault = address(v);

        userVaults[user] = vault;
        vaults.push(vault);

        emit VaultDeployed(user, vault, vaults.length - 1, block.timestamp);
    }

    /**
     * @notice 批量部署 Vault
     */
    function deployVaults(address[] calldata users) external returns (address[] memory vaultAddresses) {
        vaultAddresses = new address[](users.length);
        for (uint256 i = 0; i < users.length; i++) {
            if (userVaults[users[i]] == address(0)) {
                address v = this.deployVault(users[i]);
                vaultAddresses[i] = v;
            }
        }
    }

    // ============ 管理函数 ============

    /**
     * @notice 更新平台执行器
     */
    function setTrader(address _trader) external onlyOwner {
        require(_trader != address(0), "Invalid trader");
        address old = trader;
        trader = _trader;
        emit TraderUpdated(old, _trader);
    }

    /**
     * @notice 更新平台服务费
     */
    function setFee(uint256 _feeBps) external onlyOwner {
        require(_feeBps <= 3000, "Fee too high");
        uint256 old = defaultFeeBps;
        defaultFeeBps = _feeBps;
        emit FeeUpdated(old, _feeBps);
    }

    /**
     * @notice 更新 ARK 门槛
     */
    function setArkThreshold(uint256 _minArk) external onlyOwner {
        uint256 old = minArkBalance;
        minArkBalance = _minArk;
        emit ArkThresholdUpdated(old, _minArk);
    }

    /**
     * @notice 添加/移除 DEX 白名单（会影响所有 Vault）
     */
    function setDexApproval(address dex, bool approved) external onlyOwner {
        isApprovedDex[dex] = approved;
        if (approved) {
            approvedDexes.push(dex);
        }
        emit DexApproved(dex, approved);
    }

    /**
     * @notice 更新所有 Vault 的 DEX 白名单
     * @dev 调用每个 Vault 的 setDexApproval
     */
    function syncDexApprovals(address[] calldata dexes, bool[] calldata approvals) external onlyOwner {
        require(dexes.length == approvals.length, "Length mismatch");
        for (uint256 i = 0; i < vaults.length; i++) {
            AgentVault vault = AgentVault(payable(vaults[i]));
            for (uint256 j = 0; j < dexes.length; j++) {
                try vault.setDexApproval(dexes[j], approvals[j]) {} catch {}
            }
        }
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

    /**
     * @notice 获取用户 Vault 信息
     */
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

        AgentVault v = AgentVault(payable(vault));
        usdtBalance = v.getUSDTBalance();
        bnbBalance = v.getBNBBalance();
        totalPnl = v.totalPnl();
        totalTrades = v.getTradeCount();
        totalFees = v.totalFeesCollected();
        paused = v.isPaused();
    }

    /**
     * @notice 检查用户是否满足 ARK 门槛
     */
    function checkArkThreshold(address user) external view returns (bool, uint256) {
        // 链上查 ARK 余额
        IERC20 ark = IERC20(arkToken);
        uint256 balance = ark.balanceOf(user);
        return (balance >= minArkBalance, balance);
    }
}
