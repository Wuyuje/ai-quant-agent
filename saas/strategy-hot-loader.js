/**
 * StrategyHotLoader — 策略热加载器
 * 
 * 核心功能:
 * 1. LLM生成的策略代码 → 写入文件 → require重新加载 → 注入StrategyManager
 * 2. 参数自适应修改 → 写入参数文件 → 热更新
 * 3. 回滚机制 — 如果新策略表现差,自动回退
 * 
 * 这是MasterD Agent"手"的实现 — 让它不仅能想,还能执行修改
 */

const fs = require('fs');
const path = require('path');

const STRATEGY_DIR = path.join(__dirname, '..', 'saas', 'strategies');
const GENERATED_DIR = path.join(STRATEGY_DIR, 'generated');
const PARAMS_FILE = path.join(__dirname, '..', 'data', 'adaptive-params.json');

// 确保generated目录存在
if (!fs.existsSync(GENERATED_DIR)) {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
}

class StrategyHotLoader {
  constructor() {
    this.loadedStrategies = new Map(); // name → {instance, file, loadTime, performance}
    this.strategyManager = null;
    this.maxStrategies = 5; // 最多同时5个热加载策略
    this.log = (msg) => console.log(`[HotLoader] ${msg}`);
  }

  /**
   * 注入StrategyManager引用
   */
  attach(strategyManager) {
    this.strategyManager = strategyManager;
    this.log(`已绑定StrategyManager`);
  }

  /**
   * 写入策略代码到文件
   */
  _writeStrategyFile(name, code) {
    const filePath = path.join(GENERATED_DIR, `${name}.js`);
    // 加上模块导出
    if (!code.includes('module.exports')) {
      code = code + '\n\nmodule.exports = ' + this._extractClassName(code) + ';\n';
    }
    fs.writeFileSync(filePath, code);
    return filePath;
  }

  /**
   * 从代码中提取类名
   */
  _extractClassName(code) {
    const match = code.match(/class\s+(\w+)/);
    return match ? match[1] : 'AutoStrategy';
  }

  /**
   * 热加载策略 — 核心方法
   * @param {string} name - 策略名
   * @param {string} code - JS代码
   * @param {object} options - { skipValidation, weight }
   * @returns {object} { success, name, file, error }
   */
  async loadStrategy(name, code, options = {}) {
    this.log(`🔥 热加载策略: ${name}`);

    try {
      // 1. 写入文件
      const filePath = this._writeStrategyFile(name, code);
      this.log(`📄 代码已写入: ${filePath}`);

      // 2. 语法检查
      const checkResult = await this._syntaxCheck(filePath);
      if (!checkResult.ok) {
        this.log(`❌ 语法错误: ${checkResult.error}`);
        return { success: false, name, error: checkResult.error };
      }

      // 3. 清除require缓存,重新加载
      const fullPath = require.resolve(filePath);
      delete require.cache[fullPath];
      const StrategyClass = require(filePath);
      this.log(`✅ 模块加载成功: ${StrategyClass.name}`);

      // 4. 实例化
      const instance = new StrategyClass();

      // 5. 验证接口 — 必须有analyze方法
      if (typeof instance.analyze !== 'function') {
        this.log(`❌ 策略缺少analyze方法`);
        return { success: false, name, error: 'Missing analyze() method' };
      }

      // 6. 注入StrategyManager
      if (this.strategyManager) {
        const strategyKey = `hot_${name}`;
        this.strategyManager.strategies[strategyKey] = instance;
        this.log(`🧬 已注入StrategyManager: ${strategyKey}`);
      }

      // 7. 记录
      this.loadedStrategies.set(name, {
        instance,
        file: filePath,
        loadTime: Date.now(),
        performance: { trades: 0, wins: 0, pnl: 0 },
        weight: options.weight || 0.15,
      });

      // 8. 控制数量 — 超出就移除最老的
      if (this.loadedStrategies.size > this.maxStrategies) {
        const oldestKey = [...this.loadedStrategies.keys()][0];
        this.unloadStrategy(oldestKey);
      }

      this.log(`✅ 策略 "${name}" 热加载完成`);
      return { success: true, name, file: filePath };

    } catch (e) {
      this.log(`❌ 热加载失败: ${e.message}`);
      return { success: false, name, error: e.message };
    }
  }

