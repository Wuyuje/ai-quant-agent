/**
 * UserEngine — 单用户独立引擎
 * 
 * 每个用户独立运行：
 * - 独立 Trader（用自己的 API Key 或子账户）
 * - 独立 Guardian（资金隔离）
 * - 独立 AIDecisionEngine（个性化决策）
 * - 共享 DataBus（行情数据）
 * - 共享 DeepSeekBrain（聚合进化）
 */

const fs = require('fs');
const path = require('path');
const DataBus = require('../data/databus');
const AIDecisionEngine = require('../brain/ai-engine');
const Trader = require('../executor/trader');
const Guardian = require('../safety/guardian');
const PAIRS = require('../config/trading-pairs');

const USER_DATA_DIR = path.join(__dirname, '..', 'data', 'users');

class UserEngine {
  constructor(userId, userConfig, sharedDataBus, sharedDeepSeekBrain, globalConfig) {
    this.userId = userId;
    this.userConfig = userConfig;
    this.globalConfig = globalConfig;
    this.sharedDataBus = sharedDataBus;
    this.sharedDeepSeekBrain = sharedDeepSeekBrain;
    
    // 用户数据目录
    this.userDataPath = path.join(USER_DATA_DIR, userId);
    this._ensureUserDataDir();
    
    // 独立组件
    this.trader = new Trader(this._buildUserBinanceConfig(), PAIRS);
    this.trader.setMarketData(sharedDataBus.marketData);
    
    this.guardian = new Guardian(this.trader, sharedDataBus, globalConfig);
    this.aiEngine = new AIDecisionEngine(globalConfig, sharedDataBus);
    
    // 注入共享 DeepSeek
    if (sharedDeepSeekBrain) {
      this.aiEngine.deepseek = sharedDeepSeekBrain;
    }
    
    // 状态
    this.running = false;
    this.paused = false;
    this.cycleCount = 0;
    this.startTime = null;
    this.lastError = null;
    
    // 统计
    this.stats = {
      totalPnl: 0,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      maxDrawdown: 0,
      peakBalance: 0,
    };
    
    this.tradeLog = this._loadTradeLog();
    this.log = (msg) => console.log(`[UserEngine-${userId}] ${new Date().toISOString()} ${msg}`);
  }

  // ============ 初始化 ============
  _buildUserBinanceConfig() {
    return {
      binance: {
        apiKey: this.userConfig.binanceApiKey,
        apiSecret: this.userConfig.binanceApiSecret,
        futuresBase: this.globalConfig.binance.futuresBase,
        wsBase: this.globalConfig.binance.wsBase,
      },
      trading: this.globalConfig.trading,
    };
  }

  _ensureUserDataDir() {
    if (!fs.existsSync(this.userDataPath)) {
      fs.mkdirSync(this.userDataPath, { recursive: true });
    }
  }

  _loadTradeLog() {
    const logFile = path.join(this.userDataPath, 'trades.json');
    try {
      if (fs.existsSync(logFile)) return JSON.parse(fs.readFileSync(logFile, 'utf8'));
    } catch (e) { this.log(`⚠️ _loadTradeLog FAILED: ${e.message}`); }
    return [];
  }

  _saveTradeLog() {
    if (this.tradeLog.length > 500) this.tradeLog = this.tradeLog.slice(-500);
    try {
      fs.writeFileSync(path.join(this.userDataPath, 'trades.json'), JSON.stringify(this.tradeLog, null, 2));
    } catch (e) { this.log(`⚠️ _saveTradeLog FAILED: ${e.message}`); }
  }

  _saveState() {
    try {
      fs.writeFileSync(path.join(this.userDataPath, 'state.json'), JSON.stringify({
        stats: this.stats,
        cycleCount: this.cycleCount,
        startTime: this.startTime,
        lastError: this.lastError,
        lastUpdate: Date.now(),
      }, null, 2));
    } catch (e) { this.log(`⚠️ _saveState FAILED: ${e.message}`); }
  }

  // ============ 启动/停止 ============
  async start() {
    if (this.running) return;
    this.running = true;
    this.startTime = Date.now();
    this.log('🚀 启动');
    
    try {
      // 验证 API Key 有效性
      const balance = await this.trader.getBalance();
      if (!balance) {
        throw new Error('无法获取余额，API Key 可能无效');
      }
      this.stats.peakBalance = balance.balance;
      this.log(`余额: $${balance.balance.toFixed(2)} | 可用: $${balance.available.toFixed(2)}`);
      
      // 同步链上持仓
      await this.guardian.syncAllPositions();
      
      // 启动自进化
      this.aiEngine.startSelfEvolution();
      
      // 启动主循环
      this._mainLoop();
    } catch (e) {
      this.lastError = e.message;
      this.log(`❌ 启动失败: ${e.message}`);
      this.running = false;
    }
  }

  async stop() {
    this.running = false;
    this.log('⏹️ 已停止');
    this._saveState();
  }

  togglePause() {
    this.paused = !this.paused;
    this.log(`交易 ${this.paused ? '已暂停' : '已恢复'}`);
    return this.paused;
  }

