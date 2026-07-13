const hre = require('hardhat');

async function main() {
  console.log('🚀 开始部署 AgentVaultFactory 到 BSC 主网...\n');

  // 使用 hardhat 的 signer（从 PRIVATE_KEY 环境变量加载）
  const [deployer] = await hre.ethers.getSigners();
  console.log('✅ 部署地址:', deployer.address);

  // 验证部署地址
  const expectedAddress = '0x99146ce2c7b42b42c6e6a62aadabf2db295050e8';
  if (deployer.address.toLowerCase() !== expectedAddress.toLowerCase()) {
    console.error('❌ 部署地址不匹配！');
    console.error('   期望:', expectedAddress);
    console.error('   实际:', deployer.address);
    process.exit(1);
  }

  // 检查余额
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log('💰 账户余额:', hre.ethers.formatEther(balance), 'BNB');

  if (balance < hre.ethers.parseEther('0.01')) {
    console.error('❌ 余额不足！需要至少 0.01 BNB 用于 gas');
    process.exit(1);
  }

  // 配置参数
  const TRADER = '0x99146ce2c7b42b42c6e6a62aadabf2db295050e8';
  const FEE_WALLET = '0xb6DEb31484353AdDaA5b6A105A2B758Df11bC28A';
  const FEE_BPS = 2000;  // 20%
  const ARK_TOKEN = '0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D';
  const MIN_ARK = hre.ethers.parseEther('100');  // 100 ARK

  console.log('📋 部署参数：');
  console.log('  Trader:', TRADER);
  console.log('  Fee Wallet:', FEE_WALLET);
  console.log('  Fee:', FEE_BPS / 100, '%');
  console.log('  ARK Token:', ARK_TOKEN);
  console.log('  Min ARK:', hre.ethers.formatEther(MIN_ARK));
  console.log('');

  // 1. 部署 Factory
  console.log('1/3 部署 AgentVaultFactory...');
  const Factory = await hre.ethers.getContractFactory('AgentVaultFactory');
  const factory = await Factory.deploy(
    TRADER,
    FEE_WALLET,
    FEE_BPS,
    ARK_TOKEN,
    MIN_ARK
  );
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log('✅ AgentVaultFactory 已部署:', factoryAddress);

  // 2. 设置 PancakeSwap V2 Router 为白名单
  console.log('\n2/3 设置 PancakeSwap V2 Router 为白名单...');
  const PANCAKE_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
  
  try {
    const tx = await factory.setDexApproval(PANCAKE_ROUTER, true);
    await tx.wait();
    console.log('✅ PancakeSwap V2 Router 已加入白名单');
  } catch (e) {
    console.log('⚠️ 设置白名单失败:', e.message);
  }

  // 3. 设置 PancakeSwap V3 Router 为白名单
  console.log('\n3/3 设置 PancakeSwap V3 Router 为白名单...');
  const PANCAKE_V3_ROUTER = '0x13f4EA83D0bd40E0A6f18f66C28d8d8B8da8C085';
  
  try {
    const tx = await factory.setDexApproval(PANCAKE_V3_ROUTER, true);
    await tx.wait();
    console.log('✅ PancakeSwap V3 Router 已加入白名单');
  } catch (e) {
    console.log('⚠️ 设置 V3 Router 白名单失败:', e.message);
  }

  // 输出部署结果
  console.log('\n========================================');
  console.log('🎉 部署完成！');
  console.log('========================================');
  console.log('AgentVaultFactory 地址:', factoryAddress);
  console.log('');
  console.log('⚠️ 请保存这个地址！');
  console.log('⚠️ 更新 saas/server.js 中的 VAULT_FACTORY');
  console.log('========================================');
  
  // 输出验证命令
  console.log('\n📋 验证命令（可选）：');
  console.log(`npx hardhat verify --network bsc ${factoryAddress} "${TRADER}" "${FEE_WALLET}" ${FEE_BPS} "${ARK_TOKEN}" "${hre.ethers.formatEther(MIN_ARK)}"`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
