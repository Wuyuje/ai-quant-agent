# 🚀 量化机器人系统 → 境外云迁移方案

> 生成时间：2026-07-18  
> 目标：把量化机器人系统从当前沙盘迁移到境外云服务器，降低法律与政策风险

---

## 一、为什么必须迁移境外云

### 1.1 当前部署的风险

| 风险点 | 现状 | 风险等级 |
|---|---|---|
| 中国大陆云厂商 ToS 明确禁止虚拟货币相关业务 | 阿里云/腾讯云一旦识别可单方面封停 | 🔴 高 |
| 公网 dashboard 暴露 | 容易被云厂商扫描识别 + 触发备案问题 | 🔴 高 |
| "盖茨费"自动扣费 = 经营性收费 | 跨境+加密+经营性三要素叠加 | 🟡 中（已改为自愿打赏） |
| Binance API 调用 | 通过 Binance 境外服务器，本身不违法，但需注意定性 | 🟡 中 |

### 1.2 境外云的优势

- 法律风险显著降低（境外云厂商对中国监管政策不敏感）
- 与 Binance 服务器（东京/新加坡）物理距离更近 → API 延迟更低
- 不会被云厂商主动审查业务内容
- 不会被强制要求 ICP/公安备案

---

## 二、云服务商推荐（按推荐优先级）

### 🥇 首选：Vultr / DigitalOcean（新加坡或东京节点）

| 项目 | Vultr | DigitalOcean |
|---|---|---|
| 节点 | 新加坡、东京 | 新加坡、东京 |
| 最低配置价格 | $6/月（1C/1G/25GB SSD） | $6/月（1C/1G/25GB SSD） |
| 推荐配置 | $12/月（1C/2G/60GB SSD） | $12/月（1C/2G/50GB SSD） |
| 注册门槛 | 邮箱 + 信用卡/PayPal | 邮箱 + 信用卡/PayPal |
| 对加密货币业务态度 | 中立，不会主动审查 | 中立 |
| 被墙风险 | 低（新加坡节点对中国大陆访问需走 VPN，但服务器本身不影响 Binance API） | 低 |
| 推荐度 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |

**推荐理由**：价格便宜、注册简单、对加密货币业务完全中立、与 Binance 服务器物理距离近（延迟通常 < 50ms）。

### 🥈 次选：AWS（香港/新加坡区域）

| 项目 | 详情 |
|---|---|
| 节点 | ap-east-1（香港）、ap-southeast-1（新加坡） |
| 推荐实例 | t3.small（2C/2G）约 $15/月，或 t3.micro $8/月 |
| 注册门槛 | 邮箱 + 信用卡（支持国内双币卡） |
| 优势 | 全球最大云厂商、稳定性最高、免费套餐 12 个月 |
| 劣势 | 价格稍贵、流量超额收费 |
| 推荐度 | ⭐⭐⭐⭐ |

### 🥉 备选：阿里云/腾讯云（香港/新加坡节点）

| 项目 | 详情 |
|---|---|
| 节点 | 阿里云香港/新加坡、腾讯云香港/新加坡 |
| 推荐配置 | 1C/2G 约 ¥30-60/月 |
| 优势 | 中文界面、支付宝/微信支付、网络对中国大陆友好 |
| 劣势 | **仍是中国厂商，ToS 仍禁止加密货币业务，只是监管力度比大陆节点松** |
| 推荐度 | ⭐⭐⭐（次选） |

### ⚠️ 不推荐：阿里云/腾讯云大陆节点

- 风险最高，强烈不建议
- 即使自用风险可控，但 Binance API + 合约量化 + 多用户 SaaS 几个特征叠加，风控系统识别概率不低

---

## 三、推荐方案：Vultr 新加坡节点

### 3.1 服务器配置建议

```
服务商：Vultr
节点：Singapore
操作系统：Ubuntu 22.04 LTS
配置：1 vCPU / 2GB RAM / 60GB SSD
价格：$12/月（约 ¥85/月）
带宽：2TB/月（足够）
```

