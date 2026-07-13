/**
 * AutoFixer — 自动修复引擎
 * 
 * 核心能力:
 * 1. 检测程序错误(API封禁、策略连续亏损、异常崩溃)
 * 2. 分析根因 — 用LLM或规则引擎
 * 3. 生成修复方案 — 代码修改/参数调整/策略替换
 * 4. 验证修复 — 回测验证
 * 5. 热部署 — 写入文件+热重载
 * 6. 回滚机制 — 如果修复后表现更差,自动回退
 * 
 * 这是MasterD Agent"免疫系统" — 自动发现问题并修复
 */

const fs = require('fs');
const path = require('path');
const { hotLoader, adaptiveParams, backtestValidator } = require('./strategy-hot-loader');

class AutoFixer {
  constructor(opts = {}) {
    this.engine = opts.engine || null;
    this.agent = opts.agent || null;      // MasterDAgent引用
    this.llm = opts.llm || null;           // LLM管理器

    this.fixHistory = [];                   // 修复历史
    this.maxHistory = 20;
    this.activeFixes = new Map();           // 正在进行的修复

    // 错误检测规则
    this.detectors = [
      { name: 'api_banned', check: (stats) => this._detectApiBanned(stats) },
      { name: 'consecutive_losses', check: (stats) => this._detectConsecutiveLosses(stats) },
      { name: 'low_winrate', check: (stats) => this._detectLowWinRate(stats) },
      { name: 'excessive_trading', check: (stats) => this._detectExcessiveTrading(stats) },
      { name: 'program_error', check: (stats) => this._detectProgramError(stats) },
      // v113.11.4: 新增检测器
      { name: 'position_heavy_loss', check: (stats) => this._detectPositionHeavyLoss(stats) },
      { name: 'position_too_long', check: (stats) => this._detectPositionTooLong(stats) },
      { name: 'balance_drop', check: (stats) => this._detectBalanceDrop(stats) },
      { name: 'stale_klines', check: (stats) => this._detectStaleKlines(stats) },
      { name: 'ws_disconnected', check: (stats) => this._detectWsDisconnected(stats) },
      { name: 'memory_leak', check: (stats) => this._detectMemoryLeak(stats) },
      { name: 'sub_engine_anomaly', check: (stats) => this._detectSubEngineAnomaly(stats) },
      // v113.68: 用户交易监控 — 之前完全不看用户数据!
      { name: 'user_low_winrate', check: (stats) => this._detectUserLowWinRate(stats) },
      { name: 'user_low_rr', check: (stats) => this._detectUserLowRR(stats) },
    ];

    // 上次检测时间 — 防止过频
    this._lastCheck = 0;
    this._checkInterval = 60000; // 每分钟检测一次

    this.log = (msg) => console.log(`[AutoFixer] ${msg}`);
  }

  /**
   * 绑定引擎和Agent
   */
  attach(engine, agent) {
    this.engine = engine;
    this.agent = agent;
    this.llm = agent?.llm || null;
    this.log(`已绑定 Engine + Agent`);
  }

  /**
   * 主循环 — 定期检测并自动修复
   */
  async runCheck() {
    if (Date.now() - this._lastCheck < this._checkInterval) return;
    this._lastCheck = Date.now();

    // v113.11.2: 主动扫描引擎错误 — 不再依赖被动_pushError
    const engineErrors = this._scanEngineErrors();
    for (const err of engineErrors) {
      this._pushError(err.msg);
      await this._handleIssue(err);
    }

    const stats = this._collectStats();
    if (!stats) return;

    for (const detector of this.detectors) {
      const issue = detector.check(stats);
      if (issue) {
        await this._handleIssue(issue);
      }
    }
  }

  /**
   * 收集引擎状态统计
   */
  _collectStats() {
    if (!this.engine) return null;

    const engineState = this.engine.engineState || {};
    const recentTrades = (this.agent?.memory?.trades || []).slice(-20);
    const positions = this.engine.guardian?.getAllPositions?.() || {};
    const balance = engineState.balance || this.engine.guardian?.balance || 0;

    // v113.11.4: 扩展检测数据
    const positionDetails = [];
    for (const [sym, pos] of Object.entries(positions)) {
      const price = this.engine.dataBus?.marketData?.[sym]?.price || pos.markPrice || 0;
      const isLong = pos.side === 'LONG';
      const pnlPct = isLong
        ? ((price - pos.entryPrice) / (pos.entryPrice || 1)) * 100
        : ((pos.entryPrice - price) / (pos.entryPrice || 1)) * 100;
      const lev = pos.leverage || 1;
      const holdMin = this.engine._openTime?.[sym] ? (Date.now() - this.engine._openTime[sym]) / 60000 : 0;
      positionDetails.push({ symbol: sym, side: pos.side, pnlPct: pnlPct * lev, holdMin, entryPrice: pos.entryPrice, currentPrice: price });
    }

    // K线数据新鲜度
    let staleKlines = [];
    const klines = this.engine.dataBus?.klines || {};
    const klineFreshness = this.engine._klineFreshness || {};
    for (const sym of Object.keys(klines)) {
      const lastFresh = klineFreshness[sym] || 0;
      if (lastFresh > 0 && Date.now() - lastFresh > 300000) staleKlines.push(sym); // 5分钟未刷新
    }

    // WebSocket状态
    let wsConnected = true;
    try {
      const ws = this.engine.dataBus?.ws;
      if (ws && ws.readyState !== undefined && ws.readyState !== 1) wsConnected = false;
    } catch (e) {}

    // 进程内存
    const memUsage = process.memoryUsage();

    return {
      totalPnl: engineState.totalPnl || 0,
      totalTrades: engineState.totalTrades || 0,
      wins: engineState.wins || 0,
      losses: engineState.losses || 0,
      winRate: engineState.totalTrades > 0 ? (engineState.wins || 0) / engineState.totalTrades : 0,
      recentTrades,
      positions,
      positionCount: this.engine.guardian?.getPositionCount?.() || 0,
      positionDetails, // v113.11.4: 持仓详情
      balance, // v113.11.4
      running: this.engine.running,
      paused: this.engine.paused, // v113.11.4
      lastErrors: this._recentErrors,
      staleKlines, // v113.11.4: 过期K线
      wsConnected, // v113.11.4: WebSocket状态
      memUsageMB: memUsage.rss / 1024 / 1024, // v113.11.4: 内存使用
      cycleCount: this.engine.cycleCount || 0, // v113.11.4
      // v113.68: 用户交易数据 — AutoFixer之前完全不看用户数据!
      userStats: this._collectUserStats(),
    };
  }

