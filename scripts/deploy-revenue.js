/**
 * 部署 RevenueDistribution 合约到 BSC
 * 
 * 用法:
 *   npx hardhat run scripts/deploy-revenue.js --network bsc
 * 
 * 前提:
 *   1. .env 中设置 PRIVATE_KEY（部署者私钥）
 *   2. 安装依赖: npm install @openzeppelin/contracts hardhat @nomicfoundation/hardhat-toolbox
 */

const hre = require('hardhat');

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log('部署者:', deployer.address);

  // ============ 配置 ============
  // ⚠️ 部署前修改为真实钱包地址
  const PLATFORM_WALLET = '0x0000000000000000000000000000000000000000'; // 你的平台钱包
  const ECO_FUND_WALLET = '0x0000000000000000000000000000000000000000'; // 生态基金钱包

  console.log('部署 RevenueDistribution 合约...');
  console.log('  平台钱包:', PLATFORM_WALLET);
  console.log('  生态基金:', ECO_FUND_WALLET);

  const Contract = await hre.ethers.getContractFactory('RevenueDistribution');
  const contract = await Contract.deploy(PLATFORM_WALLET, ECO_FUND_WALLET);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log('✅ RevenueDistribution 已部署:', address);
  console.log('   部署交易:', contract.deploymentTransaction().hash);

  // 验证（BSCScan）
  if (hre.network.name !== 'hardhat' && hre.network.name !== 'localhost') {
    console.log('等待区块确认...');
    await contract.deploymentTransaction().wait(10);

    try {
      await hre.run('verify:verify', {
        address,
        constructorArguments: [PLATFORM_WALLET, ECO_FUND_WALLET],
      });
      console.log('✅ 合约已验证');
    } catch (e) {
      console.log('⚠️ 验证失败:', e.message);
    }
  }

  console.log('\n═══════════════════════════════════════');
  console.log('  部署完成！');
  console.log(`  合约地址: ${address}`);
  console.log('  网络:', hre.network.name);
  console.log('═══════════════════════════════════════\n');

  // 写入配置
  const configPath = __dirname + '/../config/revenue-contract.json';
  const fs = require('fs');
  fs.writeFileSync(configPath, JSON.stringify({
    network: hre.network.name,
    contractAddress: address,
    platformWallet: PLATFORM_WALLET,
    ecoFundWallet: ECO_FUND_WALLET,
    deployedAt: new Date().toISOString(),
    deploymentTx: contract.deploymentTransaction().hash,
  }, null, 2));
  console.log('配置已保存:', configPath);
}

main().catch(e => {
  console.error('❌ 部署失败:', e);
  process.exit(1);
});
