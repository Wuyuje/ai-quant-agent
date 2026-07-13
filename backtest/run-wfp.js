#!/usr/bin/env node
/**
 * Walk-Forward Pro CLI — 命令行回测入口
 * 
 * 用法:
 *   node backtest/run-wfp.js BTCUSDT
 *   node backtest/run-wfp.js BTCUSDT,ETHUSDT,SOLUSDT --interval=4h --limit=1500
 *   node backtest/run-wfp.js BTCUSDT --no-grid  (跳过参数搜索，快速运行)
 */

const WalkForwardPro = require('./walk-forward-pro');

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('用法: node backtest/run-wfp.js <SYMBOL> [--interval=1h] [--limit=1500] [--no-grid]');
    console.log('示例: node backtest/run-wfp.js BTCUSDT,ETHUSDT,SOLUSDT --interval=4h');
    process.exit(0);
  }

  const symbols = args[0].split(',').map(s => s.trim().toUpperCase());
  const opts = {};
  for (let i = 1; i < args.length; i++) {
    const [k, v] = args[i].split('=');
    if (k === '--interval') opts.interval = v;
    else if (k === '--limit') opts.limit = parseInt(v);
    else if (k === '--no-grid') opts.noGrid = true;
  }

  const wfp = new WalkForwardPro();

  console.log(`\n${'█'.repeat(80)}`);
  console.log(`  Walk-Forward Pro v2.0 — 防过拟合回测框架`);
  console.log(`  品种: ${symbols.join(', ')} | 周期: ${opts.interval||'1h'} | K线: ${opts.limit||1500}`);
  console.log(`${'█'.repeat(80)}`);

  const allResults = [];

  for (const symbol of symbols) {
    try {
      const result = await wfp.fullPipeline(symbol, {
        interval: opts.interval || '1h',
        limit: opts.limit || 1500,
      });
      allResults.push(result);
    } catch(e) {
      console.log(`\n❌ ${symbol} 回测失败: ${e.message}`);
    }
  }

  // 多币种汇总
  if (allResults.length > 1) {
    console.log(`\n${'═'.repeat(80)}`);
    console.log(`📊 多币种汇总`);
    console.log(`${'═'.repeat(80)}`);
    console.log('Symbol'.padEnd(14) + 'PnL%'.padStart(8) + 'Sharpe'.padStart(8) + '胜率'.padStart(8) + '回撤%'.padStart(8) + 'WF评分'.padStart(8) + '稳定性'.padStart(8) + '综合'.padStart(8) + ' 结论');
    console.log(`${'─'.repeat(80)}`);
    for (const r of allResults) {
      const b = r.baseline;
      const s = r.scorecard;
      console.log(
        r.symbol.padEnd(14) +
        b.pnlPct.toFixed(1).padStart(8) +
        b.sharpe.toFixed(2).padStart(8) +
        (b.winRate * 100).toFixed(0).padStart(8) +
        b.maxDrawdown.toFixed(1).padStart(8) +
        r.walkForward.summary.overfitScore.toFixed(0).padStart(8) +
        r.parameterStability.stabilityScore.toString().padStart(8) +
        s.score.toString().padStart(8) +
        ' ' + s.verdict.split(' ')[0]
      );
    }
    console.log(`${'═'.repeat(80)}`);
  }

  // 保存JSON结果
  const fs = require('fs');
  const path = require('path');
  const reportPath = path.join(__dirname, '..', 'data', `wfp-report-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(allResults, null, 2));
  console.log(`\n📁 完整报告已保存: ${reportPath}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
