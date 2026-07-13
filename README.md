# AI Quant Agent 🤖

基于 Greenfield 去中心化存储的加密货币量化交易机器人。

## 功能
- 🧠 AI 决策引擎（7 个场景）
- 📊 多交易对并行监控（BTC/ETH/BNB）
- 🛡️ 四层安全防护（止损/黑天鹅/防共损/趋势跟踪）
- 📈 仪表盘实时监控
- ☁️ Greenfield 去中心化代码备份
- 🔒 助记词本地加密存储
- ⛓️ 智能合约钱包（AgentVault）
- 🌐 多语言支持（9种语言）

## 启动
```bash
npm install
node start.js
```

## 仪表盘
访问 http://localhost:10010

## SaaS 平台（智能合约钱包模式）
```bash
node saas/start.js
```

访问 http://localhost:10001

## 部署合约到 BSC
```bash
# 设置私钥
export PRIVATE_KEY=你的部署钱包私钥

# 一键部署
./deploy.sh
```

## 配置
- `config/default.json` - 主配置
- `config/trading-pairs.json` - 交易对配置
- `config/credentials/production.json` - API 密钥（加密存储）

## 安全
⚠️ **永远不要泄露你的 API 密钥或助记词**

⚠️ **部署合约使用新的空钱包**
