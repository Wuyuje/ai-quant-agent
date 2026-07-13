# 🔍 量化机器人诊断报告

**诊断日期**: 2026-06-26  
**症状**: 持仓一天没有买卖交易  
**数据**: 119笔交易，最近20笔中12笔是开仓(OPEN)，只有8笔平仓(CLOSE)，最后一条交易在 06-25 18:04

---

## 📊 关键发现

### 当前状态
- **机器人已停止运行**（process list 为空，可能崩溃或被手动停止）
- **引擎状态**: 持仓追踪为空（0个持仓），但 NEARUSDT 有残留峰值PnL=11.9%
- **最后活跃时间**: 2026-06-25 18:04
- **总PnL**: -$5.17 | 胜率极低（3胜11负）

---

## 🔴 发现的关键Bug（导致「持仓不交易」）

### Bug 1: 持仓管理与开仓的指标数据源不一致 ⭐⭐⭐

**engine.js `_managePositions()` 第172行**:
```javascript
// 强制刷新 klines，确保指标实时
const klineAge = lastKline ? Date.now() - lastKline.time : 999999;
if (klineAge > 60000) {
  await this.dataBus.fetchKlines(symbol, '1h', 150);
}
```
但 `this.dataBus.calculateIndicators(symbol)` 使用的K线数组 **不会更新到最新状态**，因为：
- WebSocket 在 `_mainLoop` 中 `connectWS` 后只接收未来的新K线
- `fetchKlines` 会 **替换整个数组**（覆盖之前的WS数据），但如果WS恰好在这之间收到新数据，会产生竞态
- 更关键的是：**指标计算结果可能基于过时的K线**，导致趋势反转信号永远不触发

**影响**: 持仓管理的止损/止盈判断基于过时数据 → 该卖的不卖 → 「持仓一天不交易」

### Bug 2: 趋势跟踪止盈死区 ⭐⭐⭐

**engine.js 第219行**:
```javascript
if (peak > 5) {
  const trailRatio = trendStr >= 14 ? 0.35 : trendStr >= 12 ? 0.40 : 0.50;
  const trailFloor = peak * trailRatio;
  if (pnlPct < trailFloor) {
    await this._executeClose(...);
  }
}
```
**问题**: 如果 PnL 在 0%~5% 之间（即没有盈利超过5%），趋势跟踪止盈 **完全不启动**。持仓可能在微利/微亏区间无限期持有，因为：
- 硬止损 -15% 还没触发
- 趋势跟踪 (peak > 5) 没启动
- DI/MA 反转信号在震荡市中不明显

**影响**: 中等亏损的仓位（-5% 到 +5%）会被无限期持有

### Bug 3: 评分门槛太高 + 选币范围不足 ⭐⭐

**engine_state.json**: `scoreThreshold: 9`  
**engine.js `_v11Score()`**: 需要 ADX≥18 + EMA排列 + BB回调 + RSI中性 + 放量 + EMA距离近 + DI差大，全部加起来才能达到9分

**实际门槛拆解**（要拿到9分）:
- ADX≥18 = 1分
- EMA排列 = 2-3分
- BB回调 = 1-2分
- RSI = 1分
- 成交量 = 0-1分
- EMA距离 = 0-1分
- DI差 = 0-2分

**在震荡市或趋势不明确时，几乎不可能达到9分** → 机器人永远在「观望」→ 不开新仓

### Bug 4: 开仓与持仓管理的职责冲突 ⭐⭐

**问题**: `_mainLoop()` 每轮都执行 `_managePositions()`，但 `aiEngine.managePositions()` 也在检测趋势反转。两套系统可能互相矛盾：
- Engine 的 `_managePositions` 用 BB中轨 + MA死叉 + DI反转 → 会频繁平仓
- AI Engine 的 `_shouldClosePositionV7` 用 score>0.4反转 → 不频繁

**结果**: 平仓可能在不该平的时候平了，或者该平的时候没平

### Bug 5: DeepSeek API 超时阻塞主循环 ⭐⭐

