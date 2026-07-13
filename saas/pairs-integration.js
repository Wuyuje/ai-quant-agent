/**
 * PairsIntegration — 配对交易集成模块
 * 
 * 读取 pair-scanner.json 结果，生成配对交易信号并发送给 guardian
 * 每个配对两端同时开仓：A做多/B做空（或反之）
 * 单个配对最大资金占用 15%
 */

const fs = require('fs');
const path = require('path');

class PairsIntegration {
  constructor(guardian, options = {}) {
    this.guardian = guardian;
    this.maxAllocation = options.maxAllocation || 0.15; // 15% per pair
    this.minCorrelation = options.minCorrelation || 0.7;
    this.minHalfLife = options.minHalfLife || 4;   // 最短半衰期（小时）
    this.maxHalfLife = options.maxHalfLife || 48;  // 最长半衰期
    this.minZScore = options.minZScore || 1.5;
    this.scannerPath = path.join(__dirname, '..', 'data', 'pair-scanner.json');
    this.lastScan = null;
    this.activePairs = new Map(); // 当前活跃配对交易
    this.blacklist = new Map();  // v113.67: 币种黑名单 — AutoFixer逆趋势平仓后阻止配对交易重新开仓
    this.maxScanAge = 2 * 3600 * 1000; // v113.67: 扫描数据最大有效期 2小时
  }

  /**
   * 读取最新的配对扫描结果
   */
  loadScanResults() {
    try {
      if (!fs.existsSync(this.scannerPath)) return null;
      const raw = fs.readFileSync(this.scannerPath, 'utf8');
      this.lastScan = JSON.parse(raw);
      // v113.67: 检查扫描数据是否过期
      const scanTime = this.lastScan.scanTime || this.lastScan.timestamp;
      if (scanTime) {
        const age = Date.now() - new Date(scanTime).getTime();
        if (age > this.maxScanAge) {
          console.log(`[Pairs] ⚠️ 配对扫描数据已过期 (${Math.round(age/3600000)}h前)，跳过配对交易`);
          return null;
        }
      } else {
        // 没有 scanTime 也跳过 — 避免使用陈旧数据
        console.log(`[Pairs] ⚠️ 配对扫描数据无时间戳，跳过配对交易`);
        return null;
      }
      return this.lastScan;
    } catch (e) {
      return null;
    }
  }

  /**
   * 筛选可执行的配对交易
   */
  getTradeablePairs() {
    const scan = this.loadScanResults();
    if (!scan || !scan.tradeable) return [];

    return scan.tradeable.filter(p => {
      // 过滤条件
      if (Math.abs(p.corr) < this.minCorrelation) return false;
      if (p.halfLife < this.minHalfLife || p.halfLife > this.maxHalfLife) return false;
      if (Math.abs(p.zScore) < this.minZScore) return false;
      if (p.hedgeRatio <= 0 || !isFinite(p.hedgeRatio)) return false;
      // 不重复交易已有的配对
      if (this.activePairs.has(p.pair)) return false;
      return true;
    });
  }

  /**
   * 将配对拆分为两个币种
   * @param {string} pair - "BTCUSDT/ETHUSDT"
   * @returns {[string, string]} - ["BTCUSDT", "ETHUSDT"]
   */
  parsePair(pair) {
    return pair.split('/').map(s => s.trim());
  }

  /**
   * v113.67: 将币种加入黑名单（AutoFixer逆趋势平仓后调用）
   * 阻止配对交易在趋势不配合时反复开仓
   */
  blacklistSymbol(symbol, reason = 'AutoFixer逆趋势平仓', durationMs = 4 * 3600 * 1000) {
    this.blacklist.set(symbol, { reason, until: Date.now() + durationMs });
    console.log(`[Pairs] ⛔ 黑名单: ${symbol} | 原因=${reason} | 持续=${durationMs/3600000}h`);
  }

  /**
   * v113.67: 检查币种是否在黑名单中
   */
  isBlacklisted(symbol) {
    const entry = this.blacklist.get(symbol);
    if (!entry) return false;
    if (Date.now() > entry.until) {
      this.blacklist.delete(symbol);
      return false;
    }
    return true;
  }

