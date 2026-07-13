/**
 * Auto Trainer v1.0
 * 
 * 神经网络每日自动重训 + 策略参数自动调优
 * 
 * 功能：
 *   1. 每天 UTC 00:00 自动用最新交易数据重训神经网络
 *   2. 每周自动运行参数网格搜索，优化策略参数
 *   3. 监控模型性能退化，自动触发提前重训
 *   4. 记录训练历史和性能曲线
 */
const fs = require('fs');
const path = require('path');
const { NeuralNet } = require('./strategies/neural-net');
const { StrategyManager } = require('./strategies/strategy-manager');

class AutoTrainer {
  constructor(config = {}) {
    this.dataDir = path.join(__dirname, '..', 'data');
    this.modelPath = path.join(this.dataDir, 'neural-model.json');
    this.historyPath = path.join(this.dataDir, 'training-history.json');
    
    // 训练配置
    this.config = {
      dailyTrainHour: config.dailyTrainHour || 0,      // UTC 0点
      weeklyParamSearch: config.weeklyParamSearch !== false,
      minNewTrades: config.minNewTrades || 5,           // 至少5笔新交易才重训
      maxModelAge: config.maxModelAge || 24 * 3600 * 1000, // 24小时
      performanceThreshold: config.performanceThreshold || 0.55, // 准确率低于55%触发提前重训
      retrainCheckInterval: config.retrainCheckInterval || 60 * 60 * 1000, // 每小时检查一次
    };
    
    // 训练历史
    this._history = this._loadHistory();
    
    // 上次训练时间
    this._lastTrainTime = this._history.length > 0 
      ? this._history[this._history.length - 1].timestamp 
      : 0;
    
    // 神经网络实例
    this.neuralNet = null;
    this.strategyManager = null;
    
    // 定时器
    this._trainTimer = null;
    this._checkTimer = null;
    
    // 状态
    this.isTraining = false;
    this.lastTrainResult = null;
    
    console.log('[AutoTrainer] ✅ 自动训练器已启动 | 上次训练: ' + 
      (this._lastTrainTime > 0 ? new Date(this._lastTrainTime).toISOString() : '从未'));
  }
  
  /**
   * 注入依赖
   */
  setDependencies(neuralNet, strategyManager) {
    this.neuralNet = neuralNet;
    this.strategyManager = strategyManager;
  }
  
  /**
   * 启动定时任务
   */
  start() {
    // v100: 首次启动时先生成训练数据，再训练
    console.log('[AutoTrainer] 🚀 启动，先生成训练数据再训练');
    setTimeout(async () => {
      try {
        // 如果训练数据不存在或太少，先生成
        const dataPath = path.join(this.dataDir, 'kline-features.json');
        let dataCount = 0;
        try { dataCount = JSON.parse(fs.readFileSync(dataPath, 'utf8')).length; } catch(e) {}
        if (dataCount < 1000) {
          console.log('[AutoTrainer] 📊 训练数据不足 (' + dataCount + ')，重新生成...');
          const { execSync } = require('child_process');
          execSync('node ' + path.join(__dirname, '..', 'scripts', 'generate-training-data.js'), { timeout: 120000 });
          console.log('[AutoTrainer] ✅ 训练数据生成完成');
        }
      } catch(e) { console.error('[AutoTrainer] 生成训练数据失败:', e.message); }
      this.train().catch(e => console.error('[AutoTrainer] 初始训练失败:', e.message));
    }, 3000);
    
    // 每小时检查是否需要训练
    this._checkTimer = setInterval(() => {
      this._checkAndTrain();
    }, this.config.retrainCheckInterval);
    
    // 每 5 分钟检查性能退化
    setInterval(() => {
      this._checkPerformance();
    }, 5 * 60 * 1000);
    
    console.log('[AutoTrainer] ⏰ 定时任务已启动 | 检查间隔: 1h | 性能监控: 5min');
  }
  
  /**
   * 检查并执行训练
   */
  async _checkAndTrain() {
    if (this.isTraining) return;
    
    const now = Date.now();
    const modelAge = now - this._lastTrainTime;
    
    // 检查是否到每日训练时间
    const utcHour = new Date().getUTCHours();
    const isTrainTime = utcHour === this.config.dailyTrainHour;
    
    // 检查新交易数量
    const newTrades = this._countNewTrades();
    
    // 条件：到时间 + 模型超过有效期 + 有足够新数据
    if (isTrainTime && modelAge > this.config.maxModelAge * 0.9) {
      if (newTrades >= this.config.minNewTrades) {
        console.log(`[AutoTrainer] 🔄 触发每日训练 | 新交易: ${newTrades} | 模型年龄: ${(modelAge / 3600000).toFixed(1)}h`);
        await this.train();
      } else {
        console.log(`[AutoTrainer] ⏸️ 新交易不足 (${newTrades}/${this.config.minNewTrades})，跳过训练`);
      }
    }
    
    // 每周参数搜索（周日 UTC 0点）
    if (this.config.weeklyParamSearch && utcHour === 0 && new Date().getUTCDay() === 0) {
      if (modelAge > 6 * 24 * 3600 * 1000) { // 6天没搜过
        console.log('[AutoTrainer] 🔍 触发每周参数搜索');
        await this.runParamSearch();
      }
    }
  }
  
