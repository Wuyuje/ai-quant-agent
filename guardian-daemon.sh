#!/bin/bash
# 永不死机守护进程 - 自动重启所有服务

LOG="/app/workspace/ai-quant-agent/data/guardian.log"
PID_FILE="/app/workspace/ai-quant-agent/data/pids.txt"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG"
  echo "$1"
}

# 清理僵尸进程
cleanup_zombies() {
  local zombie_count=$(ps aux | grep -c '\[node\] <defunct>')
  if [ "$zombie_count" -gt 10 ]; then
    log "⚠️ 发现 $zombie_count 个僵尸进程，尝试清理..."
    # 找到僵尸进程的父进程并发送 SIGCHLD
    ps aux | grep '\[node\] <defunct>' | awk '{print $3}' | sort -u | while read ppid; do
      if [ -n "$ppid" ] && [ "$ppid" != "0" ]; then
        kill -SIGCHLD "$ppid" 2>/dev/null
      fi
    done
  fi
}

# 检查内存
check_memory() {
  local mem_used=$(free -m | awk '/Mem:/ {print $3}')
  local mem_total=$(free -m | awk '/Mem:/ {print $2}')
  local mem_pct=$((mem_used * 100 / mem_total))
  
  if [ "$mem_pct" -gt 90 ]; then
    log "🚨 内存使用 ${mem_pct}%，清理缓存..."
    # 清理系统缓存
    sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
    # 清理 Node.js 缓存
    node --expose-gc -e "global.gc && global.gc()" 2>/dev/null || true
  fi
  
  echo "$mem_pct"
}

# 检查磁盘
check_disk() {
  local disk_used=$(df -h / | tail -1 | awk '{print $5}' | tr -d '%')
  
  if [ "$disk_used" -gt 85 ]; then
    log "🚨 磁盘使用 ${disk_used}%，清理日志..."
    # 保留最近1000行日志
    tail -1000 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG" 2>/dev/null || true
    # 清理旧的 state 文件
    find /app/workspace/ai-quant-agent/data -name "*.json" -mtime +7 -delete 2>/dev/null || true
  fi
  
  echo "$disk_used"
}

# 启动主程序
start_main() {
  local port=8010
  local pid=$(ss -ltnp | grep ":$port " | grep -oP 'pid=\K\d+' | head -1)
  
  if [ -n "$pid" ]; then
    # 检查进程是否健康
    if kill -0 "$pid" 2>/dev/null; then
      local cpu=$(ps -p "$pid" -o %cpu= 2>/dev/null | tr -d ' ')
      if [ -n "$cpu" ] && [ "$cpu" -gt 90 ]; then
        log "⚠️ 进程 $pid CPU ${cpu}%，疑似死循环，重启..."
        kill -9 "$pid" 2>/dev/null
        sleep 2
      else
        return 0  # 进程正常
      fi
    else
      log "⚠️ 进程 $pid 已死，重启..."
      kill -9 "$pid" 2>/dev/null
      sleep 2
    fi
  fi
  
  log "🚀 启动主程序..."
  cd /app/workspace/ai-quant-agent
  node saas/start.js 2>&1 &
  local new_pid=$!
  echo "$new_pid" > "$PID_FILE"
  log "✅ 主程序已启动 PID=$new_pid"
}

# 主循环
log "🛡️ 守护进程启动"
while true; do
  # 每30秒检查一次
  sleep 30
  
  # 清理僵尸进程
  cleanup_zombies
  
  # 检查内存
  mem_pct=$(check_memory)
  
  # 检查磁盘
  disk_pct=$(check_disk)
  
  # 启动主程序（如果没运行）
  start_main
  
  # 每100轮打印状态
  if [ $((RANDOM % 100)) -eq 0 ]; then
    log "📊 状态: 内存=${mem_pct}% 磁盘=${disk_pct}% PID=$(cat $PID_FILE 2>/dev/null)"
  fi
done
