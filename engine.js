/**
 * Engine v24 — 大道至简 + v73精简策略
 * 
 * 5分钟K线 MA7/MA25/MA99
 * 强趋势：猛加仓加杠杆
 * MA7拐头：秒级出货
 */
const fs = require('fs');
const path = require('path');
const DataBus = require('./data/databus');
const Trader = require('./executor/trader');
const Guardian = require('./safety/guardian');
const NotificationCenter = require('./saas/notifier');
const AutoTrainer = require('./saas/auto-trainer');
const { StrategyManager } = require('./saas/strategies/strategy-manager');
const { NeuralNet } = require('./saas/strategies/neural-net');
const { PositionSizer } = require('./saas/position-sizer');
const AdaptiveExitManager = require('./saas/adaptive-exit');
const signalPool = require('./saas/signal-pool');
const { TwapVwapEngine } = require('./execution/twap-vwap');
const CONFIG = require('./config/loader');

// v113.11: 自我进化闭环 — 读取自适应参数
const { adaptiveParams } = require('./saas/strategy-hot-loader');

// Config loaded via config/loader.js (handles .env + ${VAR} resolution)
const { createLogger } = require('./utils/logger');
const _logger = createLogger('Engine');
const PAIRS = require('./config/trading-pairs.js');
const STATE_FILE = path.join(__dirname, 'data', 'engine_state.json');

class Engine {
  constructor(deps = {}) {
    this.running = false;
    this.paused = false;
    this.cycleCount = 0;
    this.dataBus = deps.dataBus || new DataBus(CONFIG);
    this.trader = new Trader(CONFIG, PAIRS);
    this.guardian = new Guardian(this.trader, this.dataBus, CONFIG);
    this.trader.setMarketData(this.dataBus.marketData);
    this.engineState = this._loadState();

    // v64: 神经网络 + 策略管理器 + DEX聚合器 + 通知中心 + 自动训练器
    this.neuralNet = new NeuralNet();
    this.neuralNet.load(path.join(__dirname, 'data', 'neural-model.json'));
    this.strategyManager = new StrategyManager({ dataBus: this.dataBus });
    this.strategyManager.neuralNet = this.neuralNet;
    this.strategyManager.strategies.neuralNet = this.neuralNet;  // v112: 确保 predict 用的实例和 API 读的实例一致
    this.twapEngine = new TwapVwapEngine({ trader: this.trader });
    this.positionSizer = new PositionSizer();
    // 趋势冲刺已删除
    this.exitManager = new AdaptiveExitManager({ isAdminWallet: true });
    this.notifier = new NotificationCenter({});
    this.autoTrainer = new AutoTrainer({});
    this.sharedRisk = deps.sharedRisk || null;  // v97: 跨市场共享风控层
    this.autoTrainer.setDependencies(this.neuralNet, this.strategyManager);

    // v73: 精简策略 — 移除statArb/marketMaker/optionsGreeks/mevBot/multiServer

    const blacklist = (CONFIG.strategy && CONFIG.strategy.blacklistPairs) || [];
    this._blacklist = new Set(blacklist);
    this._candidateSymbols = Object.keys(PAIRS).filter(s => !s.startsWith('_') && !this._blacklist.has(s));

    // Dashboard 兼容属性
    this.tradeLog = [];
    // v103: MasterD Brain — 智能体核心分析引擎
    const { MasterDBrain } = require('./brain/masterd-brain');
    this.brain = new MasterDBrain(CONFIG);
    this.aiEngine = this.brain;  // 兼容 dashboard

    this._openTime = {};
    this._lastCloseTime = {};
    this._globalCooldownUntil = 0;  // v99: 全局冷却提升至1小时
    this._globalCooldownFile = path.join(__dirname, 'data', 'cooldown-state.json');  // v99: 冷却持久化
    this._loadCooldownState();
    this._klineFreshness = {};
    this._klineLock = {};
    this._emergencyStop = false;
    this._dailyPnl = 0;
    this._dailyPnlResetTime = this._startOfDay();
    this._prevMa7 = {}; // 上一轮MA7
    this._prevCloseAboveMA7 = {}; // 上一轮收盘价在MA7上方还是下方
    this._openFailCount = {};  // v83: 开仓失败计数
    this._openFailTime = {};   // v83: 最近开仓失败时间
    this._signalCache = {};    // v83: 信号缓存（避免重复分析）
    this._ma7CrossState = {}; // MA7与MA29交叉状态: 'above'/'below'/'none'
    this._lastCrossTime = {}; // 上一次交叉时间
    this._closedSymbols = {};  // v89: 已平仓标记（防止链上同步后重复平仓）
    this._openedThisScan = {}; // v89: 本轮扫描已开仓标记（防止重复开仓）
    this._closingLock = {};    // v89: 平仓进行中锁，防并发重复调用
    
    // v113.60: 将 _canAdjustLeverage / _markLeverageAdjust 移到构造函数，避免首次循环时未定义
    this._leverageAdjustTime = {};
    this._canAdjustLeverage = (symbol) => {
      const last = this._leverageAdjustTime[symbol] || 0;
      return Date.now() - last > 30 * 60 * 1000; // 30分钟冷却
    };
    this._markLeverageAdjust = (symbol) => {
      this._leverageAdjustTime[symbol] = Date.now();
    };

    // v73: 移除无用策略状态
    this._v66Stats = {};

    // v113.17: 链上大户钱包监控
    const WhaleMonitor = require('./saas/whale-monitor');
    this.whaleMonitor = new WhaleMonitor({ scanInterval: 60000 });
    this.whaleMonitor.start();

    if (this.engineState._openTime) this._openTime = this.engineState._openTime;
    if (this.engineState._posATR) this._posATR = this.engineState._posATR;
    if (this.engineState._peakPnlPct) this._peakPnlPct = this.engineState._peakPnlPct;

    this._log('Engine v24 initialized — MA7/MA29交叉确认制');
  }

  _log(msg) { _logger.info(msg); }
  _startOfDay() { const d = new Date(); d.setUTCHours(0,0,0,0); return d.getTime(); }

  // v99: 冷却状态持久化（重启不丢失）
  _loadCooldownState() {
    try {
      if (fs.existsSync(this._globalCooldownFile)) {
        const data = JSON.parse(fs.readFileSync(this._globalCooldownFile, 'utf8'));
        this._globalCooldownUntil = data.globalCooldownUntil || 0;
        this._lastCloseTime = data.lastCloseTime || {};
        if (this._globalCooldownUntil > Date.now()) {
          const waitMin = ((this._globalCooldownUntil - Date.now()) / 60000).toFixed(0);
          this._log(`📦 恢复冷却状态: 全局${waitMin}分钟后解除`);
        }
      }
    } catch(e) {}
  }
  _saveCooldownState() {
    try {
      fs.writeFileSync(this._globalCooldownFile, JSON.stringify({
        globalCooldownUntil: this._globalCooldownUntil,
        lastCloseTime: this._lastCloseTime || {}
      }));
    } catch(e) {}
  }

