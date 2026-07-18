// 手动平掉 ONDOUSDT（用修复后的精度逻辑）
const fs = require('fs');
const path = require('path');

// 加载 .env
const envContent = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
envContent.split('\n').forEach(line => {
  const match = line.match(/^([A-Z_]+)=(.*)$/);
  if (match) process.env[match[1]] = match[2];
});

const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
const crypto = require('crypto');
const https = require('https');

console.log('=== 手动平仓 ONDOUSDT ===');

async function getExchangeInfo() {
  return new Promise((resolve, reject) => {
    https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function closePosition(symbol, qty, side) {
  const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
  const query = `symbol=${symbol}&side=${closeSide}&type=MARKET&quantity=${qty}&reduceOnly=true&timestamp=${Date.now()}&recvWindow=10000`;
  const signature = crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
  
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'fapi.binance.com',
      path: '/fapi/v1/order?' + query + '&signature=' + signature,
      method: 'POST',
      headers: { 'X-MBX-APIKEY': API_KEY }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  // 1. 获取 ONDOUSDT 精度
  const info = await getExchangeInfo();
  const ondo = info.symbols.find(s => s.symbol === 'ONDOUSDT');
  const stepSize = parseFloat(ondo.filters.find(f => f.filterType === 'LOT_SIZE').stepSize);
  const precision = ondo.quantityPrecision;
  console.log('ONDOUSDT: stepSize=' + stepSize + ' precision=' + precision);
  
  // 2. 修复后的 fixQty
  const qty = 4134.9;
  const scaled = qty / stepSize;
  const fixed = (Math.abs(scaled - Math.round(scaled)) < 1e-9 ? Math.round(scaled) : Math.floor(scaled)) * stepSize;
  const fixedQty = parseFloat(fixed.toFixed(precision));
  console.log('fixQty(' + qty + ') = ' + fixedQty);
  
  // 3. 平仓
  console.log('平仓 ONDOUSDT qty=' + fixedQty + ' side=LONG...');
  const result = await closePosition('ONDOUSDT', fixedQty, 'LONG');
  console.log('结果:', JSON.stringify(result, null, 2));
})();
