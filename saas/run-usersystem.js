// 启动前加载 .env
try {
  const fs = require('fs'); const path = require('path');
  const envFile = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile,'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  }
} catch(e){}
// 普通用户仪表盘启动器: 用旧 saas/server.js (null engine), 服务登录/注册/APIkey/充值/算力费
// 兼容旧URL与注册程序, 不改变. 同时挂载新量化智能体agent供用户看自己策略数据.
const path = require('path');
const SaasServer = require('./server');
const PORT = process.env.USERSYS_PORT ? parseInt(process.env.USERSYS_PORT) : 10020;
try {
  // fake engine (只提供旧server引用的字段, 避免null崩溃; 真实策略由quant-agent提供)
const fakeEngine = {
  brain:{}, dataBus:{ marketData:{}, getKlines:async()=>[], getAllTickers:async()=>[] },
  engineState:{}, guardian:{ getAllPositions:()=>({}) }, tradeLog:[], cycleCount:0,
  aiEngine:{ feedUserFeedback:()=>{} },
};
const server = new SaasServer(fakeEngine, PORT, { userDBOnly: true });
  server.start();
  console.log(`[UserSystem] 🌐 普通用户仪表盘: http://localhost:${PORT} (登录/注册/APIkey/充值/算力费)`);
} catch(e) { console.error('[UserSystem] ❌ 启动失败:', e.message); process.exit(1); }
