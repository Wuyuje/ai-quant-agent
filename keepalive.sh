#!/bin/bash
# ════════════════════════════════════════════════════════════
# keepalive.sh — 量化机器人第二层守护
# 作用: 每 60 秒检查 watchdog 是否活着，死了就拉起
# 启动方式: nohup bash keepalive.sh > /dev/null 2>&1 &
# ════════════════════════════════════════════════════════════

cd "$(dirname "$0")"

LOG_FILE="logs/keepalive.log"
WATCHDOG_PATTERN="node saas/watchdog.js"
CHECK_INTERVAL=60

mkdir -p logs

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [keepalive] $1" >> "$LOG_FILE"
}

log "🚀 keepalive 启动 (每 ${CHECK_INTERVAL}s 检查 watchdog)"

while true; do
  # 检查 watchdog 是否在运行
  if pgrep -f "$WATCHDOG_PATTERN" > /dev/null 2>&1; then
    # watchdog 活着，不打日志（避免日志爆炸）
    :
  else
    log "⚠️ watchdog 未运行，启动新实例..."
    nohup node saas/watchdog.js > /dev/null 2>&1 &
    sleep 5
    if pgrep -f "$WATCHDOG_PATTERN" > /dev/null 2>&1; then
      log "✅ watchdog 已启动 (PID=$(pgrep -f "$WATCHDOG_PATTERN" | head -1))"
    else
      log "❌ watchdog 启动失败，下次重试"
    fi
  fi
  sleep "$CHECK_INTERVAL"
done
