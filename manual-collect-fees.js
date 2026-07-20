#!/usr/bin/env node
/**
 * 手动触发批量扣费 — 自动扣费模式（transfer，从Trader钱包直接转出）
 * 用法: node manual-collect-fees.js
 */
const fs = require('fs');
const path = require('path');

(async () => {
  require('dotenv').config();
  const { ethers } = require('ethers');
  const BSC_RPC = 'https://bsc-rpc.publicnode.com';
  const USDT_ADDR = '0x55d398326f99059fF775485246999027B3197955';
  const PLATFORM_WALLET = '0xb6DEb31484353AdDaA5b6A105A2B758Df11bC28A';  // 服务费钱包
  const ECO_FUND_WALLET = '0xeF87e7fD5f0ADC5de82e84Dc9300002D9aC8bD82';  // 生态费钱包
  
  const traderPrivateKey = process.env.TRADER_PRIVATE_KEY;
  if (!traderPrivateKey) {
    console.log('❌ TRADER_PRIVATE_KEY 未配置');
    return;
  }
  
  const provider = new ethers.JsonRpcProvider(BSC_RPC);
  const traderWallet = new ethers.Wallet(traderPrivateKey, provider);
  const usdtContract = new ethers.Contract(USDT_ADDR, [
    'function transfer(address to, uint256 amount) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
  ], traderWallet);
  
  // Trader钱包状态
  const traderBal = await usdtContract.balanceOf(traderWallet.address);
  console.log('=== Trader 钱包状态 ===');
  console.log('地址:', traderWallet.address);
  console.log('USDT 余额: $' + Number(traderBal)/1e18);
  console.log('平台钱包:', PLATFORM_WALLET);
  console.log('生态钱包:', ECO_FUND_WALLET);
  console.log('');
  
  // 加载 fee-state
  const FEE_STATE_FILE = path.join(__dirname, 'data', 'bb-fee-state.json');
  const feeState = JSON.parse(fs.readFileSync(FEE_STATE_FILE, 'utf8'));
  
  console.log('=== 当前 pending 费用 ===');
  let grandTotal = 0;
  for (const [wallet, records] of Object.entries(feeState.pending || {})) {
    if (!records || records.length === 0) continue;
    const totalPlatform = records.reduce((s,r) => r.platformCollected ? s : s + parseFloat(r.platformFee), 0);
    const totalEco = records.reduce((s,r) => s + parseFloat(r.ecoFund), 0);
    const total = totalPlatform + totalEco;
    grandTotal += total;
    console.log(`${wallet.slice(0,12)}...: ${records.length}笔 $${total.toFixed(4)} (服务费$${totalPlatform.toFixed(2)}+生态费$${totalEco.toFixed(2)})`);
  }
  console.log(`\n总计: $${grandTotal.toFixed(4)}`);
  console.log('');
  
  if (grandTotal === 0) {
    console.log('✅ 无 pending 费用，无需扣费');
    return;
  }
  
  if (BigInt(traderBal) < ethers.parseUnits(grandTotal.toFixed(6), 18)) {
    console.log(`❌ Trader钱包余额不足 ($${Number(traderBal)/1e18})，需要 $${grandTotal.toFixed(4)}`);
    return;
  }
  
  // 加载userDB
  let userDB = null;
  try {
    const JSONDB = require('./saas/json-db');
    userDB = new JSONDB('data/saas-users.json');
  } catch(e) {
    console.log('⚠️ 无法加载userDB，将不更新记账余额');
  }
  
  // 逐用户扣费（从Trader钱包transfer）
  for (const [wallet, records] of Object.entries(feeState.pending || {})) {
    if (!records || records.length === 0) continue;
    
    const totalPlatform = records.reduce((s,r) => r.platformCollected ? s : s + parseFloat(r.platformFee), 0);
    const totalEco = records.reduce((s,r) => s + parseFloat(r.ecoFund), 0);
    const totalFee = totalPlatform + totalEco;
    
    if (totalFee <= 0) continue;
    
    console.log(`\n=== 处理 ${wallet.slice(0,12)}... 总费用 $${totalFee.toFixed(4)} ===`);
    
    let platformOk = false, ecoOk = false;
    
    // Step 1: 服务费
    if (totalPlatform > 0) {
      try {
        const platformWei = ethers.parseUnits(totalPlatform.toFixed(6), 18);
        console.log(`  💸 转服务费 $${totalPlatform.toFixed(4)} → ${PLATFORM_WALLET.slice(0,10)}...`);
        const tx1 = await usdtContract.transfer(PLATFORM_WALLET, platformWei);
        await tx1.wait();
        console.log(`  ✅ 服务费成功 tx=${tx1.hash}`);
        platformOk = true;
      } catch (e) {
        console.log(`  ❌ 服务费失败: ${e.message.slice(0,100)}`);
      }
    } else {
      platformOk = true;
    }
    
    // Step 2: 生态费
    if (platformOk && totalEco > 0) {
      try {
        const ecoWei = ethers.parseUnits(totalEco.toFixed(6), 18);
        console.log(`  💸 转生态费 $${totalEco.toFixed(4)} → ${ECO_FUND_WALLET.slice(0,10)}...`);
        const tx2 = await usdtContract.transfer(ECO_FUND_WALLET, ecoWei);
        await tx2.wait();
        console.log(`  ✅ 生态费成功 tx=${tx2.hash}`);
        ecoOk = true;
      } catch (e) {
        console.log(`  ❌ 生态费失败: ${e.message.slice(0,100)}`);
      }
    }
    
    // 更新 fee-state 和 userDB
    if (platformOk && ecoOk) {
      const removed = records.splice(0, records.length);
      for (const record of removed) {
        record.status = 'auto-collected';
        record.collectedAt = Date.now();
        if (!feeState.collected[wallet]) feeState.collected[wallet] = [];
        feeState.collected[wallet].push(record);
      }
      console.log(`  ✅ ${wallet.slice(0,12)}... 批量扣费完成，移除 ${removed.length} 笔 pending`);
      
      // 更新userDB记账余额
      if (userDB) {
        const existing = userDB.get(wallet) || {};
        const oldBalance = existing.gatesFeeBalance || 0;
        const newBalance = Math.max(0, oldBalance - totalFee);
        const collected = (existing.gatesFeeCollected || 0) + totalFee;
        userDB.set(wallet, {
          ...existing,
          gatesFeeBalance: newBalance,
          gatesFeeLow: newBalance < 5,
          gatesFeeCollected: collected,
          gatesFeeApproved: true,
        });
        console.log(`  💰 记账余额: $${oldBalance.toFixed(2)} → $${newBalance.toFixed(2)} | 累计扣费 $${collected.toFixed(2)}`);
      }
    } else if (platformOk && !ecoOk) {
      for (const record of records) {
        record.platformCollected = true;
      }
      console.log(`  ⚠️ 服务费已收，生态费失败，保留 pending 等下次重试`);
    }
  }
  
  // 保存 fee-state
  fs.writeFileSync(FEE_STATE_FILE, JSON.stringify(feeState, null, 2));
  console.log('\n✅ fee-state 已更新保存');
  
  // 最终统计
  console.log('\n=== 扣费后 pending 统计 ===');
  let remainingTotal = 0;
  for (const [wallet, records] of Object.entries(feeState.pending || {})) {
    if (!records || records.length === 0) continue;
    const total = records.reduce((s,r) => s + parseFloat(r.platformFee) + parseFloat(r.ecoFund), 0);
    remainingTotal += total;
    console.log(`${wallet.slice(0,12)}...: ${records.length}笔 $${total.toFixed(4)}`);
  }
  console.log(`\n剩余 pending: $${remainingTotal.toFixed(4)}`);
  
  // Trader钱包新余额
  const newTraderBal = await usdtContract.balanceOf(traderWallet.address);
  console.log(`\nTrader钱包新余额: $${Number(newTraderBal)/1e18}`);
  
  // 平台钱包余额
  const platformBal = await usdtContract.balanceOf(PLATFORM_WALLET);
  console.log(`平台钱包余额: $${Number(platformBal)/1e18}`);
  
  // 生态钱包余额
  const ecoBal = await usdtContract.balanceOf(ECO_FUND_WALLET);
  console.log(`生态钱包余额: $${Number(ecoBal)/1e18}`);
})();
