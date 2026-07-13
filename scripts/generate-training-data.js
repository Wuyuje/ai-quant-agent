#!/usr/bin/env node
/**
 * v100: 大规模训练数据生成器
 * 
 * 从Binance拉取多品种×多时间框架K线数据
 * 提取12维特征向量，生成带标签的训练样本
 * 
 * 目标: 5000-20000+ 训练样本
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

// ═════�════════════════════════════════════
// 配置
// ═══════════════════════════════════════════

const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT',
  'MATICUSDT', 'UNIUSDT', 'LTCUSDT', 'ATOMUSDT', 'NEARUSDT',
  'APTUSDT', 'ARBUSDT', 'OPUSDT', 'FILUSDT', 'AAVEUSDT',
];

const TIMEFRAMES = [
  { interval: '1h',  limit: 1500, weight: 1.0 },
  { interval: '15m', limit: 1500, weight: 0.8 },
  { interval: '4h',  limit: 1500, weight: 0.9 },
  { interval: '5m',  limit: 1500, weight: 0.6 },
];

const OUTPUT_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'kline-features.json');
const RAW_CACHE = path.join(OUTPUT_DIR, 'kline-raw-cache.json');

// ═══════════════════════════════════════════
// HTTP 请求
// ═══════════════════════════════════════════

function fetchKlines(symbol, interval, limit) {
  return new Promise((resolve, reject) => {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    https.get(url, { timeout: 10000 }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const arr = JSON.parse(data);
          if (arr.code) { reject(new Error(`${symbol}: ${arr.msg}`)); return; }
          // 统一格式
          const klines = arr.map(k => ({
            openTime: k[0],
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
            closeTime: k[6],
            quoteVolume: parseFloat(k[7]),
            trades: k[8],
          }));
          resolve(klines);
        } catch (e) { reject(e); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

// ═══════════════════════════════════════════
// 技术指标计算
// ═══════════════════════════════════════════

function sma(arr, period) {
  if (arr.length < period) return arr.map(() => null);
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += arr[j];
    result.push(sum / period);
  }
  return result;
}

function ema(arr, period) {
  const k = 2 / (period + 1);
  const result = [arr[0]];
  for (let i = 1; i < arr.length; i++) {
    result.push(arr[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return closes.map(() => 50);
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }
  const result = [];
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i < period; i++) result.push(50);
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push(100 - 100 / (1 + rs));
  }
  result.push(50); // 补齐
  return result;
}

function atr(klines, period = 14) {
  if (klines.length < period + 1) return klines.map(() => 0);
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const h = klines[i].high, l = klines[i].low, pc = klines[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const result = [0];
  let avg = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i < period; i++) result.push(avg);
  for (let i = period; i < trs.length; i++) {
    avg = (avg * (period - 1) + trs[i]) / period;
    result.push(avg);
  }
  return result;
}

function bollingerBands(closes, period = 20) {
  const smaArr = sma(closes, period);
  const upper = [], lower = [];
  for (let i = 0; i < closes.length; i++) {
    if (smaArr[i] === null) { upper.push(null); lower.push(null); continue; }
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) sumSq += Math.pow(closes[j] - smaArr[i], 2);
    const std = Math.sqrt(sumSq / period);
    upper.push(smaArr[i] + 2 * std);
    lower.push(smaArr[i] - 2 * std);
  }
  return { mid: smaArr, upper, lower };
}

// ═══════════════════════════════════════════
// 特征提取（12维）
// ═══════════════════════════════════════════

function extractFeatures(klines, idx) {
  if (idx < 60) return null;
  
  const closes = klines.slice(0, idx + 1).map(k => k.close);
  const volumes = klines.slice(0, idx + 1).map(k => k.volume);
  
  const price = closes[closes.length - 1];
  
  // 1. 价格变化率 (5/10/20/60期)
  const r5 = (price - closes[closes.length - 6]) / closes[closes.length - 6];
  const r10 = (price - closes[closes.length - 11]) / closes[closes.length - 11];
  const r20 = (price - closes[closes.length - 21]) / closes[closes.length - 21];
  const r60 = (price - closes[closes.length - 61]) / closes[closes.length - 61];
  
  // 2. RSI(14)
  const rsiArr = rsi(closes, 14);
  const rsiVal = rsiArr[rsiArr.length - 1] / 100;
  
  // 3. 布林带位置
  const bb = bollingerBands(closes, 20);
  const bbPos = bb.upper[idx] && bb.lower[idx] 
    ? (price - bb.lower[idx]) / (bb.upper[idx] - bb.lower[idx])
    : 0.5;
  
  // 4. ATR归一化
  const atrArr = atr(klines, 14);
  const atrNorm = atrArr[idx] / price;
  
  // 5. 成交量变化
  const vol5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const vol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volRatio = vol20 > 0 ? vol5 / vol20 : 1;
  
  // 6. MACD
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = ema12[idx] - ema26[idx];
  const macdNorm = price > 0 ? macdLine / price * 100 : 0;
  
  // 7. 趋势强度 (价格 vs SMA20)
  const sma20 = sma(closes, 20);
  const trend = sma20[idx] ? (price - sma20[idx]) / sma20[idx] : 0;
  
  // 8. 动量 (当前K线振幅)
  const currentK = klines[idx];
  const momentum = currentK.high > currentK.low ? (currentK.close - currentK.low) / (currentK.high - currentK.low) : 0.5;
  
  return [
    r5, r10, r20, r60,
    rsiVal,
    bbPos,
    atrNorm,
    volRatio,
    macdNorm,
    trend,
    momentum,
    0.5, // padding
  ];
}

// ═══════════════════════════════════════════
// 标签生成
// ═══════════════════════════════════════════

function generateLabels(klines, forwardPeriod = 10) {
  const labels = [];
  const closes = klines.map(k => k.close);
  
  for (let i = 0; i < klines.length; i++) {
    if (i + forwardPeriod >= closes.length) {
      labels.push(null); // 无法确定未来
      continue;
    }
    
    const futureReturn = (closes[i + forwardPeriod] - closes[i]) / closes[i];
    
    // 多级标签: 阈值基于ATR动态调整
    const recentAtr = atr(klines.slice(0, i + 1), 14);
    const atrVal = recentAtr[recentAtr.length - 1] || 0;
    const threshold = Math.max(0.003, atrVal / closes[i] * 0.5); // 动态阈值
    
    if (futureReturn > threshold) labels.push(1);       // UP
    else if (futureReturn < -threshold) labels.push(-1); // DOWN
    else labels.push(0);                                  // NEUTRAL
  }
  return labels;
}

// ═══════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════');
  console.log('  🧠 v100 大规模训练数据生成器');
  console.log('═══════════════════════════════════════');
  console.log(`品种: ${SYMBOLS.length}个 | 时间框架: ${TIMEFRAMES.length}个`);
  
  const allSamples = [];
  const allKlinesRaw = [];
  let successCount = 0;
  let failCount = 0;
  
  for (const symbol of SYMBOLS) {
    for (const tf of TIMEFRAMES) {
      try {
        const klines = await fetchKlines(symbol, tf.interval, tf.limit);
        if (klines.length < 100) {
          console.log(`  ⏭️ ${symbol} ${tf.interval}: 数据不足 (${klines.length})`);
          failCount++;
          continue;
        }
        
        // 缓存原始K线
        allKlinesRaw.push(...klines.slice(-300));
        
        // 生成标签
        const labels = generateLabels(klines, 10);
        
        // 提取特征
        let count = 0;
        for (let i = 60; i < klines.length; i++) {
          if (labels[i] === null) continue;
          const features = extractFeatures(klines, i);
          if (!features) continue;
          
          // 跳过全NaN
          if (features.some(f => isNaN(f) || !isFinite(f))) continue;
          
          allSamples.push({
            input: features,
            output: [labels[i]],
            symbol,
            timeframe: tf.interval,
          });
          count++;
        }
        
        console.log(`  ✅ ${symbol} ${tf.interval}: ${klines.length}条K线 → ${count}个训练样本`);
        successCount++;
        
        // 限速: 每次请求间隔200ms
        await new Promise(r => setTimeout(r, 200));
        
      } catch (e) {
        console.log(`  ❌ ${symbol} ${tf.interval}: ${e.message}`);
        failCount++;
      }
    }
  }
  
  // 打乱顺序
  for (let i = allSamples.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allSamples[i], allSamples[j]] = [allSamples[j], allSamples[i]];
  }
  
  // 统计标签分布
  const labelDist = { 1: 0, 0: 0, '-1': 0 };
  allSamples.forEach(s => labelDist[s.output[0]]++);
  
  // 保存
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allSamples, null, 2));
  fs.writeFileSync(RAW_CACHE, JSON.stringify(allKlinesRaw.slice(-5000)));
  
  console.log('\n═══════════════════════════════════════');
  console.log(`  📊 生成完成！`);
  console.log(`  总样本: ${allSamples.length}`);
  console.log(`  成功/失败: ${successCount}/${failCount}`);
  console.log(`  标签分布: UP=${labelDist[1]} | NEUTRAL=${labelDist[0]} | DOWN=${labelDist['-1']}`);
  console.log(`  输出: ${OUTPUT_FILE}`);
  console.log(`  K线缓存: ${RAW_CACHE} (${allKlinesRaw.length}条)`);
  console.log('═══════════════════════════════════════');
}

main().catch(e => {
  console.error('❌ 失败:', e.message);
  process.exit(1);
});
