/**
 * BB Strategy Engine v9 — 布林带轨道交易策略
 * 
 * 核心逻辑：
 *   1. BB收口后突破开仓（5min K线）
 *   2. 轨道止盈（中轨/反向轨道）
 *   3. 放量ATR移动止盈
 *   4. 3次补仓机制
 *   5. 三重风控（单K线20%止损 / 70%终极止损 / 特殊时间暂停）
 * 
 * 信号确认：
 *   开多: 5min收盘价触及/跌破下轨 + 多层周期确认
 *   开空: 5min收盘价触及/突破上轨 + 多层周期确认
 */

class BBStrategy {
  constructor(config, dataBus) {
    this.config = config;
    this.dataBus = dataBus;
    this.log = (msg) => console.log(`[BB-Strategy] ${new Date().toISOString()} ${msg}`);

    // 补仓状态: { symbol: { count: 0, amounts: [50%, 30%, 20%], lastAddTime: 0 } }
    this.addPositionState = {};

    // 移动止盈状态: { symbol: { mode: '轨道'|'ATR', trailingPrice: 0 } }
    this.trailingState = {};

    // BB 开仓状态: { symbol: { lastCrossTime: 0, consecutiveNarrow: 0 } }
    this.bbOpenState = {};
  }

  // ============ BB 指标增强计算（100根K线版本）============
  /**
   * 计算增强 BB 指标，包括带宽分位数、收口判断
   */
  calculateBBIndicators(klines) {
    if (!klines || klines.length < 100) return null;

    const closes = klines.map(k => k.close);
    const volumes = klines.map(k => k.volume);

    // 20周期 BB（当前）
    const bb20 = this._bollingerBands(closes, 20, 2);

    // BB 带宽 = (上轨 - 下轨) / 中轨 * 100
    const currentBandwidth = ((bb20.upper - bb20.lower) / bb20.middle) * 100;

    // 100根K线历史带宽（用于分位数计算）
    const bandwidthHistory = [];
    for (let i = 99; i < closes.length; i++) {
      const slice = closes.slice(i - 19, i + 1);
      const bb = this._bollingerBands(slice, 20, 2);
      const bw = ((bb.upper - bb.lower) / bb.middle) * 100;
      bandwidthHistory.push(bw);
    }

    // 带宽历史分位数
    const bandwidthPercentile = this._percentile(bandwidthHistory, currentBandwidth);

    // 连续收口判断：最近3根K线带宽持续缩小
    let consecutiveNarrow = 0;
    const recentBandwidths = bandwidthHistory.slice(-4);
    for (let i = recentBandwidths.length - 1; i >= 1; i--) {
      if (recentBandwidths[i] < recentBandwidths[i - 1]) {
        consecutiveNarrow++;
      } else {
        break;
      }
    }

    // BB 价格位置
    const price = closes[closes.length - 1];
    const pricePosition = (price - bb20.lower) / (bb20.upper - bb20.lower); // 0~1

    // 5min K线成交量对比
    const volSma20 = this._sma(volumes, 20);
    const currentVol = volumes[volumes.length - 1];
    const volRatio = volSma20 > 0 ? currentVol / volSma20 : 1;

    // 放量判断: 成交量 > 20周期均量 x 1.8
    const isVolumeSpike = volRatio > 1.8;

    return {
      bb: bb20,
      bandwidth: currentBandwidth,
      bandwidthPercentile,   // 100根历史分位数 (0~1)
      consecutiveNarrow,     // 连续收口K线数
      pricePosition,         // 0=下轨, 0.5=中轨, 1=上轨
      volRatio,
      isVolumeSpike,         // 放量标志
      price,
    };
  }

