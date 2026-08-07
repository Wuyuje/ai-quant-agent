// 分页拉K线(startTime), 突破limit 1500限制
module.exports = async function getK(api, symbol, interval, count) {
  const out = [];
  const itMs = { '1m':60000,'5m':300000,'15m':900000,'1h':3600000,'4h':14400000 }[interval] || 300000;
  let start = Date.now() - count * itMs;
  const pageSize = 1500;
  while (out.length < count) {
    const url = undefined;
    // 用 api._get 或直接 https
    const kl = await fetchK(api, symbol, interval, pageSize, start);
    if (!Array.isArray(kl) || !kl.length) break;
    out.push(...kl);
    start = kl[kl.length-1].openTime + itMs;
    if (kl.length < pageSize) break;
  }
  return out;
};
function fetchK(api, symbol, interval, limit, startTime) {
  return new Promise((resolve) => {
    const https = require('https');
    const path = `/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}&startTime=${startTime}`;
    https.get({ hostname:'fapi.binance.com', path, headers:{'X-MBX-APIKEY': api.apiKey||''} }, (r) => {
      const ch=[]; r.on('data',d=>ch.push(d)); r.on('end',()=>{try{const j=JSON.parse(Buffer.concat(ch).toString());const obj=Array.isArray(j)?j.map(k=>({time:k[0],open:k[1],high:k[2],low:k[3],close:k[4],volume:k[5],openTime:k[0]})):null;resolve(obj||null);}catch(e){resolve(null);}});
    }).on('error',()=>resolve(null));
  });
}