  // ═══════════════════════════════════════
  // 错误检测器
  // ═══════════════════════════════════════

  /**
   * v113.68: 收集用户交易统计 — 之前AutoFixer完全不看用户数据!
   * 用户交易在 cex-user-trader 里,不在engine里
   */
  _collectUserStats() {
    try {
      const fs = require('fs');
      const tradesPath = path.join(__dirname, '..', 'data', 'cex-user-trades.json');
      if (!fs.existsSync(tradesPath)) return null;
      const trades = JSON.parse(fs.readFileSync(tradesPath, 'utf8'));
      const closes = trades.filter(t => t.action === 'CLOSE');
      if (closes.length < 10) return null;

      let wins = 0, losses = 0, totalPnl = 0;
      const recent = closes.slice(-30);
      let recentWins = 0, recentLosses = 0;

      for (const c of closes) {
        const reason = c.reason || '';
        const m = reason.match(/净[赚亏利]=?\s*([\-\d.]+)%/) || reason.match(/net=([\-\d.]+)%/);
        if (m) {
          const pnl = parseFloat(m[1]);
          if (pnl > 0) wins++; else losses++;
          totalPnl += pnl;
        }
      }
      for (const c of recent) {
        const reason = c.reason || '';
        const m = reason.match(/净[赚亏利]=?\s*([\-\d.]+)%/) || reason.match(/net=([\-\d.]+)%/);
        if (m) {
          const pnl = parseFloat(m[1]);
          if (pnl > 0) recentWins++; else recentLosses++;
        }
      }

      const totalWithPnl = wins + losses;
      const recentWithPnl = recentWins + recentLosses;

      // 计算盈亏比
      const winPnls = closes.filter(c => {
        const m = (c.reason||'').match(/净[赚亏利]=?\s*([\-\d.]+)%/) || (c.reason||'').match(/net=([\-\d.]+)%/);
        return m && parseFloat(m[1]) > 0;
      }).map(c => parseFloat((c.reason.match(/净[赚亏利]=?\s*([\-\d.]+)%/) || c.reason.match(/net=([\-\d.]+)%/))[1]));
      const lossPnls = closes.filter(c => {
        const m = (c.reason||'').match(/净[赚亏利]=?\s*([\-\d.]+)%/) || (c.reason||'').match(/net=([\-\d.]+)%/);
        return m && parseFloat(m[1]) < 0;
      }).map(c => parseFloat((c.reason.match(/净[赚亏利]=?\s*([\-\d.]+)%/) || c.reason.match(/net=([\-\d.]+)%/))[1]));

      const avgWin = winPnls.length > 0 ? winPnls.reduce((a,b)=>a+b,0) / winPnls.length : 0;
      const avgLoss = lossPnls.length > 0 ? Math.abs(lossPnls.reduce((a,b)=>a+b,0) / lossPnls.length) : 0;
      const rr = avgLoss > 0 ? avgWin / avgLoss : 0;

      return {
        totalTrades: closes.length,
        wins, losses,
        winRate: totalWithPnl > 0 ? wins / totalWithPnl : 0,
        recentWinRate: recentWithPnl > 0 ? recentWins / recentWithPnl : 0,
        recentTrades: recent.length,
        avgWin, avgLoss, rr,
        totalPnl,
      };
    } catch (e) {
      return null;
    }
  }

  _recentErrors = [];
  _pushError(msg) {
    this._recentErrors.push({ msg, time: Date.now() });
    if (this._recentErrors.length > 10) this._recentErrors.shift();
  }

