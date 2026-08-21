#!/bin/bash
# ═══════════════════════════════════════════════════════════
# 🐕 量化系统保活看门狗 — 常驻循环, 每30秒检查三个核心服务
# 死了立即自动重启, 用 process 工具启动此脚本本身长期运行
# ═══════════════════════════════════════════════════════════
LOG=/app/workspace/ai-quant-agent/logs/watchdog-cron.log
WORKDIR=/app/workspace/ai-quant-agent
mkdir -p "$(dirname "$LOG")"

log(){ echo "$(date '+%F %T') $1" >> "$LOG"; }

port_alive(){ ss -ltn 2>/dev/null | grep -q ":$1 "; }

ensure_quant(){
  if port_alive 10060; then
    return 0
  fi
  log "⚠️ quant(10060) 已死, 重启中..."
  cd "$WORKDIR" && NODE_OPTIONS="--max-old-space-size=512" TZ=Asia/Shanghai nohup node quant/start.js >> "$LOG" 2>&1 &
  sleep 8
  if port_alive 10060; then log "✅ quant(10060) 重启成功"; else log "❌ quant(10060) 重启失败"; fi
}

ensure_saas(){
  if port_alive 10010; then
    return 0
  fi
  log "⚠️ saas(10010/10020/10030) 已死, 重启中..."
  cd "$WORKDIR" && TZ=Asia/Shanghai nohup node saas/start.js >> "$LOG" 2>&1 &
  sleep 8
  if port_alive 10010; then log "✅ saas 重启成功"; else log "❌ saas 重启失败"; fi
}

log "═══ watchdog-cron 启动, 每30秒检查一次 ═══"
while true; do
  ensure_quant
  ensure_saas
  sleep 30
done
