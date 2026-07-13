#!/bin/bash
# ═══════════════════════════════════════════
# Watchdog v2.0 — 互相守护 (不杀引擎)
#
# 守护关系:
#  Watchdog → 监控 → Supervisor + Repairbot
#  引擎(start.js) 由 process 工具管理,Watchdog 不碰
#
# v2.0 改进:
#  - 不再检测/杀/重启引擎 — 避免无限重启循环
#  - 引擎启动需要~50秒,15秒检测必然误判
#  - 只守护 Supervisor(10020) 和 Repairbot(10030)
#  - API 健康检查为主
# ═══════════════════════════════════════════

cd "$(dirname "$0")/.."

# ── 配置 ──
CHECK_INTERVAL=30          # 检测间隔(秒) — 30秒够慢不会误判
MAX_RESTART_PER_MIN=2      # 每分钟最大重启次数
LOG_DIR="supervisor/logs"
LOG_FILE="$LOG_DIR/watchdog.log"
mkdir -p "$LOG_DIR"

# 重启计数
restart_count=0
restart_window_start=$(date +%s)

# 上次事件(去重)
last_supervisor_event=""
last_repairbot_event=""

# ── 日志 ──
log() {
  local ts=$(date '+%Y-%m-%dT%H:%M:%S')
  echo "[$ts] [WATCHDOG] $1" >> "$LOG_FILE"
  echo "[$ts] [WATCHDOG] $1"
}

log_once() {
  local key=$1; shift
  local msg=$1
  local varname="last_${key}_event"
  local prev=$(eval echo \$$varname)
  if [ "$prev" != "$msg" ]; then
    log "$msg"
    eval "$varname='$msg'"
  fi
}

# ── 忽略信号 ──
trap '' SIGINT SIGTERM SIGHUP
log "🛡️ Watchdog v2.0 启动 — 只守护 Supervisor + Repairbot"
log "📊 检测间隔: ${CHECK_INTERVAL}秒 | 引擎由 process 工具管理,不干预"

# ── API 健康检测 ──
check_supervisor_api() {
  curl -s --connect-timeout 5 --max-time 8 "http://localhost:10020/api/health" > /dev/null 2>&1
}

check_repairbot_api() {
  curl -s --connect-timeout 5 --max-time 8 "http://localhost:10030/api/health" > /dev/null 2>&1
}

# ── 启动函数 ──
start_supervisor() {
  log "👁️ 拉起监督机器人..."
  nohup node supervisor/supervisor.js >> "$LOG_DIR/supervisor.log" 2>&1 &
  log "   监督机器人 PID: $!"
}

start_repairbot() {
  log "🔧 拉起修复机器人..."
  nohup node supervisor/repairbot.js >> "$LOG_DIR/repairbot.log" 2>&1 &
  log "   修复机器人 PID: $!"
}

# ── 重启限流 ──
can_restart() {
  local now=$(date +%s)
  local elapsed=$((now - restart_window_start))
  if [ $elapsed -gt 60 ]; then
    restart_count=0
    restart_window_start=$now
  fi
  if [ $restart_count -ge $MAX_RESTART_PER_MIN ]; then
    log "⚠️ 重启次数超限(${MAX_RESTART_PER_MIN}/分钟),暂停60秒"
    sleep 60
    restart_count=0
    restart_window_start=$now
  fi
  restart_count=$((restart_count + 1))
  return 0
}

# ── 主循环 ──
while true; do
  now_ts=$(date '+%H:%M:%S')

  # 1. 检测监督机器人
  if ! check_supervisor_api; then
    log_once "supervisor" "🚨 [监督机器人] API无响应 @ $now_ts"
    sleep 10
    if ! check_supervisor_api; then
      log "🚨 [监督机器人] 仍无响应,强制重启 @ $now_ts"
      if can_restart; then
        pgrep -f "node.*supervisor/supervisor.js" | xargs kill -9 2>/dev/null
        sleep 2
        start_supervisor
        last_supervisor_event=""
      fi
    fi
  else
    log_once "supervisor" "✅ 监督机器人正常"
  fi

  # 2. 检测修复机器人
  if ! check_repairbot_api; then
    log_once "repairbot" "🚨 [修复机器人] API无响应 @ $now_ts"
    sleep 10
    if ! check_repairbot_api; then
      log "🚨 [修复机器人] 仍无响应,强制重启 @ $now_ts"
      if can_restart; then
        pgrep -f "node.*supervisor/repairbot.js" | xargs kill -9 2>/dev/null
        sleep 2
        start_repairbot
        last_repairbot_event=""
      fi
    fi
  else
    log_once "repairbot" "✅ 修复机器人正常"
  fi

  sleep $CHECK_INTERVAL
done
