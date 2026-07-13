/**
 * v63: 真神经网络预测引擎 — 纯JS实现，零依赖
 * 
 * 架构：3层前馈神经网络 (MLP)
 *   输入层: 12个特征（技术指标 + 量价数据）
 *   隐藏层: 8个神经元 (ReLU激活)
 *   输出层: 3个神经元 (Softmax → 看涨/中性/看跌 概率)
 * 
 * 训练：在线梯度下降 (SGD) + 反向传播
 *   - 每次交易结果反馈后自动训练
 *   - v113.51: Warm Restart (Cosine Annealing with Warm Restarts)
 *     学习率从 initialLR 余弦衰减到 minLR，周期结束后重置
 *     模型能周期性跳出局部最优，持续适应新市场
 *   - L2正则化防过拟合
 * 
 * 用法：
 *   const { NeuralNet } = require('./neural-net');
 *   const nn = new NeuralNet();
 *   const pred = nn.predict(features);  // → {up, neutral, down, action, confidence}
 *   nn.train(features, label, learningRate);  // 在线训练
 *   nn.save('data/neural-model.json');  // 持久化
 *   nn.load('data/neural-model.json');  // 加载
 */

const fs = require('fs');
const path = require('path');

const MODEL_FILE = path.join(__dirname, '..', '..', 'data', 'neural-model.json');

// ═══════════════════════════════════
// 激活函数
// ═══════════════════════════════════
const Activation = {
  relu: {
    fn: x => Math.max(0, x),
    deriv: z => z > 0 ? 1 : 0,
  },
  sigmoid: {
    fn: x => 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x)))),
    deriv: z => {
      const s = 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, z))));
      return s * (1 - s);
    },
  },
  softmax: {
    fn: arr => {
      const max = Math.max(...arr);
      const exps = arr.map(x => Math.exp(x - max));
      const sum = exps.reduce((a, b) => a + b, 0);
      return exps.map(e => e / sum);
    },
    // softmax + cross-entropy 的梯度简化为 (output - target)
    deriv: null,
  },
  tanh: {
    fn: x => Math.tanh(x),
    deriv: z => 1 - Math.tanh(z) ** 2,
  },
};

// ═══════════════════════════════════
// 层类
// ═══════════════════════════════════
class Layer {
  constructor(inputSize, outputSize, activation = 'relu') {
    this.inputSize = inputSize;
    this.outputSize = outputSize;
    this.activation = activation;
    
    // Xavier 初始化
    const limit = Math.sqrt(6 / (inputSize + outputSize));
    this.weights = [];
    this.biases = new Array(outputSize).fill(0);
    
    for (let i = 0; i < outputSize; i++) {
      const row = [];
      for (let j = 0; j < inputSize; j++) {
        row.push((Math.random() * 2 - 1) * limit);
      }
      this.weights.push(row);
    }
    
    // 缓存（用于反向传播）
    this.lastInput = null;
    this.lastZ = null;      // 加权和
    this.lastOutput = null;  // 激活后
  }

  forward(input) {
    this.lastInput = input;
    this.lastZ = new Array(this.outputSize).fill(0);
    
    for (let i = 0; i < this.outputSize; i++) {
      let sum = this.biases[i];
      for (let j = 0; j < this.inputSize; j++) {
        sum += this.weights[i][j] * input[j];
      }
      this.lastZ[i] = sum;
    }
    
    const act = Activation[this.activation];
    if (this.activation === 'softmax') {
      this.lastOutput = act.fn(this.lastZ);
    } else {
      this.lastOutput = this.lastZ.map(z => act.fn(z));
    }
    
    return this.lastOutput;
  }

  // 反向传播，返回 input 的梯度
  backward(outputGrad, learningRate, l2Lambda = 0.001) {
    const act = Activation[this.activation];
    let deltas;
    
    if (this.activation === 'softmax') {
      // softmax + cross-entropy: gradient = output - target (已传入 outputGrad)
      deltas = outputGrad;
    } else {
      deltas = outputGrad.map((g, i) => g * act.deriv(this.lastZ[i]));
    }
    
    // 计算 input 的梯度 (用于传递给上一层)
    const inputGrad = new Array(this.inputSize).fill(0);
    for (let j = 0; j < this.inputSize; j++) {
      for (let i = 0; i < this.outputSize; i++) {
        inputGrad[j] += this.weights[i][j] * deltas[i];
      }
    }
    
    // 更新权重和偏置
    for (let i = 0; i < this.outputSize; i++) {
      for (let j = 0; j < this.inputSize; j++) {
        // L2 正则化
        const l2Grad = l2Lambda * this.weights[i][j];
        this.weights[i][j] -= learningRate * (deltas[i] * this.lastInput[j] + l2Grad);
      }
      this.biases[i] -= learningRate * deltas[i];
    }
    
    return inputGrad;
  }

