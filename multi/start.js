/**
 * MultiEngine 启动入口 v2.0
 * 
 * 用法：
 *   node multi/start.js          → 启动 SaaS 多用户模式
 *   node engine.js               → 启动单用户模式（兼容旧版）
 */

const MultiEngine = require('./multi-engine');

async function main() {
  console.log('═══════════════════════════════════════');
  console.log('  🏗️ AI Quant Agent — SaaS Platform v2.0');
  console.log('  💰 钱包登录 + ARK 持仓验证 + 20% 服务费');
  console.log('═══════════════════════════════════════');

  const multi = new MultiEngine();

  process.on('SIGINT', async () => {
    console.log('\n🛑 正在关闭...');
    await multi.shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await multi.shutdown();
    process.exit(0);
  });

  await multi.init();
  const started = await multi.startAllUsers();
  console.log(`\n✅ SaaS 平台就绪！`);
  console.log(`🌐 登录: http://localhost:${process.env.MULTI_PORT || 8010}`);
  console.log(`👥 已启动 ${started} 个用户引擎`);
  console.log('\n等待 ARK 家人登录... 🔗');
}

main().catch(e => {
  console.error('❌ 启动失败:', e);
  process.exit(1);
});
