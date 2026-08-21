#!/usr/bin/env node
/**
 * 管理员手动授权转账算力费工具
 * 
 * 用法:
 *   node tools/manual-fee-transfer.js                    # 只查看累计待转算力费
 *   node tools/manual-fee-transfer.js --key=<新钱包私钥>  # 查看后, 用新钱包私钥自动转账
 * 
 * 功能:
 *   1. 读取 quant-fee-state.json 累计的 totalPlatform(平台费20%) + totalEco(生态费10%)
 *   2. 用管理员提供的新钱包私钥, 从新钱包转账:
 *      - 平台费 → PLATFORM_WALLET (0xb6DEb314...)
 *      - 生态费 → ECO_FUND_WALLET (0xeF87e7fD...)
 *   3. 转账成功后清零累计记账
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const FEE_FILE = path.join(__dirname, '..', 'data', 'quant-fee-state.json');
const USDT = '0x55d398326f99059fF775485246999027B3197955';
const PLATFORM_WALLET = '0xb6DEb31484353AdDaA5b6A105A2B758Df11bC28A';
const ECO_FUND_WALLET = '0xeF87e7fD5f0ADC5de82e84Dc9300002D9aC8bD82';
// 充值/算力费钱包
const RECHARGE_WALLET = '0xB5E113DD2fcb87a458191c3B0e2d606129455d4e';

async function main() {
  // 读取累计记账
  let st = {};
  try { st = JSON.parse(fs.readFileSync(FEE_FILE, 'utf8')); } catch(e){ st = { totalPlatform:0, totalEco:0, pending:{} }; }
  const totalPlatform = +(st.totalPlatform || 0);
  const totalEco = +(st.totalEco || 0);
  const totalFee = totalPlatform + totalEco;

  console.log('═══ 算力费累计记账 ═══');
  console.log(`  平台费(20%累计): $${totalPlatform.toFixed(4)}`);
  console.log(`  生态费(10%累计): $${totalEco.toFixed(4)}`);
  console.log(`  合计待转: $${totalFee.toFixed(4)}`);
  console.log(`  充值/算力费钱包: ${RECHARGE_WALLET}`);
  console.log(`  目标钱包: 平台${PLATFORM_WALLET.slice(0,8)}...  生态${ECO_FUND_WALLET.slice(0,8)}...`);
  console.log('');

  if (totalFee <= 0.0001) {
    console.log('ℹ️  当前无可转算力费(累计不足)');
    return;
  }

  // 提取私钥
  const argKey = process.argv.find(a => a.startsWith('--key='));
  const privateKey = argKey ? argKey.split('=')[1] : null;

  if (!privateKey) {
    console.log('ℹ️  如需转账, 请提供新钱包私钥:');
    console.log('   node tools/manual-fee-transfer.js --key=<新钱包私钥>');
    console.log('   提示: 私钥仅用于本次一次性签名, 不保存');
    return;
  }

  console.log('═══ 开始用新钱包授权转账 ═══');
  const provider = new ethers.JsonRpcProvider('https://bsc-dataseed1.binance.org');
  const wallet = new ethers.Wallet(privateKey, provider);
  console.log(`  授权钱包地址: ${wallet.address}`);
  console.log(`  是否匹配充值钱包 ${RECHARGE_WALLET}: ${wallet.address.toLowerCase()===RECHARGE_WALLET.toLowerCase()?'✅':'⚠️ 不匹配'}`);

  // 查新钱包USDT余额
  const usdt = new ethers.Contract(USDT, ['function balanceOf(address) view returns (uint256)','function transfer(address,uint256) returns (bool)'], wallet);
  const bal = await usdt.balanceOf(wallet.address);
  console.log(`  新钱包USDT余额: $${ethers.formatUnits(bal,18)}`);

  const need = ethers.parseUnits(totalFee.toFixed(6), 18);
  if (BigInt(bal) < need) {
    console.log(`❌ 新钱包USDT不足(需$${totalFee.toFixed(4)}, 有$${ethers.formatUnits(bal,18)})`);
    return;
  }

  // 检查BNB gas
  const bnb = await provider.getBalance(wallet.address);
  if (BigInt(bnb) < ethers.parseUnits('0.001',18)) {
    console.log(`❌ 新钱包BNB(gas)不足: ${ethers.formatEther(bnb)} BNB`);
    return;
  }

  const GAS = ethers.parseUnits('5','gwei');
  // 转平台费
  if (totalPlatform > 0.0001) {
    const tx1 = await usdt.transfer(PLATFORM_WALLET, ethers.parseUnits(totalPlatform.toFixed(6),18), { gasPrice: GAS });
    const rec1 = await tx1.wait();
    console.log(`✅ 平台费$${totalPlatform.toFixed(4)} → 平台钱包 成功 tx=${tx1.hash.slice(0,18)}...`);
  }
  // 转生态费
  if (totalEco > 0.0001) {
    const tx2 = await usdt.transfer(ECO_FUND_WALLET, ethers.parseUnits(totalEco.toFixed(6),18), { gasPrice: GAS });
    const rec2 = await tx2.wait();
    console.log(`✅ 生态费$${totalEco.toFixed(4)} → 生态钱包 成功 tx=${tx2.hash.slice(0,18)}...`);
  }

  // 转账成功后清零累计
  st.totalPlatform = 0; st.totalEco = 0;
  fs.writeFileSync(FEE_FILE, JSON.stringify(st, null, 2));
  console.log('\n✅ 累计算力费已转账清零, 记账归零');
}

main().catch(e => {
  console.error('❌ 执行失败:', e.message);
  process.exit(1);
});