  // ============ 主循环 ============
  async _mainLoop() {
    while (this.running) {
      try {
        this.cycleCount++;
        
        if (this.paused) {
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }
        
        // 阶段1：管理持仓
        await this.guardian.syncAllPositions();
        const allPositions = this.guardian.getAllPositions();
        const posArray = Object.entries(allPositions).map(([sym, pos]) => ({
          symbol: sym,
          ...pos,
        }));
        
        const closeActions = await this.aiEngine.managePositions(posArray, this.sharedDataBus.marketData);
        for (const act of closeActions) {
          await this._executeClose(act.symbol, act.reason);
        }
        
        // 阶段2：分析新机会
        const currentPosCount = this.guardian.getPositionCount();
        const maxPositions = this.globalConfig.trading.maxPositions || 3;
        
        if (currentPosCount < maxPositions) {
          for (const [symbol, pairCfg] of Object.entries(PAIRS)) {
            if (this.guardian.getPositionCount() >= maxPositions) break;
            await this._processSymbol(symbol, pairCfg);
            await new Promise(r => setTimeout(r, 2000));
          }
        }
        
        // 定期更新统计
        if (this.cycleCount % 10 === 0) {
          await this._updateStats();
        }
        
        this._saveState();
      } catch (e) {
        this.lastError = e.message;
        this.log(`主循环错误: ${e.message}`);
      }
      
      // 30秒间隔
      await new Promise(r => setTimeout(r, 30000));
    }
  }

  // ============ 平仓执行 ============
  async _executeClose(symbol, reason) {
    try {
      this.log(`平仓 ${symbol}: ${reason}`);
      const result = await this.guardian.executeDecision({ action: 'CLOSE', leverage: 0, positionSize: 0 }, symbol);
      if (result.executed) {
        const pnl = result.pnl || 0;
        this._recordTrade(symbol, 'CLOSE', 0, 0, pnl, reason);
        this.aiEngine._clearPeakPnl(symbol);
      }
    } catch (e) {
      this.log(`平仓失败 ${symbol}: ${e.message}`);
    }
  }

  // ============ 单币种处理 ============
  async _processSymbol(symbol, pairCfg) {
    try {
      const snapshot = await this.sharedDataBus.getMarketSnapshot(symbol);
      if (!snapshot || !snapshot.indicators) return;
      
      const currentPosition = this.guardian.getPosition(symbol);
      const balance = await this.trader.getBalance();
      const balanceUsd = balance?.balance || 0;
      
      const decision = await this.aiEngine.makeDecision(snapshot, currentPosition, balanceUsd);
      
      if (decision.action === 'WAIT' || decision.action === 'HOLD') return;
      
      this.log(`${symbol} 决策: ${decision.action} | ${decision.reasoning}`);
      
      const result = await this.guardian.executeDecision(decision, symbol);
      
      if (result.executed && ['LONG', 'SHORT', 'CLOSE'].includes(decision.action)) {
        this._recordTrade(symbol, decision.action, decision.leverage, decision.positionSize, result.pnl || 0, decision.reasoning);
      }
    } catch (e) {
      this.log(`${symbol} 错误: ${e.message}`);
    }
  }

  _recordTrade(symbol, action, leverage, size, pnl, reasoning) {
    const trade = {
      symbol, action, leverage, size, pnl, reasoning,
      price: this.sharedDataBus.marketData?.[symbol]?.price || 0,
      timestamp: Date.now(),
      userId: this.userId,
    };
    this.tradeLog.push(trade);
    this._saveTradeLog();
    
    if (pnl) {
      this.aiEngine.recordTradeResult({ action }, pnl);
      this.stats.totalPnl += pnl;
    }
    this.stats.totalTrades++;
    if (pnl > 0) this.stats.wins++;
    else if (pnl < 0) this.stats.losses++;
  }

  async _updateStats() {
    try {
      const balance = await this.trader.getBalance();
      if (balance) {
        if (balance.balance > this.stats.peakBalance) {
          this.stats.peakBalance = balance.balance;
        }
        const drawdown = this.stats.peakBalance > 0 
          ? ((this.stats.peakBalance - balance.balance) / this.stats.peakBalance) * 100 
          : 0;
        if (drawdown > this.stats.maxDrawdown) {
          this.stats.maxDrawdown = drawdown;
        }
      }
    } catch (e) { this.log(`⚠️ _updateStats FAILED: ${e.message}`); }
  }

  // ============ 状态查询 ============
  getStatus() {
    const positions = this.guardian.getAllPositions();
    return {
      userId: this.userId,
      running: this.running,
      paused: this.paused,
      cycleCount: this.cycleCount,
      uptime: this.startTime ? Date.now() - this.startTime : 0,
      positions,
      positionCount: this.guardian.getPositionCount(),
      stats: this.stats,
      winRate: this.stats.totalTrades > 0 
        ? ((this.stats.wins / this.stats.totalTrades) * 100).toFixed(1) + '%' 
        : 'N/A',
      recentTrades: this.tradeLog.slice(-10),
      lastError: this.lastError,
      timestamp: Date.now(),
    };
  }
}

module.exports = UserEngine;
