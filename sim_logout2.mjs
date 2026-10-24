import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext({
  userAgent: 'Mozilla/5.0 (Linux; Android 14; V2357A) TPCMS/1.0',
  viewport:{width:412,height:915}, isMobile:true
})).newPage();

await page.addInitScript(() => {
  const tp = {
    isTokenPocket:true, isMetaMask:true, chainId:'0x38',
    selectedAddress:'0xb5e113dd2fcb87a458191c3b0e2d606129455d4e',
    request: async(a)=>{
      console.log('PROVIDER['+a.method+']');
      if(a.method==='eth_chainId') return '0x38';
      if(a.method==='eth_requestAccounts') return ['0xb5e113dd2fcb87a458191c3b0e2d606129455d4e'];
      if(a.method==='personal_sign') return '0x'+'aa'.repeat(65);
      return '0x0';
    }, on:()=>{}
  };
  window.tokenpocket=tp; window.ethereum=tp;
});

const logs=[];
page.on('console',m=>logs.push('['+m.type()+'] '+m.text()));

await page.goto('http://65.20.68.166:18080/?v=lo2',{waitUntil:'networkidle',timeout:60000});
await page.evaluate(()=>localStorage.setItem('ark_auth_addr','0xb5e113dd2fcb87a458191c3b0e2d606129455d4e'));
await page.reload({waitUntil:'networkidle'});
await page.waitForTimeout(2000);

console.log('① 登录态:', await page.evaluate(()=>document.getElementById('authBox')?.textContent.trim().slice(0,40)));

logs.length=0;
console.log('\n② 点登出');
await page.evaluate(()=>window.logout());
await page.waitForTimeout(1000);
console.log('   登出日志:', logs.filter(l=>l.includes('logout')).join(' | ') || '(无)');
console.log('   authBox:', await page.evaluate(()=>document.getElementById('authBox')?.textContent.trim().slice(0,40)));

logs.length=0;
console.log('\n③ 点登录按钮');
const hasBtn = await page.evaluate(()=>{
  const b=document.querySelector('#authBox button');
  if(b){console.log('按钮存在:',b.textContent); b.click(); return true;}
  console.log('❌ 无按钮'); return false;
});
console.log('   点击结果:', hasBtn);
await page.waitForTimeout(3000);

console.log('   登录日志:');
logs.forEach(l=>console.log('     '+l));
console.log('\n   authBox:', await page.evaluate(()=>document.getElementById('authBox')?.textContent.trim().slice(0,60)));
await browser.close();