### 3.2 为什么选新加坡

- 🌏 与 Binance 服务器（东京/新加坡）物理距离最近，API 延迟通常 10-30ms
- 🔒 Vultr 对加密货币业务完全中立
- 💰 价格便宜，2GB 内存足够跑 BB 引擎 + watchdog + 3-5 个用户
- 🌐 中国大陆访问需走 VPN，但服务器**主动调用** Binance API 不受影响

---

## 四、完整迁移步骤

### 步骤 1：注册 Vultr 账号 + 创建服务器

```bash
# 1. 访问 https://www.vultr.com/
# 2. 邮箱注册 + 信用卡/PayPal 充值（最低充 $10）
# 3. 点击 "Deploy New Server"
# 4. 选择：
#    - Cloud Compute → Regular
#    - Location: Singapore
#    - Image: Ubuntu 22.04 LTS
#    - Plan: 1 vCPU / 2GB / 60GB SSD ($12/月)
#    - Auto Backup: 建议开启（+25% 费用，值得）
# 5. 设置 SSH 公钥（强烈建议用密钥登录，不要用密码）
# 6. 点击 Deploy Now
# 7. 等待 1-2 分钟，记录下服务器公网 IP
```

### 步骤 2：服务器初始化（SSH 登录后执行）

```bash
# 假设服务器 IP 是 1.2.3.4，你本地的 SSH 私钥是 ~/.ssh/id_rsa
ssh root@1.2.3.4

# === 2.1 系统更新 + 基础工具 ===
apt update && apt upgrade -y
apt install -y curl wget git build-essential python3 python3-pip ufw fail2ban

# === 2.2 安装 Node.js 20 LTS ===
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node -v  # 应显示 v20.x.x
npm -v   # 应显示 10.x.x

# === 2.3 安装 PM2（可选，我们用自带的 watchdog，但 PM2 可作为备用） ===
npm install -g pm2

# === 2.4 防火墙配置（只开 SSH + 内部端口）===
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp        # SSH
# 不开放 10000-10035 任何端口！所有 HTTP 服务只走 SSH 隧道
ufw enable
ufw status

# === 2.5 fail2ban 防爆破 ===
systemctl enable fail2ban
systemctl start fail2ban

# === 2.6 创建非 root 用户（推荐）===
adduser quant
usermod -aG sudo quant
mkdir -p /home/quant/.ssh
cp ~/.ssh/authorized_keys /home/quant/.ssh/
chown -R quant:quant /home/quant/.ssh
chmod 700 /home/quant/.ssh
chmod 600 /home/quant/.ssh/authorized_keys
```

### 步骤 3：拉取代码 + 安装依赖

```bash
# 切换到 quant 用户
su - quant

# 拉取代码
cd ~
git clone https://github.com/Wuyuje/ai-quant-agent.git
cd ai-quant-agent

# 安装依赖
npm install --production

# 安装 Python 依赖（如果用到 ml-service）
pip3 install --user python-dotenv flask
```

### 步骤 4：配置 .env（关键！）

```bash
cd ~/ai-quant-agent

# 1. 从沙盘下载现有的 .env（在本地执行）
# 本地执行：scp 本地的 .env 到服务器
# scp -i ~/.ssh/id_rsa .env quant@1.2.3.4:~/ai-quant-agent/.env

# 2. 服务器上编辑 .env
nano .env

# 3. 确保 .env 包含以下关键配置：
#    BINANCE_API_KEY=...
#    BINANCE_API_SECRET=...
#    DEEPSEEK_API_KEY=...
#    TRADER_PRIVATE_KEY=...
#    PLATFORM_WALLET=...
#    ENCRYPTION_KEY=...  # 重要：必须与沙盘一致，否则用户 API key 解密失败！
#    ADMIN_KEY=...

# 4. 加入境外部署安全配置（重要！）
cat >> .env << 'EOF'

# ── 境外云部署安全配置 ──
PRIVATE_ACCESS=yes
# 所有 HTTP 服务只监听 127.0.0.1，通过 SSH 隧道访问
# 公网访问 dashboard 不安全，已禁用
EOF

# 5. 同步用户数据文件（重要！）
# 本地执行：scp -r data/ quant@1.2.3.4:~/ai-quant-agent/
# 这会同步所有用户的 API key 加密文件、持仓 state、交易历史

# 6. 验证文件权限
chmod 600 .env
ls -la data/saas-users.json  # 确保只有 quant 用户可读
```