  /**
   * 性能退化检测
   */
  _checkPerformance() {
    if (!this.neuralNet) return;
    
    const stats = this.neuralNet.getStats?.() || {};
    const accuracy = stats.accuracy || 0;
    
    if (accuracy > 0 && accuracy < this.config.performanceThreshold) {
      console.log(`[AutoTrainer] ⚠️ 模型性能退化: ${(accuracy * 100).toFixed(1)}% < ${(this.config.performanceThreshold * 100)}%，触发提前重训`);
      this.train().catch(e => console.error('[AutoTrainer] 重训失败:', e.message));
    }
  }
  
  /**
   * 执行训练
   */
  async train() {
    if (this.isTraining) {
      console.log('[AutoTrainer] ⏸️ 已在训练中，跳过');
      return;
    }
    
    this.isTraining = true;
    const startTime = Date.now();
    
    try {
      console.log('═══════════════════════════════');
      console.log('  🧠 神经网络自动训练开始');
      console.log('═══════════════════════════════');
      
      // 1. 收集训练数据
      const trainingData = this._collectTrainingData();
      if (trainingData.length < 10) {
        console.log(`[AutoTrainer] ⚠️ 训练数据不足 (${trainingData.length}/10)，跳过`);
        this.isTraining = false;
        return;
      }
      
      console.log(`[AutoTrainer] 📊 训练数据: ${trainingData.length} 条`);
      
      // 2. 初始化或复用神经网络
      if (!this.neuralNet) {
        this.neuralNet = new NeuralNet();
      }
      
      // 3. 训练
      // v100: 优先用K线原始数据trainBatch（最有效）
      let trainResult;
      const klineRawPath = path.join(this.dataDir, 'kline-raw-cache.json');
      let klineRaw = [];
      try {
        if (fs.existsSync(klineRawPath)) klineRaw = JSON.parse(fs.readFileSync(klineRawPath, 'utf8'));
      } catch(e) {}
      
      // 如果没有原始K线缓存，从交易所实时获取
      if (klineRaw.length < 200 && this.strategyManager) {
        try {
          const dataBus = this.strategyManager.dataBus;
          if (dataBus?.klines) {
            for (const [sym, tf] of Object.entries(dataBus.klines)) {
              for (const [period, arr] of Object.entries(tf)) {
                if (arr && arr.length > 200) {
                  klineRaw = arr;
                  console.log(`[AutoTrainer] 📡 使用实时K线: ${sym} ${period} (${arr.length}条)`);
                  break;
                }
              }
              if (klineRaw.length >= 200) break;
            }
          }
        } catch(e) {}
      }
      
      if (klineRaw.length >= 200 && typeof this.neuralNet.trainBatch === 'function') {
        console.log(`[AutoTrainer] 🧠 用K线数据trainBatch: ${klineRaw.length}条, 50 epochs`);
        trainResult = this.neuralNet.trainBatch(klineRaw, 50);
        // 保存原始K线缓存供下次使用
        try { fs.writeFileSync(klineRawPath, JSON.stringify(klineRaw.slice(-500))); } catch(e) {}
      } else if (trainingData.length >= 10) {
        // fallback: 用交易数据在线训练
        console.log(`[AutoTrainer] 🧠 用交易数据在线训练: ${trainingData.length}条`);
        let correct = 0;
        for (const sample of trainingData) {
          if (this.neuralNet.train(sample.input, sample.output[0])) {
            correct++;
          }
        }
        trainResult = { trained: true, samples: trainingData.length, accuracy: correct / trainingData.length, epochs: 1 };
      } else {
        console.log('[AutoTrainer] ⚠️ 无可用训练数据，跳过');
        this.isTraining = false;
        return;
      }
      
      // 4. 保存模型
      this.neuralNet.save(this.modelPath);
      
      // 5. 记录训练历史
      const record = {
        timestamp: Date.now(),
        dataPoints: trainingData.length,
        epochs: trainResult.epochs || 50,
        accuracy: trainResult.accuracy || 0,
        loss: trainResult.loss || 0,
        duration: Date.now() - startTime,
        triggeredBy: this._lastTrainTime === 0 ? 'INITIAL' : 'SCHEDULED',
      };
      
      this._history.push(record);
      if (this._history.length > 100) this._history.shift();
      this._saveHistory();
      
      this._lastTrainTime = Date.now();
      this.lastTrainResult = record;
      
      console.log(`[AutoTrainer] ✅ 训练完成 | 准确率: ${(record.accuracy * 100).toFixed(1)}% | 耗时: ${(record.duration / 1000).toFixed(1)}s`);
      console.log('═══════════════════════════════\n');
      
    } catch (e) {
      console.error('[AutoTrainer] ❌ 训练失败:', e.message);
    } finally {
      this.isTraining = false;
    }
  }
  