  _loadState() {
    try { if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch(e) {}
    return { totalPnl: 0, totalTrades: 0, wins: 0, losses: 0 };
  }
  _saveState() {
    try {
      this.engineState._openTime = this._openTime;
      this.engineState._posATR = this._posATR || {};
      this.engineState._peakPnlPct = this._peakPnlPct || {};
      this.engineState._dailyPnl = this._dailyPnl;
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.engineState, null, 2));
    } catch(e) {}
  }

  async start() {
    this._log('Starting v23...');
    this.running = true;

    try {
      const balance = await this.trader.getBalance();
      this._log(`余额: $${balance?.balance?.toFixed(2)}`);
    } catch(e) { this._log(`余额查询失败: ${e.message}`); }

    await this.guardian.syncAllPositions();

    const symbols = Object.keys(PAIRS).filter(s => !s.startsWith('_') && !this._blacklist.has(s));
    this.dataBus.connectWS(symbols);
    await new Promise(r => setTimeout(r, 3000));

    // v74: 立即用HTTP获取价格（WS可能在sandbox环境下无数据）
    await this.dataBus.fetchAllTickers(symbols);

    this._log('拉取1h K线...'); // v69
    let loaded = 0;
    for (const sym of symbols) {
      try {
        await this.dataBus.fetchKlines(sym, '1h', 200); // v69: 1h K线，减少噪音
        this._klineFreshness[sym] = Date.now();
        loaded++;
        await new Promise(r => setTimeout(r, 150));
      } catch(e) {}
    }
    this._log(`K线: ${loaded}/${symbols.length}`);
    
    // v64: 启动自动训练器
    this.autoTrainer.start();
    this._log('v64 模块就绪: NeuralNet + DEX + TWAP + Notifier + AutoTrainer');

    this._log('v73 精简策略就绪');
    
    this._mainLoop();
  }

  async stop() {
    this.running = false;
    // v107: 关闭时保存神经网络模型和Brain状态
    try { this.strategies.neuralNet.save(); } catch(e) {}
    if (this.brain) this.brain._saveState();
    if (this.masterdAgent) this.masterdAgent.saveState();
    this.dataBus.disconnect();
  }

  async _mainLoop() {
    // v113.30: 启动冲刺快速止盈检查 — 每5秒检查一次，毫秒级反应
    // v113.31: 趋势冲刺检查已移至独立引擎
    while (this.running) {
      try {
        if (!this.running) break;
        this.cycleCount++;
        if (this.paused) { await new Promise(r => setTimeout(r, 5000)); continue; }
        this._checkDailyPnlReset();
        if (this._emergencyStop) {
          await new Promise(r => setTimeout(r, 60000)); // v109: 30s→60s 减少交易频率
          continue;
        }

        await this.guardian.syncAllPositions();
        // v115: 先刷新价格再管理持仓（确保止盈止损用的是最新价）
        await this.dataBus.fetchAllTickers(Object.keys(this.dataBus.marketData).length > 0 ? Object.keys(this.dataBus.marketData) : ['BTCUSDT','ETHUSDT','SOLUSDT']);
        this.trader.setMarketData(this.dataBus.marketData);
        await this._managePositions();
        await this._scanAndOpen();

        // v113.11: 自我进化闭环 — 每5轮运行一次AutoFixer检测
        if (this.cycleCount % 5 === 0 && this.masterdAgent?.autoFixer) {
          try { await this.masterdAgent.autoFixer.runCheck(); } catch (e) { /* 静默 */ }
        }

        if (this.cycleCount % 2 === 0) this.trader.setMarketData(this.dataBus.marketData);  // v74: 每2轮更新
        this._saveState();
      } catch(e) { this._log(`错误: ${e.message}`); this._lastError = e.message; }
      await new Promise(r => setTimeout(r, 60000)); // v109: 30s→60s 减少交易频率
    }
  }

  // ═══════════════════════════════════════════
  // 持仓管理 — v67: 动态ATR止损止盈
  // ═══════════════════════════════════════════
  async _managePositions() {
    const allPositions = this.guardian.getAllPositions();

    // 修复：获取余额供加仓计算使用（之前未定义导致ReferenceError）
    const _bal = this._cachedBalance || { balance: 0, available: 0 };
    const balanceUsd = _bal.balance || 0;

    // 总PnL保护 -10%（容忍更大波动，避免噪音触发全平）
    let totalPnlPct = 0;
    let totalNotional = 0;
    for (const [sym, pos] of Object.entries(allPositions)) {
      const price = this.dataBus.marketData?.[sym]?.price || pos.markPrice;
      if (!price || !pos.entryPrice) continue;
      const lev = pos.leverage || 1;
      const notional = pos.qty * (pos.entryPrice || price);
      totalNotional += notional;
      const raw = pos.side === 'LONG'
        ? ((price - pos.entryPrice) / pos.entryPrice) * 100
        : ((pos.entryPrice - price) / pos.entryPrice) * 100;
      totalPnlPct += raw * lev * (notional / Math.max(totalNotional, 1));
    }
    // 只有真正大幅亏损才全平：加权PnL < -10% 且至少有真实持仓
    if (Object.keys(allPositions).length > 0 && totalNotional > 5 && totalPnlPct < -10) {
      this._log(`🚨 总PnL ${totalPnlPct.toFixed(1)}% (notional=$${totalNotional.toFixed(0)}) → 全平`);
      for (const [sym] of Object.entries(allPositions)) {
        await this._executeClose(sym, `总PnL ${totalPnlPct.toFixed(1)}% 全平`);
      }
      return;
    }

    for (const [symbol, pos] of Object.entries(allPositions)) {
      // v89: 已平仓标记检查 — 防止链上同步后重复触发平仓（30分钟内跳过）
      if (this._closedSymbols[symbol] && Date.now() - this._closedSymbols[symbol] < 30 * 60 * 1000) {
        continue;
      }
      // v89: 平仓锁检查 — 防止并发/同步周期重复调用平仓
      if (this._closingLock[symbol]) {
        continue;
      }
      try {
        const currentPrice = this.dataBus.marketData?.[symbol]?.price || pos.markPrice;
        if (!currentPrice || currentPrice <= 0) continue;

        // v68: 检查持仓名义值是否低于Binance最低$5
        const posNotional = (pos.qty || 0) * currentPrice;
        // v113.57: 名义值<$3的残渣仓位，尝试用closePosition全平而不是跳过
        if (posNotional < 3) {
          if (this.cycleCount % 10 === 0) {
            this._log(`🔧 ${symbol} 残渣仓位 $${posNotional.toFixed(2)} < $3，尝试closePosition全平...`);
            try {
              await this.guardian.executeDecision({ action: 'CLOSE', leverage: 0, positionSize: 0 }, symbol);
            } catch(e) {
              this._log(`⚠️ ${symbol} 残渣平仓失败: ${e.message}`);
            }
          }
          continue;
        }
        // v99: 名义值$3-$20之间的仓位，仍然尝试平仓（用reduceOnly）
        // 不再跳过！这是之前亏损的根因：仓位被锁死无法平仓，持续亏损

        const isLong = pos.side === 'LONG';
        const leverage = pos.leverage || 1;
        const rawPnlPct = isLong
          ? ((currentPrice - pos.entryPrice) / (pos.entryPrice || 1)) * 100
          : ((pos.entryPrice - currentPrice) / (pos.entryPrice || 1)) * 100;
        const pnlPct = rawPnlPct * leverage;  // 毛利润
        // v87: 净利润（扣除手续费+滑点+资金费率）
        const holdHours = (Date.now() - (this._openTime[symbol] || Date.now())) / 3600000;
        const netPnlPct = this.exitManager.toNetPnl(pnlPct, leverage, holdHours);

        const holdMinutes = holdHours * 60;

        // v90: ATR恢复 — 从持久化获取，或从当前K线重新计算
        let atrPct = this._posATR?.[symbol];
        if (!atrPct || atrPct <= 0) {
          const klineData = this.dataBus.klines?.[symbol];
          if (klineData && klineData.length >= 20) {
            const highs = klineData.slice(-20).map(k => k.high);
            const lows = klineData.slice(-20).map(k => k.low);
            const avgRange = highs.reduce((s, h, i) => s + (h - lows[i]), 0) / 20;
            atrPct = (avgRange / (currentPrice || 1)) * 100;
          } else {
            atrPct = 1.5;
          }
          if (!this._posATR) this._posATR = {};
          this._posATR[symbol] = atrPct;
        }

        // v103: MasterD Brain 接管持仓管理
        const _klines = this.dataBus.klines?.[symbol] || [];
        const _indicators = this.dataBus.indicators?.[symbol] || {};
        const _fundingRate = this.dataBus.marketData?.[symbol]?.fundingRate || null;
        const _longShortRatio = this.dataBus.marketData?.[symbol]?.longShortRatio || null;
        const _sentiment = this.dataBus.marketData?.[symbol]?.sentiment || null;
        const _brainPos = { side: pos.side, entryPrice: pos.entryPrice, leverage: leverage, openTime: this._openTime[symbol] || pos.openTime || Date.now(), _peakPnlPct: pos._peakPnlPct };
        const _whaleSig = this.whaleMonitor ? this.whaleMonitor.getSignal(symbol) : null;
        const _brainDecision = this.brain.managePosition(symbol, _brainPos, _klines, _indicators, _fundingRate, _longShortRatio, _sentiment, _whaleSig);

        // 峰值PnL追踪（从持久化恢复或实时追踪）
        if (pos._peakPnlPct === undefined) pos._peakPnlPct = this._peakPnlPct?.[symbol] || pnlPct;
        if (pnlPct > pos._peakPnlPct) pos._peakPnlPct = pnlPct;
        if (!this._peakPnlPct) this._peakPnlPct = {};
        this._peakPnlPct[symbol] = pos._peakPnlPct;

        // 趋势冲刺已删除

        // v103: Brain 决定平仓
        if (_brainDecision.action === 'CLOSE') {
          await this._executeClose(symbol, _brainDecision.reason);
          this.exitManager.recordResult(netPnlPct);
          if (this.brain) this.brain.recordTrade(symbol, netPnlPct, netPnlPct > 0);
          if (this.masterdAgent) this.masterdAgent.recordTrade(symbol, netPnlPct, netPnlPct > 0, { reason: 'brain_close' });
          continue;
        }

        // v113.22: Brain 决定顺势加仓
        if (_brainDecision.action === 'ADD_POSITION') {
          const addRatio = _brainDecision.addRatio || 0.3;
          const currentPosUsd = posNotional;
          const addCalc = this.positionSizer.calcAddSize({
            balanceUsd: balanceUsd,
            currentPosUsd,
            addRatio,
            trendStrength: _brainDecision.trendStrength || 0.5,
            atrPct: atrPct || 1.5,
          });
          if (!addCalc.reject) {
            this._log(`📈 ${symbol} 加仓计算: $${addCalc.addSizeUsd.toFixed(2)} | ${JSON.stringify(addCalc.details || {})}`);
            const addResult = await this.guardian.addPosition(symbol, addCalc.addSizeUsd, leverage);
            if (addResult.executed) {
              this._log(`✅ ${symbol} 加仓成功: ${addResult.action} $${addCalc.addSizeUsd.toFixed(2)}`);
              this.positionSizer.onAddPosition(); // 成功加仓后重置连续亏损计数
            } else {
              this._log(`❌ ${symbol} 加仓失败: ${addResult.reason}`);
            }
          } else {
            this._log(`⛔ ${symbol} 加仓被拒: ${addCalc.reason}`);
          }
          continue; // 加仓后本轮不继续处理
        }

        // v113.43: 自动调杠杆 — 趋势稳健时加杠杆，趋势恶化时降杠杆
        if (this._canAdjustLeverage(symbol) && netPnlPct > 0) {
          const _trendType = _brainDecision?.regime || '';
          const _trendStr = _brainDecision?.trendStrength || 0;
          const _atrPct = atrPct || 1.5;
          const _adaptiveMaxLev = this.positionSizer.getEffectiveMaxLeverage();
          
          // 严格计算最优杠杆：止损 > 1.5×ATR
          const _slPct = Math.abs(adaptiveParams.getParams().stopLossPct || 5);
          const _optimalLev = Math.floor(Math.min(
            _slPct / (1.5 * Math.max(_atrPct, 0.1)),
            100 / 5, // 爆仓 > 5%
            _adaptiveMaxLev
          ));

          if (_optimalLev !== leverage && _optimalLev > 0) {
            // 趋势稳健+盈利 → 可以加杠杆（不超过最优值）
            if (_trendStr > 0.5 && _trendType.includes('trend') && _optimalLev > leverage) {
              this._log(`🔧 ${symbol} 趋势稳健(trend=${_trendType} str=${_trendStr.toFixed(2)}) 加杠杆 ${leverage}x→${_optimalLev}x (ATR=${_atrPct.toFixed(2)}% 止损=${_slPct}%)`);
              try {
                await this.trader.setupLeverage(symbol, _optimalLev);
                leverage = _optimalLev;
                this._markLeverageAdjust(symbol);
                this._log(`✅ ${symbol} 杠杆调整成功 → ${_optimalLev}x`);
              } catch (e) {
                this._log(`❌ ${symbol} 杠杆调整失败: ${e.message}`);
              }
            }
            // 趋势恶化+波动增大 → 降杠杆
            else if (_trendStr < 0.3 && _atrPct > leverage * 0.5 && _optimalLev < leverage) {
              this._log(`🔧 ${symbol} 趋势恶化(trend=${_trendType} str=${_trendStr.toFixed(2)}) 降杠杆 ${leverage}x→${_optimalLev}x (ATR=${_atrPct.toFixed(2)}%)`);
              try {
                await this.trader.setupLeverage(symbol, _optimalLev);
                leverage = _optimalLev;
                this._markLeverageAdjust(symbol);
                this._log(`✅ ${symbol} 杠杆调整成功 → ${_optimalLev}x`);
              } catch (e) {
                this._log(`❌ ${symbol} 杠杆调整失败: ${e.message}`);
              }
            }
          }
        }

        // v113.22: Brain 决定趋势减仓
        if (_brainDecision.action === 'REDUCE_POSITION') {
          const reduceRatio = _brainDecision.reduceRatio || 0.3;
          const reduceCalc = this.positionSizer.calcReduceRatio({
            trendStrength: _brainDecision.trendStrength || 0,
            netPnlPct,
            holdMinutes,
            regime: _brainDecision.regime || 'ranging',
            reduceRatio,
          });
          if (!reduceCalc.reject) {
            this._log(`📉 ${symbol} 减仓计算: ratio=${(reduceCalc.reduceRatio * 100).toFixed(0)}% | ${JSON.stringify(reduceCalc.details || {})}`);
            const reduceResult = await this.guardian.reducePosition(symbol, reduceCalc.reduceRatio);
            if (reduceResult.executed) {
              this._log(`✅ ${symbol} 减仓成功: ${(reduceRatio * 100).toFixed(0)}%`);
              // 减仓部分的 PnL 记录
              const reducePnl = netPnlPct * reduceRatio;
              if (this.brain) this.brain.recordTrade(symbol, reducePnl, reducePnl > 0);
            } else {
              this._log(`❌ ${symbol} 减仓失败: ${reduceResult.reason}`);
            }
          } else {
            this._log(`⛔ ${symbol} 减仓被拒: ${reduceCalc.reason}`);
          }
          continue; // 减仓后本轮不继续处理
        }

        // v113.16: AdaptiveExitManager 顶级策略止盈止损
        const _exitCalc = this.exitManager.calculate(symbol, _brainPos, {
          price: currentPrice, atr: atrPct * currentPrice / 100, atrPct,
          klines: _klines, volume: 0, volatility: atrPct
        }, { balance: 100, positionCount: Object.keys(allPositions).length });

        // v113.79: 分批止盈已删除 — Guardian没实现实际部分平仓

        // 止盈止损判断
        const _exitDecision = this.exitManager.shouldClose(symbol, _brainPos, pnlPct, _exitCalc);
        if (_exitDecision && _exitDecision.shouldClose) {
          await this._executeClose(symbol, _exitDecision.reason);
          this.exitManager.recordResult(netPnlPct);
          if (this.brain) this.brain.recordTrade(symbol, netPnlPct, netPnlPct > 0);
          if (this.masterdAgent) this.masterdAgent.recordTrade(symbol, netPnlPct, netPnlPct > 0, { reason: _exitDecision.type });
          continue;
        }

        // v113.25: 超时兜底 — 放宽到4小时+12小时
        if (holdMinutes > 240 && netPnlPct < -2.0) {
          await this._executeClose(symbol, `⏰ 超时止损 毛利=${pnlPct.toFixed(1)}% 净利=${netPnlPct.toFixed(1)}% ${holdMinutes.toFixed(0)}min`);
          this.exitManager.recordResult(netPnlPct);
          if (this.brain) this.brain.recordTrade(symbol, netPnlPct, netPnlPct > 0);
          if (this.masterdAgent) this.masterdAgent.recordTrade(symbol, netPnlPct, netPnlPct > 0, { reason: 'timeout_stop' });
          continue;
        }
        if (holdMinutes > 720) {
          await this._executeClose(symbol, `⏰ 最大持仓时间 毛利=${pnlPct.toFixed(1)}% 净利=${netPnlPct.toFixed(1)}% ${holdMinutes.toFixed(0)}min`);
          this.exitManager.recordResult(netPnlPct);
          if (this.brain) this.brain.recordTrade(symbol, netPnlPct, netPnlPct > 0);
          if (this.masterdAgent) this.masterdAgent.recordTrade(symbol, netPnlPct, netPnlPct > 0, { reason: 'max_hold' });
          continue;
        }

        this._log(_brainDecision.reason || `💎 ${symbol} ${pos.side} 毛利=${pnlPct.toFixed(1)}% 净利=${netPnlPct.toFixed(1)}%`);

      } catch(e) { this._log(`⚠️ ${symbol}: ${e.message}`); }
    }
  }

  // ═══════════════════════════════════════════
  // 扫描开仓 — 多策略融合信号（v67重构）
  // 不再只靠MA交叉，而是调用StrategyManager全策略融合
  // ═══════════════════════════════════════════
  async _scanAndOpen() {
    this.trader.setMarketData(this.dataBus.marketData);  // v74: 确保价格数据最新
    const posCount = this.guardian.getPositionCount();

    const balance = await this.trader.getBalance();
    const balanceUsd = balance?.balance || 0;
    // v115: 缓存余额到 engineState，供 /api/status 使用
    this._cachedBalance = { balance: balanceUsd, available: balance?.availableBalance || balance?.available || 0, unrealizedPnl: balance?.unrealizedPnl || 0, timestamp: Date.now() };
    this.engineState.balance = balanceUsd;
    this.engineState.available = balance?.availableBalance || balance?.available || 0;
    // v113.62: 更新阶梯式仓位到 engineState，供仪表盘显示
    this.engineState.maxPositions = this.positionSizer._calcMaxPositions(balanceUsd);
    if (balanceUsd < 10) { this._log(`💸 余额不足 $${balanceUsd.toFixed(2)}`); return; }

    // v113.50: 取消全局冷却 — 单币冷却已足够，全局冷却浪费机会
    let canOpenNew = true;

    // v84: maxPositions由PositionSizer动态计算，不再写死
    const maxPos = this.positionSizer._calcMaxPositions(balanceUsd);
    const slotsAvailable = canOpenNew && posCount < maxPos;
    if (!slotsAvailable) { this._log(`📊 持仓${posCount}/${maxPos} 满/冷却=${!canOpenNew}，继续扫描信号`); }

    this._log(`🔍 扫描开仓 posCount=${posCount} balance=$${balanceUsd.toFixed(2)} symbols=${this._candidateSymbols.length}`);

    const scored = [];
    this._lastSignals = [];  // v112: 重置信号列表
    // v89: 不再每轮重置，改为只清理超过5分钟的旧标记（防止sync前重复开仓）
    const now = Date.now();
    for (const [sym, ts] of Object.entries(this._openedThisScan)) {
      if (now - ts > 5 * 60 * 1000) delete this._openedThisScan[sym];
    }
    for (const symbol of this._candidateSymbols) {
      if (this.guardian.getPosition(symbol)) continue;
      // v89: 已开仓标记（15分钟内有效）— v113.11: 从5分钟增加到15分钟
      if (this._openedThisScan[symbol] && now - this._openedThisScan[symbol] < 15 * 60 * 1000) continue;
      // v89: 同时检查冷却：已平仓的symbol也要检查 — v113.11: 从adaptiveParams读取
      // v113.49: 正常平仓冷却从60分钟降到10分钟
      const _cooldownMs = (adaptiveParams.getParams().cooldownMinutes || 10) * 60 * 1000;
      if (this._closedSymbols[symbol] && now - this._closedSymbols[symbol] < _cooldownMs) continue;

      // v113.11: 修复冷却逻辑bug — 之前亏损冷却判断完全失效
      // lastClose = Date.now() (正常平仓) 或 Date.now()+30min (亏损平仓)
      const lastClose = this._lastCloseTime?.[symbol] || 0;
      if (lastClose > 0) {
        // 亏损冷却: lastClose设为未来时间(Date.now()+30min)，需要等到那个时间才解禁
        if (lastClose > now) {
          const remainMin = (lastClose - now) / 60000;
          this._log(`⏳ ${symbol} 亏损冷却中，还需${remainMin.toFixed(0)}分钟`);
          continue;
        }
        // 正常冷却: v113.60: 统一使用 adaptive-params 的 cooldownMinutes
        const _normalCooldownMs = (adaptiveParams.getParams().cooldownMinutes || 10) * 60 * 1000;
        const elapsed = now - lastClose;
        if (elapsed < _normalCooldownMs) {
          const remainMin = (_normalCooldownMs - elapsed) / 60000;
          this._log(`⏳ ${symbol} 平仓冷却中，还需${remainMin.toFixed(0)}分钟`);
          continue;
        }
      }

      // v113.42: Supervisor选币范围 — 三大机器人协作
      if (this.positionSizer?.getSymbolFocus) {
        const sf = this.positionSizer.getSymbolFocus();
        if (sf.blacklist.includes(symbol)) {
          continue; // Supervisor黑名单 → 跳过
        }
        // focus模式：如果Supervisor标记cautious，只做focus里的币
        if (sf.mode === 'cautious' && sf.focus.length > 0 && !sf.focus.includes(symbol)) {
          continue;
        }
      }

      try {
        // v113.44: 多K线级别扫描 — 先尝试Supervisor推荐级别，无信号则降级
        const primaryTf = this.positionSizer?.getRecommendedTimeframe?.() || '1h';
        const scanTfs = primaryTf === '5m' ? ['5m'] :
                       primaryTf === '15m' ? ['15m', '5m'] :
                       primaryTf === '1h' ? ['1h', '15m', '5m'] :
                       ['4h', '1h', '15m'];
        
        let foundSignal = false;
        for (const tf of scanTfs) {
          if (foundSignal) break;
          // 拉取对应K线级别
          try {
            await this.dataBus.fetchKlines(symbol, tf, 200);
            this._klineFreshness[symbol] = Date.now();
          } catch(e) { continue; }
          
          const klines = this.dataBus.klines?.[symbol];
          if (!klines || klines.length < 60) continue;

          // ═══ v124: B策略优点融入 — 插针过滤 ═══
          // 单K线涨跌幅>3%判定为毛刺K线，跳过防止插针扫止损
          const _lastK = klines[klines.length - 1];
          const _kChangePct = Math.abs((_lastK.close - _lastK.open) / _lastK.open * 100);
          if (_kChangePct > 3) {
            this._log(`📌 ${symbol} ${tf} 插针过滤: 单K涨跌${_kChangePct.toFixed(1)}%>3% — 跳过`);
            if (!this._lastSignals) this._lastSignals = [];
            this._lastSignals.push({symbol, dir:'NEUTRAL', strength:0, confidence:0, signal:'PIN_BAR', score:0, timestamp:Date.now()});
            continue;
          }

          // ═══ v124: B策略优点融入 — 波动率禁令 ═══
          // 布林带带宽在最近100根K线中的历史分位>90%时禁开仓，避免在极端波动中入场
          const _bwLookback = Math.min(100, klines.length - 20);
          if (_bwLookback >= 20) {
            const _bandwidths = [];
            for (let i = klines.length - _bwLookback; i < klines.length; i++) {
              const _slice = klines.slice(Math.max(0, i - 19), i + 1);
              if (_slice.length >= 20) {
                const _closes = _slice.map(k => k.close);
                const _mean = _closes.reduce((a, b) => a + b, 0) / _closes.length;
                const _std = Math.sqrt(_closes.reduce((s, c) => s + (c - _mean) ** 2, 0) / _closes.length);
                const _bw = _std > 0 ? (4 * _std) / _mean * 100 : 0; // (upper-lower)/mid = 4*std/mean
                _bandwidths.push(_bw);
              }
            }
            if (_bandwidths.length >= 20) {
              const _currentBW = _bandwidths[_bandwidths.length - 1];
              let _countAbove = 0;
              for (const _bw of _bandwidths) { if (_bw >= _currentBW) _countAbove++; }
              const _bwPercentile = (_countAbove / _bandwidths.length) * 100;
              if (_bwPercentile > 90) {
                this._log(`🚫 ${symbol} ${tf} 波动率禁令: 布林带宽分位${_bwPercentile.toFixed(0)}%>90% — 禁开仓`);
                if (!this._lastSignals) this._lastSignals = [];
                this._lastSignals.push({symbol, dir:'NEUTRAL', strength:0, confidence:0, signal:'HIGH_VOLATILITY', score:0, timestamp:Date.now()});
                continue;
              }
            }
          }

          const ind = this.dataBus.calculateIndicators(symbol);
          if (!ind) continue;
          // v124: B策略优点融入 — 收盘价确认
          // 优先使用最近K线收盘价做信号判定，而非实时 ticker 价格，避免影线误导
          const _closePrice = klines[klines.length - 1]?.close || 0;
          const price = _closePrice || ind.price || 0;
          if (!price || price <= 0) continue;

          // ═══ v67: 调用StrategyManager全策略融合分析 ═══
          const analysis = await this.strategyManager.analyze({
            klines, currentPrice: price, symbol,
            marketData: this.dataBus.marketData?.[symbol] || {},
          });

        const signal = analysis.finalSignal;
        if (!signal || signal.action === 'HOLD') {
          // v112: 记录HOLD信号供仪表盘读取
          if (!this._lastSignals) this._lastSignals = [];
          this._lastSignals.push({
            symbol, dir: 'NEUTRAL', strength: 0, confidence: signal?.confidence || 0,
            signal: 'HOLD', score: signal?.score || 0, timestamp: Date.now(),
          });
          this._log(`⚪ ${symbol} ${tf} 融合信号HOLD score=${signal?.score?.toFixed(3) || 0} conf=${signal?.confidence?.toFixed(2) || 0}`);
          continue;  // 尝试下一个K线级别
        }

        const dir = signal.action === 'BUY' ? 'LONG' : 'SHORT';

        // ═══ v106: Brain 深度推理 — 交叉验证 StrategyManager 信号 ═══
        // Brain 提供策略层没有的能力: 体制识别 + 资金面 + 情绪面 + 历史记忆 + 风险感知
        const _fundingRate = this.dataBus.marketData?.[symbol]?.fundingRate || null;
        const _longShortRatio = this.dataBus.marketData?.[symbol]?.longShortRatio || null;
        const _sentiment = this.dataBus.marketData?.[symbol]?.sentiment || null;
        const _currentPositions = this.guardian.getAllPositions();
        const _whaleSignal = this.whaleMonitor ? this.whaleMonitor.getSignal(symbol) : null;
        const brainAnalysis = this.brain.analyze(symbol, klines, this.dataBus.marketData?.[symbol] || {}, ind, _fundingRate, _longShortRatio, _sentiment, _currentPositions, _whaleSignal);
        
        // v106: Brain 和 StrategyManager 交叉验证
        // 如果 Brain 认为方向不同 → 大幅降分
        // 如果 Brain 认为方向一致 → 加分
        // 如果 Brain 认为风险高 → 降分或拒绝
        let brainAgreement = 1.0;  // 默认中性
        let brainDetails = [];
        if (brainAnalysis && brainAnalysis.action !== 'WAIT') {
          const brainDir = brainAnalysis.action;
          if (brainDir === dir) {
            brainAgreement = 1.25;  // 方向一致 +25%
            brainDetails.push(`✅Brain确认`);
          } else {
            brainAgreement = 0.3;   // 方向矛盾 -70%
            brainDetails.push(`⚠️Brain矛盾(${brainDir})`);
          }
          // Brain 信心度影响
          if (brainAnalysis.confidence > 0.7) {
            brainDetails.push(`Brain信心=${brainAnalysis.confidence.toFixed(2)}`);
          }
          // Brain 风险感知
          if (brainAnalysis.riskLevel === 'high') {
            brainAgreement *= 0.4;
            brainDetails.push(`🔴Brain高风险`);
          } else if (brainAnalysis.riskLevel === 'medium') {
            brainAgreement *= 0.7;
            brainDetails.push(`🟡Brain中风险`);
          }
          // Brain 市场体制
          brainDetails.push(`[${brainAnalysis.marketRegime}]`);
          // Brain 资金流向
          if (brainAnalysis.smartMoney) {
            brainDetails.push(`资金${brainAnalysis.smartMoney}`);
          }
          // Brain 历史记忆
          const _mem = this.brain._recallMemory(symbol);
          if (_mem.count >= 3 && _mem.recentWinRate < 0.3) {
            brainAgreement *= 0.6;
            brainDetails.push(`📉历史胜率低${(_mem.recentWinRate*100).toFixed(0)}%`);
          } else if (_mem.count >= 3 && _mem.recentWinRate > 0.6) {
            brainAgreement *= 1.1;
            brainDetails.push(`📈历史胜率高${(_mem.recentWinRate*100).toFixed(0)}%`);
          }
        } else if (brainAnalysis && brainAnalysis.action === 'WAIT') {
          // v120: Brain观望 → 降20%而非完全不影响
          // 旧逻辑: brainAgreement=1.0 不阻止也不加分 → Brain形同虚设
          // 新逻辑: brainAgreement=0.8 → 降低score但不完全否决
          brainAgreement = 0.80;
          brainDetails.push(`⚪Brain观望(-20%)`);
          if (brainAnalysis.blockReasons && brainAnalysis.blockReasons.length > 0) {
            // 如果Brain有明确阻止理由 → 再降20%
            brainAgreement *= 0.80;
            brainDetails.push(`(${brainAnalysis.blockReasons.join(',')})`);
          }
        }

        // v113.28: 趋势优先选币 — 趋势强度是第一权重
        // 之前: 融合分(0-4)+置信度(0-2)权重过高，趋势加分太少
        // 导致趋势极弱(偏离MA99 0.4%)的币被选为最强信号
        // 现在: 趋势占主导，融合分和置信度只做辅助确认
        let strength = 0;
        const details = [];

        // ═══ 趋势强度 (0-6分) — 第一权重 ═══
        const ma7 = ind.ma7 || price;
        const ma25 = ind.ma25 || price;
        const ma99 = ind.ma99 || price;
        const ma99Distance = dir === 'LONG' ? ((price - ma99) / ma99 * 100) : ((ma99 - price) / price * 100);

        // 逆趋势 — 大幅降分
        if (dir === 'LONG' && price < ma99) {
          strength *= 0.3;
          details.push(`⚠️逆MA99趋势做多-70% (偏离${ma99Distance.toFixed(1)}%)`);
          if (ma99Distance > 3) {
            this._log(`⛔ ${symbol} 逆MA99偏离过大(${ma99Distance.toFixed(1)}%) — 拒绝`);
            if (!this._lastSignals) this._lastSignals = [];
            this._lastSignals.push({symbol, dir:'NEUTRAL', strength:0, confidence:signal.confidence, signal:'BLOCKED_TREND', score:signal.score, timestamp:Date.now()});
            continue;
          }
        }
        if (dir === 'SHORT' && price > ma99) {
          strength *= 0.3;
          details.push(`⚠️逆MA99趋势做空-70% (偏离${ma99Distance.toFixed(1)}%)`);
          if (ma99Distance > 3) {
            this._log(`⛔ ${symbol} 逆MA99偏离过大(${ma99Distance.toFixed(1)}%) — 拒绝`);
            if (!this._lastSignals) this._lastSignals = [];
            this._lastSignals.push({symbol, dir:'NEUTRAL', strength:0, confidence:signal.confidence, signal:'BLOCKED_TREND', score:signal.score, timestamp:Date.now()});
            continue;
          }
        }

        // 顺势 — 趋势越强加分越多 (最多+4分)
        if ((dir === 'LONG' && price > ma99) || (dir === 'SHORT' && price < ma99)) {
          const trendScore = Math.min(4.0, ma99Distance / 1.5); // 偏离1.5%得1分，偏离6%得4分
          strength += trendScore;
          details.push(`✅趋势+${trendScore.toFixed(1)} (偏离MA99 ${ma99Distance.toFixed(1)}%)`);
          // MA排列加分
          if (dir === 'LONG' && ma7 > ma25) { strength += 1; details.push('MA多头确认'); }
          if (dir === 'SHORT' && ma7 < ma25) { strength += 1; details.push('MA空头确认'); }
          if (dir === 'LONG' && ma25 > ma99) { strength += 0.5; details.push('MA25趋势一致'); }
          if (dir === 'SHORT' && ma25 < ma99) { strength += 0.5; details.push('MA25趋势一致'); }
          if (dir === 'LONG' && ma7 > ma25 && ma25 > ma99) { strength += 0.5; details.push('完整多头排列'); }
          if (dir === 'SHORT' && ma7 < ma25 && ma25 < ma99) { strength += 0.5; details.push('完整空头排列'); }
        }

        // ═══ 融合分辅助 (0-1.5分) — 降低权重 ═══
        const absScore = Math.abs(signal.score);
        strength += Math.min(1.5, absScore * 1.5);
        details.push(`融合分=${signal.score.toFixed(3)}`);

        // ═══ 置信度辅助 (0-1分) — 降低权重 ═══
        strength += signal.confidence * 2;
        details.push(`置信度=${signal.confidence.toFixed(2)}`);

        // v112.3: 短期动量/反弹过滤 — 防止在下跌趋势的反弹中做空被止损
        // 核心问题: 1H下跌趋势中会有小时级反弹(0.3-0.5%), 在反弹中做空会被反弹打止损
        const recentCloses = klines.slice(-6).map(k => k.close);
        const minLow = Math.min(...recentCloses);
        const maxHigh = Math.max(...recentCloses);
        const priceRange = maxHigh - minLow;
        const bounceFromLow = price - minLow;
        const bouncePct = priceRange > 0 ? (bounceFromLow / priceRange) * 100 : 50;
        // 最近3根K线连续上涨 = 反弹中
        const last3Up = recentCloses[2] < recentCloses[1] && recentCloses[1] < recentCloses[0];

        if (dir === 'SHORT') {
          // v123: 追跌做空(bounce<5%)才拦截 — 之前15%太严
          if (bouncePct < 5) {
            this._log(`⛔ ${symbol} 追跌做空(位置${bouncePct.toFixed(0)}%<5%) — 直接拦截`);
            if (!this._lastSignals) this._lastSignals = [];
            this._lastSignals.push({symbol, dir:'NEUTRAL', strength:0, confidence:signal.confidence, signal:'BLOCKED_CHASE_DROP', score:signal.score, timestamp:Date.now()});
            continue;
          }
          // v123: 放宽到80%
          if (last3Up && bouncePct > 80) {
            this._log(`⛔ ${symbol} 反弹中做空(连续3根上涨+位置${bouncePct.toFixed(0)}%) — 直接拦截`);
            if (!this._lastSignals) this._lastSignals = [];
            this._lastSignals.push({symbol, dir:'NEUTRAL', strength:0, confidence:signal.confidence, signal:'BLOCKED_REBOUND_SHORT', score:signal.score, timestamp:Date.now()});
            continue;
          }
          // v113.71: 高卖 — 反弹到高位时做空更好
          if (bouncePct > 80) {
            // 太高可能是强突破
            strength *= 0.5;
            details.push(`⚠️强突破做空-50% (回升${bouncePct.toFixed(0)}%) — 等稳定`);
          } else if (bouncePct > 60) {
            // 高卖 — 加分
            strength *= 1.2;
            details.push(`✅高卖做空+20% (回升${bouncePct.toFixed(0)}%)`);
          } else {
            // 正常位置 15-60%
            if (last3Up) {
              strength *= 0.7;
              details.push('⚠️连续3根上涨-30%');
            }
          }
        }

        if (dir === 'LONG') {
          // v123: 放宽到95%
          if (bouncePct > 95) {
            this._log(`⛔ ${symbol} 追涨做多(位置${bouncePct.toFixed(0)}%>95%) — 直接拦截`);
            if (!this._lastSignals) this._lastSignals = [];
            this._lastSignals.push({symbol, dir:'NEUTRAL', strength:0, confidence:signal.confidence, signal:'BLOCKED_CHASE_LONG', score:signal.score, timestamp:Date.now()});
            continue;
          }
          // v123: 放宽 — 连续3跌+bounce<20%才拦截
          const last3Down = recentCloses[2] > recentCloses[1] && recentCloses[1] > recentCloses[0];
          if (last3Down && bouncePct < 20) {
            this._log(`⛔ ${symbol} 下跌中做多(连续3根下跌+位置${bouncePct.toFixed(0)}%) — 直接拦截`);
            if (!this._lastSignals) this._lastSignals = [];
            this._lastSignals.push({symbol, dir:'NEUTRAL', strength:0, confidence:signal.confidence, signal:'BLOCKED_DROP_LONG', score:signal.score, timestamp:Date.now()});
            continue;
          }
          // v113.71: 底买 — 回调到低位时做多更好
          if (bouncePct < 15) {
            // 太低可能是接飞刀
            strength *= 0.5;
            details.push(`⚠️急跌中做多-50% (位置${bouncePct.toFixed(0)}%) — 等稳定`);
          } else if (bouncePct < 40) {
            // 底买 — 加分
            strength *= 1.2;
            details.push(`✅底买做多+20% (位置${bouncePct.toFixed(0)}%)`);
          }
          // 连续3根下跌
          if (last3Down) {
            strength *= 0.7;
            details.push('⚠️连续3根下跌-30%');
          }
        }

        // v113.28: MA趋势逻辑已移到上方，这里不再重复

        // 策略原因
        if (signal.reasons && signal.reasons.length > 0) {
          const r = signal.reasons;
          details.push(Array.isArray(r) ? r.slice(0, 3).join(' | ') : String(r).slice(0, 200));
        }

        // v67: ML矛盾惩罚 — ML方向与信号相反，降分
        const _mlResult = analysis.analysis?.ml || analysis.signals?.ml || analysis.mlResult;
        if (_mlResult?.valid && _mlResult.direction !== 0) {
          const mlDir = _mlResult.direction > 0 ? 'LONG' : 'SHORT';
          if (mlDir !== dir) {
            strength *= 0.6;  // v98: ML矛盾大幅降分（根因#3修复）
            details.push('⚠️ML矛盾-40%');
          }
        }

        // v106: Brain 深度推理结果应用
        strength *= brainAgreement;
        if (brainDetails.length > 0) details.push(brainDetails.join(' '));

        // v113: MasterD Agent 深度分析增强（异步，不阻塞）
        if (this.masterdAgent && (dir === 'LONG' || dir === 'SHORT') && strength >= 2.0) {
          try {
            const agentDecision = await this.masterdAgent.deepAnalyze(symbol, klines, ind, this.dataBus.marketData?.[symbol] || {}, _currentPositions);
            if (agentDecision) {
              // Agent 最终方向与信号一致 → 增强
              if (agentDecision.direction === dir) {
                strength *= 1.15;
                details.push(`🧬Agent确认 conf=${agentDecision.confidence.toFixed(2)}`);
              } else if (agentDecision.direction === 'WAIT') {
                // Agent 观望 → 降分但不阻止
                strength *= 0.7;
                details.push(`🧬Agent观望`);
              } else {
                // Agent 反对 → 大幅降分
                strength *= 0.3;
                details.push(`🧬Agent反对(${agentDecision.direction})`);
              }
              // 新闻增强
              if (agentDecision.newsEnhanced) {
                if (agentDecision.newsEnhanced.newsBoost) {
                  strength *= agentDecision.newsEnhanced.multiplier;
                  details.push(`📰新闻增强×${agentDecision.newsEnhanced.multiplier.toFixed(2)}`);
                }
                if (agentDecision.newsEnhanced.newsBlocked) {
                  strength = 0;
                  details.push(`⛔新闻过滤`);
                }
              }
              // 保存Agent推理链供仪表盘查看
              if (!this._lastAgentDecisions) this._lastAgentDecisions = {};
              this._lastAgentDecisions[symbol] = agentDecision;
            }
          } catch (e) { /* Agent失败不影响主流程 */ }
        }

        // v113.48: 降低开仓门槛 — 神经网络权重已提高+止盈止损已修复
        const isBTC = symbol === 'BTCUSDT';
        const _isTrendAligned = (dir === 'LONG' && price > ma99) || (dir === 'SHORT' && price < ma99);
        const minStrength = _isTrendAligned ? (isBTC ? 2.0 : 1.5) : (isBTC ? 3.5 : 2.5);
        // v113.48: 趋势偏离门槛从1.0%降到0.5%
        // v123: 门槛从0.5%降到0.1%
        if (_isTrendAligned && ma99Distance < 0.1 && !isBTC) {
          this._log(`⚪ ${symbol} 趋势太弱 偏离MA99仅${ma99Distance.toFixed(2)}% < 0.1% — 跳过`);
          if (!this._lastSignals) this._lastSignals = [];
          this._lastSignals.push({symbol, dir:'NEUTRAL', strength:0, confidence:signal.confidence, signal:'WEAK_TREND', score:signal.score, timestamp:Date.now()});
          continue;
        }
        if (strength < minStrength) {
          this._log(`⚪ ${symbol} ${tf} 信号不够强 str=${strength.toFixed(1)}/${minStrength} ${_isTrendAligned ? '顺势' : '逆势'} conf=${signal.confidence.toFixed(2)} — 尝试下一个级别`);
          if (!this._lastSignals) this._lastSignals = [];
          this._lastSignals.push({symbol, dir, strength, confidence: signal.confidence, signal: 'WEAK', score: signal.score, timestamp: Date.now()});
          continue;
        }
        // v123: 置信度门槛从0.45降到0.25
        if (signal.confidence < 0.25) {
          this._log(`⚪ ${symbol} ${tf} 置信度太低 conf=${signal.confidence.toFixed(2)} < 0.45 — 尝试下一个级别`);
          if (!this._lastSignals) this._lastSignals = [];
          this._lastSignals.push({symbol, dir:'NEUTRAL', strength:0, confidence:signal.confidence, signal:'LOW_CONF', score:signal.score, timestamp:Date.now()});
          continue;
        }

        // v123: 放宽反弹过滤 — 之前65%太严
        if (dir === 'SHORT' && price > ma99 && bouncePct > 90) {
          this._log(`⛔ ${symbol} 反弹中(${bouncePct.toFixed(0)}%)跳过做空`);
          if (!this._lastSignals) this._lastSignals = [];
          this._lastSignals.push({symbol, dir:'NEUTRAL', strength:0, confidence:signal.confidence, signal:'BLOCKED_REBOUND', score:signal.score, timestamp:Date.now()});
          continue;
        }
        if (dir === 'LONG' && price < ma99 && bouncePct < 10) {
          this._log(`⛔ ${symbol} 下跌中(${bouncePct.toFixed(0)}%)跳过做多`);
          if (!this._lastSignals) this._lastSignals = [];
          this._lastSignals.push({symbol, dir:'NEUTRAL', strength:0, confidence:signal.confidence, signal:'BLOCKED_DROP', score:signal.score, timestamp:Date.now()});
          continue;
        }

        // v113.52: 神经网络置信度优先 — 作为选币排序的第一权重
        // analyze() 返回 { analysis: { neuralNet }, signals: { neuralNet } }
        // 注意: 必须在 _log 之前计算, 这样 NN 标记会出现在日志里
        const _nnResult = analysis.analysis?.neuralNet || analysis.signals?.neuralNet || analysis.mlResult || {};
        const _nnProbs = _nnResult.probabilities || {};
        const _nnConfidence = _nnResult.valid ? _nnResult.confidence : 0;
        const _nnDir = _nnResult.valid ? (_nnResult.direction > 0 ? 'LONG' : _nnResult.direction < 0 ? 'SHORT' : null) : null;
        
        // v113.52: 当神经网络明确给方向时，检查是否与信号一致
        // 当神经网络方向为中性(direction=0)时，用 up/down 概率判断是否支持信号方向
        let _nnAgrees = false;
        let _nnScore = 0;
        
        if (_nnResult.valid && _nnDir === dir) {
          // 神经网络方向与信号一致 → 强信号
          _nnAgrees = true;
          _nnScore = _nnConfidence;
          details.push(`🧠NN确认 ${_nnDir} conf=${_nnConfidence.toFixed(2)}×10=${(_nnConfidence*10).toFixed(1)}`);
        } else if (_nnResult.valid && _nnDir && _nnDir !== dir) {
          // 神经网络明确反对 → 大幅降分
          _nnAgrees = false;
          _nnScore = -_nnConfidence * 0.5;
          details.push(`⚠️NN矛盾 ${_nnDir}≠${dir} conf=${_nnConfidence.toFixed(2)}`);
        } else if (_nnResult.valid && !_nnDir) {
          // 神经网络中性 → 用 up/down 概率判断偏向
          const _upProb = _nnProbs.up || 0;
          const _downProb = _nnProbs.down || 0;
          const _neutralProb = _nnProbs.neutral || 0;
          
          // v113.52d: 当 NN 极度偏向 neutral (>0.95) 时，说明模型没有有效预测
          // 这种情况下 up/down 概率都是噪音，不应该影响选币
          if (_neutralProb > 0.95) {
            _nnAgrees = false;
            _nnScore = 0;  // 不加分也不扣分
            details.push(`⚪NN无有效预测 (neutral=${_neutralProb.toFixed(3)})`);
          } else if (dir === 'LONG' && _upProb > _downProb) {
            // 做多且 up概率 > down概率 → 弱支持
            _nnAgrees = true;
            _nnScore = _upProb * 0.6;  // 中性状态下权重减半
            details.push(`🧠NN偏多 up=${_upProb.toFixed(2)} down=${_downProb.toFixed(2)}`);
          } else if (dir === 'SHORT' && _downProb > _upProb) {
            _nnAgrees = true;
            _nnScore = _downProb * 0.6;
            details.push(`🧠NN偏空 down=${_downProb.toFixed(2)} up=${_upProb.toFixed(2)}`);
          } else {
            // 概率不支持信号方向 → 轻微降分
            _nnAgrees = false;
            _nnScore = -0.2;
            details.push(`⚠️NN概率不支持 up=${_upProb.toFixed(2)} down=${_downProb.toFixed(2)}`);
          }
        }
        
        // v113.52: 最终评分 = 神经网络置信度×10(主) + 趋势强度×3(辅) + 融合分×2(辅)
        let finalScore = 0;
        finalScore += _nnScore * 10;  // 神经网络: -5 到 +10分 (主权重)
        finalScore += strength * 3;  // 趋势强度: 0-18分 (辅助)
        finalScore += Math.abs(signal.score) * 2;  // 融合分: 0-2分 (辅助)
        
        this._log(`📊 ${symbol} ${dir} str=${strength.toFixed(1)} conf=${signal.confidence.toFixed(2)} bounce=${bouncePct.toFixed(0)}% [${tf}] ${details.join(' | ')}`);
        
        scored.push({ 
          symbol, dir, 
          strength: finalScore,  // 用 finalScore 替代原 strength 做排序
          rawStrength: strength,  // 保留原始趋势强度
          confidence: signal.confidence,
          nnConfidence: _nnAgrees ? Math.max(0, _nnScore) : 0,  // 只在NN同意时记录
          nnAgrees: _nnAgrees,
          details: details.join(' | '), 
          signal, analysis, timeframe: tf 
        });
        foundSignal = true;
        break;  // 找到信号，不再尝试更小级别
        } // end for tf
      } catch(e) { this._log(`⚠️ ${symbol} 扫描异常: ${e.message}`); }
      await new Promise(r => setTimeout(r, 200));
    }

    scored.sort((a, b) => b.strength - a.strength);
    if (scored.length > 0) {
      this._log(`📊 候选: ${scored.slice(0, 5).map(s => `${s.symbol}=${s.dir} nn=${s.nnConfidence?.toFixed(2)||0} str=${s.strength.toFixed(1)}`).join(', ')}`);
    }
    // v112: 保存最近信号供仪表盘读取
    this._lastSignals = scored.map(s => ({
      symbol: s.symbol, dir: s.dir, strength: s.strength, confidence: s.confidence,
      nnConfidence: s.nnConfidence || 0,
      signal: s.signal?.action || 'HOLD', score: s.signal?.score || 0,
      timestamp: Date.now(),
    }));

    // v112.5: 写入统一信号池
    signalPool.collect(scored.map(s => ({
      symbol: s.symbol, dir: s.dir, strength: s.strength, confidence: s.confidence,
      nnConfidence: s.nnConfidence || 0,
      score: s.signal?.score || 0, market: 'crypto', source: 'engine', timestamp: Date.now(),
    })));

    // v86: 方向分散 — 已有持仓的多/空方向统计，避免全部同向
    // v113.60: 修复 getPositions 不存在 — 改用 getAllPositions (返回 Object)
    const existingPositions = Object.values(this.guardian.getAllPositions());
    let longCount = 0, shortCount = 0;
    for (const p of existingPositions) {
      if (p.side === 'LONG') longCount++;
      else shortCount++;
    }
    // 如果已有持仓70%以上同方向，只允许反方向开仓
    const totalPos = longCount + shortCount;
    const preferDir = totalPos >= 2 ? (longCount > shortCount + 1 ? 'SHORT' : shortCount > longCount + 1 ? 'LONG' : null) : null;
    if (preferDir) {
      this._log(`📊 方向对冲: 已有${longCount}多/${shortCount}空，优先${preferDir}`);
    }

    // v84: 取TOP信号开仓，仓位由PositionSizer动态计算
    if (!slotsAvailable) {
      // 仓位已满，只记录信号不开仓
      return;
    }
    // v113.24: 集中资金 — 只选趋势最强的TOP 2-3
    const maxSlots = this.positionSizer._calcMaxPositions(balanceUsd) - posCount;
    const topCount = Math.min(scored.length, maxSlots);
    let pickedDirections = { LONG: longCount, SHORT: shortCount };
    // v118: 信号质量过滤 — 趋势方向必须一致才能开仓
    // 旧: 时间框架不一致只扣50%但仍能开仓 → 入场即被反向波动扫止损
    // 新: NN明确矛盾或NN概率不支持 → 直接排除, 不浪费仓位
    const strongPicks = scored.filter(s => {
      const details = s.details || '';
      // NN明确矛盾 → 排除
      if (details.includes('NN矛盾')) return false;
      // NN概率不支持 → 排除
      if (details.includes('NN概率不支持')) return false;
      // 神经网络置信度≥0.5且方向一致 OR 综合评分≥8
      return (s.nnConfidence >= 0.5 && s.nnAgrees) || s.strength >= 8.0;
    });
    const picksToOpen = strongPicks.length > 0 ? strongPicks.slice(0, topCount) : [];
    if (picksToOpen.length === 0 && scored.length > 0) {
      this._log(`📊 候选${scored.length}个但无强信号(nn≥0.5或str≥8)，暂不开仓`);
    }
    for (const pick of picksToOpen) {
      // v113.72: 硬限制 — 每次开仓前重新检查实时持仓数
      const _livePos = this.guardian.getPositionCount();
      if (_livePos >= maxPos) {
        this._log(`📊 持仓${_livePos}/${maxPos} 已满，停止开仓`);
        break;
      }
      // v113.72: 不限制方向 — 集中持仓只看趋势强弱, 不人为分散方向

      // v67: 计算ATR用于动态止损止盈 + 仓位计算
      const klines = this.dataBus.klines?.[pick.symbol] || [];
      const atr = this._calculateATR(klines, 14);
      const currentPrice = this.dataBus.marketData?.[pick.symbol]?.price || 0;
      const atrPct = atr > 0 && currentPrice > 0 ? (atr / currentPrice) * 100 : 2; // 默认2%

      // v84: 动态仓位计算（余额×波动率×置信度×回撤保护）
      // v113.15: 传递趋势强度让 PositionSizer 顺势加杠杆加仓
      const _pickInd = this.dataBus.indicators?.[pick.symbol] || {};
      const _pickPrice = this.dataBus.marketData?.[pick.symbol]?.price || 0;
      const _pickMA99 = _pickInd.ma99 || _pickPrice;
      const _pickMA7 = _pickInd.ma7 || _pickPrice;
      const _pickMA25 = _pickInd.ma25 || _pickPrice;
      let _trendStrength = 0;
      // 顺势且完整排列 → 趋势最强
      if (pick.dir === 'LONG' && _pickPrice > _pickMA99) {
        const _dist = Math.abs((_pickPrice - _pickMA99) / _pickMA99 * 100);
        _trendStrength = Math.min(2.0, _dist / 2);
        if (_pickMA7 > _pickMA25 && _pickMA25 > _pickMA99) _trendStrength += 0.5;
      } else if (pick.dir === 'SHORT' && _pickPrice < _pickMA99) {
        const _dist = Math.abs((_pickMA99 - _pickPrice) / _pickPrice * 100);
        _trendStrength = Math.min(2.0, _dist / 2);
        if (_pickMA7 < _pickMA25 && _pickMA25 < _pickMA99) _trendStrength += 0.5;
      }
      _trendStrength = Math.min(2.5, _trendStrength);

      let sizing;
      let isSurge = false; // v113.31: 保留兼容性占位

      // v113.31: 趋势冲刺已移至独立引擎，主引擎只用原策略
      {
        // 原策略 — PositionSizer 动态计算
        sizing = this.positionSizer.size({
          balanceUsd, atrPct, currentPrice,
          signalStrength: pick.strength >= 12 ? 'strong' : pick.strength >= 6 ? 'moderate' : 'weak',
          confidence: pick.confidence,
          posCount: this.guardian.getPositionCount(),
          trendStrength: _trendStrength,
        });
      }

      if (sizing.reject) {
        this._log(`⏭️ ${pick.symbol} 仓位计算拒绝: ${sizing.reason}`);
        continue;
      }

      let { leverage, positionSize, notional } = sizing;

      // v97: 跨市场共享风控检查
      if (this.sharedRisk) {
        const riskCheck = this.sharedRisk.preTradeCheck(
          'crypto', pick.dir, positionSize, leverage, this.positions
        );
        if (!riskCheck.allowed) {
          this._log(`🛡️ 风控拒绝 ${pick.symbol} ${pick.dir}: ${riskCheck.reason}`);
          continue;
        }
        if (riskCheck.adjustedSize && riskCheck.adjustedSize < positionSize) {
          this._log(`⚠️ 风控调整 ${pick.symbol}: $${positionSize.toFixed(2)} → $${riskCheck.adjustedSize.toFixed(2)} (${riskCheck.reason})`);
          positionSize = riskCheck.adjustedSize;
        }
      }

      this._log(`🎯 ${pick.symbol} ${pick.dir} ${leverage}x $${positionSize.toFixed(1)} (${sizing.details.balancePct}) ATR=${atrPct.toFixed(2)}% vol=${sizing.details.volRegime} [${pick.timeframe||'1h'}] | ${pick.details}`);
    // v113.60: _canAdjustLeverage / _markLeverageAdjust 已移到构造函数，这里不再重复定义

    // v83: 失败冷却检查
      const failCount = this._openFailCount[pick.symbol] || 0;
      const failTime = this._openFailTime[pick.symbol] || 0;
      if (failCount >= 3 && Date.now() - failTime < 3600 * 1000) {
        const remain = ((3600000 - (Date.now() - failTime)) / 60000).toFixed(0);
        this._log(`⏸️ ${pick.symbol} 连续失败${failCount}次，冷却${remain}min`);
        continue;
      }

      const result = await this.guardian.executeDecision({
        action: pick.dir,
        leverage,
        positionSize,
        reasoning: pick.details
      }, pick.symbol);

      if (result.executed && !result.blocked && result.success !== false) {
        // v113.31: 趋势冲刺记录已移至独立引擎
        // v97: 通知风控层记录开仓
        if (this.sharedRisk) {
          this.sharedRisk.recordOpen('crypto', pick.dir, positionSize, leverage);
        }
        // v83: 成功，重置失败计数
        this._openFailCount[pick.symbol] = 0;
        if (!this._openTime) this._openTime = {};
        this._openTime[pick.symbol] = Date.now();
        if (!this._posATR) this._posATR = {};
        this._posATR[pick.symbol] = atrPct;
        // v88: 标记本轮扫描已开仓，防止同轮重复开仓
        this._openedThisScan[pick.symbol] = Date.now();
        // v86: 更新方向统计
        pickedDirections[pick.dir] = (pickedDirections[pick.dir] || 0) + 1;
        // v83: 记录完整交易数据（学习闭环）
        this._recordTrade({
          symbol: pick.symbol, side: pick.dir, action: 'OPEN',
          price: this.dataBus.marketData?.[pick.symbol]?.price || 0,
          size: positionSize, leverage, atr: atrPct,
          score: pick.signal?.score || 0, confidence: pick.confidence,
          strategy: 'Multi-Strategy Fusion',
          features: [],
          reasons: pick.details
        });
        const factorScores = pick.analysis?.mlResult?.valid ? pick.analysis.mlResult : {};
        this.strategyManager.recordTradeResult(0, pick.signal?.score || 0, pick.dir === 'LONG' ? 1 : -1, factorScores);
        // v83: DynamicWeight 自学习 — 记录开仓时的策略权重
        const dw = this.strategyManager.strategies.dynamicWeight;
        if (dw && pick.signal?.details) {
          for (const d of pick.signal.details) {
            if (d && d.strategy) dw.recordStrategyResult(d.strategy, 0);
          }
        }
        if (this.notifier) {
          this.notifier.notifyOpenPosition({
            symbol: pick.symbol, side: pick.dir,
            price: this.dataBus.marketData?.[pick.symbol]?.price || 0,
            amount: positionSize, strategy: 'Multi-Strategy Fusion v83',
            confidence: pick.confidence, reasons: Array.isArray(pick.details) ? pick.details : String(pick.details).split(' | ')
          });
        }
      } else {
        // v83: 失败，记录原因+计数
        const failReason = result.reason || result.error || 'unknown';
        this._openFailCount[pick.symbol] = (this._openFailCount[pick.symbol] || 0) + 1;
        this._openFailTime[pick.symbol] = Date.now();
        this._log(`❌ ${pick.symbol} 开仓失败(#${this._openFailCount[pick.symbol]}): ${failReason}`);
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    // v114: 配对交易已删除 — 需要协整检验, 代码里没有实现, 假策略
  }

  // ═══ v83: 完整交易记录（学习闭环） ═══
  _recordTrade(data) {
    try {
      const tradesPath = path.join(__dirname, 'data', 'trade-log.json');
      let trades = [];
      try { trades = JSON.parse(fs.readFileSync(tradesPath, 'utf8')); } catch(e) {}
      trades.push({
        ...data,
        timestamp: Date.now(),
        input: data.features || [],
        output: [data.side === 'LONG' ? 1 : -1],
        label: data.side === 'LONG' ? 1 : -1,
        pnl: null,
        closeTime: null,
        closePrice: null
      });
      if (trades.length > 2000) trades = trades.slice(-2000);
      fs.writeFileSync(tradesPath, JSON.stringify(trades, null, 2));
    } catch(e) { this._log(`⚠️ 记录交易失败: ${e.message}`); }
  }

  _recordTradeClose(symbol, pnl, closePrice, reason, side, entryPrice, leverage) {
    try {
      const tradesPath = path.join(__dirname, 'data', 'trade-log.json');
      let trades = JSON.parse(fs.readFileSync(tradesPath, 'utf8'));
      for (let i = trades.length - 1; i >= 0; i--) {
        if (trades[i].symbol === symbol && trades[i].action === 'OPEN' && trades[i].pnl === null) {
          trades[i].pnl = pnl;
          trades[i].closePrice = closePrice;
          trades[i].closeTime = Date.now();
          trades[i].exitReason = reason || 'unknown';
          trades[i].side = trades[i].side || side || 'LONG';
          trades[i].entryPrice = trades[i].entryPrice || entryPrice || 0;
          trades[i].leverage = trades[i].leverage || leverage || 1;
          // v107: 计算并记录 pnlPct
          if (entryPrice && entryPrice > 0 && leverage && leverage > 0) {
            trades[i].pnlPct = (pnl / (entryPrice * leverage)) * 100;
          }
          break;
        }
      }
      fs.writeFileSync(tradesPath, JSON.stringify(trades, null, 2));
    } catch(e) { this._log(`⚠️ 更新平仓记录失败: ${e.message}`); }
  }

  // v67: ATR计算辅助函数
  _calculateATR(klines, period = 14) {
    if (!klines || klines.length < period + 1) return 0;
    const trueRanges = [];
    for (let i = 1; i < klines.length; i++) {
      const high = klines[i].high || klines[i].close || 0;
      const low = klines[i].low || klines[i].close || 0;
      const prevClose = klines[i - 1].close || 0;
      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trueRanges.push(tr);
    }
    const slice = trueRanges.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }

  // v73: 无用策略已全部移除

  _log(msg) { _logger.info(msg); }
  _startOfDay() { const d = new Date(); d.setUTCHours(0,0,0,0); return d.getTime(); }

  async _forceRefreshKlines(symbol) {
    if (this._klineLock[symbol]) return;
    this._klineLock[symbol] = true;
    try {
      // v113.42: K线级别由三大机器人协作决定
      // 1. 先看Supervisor的市场分析建议
      const supervisorTf = this.positionSizer?.getRecommendedTimeframe?.();
      // 2. 再由PositionSizer量化计算
      const ind0 = this.dataBus.calculateIndicators(symbol);
      const atrPct0 = ind0?.atrPct || 1.5;
      const lev0 = this.positionSizer?.getEffectiveMaxLeverage?.() || 5;
      const calculatedTf = this.positionSizer?.selectTimeframe?.(atrPct0, lev0, 240) || '1h';
      // 3. Supervisor建议优先（它有全市场视角）
      const tf = supervisorTf || calculatedTf;
      if (!this._klineInterval) this._klineInterval = {};
      const prevTf = this._klineInterval[symbol];
      if (prevTf && prevTf !== tf) {
        this._log(`📊 ${symbol} K线级别 ${prevTf} → ${tf} (ATR=${atrPct0.toFixed(2)}% lev=${lev0}x)`);
      }
      this._klineInterval[symbol] = tf;
      await this.dataBus.fetchKlines(symbol, tf, 200);
      this._klineFreshness[symbol] = Date.now();
    } catch(e) {}
    finally { this._klineLock[symbol] = false; }
  }

  async _executeClose(symbol, reason) {
    // v89: 平仓锁 — 防止并发/同步周期重复调用
    if (this._closingLock[symbol]) {
      this._log(`⏭️ ${symbol} 平仓进行中，跳过重复调用`);
      return;
    }
    this._closingLock[symbol] = true;
    // v113.31: 趋势冲刺记录由独立引擎管理
    let _closePnlPct = 0;
    let _closeSide = 'LONG';
    let _closeEntryPrice = 0;
    let _closeLeverage = 1;
    try {
      this._log(`📤 ${symbol}: ${reason}`);
      // v89: 设置平仓标记，30分钟内不会再次触发
      if (!this._closedSymbols) this._closedSymbols = {};
      this._closedSymbols[symbol] = Date.now();
      const _posBefore = this.guardian.positions[symbol] || {};
      _closeSide = _posBefore.side || 'LONG';
      _closeEntryPrice = _posBefore.entryPrice || 0;
      _closeLeverage = _posBefore.leverage || 1;
      const result = await this.guardian.executeDecision({ action: 'CLOSE', leverage: 0, positionSize: 0 }, symbol);
      // 修复：平仓失败时保留本地仓位，等下一轮sync确认后重试
      // 之前不检查result.success直接删除 → 远程仓位失去监控
      if (result.success === false || result.executed === false && result.noPosition !== true) {
        this._log(`⚠️ ${symbol} 平仓失败: ${result.error || result.reason || 'unknown'} — 保留本地仓位，下一轮重试`);
        // 清除平仓锁，允许下一轮重试
        this._closingLock[symbol] = false;
        // 清除已平仓标记，允许重试
        if (this._closedSymbols) delete this._closedSymbols[symbol];
        return;
      }
      const pnl = result.pnl || 0;
      if (!this._lastCloseTime) this._lastCloseTime = {};
      this._lastCloseTime[symbol] = Date.now();
      // v113.50: 取消全局冷却，只保留单币冷却5分钟
      if (pnl < 0) {
        if (!this._lastCloseTime) this._lastCloseTime = {};
        this._lastCloseTime[symbol] = Date.now() + 5 * 60 * 1000;
        this._log(`🛑 ${symbol} 亏损平仓 $${pnl.toFixed(4)}，该币冷却5分钟`);
      }
      // v99: 保存冷却状态到文件
      this._saveCooldownState();
      // v113.60: 先保存 holdTime 再 delete，避免通知中 holdTime=0
      const _holdTime = this._openTime?.[symbol] ? Date.now() - this._openTime[symbol] : 0;
      delete this._openTime?.[symbol];
      delete this.guardian.positions[symbol];
      this.engineState.totalPnl = (this.engineState.totalPnl || 0) + pnl;
      this.engineState.totalTrades = (this.engineState.totalTrades || 0) + 1;
      if (pnl > 0) this.engineState.wins = (this.engineState.wins || 0) + 1;
      else this.engineState.losses = (this.engineState.losses || 0) + 1;
      this._dailyPnl += pnl;
      // v103: 反馈给 Brain 让它进化
      if (this.brain) {
        const pnlPct = _closeEntryPrice ? (pnl / (_closeEntryPrice * (_closeLeverage||1))) * 100 : 0;
        _closePnlPct = pnlPct;
        this.brain.recordTrade(symbol, pnlPct, pnl > 0);
      }
      // v113: 反馈给 MasterD Agent 让分身进化
      if (this.masterdAgent) {
        this.masterdAgent.recordTrade(symbol, _closePnlPct || 0, pnl > 0, {
          reason,
          side: _closeSide,
          entryPrice: _closeEntryPrice,
          leverage: _closeLeverage,
          modelDecision: this._lastAgentDecisions?.[symbol]?.reasoningChain?.find(s => s.step === 'llm_vote')?.result?.models,
        });
      }
      // v83: 记录平仓PnL到trade-log（含平仓原因）
      const closePrice = this.dataBus.marketData?.[symbol]?.price || 0;
      this._recordTradeClose(symbol, pnl, closePrice, reason, _closeSide, _closeEntryPrice, _closeLeverage);
      // v76: 平仓后记录交易结果用于ML/神经网络在线学习
      const actualDir = pnl > 0 ? 1 : -1;
      // v100: 提取当前K线特征用于神经网络训练
      let closeFactorScores = {};
      try {
        const klines = this.dataBus.klines?.[symbol]?.['1h'] || this.dataBus.klines?.[symbol]?.['5m'];
        if (klines && klines.length >= 50) {
          const indicators = this.dataBus.indicators?.[symbol] || {};
          const nnFeatures = this.strategyManager.strategies.neuralNet?.extractFeatures(klines, indicators);
          if (nnFeatures) closeFactorScores = { nnFeatures };
        }
      } catch(e) {}
      this.strategyManager.recordTradeResult(pnl, 0, actualDir, closeFactorScores);
      // v83: DynamicWeight 自学习 — 用真实PnL调整权重
      const dw2 = this.strategyManager.strategies.dynamicWeight;
      if (dw2) {
        dw2.recordStrategyResult(_closeSide === 'LONG' ? 'multiTimeframe' : 'volatility', pnl);
      }
      // v84: PositionSizer记录盈亏，调整后续仓位
      this.positionSizer.recordTradeResult(pnl);
      // v84c: AdaptiveExitManager记录盈亏，调整连亏统计
      if (this.exitManager) this.exitManager.recordResult(pnl);
      // v64: 发送平仓通知
      if (this.notifier) {
        this.notifier.notifyClosePosition({
          symbol, side: _closeSide,
          entryPrice: _closeEntryPrice, exitPrice: this.dataBus.marketData?.[symbol]?.price || 0,
          pnl, pnlPercent: _closeEntryPrice ? pnl / Math.max(_closeEntryPrice * _closeLeverage, 1) : 0,
          holdTime: _holdTime || 0,
          reason
        });
      }
      if (this._dailyPnl < -5) { this._emergencyStop = true; this._log('🚨 日亏损超限 $-5触发紧急停止'); }
      // v113.50: 连亏5笔不再全局冷却，单币冷却已足够
    } catch(e) { this._log(`平仓失败 ${symbol}: ${e.message}`); }
    finally { this._closingLock[symbol] = false; }
  }

  _checkDailyPnlReset() {
    const todayStart = this._startOfDay();
    if (todayStart > this._dailyPnlResetTime) {
      this._dailyPnl = 0;
      this._dailyPnlResetTime = todayStart;
      this._emergencyStop = false;
    }
  }

  togglePause() { this.paused = !this.paused; return this.paused; }
  // 趋势冲刺已删除
  stopEngine() { this.running = false; this.paused = false; return { running: false }; }
  startEngine() { if (this.running) return { running: true }; this.running = true; this._mainLoop(); return { running: true }; }
  getConfig() { return { maxPositions: 'auto (阶梯式)', leverage: 'auto' }; } // v113.61: 阶梯式动态仓位
  updateConfig(u) { return u; }
  getStatus() {
    return {
      running: this.running, paused: this.paused, cycleCount: this.cycleCount,
      positions: this.guardian.getAllPositions(), positionCount: this.guardian.getPositionCount(),
      state: this.engineState, recentTrades: this.tradeLog.slice(-20),
      timestamp: Date.now()
    };
  }
}

module.exports = Engine;
