require('dotenv').config({ path: '.env' });
const axios = require('axios');
const crypto = require('crypto');

const apiKey = process.env.BINANCE_API_KEY || process.env.API_KEY;
const apiSecret = process.env.BINANCE_API_SECRET || process.env.API_SECRET;

if (!apiKey || !apiSecret) {
  console.log('❌ No API credentials found');
  process.exit(1);
}

async function getIncomeHistory(startTime, endTime) {
  const base = 'https://fapi.binance.com';
  const params = {
    startTime,
    endTime,
    incomeType: 'REALIZED_PNL',
    limit: 1000,
    timestamp: Date.now(),
  };
  const query = Object.keys(params).map(k => `${k}=${params[k]}`).join('&');
  const sig = crypto.createHmac('sha256', apiSecret).update(query).digest('hex');
  const url = `${base}/fapi/v1/income?${query}&signature=${sig}`;
  const r = await axios.get(url, { headers: { 'X-MBX-APIKEY': apiKey } });
  return r.data;
}

(async () => {
  // 查 7/10 - 7/18 全部
  const start = Date.parse('2026-07-10T00:00:00Z');
  const end = Date.parse('2026-07-19T00:00:00Z');
  
  try {
    const trades = await getIncomeHistory(start, end);
    console.log(`\n=== 7/10-7/18 已实现盈亏记录: ${trades.length} 笔 ===\n`);
    
    const byDay = {};
    const bySymbol = {};
    let totalPnl = 0, winCount = 0, lossCount = 0, zeroCount = 0;
    
    for (const t of trades) {
      const day = new Date(t.time).toISOString().slice(0,10);
      byDay[day] = (byDay[day] || 0) + parseFloat(t.income);
      bySymbol[t.symbol] = (bySymbol[t.symbol] || 0) + parseFloat(t.income);
      totalPnl += parseFloat(t.income);
      const pnl = parseFloat(t.income);
      if (pnl > 0.0001) winCount++;
      else if (pnl < -0.0001) lossCount++;
      else zeroCount++;
    }
    
    console.log('--- 按日统计 ---');
    for (const [day, pnl] of Object.entries(byDay).sort()) {
      console.log(`  ${day}: ${pnl >= 0 ? '🟢' : '🔴'} $${pnl.toFixed(4)}`);
    }
    
    console.log('\n--- 按币种统计（7/10-7/18）---');
    for (const [sym, pnl] of Object.entries(bySymbol).sort((a,b) => b[1] - a[1])) {
      console.log(`  ${sym}: ${pnl >= 0 ? '🟢' : '🔴'} $${pnl.toFixed(4)}`);
    }
    
    console.log(`\n=== 汇总（7/10-7/18）===`);
    console.log(`  总盈亏: $${totalPnl.toFixed(4)}`);
    console.log(`  盈利笔数: ${winCount}`);
    console.log(`  亏损笔数: ${lossCount}`);
    console.log(`  平局笔数: ${zeroCount}`);
    console.log(`  胜率: ${trades.length > 0 ? (winCount / trades.length * 100).toFixed(1) : 0}%`);
    
    // 单独算 7/17
    const t17 = trades.filter(t => new Date(t.time).toISOString().slice(0,10) === '2026-07-17');
    if (t17.length > 0) {
      let w17 = 0, l17 = 0, p17 = 0;
      for (const t of t17) {
        const pnl = parseFloat(t.income);
        p17 += pnl;
        if (pnl > 0.0001) w17++;
        else if (pnl < -0.0001) l17++;
      }
      console.log(`\n=== 7/17 单日 ===`);
      console.log(`  交易: ${t17.length} 笔，盈利 ${w17}，亏损 ${l17}`);
      console.log(`  总盈亏: $${p17.toFixed(4)}`);
      console.log(`  胜率: ${(w17 / t17.length * 100).toFixed(1)}%`);
    } else {
      console.log(`\n=== 7/17 没有交易记录 ===`);
    }
  } catch (e) {
    console.log('❌ API error:', e.response?.data || e.message);
  }
})();
