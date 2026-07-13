# MasterD Multi-Market v97 — 100万用户并发架构

## 核心挑战

| 挑战 | 解决方案 |
|------|---------|
| 100万用户同时在线 | WebSocket集群 + 连接池分片 |
| 100万用户同时交易 | 异步队列 + 批量执行引擎 |
| 100万用户实时数据 | Redis缓存 + 推送扇出 |
| 100万用户资金隔离 | 子账户 + 智能合约钱包 |
| 100万用户API限速 | Binance限速器 + 多账户轮转 |

## 架构设计

```
┌─────────────────────────────────────────────────────────────────┐
│                    Load Balancer (Nginx/HAProxy)                │
│                    WebSocket + HTTP + HTTPS                      │
├──────────┬──────────┬──────────┬──────────┬────────────────────┤
│ WS Node1 │ WS Node2 │ WS Node3 │ WS Node4 │ ... (水平扩展)    │
│ 25万连接  │ 25万连接  │ 25万连接  │ 25万连接  │                   │
├──────────┴──────────┴──────────┴──────────┴────────────────────┤
│                    Message Bus (Redis Pub/Sub)                   │
│                    所有节点共享交易信号/风控指令                    │
├─────────────────────────────────────────────────────────────────┤
│                    Trade Queue (Bull/Redis)                      │
│                    异步排队 → 批量执行 → 结果回调                  │
├──────────┬──────────┬──────────┬──────────────────────────────┤
│ Executor1│ Executor2│ Executor3│ ... (独立进程)                │
│ Binance  │ Binance  │ OKX     │ 跨交易所调度                   │
│ Account1 │ Account2 │ Account3│ 每账户管理~10万用户             │
├──────────┴──────────┴──────────┴──────────────────────────────┤
│                    Data Layer                                   │
│  Redis (实时) │ PostgreSQL (持久化) │ S3 (历史数据)              │
└─────────────────────────────────────────────────────────────────┘
```

## 关键组件

### 1. WebSocket连接管理器

```javascript
// 连接分片: 每个Node处理25万连接
// 100万用户 = 4个Node
class WSManager {
  constructor() {
    this.maxConnectionsPerNode = 250000;
    this.heartbeatInterval = 30000; // 30秒心跳
    this.reconnectTimeout = 5000;
  }
  
  // 用户连接时: 
  // 1. 从Redis获取用户订阅的主题
  // 2. 注册到对应分片
  // 3. 推送当前持仓/行情
  onConnect(ws, userId) {
    this.subscribe(userId, ['positions', 'signals', 'price']);
  }
  
  // 推送消息:
  // 1. 优先级: 风控 > 交易 > 信号 > 行情
  // 2. 批量推送: 同一消息扇出给所有订阅者
  broadcast(topic, data, priority = 'normal') {
    // Redis Pub/Sub → 所有Node → 对应用户
  }
}
```

### 2. 异步交易队列

```javascript
// 核心: 100万用户不能同步交易, 必须异步排队
class TradeQueue {
  constructor() {
    this.maxConcurrency = 100; // 同时执行100笔
    this.batchSize = 50;       // 批量执行50笔
    this.retryCount = 3;
  }
  
  // 用户请求交易 → 入队 → 按优先级执行 → 回调
  async enqueue(userId, trade) {
    // 1. 检查用户余额
    // 2. 检查风控
    // 3. 加入队列
    // 4. 返回排队编号
  }
  
  async processBatch() {
    // 批量获取待执行交易
    // 按交易对分组 (BTC/ETH/SOL...)
    // 同一交易对的订单合并执行
    // 减少API调用次数
  }
}
```

### 3. 资金路由器 (100万用户版)

