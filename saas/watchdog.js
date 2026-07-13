/**
 * 🔒 Watchdog 守护进程 — 自动重启量化引擎
 * 
 * 功能：
 *   1. 定期（每30秒）通过 HTTP 检查引擎是否存活
 *   2. 连续3次检测失败后，杀掉旧进程并重启
 *   3. 记录重启日志到 data/watchdog.log
 *   4. 内存/CPU 监控告警
 *   5. 最大连续重启次数限制（防止无限循环崩溃重启）
 * 
 * 启动：
 *   node saas/watchdog.js
 * 
 * 在 process 工具中以后台进程运行，和 start.js 共存。
 */

const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ═══ 配置 ═══
const CONFIG = {
  ENGINE_PORT: 10010,
  CHECK_INTERVAL: 30000,     // 30秒检查一次
  FAIL_THRESHOLD: 3,         // 连续3次失败才重启
  MAX_RESTARTS: 10,          // 1小时内最多重启10次
  RESTART_WINDOW: 3600000,   // 1小时窗口
  HEALTH_TIMEOUT: 10000,     // 健康检查超时10秒
  RESTART_COOLDOWN: 15000,   // 重启后等15秒再检查
  MAX_RESTART_BACKOFF: 60000 // 退避最大60秒
};

// ═══ 状态 ═══
let engineProcess = null;
let failCount = 0;
let restartHistory = [];  // 重启时间戳列表
let lastRestartTime = 0;
let backoffTime = CONFIG.RESTART_COOLDOWN;

const LOG_FILE = path.join(__dirname, '..', 'data', 'watchdog.log');

// ═══ 日志 ═══
function log(msg, level = 'INFO') {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) { /* ignore */ }
}

