# ⛓️ AgentVault 智能合约部署教程（从零开始）

> 目标：把 `AgentVaultFactory.sol` 部署到 BSC 主网，让用户的 TP 钱包可以部署自己的 Vault。

---

## 📋 部署前准备

### 你需要的东西

| 项目 | 说明 |
|------|------|
| 电脑 | Windows / Mac / Linux 都行 |
| Node.js | v16 或更高版本 |
| MetaMask | 浏览器插件（部署合约用） |
| BNB | ~0.3 BNB（部署 gas 费，约 $200） |
| BSC 主网 RPC | https://bsc-dataseed.binance.org |
| 网络 | 需要能访问 npm |

---

## 第一步：安装 Node.js（如果没有）

### Windows
1. 打开 https://nodejs.org
2. 下载 **LTS** 版本（推荐 18.x）
3. 双击安装，一路「下一步」
4. 打开 CMD，输入：
```bash
node -v
```
看到 `v18.x.x` 就成功了。

### Mac
```bash
# 安装 Homebrew（如果没有）
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 安装 Node.js
brew install node

# 验证
node -v
```

---

## 第二步：创建 Hardhat 项目

### 1. 创建项目文件夹

```bash
# 在任意位置创建
mkdir ark-vault-deploy
cd ark-vault-deploy
```

### 2. 初始化 npm

```bash
npm init -y
```

### 3. 安装 Hardhat

```bash
npm install --save-dev hardhat @nomicfoundation/hardhat-toolbox
```

如果安装超时，可以用淘宝镜像：
```bash
npm config set registry https://registry.npmmirror.com
npm install --save-dev hardhat @nomicfoundation/hardhat-toolbox
```

### 4. 初始化 Hardhat

```bash
npx hardhat init
```

选择：
```
? What do you want to do? 
  Create a JavaScript project    ← 选这个
? Hardhat project root: 
  ./ark-vault-deploy             ← 直接回车
? Do you want to add a .gitignore? 
  Yes                            ← 回车
? Do you want to install this sample project's dependencies with npm? 
  Yes                            ← 回车
```

等它装完依赖，你会看到：
```
✅ Project created
```

---

## 第三步：安装 OpenZeppelin 合约库

```bash
npm install --save @openzeppelin/contracts
```

---

## 第四步：复制合约文件

把你的合约文件放到 `contracts/` 目录下：

```
ark-vault-deploy/
  contracts/
    AgentVault.sol          ← 复制这个
    AgentVaultFactory.sol   ← 复制这个
```

### 复制方法

**方法 A：直接复制文件内容**
1. 打开 `ai-quant-agent/contracts/AgentVault.sol`
2. 全选复制
3. 在 `ark-vault-deploy/contracts/` 下创建 `AgentVault.sol`，粘贴
4. 同理复制 `AgentVaultFactory.sol`

**方法 B：用命令复制**
```bash
# 如果你的 ai-quant-agent 在本地
cp /path/to/ai-quant-agent/contracts/AgentVault.sol ./contracts/
cp /path/to/ai-quant-agent/contracts/AgentVaultFactory.sol ./contracts/
```

---

## 第五步：配置 Hardhat

### 1. 编辑 `hardhat.config.js`

```bash
# 用记事本或 VS Code 打开
code hardhat.config.js
```

替换内容为：

```javascript
require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
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
      gasPrice: 3000000000, // 3 Gwei（BSC 通常够用）
    },
    bscTestnet: {
      url: "https://data-seed-prebsc-1-s1.binance.org:8545",
      chainId: 97,
      accounts: [process.env.PRIVATE_KEY],
      gasPrice: 10000000000, // 10 Gwei
    }
  },
  etherscan: {
    apiKey: process.env.BSCSCAN_API_KEY // 可选，用于验证合约
  }
};
```

### 2. 创建 `.env` 文件（存放私钥）

```bash
# 在项目根目录创建
touch .env
```

编辑 `.env` 文件：

```env
# ⚠️ 你的 MetaMask 私钥（部署合约用的钱包）
# ⚠️ 绝对不要把有大量资金的钱包私钥放这里！
# ⚠️ 用一个专门部署合约的钱包
PRIVATE_KEY=你的私钥去掉0x前缀

# BscScan API Key（可选，用于验证合约）
BSCSCAN_API_KEY=你的api_key
```

**⚠️ 获取私钥的步骤（MetaMask）：**

