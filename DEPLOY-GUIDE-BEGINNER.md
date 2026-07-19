# 🌟 零基础部署教程 — 手把手教到成功

> 这份教程是给**完全不懂代码的人**写的
> 每一步都告诉你：**打开什么、点哪里、输入什么**

---

## 🎯 你需要准备的东西

### 必须准备

| 物品 | 怎么获取 | 大概价格 |
|------|----------|----------|
| **电脑** | Windows 或 Mac 都行 | 你已经有了 |
| **MetaMask** | 浏览器插件（免费） | 免费 |
| **BNB** | 币安交易所购买 | ~$200（0.3个够用） |

### ⚠️ 重要：准备 2 个钱包

```
钱包A（有大量资金）：你的主钱包，存放大部分资产
钱包B（空的）：专门用来部署合约，只放 0.3 BNB
```

**为什么？**
- 部署合约需要暴露私钥到电脑
- 为了安全，**绝对不要用有大量资金的钱包**
- 用一个**新的空钱包**来部署

---

# 第一部分：安装工具

---

## 第1步：安装 Node.js（电脑运行程序的工具）

Node.js 是让电脑能运行合约部署程序的工具。就像播放器，合约程序是视频。

### Windows 用户

1. **打开这个网站**：
   ```
   https://nodejs.org
   ```

2. **你会看到两个按钮**，点击左边那个（LTS 版本）：
   ```
   [LTS 18.x.x]   [Current 20.x.x]
        ↑ 点这个
   ```

3. **下载完成后**，找到下载的文件（在「下载」文件夹）：
   ```
   文件名类似：node-v18.18.0-x64.msi
   ```

4. **双击运行**，然后：
   - 第一个页面：点 **Next**
   - 第二个页面：勾选 **I accept...**，点 **Next**
   - 第三个页面：直接点 **Next**（不要改任何东西）
   - 第四个页面：点 **Next**
   - 第五个页面：点 **Install**
   - 等待安装完成
   - 点 **Finish**

5. **验证安装成功**：
   - 按键盘 `Windows键 + R`
   - 输入 `cmd`，按回车
   - 在黑色窗口输入：
     ```
     node -v
     ```
   - 如果看到 `v18.x.x`，就成功了 ✅

### Mac 用户

1. **打开「终端」**：
   - 按 `Command + 空格`
   - 输入 `Terminal`
   - 按回车

2. **复制粘贴这行命令**，按回车：
   ```
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```

3. **等待安装完**（可能要几分钟），看到绿色字就成功了

4. **继续复制粘贴这行命令**：
   ```
   brew install node
   ```

5. **验证安装成功**：
   ```
   node -v
   ```
   看到 `v18.x.x` 就成功了 ✅

---

## 第2步：安装 MetaMask（管理钱包的工具）

MetaMask 是浏览器的插件，让你可以用钱包登录网站、签名交易。

1. **打开这个网站**：
   ```
   https://metamask.io
   ```

2. **点击「Download」**

3. **选择你的浏览器**（Chrome / Firefox / Brave）

4. **安装插件**：
   - Chrome 用户会跳转到 Chrome 商店
   - 点 **添加到 Chrome**
   - 确认添加

5. **设置 MetaMask**：
   - 安装完成后，浏览器右上角会出现狐狸图标
   - 点击狐狸图标
   - 点 **开始使用**
   - 选择 **我同意**（隐私政策）
   - 选择 **创建新钱包**
   - 设置密码（登录用，不是私钥）
   - 点 **创建新钱包**

6. **⚠️ 最重要的一步：备份助记词**
   - MetaMask 会给你 12 个英文单词
   - **这是你钱包的唯一备份！**
   - **用笔写在纸上！** 不要截图！不要存在电脑！
   - **不要给任何人看这 12 个词！**
   - 写完后，按顺序输入确认
   - 完成 ✅

---

## 第3步：切换到 BSC 网络