  /**
   * v113.11.2: 主动扫描引擎日志 — 不再被动等_pushError
   * 从引擎_log和stderr中提取错误信息
   */
  _scanEngineErrors() {
    const errors = [];

    // 1. 检查RateLimiter熔断状态
    try {
      const { globalLimiter } = require('./rate-limiter');
      // v113.13.4: 封禁过期自动清除
      if (globalLimiter && globalLimiter._banned && Date.now() >= (globalLimiter._bannedUntil || 0)) {
        globalLimiter._banned = false;
        globalLimiter._bannedInfo = null;
        this.log(`✅ IP封禁已过期，清除熔断状态`);
      }
      if (globalLimiter && (globalLimiter._banned || globalLimiter._bannedInfo?.banned)) {
        const until = globalLimiter._bannedUntil || globalLimiter._bannedInfo?.until || 0;
        const waitSec = until ? Math.ceil((until - Date.now()) / 1000) : 0;
        errors.push({
          type: 'api_banned',
          severity: 'high',
          msg: `API封禁中，还需${waitSec}秒解封`,
          rootCause: 'API请求频率超过Binance限制',
        });
      } else if (this.engine?.paused && this._wasBanned) {
        // v113.11.2: API已解封 → 自动恢复引擎
        this._wasBanned = false;
        this.engine.paused = false;
        this.log(`✅ API已解封 — 自动恢复引擎运行`);
        // 恢复子引擎
        const subEngines = this.engine._subEngines || [];
        for (const sub of subEngines) {
          if (sub) sub._paused = false;
        }
      }
      if (globalLimiter && globalLimiter._banned) this._wasBanned = true;
    } catch (e) {}

    // 2. 检查引擎轮次是否在增长(停滞检测)
    if (this.engine) {
      const cycle = this.engine.cycleCount || 0;
      const now = Date.now();
      if (!this._lastCycleCheck) { this._lastCycleCheck = { cycle, time: now }; }
      const elapsed = now - this._lastCycleCheck.time;
      if (elapsed > 300000) { // 5分钟
        if (cycle === this._lastCycleCheck.cycle) {
          errors.push({
            type: 'engine_stalled',
            severity: 'high',
            msg: `引擎轮次5分钟未增长(stuck在${cycle})`,
            rootCause: '可能被错误卡住或API被封',
          });
        }
        this._lastCycleCheck = { cycle, time: now };
      }
    }

    // 3. 检查引擎最后错误
    if (this.engine?._log) {
      // engine用_log输出错误，我们检查engineState中的错误标志
      const state = this.engine.engineState || {};
      if (state.lastError) {
        errors.push({
          type: 'program_error',
          severity: 'medium',
          msg: state.lastError,
          rootCause: '引擎运行错误',
        });
      }
    }

    // 4. 检查Guardian同步失败次数
    if (this.engine?.guardian) {
      const g = this.engine.guardian;
      if (g._syncFailCount && g._syncFailCount > 5) {
        errors.push({
          type: 'api_banned',
          severity: 'high',
          msg: `Guardian同步失败${g._syncFailCount}次`,
          rootCause: 'API封禁或网络问题',
        });
      }
    }

    // 5. v113.11.2: 从引擎状态直接检测API封禁
    if (this.engine) {
      // 检查最近一次扫描是否有-1003错误
      const lastErr = this.engine._lastError || '';
      if (lastErr.includes('-1003') || lastErr.includes('banned')) {
        errors.push({
          type: 'api_banned',
          severity: 'high',
          msg: `引擎报告API封禁: ${lastErr.substring(0, 100)}`,
          rootCause: 'API请求频率超过Binance限制',
        });
      }
    }

    // 6. v113.11.2: 从引擎日志文件检测封禁
    try {
      const fs = require('fs');
      const path = require('path');
      const logFile = path.join(__dirname, '..', 'logs', 'engine.log');
      if (fs.existsSync(logFile)) {
        const stat = fs.statSync(logFile);
        // 只读最近5分钟内修改的日志
        if (Date.now() - stat.mtimeMs < 300000) {
          const content = fs.readFileSync(logFile, 'utf8');
          const last5000 = content.slice(-5000);
          if (last5000.includes('-1003') || last5000.includes('banned until')) {
            errors.push({
              type: 'api_banned',
              severity: 'high',
              msg: '日志检测到API封禁',
              rootCause: 'API请求频率超过Binance限制',
            });
          }
          // 检测程序错误
          if (last5000.includes('TypeError') || last5000.includes('ReferenceError') || last5000.includes('is not a function')) {
            const errMatch = last5000.match(/(TypeError|ReferenceError)[^\n]+/);
            errors.push({
              type: 'program_error',
              severity: 'high',
              msg: errMatch ? errMatch[0] : '检测到程序错误',
              rootCause: '代码bug',
            });
          }
        }
      }
    } catch (e) {}

    return errors;
  }

  _detectApiBanned(stats) {
    // 检查最近是否有API封禁错误
    const recent = this._recentErrors.filter(e => Date.now() - e.time < 300000);
    const bannedErrors = recent.filter(e => e.msg.includes('-1003') || e.msg.includes('banned'));
    if (bannedErrors.length > 3) {
      return {
        type: 'api_banned',
        severity: 'high',
        description: `API被封禁 ${bannedErrors.length} 次(5分钟内)`,
        rootCause: 'API请求频率超过Binance限制',
      };
    }
    return null;
  }

  _detectConsecutiveLosses(stats) {
    const trades = stats.recentTrades;
    if (trades.length < 5) return null;

    let consecLoss = 0;
    for (let i = trades.length - 1; i >= 0; i--) {
      if (!trades[i].isWin) consecLoss++;
      else break;
    }

    if (consecLoss >= 4) {
      return {
        type: 'consecutive_losses',
        severity: 'high',
        description: `${consecLoss}连亏`,
        rootCause: '策略可能不适应当前市场',
        context: { consecLoss, recentTrades: trades.slice(-consecLoss) },
      };
    }
    return null;
  }

  _detectLowWinRate(stats) {
    if (stats.totalTrades < 20) return null;

    if (stats.winRate < 0.35) {
      return {
        type: 'low_winrate',
        severity: 'high',
        description: `总胜率仅${(stats.winRate*100).toFixed(0)}%`,
        rootCause: '策略信号质量差或趋势过滤不足',
        context: { winRate: stats.winRate, totalTrades: stats.totalTrades },
      };
    }
    return null;
  }

  _detectExcessiveTrading(stats) {
    const trades = stats.recentTrades;
    if (trades.length < 10) return null;

    // 10笔交易在30分钟内 = 过度交易
    const last10 = trades.slice(-10);
    if (last10.length === 10) {
      const span = last10[last10.length - 1].timestamp - last10[0].timestamp;
      if (span < 1800000) { // 30分钟
        return {
          type: 'excessive_trading',
          severity: 'medium',
          description: `30分钟内${trades.length}笔交易 — 过度频繁`,
          rootCause: '冷却时间太短或信号过滤太松',
        };
      }
    }
    return null;
  }

