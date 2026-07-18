const traderAddr = '0xe6DDF0771c7610dBA77eB5a07ba7771DD7F5e91e'.toLowerCase();
const toTopic = '0x000000000000000000000000' + traderAddr.replace('0x','');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function rpc(method, params) {
  try {
    const r = await fetch('https://bsc.blockrazor.xyz', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({jsonrpc:'2.0',id:1,method,params})
    });
    return await r.json();
  } catch(e) { return {error: e.message}; }
}

(async () => {
  const latest = await rpc('eth_blockNumber', []);
  const latestNum = parseInt(latest.result, 16);
  console.log('latest:', latestNum);
  
  // 查 110630000 到 110650000（约昨天）
  const startBlock = 110630000;
  const endBlock = 110650000;
  const batchSize = 20;
  let allLogs = [];
  let batchCount = 0;
  
  for (let from = startBlock; from < endBlock; from += batchSize) {
    const to = Math.min(from + batchSize - 1, endBlock);
    batchCount++;
    
    const logs = await rpc('eth_getLogs', [{
      address: '0x55d398326f99059fF775485246999027B3197955',
      topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', null, toTopic],
      fromBlock: '0x' + from.toString(16),
      toBlock: '0x' + to.toString(16)
    }]);
    
    if (logs.error) { await sleep(300); continue; }
    if (logs.result && logs.result.length) {
      allLogs = allLogs.concat(logs.result);
      console.log('block ' + from + ': ✅ found ' + logs.result.length);
    }
    
    if (batchCount % 200 === 0) {
      console.log('progress: block ' + from + ' (' + Math.round((from - startBlock) / (endBlock - startBlock) * 100) + '%)');
    }
    await sleep(80);
  }
  
  console.log('');
  console.log('=== block ' + startBlock + '-' + endBlock + ' ===');
  console.log('总计 ' + allLogs.length + ' 条');
  let total = 0;
  const byFrom = {};
  allLogs.forEach(log => {
    const from = '0x' + log.topics[1].substring(26);
    const amount = Number(BigInt(log.data)) / 1e18;
    const block = parseInt(log.blockNumber, 16);
    total += amount;
    byFrom[from] = (byFrom[from] || 0) + amount;
    console.log('block:' + block + ' from:' + from + ' +$' + amount.toFixed(2));
  });
  console.log('=== by source ===');
  for (const [from, amt] of Object.entries(byFrom)) {
    console.log(from + ': $' + amt.toFixed(2));
  }
  console.log('total: $' + total.toFixed(2));
})();