  /**
   * 参数网格搜索
   */
  async runParamSearch() {
    if (this.isTraining) return;
    this.isTraining = true;
    
    try {
      console.log('[AutoTrainer] 🔍 开始参数网格搜索...');
      
      // 动态加载回测模块
      const GridSearch = require('../backtest/grid-search');
      const BacktestEngine = require('../backtest/backtest-engine');
      
      const backtest = new BacktestEngine();
      const gridSearch = new GridSearch(backtest);
      
      // 使用最近交易数据
      const trades = this._loadTradeLog();
      if (trades.length < 20) {
        console.log('[AutoTrainer] ⚠️ 交易数据不足，跳过参数搜索');
        return;
      }
      
      const result = await gridSearch.search(trades);
      console.log(`[AutoTrainer] ✅ 参数搜索完成 | 最优参数:`, result.bestParams);
      
      // 记录到历史
      const record = {
        timestamp: Date.now(),
        type: 'PARAM_SEARCH',
        bestParams: result.bestParams,
        bestScore: result.bestScore,
        tested: result.tested || 0,
      };
      this._history.push(record);
      this._saveHistory();
      
    } catch (e) {
      console.error('[AutoTrainer] 参数搜索失败:', e.message);
    } finally {
      this.isTraining = false;
    }
  }
  
  /**
   * 收集训练数据
   */
  _collectTrainingData() {
    // 从交易日志加载
    const trades = this._loadTradeLog();
    
    // 转换为训练样本（v83: 兼容三种格式）
    const samples = [];
    for (const t of trades) {
      let input, label;
      // 格式1: 新格式 features+label
      if (t.features && t.features.length > 0 && t.label !== undefined && t.label !== null) {
        input = t.features;
        label = t.label;
      }
      // 格式2: input+output (旧格式)
      else if (t.input && t.input.length > 0 && t.output !== undefined) {
        input = t.input;
        label = Array.isArray(t.output) ? t.output[0] : t.output;
      }
      // 格式3: 有pnl但没features（用pnl做label，features用0填充）
      else if (t.pnl !== undefined && t.pnl !== null) {
        input = new Array(8).fill(0);  // 8维占位
        label = t.pnl > 0 ? 1 : (t.pnl < 0 ? -1 : 0);
      }
      else continue;
      
      if (!input || input.length === 0) continue;
      samples.push({ input, output: [label] });
    }
    
    // 如果训练数据太少，用 K 线数据补充
    if (samples.length < 50) {
      const klineData = this._loadKlineFeatures();
      samples.push(...klineData);
    }
    
    return samples;
  }
  
  /**
   * 统计自上次训练以来的新交易数
   */
  _countNewTrades() {
    const trades = this._loadTradeLog();
    return trades.filter(t => t.timestamp > this._lastTrainTime).length;
  }
  
  /**
   * 加载交易日志
   */
  _loadTradeLog() {
    try {
      const p = path.join(this.dataDir, 'trade-log.json');
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      }
    } catch (e) { /* ignore */ }
    return [];
  }
  
  /**
   * 从 K 线数据生成训练特征
   */
  _loadKlineFeatures() {
    try {
      const p = path.join(this.dataDir, 'kline-features.json');
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      }
    } catch (e) { /* ignore */ }
    return [];
  }
  
  /**
   * 加载训练历史
   */
  _loadHistory() {
    try {
      if (fs.existsSync(this.historyPath)) {
        return JSON.parse(fs.readFileSync(this.historyPath, 'utf8'));
      }
    } catch (e) { /* ignore */ }
    return [];
  }
  
  /**
   * 保存训练历史
   */
  _saveHistory() {
    try {
      fs.writeFileSync(this.historyPath, JSON.stringify(this._history, null, 2));
    } catch (e) { /* ignore */ }
  }
  
  /**
   * 获取状态
   */
  getStatus() {
    return {
      isTraining: this.isTraining,
      lastTrainTime: this._lastTrainTime,
      lastTrainResult: this.lastTrainResult,
      historyCount: this._history.length,
      nextCheckIn: this.config.retrainCheckInterval,
      modelAge: Date.now() - this._lastTrainTime,
    };
  }
  
  /**
   * 获取训练历史
   */
  getHistory(limit = 20) {
    return this._history.slice(-limit);
  }
  
  destroy() {
    if (this._trainTimer) clearInterval(this._trainTimer);
    if (this._checkTimer) clearInterval(this._checkTimer);
  }
}

module.exports = AutoTrainer;
