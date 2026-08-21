#!/usr/bin/env node
/**
 * A策略定时监控(占位/精简版)
 * 原全量监控已废弃, 这里保留为一个可正常启动的占位进程
 * 避免 start.js spawn 时因文件不存在导致主进程崩溃
 */
const http = require('http');
// 最小可用监控: 定时ping SaaS健康
const EVERY_HOUR = 60 * 60 * 1000;
console.log('[Monitor] A策略监控(占位)已启动');
setInterval(() => {
  try {
    http.get('http://localhost:10020/api/health', r => {}).on('error', () => {});
  } catch(e){}
}, EVERY_HOUR);
// 保持进程存活
setInterval(() => {}, 86400000);
