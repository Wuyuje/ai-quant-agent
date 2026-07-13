/**
 * 部署 AgentVaultFactoryV2 到 BSC 主网
 * 
 * 核心改进：
 *   - deployVault() 会把 ownership 转移给用户
 *   - 用户是 Vault 的 owner → 自由入金/提现
 *   - 无 ARK 门槛限制
 *
 * 使用方法：
 *   PRIVATE_KEY=0x... node scripts/deploy-v2.js
 * 
 * 部署后更新 saas/server.js 中的 VAULT_FACTORY 地址
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const BSC_RPC = 'https://bsc-dataseed.binance.org';
const TRADER_WALLET = '0xe6DDF0771c7610dBA77eB5a07ba7771DD7F5e91e';
const PLATFORM_FEE_WALLET = '0xb6DEb31484353AdDaA5b6A105A2B758Df11bC28A';
const PLATFORM_FEE_BPS = 2000; // 20%

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error('❌ 请设置 PRIVATE_KEY 环境变量');
    console.log('用法: PRIVATE_KEY=0x... node scripts/deploy-v2.js');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(BSC_RPC);
  const wallet = new ethers.Wallet(privateKey, provider);

  console.log('═══════════════════════════════════════');
  console.log('  部署 AgentVaultFactoryV2 到 BSC');
  console.log('═══════════════════════════════════════');
  console.log('部署钱包:', wallet.address);

  const balance = await provider.getBalance(wallet.address);
  const balanceBnb = Number(balance) / 1e18;
  console.log('余额:', balanceBnb.toFixed(6), 'BNB');

  if (balanceBnb < 0.05) {
    console.error('❌ 余额不足，需要至少 0.05 BNB');
    process.exit(1);
  }

  // 加载编译产物
  const factoryArtifact = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'contracts', 'AgentVaultFactoryV2.sol', 'AgentVaultFactoryV2.json'), 'utf8')
  );

  // 部署 Factory
  console.log('\n📦 部署 AgentVaultFactoryV2...');
  const factory = new ethers.Contract(factoryArtifact.abi, factoryArtifact.bytecode, wallet);

  const deployTx = await factory.deploy(
    TRADER_WALLET,
    PLATFORM_FEE_WALLET,
    PLATFORM_FEE_BPS
  );

  console.log('⏳ 等待确认...');
  const receipt = await deployTx.waitForDeployment();
  const factoryAddress = await factory.getAddress();

  console.log('\n✅ 部署成功！');
  console.log('═══════════════════════════════════════');
  console.log('AgentVaultFactoryV2:', factoryAddress);
  console.log('部署 tx:', receipt.deploymentTransaction()?.hash);
  console.log('═══════════════════════════════════════');

  // 验证
  const trader = await factory.trader();
  const feeWallet = await factory.platformFeeWallet();
  const feeBps = await factory.defaultFeeBps();
  console.log('\n📋 验证:');
  console.log('  trader:', trader);
  console.log('  feeWallet:', feeWallet);
  console.log('  feeBps:', feeBps.toString());

  console.log('\n📝 下一步:');
  console.log('  1. 更新 saas/server.js 中的 VAULT_FACTORY:');
  console.log(`     const VAULT_FACTORY = '${factoryAddress}';`);
  console.log('  2. 重启服务: node saas/start.js');
}

main().catch(e => { console.error('❌ 部署失败:', e.message); process.exit(1); });
