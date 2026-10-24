import { chromium } from 'playwright';

// ⭐ 关键：模拟「真机实际行为」——TP 的 eth_sendTransaction 抛异常
const browser = await chromium.launch();
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Linux; Android 14; V2357A Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120 Mobile Safari/537.36 TPCMS/1.0',
  viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true
});
const page = await ctx.newPage();

await page.addInitScript(() => {
  const tp = {
    isTokenPocket: true, isMetaMask: true, chainId: '0x38',
    selectedAddress: '0xb5e113dd2fcb87a458191c3b0e2d606129455d4e',
    request: async (a) => {
      console.log('PROVIDER[' + a.method + ']');
      switch(a.method) {
        case 'eth_chainId': return '0x38';
        case 'eth_requestAccounts': return ['0xb5e113dd2fcb87a458191c3b0e2d606129455d4e'];
        // ⭐ 模拟真机：sendTransaction 拒绝
        case 'eth_sendTransaction': throw new Error('User rejected the request');
        case 'eth_estimateGas': throw new Error('execution reverted');
        case 'eth_call': return '0x0';
        case 'eth_getBalance': return '0x0';
        case 'personal_sign': return '0xmocksig';
        default: return '0x0';
      }
    }, on: () => {}
  };
  window.tokenpocket = tp; window.ethereum = tp;
});

const logs = [];
page.on('console', m => logs.push('[' + m.type() + '] ' + m.text()));
page.on('pageerror', e => logs.push('[PAGE_ERROR] ' + e.message));

await page.goto('http://65.20.68.166:18080/?v=rej', { waitUntil: 'networkidle', timeout: 60000 });
await page.evaluate(() => {
  localStorage.setItem('ark_auth_addr', '0xb5e113dd2fcb87a458191c3b0e2d606129455d4e');
});
await page.reload({ waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);

console.log('=== 场景：TP 拒绝交易（模拟真机）===');
await page.evaluate(() => {
  const b = document.querySelector('#adSlots .partner-card button');
  if (b) b.click();
});
await page.waitForTimeout(1200);
await page.evaluate(() => {
  document.getElementById('adTitle').value = 'test';
  document.getElementById('adUrl').value = 'https://example.com';
  window.adSubmit();
});
await page.waitForTimeout(2500);
logs.length = 0;

await page.evaluate(() => {
  const b = document.querySelector('#adPayBox button.inv-paybtn');
  if (b) b.click();
});
await page.waitForTimeout(5000);

const r = await page.evaluate(() => ({
  status: document.getElementById('adPayStatus')?.textContent || 'NO',
  wcPicker: document.getElementById('wcPicker') ? getComputedStyle(document.getElementById('wcPicker')).display : 'not-exist',
  wcClass: document.getElementById('wcPicker')?.className || 'NO'
}));
console.log('支付状态:', r.status);
console.log('钱包选择器:', r.wcPicker, '|', r.wcClass);
console.log('\n日志:');
logs.forEach(l => console.log('  ' + l));

await browser.close();
