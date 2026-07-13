/**
 * Multi-v3 启动入口
 * 
 * 用法：node multi-v3/start.js
 * 
 * 启动顺序：
 *   1. MessageBus — 消息通信
 *   2. RiskIsolator — 风控
 *   3. SubscriptionManager — 订阅
 *   4. WebSocketHub — 推送
 *   5. UserPool — 连接池
 *   6. AdminDashboard — 管理
 *   7. MultiEngine — 主引擎
 *   8. 加载用户 → 启动交易
 */

const MultiEngine = require('./multi-engine-v3');

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  ARK Quant Agent — Multi-Engine v3.0        ║');
  console.log('║  百万用户量化机器人框架                        ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');

  const engine = new MultiEngine({
    port: parseInt(process.env.MULTI_PORT || '8010'),
    wsPort: parseInt(process.env.WS_PORT || '8015'),
  });

  try {
    await engine.init();
    engine.start();
    console.log('');
    console.log(`✅ Multi-Engine v3 运行中`);
    console.log(`   HTTP API: http://localhost:${engine.config.port}`);
    console.log(`   WebSocket: ws://localhost:${engine.config.wsPort}/ws`);
    console.log(`   管理面板: http://localhost:${engine.config.port}/admin/overview?token=ark-admin-v3-secret`);
    console.log('');
  } catch (e) {
    console.error('❌ 启动失败:', e.message);
    process.exit(1);
  }

  // 优雅关闭
  process.on('SIGINT', async () => {
    console.log('\n收到 SIGINT，优雅关闭...');
    await engine.shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n收到 SIGTERM，优雅关闭...');
    await engine.shutdown();
    process.exit(0);
  });
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
