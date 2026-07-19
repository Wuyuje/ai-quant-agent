# MasterD Multi-Market v97 — 架构总览

## 系统规模

| 维度 | 数量 |
|------|------|
| 独立引擎 | 8 个 |
| 交易策略 | 48 个 |
| 市场覆盖 | 7 个 (Crypto/Gold/Forex/Index/Commodity/Bond/Arb) |
| 跨市场联动规则 | 7 个 |
| 套利策略 | 8 种 (含实盘下单) |
| 代码总量 | ~55,000+ 行 |
| 回测验证 | 6 币种 30 天 |

## 引擎架构

```
┌─────────────────────────────────────────────────────────────────┐
│                     SharedRiskLayer (v97)                       │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ 总敞口≤100% │ 单市场≤40% │ 日亏损≤5% │ 杠杆≤8x          ││
│  │ 高相关≤60%  │ 单笔亏损≤2% │ 相关性>0.7限制同向            ││
│  └─────────────────────────────────────────────────────────────┘│
├──────────┬──────────┬──────────┬──────────┬─────────────────────┤
│ Crypto   │ Gold     │ Forex    │ Index    │ Commodity │ Bond    │
│ 18策略   │ 4策略    │ 5策略    │ 6策略    │ 4策略     │ 4策略   │
│ BTC/ETH  │ PAXG     │ EUR/GBP  │ BTC/ETH  │ 商品代理  │ 利率    │
│ SOL/BNB  │ 避险对冲  │ USD/JPY  │ SOL/BNB  │ 通胀对冲  │ 曲线    │
│ +6 alts  │ 宏观因子  │ AUD      │ AVAX     │ 趋势跟踪 │ 通胀    │
├──────────┴──────────┴──────────┴──────────┴─────────────────────┤
│              CrossMarketSignalBus — 7个联动规则                  │
│  VIX↑→减股指加黄金 │ BTC跌→减加密加黄金 │ 美元→黄金反向        │
│  黄金暴涨→减加密 │ 利率↑→减债加美元 │ 相关性断裂→全面减仓     │
├─────────────────────────────────────────────────────────────────┤
│              CrossMarketArb — 8种套利 (含实盘下单)              │
│  现货期货 │ 跨资产 │ 三角 │ 资金费率 │ 现货溢价                │
├─────────────────────────────────────────────────────────────────┤
│              CapitalRouter — 动态资金分配                        │
│  Crypto 40% │ Gold 20% │ Forex 20% │ Index 15% │ Cash 5%      │
├─────────────────────────────────────────────────────────────────┤
│              费用系统                                            │
│  管理员: 0% 算力 Token + 0% 算力 Token = 100% 实得                     │
│  用户:   20% 算力 Token + 10% 算力 Token = 70% 实得 (盈利自动扣除)      │
└─────────────────────────────────────────────────────────────────┘
```

## 各引擎策略详情

### 1. Crypto Futures Engine — 18 策略融合

| # | 策略名 | 类型 | 灵感来源 | 描述 |
|---|--------|------|---------|------|
| 1 | MultiTimeframe | 趋势 | 独创 | 多时间框架MA交叉确认 |
| 2 | MLPredictor | 预测 | 独创 | 机器学习价格方向预测 |
| 3 | NeuralNet | 预测 | 独创 | 神经网络非线性特征 |
| 4 | FundingRateArb | 套利 | Jump Trading | 资金费率套利 |
| 5 | Sentiment | 情绪 | Two Sigma | 社交媒体情绪分析 |
| 6 | DeltaNeutral | 中性 | Citadel | 多空中性组合 |
| 7 | RegimeDetect | 体制 | Man AHL | HMM市场状态检测 |
| 8 | CrossSpread | 价差 | Virtu | 跨期价差 |
| 9 | PairsTrading | 配对 | Renaissance | 均值回归配对 |
| 10 | MarketMaking | 做市 | Citadel Securities | 双边报价 |
| 11 | Grid | 网格 | — | 网格交易 |
| 12 | Volatility | 波动率 | Winton Group | 波动率突破/回归 |
| 13 | Kelly | 仓位 | Kelly Criterion | 凯利公式仓位管理 |
| 14 | DCA | 定投 | — | 定投/定抛 |
| 15 | RiskParity | 风控 | Bridgewater | 风险平价配置 |
| 16 | TailRisk | 风控 | Universa | 尾部风险保护 |
| 17 | AdaptiveExit | 出场 | AQR | 自适应止盈止损 |
| 18 | Ensemble | 融合 | — | 加权投票融合 |

### 2. Gold Spot Engine — 4 策略融合
- 动量突破、均值回归、宏观因子(美元/利率)、波动率

### 3. Forex Engine — 5 策略融合
- AQR利差套利、Man趋势跟踪、Renaissance均值回归、Winton波动率、Bridgewater宏观

### 4. Index/ETF Engine — 6 策略融合
- Renaissance统计套利、Two Sigma因子、Citadel多空、AQR动量、BlackRock风险平价、趋势跟踪

### 5. Cross-Market Arb — 8 种套利
- 现货-期货基差、跨资产相关性、三角套利、资金费率、现货溢价、跨市场相关性、黄金-加密、美元-黄金

### 6. Commodity Engine — 4 策略融合
- AHL趋势跟踪、季节性均值回归、跨商品比价套利、通胀对冲

### 7. Bond Engine — 4 策略融合
- PIMCO利率周期、Two Sigma收益率曲线、Bridgewater通胀挂钩、AQR债券动量

## 风控层级

```
第一层: 引擎内部 (各引擎独立止损/止盈/追踪)
  ↓
第二层: SharedRiskLayer (跨市场统一风控)
  - 总敞口 / 单市场敞口 / 相关性约束
  - 日亏损熔断 / 单笔限额
  ↓
第三层: Guardian (链上交易执行验证)
  - 滑点保护 / 重复交易检测 / 精度校验
  ↓
第四层: CapitalRouter (动态资金分配)
  - 绩效加权 / 相关性调整 / 紧急回收
```

## 费用体系

| 角色 | 算力 Token | 算力 Token | 实得 |
|------|--------|--------|------|
| 管理员 | 0% | 0% | 100% |
| 普通用户 | 20% | 10% | 70% |

- 只在盈利时扣除
- 自动从用户Binance钱包转账
- 转入管理员指定钱包

## Dashboard API

| 端点 | 说明 |
|------|------|
| `/api/multi-market/status` | 引擎状态总览 |
| `/api/multi-market/all-positions` | 全市场持仓 |
| `/api/multi-market/forex` | 外汇持仓 |
| `/api/multi-market/index` | 股指持仓 |
| `/api/multi-market/arbitrage` | 套利机会 |
| `/api/multi-market/signals` | 跨市场信号 |
| `/api/multi-market/risk` | 风控报告 |
| `/multi-market.html` | 管理员多市场面板 |
| `multi-v3/public/index.html` | 用户端仪表盘 |
