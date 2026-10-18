// 新量化智能体 · 启动入口
const { QuantServer } = require('./quant-server');
const PORT = process.env.QUANT_PORT ? parseInt(process.env.QUANT_PORT) : 10060;
const server = new QuantServer();

// 保持进程存活(async start 需 await, 否则 Node 无活跃handle会退出)
server.start(PORT).catch(e => { console.error('[QuantServer] start失败:', e); });

process.on('uncaughtException', e => console.error('[QuantServer] uncaught:', e && e.message));
process.on('unhandledRejection', e => console.error('[QuantServer] unhandled:', e && e.message));

// keep-alive: 防止事件循环空转退出
setInterval(() => {}, 1 << 30);