```javascript
// 每个用户独立子账户
class UserWalletManager {
  constructor() {
    // 方案A: Binance子账户 (推荐)
    // 1个主账户 → N个子账户
    // 每个子账户管理~1000用户
    
    // 方案B: 智能合约钱包
    // 1个合约 → 用户通过签名授权
    // 更去中心化, 但gas成本高
  }
  
  // 用户入金: 转入主账户 → 分配到子账户
  async deposit(userId, amount) {
    // 1. 记录入金
    // 2. 分配到对应子账户
    // 3. 更新用户余额
  }
  
  // 用户出金: 子账户 → 主账户 → 用户钱包
  async withdraw(userId, amount) {
    // 1. 检查可用余额
    // 2. 从子账户转出
    // 3. 转到用户指定钱包
  }
}
```

### 4. 限速器

```javascript
// Binance API限速: 1200请求/分钟
// 100万用户 → 需要100个API Key轮转
class RateLimiter {
  constructor() {
    this.keys = []; // 多个API Key
    this.currentKey = 0;
    this.requestCounts = {};
    this.maxPerMinute = 1200;
  }
  
  async getNextKey() {
    // 轮转到下一个未超限的Key
    // 如果所有Key都超限, 等待最早可用的
  }
}
```

## 数据库设计

```sql
-- 用户表
CREATE TABLE users (
  id BIGINT PRIMARY KEY,
  wallet_address VARCHAR(42) UNIQUE,
  created_at TIMESTAMP,
  tier VARCHAR(20), -- free/basic/pro/vip
  trading_enabled BOOLEAN DEFAULT false,
  cex_api_key_encrypted TEXT,
  cex_secret_encrypted TEXT
);

-- 交易记录
CREATE TABLE trades (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT,
  market VARCHAR(20), -- crypto/gold/forex/index
  symbol VARCHAR(20),
  side VARCHAR(5),
  entry_price NUMERIC,
  exit_price NUMERIC,
  qty NUMERIC,
  pnl NUMERIC,
  fee_platform NUMERIC,
  fee_eco NUMERIC,
  strategy VARCHAR(50),
  opened_at TIMESTAMP,
  closed_at TIMESTAMP
);

-- 费用记录
CREATE TABLE fees (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT,
  type VARCHAR(20), -- platform/ecology
  amount NUMERIC,
  wallet_address VARCHAR(42),
  tx_hash VARCHAR(66),
  created_at TIMESTAMP
);
```

## 扩展路径

| 用户量 | 服务器 | WebSocket Node | 数据库 | 估计月成本 |
|--------|--------|----------------|--------|-----------|
| 1,000 | 1台 4C8G | 1 | SQLite | $50 |
| 10,000 | 1台 8C16G | 1 | PostgreSQL | $200 |
| 100,000 | 2台 16C32G | 2 | PostgreSQL+Redis | $800 |
| 1,000,000 | 4台 32C64G | 4 | PostgreSQL+Redis+S3 | $3,000 |
| 10,000,000 | 8台 64C128G | 8 | 分布式集群 | $15,000 |

## 关键优化

### 1. 行情推送压缩
- 用户只订阅持有的币种行情
- 增量更新 (只推价格变化)
- 二进制协议 (MessagePack) 而非JSON

### 2. 批量执行引擎
- 同一交易对的订单合并执行
- 一次API调用处理100笔订单
- 减少99%的API调用

### 3. 智能缓存
- Redis缓存所有用户的持仓信息
- 行情数据60秒过期重拉
- 策略信号10秒缓存

### 4. 连接池复用
- Binance WebSocket连接在Executor之间共享
- 避免每个用户单独建立连接
- 100万用户只需100个Binance连接

## 部署方案

### Phase 1: 单机 (当前)
- 1台VPS, 8个引擎, SQLite
- 支持1,000用户

### Phase 2: 垂直扩展
- 1台高配服务器, PostgreSQL, Redis
- 支持10,000用户

### Phase 3: 水平扩展
- 4台服务器, Nginx负载均衡
- WebSocket集群, Redis集群
- 支持100,000用户

### Phase 4: 分布式
- K8s集群, 微服务架构
- 多交易所, 多地区部署
- 支持1,000,000用户