  /**
   * 卸载策略
   */
  unloadStrategy(name) {
    const info = this.loadedStrategies.get(name);
    if (!info) return;

    // 从StrategyManager移除
    if (this.strategyManager) {
      delete this.strategyManager.strategies[`hot_${name}`];
    }

    // 删除文件
    try { fs.unlinkSync(info.file); } catch (e) {}

    this.loadedStrategies.delete(name);
    this.log(`🗑️ 策略 "${name}" 已卸载`);
  }

  /**
   * 语法检查
   */
  async _syntaxCheck(filePath) {
    const { execSync } = require('child_process');
    try {
      execSync(`node -c "${filePath}"`, { stdio: 'pipe', timeout: 5000 });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.stderr?.toString() || e.message };
    }
  }

  /**
   * 记录策略表现 — 用于回滚判断
   */
  recordPerformance(name, isWin, pnlPct) {
    const info = this.loadedStrategies.get(name);
    if (!info) return;

    info.performance.trades++;
    if (isWin) info.performance.wins++;
    info.performance.pnl += pnlPct || 0;

    // 10笔后评估 — 胜率<30%且亏损→自动回滚
    if (info.performance.trades >= 10) {
      const winRate = info.performance.wins / info.performance.trades;
      if (winRate < 0.3 && info.performance.pnl < 0) {
        this.log(`⚠️ 策略 "${name}" 表现差(胜率${(winRate*100).toFixed(0)}%, PnL=${info.performance.pnl.toFixed(2)}%) — 自动回滚`);
        this.unloadStrategy(name);
        return { rolledBack: true };
      }
    }
    return { rolledBack: false };
  }

  /**
   * 获取所有热加载策略状态
   */
  getStatus() {
    const strategies = [];
    for (const [name, info] of this.loadedStrategies) {
      strategies.push({
        name,
        file: info.file,
        loadTime: info.loadTime,
        weight: info.weight,
        performance: {
          trades: info.performance.trades,
          wins: info.performance.wins,
          winRate: info.performance.trades > 0 ? (info.performance.wins / info.performance.trades) : 0,
          pnl: info.performance.pnl,
        },
      });
    }
    return { strategies, maxStrategies: this.maxStrategies };
  }
}

// ═══════════════════════════════════════════
// 参数自适应 — 反思结论自动改策略参数
// ═══════════════════════════════════════════

class AdaptiveParams {
  constructor() {
    this.params = this._load();
    this.log = (msg) => console.log(`[AdaptiveParams] ${msg}`);
  }

  _load() {
    try {
      return JSON.parse(fs.readFileSync(PARAMS_FILE, 'utf8'));
    } catch (e) {
      // 默认参数
      return {
        stopLossPct: 3.0,
        takeProfitPct: 5.0,
        confidenceThreshold: 0.7,
        maxLeverage: 3,
        minSignalStrength: 2.0,
        ma99FilterEnabled: true,
        bounceFilterPct: 50,
        cooldownMinutes: 5,
        lossCooldownMinutes: 15,
        version: 1,
        lastUpdated: Date.now(),
        history: [], // 参数变更历史
      };
    }
  }

  _save() {
    this.params.lastUpdated = Date.now();
    fs.writeFileSync(PARAMS_FILE, JSON.stringify(this.params, null, 2));
  }