### 步骤 5：配置 SSH 隧道访问（本地电脑操作）

```bash
# 在你本地电脑创建 SSH 配置，方便快速连接
# 编辑 ~/.ssh/config（本地）

cat >> ~/.ssh/config << 'EOF'

Host quant-sg
    HostName 1.2.3.4
    User quant
    IdentityFile ~/.ssh/id_rsa
    # SSH 隧道：把服务器的本地端口映射到你本地
    LocalForward 10010 127.0.0.1:10010  # Dashboard
    LocalForward 10020 127.0.0.1:10020  # SaaS API
    LocalForward 10030 127.0.0.1:10030  # Multi Engine
EOF

# 之后只需：
ssh quant-sg
# 然后在你本地浏览器打开 http://localhost:10010 即可访问 Dashboard
# 所有流量通过 SSH 加密传输，不会被中间人看到
```

### 步骤 6：启动系统 + watchdog

```bash
# SSH 登录服务器
ssh quant-sg

cd ~/ai-quant-agent

# 启动 watchdog（它会自动拉起 saas）
nohup node saas/watchdog.js > logs/watchdog.log 2>&1 &

# 或者用 setsid（更可靠）
setsid node saas/watchdog.js >> logs/watchdog.log 2>&1 < /dev/null &

# 检查启动状态
sleep 10
curl http://127.0.0.1:10020/api/dashboard  # 应返回 JSON
curl http://127.0.0.1:10010/                 # 应返回 HTML

# 看 watchdog 日志
tail -f logs/watchdog.log
```

### 步骤 7：配置 systemd 让 watchdog 开机自启（强烈推荐）

```bash
# 创建 systemd 服务
sudo tee /etc/systemd/system/quant-watchdog.service << 'EOF'
[Unit]
Description=MasterD Quant Agent Watchdog
After=network.target

[Service]
Type=simple
User=quant
WorkingDirectory=/home/quant/ai-quant-agent
ExecStart=/usr/bin/node saas/watchdog.js
Restart=always
RestartSec=10
StandardOutput=append:/home/quant/ai-quant-agent/logs/watchdog.log
StandardError=append:/home/quant/ai-quant-agent/logs/watchdog.log

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable quant-watchdog
sudo systemctl start quant-watchdog

# 检查状态
sudo systemctl status quant-watchdog
```

### 步骤 8：验证迁移成功

```bash
# 1. 检查所有用户持仓是否同步
curl -s http://127.0.0.1:10020/api/dashboard | jq '.users[] | {wallet: .wallet[0:10], positions: (.positions | length), bbRunning: .bbRunning}'

# 2. 检查 Binance API 连通性
curl -s http://127.0.0.1:10020/api/dashboard | jq '.users[0].binanceConnected'

# 3. 检查 watchdog 心跳
ps aux | grep watchdog
tail -5 logs/watchdog.log

# 4. 从 Binance API 直接查持仓（确认 state 没丢）
node -e "
const { ethers } = require('ethers');
// ... 查询脚本
"
```

---

## 五、数据备份策略（关键！）

### 5.1 自动备份脚本

