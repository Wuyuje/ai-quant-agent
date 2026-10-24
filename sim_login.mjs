import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Linux; Android 14; V2357A) AppleWebKit/537.36 TPCMS/1.0',
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
        case 'personal_sign': return '0x' + '11'.repeat(65);
        default: return '0x0';
      }
    }, on: () => {}
  };
  window.tokenpocket = tp; window.ethereum = tp;
});

const logs = [];
page.on('console', m => logs.push('[' + m.type() + '] ' + m.text()));
page.on('pageerror', e => logs.push('[ERR] ' + e.message));

await page.goto('http://65.20.68.166:18080/?v=login', { waitUntil: 'networkidle', timeout: 60000 });

console.log('=== ① 先登录状态 ===');
await page.evaluate(() => localStorage.setItem('ark_auth_addr','0xb5e113dd2fcb87a458191c3b0e2d606129455d4e'));
await page.reload({ waitUntil:'networkidle' });
await page.waitForTimeout(2000);
console.log('  authBox:', await page.evaluate(()=>document.getElementById('authBox')?.textContent.trim().slice(0,60)));

console.log('\n=== ② 点登出 ===');
await page.evaluate(() => { if(window.logout) window.logout(); });
await page.waitForTimeout(1500);
let after = await page.evaluate(() => ({
  authBox: document.getElementById('authBox')?.textContent.trim().slice(0,60),
  html: document.getElementById('authBox')?.innerHTML.slice(0,200),
  ls: localStorage.getItem('ark_auth_addr')
}));
console.log('  authBox:', after.authBox);
console.log('  html:', after.html);
console.log('  localStorage:', after.ls);

console.log('\n=== ③ 点登录按钮 ===');
logs.length = 0;
await page.evaluate(() => {
  const b = document.querySelector('#authBox button');
  if (b) { console.log('找到按钮:', b.textContent); b.click(); }
  else console.log('❌ 没找到按钮');
});
await page.waitForTimeout(3000);

let r = await page.evaluate(() => ({
  authBox: document.getElementById('authBox')?.textContent.trim().slice(0,80),
  auStatus: document.getElementById('auStatus')?.textContent || 'NO',
  wcPicker: document.getElementById('wcPicker') ? getComputedStyle(document.getElementById('wcPicker')).display : 'not-exist'
}));
console.log('  结果:', JSON.stringify(r, null, 1));
console.log('\n  日志:');
logs.forEach(l => console.log('    ' + l));

await browser.close();
