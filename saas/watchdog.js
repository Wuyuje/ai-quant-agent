/**
 * 🔒 Watchdog — 量化机器人 B 策略 (BBStrategy) 唯一守护进程
 *
 * 设计原则：
 *   1. 只做一件事：检测 saas 是否健康，不健康就重启
 *   2. 重启绝不碰 Binance 持仓 — 只 kill node 进程，Binance 上的仓位原封不动
 *   3. 重启后 saas 启动时会自动恢复监控现有持仓（ Guardian 同步机制）
 *   4. 单层守护，无 keepalive 之类多余进程
 *
 * 检测逻辑：
 *   - 每 30s HTTP GET http://localhost:10010/api/status
 *   - 连续 3 次失败 → 杀旧进程 → 启动新进程
 *   - 1 小时内最多重启 10 次（防止无限崩溃循环）
 *   - 退避：1 次=15s，2 次=30s，3 次+60s
 *
 * 资源监控：
 *   - 内存 > 3GB → 重启
 *   - CPU > 95% 持续 60s → 重启
 *
 * 启动：
 *   node saas/watchdog.js
 *
 * 通过 process 工具以后台进程运行，和 start.js 共存。
 */

const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ═══ 配置 ═══
const CONFIG = {
  // 健康检查端口（主端口，saas/start.js 启动后监听 10010）
  PRIMARY_PORT: 10010,
  HEALTH_URL: 'http://localhost:10010/api/status',

  CHECK_INTERVAL: 30000,       // 30 秒检查一次
  FAIL_THRESHOLD: 3,            // 连续 3 次失败才重启
  MAX_RESTARTS: 10,             // 1 小时内最多重启 10 次
  RESTART_WINDOW: 3600000,     // 1 小时窗口
  HEALTH_TIMEOUT: 10000,        // 健康检查超时 10 秒
  RESTART_COOLDOWN: 15000,     // 重启后等 15 秒再检查
  MAX_RESTART_BACKOFF: 60000,  // 退避最大 60 秒

  // 资源监控
  MEM_LIMIT_MB: 3072,          // 内存超 3GB 重启
  CPU_LIMIT_PCT: 95,           // CPU > 95% 持续 60s 重启
  CPU_SUSTAINED_SEC: 60,

  // 状态文件
  CRASH_STATE_FILE: path.join(__dirname, '..', 'data', 'engine-crash.state'),
  SHUTDOWN_STATE_FILE: path.join(__dirname, '..', 'data', 'engine-shutdown.state'),
  LOG_FILE: path.join(__dirname, '..', 'data', 'watchdog.log'),
};

// ═══ 状态 ═══
let engineProcess = null;       // watchdog 自己 spawn 的引擎（首次启动时）
let failCount = 0;
let restartHistory = [];
let lastRestartTime = 0;
let backoffTime = CONFIG.RESTART_COOLDOWN;
let cpuHighSince = 0;

// ═══ 日志 ═══
function log(msg, level = 'INFO') {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(CONFIG.LOG_FILE, line + '\n');
    // 日志轮转：超过 5MB 截断保留最后 1000 行
    const stats = fs.statSync(CONFIG.LOG_FILE);
    if (stats.size > 5 * 1024 * 1024) {
      const content = fs.readFileSync(CONFIG.LOG_FILE, 'utf-8');
      const lines = content.split('\n');
      fs.writeFileSync(CONFIG.LOG_FILE, lines.slice(-1000).join('\n'));
    }
  } catch (e) { /* ignore */ }
}