  /**
   * v113.67: 检查趋势方向是否与开仓方向一致
   * 价格在MA99上方 → 只做多不做空
   * 价格在MA99下方 → 只做空不做多
   */
  _isTrendAligned(symbol, side) {
    const klines = this.guardian?.engine?.dataBus?.klines || this.guardian?.engine?.klines;
    const kl = klines?.[symbol];
    if (!kl || kl.length < 50) return true; // 数据不足时不阻止
    const closes = kl.slice(-99).map(k => k.close || k[4]);
    if (closes.length < 50) return true;
    const ma99 = closes.reduce((s, c) => s + c, 0) / closes.length;
    const currentPrice = closes[closes.length - 1];

    if (side === 'SHORT' && currentPrice > ma99 * 1.005) {
      // 上涨趋势中做空 = 逆趋势
      return false;
    }
    if (side === 'LONG' && currentPrice < ma99 * 0.995) {
      // 下跌趋势中做多 = 逆趋势
      return false;
    }
    return true;
  }

  /**
   * 生成配对交易信号
   * v113.67: 加入趋势检查和黑名单过滤
   * @returns {Object[]} 信号列表
   */
  generateSignals() {
    const pairs = this.getTradeablePairs();
    if (pairs.length === 0) return [];

    const signals = [];
    for (const p of pairs.slice(0, 3)) { // 最多3个配对同时
      const [symA, symB] = this.parsePair(p.pair);

      // v113.67: 黑名单检查 — 任一端被拉黑则跳过整个配对
      if (this.isBlacklisted(symA) || this.isBlacklisted(symB)) {
        console.log(`[Pairs] ⏭️ 跳过 ${p.pair}: 涉及黑名单币种`);
        continue;
      }

      if (p.signal === 'LONG_SPREAD') {
        // 价差低于均值 → 买A卖B（均值回归）
        // v113.67: 检查趋势方向
        if (!this._isTrendAligned(symA, 'LONG') || !this._isTrendAligned(symB, 'SHORT')) {
          console.log(`[Pairs] ⏭️ 跳过 ${p.pair}: LONG_SPREAD 但趋势不配合`);
          continue;
        }
        signals.push({
          pair: p.pair,
          legA: { symbol: symA, side: 'LONG', confidence: Math.min(Math.abs(p.zScore) / 3, 1) },
          legB: { symbol: symB, side: 'SHORT', confidence: Math.min(Math.abs(p.zScore) / 3, 1) },
          zScore: p.zScore,
          halfLife: p.halfLife,
          hedgeRatio: p.hedgeRatio,
          corr: p.corr,
          reason: `配对交易 LONG_SPREAD Z=${p.zScore} HL=${p.halfLife}h`,
        });
      } else if (p.signal === 'SHORT_SPREAD') {
        // 价差高于均值 → 卖A买B
        // v113.67: 检查趋势方向
        if (!this._isTrendAligned(symA, 'SHORT') || !this._isTrendAligned(symB, 'LONG')) {
          console.log(`[Pairs] ⏭️ 跳过 ${p.pair}: SHORT_SPREAD 但趋势不配合`);
          continue;
        }
        signals.push({
          pair: p.pair,
          legA: { symbol: symA, side: 'SHORT', confidence: Math.min(Math.abs(p.zScore) / 3, 1) },
          legB: { symbol: symB, side: 'LONG', confidence: Math.min(Math.abs(p.zScore) / 3, 1) },
          zScore: p.zScore,
          halfLife: p.halfLife,
          hedgeRatio: p.hedgeRatio,
          corr: p.corr,
          reason: `配对交易 SHORT_SPREAD Z=${p.zScore} HL=${p.halfLife}h`,
        });
      }
    }

    return signals;
  }