  _detectProgramError(stats) {
    const recent = this._recentErrors.filter(e => Date.now() - e.time < 60000);
    const crashErrors = recent.filter(e =>
      e.msg.includes('TypeError') || e.msg.includes('ReferenceError') || e.msg.includes('is not a function')
    );
    if (crashErrors.length > 0) {
      return {
        type: 'program_error',
        severity: 'critical',
        description: crashErrors[0].msg.substring(0, 200),
        rootCause: '代码bug',
      };
    }
    return null;
  }

  // ═══ v113.11.4: 新增检测器 ═══

  /**
   * 检测单仓亏损过大
   */
  _detectPositionHeavyLoss(stats) {
    const positions = stats.positionDetails || [];
    for (const pos of positions) {
      const lossPct = pos.pnlPct;
      if (lossPct < -8) { // 单仓亏损>8%(含杠杆)
        return {
          type: 'position_heavy_loss',
          severity: 'high',
          description: `${pos.symbol} ${pos.side} 亏损${lossPct.toFixed(1)}%`,
          rootCause: '趋势判断错误或止损太晚',
          context: { symbol: pos.symbol, pnlPct: lossPct, side: pos.side },
        };
      }
    }
    return null;
  }

  /**
   * 检测持仓时间过长
   */
  _detectPositionTooLong(stats) {
    const positions = stats.positionDetails || [];
    for (const pos of positions) {
      if (pos.holdMin > 480 && pos.pnlPct < 0) { // >8小时且亏损
        return {
          type: 'position_too_long',
          severity: 'medium',
          description: `${pos.symbol} 持仓${pos.holdMin.toFixed(0)}分钟且亏损${pos.pnlPct.toFixed(1)}%`,
          rootCause: '可能被套牢，需要考虑止损',
          context: { symbol: pos.symbol, holdMin: pos.holdMin, pnlPct: pos.pnlPct },
        };
      }
    }
    return null;
  }

  /**
   * 检测余额异常下降
   */
  _detectBalanceDrop(stats) {
    if (!this._prevBalance) { this._prevBalance = stats.balance; return null; }
    const drop = (this._prevBalance - stats.balance) / this._prevBalance;
    if (drop > 0.1 && this._prevBalance > 10) { // 余额下降>10%
      const result = {
        type: 'balance_drop',
        severity: 'high',
        description: `余额从$${this._prevBalance.toFixed(2)}降到$${stats.balance.toFixed(2)} (-${(drop*100).toFixed(1)}%)`,
        rootCause: '连续亏损或异常交易',
      };
      this._prevBalance = stats.balance;
      return result;
    }
    this._prevBalance = stats.balance;
    return null;
  }

  /**
   * 检测K线数据过期
   */
  _detectStaleKlines(stats) {
    const stale = stats.staleKlines || [];
    if (stale.length >= 3) { // 3个以上品种K线过期
      return {
        type: 'stale_klines',
        severity: 'medium',
        description: `${stale.length}个品种K线数据过期(>5分钟)`,
        rootCause: 'API封禁或网络问题',
        context: { symbols: stale },
      };
    }
    return null;
  }

  /**
   * 检测WebSocket断连
   */
  _detectWsDisconnected(stats) {
    if (stats.wsConnected === false && stats.paused === false) {
      return {
        type: 'ws_disconnected',
        severity: 'medium',
        description: 'WebSocket行情连接断开',
        rootCause: '网络问题或Binance服务异常',
      };
    }
    return null;
  }

  /**
   * 检测内存泄漏
   */
  _detectMemoryLeak(stats) {
    if (!this._memHistory) this._memHistory = [];
    this._memHistory.push(stats.memUsageMB || 0);
    if (this._memHistory.length > 30) this._memHistory.shift(); // 30分钟历史
    if (this._memHistory.length < 10) return null;

    // 内存持续增长(后10分钟均值比前10分钟高50%+)
    const recent10 = this._memHistory.slice(-10).reduce((s, m) => s + m, 0) / 10;
    const early10 = this._memHistory.slice(0, 10).reduce((s, m) => s + m, 0) / 10;
    if (early10 > 50 && recent10 > early10 * 1.5) {
      return {
        type: 'memory_leak',
        severity: 'high',
        description: `内存从${early10.toFixed(0)}MB涨到${recent10.toFixed(0)}MB (+${((recent10/early10-1)*100).toFixed(0)}%)`,
        rootCause: '可能存在内存泄漏',
      };
    }
    return null;
  }

  /**
   * 检测子引擎异常行为(逆趋势做空等)
   */
  _detectSubEngineAnomaly(stats) {
    const positions = stats.positionDetails || [];
    const klines = this.engine?.dataBus?.klines || {};
    for (const pos of positions) {
      const kl = klines[pos.symbol];
      if (!kl || kl.length < 20) continue;
      // 计算MA99
      const closes = kl.slice(-99).map(k => k.close);
      if (closes.length < 50) continue;
      const ma99 = closes.reduce((s, c) => s + c, 0) / closes.length;
      const currentPrice = pos.currentPrice;
      if (!currentPrice || !ma99) continue;

      // 价格在MA99上方(上涨趋势)但做空 = 逆趋势
      if (pos.side === 'SHORT' && currentPrice > ma99 * 1.01) {
        return {
          type: 'sub_engine_anomaly',
          severity: 'medium',
          description: `${pos.symbol} 逆趋势做空(价格${currentPrice.toFixed(4)}>MA99 ${ma99.toFixed(4)})`,
          rootCause: '子引擎没有趋势过滤',
          context: { symbol: pos.symbol, side: pos.side, price: currentPrice, ma99 },
        };
      }
      // 价格在MA99下方(下跌趋势)但做多 = 逆趋势
      if (pos.side === 'LONG' && currentPrice < ma99 * 0.99) {
        return {
          type: 'sub_engine_anomaly',
          severity: 'medium',
          description: `${pos.symbol} 逆趋势做多(价格${currentPrice.toFixed(4)}<MA99 ${ma99.toFixed(4)})`,
          rootCause: '子引擎没有趋势过滤',
          context: { symbol: pos.symbol, side: pos.side, price: currentPrice, ma99 },
        };
      }
    }
    return null;
  }

