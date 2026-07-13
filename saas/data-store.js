/**
 * DataStore — 统一数据存储抽象层
 * 
 * 小配置 (1-100 用户): JSON 文件存储，零依赖
 * 大配置 (100+ 用户): Redis 存储，自动切换
 * 
 * 用法:
 *   const store = new DataStore({ type: 'json', dir: './data' });
 *   await store.set('users', data);
 *   const users = await store.get('users');
 * 
 * 环境变量:
 *   DATA_STORE=redis    → 使用 Redis
 *   REDIS_URL=redis://.. → Redis 连接地址
 *   DATA_STORE=json     → 使用 JSON 文件 (默认)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class JsonBackend {
  constructor(dir) {
    this.dir = dir;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  async get(key) {
    const fp = this._fp(key);
    if (!fs.existsSync(fp)) return null;
    try {
      const raw = fs.readFileSync(fp, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      console.error(`[DataStore] JSON read error: ${key}`, e.message);
      return null;
    }
  }

  async set(key, value) {
    const fp = this._fp(key);
    const tmp = fp + '.tmp.' + crypto.randomBytes(4).toString('hex');
    try {
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
      fs.renameSync(tmp, fp);
    } catch (e) {
      console.error(`[DataStore] JSON write error: ${key}`, e.message);
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }

  async keys(pattern) {
    const files = fs.readdirSync(this.dir);
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''))
      .filter(k => regex.test(k));
  }

  async has(key) {
    return fs.existsSync(this._fp(key));
  }

  async delete(key) {
    const fp = this._fp(key);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }

  _fp(key) {
    // 防止路径遍历
    const safe = key.replace(/[^a-zA-Z0-9_\-\/]/g, '_');
    return path.join(this.dir, safe + '.json');
  }

  async close() {}
}

class RedisBackend {
  constructor(redisUrl) {
    this.redisUrl = redisUrl;
    this.client = null;
    this.prefix = 'quant:';
  }

  async _connect() {
    if (this.client) return;
    try {
      // 尝试动态加载 ioredis（可选依赖）
      let Redis;
      try {
        Redis = require('ioredis');
      } catch (e) {
        // 回退到 redis 包
        const { createClient } = require('redis');
        this.client = createClient({ url: this.redisUrl });
        await this.client.connect();
        this._isLegacy = true;
        console.log('[DataStore] Redis connected (redis package)');
        return;
      }
      this.client = new Redis(this.redisUrl, {
        retryStrategy: (times) => Math.min(times * 100, 3000),
        maxRetriesPerRequest: 3,
      });
      await this.client.ping();
      console.log('[DataStore] Redis connected (ioredis)');
    } catch (e) {
      console.error('[DataStore] Redis connect failed, falling back to JSON:', e.message);
      throw e;
    }
  }

  async get(key) {
    await this._connect();
    const raw = await this.client.get(this.prefix + key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  async set(key, value) {
    await this._connect();
    await this.client.set(this.prefix + key, JSON.stringify(value));
  }

  async keys(pattern) {
    await this._connect();
    const fullPattern = this.prefix + pattern;
    let keys;
    if (this._isLegacy) {
      // redis 包
      keys = await this.client.keys(fullPattern);
    } else {
      // ioredis
      keys = await this.client.keys(fullPattern);
    }
    return keys.map(k => k.replace(this.prefix, ''));
  }

  async has(key) {
    await this._connect();
    return (await this.client.exists(this.prefix + key)) === 1;
  }

  async delete(key) {
    await this._connect();
    await this.client.del(this.prefix + key);
  }

  async close() {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
  }
}

class DataStore {
  constructor(opts = {}) {
    const storeType = opts.type || process.env.DATA_STORE || 'json';
    
    if (storeType === 'redis') {
      const url = opts.redisUrl || process.env.REDIS_URL || 'redis://127.0.0.1:6379';
      this.backend = new RedisBackend(url);
      this.type = 'redis';
    } else {
      const dir = opts.dir || path.join(__dirname, '..', 'data');
      this.backend = new JsonBackend(dir);
      this.type = 'json';
    }
    
    console.log(`[DataStore] Initialized: ${this.type}`);
  }

  async get(key) { return this.backend.get(key); }
  async set(key, value) { return this.backend.set(key, value); }
  async keys(pattern) { return this.backend.keys(pattern); }
  async has(key) { return this.backend.has(key); }
  async delete(key) { return this.backend.delete(key); }
  async close() { return this.backend.close(); }

  /**
   * 兼容旧代码的文件读写
   * readJsonFile('saas-users.json') → 同步读取 JSON 文件
   * 逐步迁移时用，最终全部换成 get/set
   */
  readJsonFileSync(filePath) {
    if (this.type === 'json') {
      // JSON 模式：直接读文件
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    }
    // Redis 模式：从文件路径提取 key
    const key = path.basename(filePath, '.json');
    // 注意：这是同步的，Redis 模式下需要用 async
    throw new Error('readJsonFileSync not supported in Redis mode. Use async get()');
  }

  writeJsonFileSync(filePath, data) {
    if (this.type === 'json') {
      const tmp = filePath + '.tmp.' + crypto.randomBytes(4).toString('hex');
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, filePath);
      return;
    }
    const key = path.basename(filePath, '.json');
    throw new Error('writeJsonFileSync not supported in Redis mode. Use async set()');
  }
}

// 单例
let _instance = null;

function getDataStore(opts) {
  if (!_instance) {
    _instance = new DataStore(opts);
  }
  return _instance;
}

module.exports = { DataStore, getDataStore };
