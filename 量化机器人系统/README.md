# 🤖 量化机器人系统 — 部署包

> **这个文件夹是我（MasterD）为你维护的量化机器人系统最新部署包。**
> 以后你说 **"找量化机器人系统"**，直接来这里。

---

## 📌 当前版本

| 项目 | 值 |
|---|---|
| **版本** | v10（震荡策略优化版）|
| **打包时间** | 2026-09-15 |
| **部署服务器** | `65.20.73.24` |
| **部署目录** | `/root/ai-quant-agent/` |
| **状态** | ✅ 运行中 |

---

## 🚀 系统组成（3 个服务）

| 服务 | systemd 名称 | 端口 | 公网地址 | 作用 |
|---|---|---|---|---|
| **量化引擎** | `ai-quant-quant` | **10060** | `http://65.20.73.24:10060/` | 双策略引擎 + 管理员面板 |
| **用户仪表盘** | `ai-quant-saas` | **10010** | `http://65.20.73.24:10010/` | 普通用户面板 |
| **SaaS API** | `ai-quant-saas` | **10020** | `http://65.20.73.24:10020/` | 用户后端 API |

---

## 📈 策略说明

### 1️⃣ 趋势策略（MA7 / trend）

```
开仓: EMA20/60排列 + EMA间距<1.5% + ADX 20-50 + RSI过滤 + 15m确认
止盈: 浮盈≥3%后峰值回撤1.5%锁利（移动止盈）
止损: 12 ATR / 单K 6% / 终极 15% / 总浮亏20% / 反向15% / 时间4h
周期: 5m（15m确认）
```

**回测表现**（12币 × 35天 5m数据）：
```
354笔 | 胜率 34.7% | 盈亏 +3.84 | 盈亏比 2.36:1 | 回撤 1.14
```

### 2️⃣ 震荡策略（bollinger / 布林+SUPERTREND）

```
开仓: 布林均值回归（触上/下轨）+ SUPERTREND方向确认 + ATR波动率过滤
止盈: 触对轨 + 2%兜底
止损: 1.5 ATR（v10优化）+ 总浮亏10% + 时间3h
周期: 15m
```

**v10 优化**（125天回测驱动）：
| 参数 | 旧值 | 新值 |
|---|---|---|
| `atrStopMultiplier` | 2.0 | **1.5** |
| `totalLossPct` | 8 | **10** |
| `maxHoldHours` | 2 | **3** |

**优化效果**：
```
旧v5   : 2198笔 胜率35.4% 盈亏 +0.63 回撤1.50 盈利币7/12
新v10  : 2389笔 胜率32.4% 盈亏 +2.43 回撤1.02 盈利币8/12
提升   : 盈亏 +286%，回撤 -32%
```

---

## 🏗️ 系统架构

```
市场分类器（自动判断行情）
  ├─ ranging(震荡)  → 布林均值回归 + SUPERTREND
  └─ trending(趋势) → MA7趋势追踪
         ↓
    双策略仓位隔离（独立名额，互不接管）
         ↓
    多用户智能体（每钱包独立引擎）
```

---

## 👥 当前用户（6个）

| 角色 | 钱包 | 余额 | 权益 |
|---|---|---|---|
| 管理员 | `0xfa3b90c5...` | $254.00 | $389.11 |
| 白名单 | `0x41c89c7d...` | $99.62 | $157.74 |
| 白名单 | `0xc6dbb4cd...` | $87.68 | $138.80 |
| 普通 | `0x588ff823...` | $9.55 | $9.55 |
| 普通 | `0xa52eb09f...` | $0 | $0 |
| 普通 | `0xaaf52c91...` | $0 | $0 |

---

## 🔧 运维命令

```bash
# 查看状态
systemctl status ai-quant-quant
systemctl status ai-quant-saas

# 重启
systemctl restart ai-quant-quant
systemctl restart ai-quant-saas

# 实时日志
tail -f /root/ai-quant-agent/logs/quant.log
tail -f /root/ai-quant-agent/logs/saas.log

# 健康检查
curl http://localhost:10060/api/quant/health
```

---

## 🔒 隔离说明

**与 Polymarket 系统完全隔离**：

| 项目 | Polymarket | 量化机器人 |
|---|---|---|
| 目录 | `/root/polymarket-btc5/` | `/root/ai-quant-agent/` |
| 端口 | 8099 | 10010/10020/10060 |
| 运行时 | python3 | node |
| 数据 | `users_db.json` | `saas-users.json` |

---

## 📦 本文件夹内容

| 文件 | 说明 |
|---|---|
| `README.md` | 本说明（系统总览）|
| `deploy.sh` | 一键部署脚本（新服务器迁移用）|
| `ai-quant-agent-*.tar.gz` | 完整源码包（含 data/ 和 .env）|
| `systemd/` | systemd 服务定义 |
| `VERSION.txt` | 版本与时间戳 |

---

## 🔄 迁移到新服务器

```bash
# 1. 上传本文件夹到新服务器
scp -r 量化机器人系统/ root@新IP:/root/

# 2. 在新服务器执行
cd /root/量化机器人系统
bash deploy.sh

# 3. 验证
curl http://localhost:10060/api/quant/health
```

---

**最后更新**: 2026-09-15
**维护**: MasterD
