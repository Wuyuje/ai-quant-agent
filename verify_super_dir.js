// 验证 SUPER dir 与未来价格方向的对齐关系
const { BollingerStrategy } = require('/app/workspace/ai-quant-agent/quant/bollinger-strategy.js');
const fs = require('fs');
const arr = JSON.parse(fs.readFileSync('/tmp/stbig.json', 'utf8'));
const h = arr.map(k => +k.high), l = arr.map(k => +k.low), c = arr.map(k => +k.close);
const n = c.length;
const atr = Array(n).fill(0);
for (let i = 1; i < n; i++) { const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])); atr[i] = i >= 10 ? (atr[i - 1] * 9 + tr) / 10 : (i > 0 ? (atr[i - 1] + tr) / i : tr); }
const hl2 = h.map((x, i) => (x + l[i]) / 2);
const up = Array(n).fill(0), dn = Array(n).fill(0), dir = Array(n).fill(1);
for (let i = 0; i < n; i++) { let u = hl2[i] + 3 * atr[i], dd = hl2[i] - 3 * atr[i]; if (i > 0) { u = u < up[i - 1] || c[i - 1] > up[i - 1] ? u : up[i - 1]; dd = dd > dn[i - 1] || c[i - 1] < dn[i - 1] ? dd : dn[i - 1]; } up[i] = u; dn[i] = dd; }
for (let i = 1; i < n; i++) { if (c[i] > up[i - 1]) dir[i] = 1; else if (c[i] < dn[i - 1]) dir[i] = -1; else if (dir[i - 1] === 1) dir[i] = c[i] >= dn[i] ? 1 : -1; else dir[i] = c[i] <= up[i] ? -1 : 1; }

// 验证 dir=1 是否对应价格上涨趋势
const H = 5;
let up_total = 0, up_ok = 0, dn_total = 0, dn_ok = 0;
for (let i = 20; i < n - H; i++) {
  const fut = c[i + H] - c[i];
  if (dir[i] === 1) { up_total++; if (fut > 0) up_ok++; }
  else { dn_total++; if (fut < 0) dn_ok++; }
}
console.log('dir=1(红线) 后' + H + '根K线上涨率: ' + (up_ok / up_total * 100).toFixed(1) + '% (' + up_total + '样本)');
console.log('dir=-1(绿线) 后' + H + '根K线下跌率: ' + (dn_ok / dn_total * 100).toFixed(1) + '% (' + dn_total + '样本)');
console.log('');
console.log('解读:');
console.log('  若 dir=1 上市面上涨率>50% → dir=1=上涨趋势(标准SUPER), 我们的红↑=上涨正确');
console.log('  若 dir=1 后反而下跌率>50% → 方向反了!');