```bash
# 创建备份脚本
cat > ~/ai-quant-agent/scripts/backup-to-git.sh << 'EOF'
#!/bin/bash
set -e

cd ~/ai-quant-agent

# 备份关键数据
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_BRANCH="backup/data"

# 切换到 backup 分支
git stash || true
git checkout -B $BACKUP_BRANCH

# 加入关键数据（注意不要加 .env！）
git add data/saas-users.json
git add data/bb-user-*.json
git add data/bb-trade-history.json
git add data/*.json 2>/dev/null || true

git commit -m "backup: $TIMESTAMP" || true

# 推到 GitHub 私有仓库的 backup 分支
git push origin $BACKUP_BRANCH --force

# 切回 main
git checkout main
git stash pop || true

echo "✅ Backup completed: $TIMESTAMP"
EOF

chmod +x ~/ai-quant-agent/scripts/backup-to-git.sh
```

### 5.2 定时备份（crontab）

```bash
# 编辑 crontab
crontab -e

# 加入定时任务
# 每天凌晨 4 点备份
0 4 * * * /home/quant/ai-quant-agent/scripts/backup-to-git.sh >> /home/quant/ai-quant-agent/logs/backup.log 2>&1

# 每小时同步一次持仓 state 到 git（增量）
0 * * * * cd /home/quant/ai-quant-agent && git add data/bb-user-*.json && git commit -m "auto: state sync $(date +%H:%M)" && git push origin main || true
```

---

## 六、Binance API Key 更新

### 6.1 如果 API Key 不变

**不需要任何操作**，迁移后直接复用，Binance API Key 不绑定 IP。

### 6.2 如果需要限制 IP（推荐，更安全）

```bash
# 1. 登录 Binance → API 管理 → 找到现有 API Key
# 2. 编辑 IP 限制 → 添加服务器公网 IP
# 3. 这样即使 API Key 泄露，黑客也无法从其他 IP 调用

# 查看服务器公网 IP
curl -s ifconfig.me
```

### 6.3 如果创建新 API Key

```bash
# 1. 登录 Binance → API 管理 → 创建 API
# 2. 权限设置：✅ Enable Reading  ✅ Enable Futures Trading
#             ❌ Enable Withdrawals（永远不要勾选！）
# 3. IP 限制：填入服务器公网 IP
# 4. 复制 API Key 和 Secret

# 5. 在服务器上更新 .env
nano ~/ai-quant-agent/.env
# 修改 BINANCE_API_KEY 和 BINANCE_API_SECRET

# 6. 重启服务
sudo systemctl restart quant-watchdog
```

---

## 七、回滚预案（如果服务器被封）

### 7.1 快速回滚到本地

```bash
# 本地执行：从 GitHub 拉取最新 backup 分支
git fetch origin backup/data
git checkout backup/data

# 恢复 data 目录
cp -r data/ ai-quant-agent/data/

# 本地启动
cd ai-quant-agent
node saas/start.js
```

### 7.2 迁移到新云厂商

```bash
# 1. 注册新的境外云账号（如 DigitalOcean）
# 2. 创建新服务器
# 3. git clone 代码
# 4. scp data/ 和 .env 到新服务器
# 5. 启动 watchdog
# 整个过程 < 30 分钟
```

---

## 八、成本估算

### 8.1 Vultr 新加坡方案

| 项目 | 月成本 |
|---|---|
| Vultr 1C/2G 服务器 | $12 |
| 自动备份（+25%） | $3 |
| 域名（可选，不推荐） | $1 |
| **合计** | **$16/月（约 ¥115）** |

### 8.2 AWS 新加坡方案

| 项目 | 月成本 |
|---|---|
| AWS t3.small 实例 | $15 |
| EBS 50GB | $5 |
| 流量（前 1TB 免费） | $0 |
| **合计** | **$20/月（约 ¥145）** |

---

## 九、风险检查清单（迁移后必查）