  /**
   * v113.68: 用户低胜率检测 — 之前AutoFixer只看管理员(engine)的胜率
   * 管理员胜率48%不触发，但用户胜率34.9%已严重亏损!
   */
  _detectUserLowWinRate(stats) {
    const us = stats.userStats;
    if (!us || us.totalTrades < 15) return null;
    // 最近30笔胜率 < 40% 触发
    if (us.recentWinRate < 0.40 && us.recentTrades >= 10) {
      return {
        type: 'user_low_winrate',
        severity: 'high',
        description: `用户最近${us.recentTrades}笔胜率仅${(us.recentWinRate*100).toFixed(0)}% (总${us.totalTrades}笔胜率${(us.winRate*100).toFixed(0)}%)`,
        rootCause: 'AdaptiveExit止盈太早或信号过滤不足',
        context: { winRate: us.winRate, recentWinRate: us.recentWinRate, rr: us.rr, totalTrades: us.totalTrades },
      };
    }
    return null;
  }

  /**
   * v113.68: 用户盈亏比检测 — 盈亏比<1.5需要更高胜率才保本
   */
  _detectUserLowRR(stats) {
    const us = stats.userStats;
    if (!us || us.totalTrades < 15) return null;
    if (us.rr > 0 && us.rr < 1.5) {
      const breakevenWinRate = 1 / (1 + us.rr); // 保本所需胜率
      return {
        type: 'user_low_rr',
        severity: 'high',
        description: `用户盈亏比仅${us.rr.toFixed(2)} (止盈${us.avgWin.toFixed(2)}%/止损${us.avgLoss.toFixed(2)}%) — 保本需胜率${(breakevenWinRate*100).toFixed(0)}%`,
        rootCause: '止盈线≈止损线,盈亏比太低,止盈目标需要提高到2R以上',
        context: { rr: us.rr, avgWin: us.avgWin, avgLoss: us.avgLoss, breakevenWinRate, winRate: us.winRate },
      };
    }
    return null;
  }

  // ═══════════════════════════════════════

  async _handleIssue(issue) {
    // 防止重复修复同一个问题
    const fixKey = `${issue.type}_${Math.floor(Date.now() / 900000)}`; // 15分钟去重 — 避免反复修复同一问题
    if (this.activeFixes.has(fixKey)) return;
    this.activeFixes.set(fixKey, { issue, startTime: Date.now() });

    this.log(`🚨 检测到问题: ${issue.type} — ${issue.description}`);
    this.log(`📋 根因: ${issue.rootCause}`);

    let fixResult = null;

    switch (issue.type) {
      case 'api_banned':
        fixResult = this._fixApiBanned(issue);
        break;
      case 'engine_stalled':
        fixResult = this._fixEngineStalled(issue);
        break;
      case 'consecutive_losses':
        fixResult = await this._fixConsecutiveLosses(issue);
        break;
      case 'low_winrate':
        fixResult = await this._fixLowWinRate(issue);
        break;
      case 'excessive_trading':
        fixResult = this._fixExcessiveTrading(issue);
        break;
      case 'program_error':
        fixResult = await this._fixProgramError(issue);
        break;
      // v113.11.4: 新增修复器
      case 'position_heavy_loss':
        fixResult = this._fixPositionHeavyLoss(issue);
        break;
      case 'position_too_long':
        fixResult = this._fixPositionTooLong(issue);
        break;
      case 'balance_drop':
        fixResult = this._fixBalanceDrop(issue);
        break;
      case 'stale_klines':
        fixResult = this._fixStaleKlines(issue);
        break;
      case 'ws_disconnected':
        fixResult = this._fixWsDisconnected(issue);
        break;
      case 'memory_leak':
        fixResult = this._fixMemoryLeak(issue);
        break;
      case 'sub_engine_anomaly':
        fixResult = this._fixSubEngineAnomaly(issue);
        break;
      // v113.68: 用户交易修复
      case 'user_low_winrate':
        fixResult = this._fixUserLowWinRate(issue);
        break;
      case 'user_low_rr':
        fixResult = this._fixUserLowRR(issue);
        break;
    }

    // 记录修复历史
    if (fixResult) {
      this.fixHistory.push({
        timestamp: Date.now(),
        issue,
        fix: fixResult,
      });
      if (this.fixHistory.length > this.maxHistory) this.fixHistory.shift();

      this.log(`${fixResult.success ? '✅' : '❌'} 修复完成: ${fixResult.description}`);
    }

    // 清理
    setTimeout(() => this.activeFixes.delete(fixKey), 900000); // 15分钟后清除
  }

  /**
   * 修复API封禁 — 降低请求频率
   */
  _fixApiBanned(issue) {
    const fixes = [];
    const params = adaptiveParams.getParams();

    // 1. 延长冷却时间
    adaptiveParams.setParam('cooldownMinutes', Math.min(60, params.cooldownMinutes + 10));
    fixes.push(`冷却→${Math.min(60, params.cooldownMinutes + 10)}min`);

    // 2. v113.11.2: 暂停所有子引擎(FOREX/SymbolEngine/Gold) — 停止疯狂下单
    if (this.engine) {
      // 暂停主引擎扫描
      if (!this.engine.paused) {
        this.engine.paused = true;
        fixes.push('主引擎已暂停');
        this.log(`🛑 主引擎已暂停 — API封禁期间停止所有下单`);
      }

      // 暂停子引擎
      const subEngines = this.engine._subEngines || [];
      for (const sub of subEngines) {
        if (sub && !sub._paused) {
          sub._paused = true;
          fixes.push(`${sub.name || '子引擎'}已暂停`);
        }
      }
    }

    // 3. v113.11.2: 检测哪些引擎在下单过多
    // 读Guardian同步失败次数 — 归零
    if (this.engine?.guardian?._syncFailCount) {
      this.engine.guardian._syncFailCount = 0;
      fixes.push('Guardian失败计数已重置');
    }

    this.log(`🔧 API封禁修复: ${fixes.join(', ')}`);
    return { success: true, description: fixes.join(', '), action: 'pause_and_cooldown' };
  }

