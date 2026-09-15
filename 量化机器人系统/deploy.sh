#!/bin/bash
# ═══════════════════════════════════════════════════════════
# 量化机器人系统 — 一键部署脚本
# 用法: bash deploy.sh
# 适用: Ubuntu/Debian (root 权限)
# ═══════════════════════════════════════════════════════════
set -e

INSTALL_DIR="/root/ai-quant-agent"
TS=$(date +%Y%m%d)
PKG="ai-quant-agent-${TS}.tar.gz"

echo "═══════════════════════════════════════"
echo "  🤖 量化机器人系统部署"
echo "═══════════════════════════════════════"

# ─── 1. 检查 root ───
if [ "$(id -u)" != "0" ]; then
  echo "❌ 需要 root 权限，请用 sudo 运行"
  exit 1
fi

# ─── 2. 安装 Node.js ───
echo ""
echo "[1/6] 检查 Node.js..."
if ! command -v node >/dev/null 2>&1; then
  echo "  安装 Node.js + npm..."
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs npm
fi
echo "  ✅ Node $(node -v) / npm $(npm -v)"

# ─── 3. 解压代码 ───
echo ""
echo "[2/6] 部署代码到 ${INSTALL_DIR}..."
mkdir -p "${INSTALL_DIR}"
if [ -f "${PKG}" ]; then
  tar -xzf "${PKG}" -C "${INSTALL_DIR}"
  echo "  ✅ 代码已解压"
else
  echo "  ⚠️  未找到 ${PKG}，假定当前目录已是代码目录"
  if [ "$(pwd)" != "${INSTALL_DIR}" ]; then
    cp -r . "${INSTALL_DIR}/"
  fi
fi
cd "${INSTALL_DIR}"
mkdir -p logs data

# ─── 4. 安装依赖 ───
echo ""
echo "[3/6] 安装 npm 依赖（约1-2分钟）..."
if [ -d node_modules ] && [ "$(ls node_modules | wc -l)" -gt 100 ]; then
  echo "  ℹ️  依赖已存在，跳过"
else
  npm install --no-audit --no-fund --production=false
fi
echo "  ✅ 依赖就绪（$(ls node_modules 2>/dev/null | wc -l) 个包）"

# ─── 5. 安装 systemd 服务 ───
echo ""
echo "[4/6] 安装 systemd 服务..."
for f in systemd/*.service; do
  [ -f "$f" ] || continue
  cp "$f" /etc/systemd/system/
  echo "  ✅ $(basename $f)"
done
systemctl daemon-reload
systemctl enable ai-quant-quant ai-quant-saas 2>/dev/null || true
echo "  ✅ 开机自启已启用"

# ─── 6. 防火墙 ───
echo ""
echo "[5/6] 配置防火墙..."
if command -v ufw >/dev/null 2>&1; then
  ufw allow 10010/tcp >/dev/null 2>&1 || true
  ufw allow 10020/tcp >/dev/null 2>&1 || true
  ufw allow 10060/tcp >/dev/null 2>&1 || true
  ufw reload >/dev/null 2>&1 || true
  echo "  ✅ 已放行 10010/10020/10060"
else
  echo "  ℹ️  未检测到 ufw，跳过"
fi

# ─── 7. 启动 ───
echo ""
echo "[6/6] 启动服务..."
systemctl restart ai-quant-quant ai-quant-saas
sleep 20

echo ""
echo "═══════════════════════════════════════"
echo "  ✅ 部署完成"
echo "═══════════════════════════════════════"
echo ""
echo "服务状态:"
for s in ai-quant-quant ai-quant-saas; do
  printf "  %-20s %s\n" "$s" "$(systemctl is-active $s)"
done
echo ""
echo "端口监听:"
ss -ltn 2>/dev/null | grep -E ':10010|:10020|:10060' || echo "  ⚠️  未检测到端口"
echo ""
echo "健康检查:"
curl -s -m10 http://localhost:10060/api/quant/health && echo "" || echo "  ⚠️  引擎未响应"
echo ""
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo "访问地址:"
echo "  管理员面板: http://${IP}:10060/"
echo "  用户仪表盘: http://${IP}:10010/"
echo "  SaaS API:   http://${IP}:10020/"
echo ""
echo "日志: tail -f ${INSTALL_DIR}/logs/quant.log"
echo ""
