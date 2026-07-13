/**
 * v63: 参数网格搜索优化引擎
 * 
 * 功能：
 *   1. 对核心参数做网格搜索：止损/止盈/ATR倍数/最低分数/保护期/反转缓冲/移动止盈
 *   2. 每个参数组合运行完整回测
 *   3. 输出最优参数组合 + 参数敏感性热力图
 *   4. 自动推荐最佳参数集
 * 
 * 用法：node backtest/grid-search.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// 复用策略回测模块的函数
const { generateSignal, fetchKlines, backtestStrategy, backtestMultiSymbol } = require('./strategy-backtest');

// ═══════════════════════════════════════════
// 网格搜索配置
// ═══════════════════════════════════════════
const GRID = {
  symbols: ['ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'],
  interval: '1h',
  limit: 1000,
  initialCapital: 1000,
  dexCostPct: 0.016,

  // 参数搜索空间
  searchSpace: {
    stopLossPct: [0.02, 0.03, 0.04, 0.05],
    takeProfitMulti: [3, 4, 5, 6, 7],
    minScore: [5, 6, 7, 8],
    protectionMins: [15, 30, 45],
    reversalBufferPct: [0.02, 0.03, 0.04],
    trailingPeakPct: [0.02, 0.03, 0.04],
    trailingDropPct: [0.3, 0.4, 0.5],
  },

  // 优化目标权重
  objective: {
    roi: 0.4,        // ROI 权重
    sharpe: 0.3,     // 夏普比率权重
    drawdown: 0.2,   // 回撤（越低越好）
    winRate: 0.1,    // 胜率权重
  },
};

// ═══════════════════════════════════════════
// 生成参数组合（不全部遍历，用随机采样减少组合数）
// ═══════════════════════════════════════════
function generateParamCombos(searchSpace, maxCombos = 200) {
  const keys = Object.keys(searchSpace);
  const totalCombos = keys.reduce((acc, k) => acc * searchSpace[k].length, 1);
  console.log(`  参数空间: ${totalCombos} 种组合 (限制${maxCombos})`);

  const combos = [];
  if (totalCombos <= maxCombos) {
    // 全量遍历
    function recurse(idx, current) {
      if (idx === keys.length) {
        combos.push({ ...current });
        return;
      }
      const key = keys[idx];
      for (const val of searchSpace[key]) {
        current[key] = val;
        recurse(idx + 1, current);
      }
    }
    recurse(0, {});
  } else {
    // 随机采样
    for (let i = 0; i < maxCombos; i++) {
      const combo = {};
      for (const key of keys) {
        const vals = searchSpace[key];
        combo[key] = vals[Math.floor(Math.random() * vals.length)];
      }
      combos.push(combo);
    }
  }
  return combos;
}

// ═══════════════════════════════════════════
// 综合评分函数
// ═══════════════════════════════════════════
function calcObjectiveScore(result) {
  const roiScore = Math.max(-50, Math.min(100, result.roi)); // 限制范围
  const sharpeScore = Math.max(-5, Math.min(10, result.sharpe));
  const drawdownScore = -Math.min(50, result.maxDrawdown); // 越低越好，取负
  const winRateScore = result.winRate - 50; // 偏离50%的差值

  return (
    roiScore * GRID.objective.roi +
    sharpeScore * GRID.objective.sharpe +
    drawdownScore * GRID.objective.drawdown +
    winRateScore * GRID.objective.winRate
  );
}

// ═══════════════════════════════════════════
// 主函数
// ═══════════════════════════════════════════
async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  v63 参数网格搜索优化引擎');
  console.log('═══════════════════════════════════════════\n');

  // 1. 拉取K线
  console.log('📊 拉取历史K线数据...');
  const allKlines = {};
  for (const sym of GRID.symbols) {
    allKlines[sym] = await fetchKlines(sym, GRID.interval, GRID.limit);
    console.log(`  ${sym}: ${allKlines[sym].length} 根K线`);
  }

  // 2. 生成参数组合
  console.log('\n🔧 生成参数组合...');
  const combos = generateParamCombos(GRID.searchSpace, 200);
  console.log(`  将测试 ${combos.length} 种组合\n`);

  // 3. 逐组合回测
  console.log('═══ 开始网格搜索 ═══\n');
  const results = [];
  let tested = 0;

  for (const combo of combos) {
    tested++;
    if (tested % 20 === 0) console.log(`  进度: ${tested}/${combos.length}...`);

    const params = {
      ...combo,
      dexCostPct: GRID.dexCostPct,
      initialCapital: GRID.initialCapital,
    };

    // 多币种组合回测
    const result = backtestMultiSymbol(allKlines, GRID.symbols, params);
    const objScore = calcObjectiveScore(result);

    results.push({
      params: combo,
      totalTrades: result.totalTrades,
      wins: result.wins,
      losses: result.losses,
      winRate: result.winRate,
      avgWin: result.avgWin,
      avgLoss: result.avgLoss,
      profitFactor: result.profitFactor,
      maxDrawdown: result.maxDrawdown,
      roi: result.roi,
      sharpe: result.sharpe,
      finalCapital: result.finalCapital,
      objScore,
    });
  }

  // 4. 排序（按综合得分降序）
  results.sort((a, b) => b.objScore - a.objScore);

  // 5. 输出 Top 20
  console.log('\n═══ Top 20 最优参数组合 ═══\n');
  console.log('  排名 | 综合分 | ROI%   | 胜率%  | 回撤%  | 夏普  | 交易数 | 止损% | 止盈×ATR | 最低分 | 保护min | 反转% | 峰值% | 回撤%');
  console.log('  ────┼────────┼─────────┼────────┼────────┼───────┼────────┼───────┼──────────┼────────┼─────────┼───────┼───────┼──────');

  for (let i = 0; i < Math.min(20, results.length); i++) {
    const r = results[i];
    const p = r.params;
    console.log(
      `  ${String(i + 1).padEnd(4)} | ${r.objScore.toFixed(1).padEnd(6)} | ${r.roi.toFixed(2).padEnd(7)} | ${r.winRate.toFixed(1).padEnd(6)} | ${r.maxDrawdown.toFixed(1).padEnd(6)} | ${r.sharpe.toFixed(2).padEnd(5)} | ${String(r.totalTrades).padEnd(6)} | ${(p.stopLossPct * 100).toFixed(0).padEnd(5)} | ${p.takeProfitMulti.toString().padEnd(8)} | ${p.minScore.toString().padEnd(6)} | ${p.protectionMins.toString().padEnd(7)} | ${(p.reversalBufferPct * 100).toFixed(0).padEnd(5)} | ${(p.trailingPeakPct * 100).toFixed(0).padEnd(5)} | ${p.trailingDropPct.toFixed(1).padEnd(4)}`
    );
  }

  // 6. 参数敏感性分析
  console.log('\n═══ 参数敏感性分析 ═══\n');

  const paramKeys = Object.keys(GRID.searchSpace);
  for (const key of paramKeys) {
    const values = GRID.searchSpace[key];
    const sensitivity = {};

    for (const val of values) {
      const matching = results.filter(r => r.params[key] === val);
      if (matching.length > 0) {
        const avgROI = matching.reduce((a, b) => a + b.roi, 0) / matching.length;
        const avgSharpe = matching.reduce((a, b) => a + b.sharpe, 0) / matching.length;
        const avgWinRate = matching.reduce((a, b) => a + b.winRate, 0) / matching.length;
        sensitivity[val] = { avgROI, avgSharpe, avgWinRate, count: matching.length };
      }
    }

    console.log(`  ${key}:`);
    for (const [val, stats] of Object.entries(sensitivity)) {
      const valStr = typeof val === 'number' && val < 1 ? (val * 100).toFixed(0) + '%' : val;
      console.log(`    ${String(valStr).padEnd(8)} → ROI=${stats.avgROI.toFixed(2).padEnd(8)}% 夏普=${stats.avgSharpe.toFixed(2).padEnd(6)} 胜率=${stats.avgWinRate.toFixed(1)}% (${stats.count}组)`);
    }
    console.log();
  }

  // 7. 推荐最佳参数
  const best = results[0];
  console.log('═══ 🏆 推荐最佳参数组合 ═══\n');
  console.log(`  综合得分: ${best.objScore.toFixed(2)}`);
  console.log(`  ROI: ${best.roi.toFixed(2)}% | 胜率: ${best.winRate.toFixed(1)}% | 回撤: ${best.maxDrawdown.toFixed(1)}% | 夏普: ${best.sharpe.toFixed(2)}`);
  console.log(`  交易数: ${best.totalTrades} (胜${best.wins}/负${best.losses})`);
  console.log(`  盈亏比: ${(best.avgWin / Math.max(0.01, best.avgLoss)).toFixed(2)} | 利润因子: ${best.profitFactor.toFixed(2)}`);
  console.log('\n  参数:');
  for (const [k, v] of Object.entries(best.params)) {
    const vStr = typeof v === 'number' && v < 1 ? (v * 100).toFixed(0) + '%' : v;
    console.log(`    ${k}: ${vStr}`);
  }

  // 8. 保存结果
  const report = {
    timestamp: new Date().toISOString(),
    totalCombos: combos.length,
    best: { params: best.params, ...best },
    top20: results.slice(0, 20),
    sensitivity: {},
  };

  // 保存敏感性分析
  for (const key of paramKeys) {
    const values = GRID.searchSpace[key];
    report.sensitivity[key] = {};
    for (const val of values) {
      const matching = results.filter(r => r.params[key] === val);
      if (matching.length > 0) {
        report.sensitivity[key][val] = {
          avgROI: matching.reduce((a, b) => a + b.roi, 0) / matching.length,
          avgSharpe: matching.reduce((a, b) => a + b.sharpe, 0) / matching.length,
          avgWinRate: matching.reduce((a, b) => a + b.winRate, 0) / matching.length,
        };
      }
    }
  }

  const reportPath = path.join(__dirname, '..', 'data', 'grid-search-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n📄 报告已保存: ${reportPath}`);

  return report;
}

main().then(() => {
  console.log('\n✅ 参数网格搜索完成');
  process.exit(0);
}).catch(e => {
  console.error('❌ 网格搜索失败:', e);
  process.exit(1);
});