  /**
   * 执行配对交易
   * @param {number} totalBalance - 总余额
   * @returns {Object[]} 执行结果
   */
  async executePairs(totalBalance, maxSlots = 6) {
    const signals = this.generateSignals();
    if (signals.length === 0) return [];

    const results = [];
    let slotsUsed = 0;  // v113.58: 追踪本轮配对已用仓位

    for (const signal of signals) {
      // v113.58: 配对交易两端各占1个仓位，必须确保不超总仓位数限制
      if (slotsUsed + 2 > maxSlots) {
        console.log(`[Pairs] ⏭️ 跳过 ${signal.pair}: 剩余仓位${maxSlots - slotsUsed} < 需要2`);
        break;
      }
      try {
        console.log(`[Pairs] 执行配对: ${signal.pair} | Z=${signal.zScore}`);

        // 开仓 legA — 用 guardian.executeDecision
        const legA = signal.legA;
        const legASize = totalBalance * this.maxAllocation / 2;
        const resultA = await this.guardian.executeDecision({
          action: legA.side === 'LONG' ? 'LONG' : 'SHORT',
          leverage: 1,
          positionSize: legASize,
        }, legA.symbol).catch(e => ({ executed: false, error: e.message }));

        // 开仓 legB
        const legB = signal.legB;
        const legBSize = totalBalance * this.maxAllocation / 2;
        const resultB = await this.guardian.executeDecision({
          action: legB.side === 'LONG' ? 'LONG' : 'SHORT',
          leverage: 1,
          positionSize: legBSize,
        }, legB.symbol).catch(e => ({ executed: false, error: e.message }));

        if (resultA?.executed && resultB?.executed) {
          slotsUsed += 2;  // 两端都成功才算占2个仓位
        } else {
          // 有一端失败 → 不计数，但不影响后续配对
          console.log(`[Pairs] ⚠️ ${signal.pair} 部分成交: A=${resultA?.executed} B=${resultB?.executed}`);
        }

        // 记录活跃配对
        this.activePairs.set(signal.pair, {
          entryTime: Date.now(),
          zScore: signal.zScore,
          halfLife: signal.halfLife,
          legA, legB,
        });

        results.push({
          pair: signal.pair,
          success: true,
          legA: resultA,
          legB: resultB,
        });

        console.log(`[Pairs] ✅ 配对开仓成功: ${signal.pair}`);
      } catch (e) {
        console.error(`[Pairs] ❌ 配对执行失败 ${signal.pair}: ${e.message}`);
        results.push({ pair: signal.pair, success: false, error: e.message });
      }
    }

    return results;
  }

  /**
   * 检查活跃配对是否需要平仓
   * 当 Z-Score 回归到 ±0.5 以内时平仓（均值回归完成）
   */
  async checkExit() {
    if (this.activePairs.size === 0) return [];

    const scan = this.loadScanResults();
    if (!scan) {
      // 扫描数据不可用 — 强制平仓所有活跃配对
      for (const [pairKey, pairData] of this.activePairs) {
        console.log(`[Pairs] 🔄 强制平仓配对: ${pairKey} | 原因=扫描数据不可用`);
        try {
          if (this.guardian?.engine?._executeClose) {
            if (pairData.legA) this.guardian.engine._executeClose(pairData.legA.symbol, '配对交易:数据过期强制平仓');
            if (pairData.legB) this.guardian.engine._executeClose(pairData.legB.symbol, '配对交易:数据过期强制平仓');
          }
        } catch (e) { console.error(`[Pairs] 平仓失败: ${e.message}`); }
        this.activePairs.delete(pairKey);
      }
      return [];
    }

    const exits = [];

    for (const [pairKey, pairData] of this.activePairs) {
      // 找到当前Z-Score
      const current = scan.pairs?.find(p => p.pair === pairKey);
      const currentZ = current?.zScore || 0;

      // Z-Score回归到±0.5以内 → 平仓（均值回归完成）
      const zScoreNorm = Math.abs(currentZ) < 0.5;
      // 持有超过半衰期的2倍 → 强制平仓
      const timeExceeded = Date.now() - pairData.entryTime > pairData.halfLife * 3600000 * 2;

      if (zScoreNorm || timeExceeded) {
        console.log(`[Pairs] 🔄 平仓配对: ${pairKey} | Z=${currentZ} | ${zScoreNorm ? 'Z-Score回归' : '超时'}`);

        // v113.67: 实际执行平仓
        try {
          if (this.guardian?.engine?._executeClose) {
            if (pairData.legA) this.guardian.engine._executeClose(pairData.legA.symbol, `配对交易:${zScoreNorm ? 'Z-Score回归' : '超时'}平仓`);
            if (pairData.legB) this.guardian.engine._executeClose(pairData.legB.symbol, `配对交易:${zScoreNorm ? 'Z-Score回归' : '超时'}平仓`);
          }
          this.activePairs.delete(pairKey);
          exits.push({ pair: pairKey, reason: zScoreNorm ? 'Z-Score回归' : '超时平仓' });
        } catch (e) {
          console.error(`[Pairs] 平仓失败: ${e.message}`);
        }
      }
    }

    return exits;
  }

  /**
   * 获取当前状态
   */
  getStatus() {
    return {
      activePairs: this.activePairs.size,
      maxPairs: 3,
      pairs: Array.from(this.activePairs.entries()).map(([k, v]) => ({
        pair: k,
        zScore: v.zScore,
        halfLife: v.halfLife,
        entryTime: new Date(v.entryTime).toISOString(),
        duration: Math.round((Date.now() - v.entryTime) / 60000) + 'min',
      })),
      lastScan: this.lastScan?.timestamp || null,
      tradeableCount: this.lastScan?.tradeable?.length || 0,
    };
  }
}

module.exports = PairsIntegration;
