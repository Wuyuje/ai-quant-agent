/**
 * PairScanner — 自动扫描协整配对
 * 
 * 扫描所有主流交易对，找出具有均值回归特性的配对
 * 每小时运行一次，自动更新可交易配对列表
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ═══ 配置 ═══
const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'MATICUSDT',
  'NEARUSDT', 'ATOMUSDT', 'FTMUSDT', 'ALGOUSDT', 'ICPUSDT',
  'LTCUSDT', 'ETCUSDT', 'BCHUSDT', 'UNIUSDT', 'AAVEUSDT',
  'DOGEUSDT', 'SHIBUSDT', 'PEPEUSDT', 'WIFUSDT', 'ARBUSDT',
  'OPUSDT', 'SUIUSDT', 'APTUSDT',
];

// ═══ 拉取历史数据 ═══
function fetchKlines(symbol, interval = '1h', limit = 500) {
  return new Promise((resolve) => {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const req = https.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const raw = JSON.parse(data);
          resolve(raw.map(k => parseFloat(k[4]))); // close prices
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

// ═══ 统计函数 ═══
function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function std(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + Math.pow(v - m, 2), 0) / arr.length);
}

// 对数收益率
function logReturns(prices) {
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] > 0 && prices[i - 1] > 0) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    }
  }
  return returns;
}

// 皮尔逊相关系数
function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 20) return 0;
  const mA = mean(a.slice(-n)), mB = mean(b.slice(-n));
  let cov = 0, vA = 0, vB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[a.length - n + i] - mA;
    const db = b[b.length - n + i] - mB;
    cov += da * db; vA += da * da; vB += db * db;
  }
  return cov / Math.sqrt(vA * vB || 1);
}

// OLS 回归 beta
function olsBeta(y, x) {
  const n = Math.min(y.length, x.length);
  let sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumXY += x[x.length - n + i] * y[y.length - n + i];
    sumX2 += Math.pow(x[x.length - n + i], 2);
  }
  return sumX2 > 0 ? sumXY / sumX2 : 0;
}

// 半衰期估计
function halfLife(spreads) {
  if (spreads.length < 30) return Infinity;
  const lag = spreads.slice(0, -1);
  const diff = spreads.slice(1).map((s, i) => s - spreads[i]);
  let sumXY = 0, sumX2 = 0;
  for (let i = 0; i < lag.length; i++) {
    sumXY += lag[i] * diff[i];
    sumX2 += lag[i] * lag[i];
  }
  const beta = sumX2 > 0 ? sumXY / sumX2 : 0;
  return beta < 0 ? -Math.log(2) / beta : Infinity;
}

// ADF 简化版（检查均值回归）
function adfTest(spreads) {
  if (spreads.length < 30) return { pValue: 1, stationary: false };
  const lag = spreads.slice(0, -1);
  const diff = spreads.slice(1).map((s, i) => s - spreads[i]);
  let sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < lag.length; i++) {
    sumXY += lag[i] * diff[i];
    sumX2 += lag[i] * lag[i];
    sumY2 += diff[i] * diff[i];
  }
  const beta = sumX2 > 0 ? sumXY / sumX2 : 0;
  const se = Math.sqrt((sumY2 / lag.length - beta * sumXY / lag.length) / (sumX2 / lag.length));
  const t = se > 0 ? beta / se : 0;
  // 简化：ADF临界值约 -2.86 (5%显著性)
  return { t, stationary: t < -2.86, pValue: t < -3.5 ? 0.01 : t < -2.86 ? 0.05 : 0.5 };
}

// ═══ 主扫描函数 ═══
async function scanPairs() {
  console.log(`\n🔍 PairScanner — 扫描 ${SYMBOLS.length} 个交易对\n`);

  // 拉取所有价格
  const prices = {};
  const batchSize = 6;
  for (let i = 0; i < SYMBOLS.length; i += batchSize) {
    const batch = SYMBOLS.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(s => fetchKlines(s)));
    batch.forEach((s, j) => { prices[s] = results[j]; });
    process.stdout.write(`  已获取 ${Math.min(i + batchSize, SYMBOLS.length)}/${SYMBOLS.length}\r`);
  }
  console.log('');

  // 过滤有效数据
  const validSymbols = SYMBOLS.filter(s => prices[s] && prices[s].length >= 200);
  console.log(`📊 有效交易对: ${validSymbols.length}\n`);

  // 两两配对扫描
  const pairs = [];
  for (let i = 0; i < validSymbols.length; i++) {
    for (let j = i + 1; j < validSymbols.length; j++) {
      const symA = validSymbols[i];
      const symB = validSymbols[j];
      const pA = prices[symA];
      const pB = prices[symB];

      // 计算对数收益率相关性
      const retA = logReturns(pA);
      const retB = logReturns(pB);
      const corr = pearson(retA, retB);

      if (Math.abs(corr) < 0.5) continue; // 相关性太低

      // 计算 hedge ratio
      const hedgeRatio = olsBeta(pA.slice(-100), pB.slice(-100));

      // 计算价差
      const spread = [];
      const n = Math.min(pA.length, pB.length, 200);
      for (let k = 0; k < n; k++) {
        spread.push(pA[pA.length - n + k] - hedgeRatio * pB[pB.length - n + k]);
      }

      // ADF 检验
      const adf = adfTest(spread);

      // 半衰期
      const hl = halfLife(spread);

      // Z-Score
      const sMean = mean(spread);
      const sStd = std(spread);
      const currentZ = sStd > 0 ? (spread[spread.length - 1] - sMean) / sStd : 0;

      if (hl < 200 && hl > 0 && (adf.stationary || hl < 100 && Math.abs(corr) > 0.7)) {
        pairs.push({
          pair: `${symA}/${symB}`,
          corr: Math.round(corr * 1000) / 1000,
          hedgeRatio: Math.round(hedgeRatio * 10000) / 10000,
          halfLife: Math.round(hl),
          zScore: Math.round(currentZ * 100) / 100,
          adfT: Math.round(adf.t * 100) / 100,
          adfP: adf.pValue,
          tradeable: Math.abs(currentZ) > 1.5 && hl < 100,
          signal: currentZ > 2 ? 'SHORT_SPREAD' : currentZ < -2 ? 'LONG_SPREAD' : 'WAIT',
        });
      }
    }
  }

  // 排序
  pairs.sort((a, b) => a.halfLife - b.halfLife);

  // 输出
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                 🎯 协整配对扫描结果');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  配对              相关性  对冲比   半衰期  Z-Score  信号');
  console.log('  ────────────────  ──────  ───────  ──────  ───────  ──────────');

  for (const p of pairs.slice(0, 20)) {
    const signalEmoji = p.signal === 'LONG_SPREAD' ? '🟢做多' :
                        p.signal === 'SHORT_SPREAD' ? '🔴做空' : '⚪等待';
    console.log(`  ${p.pair.padEnd(18)} ${String(p.corr).padStart(6)}  ${String(p.hedgeRatio).padStart(7)}  ${String(p.halfLife).padStart(6)}h  ${String(p.zScore).padStart(7)}  ${signalEmoji}`);
  }

  console.log(`\n  可交易配对: ${pairs.filter(p => p.tradeable).length} / ${pairs.length} 对`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // 保存
  const resultPath = path.join(__dirname, '..', 'data', 'pair-scanner.json');
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    scanned: validSymbols.length,
    pairs,
    tradeable: pairs.filter(p => p.tradeable),
  }, null, 2));

  console.log(`💾 结果已保存: ${resultPath}`);
  return pairs;
}

// ═══ CLI ═══
scanPairs().catch(e => {
  console.error('❌ 扫描失败:', e.message);
  process.exit(1);
});