BSC（币安智能链）是我们要部署合约的网络。

1. **点击 MetaMask 狐狸图标**

2. **点击顶部的网络选择器**（可能显示「以太坊主网」）

3. **点击「添加网络」**

4. **选择「手动添加网络」**

5. **输入以下信息**：
   ```
   网络名称：BNB Smart Chain
   新 RPC URL：https://bsc-dataseed.binance.org
   链 ID：56
   货币符号：BNB
   区块浏览器 URL：https://bscscan.com
   ```

6. **点击保存**

7. **切换到这个网络**：
   - 再次点击网络选择器
   - 选择 **BNB Smart Chain**

---

# 第二部分：准备部署

---

## 第4步：创建一个新的空钱包（专门部署用）

⚠️ **这步非常重要！不要跳过！**

1. **在 MetaMask 里创建新钱包**：
   - 点击 MetaMask 右上角的圆形图标
   - 点 **创建新账户**
   - 名称输入：`部署专用`（方便识别）
   - 点 **创建**

2. **复制新钱包地址**：
   - 确保当前选中的是「部署专用」账户
   - 点击地址栏（以 0x 开头的那串字符）
   - 复制这个地址
   - **保存到记事本**，后面要用

3. **导出私钥**：
   - 点击右上角三个点 → **账户详情**
   - 点 **导出私钥**
   - 输入密码确认
   - **复制私钥**（一串很长的十六进制字符）
   - **⚠️ 这个私钥只在部署时用一次！部署完立即删除记录！**

---

## 第5步：给新钱包充值 BNB（部署 gas 费）

部署合约需要 gas 费（手续费），大约 0.2-0.3 BNB。

### 方法 A：从币安提币（推荐）

1. **登录币安**：
   - 打开 https://www.binance.com
   - 登录你的账户

2. **购买 BNB**（如果还没有）：
   - 点 **购买加密货币**
   - 选择用信用卡或 C2C
   - 购买 0.5 BNB（多准备一点）

3. **提币到 MetaMask**：
   - 点 **钱包** → **现货钱包**
   - 找到 **BNB**，点 **提现**
   - 选择 **BSC (BEP20)** 网络（⚠️ 一定要选这个！）
   - 粘贴你刚才创建的新钱包地址
   - 输入数量：0.5
   - 确认提现

4. **等待到账**：
   - 通常需要 5-10 分钟
   - 在 MetaMask 可以看到余额变化

### 方法 B：从其他钱包转账

如果你有其他钱包里有 BNB：
- 转 0.5 BNB 到新钱包地址
- 网络选择 **BSC (BEP20)**

---

# 第三部分：写代码

---

## 第6步：创建项目文件夹

现在开始配置部署环境。

### Windows 用户

1. **在桌面创建新文件夹**：
   - 右键桌面 → 新建 → 文件夹
   - 命名为 `vault-deploy`
   - 双击打开

2. **在这个文件夹里打开命令行**：
   - 在文件夹空白处，按住 `Shift` 键
   - 同时右键 → **在此处打开 PowerShell 窗口**
   - （或者选择「在终端中打开」）

3. **你应该看到类似这样的窗口**：
   ```
   PS C:\Users\你的用户名\Desktop\vault-deploy>
   ```

### Mac 用户

1. **打开终端**（Command + 空格，输入 Terminal）

2. **输入以下命令，创建文件夹**：
   ```
   mkdir ~/Desktop/vault-deploy
   cd ~/Desktop/vault-deploy
   ```

---

## 第7步：初始化项目

在刚才打开的命令行/终端里，**一行一行**输入以下命令：

### 第1行：初始化 npm
```
npm init -y
```
按回车。

你会看到：
```
Wrote to C:\Users\...\vault-deploy\package.json:
```

### 第2行：设置淘宝镜像（加速下载）
```
npm config set registry https://registry.npmmirror.com
```
按回车。

（这步让下载速度快 10 倍，因为用的是国内服务器）

