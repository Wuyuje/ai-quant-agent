#!/bin/bash
# ════════════════════════════════════════════════════════════
# 量化机器人云端部署脚本
# 用法: bash deploy.sh
# ════════════════════════════════════════════════════════════

set -e

PROJECT_DIR="/opt/ai-quant-agent"
REPO_URL="https://github.com/Wuyuje/ai-quant-agent.git"

echo "═══════════════════════════════════════════════════════════"
echo "🚀 量化机器人云端部署脚本"
echo "═══════════════════════════════════════════════════════════"

# 1. 检查 root 权限
if [ "$EUID" -ne 0 ]; then
  echo "❌ 请用 root 用户执行: sudo bash deploy.sh"
  exit 1
fi

# 2. 安装 Node.js
echo ""
echo "📦 [1/6] 检查 Node.js..."
if command -v node &> /dev/null; then
  NODE_VER=$(node -v)
  echo "✅ Node.js 已安装: $NODE_VER"
else
  echo "📦 安装 Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  echo "✅ Node.js 安装完成: $(node -v)"
fi

# 3. 安装 git
echo ""
echo "📦 [2/6] 检查 git..."
if command -v git &> /dev/null; then
  echo "✅ git 已安装"
else
  apt-get update && apt-get install -y git
  echo "✅ git 安装完成"
fi

# 4. 克隆代码
echo ""
echo "📦 [3/6] 克隆代码..."
if [ -d "$PROJECT_DIR/.git" ]; then
  echo "📂 代码已存在，拉取最新..."
  cd "$PROJECT_DIR"
  git pull origin main
else
  git clone "$REPO_URL" "$PROJECT_DIR"
  cd "$PROJECT_DIR"
fi
echo "✅ 代码就绪"

# 5. 安装依赖
echo ""
echo "📦 [4/6] 安装 npm 依赖..."
npm install --production
echo "✅ 依赖安装完成"

# 6. 检查 .env
echo ""
echo "📦 [5/6] 检查 .env 配置..."
if [ ! -f .env ]; then
  echo "⚠️ .env 不存在，从模板创建..."
  cat > .env << 'ENVEOF'
# Binance API (管理员合约账户)
BINANCE_API_KEY=你的binance_api_key
BINANCE_API_SECRET=你的binance_api_secret

# Trader 钱包私钥 (用户充值地址，BSC 链上转账用)
TRADER_PRIVATE_KEY=你的trader钱包私钥

# 管理员密钥 (仪表盘登录用)
ADMIN_KEY=你自定义的管理员密钥

# 邀请码 (用户注册用)
INVITE_CODE=你自定义的邀请码

# 以下可选
ENCRYPTION_KEY=
ENCRYPT_KEY=
VAULT_FACTORY_ADDRESS=
REVENUE_DISTRIBUTION_ADDRESS=
ENVEOF
  echo "⚠️ .env 已创建，请编辑填入真实值: nano $PROJECT_DIR/.env"
  echo "⚠️ 填完后重新执行: bash deploy.sh"
  exit 0
else
  echo "✅ .env 已存在"
fi

# 7. 创建 systemd 服务
echo ""
echo "📦 [6/6] 创建 systemd 服务..."

cat > /etc/systemd/system/quant-keepalive.service << 'SVCEOF'
[Unit]
Description=AI Quant Agent - Keepalive (Layer 1)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/ai-quant-agent
ExecStart=/bin/bash /opt/ai-quant-agent/keepalive.sh
Restart=always
RestartSec=10
StandardOutput=null
StandardError=null

[Install]
WantedBy=multi-user.target
SVCEOF

cat > /etc/systemd/system/quant-watchdog.service << 'SVCEOF'
[Unit]
Description=AI Quant Agent - Watchdog (Layer 2)
After=network.target quant-keepalive.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/ai-quant-agent
ExecStart=/usr/bin/node /opt/ai-quant-agent/saas/watchdog.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable quant-keepalive
systemctl enable quant-watchdog

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "✅ 部署完成！"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "📋 服务管理命令:"
echo "  启动: systemctl start quant-keepalive quant-watchdog"
echo "  停止: systemctl stop quant-keepalive quant-watchdog"
echo "  状态: systemctl status quant-watchdog"
echo "  日志: journalctl -u quant-watchdog -f"
echo ""
echo "🌐 访问地址:"
echo "  仪表盘: http://服务器IP:10010"
echo "  管理员: http://服务器IP:10010/admin"
echo "  用户页: http://服务器IP:10010/go"
echo ""
echo "🔒 防火墙 (如需要):"
echo "  ufw allow 10010/tcp"
echo ""
echo "📝 下一步:"
echo "  1. 确认 .env 配置正确: cat $PROJECT_DIR/.env"
echo "  2. 启动服务: systemctl start quant-keepalive quant-watchdog"
echo "  3. 查看日志: journalctl -u quant-watchdog -f"
echo "  4. 访问仪表盘: http://服务器IP:10010"
echo ""
echo "🔄 后续更新代码:"
echo "  cd $PROJECT_DIR && git pull && systemctl restart quant-watchdog"
echo ""