1. 打开 MetaMask
2. 点击右上角 **三个点** → **账户详情**
3. 点击 **导出私钥**
4. 输入密码确认
5. 复制私钥（一串十六进制字符串）
6. 粘贴到 `.env` 文件的 `PRIVATE_KEY=` 后面
7. **不要带 0x 前缀**

**⚠️ 安全提醒：**
- 用一个**新的空钱包**来部署，不要用有大量资金的钱包
- 私钥泄露 = 钱包里所有钱没了
- `.env` 文件**不要提交到 GitHub**

### 3. 创建 `.gitignore`（防止私钥泄露）

确保项目根目录有 `.gitignore`，内容包含：

```
node_modules
.env
cache
artifacts
coverage
coverage.json
typechain-types
```

---

## 第六步：编译合约

```bash
npx hardhat compile
```

成功输出：
```
Compiled N Solidity files successfully
```

如果报错，检查：
1. 合约文件是否在 `contracts/` 目录下
2. OpenZeppelin 是否安装成功
3. Solidity 版本是否匹配（0.8.20）

---

## 第七步：写部署脚本

### 1. 创建 `scripts/deploy.js`

```bash
# 创建 scripts 目录
mkdir scripts

# 创建部署脚本
touch scripts/deploy.js
```

### 2. 编辑 `scripts/deploy.js`

**⚠️ 部署参数说明：**

| 参数 | 值 | 说明 |
|------|-----|------|
| `_trader` | `0x你的平台机器人地址` | 只有这个地址可以在 Vault 里执行交易 |
| `_platformFeeWallet` | `0x你的收入钱包地址` | 平台算力 Token收到这个钱包 |
| `_defaultFeeBps` | `2000` | 20% 算力 Token（2000 = 20.00%） |
| `_arkToken` | `0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D` | ARK 代币合约地址 |
| `_minArkBalance` | `100000000000000000000` | 100 ARK（18位小数） |

```javascript
const hre = require("hardhat");

async function main() {
  console.log("开始部署合约...");

  // ============ 部署参数 ============
  // ⚠️ 修改为你的实际地址！
  const TRADER = "0x你的平台机器人地址";           // 执行交易的机器人地址
  const FEE_WALLET = "0x你的平台收入钱包地址";      // 收算力 Token的钱包
  const FEE_BPS = 2000;                             // 20% 算力 Token
  const ARK_TOKEN = "0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D"; // ARK 代币
  const MIN_ARK = hre.ethers.parseEther("100");    // 100 ARK（18位小数）

  // ============ 1. 部署 AgentVaultFactory ============
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

  // ============ 2. 初始化 DEX 白名单 ============
  console.log("2/2 设置 PancakeSwap V2 Router 为白名单...");
  const PANCAKE_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E"; // PancakeSwap V2 Router (BSC)
  
  try {
    const tx = await factory.setDexApproval(PANCAKE_ROUTER, true);
    await tx.wait();
    console.log("✅ PancakeSwap V2 Router 已加入白名单");
  } catch (e) {
    console.log("⚠️ 设置白名单失败（可能已设置）:", e.message);
  }

  // ============ 完成 ============
  console.log("\n========================================");
  console.log("🎉 部署完成！");
  console.log("========================================");
  console.log("AgentVaultFactory 地址:", factoryAddress);
  console.log("网络: BSC Mainnet (Chain ID 56)");
  console.log("\n⚠️ 请保存这个地址，填入 saas/server.js 的 VAULT_FACTORY");
  console.log("========================================");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
```

---

## 第八步：部署到 BSC 测试网（先测试！）

**⚠️ 先在测试网测试，确认没问题再部署到主网！**

### 1. 获取测试网 BNB

1. 打开 https://testnet.bnbchain.org/faucet-smart
2. 连接 MetaMask（切换到 BSC Testnet）
3. 输入你的地址，领取测试 BNB
4. 等 1-2 分钟到账

### 2. 切换 MetaMask 到 BSC Testnet

1. MetaMask → 网络下拉 → **添加网络**
2. 手动添加：
   - 网络名称: `BNB Smart Chain Testnet`
   - RPC URL: `https://data-seed-prebsc-1-s1.binance.org:8545`
   - Chain ID: `97`
   - 货币符号: `BNB`
   - 区块浏览器: `https://testnet.bscscan.com`
3. 保存并切换

### 3. 部署到测试网

```bash
npx hardhat run scripts/deploy.js --network bscTestnet
```