  // ============ 开仓信号判断 ============
  /**
   * 判断是否满足开仓条件
   * @param {object} bbIndicators - calculateBBIndicators 的结果
   * @param {object} indicators   - DataBus calculateIndicators 的结果（含 RSI 等）
   * @param {string} symbol       - 交易对
   * @returns {object} { canOpen, direction, reason }
   */
  checkOpenSignal(bbInd, indicators, symbol) {
    if (!bbInd || !indicators) {
      return { canOpen: false, direction: 'WAIT', reason: '数据不足' };
    }

    const price = bbInd.price;
    const bb = bbInd.bb;
    const rsi = indicators.rsi || 50;

    // ═══ 禁开仓条件 ═══
    // 5min 布林带宽 100根历史分位 > 90%
    if (bbInd.bandwidthPercentile > 0.90) {
      return { canOpen: false, direction: 'WAIT', reason: `BB带宽分位${(bbInd.bandwidthPercentile * 100).toFixed(0)}% > 90% (波动过大)` };
    }

    // ═══ 开仓解禁条件（必须同时满足）═══
    // 1. BB带宽分位 < 85%
    const bandwidthOK = bbInd.bandwidthPercentile < 0.85;
    // 2. 连续3根K线收窄
    const narrowOK = bbInd.consecutiveNarrow >= 3;

    if (!bandwidthOK || !narrowOK) {
      return {
        canOpen: false, direction: 'WAIT',
        reason: `未解禁: 分位=${(bbInd.bandwidthPercentile * 100).toFixed(0)}%${bandwidthOK ? '✅' : '>85%'} 收口=${bbInd.consecutiveNarrow}根${narrowOK ? '✅' : '<3'}`
      };
    }

    // ═══ 开仓信号确认 ═══
    // 开多: 5min收盘价触及/跌破下轨
    if (price <= bb.lower) {
      // RSI 超卖确认
      if (rsi < 35) {
        return { canOpen: true, direction: 'LONG', reason: `BB下轨触及+RSI超卖(${rsi.toFixed(0)})` };
      }
      return { canOpen: true, direction: 'LONG', reason: `BB下轨触及(price=${price.toFixed(4)}<=lower=${bb.lower.toFixed(4)})` };
    }

    // 开空: 5min收盘价触及/突破上轨
    if (price >= bb.upper) {
      // RSI 超买确认
      if (rsi > 65) {
        return { canOpen: true, direction: 'SHORT', reason: `BB上轨触及+RSI超买(${rsi.toFixed(0)})` };
      }
      return { canOpen: true, direction: 'SHORT', reason: `BB上轨触及(price=${price.toFixed(4)}>=upper=${bb.upper.toFixed(4)})` };
    }

    return { canOpen: false, direction: 'WAIT', reason: `价格在BB内部(pos=${(bbInd.pricePosition * 100).toFixed(0)}%)` };
  }

  // ============ 止盈判断（双模式）============
  /**
   * 判断是否触发止盈
   * 前提: 持仓浮盈 >= 2% 才触发
   */
  checkTakeProfit(position, currentPrice, bbInd, symbol) {
    if (!position || !bbInd) return null;

    const isLong = position.side === 'LONG';
    const entry = position.entryPrice;
    if (!entry || entry <= 0) return null;

    // 浮盈计算（含杠杆）
    const leverage = position.leverage || 5;
    const rawPnlPct = isLong
      ? ((currentPrice - entry) / entry) * 100
      : ((entry - currentPrice) / entry) * 100;
    const pnlPct = rawPnlPct * leverage;

    // 浮盈 >= 2% 才触发止盈条件
    if (pnlPct < 2) return null;

    const bb = bbInd.bb;
    const volRatio = bbInd.volRatio || 1;
    const isVolumeSpike = bbInd.isVolumeSpike;

    // ═══ 模式1: 常态轨道止盈 ═══
    if (!isVolumeSpike) {
      // 一级: 收盘价触碰布林中轨
      if (isLong && currentPrice >= bb.middle) {
        return { action: 'CLOSE', reason: `轨道止盈: 多单触碰中轨 price=${currentPrice.toFixed(4)} >= middle=${bb.middle.toFixed(4)} pnl=${pnlPct.toFixed(1)}%` };
      }
      if (!isLong && currentPrice <= bb.middle) {
        return { action: 'CLOSE', reason: `轨道止盈: 空单触碰中轨 price=${currentPrice.toFixed(4)} <= middle=${bb.middle.toFixed(4)} pnl=${pnlPct.toFixed(1)}%` };
      }

      // 二级: 反向轨道触碰
      if (isLong && currentPrice >= bb.upper) {
        return { action: 'CLOSE', reason: `轨道止盈: 多单触碰上轨(反向) pnl=${pnlPct.toFixed(1)}%` };
      }
      if (!isLong && currentPrice <= bb.lower) {
        return { action: 'CLOSE', reason: `轨道止盈: 空单触碰下轨(反向) pnl=${pnlPct.toFixed(1)}%` };
      }
    }

    // ═══ 模式2: 放量移动止盈（ATR跟踪）═══
    if (isVolumeSpike) {
      const atr = this.dataBus.calculateIndicators(symbol)?.atr || 0;
      if (atr <= 0) return null;

      const atrTrailing = atr * 0.3; // 0.3ATR 为止盈线

      if (!this.trailingState[symbol]) {
        this.trailingState[symbol] = { mode: 'ATR', trailingPrice: 0 };
      }
      const state = this.trailingState[symbol];
      state.mode = 'ATR';

      if (isLong) {
        // 多单: 阶段最低点 + 0.3ATR 为止盈线
        if (!state.lowestSinceEntry || currentPrice < state.lowestSinceEntry) {
          state.lowestSinceEntry = currentPrice;
        }
        const trailingLine = state.lowestSinceEntry + atrTrailing;
        state.trailingPrice = trailingLine;
        if (currentPrice < trailingLine) {
          return { action: 'CLOSE', reason: `ATR移动止盈: 多单跌破跟踪线 price=${currentPrice.toFixed(4)} < trail=${trailingLine.toFixed(4)} pnl=${pnlPct.toFixed(1)}%` };
        }
      } else {
        // 空单: 阶段最高点 - 0.3ATR 为止盈线
        if (!state.highestSinceEntry || currentPrice > state.highestSinceEntry) {
          state.highestSinceEntry = currentPrice;
        }
        const trailingLine = state.highestSinceEntry - atrTrailing;
        state.trailingPrice = trailingLine;
        if (currentPrice > trailingLine) {
          return { action: 'CLOSE', reason: `ATR移动止盈: 空单突破跟踪线 price=${currentPrice.toFixed(4)} > trail=${trailingLine.toFixed(4)} pnl=${pnlPct.toFixed(1)}%` };
        }
      }
    } else {
      // 非放量时，如果之前是 ATR 模式，切回轨道模式
      if (this.trailingState[symbol]?.mode === 'ATR') {
        // 布林带收口后自动切回
        if (bbInd.bandwidthPercentile < 0.70) {
          delete this.trailingState[symbol];
        }
      }
    }

    return null;
  }

