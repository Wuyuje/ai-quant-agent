/**
 * ═══════════════════════════════════════════════════════════════
 *  AI Quant Agent — 一键上链部署脚本
 *  7月17日 BSC 主网部署
 * ═══════════════════════════════════════════════════════════════
 *
 *  执行流程：
 *    1. 检查部署者钱包余额
 *    2. 部署 AgentVaultFactoryV2（新版本，含 RevenueDistribution 集成）
 *    3. 部署 RevenueDistribution（自愿打赏费自动分配合约）
 *    4. Factory.setRevenueDistributor(revenueAddr) 关联两个合约
 *    5. RevenueDistribution.approveVaults() 授权所有用户 Vault
 *    6. 为所有没有 Vault 的用户 deployVault
 *    7. 更新 server.js 和 bb-strategy-manager.js 中的合约地址
 *    8. 保存完整部署记录
 *
 *  使用方法：
 *    cd /app/workspace/ai-quant-agent
 *    node scripts/deploy-all.js
 *
 *  前提：
 *    .env 中有 TRADER_PRIVATE_KEY
 *    已执行 npx hardhat compile
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// ============ 常量配置 ============

const BSC_RPC = 'https://bsc-rpc.publicnode.com';
const CHAIN_ID = 56;

// 钱包地址（从系统现有配置中确认）
const TRADER_WALLET     = '0xe6DDF0771c7610dBA77eB5a07ba7771DD7F5e91e';  // 平台执行器
const PLATFORM_WALLET   = '0xb6DEb31484353AdDaA5b6A105A2B758Df11bC28A';  // 服务费 20%
const ECO_FUND_WALLET   = '0xeF87e7fD5f0ADC5de82e84Dc9300002D9aC8bD82';  // 生态费 10%
const PLATFORM_FEE_BPS  = 2000;  // 20%
const USDT_ADDRESS      = '0x55d398326f99059fF775485246999027B3197955';

// 文件路径
const ROOT = path.join(__dirname, '..');
const ARTIFACTS_DIR = path.join(ROOT, 'artifacts', 'contracts');
const DATA_DIR = path.join(ROOT, 'data');
const SERVER_JS = path.join(ROOT, 'saas', 'server.js');
const BB_MANAGER_JS = path.join(ROOT, 'saas', 'bb-strategy-manager.js');
const CEX_TRADER_JS = path.join(ROOT, 'saas', 'cex-user-trader.js');
const USERS_JSON = path.join(DATA_DIR, 'saas-users.json');

// ============ 工具函数 ============

function log(msg) { console.log(`  ${msg}`); }
function step(n, msg) { console.log(`\n══════ ${n}. ${msg} ══════`); }
function success(msg) { console.log(`  ✅ ${msg}`); }
function fail(msg) { console.error(`  ❌ ${msg}`); }

function loadArtifact(name) {
  const p = path.join(ARTIFACTS_DIR, `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(p)) throw new Error(`合约产物不存在: ${p}，请先运行 npx hardhat compile`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============ 主流程 ============

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   AI Quant Agent — BSC 主网一键部署             ║');
  console.log('║   7月17日上链                                    ║');
  console.log('╚══════════════════════════════════════════════════╝');

  // ─── 加载私钥 ───
  const dotenv = require('dotenv');
  dotenv.config({ path: path.join(ROOT, '.env') });

  const privateKey = process.env.TRADER_PRIVATE_KEY;
  if (!privateKey) {
    fail('TRADER_PRIVATE_KEY 未设置，请检查 .env 文件');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(BSC_RPC);
  const wallet = new ethers.Wallet(privateKey, provider);

  console.log('\n部署者/Trader:', wallet.address);
  console.log('网络: BSC Mainnet (Chain ID: 56)');

  const balance = await provider.getBalance(wallet.address);
  const bnbBalance = Number(balance) / 1e18;
  console.log('BNB 余额:', bnbBalance.toFixed(6));

  if (bnbBalance < 0.05) {
    fail('BNB 余额不足，需要至少 0.05 BNB 用于部署 gas');
    fail(`当前余额: ${bnbBalance} BNB`);
    process.exit(1);
  }

  // ─── 加载编译产物 ───
  step('0', '加载编译产物');
  const factoryArt = loadArtifact('AgentVaultFactoryV2');
  const vaultArt = loadArtifact('AgentVaultV2');
  const revenueArt = loadArtifact('RevenueDistribution');
  success(`Factory: ${factoryArt.abi.length} ABI entries, ${factoryArt.bytecode.length} bytes`);
  success(`Vault: ${vaultArt.abi.length} ABI entries, ${vaultArt.bytecode.length} bytes`);
  success(`Revenue: ${revenueArt.abi.length} ABI entries, ${revenueArt.bytecode.length} bytes`);

  // ─── 加载用户数据 ───
  step('1', '加载用户数据');
  const users = JSON.parse(fs.readFileSync(USERS_JSON, 'utf8'));
  const userAddrs = Object.keys(users);
  log(`共 ${userAddrs.length} 个用户`);

  const usersNeedingVault = [];
  const existingVaults = [];
  for (const addr of userAddrs) {
    const u = users[addr];
    const vault = u.vaultAddress || '';
    if (vault && vault !== '0x0000000000000000000000000000000000000000') {
      existingVaults.push({ user: addr, vault });
      log(`  ${addr.slice(0,10)}... 已有 Vault: ${vault.slice(0,10)}...`);
    } else {
      usersNeedingVault.push(addr);
      log(`  ${addr.slice(0,10)}... 需要部署 Vault`);
    }
  }
  log(`已有 Vault: ${existingVaults.length}，待部署: ${usersNeedingVault.length}`);

  // ═══════════════════════════════════════
  //  2. 部署 AgentVaultFactoryV2
  // ═══════════════════════════════════════
  step('2', '部署 AgentVaultFactoryV2');

  const factoryFactory = new ethers.ContractFactory(factoryArt.abi, factoryArt.bytecode, wallet);
  log('发送部署交易...');
  const factory = await factoryFactory.deploy(TRADER_WALLET, PLATFORM_WALLET, PLATFORM_FEE_BPS, {
    gasPrice: ethers.parseUnits('3', 'gwei'),
    gasLimit: 5000000,
  });
  log(`tx: ${factory.deploymentTransaction().hash}`);
  log('等待确认...');
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  success(`Factory 已部署: ${factoryAddress}`);

  // 验证
  const fTrader = await factory.trader();
  const fFeeWallet = await factory.platformFeeWallet();
  const fFeeBps = await factory.defaultFeeBps();
  log(`验证: trader=${fTrader}, feeWallet=${fFeeWallet}, feeBps=${fFeeBps}`);
  if (fTrader.toLowerCase() !== TRADER_WALLET.toLowerCase()) {
    fail('Trader 地址不匹配！');
    process.exit(1);
  }
  success('Factory 验证通过');

  // ═══════════════════════════════════════
  //  3. 部署 RevenueDistribution
  // ═══════════════════════════════════════
  step('3', '部署 RevenueDistribution');

  const revenueFactory = new ethers.ContractFactory(revenueArt.abi, revenueArt.bytecode, wallet);
  log('发送部署交易...');
  const revenue = await revenueFactory.deploy(TRADER_WALLET, PLATFORM_WALLET, ECO_FUND_WALLET, {
    gasPrice: ethers.parseUnits('3', 'gwei'),
    gasLimit: 5000000,
  });
  log(`tx: ${revenue.deploymentTransaction().hash}`);
  log('等待确认...');
  await revenue.waitForDeployment();
  const revenueAddress = await revenue.getAddress();
  success(`RevenueDistribution 已部署: ${revenueAddress}`);

  // 验证
  const rTrader = await revenue.trader();
  const rPlatform = await revenue.platformWallet();
  const rEcoFund = await revenue.ecoFundWallet();
  log(`验证: trader=${rTrader}, platform=${rPlatform}, ecoFund=${rEcoFund}`);
  if (rPlatform.toLowerCase() !== PLATFORM_WALLET.toLowerCase() || rEcoFund.toLowerCase() !== ECO_FUND_WALLET.toLowerCase()) {
    fail('钱包地址不匹配！');
    process.exit(1);
  }
  success('RevenueDistribution 验证通过');

  // ═══════════════════════════════════════
  //  4. 关联 Factory ↔ RevenueDistribution
  // ═══════════════════════════════════════
  step('4', '关联 Factory ↔ RevenueDistribution');

  log('Factory.setRevenueDistributor()...');
  const tx1 = await factory.setRevenueDistributor(revenueAddress, {
    gasPrice: ethers.parseUnits('3', 'gwei'),
    gasLimit: 100000,
  });
  await tx1.wait();
  success('Factory 已关联 RevenueDistribution');

  // ═══════════════════════════════════════
  //  5. 为所有用户部署 Vault
  // ═══════════════════════════════════════
  step('5', `为 ${usersNeedingVault.length} 个用户部署 Vault`);

  const deployedVaults = [];
  const allVaults = [...existingVaults];

  for (let i = 0; i < usersNeedingVault.length; i++) {
    const userAddr = usersNeedingVault[i];
    log(`[${i+1}/${usersNeedingVault.length}] 为 ${userAddr.slice(0,10)}... 部署 Vault`);

    try {
      const tx = await factory.deployVault(userAddr, {
        gasPrice: ethers.parseUnits('3', 'gwei'),
        gasLimit: 3000000,
      });
      const receipt = await tx.wait();
      const vaultAddr = await factory.getVault(userAddr);
      success(`Vault: ${vaultAddr} (tx: ${tx.hash.slice(0,16)}...)`);

      deployedVaults.push({ user: userAddr, vault: vaultAddr });
      allVaults.push({ user: userAddr, vault: vaultAddr });

      // 更新用户数据
      users[userAddr].vaultAddress = vaultAddr;

      // 等待 2 秒避免 nonce 冲突
      await delay(2000);
    } catch (e) {
      fail(`部署失败: ${e.message.slice(0, 100)}`);
    }
  }

  // 保存更新后的用户数据
  fs.writeFileSync(USERS_JSON, JSON.stringify(users, null, 2));
  success('用户数据已更新');

  // ═══════════════════════════════════════
  //  6. 在 RevenueDistribution 中授权所有 Vault
  // ═══════════════════════════════════════
  step('6', '授权所有 Vault 可被 RevenueDistribution 扣费');

  const vaultAddrs = allVaults.map(v => v.vault);
  if (vaultAddrs.length > 0) {
    log(`授权 ${vaultAddrs.length} 个 Vault...`);
    const tx = await revenue.approveVaults(vaultAddrs, true, {
      gasPrice: ethers.parseUnits('3', 'gwei'),
      gasLimit: 500000,
    });
    await tx.wait();
    success(`已授权 ${vaultAddrs.length} 个 Vault`);
  }

  // ═══════════════════════════════════════
  //  7. 更新 server.js 中的合约地址
  // ═══════════════════════════════════════
  step('7', '更新后端配置');

  // 更新 server.js
  if (fs.existsSync(SERVER_JS)) {
    let serverCode = fs.readFileSync(SERVER_JS, 'utf8');

    // 更新 VAULT_FACTORY 地址
    serverCode = serverCode.replace(
      /const VAULT_FACTORY = process\.env\.VAULT_FACTORY_ADDRESS \|\| '0x[0-9a-fA-F]{40}';/,
      `const VAULT_FACTORY = process.env.VAULT_FACTORY_ADDRESS || '${factoryAddress}';`
    );

    // 添加 REVENUE_DISTRIBUTION 常量（如果不存在）
    if (!serverCode.includes('REVENUE_DISTRIBUTION')) {
      serverCode = serverCode.replace(
        /const VAULT_FACTORY = ([^;]+);/,
        `const VAULT_FACTORY = $1;\nconst REVENUE_DISTRIBUTION = process.env.REVENUE_DISTRIBUTION_ADDRESS || '${revenueAddress}';`
      );
    } else {
      serverCode = serverCode.replace(
        /const REVENUE_DISTRIBUTION = process\.env\.REVENUE_DISTRIBUTION_ADDRESS \|\| '0x[0-9a-fA-F]{40}';/,
        `const REVENUE_DISTRIBUTION = process.env.REVENUE_DISTRIBUTION_ADDRESS || '${revenueAddress}';`
      );
    }

    fs.writeFileSync(SERVER_JS, serverCode);
    success(`server.js 已更新: VAULT_FACTORY=${factoryAddress}, REVENUE_DISTRIBUTION=${revenueAddress}`);
  }

  // ═══════════════════════════════════════
  //  8. 保存部署记录
  // ═══════════════════════════════════════
  step('8', '保存部署记录');

  const deploymentRecord = {
    deployedAt: new Date().toISOString(),
    network: 'bsc',
    chainId: CHAIN_ID,
    deployer: wallet.address,

    contracts: {
      AgentVaultFactoryV2: {
        address: factoryAddress,
        abi: factoryArt.abi,
        constructorArgs: [TRADER_WALLET, PLATFORM_WALLET, PLATFORM_FEE_BPS],
      },
      RevenueDistribution: {
        address: revenueAddress,
        abi: revenueArt.abi,
        constructorArgs: [TRADER_WALLET, PLATFORM_WALLET, ECO_FUND_WALLET],
      },
      AgentVaultV2: {
        note: '按需通过 Factory.deployVault() 部署',
        abi: vaultArt.abi,
      },
    },

    wallets: {
      trader: TRADER_WALLET,
      platformWallet: PLATFORM_WALLET,
      ecoFundWallet: ECO_FUND_WALLET,
    },

    feeConfig: {
      gatesFeeBps: 3000,       // 30% 自愿打赏费
      platformFeeBps: 2000,    // 20% 服务费
      ecoFundBps: 1000,        // 10% 生态费
      userShareBps: 7000,      // 70% 用户实得
    },

    vaults: allVaults,
    newVaultsDeployed: deployedVaults,

    bscScanLinks: {
      factory: `https://bscscan.com/address/${factoryAddress}`,
      revenue: `https://bscscan.com/address/${revenueAddress}`,
    },
  };

  const recordPath = path.join(DATA_DIR, 'deployment-20250717.json');
  fs.writeFileSync(recordPath, JSON.stringify(deploymentRecord, null, 2));
  success(`部署记录已保存: ${recordPath}`);

  // ═══════════════════════════════════════
  //  完成
  // ═══════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   ✅ 部署完成！                                  ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('\n合约地址:');
  console.log(`  Factory:             ${factoryAddress}`);
  console.log(`  RevenueDistribution: ${revenueAddress}`);
  console.log(`\nBscScan:`);
  console.log(`  ${deploymentRecord.bscScanLinks.factory}`);
  console.log(`  ${deploymentRecord.bscScanLinks.revenue}`);
  console.log(`\n用户 Vault (${allVaults.length} 个):`);
  for (const v of allVaults) {
    console.log(`  ${v.user.slice(0,10)}... → ${v.vault}`);
  }
  console.log(`\n自愿打赏费分配:`);
  console.log(`  盈利 × 30% = 自愿打赏费`);
  console.log(`    20% 服务费 → ${PLATFORM_WALLET}`);
  console.log(`    10% 生态费 → ${ECO_FUND_WALLET}`);
  console.log(`    70% 用户实得`);
  console.log(`\n下一步: 在云端服务器上启动 node saas/start.js`);
}

main().catch(e => {
  console.error('\n❌ 部署失败:', e.message);
  console.error(e.stack);
  process.exit(1);
});
