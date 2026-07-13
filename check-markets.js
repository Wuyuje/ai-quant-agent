/**
 * 全面验证币安三大板块的 API 和交易对
 */
const https = require('https');

function fetch(url) {
  return new Promise((resolve) => {
    https.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

async function main() {
  console.log('========== 币安传统金融三大板块验证 ==========\n');

  // === 1. 股票板块 (现货股票代币 xxxBUSDT) ===
  console.log('【1】股票板块 — 现货股票代币 (api.binance.com 现货API)');
  const stockSymbols = ['TSLABUSDT','SPYBUSDT','QQQBUSDT','NVDABUSDT','METABUSDT','MSFTBUSDT','GOOGLBUSDT','COINBUSDT','MSTRBUSDT','PLTRBUSDT'];
  for (const sym of stockSymbols) {
    const t = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`);
    if (t && t.price) console.log(`  ✅ ${sym}: $${t.price}`);
    else console.log(`  ❌ ${sym}: 不可用`);
  }

  // === 2. U本位合约板块 (永续合约 xxxUSDT) ===
  console.log('\n【2】U本位合约 — 永续合约 (fapi.binance.com 合约API)');
  const futuresSymbols = ['TSLAUSDT','SPYUSDT','QQQUSDT','NVDAUSDT','METAUSDT','MSFTUSDT','GOOGLUSDT','COINUSDT','MSTRUSDT','PLTRUSDT'];
  for (const sym of futuresSymbols) {
    const t = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${sym}`);
    if (t && t.price) console.log(`  ✅ ${sym}: $${t.price}`);
    else console.log(`  ❌ ${sym}: 不可用`);
  }

  // === 3. 商品期货U本位 ===
  console.log('\n【3】商品期货U本位 — 永续合约 (fapi.binance.com)');
  const commoditySymbols = ['XAGUSDT','XAUUSDT','COPPERUSDT','NATGASUSDT'];
  for (const sym of commoditySymbols) {
    const t = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${sym}`);
    if (t && t.price) console.log(`  ✅ ${sym}: $${t.price}`);
    else console.log(`  ❌ ${sym}: 不可用`);
  }

  // === 4. 现货加密货币 ===
  console.log('\n【4】现货板块 — 加密货币现货 (api.binance.com)');
  const cryptoSymbols = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','PAXGUSDT','EURUSDT'];
  for (const sym of cryptoSymbols) {
    const t = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`);
    if (t && t.price) console.log(`  ✅ ${sym}: $${t.price}`);
    else console.log(`  ❌ ${sym}: 不可用`);
  }

  // === 5. 债券代币检查 ===
  console.log('\n【5】债券相关代币');
  const bondSymbols = ['BONDUSDT'];
  for (const sym of bondSymbols) {
    // 现货
    const spotT = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`);
    console.log(`  现货 ${sym}: ${spotT && spotT.price ? '$'+spotT.price : '不可用'}`);
    // 合约
    const futT = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${sym}`);
    console.log(`  合约 ${sym}: ${futT && futT.price ? '$'+futT.price : '不可用'}`);
  }

  // === 6. 利率相关合约 ===
  console.log('\n【6】利率/VIX相关合约U本位');
  const rateSymbols = ['USDCUSDT','UVXYUSDT','URNMUSDT','IWMUSDT','XLEUSDT'];
  for (const sym of rateSymbols) {
    const t = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${sym}`);
    if (t && t.price) console.log(`  ✅ ${sym}: $${t.price}`);
    else console.log(`  ❌ ${sym}: 不可用`);
  }

  // === 7. 检查现货股票代币的交易精度 ===
  console.log('\n【7】现货股票代币交易精度');
  const info = await fetch('https://api.binance.com/api/v3/exchangeInfo');
  if (info) {
    for (const sym of stockSymbols) {
      const s = info.symbols.find(x => x.symbol === sym && x.status === 'TRADING');
      if (s) {
        const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
        const minN = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
        console.log(`  ✅ ${sym} | step:${lot?.stepSize} minQty:${lot?.minQty} minNotional:${minN?.minNotional || minN?.notional}`);
      }
    }
  }

  // === 8. 检查合约U本位精度 ===
  console.log('\n【8】合约U本位精度');
  const finfo = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo');
  if (finfo) {
    for (const sym of [...futuresSymbols, ...commoditySymbols, 'USDCUSDT','UVXYUSDT','URNMUSDT','IWMUSDT','XLEUSDT']) {
      const s = finfo.symbols.find(x => x.symbol === sym && x.status === 'TRADING');
      if (s) {
        const lot = s.filters.find(f => f.filterType === 'LOT_SIZE' || f.filterType === 'MARKET_LOT_SIZE');
        console.log(`  ✅ ${sym} | qtyPrecision:${s.quantityPrecision} step:${lot?.stepSize} minQty:${lot?.minQty}`);
      }
    }
  }

  console.log('\n========== 验证完成 ==========');
}

main().catch(e => console.log('Error:', e.message));
