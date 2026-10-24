import { chromium } from 'playwright';

const browser = await chromium.launch();
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Linux; Android 14; V2357A Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120 Mobile Safari/537.36 TPTokenpocket/4.0',
  viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true
});
const page = await ctx.newPage();

// 完整模拟 TP 钱包注入（含 providers 数组，真机可能这样）
await page.addInitScript(() => {
  const tp = {
    isTokenPocket: true, isMetaMask: true, chainId: '0x38',
    selectedAddress: '0xb5e113dd2fcb87a458191c3b0e2d606129455d4e',
    request: async (a) => {
      console.log('PROVIDER[' + (a.method) + ']');
      switch(a.method) {
        case 'eth_chainId': return '0x38';
        case 'eth_requestAccounts': return ['0xb5e113dd2fcb87a458191c3b0e2d606129455d4e'];
        case 'eth_sendTransaction': return '0xREALMOCK' + Date.now();
        case 'eth_estimateGas': return '0x5208';
        case 'eth_call': return '0x0000000000000000000000000000000000000000000000000000000000000000';
        case 'eth_getBalance': return '0x0';
        case 'personal_sign': return '0xmocksig';
        default: return '0x0';
      }
    }, on: () => {}
  };
  window.tokenpocket = tp;
  window.ethereum = tp;
});

const logs = [];
page.on('console', m => logs.push('[' + m.type() + '] ' + m.text()));

console.log('###### 全流程测试（TP 环境 + 已登录）######\n');
await page.goto('http://65.20.68.166:18080/?v=full1', { waitUntil: 'networkidle', timeout: 60000 });

// ① 模拟已登录
await page.evaluate(() => {
  localStorage.setItem('ark_auth_addr', '0xb5e113dd2fcb87a458191c3b0e2d606129455d4e');
  localStorage.setItem('ark_wallet_type', 'tp');
});
await page.reload({ waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);

// ② 检查登录态
const login = await page.evaluate(() => ({
  authBox: document.getElementById('authBox') ? document.getElementById('authBox').textContent.trim().slice(0,50) : 'NO',
  arkState: window.arkState ? window.arkState.addr : 'undefined',
  isPro: window.arkState ? window.arkState.pro : '?'
}));
console.log('① 登录态:', JSON.stringify(login));

// ③ 测试 1：点「投放」
console.log('\n② 点「投放」按钮...');
await page.evaluate(() => {
  const btn = document.querySelector('#adSlots .partner-card button');
  if (btn) btn.click();
});
await page.waitForTimeout(1500);
let m1 = await page.evaluate(() => ({
  adModal: document.getElementById('adModal')?.className || 'NO',
  wcPicker: document.getElementById('wcPicker')?.className || 'NO',
  wcVisible: document.getElementById('wcPicker') ? getComputedStyle(document.getElementById('wcPicker')).display : 'NO'
}));
console.log('   弹窗:', JSON.stringify(m1));
console.log('   →', m1.adModal.includes('on') ? '✅ 打开申请表' : '❌ 失败');
console.log('   →', m1.wcVisible === 'none' || m1.wcPicker === 'NO' ? '✅ 无选择器' : '❌ 弹了选择器');

// ④ 测试 2：提交并支付
console.log('\n③ 填表提交...');
await page.evaluate(() => {
  document.getElementById('adTitle').value = '全流程测试';
  document.getElementById('adUrl').value = 'https://example.com';
  document.getElementById('adContact').value = 'test';
  document.getElementById('adMonths').value = '1';
  window.adOnMonthsChange();
});
await page.waitForTimeout(500);
await page.evaluate(() => window.adSubmit());
await page.waitForTimeout(3000);

let payBtn = await page.evaluate(() => {
  const b = document.querySelector('#adPayBox button.inv-paybtn');
  return b ? { exists: true, onclick: b.getAttribute('onclick') } : { exists: false };
});
console.log('   支付按钮:', JSON.stringify(payBtn));
await page.waitForTimeout(2000);

// 清空日志以专注支付
logs.length = 0;

// ⑤ 测试 3：点支付
console.log('\n④ 点「用錢包支付」...');
const beforePicker = await page.evaluate(() => 
  document.getElementById('wcPicker') ? getComputedStyle(document.getElementById('wcPicker')).display : 'not-exist');
console.log('   点击前 wcPicker:', beforePicker);

await page.evaluate(() => {
  const b = document.querySelector('#adPayBox button.inv-paybtn');
  if (b) b.click();
});
await page.waitForTimeout(4000);

let m2 = await page.evaluate(() => ({
  status: document.getElementById('adPayStatus')?.textContent || 'NO',
  wcPicker: document.getElementById('wcPicker') ? getComputedStyle(document.getElementById('wcPicker')).display : 'not-exist',
  wcPickerClass: document.getElementById('wcPicker')?.className || 'NO'
}));
console.log('   支付后:', JSON.stringify(m2));
console.log('   → wcPicker 显示?', m2.wcPicker);
console.log('   → 状态:', m2.status);

console.log('\n⑤ 支付过程日志:');
logs.forEach(l => console.log('   ' + l));

// ⑥ 关键判定
console.log('\n###### 判定 ######');
const pickerShown = m2.wcPicker === 'flex' || m2.wcPickerClass.includes('on');
console.log('钱包选择器:', pickerShown ? '❌ 被弹出（有 BUG）' : '✅ 未弹出');
console.log('状态文字:', m2.status);

await browser.close();