- [ ] `ufw status` 确认只开了 22 端口
- [ ] `curl http://localhost:10020` 在服务器本地可访问
- [ ] `curl http://1.2.3.4:10020` 从外部**无法**访问（应超时/拒绝）
- [ ] `grep PRIVATE_ACCESS .env` 确认是 `yes`
- [ ] SSH 隧道连接后本地浏览器可访问 dashboard
- [ ] 所有用户持仓数量与沙盘一致
- [ ] Binance API 连通正常（查余额、查持仓成功）
- [ ] watchdog 进程在运行，日志无错误
- [ ] crontab 备份任务已设置
- [ ] .env 文件权限是 600
- [ ] fail2ban 在运行：`systemctl status fail2ban`
- [ ] GitHub 仓库是**私有**仓库（不是 public）

---

## 十、重要提醒

### ⚠️ 必须保持私有的内容

1. **`.env` 文件**：包含所有 API key、私钥、加密密钥
   - 永远不要 git commit
   - 确认 `.gitignore` 包含 `.env`
   - 服务器权限必须 `chmod 600 .env`

2. **`data/saas-users.json`**：用户 API key 加密文件
   - 包含所有用户的加密 Binance API key
   - 不要上传到公开仓库（备份用单独的 backup 分支）

3. **GitHub 仓库**：必须是**私有仓库**
   - 检查：https://github.com/Wuyuje/ai-quant-agent/settings → Change visibility → 确认是 Private

### ⚠️ 法律风险持续监控

即使迁移到境外云，仍需注意：
- 不要公开宣传推广服务（避免"非法经营"定性）
- 用户数量保持在私人小范围
- 不要提供法币兑换服务（USDT ↔ CNY）
- 定期关注中国监管政策变化
- **建议咨询专业律师**获取正式法律意见

---

## 附录 A：完整迁移命令速查

```bash
# === 本地操作 ===
# 1. 备份沙盘数据到本地
scp -r root@沙盘IP:/app/workspace/ai-quant-agent/data/ ./backup-data/

# === 服务器操作（SSH 登录后）===
# 2. 系统初始化
apt update && apt install -y nodejs npm git python3 python3-pip ufw fail2ban
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs

# 3. 防火墙
ufw default deny incoming && ufw allow 22/tcp && ufw enable

# 4. 拉代码
git clone https://github.com/Wuyuje/ai-quant-agent.git && cd ai-quant-agent
npm install --production

# 5. 上传数据（本地执行）
scp -r ./backup-data/ quant@服务器IP:~/ai-quant-agent/data/
scp .env quant@服务器IP:~/ai-quant-agent/.env

# 6. 配置 .env 加入 PRIVATE_ACCESS=yes
echo "PRIVATE_ACCESS=yes" >> .env
chmod 600 .env

# 7. 启动
setsid node saas/watchdog.js >> logs/watchdog.log 2>&1 < /dev/null &

# 8. 配置 systemd
# （见步骤 7）

# === 本地验证 ===
# 9. SSH 隧道访问
ssh quant@服务器IP -L 10010:127.0.0.1:10010 -L 10020:127.0.0.1:10020

# 10. 本地浏览器打开
# http://localhost:10010
```

---

## 附录 B：常用运维命令

```bash
# 查看系统状态
sudo systemctl status quant-watchdog

# 重启系统
sudo systemctl restart quant-watchdog

# 查看实时日志
tail -f ~/ai-quant-agent/logs/watchdog.log

# 查看 saas 进程
ps aux | grep saas

# 查看内存使用
free -h

# 查看磁盘使用
df -h

# 紧急停止所有交易（保留持仓）
curl -X POST http://127.0.0.1:10020/api/stop-all

# 查看所有用户持仓
curl -s http://127.0.0.1:10020/api/dashboard | jq '.users[] | {wallet: .wallet[0:10], positions: .positions}'
```

---

**文档版本**：v1.0  
**最后更新**：2026-07-18  
**作者**：MasterD  
**仓库**：Wuyuje/ai-quant-agent (Private)
