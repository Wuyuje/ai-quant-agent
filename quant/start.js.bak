// 新量化智能体 · 启动入口
const { QuantServer } = require('./quant-server');
const PORT = process.env.QUANT_PORT ? parseInt(process.env.QUANT_PORT) : 10060;
const server = new QuantServer();
server.start(PORT);