  /**
   * 修复引擎停滞 — 检测引擎是否被错误卡住
   */
  _fixEngineStalled(issue) {
    this.log(`🔧 引擎停滞修复: ${issue.msg}`);
    const fixes = [];

    if (this.engine) {
      // 1. 检查是否被catch吃掉的错误卡住
      if (issue.rootCause.includes('API')) {
        // API封禁导致的停滞 → 暂停引擎等解封
        this.engine.paused = true;
        fixes.push('引擎已暂停(等待API解封)');
      } else {
        // 未知错误导致的停滞 → 重置错误状态
        this.engine._emergencyStop = false;
        fixes.push('紧急停止已重置');
      }

      // 2. 检查冷却状态是否错误
      if (this.engine._globalCooldownUntil && this.engine._globalCooldownUntil > Date.now() + 7200000) {
        // 全局冷却超过1小时 → 可能是bug，重置
        this.engine._globalCooldownUntil = 0;
        fixes.push('全局冷却已重置(异常值)');
      }
    }

    this.log(`🔧 停滞修复完成: ${fixes.join(', ')}`);
    return { success: true, description: fixes.join(', '), action: 'fix_stall' };
  }

  /**
   * 修复连续亏损 — LLM分析根因+调整策略
   */
  async _fixConsecutiveLosses(issue) {
    this.log(`🔧 连亏修复: 分析亏损交易...`);

    const losingTrades = issue.context?.recentTrades || [];
    if (losingTrades.length === 0) {
      // 没有详细数据,调参数
      const result = adaptiveParams.applyReflection({
        winRate: 0.2,
        avgPnl: -2,
        maxConsecLoss: issue.context?.consecLoss || 4,
        lessons: ['连亏触发自动调参'],
      });
      return { success: true, description: '自适应调参(连亏)', action: 'adjust_params', details: result.changes };
    }

    // 用LLM分析亏损原因
    if (this.llm && this.llm.getAvailableModels().length > 0) {
      try {
        const analysis = await this.llm.ask(
          '你是量化交易策略分析专家。分析以下亏损交易,找出策略的系统性问题,给出具体修复建议。',
          `亏损交易:\n${JSON.stringify(losingTrades.map(t => ({
            symbol: t.symbol, pnl: t.pnlPct, direction: t.direction,
            reasons: t.reasons?.slice(0, 100), entryPrice: t.entryPrice,
          })), null, 2)}\n\n分析问题并给出修复建议(止损/止盈/信号过滤/趋势判断):`,
          null
        );

        if (analysis) {
          this.log(`🧠 LLM分析: ${analysis.substring(0, 200)}`);

          // 根据LLM建议调整参数
          const result = adaptiveParams.applyReflection({
            winRate: 0.2,
            avgPnl: -2,
            maxConsecLoss: issue.context?.consecLoss || 4,
            lessons: [analysis.substring(0, 100)],
          });

          return {
            success: true,
            description: 'LLM分析+自适应调参(连亏)',
            action: 'llm_analyze_and_adjust',
            llmAnalysis: analysis.substring(0, 500),
            paramChanges: result.changes,
          };
        }
      } catch (e) {
        this.log(`LLM分析失败: ${e.message}`);
      }
    }

    // LLM不可用,用规则调参
    const result = adaptiveParams.applyReflection({
      winRate: 0.2, avgPnl: -2, maxConsecLoss: issue.context?.consecLoss || 4, lessons: [],
    });
    return { success: true, description: '规则调参(连亏)', action: 'adjust_params', details: result.changes };
  }

  /**
   * 修复低胜率 — 生成新策略+回测验证+热加载
   */
  async _fixLowWinRate(issue) {
    this.log(`🔧 低胜率修复: 尝试生成新策略...`);

    // 1. 提高信号门槛
    adaptiveParams.setParam('confidenceThreshold', 0.8);
    adaptiveParams.setParam('minSignalStrength', 2.5);

    // 2. 让Agent生成新策略
    if (this.agent && this.llm && this.llm.getAvailableModels().length > 0) {
      try {
        this.log(`🧠 让Agent生成新策略...`);
        const strategyRecord = await this.agent.generateStrategy(
          '趋势跟踪+RSI组合策略,需要强趋势确认才开仓,RSI做入场时机优化,止损5%止盈10%,盈亏比2:1',
          { performance: { winRate: issue.context?.winRate, totalTrades: issue.context?.totalTrades } }
        );

        if (strategyRecord && strategyRecord.code) {
          this.log(`📝 策略已生成,准备回测验证...`);

          // 3. 获取K线数据回测
          const klines = this.engine?.klines?.['BTCUSDT'] || [];
          if (klines.length > 50) {
            const validation = await backtestValidator.validate(
              `auto_fix_${Date.now()}`,
              strategyRecord.code,
              klines
            );

            if (validation.pass) {
              this.log(`✅ 回测通过 — 热加载策略`);
              // 4. 回测通过 → 热加载
              const loadResult = await hotLoader.loadStrategy(
                `auto_fix_${Date.now()}`,
                strategyRecord.code,
                { weight: 0.2 }
              );

              return {
                success: true,
                description: '生成新策略+回测通过+热加载',
                action: 'generate_and_load_strategy',
                strategyId: strategyRecord.id,
                backtest: validation,
                loaded: loadResult.success,
              };
            } else {
              this.log(`❌ 回测不通过 — 不加载: ${validation.error || `胜率${(validation.winRate*100).toFixed(0)}%`}`);
              return {
                success: true,
                description: '生成新策略但回测不通过,仅提高门槛',
                action: 'raise_threshold',
                backtest: validation,
              };
            }
          }
        }
      } catch (e) {
        this.log(`LLM策略生成失败: ${e.message}`);
      }
    }

    return { success: true, description: '提高信号门槛(低胜率)', action: 'raise_threshold' };
  }

