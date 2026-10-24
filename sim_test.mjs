import { chromium } from 'playwright';

const browser = await chromium.launch();
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Linux; Android 14; V2357A Build/UP1A.231005.007; wv) AppleWebKit/537.36',
  viewport: { width: 412, height: 915 },
  isMobile: true, hasTouch: true
});
const page = await ctx.newPage();

// ⭐ 模拟 TP 钱包注入（在页面加载前）
await page.addInitScript(() => {
  const mockProvider = {
    isTokenPocket: true,
    isMetaMask: true,
    chainId: '0x38',
    selectedAddress: '0xb5e113dd2fcb87a458191c3b0e2d606129455d4e',
    request: async (args) => {
      console.log('PROVIDER CALL:', args.method, JSON.stringify(args.params||'').slice(0,100));
      if (args.method === 'eth_chainId') return '0x38';
      if (args.method === 'eth_requestAccounts') return ['0xb5e113dd2fcb87a458191c3b0e2d606129455d4e'];
      if (args.method === 'eth_sendTransaction') return '0xMOCKTXHASH1234567890abcdef';
      if (args.method === 'eth_estimateGas') return '0x5208';
      if (args.method === 'eth_call') return '0x0';
      if (args.method === 'eth_getBalance') return '0x0';
      if (args.method === 'personal_sign') return '0xmocksig';
      return '0x0';
    },
    on: () => {}
  };
  window.tokenpocket = mockProvider;
  window.ethereum = mockProvider;
});

// 收集日志
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));

console.log('=== 1) 打开页面 ===');
await page.goto('http://localhost:18080/?v=test', { waitUntil: 'networkidle' });
console.log('  标题:', await page.title());

console.log('\n=== 2) 设置登录状态 ===');
await page.evaluate(() => {
  localStorage.setItem('ark_auth_addr', '0xb5e113dd2fcb87a458191c3b0e2d606129455d4e');
  window._arkAddr = '0xb5e113dd2fcb87a458191c3b0e2d606129455d4e';
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

console.log('\n=== 3) 检查环境 ===');
const env = await page.evaluate(() => ({
  tokenpocket: !!window.tokenpocket,
  ethereum: !!window.ethereum,
  arkProvider: typeof window.arkProvider,
  providerResult: window.arkProvider ? (window.arkProvider() ? 'OK' : 'NULL') : 'NO_FUNC',
  arkPay: typeof window.arkPay,
  adPay: typeof window.adPay,
  arkState: window.arkState ? window.arkState.addr : 'undefined',
  ls: localStorage.getItem('ark_auth_addr')
}));
console.log(JSON.stringify(env, null, 1).split('\n').map(l=>'  '+l).join('\n'));

console.log('\n=== 4) 点「投放」按钮 ===');
// 等广告位渲染
await page.waitForTimeout(2000);
const slotsHtml = await page.evaluate(() => {
  const el = document.getElementById('adSlots');
  return el ? el.innerHTML.slice(0, 200) : 'NOT FOUND';
});
console.log('  adSlots:', slotsHtml);

// 找投放按钮
const btns = await page.$$('button');
console.log('  页面按钮数:', btns.length);

// 直接调用 adOpenForm
console.log('\n=== 5) 直接调 adOpenForm ===');
const r = await page.evaluate(() => {
  try {
    if (typeof window.adOpenForm !== 'function') return 'adOpenForm NOT FUNCTION';
    window.adOpenForm('test');
    return 'called OK';
  } catch (e) { return 'ERROR: ' + e.message; }
});
console.log('  结果:', r);
await page.waitForTimeout(1500);

const state = await page.evaluate(() => ({
  adModal: document.getElementById('adModal') ? document.getElementById('adModal').className : 'NO MODAL',
  wcPicker: document.getElementById('wcPicker') ? document.getElementById('wcPicker').className : 'NO PICKER',
  slotChips: document.getElementById('cPlanChips') ? 'OK' : 'NO',
}));
console.log('  弹窗状态:', JSON.stringify(state));

console.log('\n=== 6) 日志（最后20条）===');
logs.slice(-20).forEach(l => console.log('  ' + l));

await browser.close();