  // 序列化
  toJSON() {
    return {
      inputSize: this.inputSize,
      outputSize: this.outputSize,
      activation: this.activation,
      weights: this.weights,
      biases: this.biases,
    };
  }

  static fromJSON(data) {
    const layer = new Layer(data.inputSize, data.outputSize, data.activation);
    // v91: 只在权重有效时覆盖，防止None值破坏Xavier初始化
    if (data.weights && data.weights[0] && data.weights[0][0] !== null && data.weights[0][0] !== undefined) {
      layer.weights = data.weights;
    }
    if (data.biases && data.biases[0] !== null && data.biases[0] !== undefined) {
      layer.biases = data.biases;
    }
    return layer;
  }
}

// ═══════════════════════════════════
// 神经网络主类
// ═══════════════════════════════════
class NeuralNet {
  constructor(config = {}) {
    // 网络结构: 12 → 8 → 3
    this.inputSize = config.inputSize || 12;
    this.hiddenSize = config.hiddenSize || 8;
    this.outputSize = config.outputSize || 3; // up, neutral, down
    
    this.layers = [
      new Layer(this.inputSize, this.hiddenSize, 'relu'),
      new Layer(this.hiddenSize, this.outputSize, 'softmax'),
    ];
    
    // 训练状态
    this.learningRate = config.learningRate || 0.01;
    this.initialLR = this.learningRate;
    this.minLR = config.minLR || 0.0001;  // v113.51: Warm Restart 下限
    this.l2Lambda = config.l2Lambda || 0.001;
    this.trainCount = 0;
    this.accuracyHistory = [];
    
    // v113.51: Warm Restart 参数 (Cosine Annealing with Warm Restarts)
    this.warmRestartEpoch = 0;       // 当前周期内的训练计数
    this.warmRestartCycle = 0;       // 第几个 restart 周期
    this.warmRestartPeriod = 5000;   // 每5000次训练重启一次学习率
    
    // 特征归一化参数（动态更新）
    this.featureStats = {
      means: new Array(this.inputSize).fill(0),
      stds: new Array(this.inputSize).fill(1),
      count: 0,
    };
  }

  // ═══════════════════════════════════
  // 特征工程：从K线提取12维特征向量
  // ═══════════════════════════════════
  extractFeatures(klines, indicators = {}) {
    if (!klines || klines.length < 50) return null;
    
    const closes = klines.map(k => parseFloat(k.close));
    const volumes = klines.map(k => parseFloat(k.volume || 0));
    const highs = klines.map(k => parseFloat(k.high));
    const lows = klines.map(k => parseFloat(k.low));
    const n = closes.length;
    const price = closes[n - 1];
    
    // 1. 收益率序列
    const returns = [];
    for (let i = 1; i <= 20; i++) {
      if (n > i) returns.push((closes[n - 1] - closes[n - 1 - i]) / closes[n - 1 - i]);
    }
    
    // === 12维特征 ===
    const features = [];
    
    // F1: 短期动量 (5期ROC)
    features.push(this._safeDiv(closes[n-1] - closes[n-6], closes[n-6]));
    
    // F2: 中期动量 (10期ROC)
    features.push(this._safeDiv(closes[n-1] - closes[n-11], closes[n-11]));
    
    // F3: 长期动量 (20期ROC)
    features.push(this._safeDiv(closes[n-1] - closes[n-21], closes[n-21]));
    
    // F4: 波动率 (20期标准差)
    const mean20 = closes.slice(-20).reduce((a,b) => a+b, 0) / 20;
    const var20 = closes.slice(-20).reduce((s, p) => s + (p - mean20) ** 2, 0) / 20;
    features.push(Math.sqrt(var20) / price);
    
    // F5: RSI (14期)
    features.push(this._calcRSI(closes, 14) / 100);
    
    // F6: 价格vs MA7 偏离度
    const ma7 = closes.slice(-7).reduce((a,b) => a+b, 0) / 7;
    features.push(this._safeDiv(price - ma7, ma7));
    
    // F7: 价格vs MA25 偏离度
    const ma25 = closes.slice(-25).reduce((a,b) => a+b, 0) / 25;
    features.push(this._safeDiv(price - ma25, ma25));
    
    // F8: 成交量比率 (当前 vs 20期均值)
    const avgVol20 = volumes.slice(-20).reduce((a,b) => a+b, 0) / 20 || 1;
    features.push(volumes[n-1] / avgVol20);
    
    // F9: 量价相关性 (20期)
    features.push(this._correlation(closes.slice(-20), volumes.slice(-20)));
    
    // F10: ATR% (波动幅度)
    const atr = this._calcATR(highs, lows, closes, 14);
    features.push(atr / price);
    
    // F11: 上影线占比 (最近K线)
    const range = highs[n-1] - lows[n-1] || 0.0001;
    const upperShadow = highs[n-1] - Math.max(closes[n-2] || price, price);
    features.push(upperShadow / range);
    
    // F12: 布林带 %B
    const std20 = Math.sqrt(var20) || 0.0001;
    const upperBB = mean20 + 2 * std20;
    const lowerBB = mean20 - 2 * std20;
    features.push(this._safeDiv(price - lowerBB, upperBB - lowerBB));
    
    // 归一化
    return this._normalize(features);
  }