// 确保日志目录
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ═══ 健康检查 ═══
function healthCheck() {
  return new Promise((resolve) => {
    const req = http.get(CONFIG.HEALTH_URL, { timeout: CONFIG.HEALTH_TIMEOUT }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
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
      `lsof -ti:${CONFIG.PRIMARY_PORT} 2>/dev/null || ss -ltnp sport = :${CONFIG.PRIMARY_PORT} 2>/dev/null | grep -oP 'pid=\\K[0-9]+'`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    if (result) return parseInt(result.split('\n')[0]);
  } catch (e) { /* ignore */ }
  return null;
}

// ═══ 获取引擎进程资源占用 ═══
function getEngineResources(pid) {
  if (!pid) return null;
  try {
    const out = execSync(`ps -p ${pid} -o rss=,%cpu=,etimes= 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    const parts = out.split(/\s+/);
    return {
      rssKB: parseInt(parts[0]) || 0,
      cpuPct: parseFloat(parts[1]) || 0,
      elapsedSec: parseInt(parts[2]) || 0,
      rssMB: Math.round((parseInt(parts[0]) || 0) / 1024),
    };
  } catch (e) { return null; }
}

// ═══ 清理僵尸进程 ═══
function cleanupZombies() {
  try {
    const zombies = execSync("ps aux | grep '\\[node\\] <defunct>' | wc -l", {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    const count = parseInt(zombies) || 0;
    if (count > 20) {
      log(`🧟 发现 ${count} 个僵尸 node 进程，尝试清理...`, 'WARN');
      execSync(
        "ps -ef | grep '\\[node\\] <defunct>' | awk '{print $3}' | sort -u | while read ppid; do [ -n \"$ppid\" ] && [ \"$ppid\" != \"0\" ] && [ \"$ppid\" != \"1\" ] && kill -SIGCHLD $ppid 2>/dev/null; done",
        { timeout: 5000 },
      );
    }
  } catch (e) { /* ignore */ }
}

// ═══ 杀旧进程（只 kill node 进程，绝不碰 Binance 持仓）═══
function killEngine() {
  const pid = getEnginePid();
  if (pid) {
    log(`🔪 杀死旧引擎进程 PID=${pid}（Binance 持仓保留不动）`, 'WARN');
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
  // 兜底：杀所有 saas/start.js 进程
  try {
    execSync("pkill -9 -f 'node saas/start' 2>/dev/null", { timeout: 5000 });
    log('⚠️ 通过 pkill 杀死残留 saas 进程', 'WARN');
  } catch (e) { /* ignore */ }
  return false;
}

// ═══ 启动引擎 ═══
function startEngine() {
  const enginePath = path.join(__dirname, 'start.js');
  log(`🚀 启动引擎: node ${enginePath}`);

  // v113.67: 强制 PRIVATE_ACCESS=no 让管理员仪表盘可公网访问（web_publish 需要）
  engineProcess = spawn('node', [enginePath], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PRIVATE_ACCESS: 'no' },
    detached: false,
  });

  engineProcess.stdout.on('data', (data) => {
    // 只在 stdout 里出现 ERROR/FATAL 时才打印，避免日志爆炸
    const lines = data.toString().split('\n').filter((l) => l.trim());
    lines.forEach((line) => {
      if (/ERROR|FATAL|🚨|⚠️.*失败|uncaughtException|unhandledRejection/i.test(line)) {
        console.log(`[ENGINE] ${line}`);
      }
    });
  });

  engineProcess.stderr.on('data', (data) => {
    const lines = data.toString().split('\n').filter((l) => l.trim());
    lines.forEach((line) => console.error(`[ENGINE-ERR] ${line}`));
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

// ═══ 清理 state 文件 ═══
function clearCrashState() {
  try { fs.unlinkSync(CONFIG.CRASH_STATE_FILE); } catch (e) { /* not exist */ }
  try { fs.unlinkSync(CONFIG.SHUTDOWN_STATE_FILE); } catch (e) { /* not exist */ }
}

// ═══ 检测 crash state 文件 ═══
function checkCrashState() {
  try {
    if (fs.existsSync(CONFIG.CRASH_STATE_FILE)) {
      const content = JSON.parse(fs.readFileSync(CONFIG.CRASH_STATE_FILE, 'utf-8'));
      log(`🚨 检测到 crash state: ${content.reason} - ${content.msg}`, 'ERROR');
      return true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

// ═══ 计算窗口内重启次数 ═══
function recentRestartCount() {
  const cutoff = Date.now() - CONFIG.RESTART_WINDOW;
  restartHistory = restartHistory.filter((t) => t > cutoff);
  return restartHistory.length;
}

// ═══ 执行重启（统一逻辑）═══
async function doRestart(reason) {
  const restarts = recentRestartCount();
  if (restarts >= CONFIG.MAX_RESTARTS) {
    log(`🛑 1 小时内已重启 ${restarts} 次，达到上限。暂停自动重启。`, 'ERROR');
    return;
  }
  log(`🔄 ${reason} — 开始重启... (${restarts + 1}/${CONFIG.MAX_RESTARTS} in 1h)`, 'WARN');

  // 清理 crash state（避免重启后又立即检测到）
  clearCrashState();

  if (engineProcess) {
    // watchdog 自己 spawn 的，可以杀
    killEngine();
    await new Promise((r) => setTimeout(r, 3000));
  } else {
    // 引擎是别人启动的，写 crash state 让它自己退出
    try {
      fs.writeFileSync(CONFIG.CRASH_STATE_FILE,
        JSON.stringify({ reason: 'watchdog-' + reason, msg: reason, ts: Date.now() }));
    } catch (e) { /* ignore */ }
    // 等它自己检测到并退出（start.js 每 5s 检查一次 crash state，等 12s 给足时间）
    await new Promise((r) => setTimeout(r, 12000));
    // 如果还活着，强行 kill
    const pid = getEnginePid();
    if (pid) {
      log(`⚠️ 引擎未自行退出，强杀 PID=${pid}`, 'WARN');
      killEngine();
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // ⚠️ 启动新实例前再清一次 crash state
  // 否则新 saas 启动时检测到 state 又会立即退出，形成死循环
  clearCrashState();
  await new Promise((r) => setTimeout(r, 1000));

  startEngine();
  restartHistory.push(Date.now());
  await new Promise((r) => setTimeout(r, backoffTime));
  failCount = 0;
}

// ═══ 主监控循环 ═══
async function watchLoop() {
  try {
    // 0. 清理僵尸
    cleanupZombies();

    // 1. 检测 crash state 文件
    if (checkCrashState()) {
      log('🔄 engine-crash.state 检测到崩溃，立即重启', 'WARN');
      await doRestart('crash-state-detected');
      return;
    }

    // 2. 健康检查
    const result = await healthCheck();

    if (result.alive) {
      failCount = 0;
      backoffTime = CONFIG.RESTART_COOLDOWN;

      // 3. 资源监控
      const pid = getEnginePid();
      const resources = getEngineResources(pid);
      if (resources) {
        // 内存检查
        if (resources.rssMB > CONFIG.MEM_LIMIT_MB) {
          log(`🚨 引擎内存 ${resources.rssMB}MB 超限 (${CONFIG.MEM_LIMIT_MB}MB)`, 'ERROR');
          await doRestart(`内存超限 RSS=${resources.rssMB}MB`);
          return;
        }

        // CPU 持续高位检查
        if (resources.cpuPct > CONFIG.CPU_LIMIT_PCT) {
          if (cpuHighSince === 0) cpuHighSince = Date.now();
          const sustained = (Date.now() - cpuHighSince) / 1000;
          if (sustained > CONFIG.CPU_SUSTAINED_SEC) {
            log(`🚨 CPU ${resources.cpuPct.toFixed(1)}% 持续 ${sustained.toFixed(0)}s`, 'ERROR');
            await doRestart(`CPU超限 ${resources.cpuPct.toFixed(1)}%`);
            cpuHighSince = 0;
            return;
          }
        } else {
          cpuHighSince = 0;
        }

        // 偶尔记录健康状态
        if (Math.random() < 0.05) {
          log(`💓 引擎健康 | MEM=${resources.rssMB}MB CPU=${resources.cpuPct.toFixed(1)}% | uptime=${resources.elapsedSec}s`);
        }
      }
    } else {
      failCount++;
      log(`⚠️ 健康检查失败 (${failCount}/${CONFIG.FAIL_THRESHOLD}): ${result.reason}`, 'WARN');

      if (failCount >= CONFIG.FAIL_THRESHOLD) {
        await doRestart(`健康检查失败 ${result.reason}`);
      }
    }
  } catch (e) {
    log(`监控循环异常: ${e.message}`, 'ERROR');
  }
}

// ═══ 启动 ═══
log('');
log('╔══════════════════════════════════════════════╗');
log('║  🔒 Watchdog 守护进程已启动                   ║');
log('║  监控端口: 10010 | 检查间隔: 30s              ║');
log('║  重启上限: 10次/h | 内存: 3GB | CPU: 95%      ║');
log('║  ⚠️  重启时不平仓，Binance 持仓保留           ║');
log('╚══════════════════════════════════════════════╝');

// 首次启动：检查引擎是否已在运行（重试 10 次，每次 5 秒）
// 关键：如果端口被占用但 HTTP 不响应，说明引擎还在初始化，绝不启动第二个实例
async function waitForEngine(maxAttempts = 10) {
  let portOccupiedCount = 0;
  for (let i = 1; i <= maxAttempts; i++) {
    const result = await healthCheck();
    if (result.alive) {
      log(`✅ 检测到引擎已在运行 (attempt ${i}/${maxAttempts})`);
      return true;
    }
    const pid = getEnginePid();
    if (pid) {
      portOccupiedCount++;
      log(`⏳ 端口被占用 PID=${pid} 但 HTTP 未响应，等待初始化 (attempt ${i}/${maxAttempts}, portOccupied=${portOccupiedCount})`);
      // 端口被占用 >= 3 次，确认有其他进程在跑，绝不启动第二个
      if (portOccupiedCount >= 3) {
        log('✅ 端口被占用超过 3 次检查，确认有其他进程在跑，只监控不启动');
        return true;
      }
    } else {
      log(`⚠️ 端口未监听，引擎未启动 (attempt ${i}/${maxAttempts})`);
      portOccupiedCount = 0;
    }
    if (i < maxAttempts) await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

waitForEngine(10).then(async (alive) => {
  if (!alive) {
    log('⚠️ 引擎未运行，首次启动...', 'WARN');
    startEngine();
  }

  // 开始定期检查
  setInterval(watchLoop, CONFIG.CHECK_INTERVAL);
});

// 优雅关闭（watchdog 自己退出时不杀引擎）
process.on('SIGINT', () => {
  log('收到 SIGINT — watchdog 忽略，继续守护引擎');
  // v125: 不退出，继续守护引擎
});
process.on('SIGTERM', () => {
  log('收到 SIGTERM — watchdog 忽略，继续守护引擎');
  // v125: 不退出，继续守护引擎（避免进程终止信号杀死 watchdog）
});

// watchdog 自身异常不应影响引擎
process.on('uncaughtException', (err) => {
  log(`watchdog uncaughtException: ${err.message}`, 'ERROR');
  // v125: EPIPE 是 stdout/stderr 管道断裂，忽略
  if (err.code === 'EPIPE') return;
  // watchdog 自己出错时不退出，继续监控
});
process.on('unhandledRejection', (reason) => {
  log(`watchdog unhandledRejection: ${reason?.message || reason}`, 'ERROR');
  // watchdog 自己出错时不退出，继续监控
});

// v125: 忽略 stdout EPIPE 错误（避免 bash pipe 断裂导致 watchdog 崩溃）
process.stdout?.on?.('error', (err) => { if (err.code === 'EPIPE') return; throw err; });
process.stderr?.on?.('error', (err) => { if (err.code === 'EPIPE') return; throw err; });

// ═══ watchdog 自身心跳（每 5 分钟打一条，让用户知道 watchdog 还活着） ═══
setInterval(() => {
  const pid = getEnginePid();
  const resources = getEngineResources(pid);
  if (resources) {
    log(`💓 watchdog 心跳 | 引擎 PID=${pid} | MEM=${resources.rssMB}MB CPU=${resources.cpuPct.toFixed(1)}% | uptime=${resources.elapsedSec}s | restarts=${recentRestartCount()}/10`);
  } else {
    log(`💓 watchdog 心跳 | 引擎未运行 | restarts=${recentRestartCount()}/10`);
  }
}, 5 * 60 * 1000);