  /**
   * v114: 修复用户低胜率 — 只调信号门槛, 不动止盈止损参数
   * 止盈止损由 AdaptiveExitManager v114 统一管理, AutoFixer不介入
   */
  _fixUserLowWinRate(issue) {
    this.log(`🔧 用户低胜率: ${issue.description}`);
    const fixes = [];

    // 只提高信号门槛
    try {
      adaptiveParams.setParam('confidenceThreshold', 0.50);
      adaptiveParams.setParam('minSignalStrength', 3.0);
      fixes.push('信号门槛: conf≥0.50 str≥3.0');
    } catch (e) {}

    return {
      success: true,
      description: `用户低胜率: ${fixes.join(', ')}`,
      action: 'raise_signal_threshold',
    };
  }

  /**
   * v114: 修复用户低盈亏比 — 只记录状态, 不修改止盈止损参数
   * 止盈止损由 AdaptiveExitManager v114 统一管理
   */
  _fixUserLowRR(issue) {
    this.log(`🔧 用户低盈亏比: ${issue.description}`);
    // v114: 不再修改参数, 止盈止损由 v114 引擎统一管理
    return {
      success: true,
      description: '盈亏比由v114引擎统一管理, AutoFixer不介入',
      action: 'no_action',
    };
  }

  /**
   * 修复过度交易 — 延长冷却+提高门槛
   */
  _fixExcessiveTrading(issue) {
    const params = adaptiveParams.getParams();
    adaptiveParams.setParam('cooldownMinutes', Math.min(60, params.cooldownMinutes + 15));
    adaptiveParams.setParam('minSignalStrength', Math.min(3.0, params.minSignalStrength + 0.5));
    this.log(`🔧 过度交易修复: 冷却→${params.cooldownMinutes + 15}min, 门槛→${Math.min(3.0, params.minSignalStrength + 0.5)}`);
    return { success: true, description: '延长冷却+提高门槛', action: 'increase_cooldown_threshold' };
  }

  /**
   * 修复程序错误 — LLM分析+生成修复代码
   */
  async _fixProgramError(issue) {
    this.log(`🔧 程序错误修复: ${issue.description.substring(0, 100)}`);

    if (this.llm && this.llm.getAvailableModels().length > 0) {
      try {
        const analysis = await this.llm.ask(
          '你是Node.js调试专家。分析以下错误,给出可能的修复方案(不要直接改文件,只给建议):',
          `错误: ${issue.description}\n\n分析根因和修复方案:`,
          null
        );
        this.log(`🧠 LLM分析: ${analysis?.substring(0, 300)}`);
        return {
          success: true,
          description: 'LLM分析程序错误',
          action: 'llm_analyze_error',
          analysis: analysis?.substring(0, 500),
        };
      } catch (e) {
        this.log(`LLM分析失败: ${e.message}`);
      }
    }

    return { success: false, description: 'LLM不可用,无法自动分析', action: 'no_llm' };
  }

  // ═══ v113.11.4: 新增修复器 ═══

  /**
   * 修复单仓重损 — 强制止损+加强风控
   */
  _fixPositionHeavyLoss(issue) {
    const sym = issue.context?.symbol;
    this.log(`🔧 单仓重损修复: ${sym} ${issue.description}`);
    const fixes = [];

    // 1. 如果引擎可控制,立即平掉亏损仓位
    if (this.engine && sym && this.engine._executeClose) {
      try {
        this.engine._executeClose(sym, `AutoFixer: 单仓亏损${issue.context?.pnlPct?.toFixed(1)}% 自动止损`);
        fixes.push(`${sym}已强制平仓`);
      } catch (e) { fixes.push(`平仓失败: ${e.message}`); }
    }

    // 2. 提高止损参数
    const params = adaptiveParams.getParams();
    adaptiveParams.setParam('stopLossPct', Math.max(2, params.stopLossPct - 1));
    fixes.push(`止损收紧→${Math.max(2, params.stopLossPct - 1)}%`);

    this.log(`✅ 重损修复: ${fixes.join(', ')}`);
    return { success: true, description: fixes.join(', '), action: 'force_close_and_tighten_sl' };
  }

  /**
   * 修复持仓过长 — 平掉亏损长持
   */
  _fixPositionTooLong(issue) {
    const sym = issue.context?.symbol;
    this.log(`🔧 持仓过长修复: ${sym} 持仓${issue.context?.holdMin?.toFixed(0)}分钟亏损${issue.context?.pnlPct?.toFixed(1)}%`);

    if (this.engine && sym && this.engine._executeClose) {
      try {
        this.engine._executeClose(sym, `AutoFixer: 持仓${issue.context?.holdMin?.toFixed(0)}min超时平仓`);
        return { success: true, description: `${sym}超时平仓`, action: 'timeout_close' };
      } catch (e) { return { success: false, description: `平仓失败: ${e.message}`, action: 'close_failed' }; }
    }
    return { success: false, description: '无法执行平仓', action: 'no_close' };
  }