  /**
   * 应用反思结论 — 自动调参
   * @param {object} reflection - _selfReflect的输出
   */
  applyReflection(reflection) {
    const changes = [];
    const { winRate, avgPnl, maxConsecLoss, lessons } = reflection;

    // 胜率低 → 提高门槛
    if (winRate < 0.4) {
      const old = this.params.confidenceThreshold;
      this.params.confidenceThreshold = Math.min(0.85, old + 0.05);
      if (this.params.confidenceThreshold !== old) {
        changes.push(`confidenceThreshold: ${old.toFixed(2)}→${this.params.confidenceThreshold.toFixed(2)}`);
      }
      // 止损放宽一点 — 给交易更多空间
      const oldSL = this.params.stopLossPct;
      this.params.stopLossPct = Math.min(6.0, old + 0.5);
      if (this.params.stopLossPct !== oldSL) {
        changes.push(`stopLossPct: ${oldSL.toFixed(1)}→${this.params.stopLossPct.toFixed(1)}%`);
      }
    } else if (winRate > 0.65) {
      // 胜率高 → 适当降低门槛
      const old = this.params.confidenceThreshold;
      this.params.confidenceThreshold = Math.max(0.5, old - 0.03);
      if (this.params.confidenceThreshold !== old) {
        changes.push(`confidenceThreshold: ${old.toFixed(2)}→${this.params.confidenceThreshold.toFixed(2)}`);
      }
    }

    // 平均亏损 → 加大止损 + 降杠杆
    if (avgPnl < -1) {
      const oldSL = this.params.stopLossPct;
      this.params.stopLossPct = Math.min(6.0, oldSL + 1.0);
      if (this.params.stopLossPct !== oldSL) {
        changes.push(`stopLossPct: ${oldSL.toFixed(1)}→${this.params.stopLossPct.toFixed(1)}% (亏损加大止损)`);
      }
      // 止盈也加大 — 让盈亏比更大
      const oldTP = this.params.takeProfitPct;
      this.params.takeProfitPct = Math.min(10.0, oldTP + 1.0);
      if (this.params.takeProfitPct !== oldTP) {
        changes.push(`takeProfitPct: ${oldTP.toFixed(1)}→${this.params.takeProfitPct.toFixed(1)}% (加大止盈)`);
      }
    }

    // 连亏 → 延长冷却
    if (maxConsecLoss >= 3) {
      const old = this.params.lossCooldownMinutes;
      this.params.lossCooldownMinutes = Math.min(20, old + 5);
      if (this.params.lossCooldownMinutes !== old) {
        changes.push(`lossCooldownMinutes: ${old}→${this.params.lossCooldownMinutes} (连亏延长冷却)`);
      }
    }

    // 记录变更历史
    if (changes.length > 0) {
      this.params.version++;
      this.params.history.push({
        timestamp: Date.now(),
        version: this.params.version,
        changes,
        context: { winRate, avgPnl, maxConsecLoss },
      });
      if (this.params.history.length > 50) this.params.history.shift();
      this._save();
      this.log(`🔧 自适应调参 v${this.params.version}: ${changes.join(', ')}`);
      return { changed: true, changes, version: this.params.version };
    }

    return { changed: false, changes: [] };
  }

  /**
   * 获取当前参数
   */
  getParams() {
    return { ...this.params };
  }

  /**
   * 手动设置参数
   */
  setParam(key, value) {
    const old = this.params[key];
    this.params[key] = value;
    this.params.version++;
    this.params.history.push({
      timestamp: Date.now(),
      version: this.params.version,
      changes: [`${key}: ${old}→${value}`],
      context: { manual: true },
    });
    this._save();
    this.log(`🔧 手动调参: ${key}=${value}`);
    return { old, new: value };
  }

  /**
   * 回滚到上一版参数
   */
  rollback() {
    if (this.params.history.length < 2) return { success: false, reason: 'no history' };

    // 找到上一版的参数
    const prev = this.params.history[this.params.history.length - 2];
    // 回滚版本号
    this.params.version = prev.version;
    // 从历史中重建参数
    // 简单实现: 回退最近的变更
    const lastChange = this.params.history[this.params.history.length - 1];
    for (const change of lastChange.changes) {
      const match = change.match(/(\w+):\s*([\d.]+)→([\d.]+)/);
      if (match) {
        const [, key, oldVal] = match;
        this.params[key] = parseFloat(oldVal);
      }
    }
    this.params.history.pop();
    this._save();
    this.log(`↩️ 参数回滚到 v${prev.version}`);
    return { success: true, version: prev.version };
  }
}

// ═══════════════════════════════════════════
// 回测验证器 — 改前回测,赢了部署,输了回滚
// ═══════════════════════════════════════════

class BacktestValidator {
  constructor() {
    this.log = (msg) => console.log(`[Backtest] ${msg}`);
    this.minTrades = 20; // 最少20笔交易才有统计意义
    this.minWinRate = 0.45; // 最低45%胜率才通过
    this.maxMaxDrawdown = 15; // 最大回撤不超过15%
  }