### 第3行：安装 Hardhat（部署工具）
```
npm install --save-dev hardhat
```
按回车。

等待安装，可能需要 2-5 分钟。看到类似这样的就成功了：
```
added 500 packages in 10s
```

### 第4行：安装 OpenZeppelin（安全合约库）
```
npm install --save @openzeppelin/contracts
```
按回车。

### 第5行：安装 Hardhat 工具箱
```
npm install --save-dev @nomicfoundation/hardhat-toolbox
```
按回车。

---

## 第8步：初始化 Hardhat

继续在命令行输入：

```
npx hardhat init
```

然后你会看到交互式选择：

```
? What do you want to do?
```

用键盘上下箭头选择 **Create a JavaScript project**，按回车。

```
? Hardhat project root:
```

直接按回车（使用默认路径）。

```
? Do you want to add a .gitignore?
```

输入 `y`，按回车。

```
? Do you want to install this sample project's dependencies?
```

输入 `y`，按回车。

等待安装完成，你会看到：

```
✅ Project created
```

---

## 第9步：复制合约文件

现在需要把合约文件放到正确的位置。

### 方法 A：手动创建（推荐小白用）

1. **打开你刚才创建的 `vault-deploy` 文件夹**

2. **确保你看到 `contracts` 文件夹**（Hardhat 自动创建的）

3. **进入 `contracts` 文件夹**：
   - 双击打开
   - 你应该看到一个示例文件 `Greeter.sol`

4. **删除 `Greeter.sol`**（右键删除）

5. **创建 `AgentVault.sol`**：
   - 右键 → 新建 → 文本文档
   - 命名为 `AgentVault.sol`（⚠️ 注意后缀是 `.sol` 不是 `.txt`）
   - 如果 Windows 提示「改变扩展名可能导致文件不可用」，点 **是**

6. **用记事本打开 `AgentVault.sol`**：
   - 右键 → 打开方式 → 记事本

