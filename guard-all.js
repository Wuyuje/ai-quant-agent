#!/usr/bin/env node
/**
 * 🛡️ Guard-All — 量化机器人群守护进程（quant + saas/dashboard）
 *
 * 守护目标：
 *   - quant  端口 10060  (量化三策略引擎, 启动: TZ=Asia/Shanghai node quant/start.js)
 *   - saas   端口 10010  (用户仪表盘, 启动: TZ=Asia/Shanghai node saas/start.js)
 *   - saas   端口 10020  (SaaS 后端, 与 10010 同进程)
 *
 * 检测: 每 30s HTTP GET 健康地址, 连续 3 次失败 → 重启对应服务
 * 重启: 用 child_process.spawn 启动, 不碰 Binance 持仓
 * 限制: 每个服务 1 小时内最多重启 15 次 (防死循环)
 *
 * 启动: node guard-all.js  (用 process 工具以后台进程运行)
 */
const { spawn } = require('child_process');
const http = require('http');

const SERVICES = [
  {
    name: 'quant',
    port: 10060,
    check: () => httpGet('http://localhost:10060/api/quant/health'),
    start: () => startProc('quant', 'quant/start.js'),
  },
  {
    name: 'dashboard',
    port: 10010,
    check: () => httpGet('http://localhost:10010/api/status'),
    start: () => startProc('dashboard', 'saas/start.js'),
  },
  {
    name: 'saas',
    port: 10020,
    // 10020 和 10010 是同一进程 (saas/start.js 同时起 dashboard+saas), 由 dashboard 守护兜住
    check: async () => { try { const r = await httpGet('http://localhost:10020/'); return r; } catch (e) { return false; } },
    // 不作为独立重启目标, 依赖 dashboard
    start: null,
    passive: true,
  },
];

const CFG = {
  CHECK_INTERVAL: 30000,
  FAIL_THRESHOLD: 3,
  MAX_RESTARTS: 15,
  RESTART_WINDOW: 3600000,
  RESTART_COOLDOWN: 15000,
};

const failCount = { quant: 0, dashboard: 0, saas: 0 };
const restartHistory = {}; // name -> [timestamps]
let runningProcs = {};

function httpGet(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve(res.statusCode === 200 || res.statusCode === 404));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[guard-${ts}] ${msg}`);
}

function canRestart(name) {
  if (!restartHistory[name]) return true;
  const window = restartHistory[name].filter(t => Date.now() - t < CFG.RESTART_WINDOW);
  return window.length < CFG.MAX_RESTARTS;
}

function startProc(name, script) {
  // 若已有进程在跑则不重复启动
  if (runningProcs[name]) return;
  log(`🔄 重启 ${name}: TZ=Asia/Shanghai node ${script}`);
  const child = spawn('node', [script], {
    cwd: '/app/workspace/ai-quant-agent',
    env: { ...process.env, TZ: 'Asia/Shanghai' },
    stdio: 'inherit',
    detached: false,
  });
  runningProcs[name] = child;
  child.on('exit', (code, signal) => {
    log(`⚠️ ${name} 进程退出 (code=${code}, signal=${signal})`);
    if (runningProcs[name] === child) runningProcs[name] = null;
  });
}

async function ensureService(svc) {
  const ok = await svc.check();
  if (ok) {
    failCount[svc.name] = 0;
    return;
  }
  failCount[svc.name] = (failCount[svc.name] || 0) + 1;
  log(`❌ ${svc.name} 健康检查失败 ${failCount[svc.name]}/${CFG.FAIL_THRESHOLD}`);
  if (failCount[svc.name] >= CFG.FAIL_THRESHOLD && !svc.passive && svc.start) {
    if (canRestart(svc.name)) {
      if (!restartHistory[svc.name]) restartHistory[svc.name] = [];
      restartHistory[svc.name].push(Date.now());
      log(`🚨 重启 ${svc.name} (第${restartHistory[svc.name].length}次)`);
      svc.start();
      failCount[svc.name] = 0;
    } else {
      log(`🚫 ${svc.name} 1小时内重启超限(${CFG.MAX_RESTARTS}), 暂停`);
    }
  }
}

(async function main() {
  log('🛡️ 量化机器人群守护进程启动 (quant:10060 + dashboard:10010/saas:10020)');
  // 首次启动: 若端口未监听则拉起来
  for (const svc of SERVICES) {
    if (svc.passive || !svc.start) continue;
    const ok = await svc.check();
    if (ok) log(`✅ ${svc.name} 已在线 (端口 ${svc.port})`);
    else { log(`⚠️ ${svc.name} 离线, 启动中...`); svc.start(); await sleep(5000); }
  }
  setInterval(async () => {
    for (const svc of SERVICES) await ensureService(svc);
  }, CFG.CHECK_INTERVAL);
})().catch(e => log('初始化错误: ' + e.message));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
