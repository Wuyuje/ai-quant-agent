# BTC5分钟预测系统 (Polymarket)

基于 Polymarket「Bitcoin Up or Down」5分钟预测市场的自动交易系统。

## 策略

**当前策略（最优配置）**：
- **时点**：轮内第 3 分钟窗口（2.5-4.0 分钟）
- **信号**：币安 BTC 偏离 `dev = (当前价 - 本轮起点价) / 起点价 × 100`
  - 起点 = 本轮开始时刻的价格（整点 1m K 线开盘）
- **方向**：dev > 0 买 UP，dev < 0 买 DOWN
- **门槛**：|dev| ≥ 0.02%
- **买入价上限**：MAX_P = 0.9（市价单，太贵跳过）
- **每轮每用户 1 仓**

**回测（Polymarket 官方结算 498 轮）**：
- dev≥0.02% → 触发 294 笔，胜率 94.2%，每$1 EV +0.438，总盈亏 +128.6（$1/单）

## 核心组件

| 文件 | 说明 |
|---|---|
| `multi_auto_bot.py` | 多用户独立开仓引擎（主策略） |
| `platform_server.py` | 平台服务（管理员/用户仪表盘 + API，端口 8099） |
| `twap_strategy.py` | TWAP 偏离语音信号（WebSocket 实时） |
| `round_recorder.py` | 轮次记录 |
| `watchdog.py` | 进程守护 |
| `admin_v2.html` | 管理员仪表盘 |
| `user.html` | 普通用户仪表盘 |

## 关键机制

1. **deposit wallet 推导**：Polymarket 用户资金在确定性生成的 deposit wallet 上（不是 EOA 地址）。下单/查余额都必须用 deposit wallet：
   ```
   from polymarket._internal.environment import PRODUCTION_CONFIG
   from polymarket._internal.wallet import derive_beacon_deposit_wallet_address
   from eth_account import Account
   signer = Account.from_key(pk).address
   dw = derive_beacon_deposit_wallet_address(signer, PRODUCTION_CONFIG.wallet_derivation)
   ```
   - 管理员 0x9999 → deposit wallet 0xe1688...

2. **多用户独立**：每个用户用自己的私钥 + deposit wallet + size，独立判断信号、下单、记盈亏，互不干扰。

3. **每用户 size**：仪表盘可设置每单金额（挂 users_db.size_usdc），bot 按此下单。

## 管理员仪表盘功能

- 用户账户管理（收益 = Polymarket 真实 netWorth - 充值）
- 当前在途持仓（真实持仓 + 币安实时浮盈估算）
- **手动交易**：买涨 UP / 买跌 DOWN / 卖出（真实下单 Polymarket）
- **交易记录**：按日期下拉，显示每笔（时间/方向/金额/成交价/结果/盈亏）

## 重要教训（踩过的坑）

1. **dev 起点 bug**：`since=(ts-300)*1000`（上轮起点）会算错 dev（虚高约1倍），必须是本轮起点 `ts*1000`。
2. **Polymarket 结算用 PYTH 预言机**，和币安 K 线有 ~20% 差异。
3. **Polymarket 5分钟盘流动性差**：中间价（0.3-0.7）常无挂单，只能吃到 0.86+ 的贵边。
4. **限价挂低价（0.55）会被 RequestRejected**（偏离市场太远）。
5. 回测的「赢率」必须用 **Polymarket 官方结算**（outcomePrices/cashPnl），不能用币安判定（会虚高）。

## 运行

```bash
# 依赖: python3.11 + polymarket + ccxt + eth_account + websockets
# 主策略引擎
python3 multi_auto_bot.py &
# 平台服务（仪表盘）
python3 platform_server.py &   # 端口 8099
# 语音信号
python3 twap_strategy.py &
```

## 风险提示

Polymarket 5分钟预测盘为高风险对赌，实盘表现与回测存在差异，请谨慎控制仓位。
