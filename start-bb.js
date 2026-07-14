/**
 * start-bb.js — 孙总布林带引擎独立启动脚本
 * 
 * 独立端口、独立日志，不影响现有系统
 * 
 * 用法: node start-bb.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const http = require('http');
const { BBEngine, CONFIG } = require('./bb-engine');

// ════════════════════════════════════════
//  配置
// ════════════════════════════════════════
const PORT = 10088;  // 独立端口，不冲突

const apiKey = process.env.BINANCE_API_KEY || '';
const apiSecret = process.env.BINANCE_API_SECRET || '';

if (!apiKey || !apiSecret) {
  console.error('❌ 未找到 BINANCE_API_KEY / BINANCE_API_SECRET');
  process.exit(1);
}

// ════════════════════════════════════════
//  启动引擎
// ════════════════════════════════════════
console.log('');
console.log('╔═══════════════════════════════════════════════╗');
console.log('║  孙总布林带引擎 BB Engine  独立测试版          ║');
console.log('║  策略: 50强选币 + 5min布林带 + 双模式止盈      ║');
console.log('║  补仓3次 + 单K20%止损 + 70%终极止损           ║');
console.log('╚═══════════════════════════════════════════════╝');
console.log('');

const engine = new BBEngine(apiKey, apiSecret);

// ════════════════════════════════════════
//  状态HTTP接口（简单仪表盘）
// ════════════════════════════════════════
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/status') {
    const positions = Object.values(engine.positions || {}).map(p => {
      const pnlPct = p.side === 'LONG'
        ? ((p.currentPrice || p.entryPrice) - p.entryPrice) / p.entryPrice * 100 * p.leverage
        : (p.entryPrice - (p.currentPrice || p.entryPrice)) / p.entryPrice * 100 * p.leverage;
      const pnlUsd = p.side === 'LONG'
        ? ((p.currentPrice || p.entryPrice) - p.entryPrice) * p.qty
        : (p.entryPrice - (p.currentPrice || p.entryPrice)) * p.qty;
      return `<tr>
        <td>${p.symbol}</td>
        <td style="color:${p.side==='LONG'?'green':'red'}">${p.side}</td>
        <td>${p.qty}</td>
        <td>${p.entryPrice}</td>
        <td>${(p.currentPrice||0)}</td>
        <td style="color:${pnlUsd>=0?'green':'red'}">${pnlPct.toFixed(2)}%</td>
        <td style="color:${pnlUsd>=0?'green':'red'}">$${pnlUsd.toFixed(2)}</td>
        <td>${p.replenishCount}/3</td>
        <td>${p.mode||'轨道'}</td>
      </tr>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>BB Engine 状态</title>
<meta http-equiv="refresh" content="10">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Menlo','Monaco','Courier New',monospace;background:#0d1b2a;color:#e0e0e0;padding:30px;min-height:100vh}
h1{color:#00d4ff;font-size:32px;margin-bottom:20px}
.summary{margin:20px 0;padding:25px 30px;background:#1b263b;border-radius:12px;font-size:22px;line-height:1.8}
.summary b{color:#00d4ff;margin-right:5px}
.summary span{margin-right:25px;display:inline-block}
table{border-collapse:collapse;width:100%;font-size:20px}
th,td{border:1px solid #2a3a5c;padding:14px 16px;text-align:center}
th{background:#1b263b;color:#00d4ff;font-size:18px}
tr:nth-child(even){background:#162033}
tr:hover{background:#1e2d4a}
.footer{color:#555;margin-top:25px;font-size:16px}
</style></head><body>
<h1>🎯 孙总布林带引擎</h1>
<div class="summary">
  <span><b>余额:</b>$${(engine.balance||0).toFixed(2)}</span>
  <span><b>持仓:</b>${Object.keys(engine.positions||{}).length}/${CONFIG.maxPositions}</span>
  <span><b>杠杆:</b>${CONFIG.leverage}x</span>
  <span><b>K线:</b>${CONFIG.klineInterval}</span>
  <span><b>止盈触发:</b>≥${CONFIG.profitTriggerPct}%</span>
  <span><b>单K止损:</b>≥${CONFIG.singleKLossPct}%</span>
  <span><b>终极止损:</b>≥${CONFIG.ultimateLossPct}%</span>
</div>
<table>
<tr><th>币种</th><th>方向</th><th>数量</th><th>开仓价</th><th>当前价</th><th>浮盈%</th><th>浮盈$</th><th>补仓</th><th>止盈模式</th></tr>
${positions || '<tr><td colspan="9" style="padding:30px;color:#666">无持仓</td></tr>'}
</table>
<p class="footer">自动刷新10s | Port ${PORT}</p>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } else if (req.url === '/api/positions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      balance: engine.balance,
      positions: engine.positions,
      config: {
        maxPositions: CONFIG.maxPositions,
        leverage: CONFIG.leverage,
        klineInterval: CONFIG.klineInterval,
      },
    }, null, 2));
  } else if (req.url === '/api/stop') {
    engine.stop();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, msg: '引擎已停止' }));
    setTimeout(() => process.exit(0), 1000);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`📊 BB Engine Dashboard: http://localhost:${PORT}`);
  console.log(`📋 API: http://localhost:${PORT}/api/positions`);
  console.log(`🛑 停止: http://localhost:${PORT}/api/stop`);
  console.log('');

  // 启动引擎
  engine.start().catch(e => {
    console.error('❌ 引擎启动失败:', e.message);
    process.exit(1);
  });
});

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n🛑 收到退出信号...');
  engine.stop();
  engine._saveState();
  setTimeout(() => process.exit(0), 500);
});

process.on('SIGTERM', () => {
  engine.stop();
  engine._saveState();
  setTimeout(() => process.exit(0), 500);
});