  /**
   * 回测策略 — 用历史K线数据跑策略
   * @param {object} strategyInstance - 策略实例
   * @param {array} klines - 历史K线
   * @returns {object} { pass, winRate, avgPnl, maxDrawdown, trades, details }
   */
  async backtest(strategyInstance, klines) {
    if (!klines || klines.length < 50) {
      return { pass: false, error: 'insufficient data' };
    }

    this.log(`📊 回测开始 — ${klines.length}根K线`);

    let position = null;
    let totalPnl = 0;
    let wins = 0;
    let trades = 0;
    let peak = 0;
    let maxDrawdown = 0;
    const tradeLog = [];

    // 模拟交易 — 滑动窗口
    const windowSize = 60; // 用60根K线做分析窗口
    const takeProfitPct = 5;
    const stopLossPct = 3;

    for (let i = windowSize; i < klines.length; i++) {
      const window = klines.slice(i - windowSize, i + 1);
      const currentPrice = parseFloat(window[window.length - 1].close);

      // 如果有持仓,检查止盈止损
      if (position) {
        const pnlPct = position.direction === 'LONG'
          ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100
          : ((position.entryPrice - currentPrice) / position.entryPrice) * 100;

        if (pnlPct >= takeProfitPct || pnlPct <= -stopLossPct || i - position.entryIdx >= 50) {
          const pnl = pnlPct;
          totalPnl += pnl;
          trades++;
          if (pnl > 0) wins++;
          peak = Math.max(peak, totalPnl);
          maxDrawdown = Math.max(maxDrawdown, peak - totalPnl);
          tradeLog.push({ entry: position.entryPrice, exit: currentPrice, direction: position.direction, pnl: pnlPct });
          position = null;
        }
      }

      // 如果空仓,运行策略
      if (!position && typeof strategyInstance.analyze === 'function') {
        try {
          const result = strategyInstance.analyze(window, {});
          if (result && (result.direction === 'LONG' || result.direction === 'SHORT') && result.score > 0) {
            position = {
              direction: result.direction,
              entryPrice: currentPrice,
              entryIdx: i,
            };
          }
        } catch (e) {
          // 策略可能抛错,继续
        }
      }
    }

    // 平掉最后的持仓
    if (position) {
      const lastPrice = parseFloat(klines[klines.length - 1].close);
      const pnlPct = position.direction === 'LONG'
        ? ((lastPrice - position.entryPrice) / position.entryPrice) * 100
        : ((position.entryPrice - lastPrice) / position.entryPrice) * 100;
      totalPnl += pnlPct;
      trades++;
      if (pnlPct > 0) wins++;
    }

    const winRate = trades > 0 ? wins / trades : 0;
    const avgPnl = trades > 0 ? totalPnl / trades : 0;

    const pass = trades >= this.minTrades && winRate >= this.minWinRate && maxDrawdown <= this.maxMaxDrawdown;

    this.log(`📊 回测结果: ${trades}笔 胜率=${(winRate*100).toFixed(0)}% 平均=${avgPnl.toFixed(2)}% 回撤=${maxDrawdown.toFixed(2)}% ${pass ? '✅通过' : '❌不通过'}`);

    return {
      pass,
      winRate,
      avgPnl,
      maxDrawdown,
      trades,
      totalPnl,
      details: tradeLog.slice(-10),
    };
  }

  /**
   * 验证新策略 — 回测通过才允许加载
   */
  async validate(name, code, klines) {
    this.log(`🔍 验证新策略: ${name}`);

    // 1. 语法检查
    const tmpFile = path.join(GENERATED_DIR, `_tmp_${name}.js`);
    let StrategyClass;
    try {
      if (!code.includes('module.exports')) {
        const className = code.match(/class\s+(\w+)/)?.[1] || 'AutoStrategy';
        code = code + '\n\nmodule.exports = ' + className + ';\n';
      }
      fs.writeFileSync(tmpFile, code);
      const { execSync } = require('child_process');
      execSync(`node -c "${tmpFile}"`, { stdio: 'pipe', timeout: 5000 });

      // 加载
      delete require.cache[require.resolve(tmpFile)];
      StrategyClass = require(tmpFile);
    } catch (e) {
      try { fs.unlinkSync(tmpFile); } catch (e2) {}
      return { pass: false, error: `syntax error: ${e.message}` };
    }

    // 2. 实例化
    let instance;
    try {
      instance = new StrategyClass();
    } catch (e) {
      try { fs.unlinkSync(tmpFile); } catch (e2) {}
      return { pass: false, error: `instantiation error: ${e.message}` };
    }

    // 3. 接口检查
    if (typeof instance.analyze !== 'function') {
      try { fs.unlinkSync(tmpFile); } catch (e2) {}
      return { pass: false, error: 'missing analyze() method' };
    }

    // 4. 回测
    const result = await this.backtest(instance, klines);

    // 5. 清理临时文件
    try { fs.unlinkSync(tmpFile); } catch (e) {}

    return result;
  }
}

// ═══════════════════════════════════════════
// 导出
// ═══════════════════════════════════════════

const hotLoader = new StrategyHotLoader();
const adaptiveParams = new AdaptiveParams();
const backtestValidator = new BacktestValidator();

module.exports = {
  StrategyHotLoader,
  AdaptiveParams,
  BacktestValidator,
  hotLoader,
  adaptiveParams,
  backtestValidator,
  GENERATED_DIR,
  PARAMS_FILE,
};
