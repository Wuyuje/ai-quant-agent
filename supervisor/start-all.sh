#!/bin/bash
# ═══════════════════════════════════════════
# 三机器人统一启动脚本 (v2.0 — 带 Watchdog 互相守护)
# Supervisor + RepairBot + QuantEngine + Watchdog
# 各自独立进程,互相守护,永不停止
# ═══════════════════════════════════════════

cd "$(dirname "$0")/.."

echo "🚀 启动三机器人系统 (v2.0 带Watchdog)..."
echo ""

# 1. 先杀掉旧进程
echo "🧹 清理旧进程..."
pkill -f "node.*supervisor.js" 2>/dev/null || true
pkill -f "node.*repairbot.js" 2>/dev/null || true
pkill -f "supervisor/watchdog.sh" 2>/dev/null || true
sleep 2

# 2. 启动量化引擎 (如果没在运行)
if ! pgrep -f "node.*saas/start.js" > /dev/null 2>&1; then
  echo "📈 启动量化引擎..."
  node saas/start.js &
  QUANT_PID=$!
  echo "   PID: $QUANT_PID"
  sleep 10  # 等引擎先启动
else
  echo "📈 量化引擎已在运行"
fi

# 3. 启动监督机器人
echo "👁️ 启动监督机器人 Supervisor..."
node supervisor/supervisor.js &
SUPERVISOR_PID=$!
echo "   PID: $SUPERVISOR_PID"

# 4. 启动修复机器人
echo "🔧 启动修复机器人 RepairBot..."
node supervisor/repairbot.js &
REPAIRBOT_PID=$!
echo "   PID: $REPAIRBOT_PID"

# 5. 启动 Watchdog (互相守护)
echo "🛡️ 启动 Watchdog 守护进程..."
bash supervisor/watchdog.sh &
WATCHDOG_PID=$!
echo "   PID: $WATCHDOG_PID"

echo ""
echo "═══════════════════════════════════════════"
echo "  🤖 三机器人系统已启动 (v2.0 互相守护)"
echo "  📈 量化引擎:  PID $QUANT_PID     (端口 10010)"
echo "  👁️ 监督机器人: PID $SUPERVISOR_PID  (15秒检测)"
echo "  🔧 修复机器人: PID $REPAIRBOT_PID  (3秒轮询)"
echo "  🛡️ Watchdog:   PID $WATCHDOG_PID  (10秒守护)"
echo "═══════════════════════════════════════════"
echo ""

# 等待所有子进程
wait
