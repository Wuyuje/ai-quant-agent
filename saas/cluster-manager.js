/**
 * cluster-manager.js — 多进程管理器
 * 
 * 小配置 (WORKERS=0 或未设置): 单进程，零开销
 * 大配置 (WORKERS=auto 或数字): fork Worker 利用多核
 * 
 * 环境变量:
 *   WORKERS=0      → 单进程 (默认)
 *   WORKERS=auto   → CPU核数-1
 *   WORKERS=N      → N个Worker
 */

const cluster = require('cluster');
const os = require('os');

const NUM_CPUS = os.cpus().length;

function getWorkerCount() {
  const env = process.env.WORKERS;
  if (!env || env === '0') return 1;
  if (env === 'auto') return Math.max(1, NUM_CPUS - 1);
  const n = parseInt(env, 10);
  return isNaN(n) ? 1 : Math.max(1, Math.min(n, NUM_CPUS));
}

function startCluster(entryPoint) {
  const workers = getWorkerCount();
  const isPrimary = cluster.isPrimary || cluster.isMaster; // 兼容不同 Node 版本

  if (workers <= 1) {
    // 单进程模式：直接加载主逻辑
    console.log(`[Cluster] 单进程模式 (WORKERS=${process.env.WORKERS || '0'})`);
    require(entryPoint);
    return;
  }

  if (!isPrimary) {
    // Worker 中：直接加载主逻辑
    require(entryPoint);
    return;
  }

  // 主进程：fork Workers
  console.log(`[Cluster] 主进程 PID=${process.pid} | CPU核数=${NUM_CPUS} | 启动 ${workers} 个 Worker`);

  for (let i = 0; i < workers; i++) {
    const worker = cluster.fork();
    console.log(`[Cluster] Worker ${worker.process.pid} 启动`);
  }

  cluster.on('exit', (worker, code, signal) => {
    console.error(`[Cluster] Worker ${worker.process.pid} 挂了 (${signal || code})，3s后重启`);
    setTimeout(() => {
      const w = cluster.fork();
      console.log(`[Cluster] 新 Worker ${w.process.pid} 已启动`);
    }, 3000);
  });

  // 优雅关闭
  const shutdown = () => {
    console.log('[Cluster] 关闭所有 Worker...');
    for (const id in cluster.workers) {
      cluster.workers[id].process.kill('SIGTERM');
    }
    setTimeout(() => process.exit(0), 5000);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { startCluster, getWorkerCount };
