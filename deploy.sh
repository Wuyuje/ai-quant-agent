#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  AI Quant Agent — 一键部署脚本
#  适用于全新 Ubuntu 22.04/24.04 云服务器
#  用法: sudo bash deploy.sh
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

# ─── 配置 ───
REPO_URL="https://github.com/Wuyuje/ai-quant-agent.git"
INSTALL_DIR="/opt/ai-quant-agent"
NODE_VERSION="22"
APP_USER="quant"
SAAS_PORT=8010
DASHBOARD_PORT=8005
LOG_DIR="/var/log/ai-quant-agent"

# ─── 颜色 ───
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✅]${NC} $*"; }
warn() { echo -e "${YELLOW}[⚠️]${NC} $*"; }
err()  { echo -e "${RED}[❌]${NC} $*"; }
info() { echo -e "${BLUE}[ℹ️]${NC} $*"; }
step() { echo -e "\n${CYAN}══════ $* ══════${NC}"; }

# ═══════════════════════════════════════════
#  0. 检查 root 权限
# ═══════════════════════════════════════════
if [[ $EUID -ne 0 ]]; then
  err "请用 sudo 运行: sudo bash deploy.sh"
  exit 1
fi

echo -e "${CYAN}"
cat << 'BANNER'
  ╔══════════════════════════════════════════════╗
  ║   🔥 AI Quant Agent — 一键部署              ║
  ║   CEX智能交易 · 黄金现货 · 多用户SaaS       ║
  ╚══════════════════════════════════════════════╝
BANNER
echo -e "${NC}"

# ═══════════════════════════════════════════
#  1. 系统更新 & 基础依赖
# ═══════════════════════════════════════════
step "1/8 系统更新 & 基础依赖"
apt-get update -qq
apt-get install -y -qq curl git build-essential python3 > /dev/null 2>&1
log "基础依赖安装完成"

# ═══════════════════════════════════════════
#  2. 安装 Node.js
# ═══════════════════════════════════════════
step "2/8 安装 Node.js v${NODE_VERSION}"

if command -v node &> /dev/null; then
  CURRENT_NODE=$(node --version | sed 's/v//' | cut -d. -f1)
  if [[ "$CURRENT_NODE" -ge "$NODE_VERSION" ]]; then
    log "Node.js $(node --version) 已安装，跳过"
  else
    warn "Node.js 版本过低 ($(node --version))，升级中..."
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - > /dev/null 2>&1
    apt-get install -y -qq nodejs > /dev/null 2>&1
    log "Node.js 升级到 $(node --version)"
  fi
else
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs > /dev/null 2>&1
  log "Node.js $(node --version) 安装完成"
fi

# ═══════════════════════════════════════════
#  3. 创建应用用户（非 root）
# ═══════════════════════════════════════════
step "3/8 创建应用用户"
if id "$APP_USER" &>/dev/null; then
  log "用户 $APP_USER 已存在"
else
  useradd -r -m -s /bin/bash "$APP_USER"
  log "用户 $APP_USER 创建完成"
fi

# ═══════════════════════════════════════════
#  4. 克隆代码
# ═══════════════════════════════════════════
step "4/8 克隆代码"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  cd "$INSTALL_DIR"
  git pull origin main 2>/dev/null && log "代码已更新" || warn "git pull 失败，使用现有代码"
else
  rm -rf "$INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
  log "代码克隆完成"
fi
chown -R "$APP_USER:$APP_USER" "$INSTALL_DIR"

# ═══════════════════════════════════════════
#  5. 安装依赖
# ═══════════════════════════════════════════
step "5/8 安装 npm 依赖"
cd "$INSTALL_DIR"
sudo -u "$APP_USER" npm install --production --silent 2>/dev/null
log "npm 依赖安装完成 ($(ls node_modules | wc -l) 个包)"

# ═══════════════════════════════════════════
#  6. 配置环境变量
# ═══════════════════════════════════════════
step "6/8 配置环境变量"

ENV_FILE="$INSTALL_DIR/.env"
mkdir -p "$INSTALL_DIR/data"
chown -R "$APP_USER:$APP_USER" "$INSTALL_DIR/data"

if [[ -f "$ENV_FILE" ]] && grep -q "BINANCE_API_KEY" "$ENV_FILE"; then
  log ".env 已存在，跳过配置（如需修改请编辑 $ENV_FILE）"
else
  cat > "$ENV_FILE" << 'ENVCONF'
# ═══════════════════════════════════════════
#  AI Quant Agent — 环境变量
#  ⚠️  请填写你自己的值
# ═══════════════════════════════════════════

# ── Binance API（管理员交易用）──
BINANCE_API_KEY=你的币安API_KEY
BINANCE_API_SECRET=你的币安API_SECRET

# ── 管理员私钥（链上交易用）──
TRADER_PRIVATE_KEY=0x你的管理员私钥

