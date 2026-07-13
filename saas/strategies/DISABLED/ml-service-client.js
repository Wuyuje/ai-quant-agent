/**
 * ML Service Client — Node.js ↔ Python LSTM bridge
 * 
 * Calls the Python LSTM microservice via HTTP to get
 * deep learning predictions that are superior to the
 * existing 3-layer MLP neural-net.js.
 * 
 * Fallback: if ML service is down, falls back to local NeuralNet.
 */

const http = require('http');
const { NeuralNet } = require('./neural-net');

class MLServiceClient {
  constructor(config = {}) {
    this.serviceUrl = config.serviceUrl || process.env.ML_SERVICE_URL || 'http://localhost:8100';
    this.timeout = config.timeout || 5000; // 5s timeout
    this.enabled = config.enabled !== false;
    this._healthy = false;
    this._lastHealthCheck = 0;
    this._healthCheckInterval = 30000; // 30s
    
    // Fallback local model
    this._fallbackNet = new NeuralNet();
    this._fallbackNet.load();
    
    this._log = config.log || ((msg) => console.log(`[MLClient] ${msg}`));
  }

  /**
   * Check if ML service is healthy
   */
  async checkHealth() {
    const now = Date.now();
    if (now - this._lastHealthCheck < this._healthCheckInterval) {
      return this._healthy;
    }
    this._lastHealthCheck = now;

    try {
      const result = await this._request('GET', '/health', null, 3000);
      this._healthy = result.status === 'ok' && result.tensorflow === true;
      if (this._healthy) {
        this._log(`✅ ML service healthy (model_loaded=${result.model_loaded})`);
      } else {
        this._log(`⚠️ ML service unhealthy or no TensorFlow — using fallback`);
      }
    } catch (e) {
      this._healthy = false;
      this._log(`⚠️ ML service unreachable: ${e.message} — using fallback`);
    }
    
    return this._healthy;
  }

  /**
   * Predict next-bar direction using LSTM
   * @param {Array} klines — [{open, high, low, close, volume}, ...]
   * @param {string} symbol — trading symbol
   * @returns {Object} { direction, action, confidence, probabilities, valid, source }
   */
  async predict(klines, symbol = 'unknown') {
    if (!this.enabled) {
      return this._fallbackPredict(klines, symbol);
    }

    // Check health first
    if (!await this.checkHealth()) {
      return this._fallbackPredict(klines, symbol);
    }

    try {
      const result = await this._request('POST', '/predict', {
        klines: klines.slice(-100), // send last 100 bars
        symbol,
      }, this.timeout);

      if (result.valid) {
        return {
          ...result,
          source: 'lstm-service',
        };
      } else {
        // Service returned invalid — try fallback
        const fb = this._fallbackPredict(klines, symbol);
        return { ...fb, source: 'fallback-momentum' };
      }
    } catch (e) {
      this._log(`⚠️ Predict failed: ${e.message}`);
      return this._fallbackPredict(klines, symbol);
    }
  }

  /**
   * Train the LSTM model with historical klines
   */
  async train(klines, options = {}) {
    if (!await this.checkHealth()) {
      return { success: false, error: 'ML service unavailable' };
    }

    try {
      const result = await this._request('POST', '/train', {
        klines,
        epochs: options.epochs || 50,
        batch_size: options.batch_size || 32,
      }, 300000); // 5min timeout for training

      return result;
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Fallback prediction using local NeuralNet (3-layer MLP)
   */
  _fallbackPredict(klines, symbol) {
    try {
      const features = this._fallbackNet.extractFeatures(klines, { 
        price: klines[klines.length - 1]?.close || 0 
      });
      
      if (!features) {
        return { valid: false, direction: 0, action: 'HOLD', confidence: 0, source: 'fallback-none' };
      }

      const result = this._fallbackNet.predict(features);
      return {
        valid: result.valid,
        direction: result.direction,
        action: result.action,
        confidence: result.confidence,
        probabilities: result.probabilities,
        source: 'fallback-mlp',
      };
    } catch (e) {
      return { valid: false, direction: 0, action: 'HOLD', confidence: 0, source: 'fallback-error' };
    }
  }

  /**
   * HTTP request helper
   */
  _request(method, path, body = null, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.serviceUrl + path);
      const mod = url.protocol === 'https:' ? require('https') : http;
      
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method,
        headers: {},
        timeout,
      };

      if (body) {
        const data = JSON.stringify(body);
        options.headers['Content-Type'] = 'application/json';
        options.headers['Content-Length'] = Buffer.byteLength(data);
      }

      const req = mod.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Invalid JSON response'));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }
}

module.exports = { MLServiceClient };
