/**
 * 部署新的 AgentVaultFactory V2（修复 encodePacked bug）
 */
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const factoryArtifact = path.join(__dirname, 'artifacts/contracts/AgentVaultFactory.sol/AgentVaultFactory.json');
if (!fs.existsSync(factoryArtifact)) {
  console.error('❌ 请先编译: npx hardhat compile --force');
  process.exit(1);
}

const FactoryJSON = JSON.parse(fs.readFileSync(factoryArtifact, 'utf8'));
const RPC_URL = 'https://bsc-dataseed.binance.org/';
const TRADER_PRIVATE_KEY = process.env.TRADER_PRIVATE_KEY;
if (!TRADER_PRIVATE_KEY) { console.error('[FATAL] TRADER_PRIVATE_KEY not set in .env'); process.exit(1); }

const TRADER_ADDRESS = '0xe6DDF0771c7610dBA77eB5a07ba7771DD7F5e91e';
const PLATFORM_FEE_WALLET = '0xb6DEb31484353AdDaA5b6A105A2B758Df11bC28A';
const PLATFORM_FEE_BPS = 2000;
const ARK_TOKEN = '0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D';
const MIN_ARK_BALANCE = 0;

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(TRADER_PRIVATE_KEY, provider);
  
  console.log('═══════════════════════════════');
  console.log('  🚀 部署 AgentVaultFactory V2');
  console.log('═══════════════════════════════');
  console.log('部署者:', wallet.address);
  
  const balance = await provider.getBalance(wallet.address);
  console.log('余额:', ethers.formatEther(balance), 'BNB');
  
  if (Number(ethers.formatEther(balance)) < 0.02) {
    console.error('❌ 余额不足');
    process.exit(1);
  }

  // 构造参数编码
  const iface = new ethers.Interface(FactoryJSON.abi);
  const deployData = iface.encodeDeploy([
    TRADER_ADDRESS,
    PLATFORM_FEE_WALLET,
    PLATFORM_FEE_BPS,
    ARK_TOKEN,
    MIN_ARK_BALANCE,
  ]);
  
  // 部署合约（bytecode + 构造参数）
  const deployTx = await wallet.sendTransaction({
    data: FactoryJSON.bytecode + deployData.slice(2), // 去掉 0x
    gasLimit: 5000000n,
    gasPrice: ethers.parseUnits('3', 'gwei'),
  });
  
  console.log('  tx hash:', deployTx.hash);
  console.log('  等待确认...');
  
  const receipt = await provider.waitForTransaction(deployTx.hash, 1, 120000);
  
  if (receipt.status === 0) {
    console.error('❌ 部署交易失败（revert）');
    process.exit(1);
  }
  
  // 从 receipt 中提取合约地址
  const factoryAddress = receipt.contractAddress;
  console.log('✅ Factory V2 已部署:', factoryAddress);
  console.log('  gasUsed:', receipt.gasUsed.toString());

  // 验证
  const code = await provider.getCode(factoryAddress);
  console.log('  合约代码长度:', code.length / 2 - 1, 'bytes');

  // 保存部署信息
  const deploymentInfo = {
    factoryAddress,
    trader: TRADER_ADDRESS,
    platformFeeWallet: PLATFORM_FEE_WALLET,
    platformFeeBps: PLATFORM_FEE_BPS,
    arkToken: ARK_TOKEN,
    deployedAt: new Date().toISOString(),
    network: 'bsc',
    chainId: 56,
    deployer: wallet.address,
    txHash: receipt.hash,
  };
  
  const outputPath = path.join(__dirname, 'data', 'factory-deployment.json');
  if (!fs.existsSync(path.dirname(outputPath))) fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(deploymentInfo, null, 2));
  console.log('\n💾 部署信息已保存:', outputPath);
  
  console.log('\n═══════════════════════════════');
  console.log('  🎉 部署完成！');
  console.log(`  Factory V2: ${factoryAddress}`);
  console.log('═══════════════════════════════');
}

main().catch(e => {
  console.error('❌ 部署失败:', e.message);
  process.exit(1);
});
