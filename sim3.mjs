import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Linux; Android 14; V2357A Build/UP1A.231005.007; wv) AppleWebKit/537.36',
  viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true
});
const page = await ctx.newPage();

// 模拟 TP 注入
await page.addInitScript(() => {
  const p = {
    isTokenPocket: true, isMetaMask: true, chainId: '0x38',
    selectedAddress: '0xb5e113dd2fcb87a458191c3b0e2d606129455d4e',
    request: async (a) => {
      console.log('PROVIDER:', a.method);
      if (a.method === 'eth_chainId') return '0x38';
      if (a.method === 'eth_requestAccounts') return ['0xb5e113dd2fcb87a458191c3b0e2d606129455d4e'];
      if (a.method === 'eth_sendTransaction') return '0xMOCKTX';
      if (a.method === 'eth_estimateGas') return '0x5208';
      if (a.method === 'eth_call') return '0x0';
      if (a.method === 'eth_getBalance') return '0x0';
      return '0x0';
    }, on: () => {}
  };
  window.tokenpocket = p; window.ethereum = p;
});

const logs = [];
page.on('console', m => logs.push('[' + m.type() + '] ' + m.text()));
const errs = [];
page.on('response', r => { if (r.status() >= 400) errs.push(r.status() + ' ' + r.url()); });

console.log('=== 打开线上服务器 ===');
await page.goto('http://65.20.68.166:18080/?v=test3', { waitUntil: 'networkidle', timeout: 60000 });

// 设置登录
await page.evaluate(() => {
  localStorage.setItem('ark_auth_addr', '0xb5e113dd2fcb87a458191c3b0e2d606129455d4e');
  window._arkAddr = '0xb5e113dd2fcb87a458191c3b0e2d606129455d4e';
});
await page.reload({ waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);

console.log('\n=== 1) 失败请求 ===');
errs.forEach(e => console.log('  ' + e));

console.log('\n=== 2) 广告位渲染 ===');
const slots = await page.evaluate(() => {
  const el = document.getElementById('adSlots');
  return el ? { html: el.innerHTML.slice(0,100), count: el.children.length } : 'NO ELEMENT';
});
console.log(' ', JSON.stringify(slots));

console.log('\n=== 3) 找「投放」按钮并点击 ===');
const clicked = await page.evaluate(() => {
  const chips = document.querySelectorAll('#adSlots .partner-card');
  if (!chips.length) return 'no slots rendered';
  const btn = chips[0].querySelector('button');
  if (!btn) return 'no button';
  btn.click();
  return 'clicked: ' + btn.textContent;
});
console.log('  ' + clicked);
await page.waitForTimeout(2000);

console.log('\n=== 4) 检查弹窗 ===');
const modal = await page.evaluate(() => ({
  adModal: document.getElementById('adModal') ? document.getElementById('adModal').className : 'NO',
  wcPicker: document.getElementById('wcPicker') ? document.getElementById('wcPicker').className : 'NO',
  adFormTitle: document.getElementById('adFormTitle') ? document.getElementById('adFormTitle').textContent : 'NO'
}));
console.log('  ' + JSON.stringify(modal));

console.log('\n=== 5) 填表并提交 ===');
await page.evaluate(() => {
  document.getElementById('adTitle').value = '测试项目';
  document.getElementById('adUrl').value = 'https://example.com';
  document.getElementById('adContact').value = 'test';
});
const sub = await page.evaluate(() => {
  if (typeof window.adSubmit !== 'function') return 'adSubmit NOT EXPORTED';
  window.adSubmit();
  return 'submitted';
});
console.log('  ' + sub);
await page.waitForTimeout(3000);

console.log('\n=== 6) 检查订单 + 支付 ===');
const payState = await page.evaluate(() => ({
  payBox: document.getElementById('adPayBox') ? document.getElementById('adPayBox').style.display : 'NO',
  payHtml: document.getElementById('adPayBox') ? document.getElementById('adPayBox').innerHTML.slice(0,200) : '',
  adPayFn: typeof window.adPay
}));
console.log('  ' + JSON.stringify(payState, null, 1));

console.log('\n=== 7) 点「用钱包支付」 ===');
const payClick = await page.evaluate(() => {
  const b = document.querySelector('#adPayBox button.inv-paybtn');
  if (!b) return 'button not found';
  const oc = b.getAttribute('onclick');
  b.click();
  return 'clicked, onclick=' + oc;
});
console.log('  ' + payClick);
await page.waitForTimeout(4000);

console.log('\n=== 8) 支付后状态 ===');
const after = await page.evaluate(() => ({
  status: document.getElementById('adPayStatus') ? document.getElementById('adPayStatus').textContent : 'NO',
  wcPicker: document.getElementById('wcPicker') ? document.getElementById('wcPicker').className : 'NO',
  wcPickerVisible: document.getElementById('wcPicker') ? getComputedStyle(document.getElementById('wcPicker')).display : 'NO'
}));
console.log('  ' + JSON.stringify(after, null, 1));

console.log('\n=== 9) 日志 ===');
logs.slice(-25).forEach(l => console.log('  ' + l));

await browser.close();