  /**
   * 修复余额下降 — 降低风险+暂停开新仓
   */
  _fixBalanceDrop(issue) {
    this.log(`🔧 余额下降修复: ${issue.description}`);
    const fixes = [];
    const params = adaptiveParams.getParams();

    // 1. 降低杠杆
    adaptiveParams.setParam('maxLeverage', Math.max(1, params.maxLeverage - 1));
    fixes.push(`杠杆→${Math.max(1, params.maxLeverage - 1)}x`);

    // 2. 提高门槛
    adaptiveParams.setParam('confidenceThreshold', Math.min(0.85, params.confidenceThreshold + 0.1));
    fixes.push(`门槛→${Math.min(0.85, params.confidenceThreshold + 0.1)}`);

    // 3. 延长冷却
    adaptiveParams.setParam('cooldownMinutes', Math.min(60, params.cooldownMinutes + 15));
    fixes.push(`冷却→${Math.min(60, params.cooldownMinutes + 15)}min`);

    this.log(`✅ 余额下降修复: ${fixes.join(', ')}`);
    return { success: true, description: fixes.join(', '), action: 'reduce_risk' };
  }

  /**
   * 修复K线过期 — 强制刷新
   */
  _fixStaleKlines(issue) {
    const symbols = issue.context?.symbols || [];
    this.log(`🔧 K线过期修复: ${symbols.join(', ')}`);

    if (this.engine && symbols.length > 0) {
      for (const sym of symbols) {
        if (this.engine._forceRefreshKlines) {
          try { this.engine._forceRefreshKlines(sym); }
          catch (e) {}
        }
      }
      return { success: true, description: `强制刷新${symbols.length}个品种K线`, action: 'refresh_klines' };
    }
    return { success: false, description: '无法刷新K线', action: 'no_refresh' };
  }

  /**
   * 修复WebSocket断连 — 重连
   */
  _fixWsDisconnected(issue) {
    this.log(`🔧 WebSocket断连修复: 重新连接`);

    if (this.engine?.dataBus?.reconnect) {
      try { this.engine.dataBus.reconnect(); return { success: true, description: 'WebSocket重连', action: 'ws_reconnect' }; }
      catch (e) { return { success: false, description: `重连失败: ${e.message}`, action: 'reconnect_failed' }; }
    }
    // 尝试重新初始化
    if (this.engine?.dataBus?.fetchAllTickers) {
      try {
        this.engine.dataBus.fetchAllTickers(Object.keys(this.engine.dataBus.marketData || {}));
        return { success: true, description: 'HTTP行情刷新(WS降级)', action: 'http_fallback' };
      } catch (e) {}
    }
    return { success: false, description: '无法重连', action: 'no_reconnect' };
  }

  /**
   * 修复内存泄漏 — 记录+警告
   */
  _fixMemoryLeak(issue) {
    this.log(`🔧 内存泄漏检测: ${issue.description}`);
    // 内存泄漏无法自动修复,但可以清理缓存
    if (this.agent?.memory?.trades) {
      const trades = this.agent.memory.trades;
      if (trades.length > 100) trades.splice(0, trades.length - 100);
    }
    if (this.agent?.reasoningChains) {
      const chains = this.agent.reasoningChains;
      if (chains.length > 50) chains.splice(0, chains.length - 50);
    }
    // 清理日志缓存
    this._recentErrors = this._recentErrors.slice(-5);
    this._memHistory = this._memHistory.slice(-15);
    return { success: true, description: '已清理缓存+交易历史', action: 'clear_cache' };
  }

  /**
   * 修复子引擎逆趋势 — 平仓+暂停该引擎
   */
  _fixSubEngineAnomaly(issue) {
    const sym = issue.context?.symbol;
    this.log(`🔧 子引擎异常修复: ${sym} ${issue.description}`);
    const fixes = [];

    // 1. 平掉逆趋势仓位
    if (this.engine && sym && this.engine._executeClose) {
      try {
        this.engine._executeClose(sym, `AutoFixer: 逆趋势持仓自动平仓`);
        fixes.push(`${sym}已平仓`);
      } catch (e) { fixes.push(`平仓失败`); }
    }

    // 2. v113.67: 将该币种加入配对交易黑名单 — 阻止配对交易重新开仓
    if (this.engine?._pairsIntegration) {
      this.engine._pairsIntegration.blacklistSymbol(sym, `AutoFixer逆趋势平仓: ${issue.description}`, 4 * 3600 * 1000);
      fixes.push(`${sym}已加入配对交易黑名单4h`);
    }

    // 3. 找到并暂停产生该仓位的子引擎
    const subEngines = this.engine?._subEngines || [];
    for (const sub of subEngines) {
      if (sub?.positions?.[sym]) {
        sub._paused = true;
        fixes.push(`${sub.name || '子引擎'}已暂停`);
        // 延时恢复
        setTimeout(() => { if (sub) sub._paused = false; }, 3600000); // 1小时后恢复
        break;
      }
    }

    this.log(`✅ 子引擎修复: ${fixes.join(', ')}`);
    return { success: true, description: fixes.join(', '), action: 'close_and_pause_sub' };
  }

  /**
   * 获取修复历史
   */
  getHistory() {
    return this.fixHistory.slice(-10).map(h => ({
      time: h.timestamp,
      issue: h.issue.type,
      description: h.issue.description,
      fix: h.fix.description,
      success: h.fix.success,
    }));
  }

  /**
   * 获取状态
   */
  getStatus() {
    return {
      activeFixes: [...this.activeFixes.keys()],
      totalFixes: this.fixHistory.length,
      recentFixes: this.getHistory(),
      adaptiveParams: adaptiveParams.getParams(),
      hotLoadedStrategies: hotLoader.getStatus(),
    };
  }
}

// 全局实例
const autoFixer = new AutoFixer();

module.exports = { AutoFixer, autoFixer, hotLoader, adaptiveParams, backtestValidator };
