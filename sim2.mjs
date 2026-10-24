import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext({ isMobile: true })).newPage();

const reqs = [];
page.on('requestfailed', r => reqs.push('FAIL ' + r.url()));
page.on('response', r => { if (r.status() >= 400) reqs.push(r.status() + ' ' + r.url()); });

await page.goto('http://localhost:18080/?v=t2', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

console.log('=== 失败的请求 ===');
reqs.forEach(r => console.log('  ' + r));

console.log('\n=== adSlots 状态 ===');
const st = await page.evaluate(async () => {
  const el = document.getElementById('adSlots');
  // 手动请求 API
  let api = 'N/A';
  try {
    const r = await fetch('/api/ads/slots');
    const d = await r.json();
    api = 'OK slots=' + Object.keys(d.slots||{}).join(',');
  } catch (e) { api = 'ERR ' + e.message; }
  return {
    adSlotsHTML: el ? el.innerHTML.slice(0, 150) : 'NO ELEMENT',
    apiResult: api,
    loadSlotsFn: typeof window.loadSlots,
    renderSlotsFn: typeof window.renderSlots
  };
});
console.log(JSON.stringify(st, null, 1));

await browser.close();