  // ============ 止损判断 ============
  /**
   * 三重风控:
   * 1. 前置风控: 单K线浮亏达本金20%，全仓止损
   * 2. 终极风控: 3次补仓完成 + 总浮亏 >= 70%，全仓强制平仓
   */
  checkStopLoss(position, currentPrice, symbol) {
    if (!position) return null;

    const isLong = position.side === 'LONG';
    const entry = position.entryPrice;
    if (!entry || entry <= 0) return null;

    const leverage = position.leverage || 5;
    const rawPnlPct = isLong
      ? ((currentPrice - entry) / entry) * 100
      : ((entry - currentPrice) / entry) * 100;
    const pnlPct = rawPnlPct * leverage;

    const addState = this.addPositionState[symbol] || { count: 0 };

    // ═══ 终极风控: 3次补仓完成 + 总浮亏 >= 70% ═══
    if (addState.count >= 3 && pnlPct <= -70) {
      return { action: 'CLOSE', reason: `终极风控: 3次补仓完成+浮亏${pnlPct.toFixed(1)}%>=70% → 强制全平` };
    }

    // ═══ 前置风控: 单K线浮亏达本金20% ═══
    // 注: 这里用未杠杆的浮盈判断（单笔本金）
    if (rawPnlPct <= -20) {
      return { action: 'CLOSE', reason: `前置风控: 单K线浮亏${rawPnlPct.toFixed(1)}% >= 20% → 全仓止损` };
    }

    return null;
  }