7. **复制以下全部内容**，粘贴进去：

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract AgentVault is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public trader;
    address public platformFeeWallet;
    address public userAddress;
    uint256 public platformFeeBps;
    mapping(address => bool) public approvedDexes;
    uint256 public maxSingleTradeAmount;
    uint256 public dailyTradeVolume;
    uint256 public dailyResetTimestamp;
    uint256 public dailyTradeLimit;
    uint256 public totalTrades;
    int256 public totalPnl;
    uint256 public totalFeesCollected;
    uint256 public createdAt;

    struct TradeRecord {
        uint256 id;
        address dex;
        bytes callData;
        uint256 inputAmount;
        uint256 outputAmount;
        int256 pnl;
        uint256 timestamp;
        bool success;
    }

    TradeRecord[] public trades;

    event TraderUpdated(address indexed oldTrader, address indexed newTrader);
    event DexApproved(address indexed dex, bool approved);
    event TradeExecuted(uint256 indexed tradeId, address indexed dex, uint256 inputAmount, uint256 outputAmount, int256 pnl, uint256 timestamp);
    event PlatformFeeCollected(uint256 amount, uint256 timestamp);
    event UserDeposit(address indexed token, uint256 amount, uint256 timestamp);
    event UserWithdraw(address indexed token, uint256 amount, uint256 timestamp);
    event EmergencyStop(uint256 timestamp);
    event TradeLimitsUpdated(uint256 maxSingle, uint256 dailyLimit);

    modifier onlyTrader() {
        require(msg.sender == trader || msg.sender == owner(), "Not trader");
        _;
    }

    constructor(
        address _userAddress,
        address _trader,
        address _platformFeeWallet,
        uint256 _platformFeeBps
    ) Ownable(msg.sender) {
        require(_userAddress != address(0), "Invalid user");
        require(_trader != address(0), "Invalid trader");
        require(_platformFeeWallet != address(0), "Invalid fee wallet");
        require(_platformFeeBps <= 3000, "Fee too high");

        userAddress = _userAddress;
        trader = _trader;
        platformFeeWallet = _platformFeeWallet;
        platformFeeBps = _platformFeeBps;
        createdAt = block.timestamp;

        maxSingleTradeAmount = 50000 * 1e6;
        dailyTradeLimit = 200000 * 1e6;
        dailyResetTimestamp = block.timestamp;
    }

    function depositUSDT(uint256 amount) external whenNotPaused {
        require(amount > 0, "Amount must be > 0");
        IERC20 usdt = IERC20(0x55d398326f99059fF775485246999027B3197955);
        usdt.safeTransferFrom(msg.sender, address(this), amount);
        emit UserDeposit(address(usdt), amount, block.timestamp);
    }

    function depositBNB() external payable whenNotPaused {
        require(msg.value > 0, "Amount must be > 0");
        emit UserDeposit(address(0), msg.value, block.timestamp);
    }

    function withdrawUSDT(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "Amount must be > 0");
        IERC20 usdt = IERC20(0x55d398326f99059fF775485246999027B3197955);
        uint256 balance = usdt.balanceOf(address(this));
        require(balance >= amount, "Insufficient USDT balance");
        usdt.safeTransfer(owner(), amount);
        emit UserWithdraw(address(usdt), amount, block.timestamp);
    }

    function withdrawBNB(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "Amount must be > 0");
        require(address(this).balance >= amount, "Insufficient BNB balance");
        payable(owner()).transfer(amount);
        emit UserWithdraw(address(0), amount, block.timestamp);
    }

    function withdrawAllUSDT() external onlyOwner nonReentrant {
        IERC20 usdt = IERC20(0x55d398326f99059fF775485246999027B3197955);
        uint256 balance = usdt.balanceOf(address(this));
        require(balance > 0, "No USDT to withdraw");
        usdt.safeTransfer(owner(), balance);
        emit UserWithdraw(address(usdt), balance, block.timestamp);
    }

    function withdrawAllBNB() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        require(balance > 0, "No BNB to withdraw");
        payable(owner()).transfer(balance);
        emit UserWithdraw(address(0), balance, block.timestamp);
    }

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
        uint256 balanceBefore = tokenInERC20.balanceOf(address(this));
        require(balanceBefore >= amountIn, "Insufficient input token");

        tokenInERC20.safeApprove(dex, 0);
        tokenInERC20.safeApprove(dex, amountIn);

        bytes memory callData = abi.encodeWithSignature(
            "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
            amountIn,
            minAmountOut,
            abi.encodePacked(tokenIn, tokenOut),
            address(this),
            block.timestamp + 300
        );

        (bool success, ) = dex.call{value: 0}(callData);
        require(success, "Swap failed");

        IERC20 tokenOutERC20 = IERC20(tokenOut);
        uint256 balanceAfter = tokenOutERC20.balanceOf(address(this));
        outputAmount = balanceAfter;

        tokenInERC20.safeApprove(dex, 0);

        _updateDailyVolume(amountIn);

        uint256 tradeId = trades.length;
        trades.push(TradeRecord({
            id: tradeId,
            dex: dex,
            callData: callData,
            inputAmount: amountIn,
            outputAmount: outputAmount,
            pnl: 0,
            timestamp: block.timestamp,
            success: true
        }));

        totalTrades++;

        emit TradeExecuted(tradeId, dex, amountIn, outputAmount, 0, block.timestamp);
    }

    function swapBNBForTokens(
        address tokenOut,
        uint256 minAmountOut
    ) external payable onlyTrader whenNotPaused returns (uint256 outputAmount) {
        address wbnb = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
        require(approvedDexes[msg.sender], "DEX not approved");
        require(msg.value > 0, "Must send BNB");
        require(msg.value <= maxSingleTradeAmount, "Exceeds single trade limit");

        _checkDailyLimit(msg.value);

        bytes memory callData = abi.encodeWithSignature(
            "swapExactETHForTokens(uint256,address[],address,uint256)",
            minAmountOut,
            abi.encodePacked(wbnb, tokenOut),
            address(this),
            block.timestamp + 300
        );

        (bool success, ) = msg.sender.call{value: msg.value}(callData);
        require(success, "BNB swap failed");

        IERC20 tokenOutERC20 = IERC20(tokenOut);
        outputAmount = tokenOutERC20.balanceOf(address(this));

        _updateDailyVolume(msg.value);

        uint256 tradeId = trades.length;
        trades.push(TradeRecord({
            id: tradeId,
            dex: msg.sender,
            callData: callData,
            inputAmount: msg.value,
            outputAmount: outputAmount,
            pnl: 0,
            timestamp: block.timestamp,
            success: true
        }));

        totalTrades++;
        emit TradeExecuted(tradeId, msg.sender, msg.value, outputAmount, 0, block.timestamp);
    }

    function recordPnl(int256 pnlAmount) external onlyTrader {
        totalPnl += pnlAmount;

        if (pnlAmount > 0) {
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

    function setTrader(address _trader) external onlyOwner {
        require(_trader != address(0), "Invalid trader");
        address old = trader;
        trader = _trader;
        emit TraderUpdated(old, _trader);
    }

    function setDexApproval(address dex, bool approved) external onlyOwner {
        approvedDexes[dex] = approved;
        emit DexApproved(dex, approved);
    }

    function setTradeLimits(uint256 _maxSingle, uint256 _dailyLimit) external onlyOwner {
        maxSingleTradeAmount = _maxSingle;
        dailyTradeLimit = _dailyLimit;
        emit TradeLimitsUpdated(_maxSingle, _dailyLimit);
    }

    function revokeTrader() external onlyOwner {
        address old = trader;
        trader = address(0);
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
    }

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

    receive() external payable {}
}
```

8. **保存文件**：按 `Ctrl + S`

9. **同样的方法创建 `AgentVaultFactory.sol`**：
   - 右键 → 新建 → 文本文档
   - 命名为 `AgentVaultFactory.sol`
   - 用记事本打开
   - 粘贴以下内容：

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./AgentVault.sol";

contract AgentVaultFactory is Ownable {
    address public trader;
    address public platformFeeWallet;
    uint256 public defaultFeeBps;
    address[] public vaults;
    mapping(address => address) public userVaults;
    address[] public approvedDexes;
    mapping(address => bool) public isApprovedDex;
    address public arkToken;
    uint256 public minArkBalance;

    event VaultDeployed(address indexed user, address indexed vault, uint256 index, uint256 timestamp);
    event TraderUpdated(address indexed oldTrader, address indexed newTrader);
    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event DexApproved(address indexed dex, bool approved);
    event ArkThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);

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

    function deployVault(address user) external returns (address vault) {
        require(user != address(0), "Invalid user address");
        require(userVaults[user] == address(0), "User already has a Vault");

        vault = new AgentVault(
            user,
            trader,
            platformFeeWallet,
            defaultFeeBps
        );

        userVaults[user] = vault;
        vaults.push(vault);

        emit VaultDeployed(user, vault, vaults.length - 1, block.timestamp);
    }

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

    function setArkThreshold(uint256 _minArk) external onlyOwner {
        uint256 old = minArkBalance;
        minArkBalance = _minArk;
        emit ArkThresholdUpdated(old, _minArk);
    }

    function setDexApproval(address dex, bool approved) external onlyOwner {
        isApprovedDex[dex] = approved;
        if (approved) {
            approvedDexes.push(dex);
        }
        emit DexApproved(dex, approved);
    }

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

        AgentVault v = AgentVault(vault);
        usdtBalance = v.getUSDTBalance();
        bnbBalance = v.getBNBBalance();
        totalPnl = v.totalPnl();
        totalTrades = v.getTradeCount();
        totalFees = v.totalFeesCollected();
        paused = v.isPaused();
    }

    function checkArkThreshold(address user) external view returns (bool, uint256) {
        IERC20 ark = IERC20(arkToken);
        uint256 balance = ark.balanceOf(user);
        return (balance >= minArkBalance, balance);
    }
}
```

10. **保存文件**：按 `Ctrl + S`

---

## 第10步：配置部署脚本

1. **在 `vault-deploy` 文件夹里**：
   - 右键 → 新建 → 文件夹
   - 命名为 `scripts`

2. **进入 `scripts` 文件夹**

3. **创建 `deploy.js`**：
   - 右键 → 新建 → 文本文档
   - 命名为 `deploy.js`
   - 用记事本打开
   - 粘贴以下内容（⚠️ **需要修改 2 个地方**）：

```javascript
const hre = require("hardhat");

async function main() {
  console.log("开始部署合约...\n");

  // ⚠️⚠️⚠️ 修改这里！填入你的地址！⚠️⚠️⚠️
  const TRADER = "0x你的平台机器人地址";           // ← 修改这里
  const FEE_WALLET = "0x你的平台收入钱包地址";      // ← 修改这里
  // ⚠️⚠️⚠️ 修改完毕 ⚠️⚠️⚠️

  const FEE_BPS = 2000;
  const ARK_TOKEN = "0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D";
  const MIN_ARK = hre.ethers.parseEther("100");

  console.log("1/2 部署 AgentVaultFactory...");
  const Factory = await hre.ethers.getContractFactory("AgentVaultFactory");
  const factory = await Factory.deploy(
    TRADER,
    FEE_WALLET,
    FEE_BPS,
    ARK_TOKEN,
    MIN_ARK
  );
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log("✅ AgentVaultFactory 已部署:", factoryAddress);

  console.log("2/2 设置 PancakeSwap V2 Router 为白名单...");
  const PANCAKE_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
  
  try {
    const tx = await factory.setDexApproval(PANCAKE_ROUTER, true);
    await tx.wait();
    console.log("✅ PancakeSwap V2 Router 已加入白名单");
  } catch (e) {
    console.log("⚠️ 设置白名单失败:", e.message);
  }

  console.log("\n========================================");
  console.log("🎉 部署完成！");
  console.log("========================================");
  console.log("AgentVaultFactory 地址:", factoryAddress);
  console.log("\n⚠️ 请保存这个地址！");
  console.log("========================================");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
```

4. **⚠️ 修改地址**：
   - 找到 `const TRADER = "0x你的平台机器人地址";`
   - 把 `0x你的平台机器人地址` 替换成你实际的平台机器人地址
   - 同理修改 `FEE_WALLET`

5. **保存文件**

---

## 第11步：配置 Hardhat

1. **回到 `vault-deploy` 文件夹根目录**

2. **找到 `hardhat.config.js` 文件**（Hardhat 自动创建的）

3. **用记事本打开**

4. **全部替换为以下内容**：

```javascript
require("@nomicfoundation/hardhat-toolbox");

module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  networks: {
    bsc: {
      url: "https://bsc-dataseed.binance.org",
      chainId: 56,
      accounts: [process.env.PRIVATE_KEY],
      gasPrice: 3000000000,
    },
    bscTestnet: {
      url: "https://data-seed-prebsc-1-s1.binance.org:8545",
      chainId: 97,
      accounts: [process.env.PRIVATE_KEY],
      gasPrice: 10000000000,
    }
  }
};
```

5. **保存文件**

---

## 第12步：配置私钥

1. **在 `vault-deploy` 文件夹根目录**

2. **创建 `.env` 文件**：
   - 右键 → 新建 → 文本文档
   - 命名为 `.env`（⚠️ 文件名就是 `.env`，不要有 `.txt` 后缀）
   - Windows 可能提示「必须键入文件名」，直接输入 `.env` 然后回车
   - 如果还是不行，先命名为 `env.txt`，然后重命名改为 `.env`

3. **用记事本打开 `.env`**

4. **输入以下内容**：

```
PRIVATE_KEY=你复制的私钥（去掉0x前缀）
```

例如：
```
PRIVATE_KEY=abc123def456...（你的实际私钥）
```

⚠️ **注意**：
- 不要带 `0x` 前缀
- 不要有空格
- 不要有引号

5. **保存文件**

---

## 第13步：编译合约

1. **在 `vault-deploy` 文件夹里打开命令行**：
   - Windows：按住 `Shift` + 右键 → 在此处打开 PowerShell 窗口
   - Mac：打开终端，`cd ~/Desktop/vault-deploy`

2. **输入以下命令**：

```
npx hardhat compile
```

3. **等待编译**（可能需要 1-2 分钟）

4. **看到以下输出就是成功**：
```
Compiled N Solidity files successfully
```

❌ **如果报错**，检查：
- 合约文件是否在 `contracts` 文件夹里
- OpenZeppelin 是否安装成功
- 文件名是否正确（`AgentVault.sol` 和 `AgentVaultFactory.sol`）

---

# 第四部分：测试网测试

---

## 第14步：获取测试网 BNB

先在测试网（模拟环境）测试，确认没问题再部署到主网。

1. **切换 MetaMask 到 BSC 测试网**：
   - 点击 MetaMask 网络选择器
   - 如果没有测试网，点「添加网络」
   - 手动添加：
     ```
     网络名称：BSC Testnet
     RPC URL：https://data-seed-prebsc-1-s1.binance.org:8545
     Chain ID：97
     货币符号：BNB
     区块浏览器：https://testnet.bscscan.com
     ```
   - 保存并切换

2. **获取测试 BNB**：
   - 打开这个网站：https://testnet.bnbchain.org/faucet-smart
   - 连接 MetaMask（点「Connect Wallet」）
   - 输入你的钱包地址
   - 点「Give me BNB」
   - 等 1-2 分钟，测试 BNB 会到账

---

## 第15步：部署到测试网

1. **在命令行输入**：

```
npx hardhat run scripts/deploy.js --network bscTestnet
```

2. **等待部署**（可能需要 1-2 分钟）

3. **看到以下输出就是成功**：

```
开始部署合约...

1/2 部署 AgentVaultFactory...
✅ AgentVaultFactory 已部署: 0x1234...
2/2 设置 PancakeSwap V2 Router 为白名单...
✅ PancakeSwap V2 Router 已加入白名单

========================================
🎉 部署完成！
========================================
AgentVaultFactory 地址: 0x1234...

⚠️ 请保存这个地址！
========================================
```

4. **⚠️ 保存合约地址**！复制下来，后面要用

---

## 第16步：验证测试网部署

1. **打开测试网浏览器**：
   ```
   https://testnet.bscscan.com
   ```

2. **搜索你的合约地址**（刚才保存的）

3. **你应该能看到合约信息**：
   - Contract 标签显示 ✅
   - 可以看到交易记录

---

# 第五部分：主网部署

---

## 第17步：准备主网部署

⚠️ **确认测试网测试通过后，再执行这步！**

1. **切换 MetaMask 到 BSC 主网**：
   - 点击网络选择器
   - 选择 **BNB Smart Chain**

2. **确保钱包里有 ~0.5 BNB**（部署 gas 费）

---

## 第18步：部署到主网

1. **在命令行输入**：

```
npx hardhat run scripts/deploy.js --network bsc
```

2. **MetaMask 会弹出确认窗口**：
   - 会显示 gas 费（大约 $50-100）
   - 检查无误后，点 **确认**

3. **等待部署完成**（1-5 分钟）

4. **看到成功输出**：

```
🎉 部署完成！
AgentVaultFactory 地址: 0xAbCdEf...
```

5. **⚠️ 保存合约地址**！

---

## 第19步：验证合约（可选但推荐）

验证后，BscScan 上会显示合约源码和读写函数，用户更信任。

1. **获取 BscScan API Key**：
   - 打开 https://bscscan.com/myapikey
   - 注册/登录
   - 创建 API Key
   - 复制 Key

2. **在命令行输入**：

```
npx hardhat verify --network bsc 0x你的合约地址 "0xTRADER" "0xFEE_WALLET" 2000 "0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D" "100000000000000000000"
```

3. **替换实际值**：
   - `0x你的合约地址` → 你刚才部署的 Factory 地址
   - `0xTRADER` → 你的平台机器人地址
   - `0xFEE_WALLET` → 你的收入钱包地址

4. **等待验证**（1-2 分钟）

5. **验证成功**后，打开 BscScan 查看合约：
   - 会显示 ✅ 绿色勾
   - 可以看到所有函数
   - 可以直接调用

---

# 第六部分：配置平台

---

## 第20步：配置平台后端

1. **打开 `ai-quant-agent/saas/server.js`**

2. **找到配置区域**（通常在文件开头）：

```javascript
const config = {
  VAULT_FACTORY: '0x你的Factory合约地址',
  PLATFORM_PRIVATE_KEY: '0x你的机器人私钥',
  PLATFORM_FEE_WALLET: '0x你的收入钱包地址',
};
```

3. **填入实际值**：
   - `VAULT_FACTORY`：刚才部署得到的合约地址
   - `PLATFORM_PRIVATE_KEY`：平台机器人的私钥
   - `PLATFORM_FEE_WALLET`：和算力 Token接收地址一致

4. **保存文件**

---

## 第21步：启动平台

1. **在命令行输入**：

```
node saas/start.js
```

2. **如果看到类似输出**：

```
SaaS 服务器启动: http://0.0.0.0:10001
```

就成功了 ✅

---

# 🎉 恭喜！部署完成！

---

## 完整流程检查清单

- [ ] ✅ 安装 Node.js
- [ ] ✅ 安装 MetaMask
- [ ] ✅ 创建新的空钱包（部署专用）
- [ ] ✅ 给新钱包充值 BNB
- [ ] ✅ 创建项目文件夹
- [ ] ✅ 初始化 npm
- [ ] ✅ 安装 Hardhat + OpenZeppelin
- [ ] ✅ 复制合约文件
- [ ] ✅ 配置部署脚本
- [ ] ✅ 配置 hardhat.config.js
- [ ] ✅ 配置 .env（私钥）
- [ ] ✅ 编译合约
- [ ] ✅ 测试网部署
- [ ] ✅ 测试网验证
- [ ] ✅ 主网部署
- [ ] ✅ 主网验证（可选）
- [ ] ✅ 配置平台后端
- [ ] ✅ 启动平台

---

## ⚠️ 安全提醒

1. **私钥安全**：
   - 部署完成后，删除 `.env` 文件或删除里面的私钥
   - 不要把私钥给任何人
   - 不要存在联网的地方

2. **合约地址安全**：
   - 保存合约地址到安全的地方
   - 这是你的平台的核心资产

3. **后续操作**：
   - 平台运行后，监控合约交易
   - 定期检查 gas 费和交易记录

---

## ❓ 常见问题

### Q: 编译报错 "cannot find module"
**A:** 重新安装依赖：
```
npm install
```

### Q: 部署报错 "insufficient funds"
**A:** 钱包里 BNB 不够，需要至少 0.5 BNB

### Q: MetaMask 弹窗没反应
**A:** 
- 刷新页面
- 重新连接 MetaMask
- 检查网络是否正确

### Q: 部署成功但 BscScan 上看不到
**A:** 
- 等 2-3 分钟让区块确认
- 手动执行验证步骤

### Q: 私钥泄露了
**A:** 立即：
1. 把钱包所有资产转移到新钱包
2. 重新部署合约
3. 更新平台配置

---

需要帮助？告诉我：
1. 你在哪一步
2. 看到什么错误信息
3. 截图给我看
