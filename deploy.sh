#!/bin/bash
# ════════════════════════════════════════════════════════════
# 量化机器人云端部署脚本 — 整套系统 (A/B策略 + 所有程序)
# 用法: sudo bash deploy.sh
# ════════════════════════════════════════════════════════════

set -e

PROJECT_DIR="/opt/ai-quant-agent"
REPO_URL="https://github.com/Wuyuje/ai-quant-agent.git"

echo "═══════════════════════════════════════════════════════════"
echo "🚀 量化机器人云端部署 — 整套系统 (A/B策略 + 所有程序)"
echo "═══════════════════════════════════════════════════════════"

# 1. root 权限
if [ "$EUID" -ne 0 ]; then
  echo "❌ 请用 root 执行: sudo bash deploy.sh"
  exit 1
fi

# 2. Node.js
echo ""
echo "📦 [1/7] 检查 Node.js..."
if command -v node &> /dev/null && [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -ge 18 ]; then
  echo "✅ Node.js 已安装: $(node -v)"
else
  echo "📦 安装 Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  echo "✅ Node.js 安装完成: $(node -v)"
fi

# 3. git
echo ""
echo "📦 [2/7] 检查 git..."
if command -v git &> /dev/null; then
  echo "✅ git 已安装"
else
  apt-get update && apt-get install -y git
  echo "✅ git 安装完成"
fi

# 4. 克隆/更新代码
echo ""
echo "📦 [3/7] 克隆代码 (整套系统)..."
if [ -d "$PROJECT_DIR/.git" ]; then
  echo "📂 代码已存在，拉取最新..."
  cd "$PROJECT_DIR"
  git fetch origin
  git reset --hard origin/main
else
  git clone "$REPO_URL" "$PROJECT_DIR"
  cd "$PROJECT_DIR"
fi
echo "✅ 代码就绪 ($(git ls-files | wc -l) 个文件)"

# 5. npm 依赖
echo ""
echo "📦 [4/7] 安装 npm 依赖..."
npm install --production 2>&1 | tail -5
echo "✅ 依赖安装完成"

# 6. .env 配置
echo ""
echo "📦 [5/7] 检查 .env 配置..."
if [ ! -f .env ]; then
  echo "⚠️ .env 不存在，从 .env.example 创建..."
  cp .env.example .env
  echo ""
  echo "═══════════════════════════════════════════════════════════"
  echo "⚠️  重要：请先编辑 .env 填入真实值！"
  echo "═══════════════════════════════════════════════════════════"
  echo ""
  echo "必须填写的配置:"
  echo "  BINANCE_API_KEY      — Binance 合约 API Key"
  echo "  BINANCE_API_SECRET   — Binance 合约 API Secret"
  echo "  TRADER_PRIVATE_KEY   — Trader 钱包私钥 (BSC 链上转账用)"
  echo "  ADMIN_KEY            — 管理员仪表盘登录密钥"
  echo ""
  echo "编辑命令: nano $PROJECT_DIR/.env"
  echo "填完后重新执行: sudo bash $PROJECT_DIR/deploy.sh"
  echo ""
  exit 0
else
  echo "✅ .env 已存在"
  # 检查关键配置是否已填入
  source .env
  if [ "$BINANCE_API_KEY" = "your_binance_api_key_here" ] || [ -z "$BINANCE_API_KEY" ]; then
    echo "⚠️ BINANCE_API_KEY 未配置！请编辑: nano $PROJECT_DIR/.env"
    exit 1
  fi
  if [ -z "$TRADER_PRIVATE_KEY" ]; then
    echo "⚠️ TRADER_PRIVATE_KEY 未配置！请编辑: nano $PROJECT_DIR/.env"
    exit 1
  fi
  echo "✅ 关键配置已检查"
fi

# 7. 创建数据目录
echo ""
echo "📦 [6/7] 创建数据目录..."
mkdir -p data logs config
[ -f config/strategy-switch.json ] || echo '{"aStrategyEnabled":false,"lastChangedAt":0,"lastChangedBy":"system"}' > config/strategy-switch.json
echo "✅ 数据目录就绪"

# 8. systemd 服务（三层守护）
echo ""
echo "📦 [7/7] 创建 systemd 服务..."

# Layer 1: keepalive (监控 watchdog)
cat > /etc/systemd/system/quant-keepalive.service << 'EOF'
[Unit]
Description=AI Quant Agent - Keepalive (Layer 1)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/ai-quant-agent
ExecStart=/bin/bash /opt/ai-quant-agent/keepalive.sh
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# Layer 2: watchdog (监控 saas 引擎)
cat > /etc/systemd/system/quant-watchdog.service << 'EOF'
[Unit]
Description=AI Quant Agent - Watchdog (Layer 2)
After=network.target quant-keepalive.service

[Service]
Type=simple
WorkingDirectory=/opt/ai-quant-agent
ExecStart=/usr/bin/node /opt/ai-quant-agent/saas/watchdog.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment=PRIVATE_ACCESS=no

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable quant-keepalive quant-watchdog
systemctl restart quant-keepalive quant-watchdog

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "✅ 部署完成！整套量化机器人系统已启动"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "📊 系统架构:"
echo "  Layer 1: keepalive (监控 watchdog 是否活着)"
echo "  Layer 2: watchdog (监控 saas 引擎，崩溃自动重启)"
echo "  Layer 3: saas/start.js (B 策略默认运行，A 策略按开关)"
echo ""
echo "🌐 访问地址:"
echo "  仪表盘:  http://$(hostname -I | awk '{print $1}'):10010"
echo "  管理员:  http://$(hostname -I | awk '{print $1}'):10010/admin"
echo "  用户页:  http://$(hostname -I | awk '{print $1}'):10010/go"
echo ""
echo "📋 服务管理:"
echo "  启动:  systemctl start quant-keepalive quant-watchdog"
echo "  停止:  systemctl stop quant-keepalive quant-watchdog"
echo "  重启:  systemctl restart quant-watchdog"
echo "  状态:  systemctl status quant-watchdog"
echo "  日志:  journalctl -u quant-watchdog -f"
echo ""
echo "🔄 更新代码:"
echo "  cd $PROJECT_DIR && git pull && systemctl restart quant-watchdog"
echo ""
echo "🎚️ A/B 策略切换:"
echo "  默认只运行 B 策略 (BB 布林带)"
echo "  启动 A 策略: 在仪表盘点「启动 A 策略」按钮"
echo "  或 API: curl -X POST -H 'X-Admin-Key: 你的密钥' http://localhost:10010/api/strategy/a/start"
echo ""
echo "🔒 防火墙:"
echo "  ufw allow 10010/tcp  # 仪表盘"
echo "  ufw allow 22/tcp     # SSH"
echo ""