  // ═══════════════════════════════════
  // 预测
  // ═══════════════════════════════════
  predict(features) {
    if (!features || features.length !== this.inputSize) {
      return { valid: false, action: 'HOLD', confidence: 0, probabilities: {} };
    }
    
    const _symbol = features._symbol || 'unknown';
    
    let output = features;
    for (const layer of this.layers) {
      output = layer.forward(output);
    }
    
    // output = [up_prob, neutral_prob, down_prob]
    const [up, neutral, down] = output;
    
    let action = 'HOLD';
    let confidence = neutral;
    let direction = 0;
    
    if (up > 0.45 && up > down) {
      action = 'BUY';
      confidence = up;
      direction = 1;
    } else if (down > 0.45 && down > up) {
      action = 'SELL';
      confidence = down;
      direction = -1;
    } else {
      action = 'HOLD';
      confidence = neutral;
      direction = 0;
    }
    
    const result = {
      valid: true,
      action,         // BUY / SELL / HOLD
      direction,      // 1 / -1 / 0
      confidence,     // 0-1
      probabilities: { up, neutral, down },
      rawOutput: output,
    };
    
    // v112: 保存预测历史供仪表盘读取
    if (!this.predictionLog) this.predictionLog = [];
    this.predictionLog.push({
      symbol: _symbol,
      direction: direction > 0 ? 'UP' : direction < 0 ? 'DOWN' : 'NEUTRAL',
      action,
      confidence,
      timestamp: Date.now(),
    });
    if (this.predictionLog.length > 50) this.predictionLog.shift();
    
    return result;
  }

  // ═══════════════════════════════════
  // 训练（单样本在线SGD）
  // ═══════════════════════════════════
  train(features, label, lr = null) {
    if (!features || features.length !== this.inputSize) return;
    
    // v113.51: Warm Restart — 如果调用者没指定 lr，用 cosine annealing 动态计算
    let learningRate;
    if (lr !== null) {
      learningRate = lr;
    } else {
      learningRate = this._calcWarmRestartLR();
    }
    
    // 前向传播
    let output = features;
    for (const layer of this.layers) {
      output = layer.forward(output);
    }
    
    // 构造目标向量 (one-hot)
    // label: 1=up, 0=neutral, -1=down
    const target = label === 1 ? [1, 0, 0] : label === -1 ? [0, 0, 1] : [0, 1, 0];
    
    // 计算输出层梯度 (softmax + cross-entropy)
    const outputGrad = output.map((o, i) => o - target[i]);
    
    // 反向传播
    let grad = outputGrad;
    for (let i = this.layers.length - 1; i >= 0; i--) {
      grad = this.layers[i].backward(grad, learningRate, this.l2Lambda);
    }
    
    this.trainCount++;
    this.warmRestartEpoch++;
    
    // v113.51: 检查是否需要 warm restart
    if (this.warmRestartEpoch >= this.warmRestartPeriod) {
      this._doWarmRestart();
    }
    
    // 返回预测准确度
    const predicted = output.indexOf(Math.max(...output));
    const actualIdx = target.indexOf(1);
    return predicted === actualIdx;
  }

