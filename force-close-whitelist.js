#!/usr/bin/env node
// ⚡ 紧急平仓脚本：平掉白名单用户浮亏仓(TAO/SEI/OP SHORT)
// 用法: node force-close-whitelist.js
'use strict';
const fs = require('fs');
const path = require('path');
const { BinanceAPI } = require('./lib/common');
const { decrypt } = require('./core/crypto-utils');

const WHITELIST = [
  '0x41c89c7df1ad4c8dd251c5afe45aa1c791fb6ea5',
  '0xc6dbb4cd3b6a12068c7388248da2bd32df7ef9b7',
];
const TARGET_SYMBOLS = ['TAOUSDT', 'SEIUSDT', 'OPUSDT'];

async function main() {
  // 读取用户数据库
  const usersPath = path.join(__dirname, 'data', 'saas-users.json');
  const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
  
  for (const wallet of WHITELIST) {
    const u = users[wallet];
    if (!u || !u.binanceApiKey || !u.binanceSecret) {
      console.log(`❌ ${wallet.slice(0,12)} 无API key, 跳过`);
      continue;
    }
    
    const apiKey = decrypt(u.binanceApiKey);
    const apiSecret = decrypt(u.binanceSecret);
    if (!apiKey || apiKey.length !== 64) {
      console.log(`❌ ${wallet.slice(0,12)} API key解密失败, 跳过`);
      continue;
    }
    
    const api = new BinanceAPI(apiKey, apiSecret);
    console.log(`\n═══ ${wallet.slice(0,12)} (白名单) ═══`);
    
    // 1) 查真实持仓
    let positions;
    try {
      positions = await api.getPositions();
    } catch(e) {
      console.log(`  ❌ 查持仓失败: ${e.message}`);
      continue;
    }
    
    // 2) 筛出目标仓
    const targets = positions.filter(p => 
      TARGET_SYMBOLS.includes(p.symbol) && parseFloat(p.positionAmt) !== 0
    );
    
    if (targets.length === 0) {
      console.log(`  ✅ 无目标持仓(TAO/SEI/OP), 已空仓`);
      continue;
    }
    
    // 3) 逐个平仓
    for (const pos of targets) {
      const sym = pos.symbol;
      const amt = parseFloat(pos.positionAmt);
      const side = amt > 0 ? 'LONG' : 'SHORT';
      const qty = Math.abs(amt);
      const entryPrice = parseFloat(pos.entryPrice);
      const markPrice = parseFloat(pos.markPrice);
      const unrealizedProfit = parseFloat(pos.unRealizedProfit);
      const pnlPct = ((markPrice - entryPrice) / entryPrice * 100 * (side === 'SHORT' ? -1 : 1));
      
      console.log(`  📊 ${sym} ${side} qty=${qty} entry=${entryPrice} mark=${markPrice} PnL=${unrealizedProfit.toFixed(4)} (${pnlPct.toFixed(2)}%)`);
      
      // 只平浮亏仓
      if (unrealizedProfit >= 0) {
        console.log(`  ⏭️ ${sym} 浮盈, 不平`);
        continue;
      }
      
      console.log(`  🔻 平仓中... ${sym} ${side} qty=${qty}`);
      
      try {
        const precisionMap = await api.getExchangeInfo().catch(() => null);
        let result;
        if (side === 'SHORT') {
          result = await api.closeShort(sym, qty, precisionMap);
        } else {
          result = await api.closeLong(sym, qty, precisionMap);
        }
        
        if (result.success) {
          console.log(`  ✅ ${sym} 平仓成功! orderId=${result.orderId}`);
        } else {
          console.log(`  ❌ ${sym} 平仓失败: ${result.error}`);
        }
      } catch(e) {
        console.log(`  ❌ ${sym} 平仓异常: ${e.message}`);
      }
    }
  }
  
  console.log('\n✅ 平仓脚本执行完毕');
}

main().catch(e => { console.error('致命错误:', e); process.exit(1); });