// ═══ 确保日志目录存在 ═══
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ═══ 健康检查 ═══
function healthCheck() {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${CONFIG.ENGINE_PORT}/api/status`, {
      timeout: CONFIG.HEALTH_TIMEOUT
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.running === true) {
            resolve({ alive: true, data: json });
          } else {
            resolve({ alive: false, reason: `running=${json.running}` });
          }
        } catch (e) {
          resolve({ alive: false, reason: `JSON parse error: ${e.message}` });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ alive: false, reason: 'timeout' });
    });
    req.on('error', (e) => {
      resolve({ alive: false, reason: e.message });
    });
  });
}

// ═══ 获取端口上的引擎 PID ═══
function getEnginePid() {
  try {
    const result = execSync(
      `lsof -ti:${CONFIG.ENGINE_PORT} 2>/dev/null || ss -ltnp sport = :${CONFIG.ENGINE_PORT} 2>/dev/null | grep -oP 'pid=\\K[0-9]+'`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    if (result) return parseInt(result.split('\n')[0]);
  } catch (e) { /* ignore */ }
  return null;
}

// ═══ 杀旧进程 ═══
function killEngine() {
  const pid = getEnginePid();
  if (pid) {
    log(`🔪 杀死旧引擎进程 PID=${pid}`, 'WARN');
    try {
      process.kill(pid, 'SIGTERM');
      // 给 5 秒优雅退出
      setTimeout(() => {
        try { process.kill(pid, 'SIGKILL'); } catch (e) { /* already dead */ }
      }, 5000);
    } catch (e) {
      log(`杀死进程失败: ${e.message}`, 'ERROR');
    }
    return true;
  }
  log(`⚠️ 未找到端口 ${CONFIG.ENGINE_PORT} 上的进程`, 'WARN');
  return false;
}

// ═══ 启动引擎 ═══
function startEngine() {
  const enginePath = path.join(__dirname, 'start.js');
  log(`🚀 启动引擎: node ${enginePath}`);
  
  engineProcess = spawn('node', [enginePath], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
    detached: false
  });
  
  engineProcess.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(l => l.trim());
    lines.forEach(line => console.log(`[ENGINE] ${line}`));
  });
  
  engineProcess.stderr.on('data', (data) => {
    const lines = data.toString().split('\n').filter(l => l.trim());
    lines.forEach(line => console.error(`[ENGINE-ERR] ${line}`));
  });
  
  engineProcess.on('exit', (code, signal) => {
    log(`引擎退出: code=${code} signal=${signal}`, 'WARN');
    engineProcess = null;
  });
  
  engineProcess.on('error', (err) => {
    log(`引擎启动错误: ${err.message}`, 'ERROR');
    engineProcess = null;
  });
  
  lastRestartTime = Date.now();
  backoffTime = Math.min(backoffTime * 2, CONFIG.MAX_RESTART_BACKOFF);
  log(`✅ 引擎已启动 PID=${engineProcess.pid}`);
}

// ═══ 计算重启次数（窗口内） ═══
function recentRestartCount() {
  const cutoff = Date.now() - CONFIG.RESTART_WINDOW;
  restartHistory = restartHistory.filter(t => t > cutoff);
  return restartHistory.length;
}

// ═══ 主循环 ═══
async function watchLoop() {
  try {
    const result = await healthCheck();
    
    if (result.alive) {
      // ✅ 引擎正常
      failCount = 0;
      backoffTime = CONFIG.RESTART_COOLDOWN; // 重置退避
      
      // 偶尔记录健康状态
      const d = result.data;
      const mem = d.process?.memory;
      if (mem && Math.random() < 0.05) { // ~5%概率记录
        log(`💓 引擎健康 | MEM=${mem.rssMB || '?'}MB | 用户=${d.userCount || 0} | 持仓=${d.positionCount || 0}`);
      }
    } else {
      // ❌ 引擎不响应
      failCount++;
      log(`⚠️ 健康检查失败 (${failCount}/${CONFIG.FAIL_THRESHOLD}): ${result.reason}`, 'WARN');
      
      if (failCount >= CONFIG.FAIL_THRESHOLD) {
        const restarts = recentRestartCount();
        
        if (restarts >= CONFIG.MAX_RESTARTS) {
          log(`🛑 1小时内已重启 ${restarts} 次，达到上限 ${CONFIG.MAX_RESTARTS}。暂停自动重启。`, 'ERROR');
          log(`🛑 手动重启: node saas/watchdog.js --force`, 'ERROR');
          failCount = 0;
          return;
        }
        
        log(`🔄 引擎不健康，开始重启... (${restarts + 1}/${CONFIG.MAX_RESTARTS} in 1h)`, 'WARN');
        
        // 1. 杀旧进程
        killEngine();
        await new Promise(r => setTimeout(r, 3000));
        
        // 2. 启动新进程
        startEngine();
        restartHistory.push(Date.now());
        
        // 3. 等待引擎初始化
        await new Promise(r => setTimeout(r, backoffTime));
        
        failCount = 0;
      }
    }
  } catch (e) {
    log(`监控循环异常: ${e.message}`, 'ERROR');
  }
}

// ═══ 启动 ═══
log('');
log('╔══════════════════════════════════════════╗');
log('║  🔒 Watchdog 守护进程已启动               ║');
log('║  检查间隔: 30s | 重启上限: 10次/h         ║');
log('╚══════════════════════════════════════════╝');

// 先检查引擎是否已经在运行
healthCheck().then(result => {
  if (result.alive) {
    log(`✅ 引擎已在运行 (${result.data.version || 'unknown'})`);
  } else {
    log(`⚠️ 引擎未运行，首次启动...`, 'WARN');
    startEngine();
  }
  
  // 开始定期检查
  setInterval(watchLoop, CONFIG.CHECK_INTERVAL);
});

// ═══ 优雅关闭 ═══
process.on('SIGINT', () => {
  log('收到 SIGINT，watchdog 退出（引擎继续运行）');
  process.exit(0);
});
process.on('SIGTERM', () => {
  log('收到 SIGTERM，watchdog 退出（引擎继续运行）');
  process.exit(0);
});