  // ═══════════════════════════════════
  // 批量训练（从历史数据）
  // ═══════════════════════════════════
  trainBatch(klines, epochs = 50) {
    if (!klines || klines.length < 100) {
      return { trained: false, samples: 0, accuracy: 0 };
    }
    
    const closes = klines.map(k => parseFloat(k.close));
    let correct = 0;
    let total = 0;
    
    for (let epoch = 0; epoch < epochs; epoch++) {
      correct = 0;
      total = 0;
      
      // 滑动窗口训练
      for (let i = 60; i < closes.length - 5; i++) {
        const window = klines.slice(0, i + 1);
        const features = this.extractFeatures(window);
        if (!features) continue;
        
        // 标签：未来5期收益率
        const futureReturn = (closes[i + 5] - closes[i]) / closes[i];
        const label = futureReturn > 0.01 ? 1 : futureReturn < -0.01 ? -1 : 0;
        
        const isCorrect = this.train(features, label);
        if (isCorrect) correct++;
        total++;
      }
      
      // v113.51: 去掉固定 ×0.9 衰减，改用 Warm Restart (cosine annealing)
      // 每次训练自动调用 _calcWarmRestartLR()，无需手动衰减
    }
    
    const accuracy = total > 0 ? correct / total : 0;
    this.accuracyHistory.push(accuracy);
    if (this.accuracyHistory.length > 100) this.accuracyHistory.shift();
    
    return { trained: true, samples: total, accuracy, epochs };
  }

  // ═══════════════════════════════════
  // v113.51: Warm Restart — Cosine Annealing with Warm Restarts
  // 学习率从 initialLR 余弦衰减到 minLR，周期结束后重置
  // 模型能周期性「跳出局部最优」，持续适应新市场
  // ═══════════════════════════════════
  _calcWarmRestartLR() {
    const t = this.warmRestartEpoch;
    const T = this.warmRestartPeriod;
    // Cosine annealing: lr = minLR + 0.5*(initialLR - minLR)*(1 + cos(π * t/T))
    const cosVal = Math.cos(Math.PI * t / T);
    const lr = this.minLR + 0.5 * (this.initialLR - this.minLR) * (1 + cosVal);
    this.learningRate = lr;  // 保持属性同步
    return lr;
  }
  
  _doWarmRestart() {
    const oldLR = this.learningRate;
    this.warmRestartEpoch = 0;
    this.warmRestartCycle++;
    // 重置学习率到初始值（warm restart 的核心）
    this.learningRate = this.initialLR;
    console.log(`[NeuralNet] 🔄 Warm Restart #${this.warmRestartCycle} — 学习率 ${oldLR.toExponential(3)} → ${this.initialLR} (trainCount=${this.trainCount})`);
  }
  
  // ═══════════════════════════════════
  // 特征归一化 (动态Z-Score)
  // ═══════════════════════════════════
  _normalize(features) {
    // 更新统计量
    this.featureStats.count++;
    const alpha = 1 / Math.min(this.featureStats.count, 1000);
    
    for (let i = 0; i < features.length; i++) {
      // 更新均值 (EMA)
      this.featureStats.means[i] = (1 - alpha) * this.featureStats.means[i] + alpha * features[i];
      // 更新方差
      const diff = features[i] - this.featureStats.means[i];
      this.featureStats.stds[i] = Math.sqrt((1 - alpha) * this.featureStats.stds[i] ** 2 + alpha * diff ** 2);
    }
    
    // Z-Score 归一化
    return features.map((f, i) => {
      const std = this.featureStats.stds[i] || 1;
      return std > 0.0001 ? (f - this.featureStats.means[i]) / std : 0;
    });
  }