  // ============ 补仓判断 ============
  /**
   * 布林带收口后间隔3根K线，按50%→30%→20%比例补仓
   * 一个币种补完3次后停止
   */
  checkAddPosition(symbol, bbInd, currentPrice, position) {
    if (!bbInd || !position) return null;

    const state = this.addPositionState[symbol] || { count: 0, lastAddTime: 0 };
    if (state.count >= 3) return null; // 已补满3次

    // 布林带收口检查
    if (bbInd.bandwidthPercentile >= 0.75) return null; // 带宽不够窄
    if (bbInd.consecutiveNarrow < 3) return null; // 没有连续收窄

    // 间隔3根K线（5min K线 = 15分钟）
    const now = Date.now();
    const timeSinceLastAdd = now - state.lastAddTime;
    if (state.lastAddTime > 0 && timeSinceLastAdd < 15 * 60 * 1000) {
      return null; // 还没到时间
    }

    // 首次开仓不算补仓，如果 lastAddTime=0 且 count=0，设置为首次开仓时间
    if (state.count === 0 && state.lastAddTime === 0) {
      // 不补仓，只是记录状态
      this.addPositionState[symbol] = {
        count: 0,
        lastAddTime: now,
        amounts: [50, 30, 20],
      };
      return null;
    }

    // 补仓比例: 第1次50%, 第2次30%, 第3次20%
    const amounts = [50, 30, 20];
    const addPercent = amounts[state.count] / 100;

    const addAmount = position.entryPrice * (position.qty || 0) * addPercent;

    this.addPositionState[symbol] = {
      ...state,
      count: state.count + 1,
      lastAddTime: now,
    };

    return {
      action: 'ADD',
      amount: addAmount,
      reason: `补仓第${state.count + 1}次: ${amounts[state.count]}% (已补${state.count}次)`,
    };
  }

  // ============ 特殊时间过滤 ============
  /**
   * 检查当前是否处于特殊时间限制期
   * @returns {object|null} { blocked: true, reason } 或 null（允许交易）
   */
  checkTimeRestrictions() {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMin = now.getUTCMinutes();
    const utcDay = now.getUTCDay(); // 0=Sunday, 5=Friday
    const totalMinutes = utcHour * 60 + utcMin;

    // ═══ 资金费率结算时间: 每8小时 UTC 0:00, 8:00, 16:00 ═══
    // 结算前15分钟暂停
    const fundingTimes = [0, 480, 960]; // UTC分钟
    for (const ft of fundingTimes) {
      const diff = ft - totalMinutes;
      if (diff >= 0 && diff <= 15) {
        return { blocked: true, reason: `资金费率结算前${diff}分钟，暂停开仓/补仓` };
      }
    }

    // ═══ 季度合约交割: 每周五 UTC 8:00 ═══
    // 交割前1小时停止一切开仓
    if (utcDay === 5 && utcHour === 7) {
      return { blocked: true, reason: '季度合约交割前1小时' };
    }

    return null; // 不受限
  }

  // ============ 插针与异常价格过滤 ============
  /**
   * 检查当前K线是否为异常K线
   * @param {object} kline - 最近一根K线
   * @returns {boolean} true=异常，信号作废
   */
  isAbnormalCandle(kline) {
    if (!kline) return false;

    // 单根K线涨跌幅超过±3% = 异动毛刺
    const range = Math.abs(kline.high - kline.low);
    const midPrice = (kline.high + kline.low) / 2;
    if (midPrice > 0) {
      const rangePercent = (range / midPrice) * 100;
      if (rangePercent > 3) {
        this.log(`⚠️ 异常K线: 涨跌幅${rangePercent.toFixed(1)}% > 3%`);
        return true;
      }
    }

    return false;
  }

  /**
   * 只使用收盘价判断（最高最低价瞬时穿刺无效）
   * @param {object} kline
   * @returns {number} 收盘价
   */
  getSafePrice(kline) {
    return kline ? kline.close : 0;
  }

  // ============ 工具方法 ============
  _bollingerBands(arr, period = 20, stdDev = 2) {
    const slice = arr.slice(-period);
    const sma = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((acc, val) => acc + Math.pow(val - sma, 2), 0) / slice.length;
    const std = Math.sqrt(variance);
    return { upper: sma + std * stdDev, middle: sma, lower: sma - std * stdDev };
  }

  _sma(arr, period) {
    if (arr.length < period) return arr[arr.length - 1] || 0;
    const slice = arr.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
  }

  _percentile(arr, value) {
    if (arr.length === 0) return 0.5;
    const sorted = [...arr].sort((a, b) => a - b);
    let count = 0;
    for (const v of sorted) {
      if (v <= value) count++;
    }
    return count / sorted.length;
  }

  /**
   * 清理已平仓币的补仓状态
   */
  clearState(symbol) {
    delete this.addPositionState[symbol];
    delete this.trailingState[symbol];
    delete this.bbOpenState[symbol];
  }

  /**
   * 获取所有策略状态（仪表盘展示用）
   */
  getStatus() {
    return {
      addPositions: { ...this.addPositionState },
      trailing: { ...this.trailingState },
    };
  }
}

module.exports = BBStrategy;
