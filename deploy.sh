#!/usr/bin/env bash
# 一键部署脚本 - 由MasterD提供, 在服务器网页终端执行
set -e
echo "======================================"
echo "🚀 开始部署量化系统 ..."
echo "  时间: $(date)"
echo "======================================"

# 1. 检测系统
echo ""
echo "[1/6] 检测系统环境..."
OS=$(grep -oP 'PRETTY_NAME="\K[^"]+' /etc/os-release 2>/dev/null || grep -o 'PRETTY_NAME="[^"]*"' /etc/os-release | cut -d'"' -f2 2>/dev/null || echo "未知")
echo "  系统: $OS"

# 2. 安装 node（如没有）
echo ""
echo "[2/6] 检查/安装 node..."
if ! command -v node >/dev/null 2>&1; then
  echo "  未装node, 开始安装..."
  IS_UBUNTU=$(grep -qi ubuntu /etc/os-release 2>/dev/null && echo 1 || echo 0)
  if [ "$IS_UBUNTU" = "1" ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - 2>/dev/null
    (apt-get install -y nodejs 2>/dev/null || apt install -y nodejs 2>/dev/null) || true
  else
    # RHEL/AlibabaCloud: 用 dnf/yum
    (curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - 2>/dev/null && dnf install -y nodejs 2>/dev/null) ||     (dnf install -y nodejs 2>/dev/null || yum install -y nodejs 2>/dev/null) ||     (dnf module install -y nodejs:20 2>/dev/null) || true
  fi
fi
echo "  node版本: $(node -v 2>/dev/null || echo '安装失败，请把上面输出发给我')"
echo "  npm版本:  $(npm -v 2>/dev/null || echo '无')"

# 3. 安装 git
echo ""
echo "[3/6] 检查/安装 git..."
command -v git >/dev/null 2>&1 || { apt-get install -y git >/dev/null 2>&1 || dnf install -y git >/dev/null 2>&1 || yum install -y git >/dev/null 2>&1; }

# 4. 拉代码
echo ""
echo "[4/6] 拉取代码..."
APP_DIR=/opt/quant-agent
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR" && git pull --rebase 2>&1 | tail -2
else
  rm -rf "$APP_DIR"
  mkdir -p "$APP_DIR"
  git clone https://github.com/Wuyuje/ai-quant-agent.git "$APP_DIR" 2>&1 | tail -3
  cd "$APP_DIR"
fi

# 5. 装依赖
echo ""
echo "[5/6] 安装依赖(可能需要几分钟)..."
cd "$APP_DIR"
[ -f .env ] || cp .env.example .env 2>/dev/null || true
npm install --omit=dev 2>&1 | tail -3 || npm install 2>&1 | tail -3

# 6. 启动
echo ""
echo "[6/6] 启动服务..."
mkdir -p /opt/quant-agent/logs
pkill -9 -f "quant/start.js" 2>/dev/null || true
pkill -9 -f "saas/start.js" 2>/dev/null || true
cd "$APP_DIR"
(TZ=Asia/Shanghai nohup node quant/start.js >> /opt/quant-agent/logs/quant.log 2>&1 &)
(TZ=Asia/Shanghai nohup node saas/start.js >> /opt/quant-agent/logs/saas.log 2>&1 &)
sleep 5

echo ""
echo "======================================"
echo "✅ 部署完成！"
echo "  量化看盘:   http://$IP:10060  (系统自动可用)"
echo "  用户面板:   http://$IP:10020"
echo "  端口: 10010/10020/10030/10060"
echo "  以下是检测到的IP/端口, 稍等确认"
echo "======================================"