  // ═══════════════════════════════════
  // 持久化
  // ═══════════════════════════════════
  save(filePath = MODEL_FILE) {
    const data = {
      inputSize: this.inputSize,
      hiddenSize: this.hiddenSize,
      outputSize: this.outputSize,
      layers: this.layers.map(l => l.toJSON()),
      learningRate: this.learningRate,
      initialLR: this.initialLR,
      minLR: this.minLR,                         // v113.51
      l2Lambda: this.l2Lambda,
      trainCount: this.trainCount,
      accuracyHistory: this.accuracyHistory,
      featureStats: this.featureStats,
      warmRestartEpoch: this.warmRestartEpoch,   // v113.51
      warmRestartCycle: this.warmRestartCycle,   // v113.51
      warmRestartPeriod: this.warmRestartPeriod, // v113.51
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return true;
  }

  load(filePath = MODEL_FILE) {
    if (!fs.existsSync(filePath)) return false;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      // v91: 检查模型是否有效（权重不是全None）
      const firstLayerWeights = data.layers?.[0]?.weights?.[0];
      const hasValidWeights = firstLayerWeights && firstLayerWeights[0] !== null && firstLayerWeights[0] !== undefined;
      if (!hasValidWeights) {
        console.log('[NeuralNet] ⚠️ 模型权重全为None，跳过加载，使用随机初始化');
        this.layers = [
          new Layer(this.inputSize, this.hiddenSize, 'relu'),
          new Layer(this.hiddenSize, this.outputSize, 'softmax'),
        ];
        return false;
      }
      this.inputSize = data.inputSize;
      this.hiddenSize = data.hiddenSize;
      this.outputSize = data.outputSize;
      this.layers = data.layers.map(d => Layer.fromJSON(d));
      this.learningRate = data.learningRate;
      this.initialLR = data.initialLR;
      this.l2Lambda = data.l2Lambda;
      this.trainCount = data.trainCount || 0;
      this.accuracyHistory = data.accuracyHistory || [];
      this.featureStats = data.featureStats || this.featureStats;
      // v113.51: 恢复 Warm Restart 状态
      this.minLR = data.minLR || 0.0001;
      this.warmRestartEpoch = data.warmRestartEpoch || 0;
      this.warmRestartCycle = data.warmRestartCycle || 0;
      this.warmRestartPeriod = data.warmRestartPeriod || 5000;
      // v113.51: 如果加载的模型学习率已死 (≤ minLR)，立即 warm restart
      if (this.learningRate <= this.minLR) {
        console.log(`[NeuralNet] ⚠️ 检测到学习率已死 (${this.learningRate.toExponential(3)}), 立即 Warm Restart`);
        this._doWarmRestart();
      }
      console.log('[NeuralNet] ✅ 模型加载成功 trainCount=' + this.trainCount + ' lr=' + this.learningRate.toExponential(3) + ' cycle=' + this.warmRestartCycle);
      return true;
    } catch (e) {
      console.log('[NeuralNet] ❌ 加载失败:', e.message);
      this.layers = [
        new Layer(this.inputSize, this.hiddenSize, 'relu'),
        new Layer(this.hiddenSize, this.outputSize, 'softmax'),
      ];
      return false;
    }
  }

  getStats() {
    return {
      trainCount: this.trainCount,
      learningRate: this.learningRate,
      initialLR: this.initialLR,
      minLR: this.minLR,
      warmRestartEpoch: this.warmRestartEpoch,
      warmRestartCycle: this.warmRestartCycle,
      warmRestartPeriod: this.warmRestartPeriod,
      accuracyHistory: this.accuracyHistory.slice(-10),
      avgAccuracy: this.accuracyHistory.length > 0
        ? this.accuracyHistory.reduce((a, b) => a + b, 0) / this.accuracyHistory.length
        : 0,
      featureStatsReady: this.featureStats.count > 10,
      recentPredictions: this.predictionLog || [],
    };
  }

  // ═══════════════════════════════════
  // 技术指标工具
  // ═══════════════════════════════════
  _calcRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const ch = closes[i] - closes[i - 1];
      if (ch > 0) gains += ch; else losses -= ch;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    return avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }

  _calcATR(highs, lows, closes, period = 14) {
    if (highs.length < 2) return 0;
    const trs = [];
    for (let i = Math.max(1, highs.length - period); i < highs.length; i++) {
      trs.push(Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      ));
    }
    return trs.reduce((a, b) => a + b, 0) / trs.length;
  }

  _correlation(arr1, arr2) {
    const n = Math.min(arr1.length, arr2.length);
    if (n < 3) return 0;
    const m1 = arr1.slice(-n).reduce((a, b) => a + b, 0) / n;
    const m2 = arr2.slice(-n).reduce((a, b) => a + b, 0) / n;
    let cov = 0, var1 = 0, var2 = 0;
    for (let i = 0; i < n; i++) {
      const d1 = arr1[arr1.length - n + i] - m1;
      const d2 = arr2[arr2.length - n + i] - m2;
      cov += d1 * d2;
      var1 += d1 * d1;
      var2 += d2 * d2;
    }
    const denom = Math.sqrt(var1 * var2);
    return denom > 0 ? cov / denom : 0;
  }

  _safeDiv(a, b) {
    return Math.abs(b) > 1e-10 ? a / b : 0;
  }
}

module.exports = { NeuralNet, Layer, Activation };
