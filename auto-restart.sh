#!/bin/bash
# ═══════════════════════════════════════════════════════════
# 🚀 Auto-Restart — 环境重启后自动拉起整个量化机器人系统
#
# 守护目标:
#   quant 端口 10060  (TZ=Asia/Shanghai node quant/start.js)
#   saas  端口 10010/10020 (TZ=Asia/Shanghai node saas/start.js)
#   guard-all 看门狗   (TZ=Asia/Shanghai node guard-all.js)
#
# 用法: bash auto-restart.sh
# 挂载: .bashrc / .profile / cron / 启动钩子 都会调它
# 幂等: 已运行的服务不重复启动
# ═══════════════════════════════════════════════════════════
LOG=/tmp/auto-restart.log
WORKDIR=/app/workspace/ai-quant-agent
cd "$WORKDIR" 2>/dev/null || { echo "$(date) ❌ 找不到工作目录" >> "$LOG"; exit 1; }

log(){ echo "$(date '+%F %T') $1" >> "$LOG"; }

# 并行异步启动, 避免阻塞
start_async(){ ( "$@" >> "$LOG" 2>&1 & ); }

# 检查端口是否被监听
port_listening(){ ss -ltn 2>/dev/null | grep -q ":$1 " ; }

ensure_quant(){
  if port_listening 10060; then
    log "✅ quant(10060) 已运行"
  else
    log "🚀 启动 quant(10060)..."
    start_async env TZ=Asia/Shanghai node quant/start.js
  fi
}

ensure_saas(){
  if port_listening 10010; then
    log "✅ dashboard(10010)/saas(10020) 已运行"
  else
    log "🚀 启动 saas(10010/10020)..."
    start_async env TZ=Asia/Shanghai node saas/start.js
  fi
}

ensure_guard(){
  if pgrep -f "guard-all.js" >/dev/null 2>&1; then
    log "✅ guard-all 看门狗 已运行"
  else
    log "🚀 启动 guard-all 看门狗..."
    start_async env TZ=Asia/Shanghai node guard-all.js
  fi
}

log "═══ Auto-Restart 触发 ═══"
ensure_quant
ensure_saas
ensure_guard
log "═══ 完成 ═══"