**ai-engine.js 第57行**:
```javascript
if (this.deepseek && this.deepseek.apiKey) {
  deepseekInsight = await this.deepseek.analyzeMarket(...);
}
```
**超时设置**: 30秒  
**问题**: 虽然 v7 中 DeepSeek 已标注为「仅供参考」不参与决策，但 `await` 仍然在主循环中执行。如果 DeepSeek API 慢或挂了，每个币分析要等30秒 → **15个候选币 × 30秒 = 7.5分钟阻塞**

**影响**: 主循环卡顿，持仓管理被延迟

### Bug 6: WebSocket 重连后指标数据丢失 ⭐

**databus.js `connectWS()`**:
```javascript
this.ws = new WebSocket(url);
```
**问题**: 如果 WebSocket 断开重连，`connectWS` 会 `this.ws.close()` 旧连接。但重连期间（5秒+）新K线不会被接收。而 `fetchKlines` 只在启动时批量拉一次，**之后依赖 WS**。如果 WS 断线时间长，指标计算会严重滞后。

### Bug 7: Guardian `syncAllPositions` 每轮清空重建 ⭐

**guardian.js 第33行**:
```javascript
// 清空本地状态，从链上重建
this.positions = {};
for (const pos of chainPositions) { ... }
```
**问题**: 每5秒调用一次 `syncAllPositions`，每次都清空 `this.positions`。如果 Binance API 偶尔超时或返回空数组，所有本地持仓追踪数据会丢失 → 开仓状态、PnL追踪全部归零。

---

## 🟡 中等问题

### M1: 交易记录中存在「0收益开仓」
最后12条交易中，开仓记录的 `PnL=0.00`，说明这些是 **新开仓** 而非平仓。机器人在 17:55-18:04 密集开了5个新仓（ENA、TAO、SEI、WLFI、NEAR），但之后没有平仓记录 → **可能是开仓后机器人崩溃了**

### M2: 固定止盈已废弃但残留逻辑
`tpPct: 999`（设为999=不触发），但 `ai-engine.js` 第206行仍有 `pnlPct >= 15` 的固定止盈逻辑，与 engine 的趋势跟踪止盈冲突。

### M3: 每日PnL重置基于UTC
`_checkDailyPnlReset()` 用 UTC 0:00 重置，但用户可能在不同时间段观察到不一致的「日亏损」数据。

---

## ✅ 已正确实现的部分

1. 多仓位管理（最多6个）
2. 动态杠杆（5-12x，基于趋势强度）
3. 硬止损保护（-15%）
4. 成本核算（手续费+费率+滑点 > 预期利润x3 才开仓）
5. 持仓状态持久化（engine_state.json）

---

## 🔧 修复建议（按优先级排序）

### P0: 确保机器人重启
当前进程列表为空，机器人已停止。需要重启。

### P1: 修复持仓管理的「死区」问题
在 `_managePositions` 中添加：
```javascript
// 超过3小时的持仓，即使微利/微亏也要评估是否平仓
const holdHours = (Date.now() - (this._openTime[symbol] || Date.now())) / 3600000;
if (holdHours > 3 && Math.abs(pnlPct) < 3) {
  // 长时间持仓 + 无方向 = 平仓释放资金
  if (ind && ind.adx < 20) { // ADX低=无趋势
    await this._executeClose(symbol, `⏰ 超时平仓: ${holdHours.toFixed(1)}h ADX=${ind.adx.toFixed(0)}`);
    continue;
  }
}
```

### P2: DeepSeek 调用改为非阻塞
```javascript
// 改为 Promise.race + 超时5秒
const dsPromise = this.deepseek?.analyzeMarket(...);
const timeoutPromise = new Promise(r => setTimeout(() => r(null), 5000));
deepseekInsight = await Promise.race([dsPromise, timeoutPromise]);
```

### P3: 降低开仓评分门槛
`scoreThreshold` 从 9 降到 7，让机器人在趋势较弱时也能开仓。

### P4: Guardian syncAllPositions 增加容错
```javascript
// 如果链上返回空但本地有持仓，保留本地状态
if (chainPositions.length === 0 && Object.keys(this.positions).length > 0) {
  this.log('⚠️ 链上返回0持仓但本地有持仓，保留本地状态');
  return;
}
```
