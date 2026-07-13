/**
 * AI Quant Agent v83 — 入口文件
 * v83: 百万级架构 — ClusterManager 支持多进程
 */
const { startCluster } = require('./saas/cluster-manager');
const path = require('path');

// 如果 WORKERS > 1，ClusterManager 会 fork 多个 worker
// 每个 worker 重新执行这个文件，但 cluster.isWorker === true
startCluster(path.join(__dirname, 'index-main.js'));