成功输出：
```
1/2 部署 AgentVaultFactory...
✅ AgentVaultFactory 已部署: 0x1234...
2/2 设置 PancakeSwap V2 Router 为白名单...
✅ PancakeSwap V2 Router 已加入白名单

========================================
🎉 部署完成！
========================================
```

### 4. 验证合约（可选）

```bash
npx hardhat verify --network bscTestnet 0x你的合约地址 "0xTRADER" "0xFEE_WALLET" 2000 "0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D" "100000000000000000000"
```

### 5. 测试

1. 打开 https://testnet.bscscan.com
2. 搜索你的合约地址
3. 点击 **Contract** → **Write Contract**
4. 连接 MetaMask
5. 找到 `deployVault` 函数
6. 输入测试地址（你自己的测试网地址）
7. 点击 **Write**
8. 确认交易

如果成功，你会看到一个新 Vault 地址。

---

## 第九步：部署到 BSC 主网

**确认测试网没问题后，再执行这步！**

### 1. 切换 MetaMask 到 BSC Mainnet

1. MetaMask → 网络下拉 → **BNB Smart Chain Mainnet**（通常已预设）
2. 确认钱包里有 ~0.3 BNB

### 2. 部署到主网

```bash
npx hardhat run scripts/deploy.js --network bsc
```

### 3. 保存合约地址

部署成功后，你会看到类似：
```
AgentVaultFactory 地址: 0xAbCdEf1234567890...
```

**⚠️ 保存这个地址！后续步骤需要用到。**

### 4. 验证合约（BscScan 上显示源码）

```bash
# 安装 BscScan 插件
npm install --save-dev @nomicfoundation/hardhat-verify

# 获取 BscScan API Key
# 1. 打开 https://bscscan.com/myapikey
# 2. 注册/登录
# 3. 创建 API Key
# 4. 复制 Key

# 更新 hardhat.config.js，添加 etherscan 配置
# etherscan: { apiKey: "你的key" }

# 执行验证
npx hardhat verify --network bsc 0x你的合约地址 "0xTRADER" "0xFEE_WALLET" 2000 "0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D" "100000000000000000000"
```

验证成功后，BscScan 上会显示 ✅ 和源码。

---

## 第十步：配置平台后端

### 1. 打开 `ai-quant-agent/saas/server.js`

### 2. 找到配置区域，填入：

```javascript
const config = {
  // 你刚部署的合约地址
  VAULT_FACTORY: '0x你的AgentVaultFactory地址',
  
  // 你的平台机器人私钥（用于调用合约）
  PLATFORM_PRIVATE_KEY: '0x你的机器人私钥',
  
  // 你的平台收入钱包（和算力 Token接收地址一致）
  PLATFORM_FEE_WALLET: '0x你的收入钱包地址',
};
```

### 3. 重启平台

```bash
node saas/start.js
```

---

## 🎯 完整流程回顾

```
1. 安装 Node.js
2. 创建 Hardhat 项目
3. 安装 OpenZeppelin
4. 复制合约文件
5. 配置 hardhat.config.js
6. 配置 .env（私钥）
7. 编译合约
8. 写部署脚本
9. 测试网部署 + 测试
10. 主网部署
11. 验证合约（可选）
12. 配置平台后端
```

---

## ⚠️ 常见问题

### Q: 部署失败，报 "insufficient funds"
**A:** 钱包里 BNB 不够，需要至少 0.3 BNB。去交易所买。

### Q: 编译报错 "Source file not found"
**A:** 检查合约文件是否在 `contracts/` 目录下，OpenZeppelin 是否安装。

### Q: 部署超时
**A:** BSC 网络拥堵，稍等重试。可以手动在 MetaMask 提高 Gas Fee。

### Q: 合约验证失败
**A:** 确保部署参数完全匹配（顺序、类型、值）。检查 BscScan API Key 是否正确。

### Q: 私钥泄露了怎么办？
**A:** 立即把钱包里所有资产转移到新钱包！以后用新钱包部署。

---

## 🔒 安全清单

- [ ] 部署用的钱包是**新的空钱包**，不存放大量资金
- [ ] `.env` 文件**没有提交到 GitHub**
- [ ] 私钥**没有泄露给任何人**
- [ ] 测试网测试通过后，才部署到主网
- [ ] 合约地址已备份到安全的地方
- [ ] 平台机器人地址是**平台控制的地址**，不是用户地址

---

## 📞 需要帮助？

部署过程中遇到问题，告诉我：
1. 完整的错误信息
2. 你执行了什么命令
3. 当前在第几步

我会帮你排查。