# ── 管理员密码（登录仪表盘用）──
ADMIN_KEY=你的管理员密码

# ── 加密密钥（API Key 加密存储用，32位hex）──
# 生成方法: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ENCRYPTION_KEY=用上面的命令生成一个32位hex

# ── 端口配置 ──
SAAS_PORT=8010
DASHBOARD_PORT=8005

# ── DeepSeek AI（可选，不填则用规则引擎）──
DEEPSEEK_API_KEY=

# ── 百万级架构配置（v83）──
# WORKERS=0     单进程（默认，小配置）
# WORKERS=auto  自动检测CPU核数
# WORKERS=4     指定Worker数量
WORKERS=0

# DATA_STORE=json  JSON文件存储（默认）
# DATA_STORE=redis Redis存储（大配置）
DATA_STORE=json
# REDIS_URL=redis://127.0.0.1:6379

# API限速（Binance 1200权重/分钟）
API_RATE_LIMIT=1200
ENVCONF
  chmod 600 "$ENV_FILE"
  chown "$APP_USER:$APP_USER" "$ENV_FILE"

  warn "⚠️  请编辑 .env 填写真实的 API Key:"
  info "  sudo nano $ENV_FILE"
fi

# ═══════════════════════════════════════════
#  7. 创建 systemd 服务（开机自启 + 崩溃重启）
# ═══════════════════════════════════════════
step "7/8 配置 systemd 服务"

mkdir -p "$LOG_DIR"
chown "$APP_USER:$APP_USER" "$LOG_DIR"

cat > /etc/systemd/system/ai-quant.service << SERVICEEOF
[Unit]
Description=AI Quant Agent — CEX智能交易引擎
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=10
StartLimitBurst=5
StartLimitIntervalSec=60

# 环境变量
EnvironmentFile=$INSTALL_DIR/.env

# 日志
StandardOutput=append:$LOG_DIR/app.log
StandardError=append:$LOG_DIR/error.log

# 安全限制
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=$INSTALL_DIR/data $LOG_DIR /tmp

# 内存限制（超过 1GB 自动重启）
MemoryMax=1G
MemoryHigh=800M

[Install]
WantedBy=multi-user.target
SERVICEEOF

systemctl daemon-reload
systemctl enable ai-quant.service
log "systemd 服务创建完成"

# ═══════════════════════════════════════════
#  8. 配置防火墙
# ═══════════════════════════════════════════
step "8/8 配置防火墙"

if command -v ufw &> /dev/null; then
  ufw allow 22/tcp > /dev/null 2>&1    # SSH
  ufw allow $SAAS_PORT/tcp > /dev/null 2>&1    # SaaS
  ufw allow $DASHBOARD_PORT/tcp > /dev/null 2>&1  # Dashboard
  ufw --force enable > /dev/null 2>&1
  log "防火墙已开放端口: 22, $SAAS_PORT, $DASHBOARD_PORT"
else
  warn "ufw 未安装，请手动开放端口: $SAAS_PORT, $DASHBOARD_PORT"
fi

# ═══════════════════════════════════════════
#  完成！
# ═══════════════════════════════════════════
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   ✅ 部署完成！                              ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"
echo ""
info "安装目录: $INSTALL_DIR"
info "日志目录: $LOG_DIR"
info ".env 配置: $INSTALL_DIR/.env"
echo ""

# 获取公网 IP
PUBLIC_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || echo "你的服务器IP")

echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  📌 下一步操作:"
echo ""
echo -e "  ${YELLOW}1.${NC} 配置 API Key（如果还没配置）:"
echo -e "     ${BLUE}sudo nano $ENV_FILE${NC}"
echo ""
echo -e "  ${YELLOW}2.${NC} 启动服务:"
echo -e "     ${BLUE}sudo systemctl start ai-quant${NC}"
echo ""
echo -e "  ${YELLOW}3.${NC} 查看日志:"
echo -e "     ${BLUE}sudo journalctl -u ai-quant -f${NC}"
echo ""
echo -e "  ${YELLOW}4.${NC} 访问仪表盘:"
echo -e "     ${BLUE}http://${PUBLIC_IP}:${DASHBOARD_PORT}${NC}"
echo ""
echo -e "  ${YELLOW}5.${NC} 访问 SaaS 平台（TP钱包扫码登录）:"
echo -e "     ${BLUE}http://${PUBLIC_IP}:${SAAS_PORT}${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
info "常用命令:"
echo "  sudo systemctl start ai-quant      # 启动"
echo "  sudo systemctl stop ai-quant       # 停止"
echo "  sudo systemctl restart ai-quant    # 重启"
echo "  sudo systemctl status ai-quant     # 状态"
echo "  sudo journalctl -u ai-quant -f     # 实时日志"
echo "  sudo nano $ENV_FILE               # 编辑配置"
echo ""
