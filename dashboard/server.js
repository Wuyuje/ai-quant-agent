/**
 * Dashboard Server v5 - 仪表盘后端
 * 支持多仓位显示 + BSC 链上备份控制
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const { ethers, JsonRpcProvider, Contract } = require('ethers');

// Body parser middleware factory
function createApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  return app;
}

class Dashboard {
  constructor(engine, port, deps = {}) {
    this.engine = engine;
    this.port = port;
    this.app = createApp();
    this.server = null;
    // v112: 注入跨市场组件
    this.capitalRouter = deps.capitalRouter || engine.capitalRouter || null;
    this.sharedRisk = deps.sharedRisk || engine.sharedRisk || null;
    this.signalBus = deps.signalBus || engine.signalBus || null;
    this.crossArb = deps.crossArb || engine.crossArb || null;
    this.goldEngine = deps.goldEngine || engine.goldEngine || null;
    this.forexEngine = deps.forexEngine || engine.forexEngine || null;
    this.symbolEngines = deps.symbolEngines || engine.symbolEngines || {};
    this.cexUserTrader = deps.cexUserTrader || null;
    this.masterdAgent = deps.masterdAgent || engine.masterdAgent || null; // v113: MasterD分身
    this.newsHub = deps.newsHub || engine.news || null; // v113: 新闻中心
    this._setupRoutes();
  }

  _setupRoutes() {
    // 静态文件（禁用缓存确保前端更新即时生效）
    this.app.use((req, res, next) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      next();
    });
    // 管理员仪表盘在根路径 / 提供（b7ec701a 公开URL指向此端口）
    this.app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false }));
    // /admin 代理到 SaaS server 返回 admin.html（兼容旧链接）

    // ═══════════════════════════════════════════
    // v72: 反向代理 — 转发用户认证和仪表盘API到SaaS Server
    // ═══════════════════════════════════════════
    const http = require('http');
    const SAAS_PORT = process.env.SAAS_PORT || 10020;
    const proxyPaths = [
      '/api/auth/', '/api/dashboard', '/api/vault/',
      '/api/user/',
      '/api/backtest',
      '/api/verify-api-key', '/api/cex-mode/', '/api/cex-status',
      '/api/strategy/a/', // v125: 仅代理 A 策略开关接口到 SaaS Server（/api/strategy/switch, /api/strategy/active 等由 dashboard 本地处理）
      '/admin', '/go', '/reg',  // SaaS 页面路由也代理
    ];
    // 注意: /api/admin/ 不代理，dashboard本地处理
    // body-parser 已经消费了 req.body，代理需要用序列化后的 body
    this.app.use((req, res, next) => {
      if (proxyPaths.some(p => req.path.startsWith(p))) {
        const bodyStr = req.body ? JSON.stringify(req.body) : '';
        const headers = { ...req.headers, host: `127.0.0.1:${SAAS_PORT}`, 'content-length': Buffer.byteLength(bodyStr) };
        delete headers['transfer-encoding'];
        const opts = { hostname: '127.0.0.1', port: SAAS_PORT, path: req.url, method: req.method, headers };
        const proxy = http.request(opts, (proxyRes) => { res.writeHead(proxyRes.statusCode, proxyRes.headers); proxyRes.pipe(res); });
        proxy.on('error', () => res.status(502).json({ error: 'Backend unavailable' }));
        if (bodyStr) proxy.write(bodyStr);
        proxy.end();
      } else { next(); }
    });

    // ═══════════════════════════════════════════
    // v120: 管理员认证中间件 — 保护所有非代理API
    // ═══════════════════════════════════════════
    const ADMIN_KEY = process.env.ADMIN_KEY || '';
    const ADMIN_WALLETS = [
      '0xfa3b90c574469909d20848273c06752a22fde74a',
      '0xe6ddf0771c7610dba77eb5a07ba7771dd7f5e91e',
    ];
    // 仪表盘前端通过 header 传递 admin-key 或 Bearer token
    this._adminAuth = (req, res, next) => {
      // 允许通过 ADMIN_KEY 或 session token 认证
      const headerKey = (req.headers['x-admin-key'] || '').trim();
      const bearerToken = (req.headers.authorization || '').replace('Bearer ', '').trim();
      
      // 方式1: ADMIN_KEY 直接认证
      if (ADMIN_KEY && headerKey === ADMIN_KEY) {
        return next();
      }
      
      // 方式2: SaaS session token 认证（验证是否为管理员session）
      if (bearerToken) {
        try {
          const sessionsFile = path.join(__dirname, '..', 'data', 'saas-sessions.json');
          if (fs.existsSync(sessionsFile)) {
            const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
            const sess = sessions[bearerToken];
            if (sess && sess.walletAddress) {
              const isWalletAdmin = ADMIN_WALLETS.some(w => w.toLowerCase() === sess.walletAddress.toLowerCase());
              if (isWalletAdmin || sess.isAdmin) {
                return next();
              }
            }
          }
        } catch(e) { /* session验证失败 */ }
      }
      
      // 方式3: 本地无ADMIN_KEY时拒绝（生产环境必须设置ADMIN_KEY）
      if (!ADMIN_KEY) {
        console.error('[Dashboard] ❌ ADMIN_KEY 未设置！管理员API拒绝访问。请设置环境变量 ADMIN_KEY。');
        return res.status(503).json({ error: 'Server not configured: ADMIN_KEY required' });
      }

      return res.status(401).json({ error: 'Unauthorized: admin access required' });
    };

    // API: 综合状态
    this.app.get('/api/status', async (req, res) => {
      try {
        // v124: running 反映 BBStrategyManager 状态（主引擎已停用，只有 BB 策略在跑）
        const bbMgr = this.bbStrategyManager || this.engine?._bbStrategyManager;
        const bbRunning = !!(bbMgr && bbMgr.running);
        const status = this.engine.getStatus();
        status.running = bbRunning; // 覆盖 engine.running=false，让 watchdog 判定健康
        let totalUserCount = 0;
        try {
          const fs = require('fs');
          const path = require('path');
          const usersFile = path.join(__dirname, '..', 'data', 'saas-users.json');
          if (fs.existsSync(usersFile)) {
            const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
            totalUserCount = Object.keys(users).length;
          }
        } catch(e) {}
        // 余额用引擎缓存的值 — 不每次轮询都打Binance API
        let balance = this.engine._cachedBalance || null;
        // 每30秒才真正刷新一次余额
        const now = Date.now();
        if (!balance || now - (this._balanceLastFetch || 0) > 30000) {
          try {
            const raw = await this.engine.trader.getBalance();
            if (raw && !raw.error) {
              balance = {
                balance: raw.totalUSDT || raw.usdt || (raw.balance?.balance) || 0,
                available: raw.availableBalance || raw.available || (raw.balances?.USDT) || raw.usdt || 0,
                unrealizedPnl: raw.unrealizedPnl || 0,
                balances: raw.balances || raw.balance || {},
              };
              this.engine._cachedBalance = balance;
              this._balanceLastFetch = now;
              this._cachedBalance = balance;
            } else if (raw?.error) {
              balance = this._cachedBalance || { balance: 0, available: 0, unrealizedPnl: 0, _error: 'API限速', _cached: true };
            }
          } catch (e) {
            balance = this._cachedBalance || { balance: 0, available: 0, unrealizedPnl: 0, _error: 'API限速', _cached: true };
          }
        }
        res.json({ ...status, balance, totalUsers: totalUserCount });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // API: 暂停/恢复
    this.app.post('/api/toggle', this._adminAuth, (req, res) => {
      const paused = this.engine.togglePause();
      res.json({ paused });
    });

    // API: 手动平仓
    this.app.post('/api/close/:symbol', this._adminAuth, async (req, res) => {
      try {
        const sym = req.params.symbol;
        const result = await this.engine.trader.closePosition(sym);
        await this.engine.guardian.postCloseVerify(sym);
        // v113.60: 修复 _recordTrade 参数不匹配 — 改用 _recordTradeClose
        const _pos = this.engine.guardian.positions[sym] || {};
        const _closePrice = this.engine.dataBus?.marketData?.[sym]?.price || 0;
        this.engine._recordTradeClose(sym, result.pnl || 0, _closePrice, '手动平仓', _pos.side || 'LONG', _pos.entryPrice || 0, _pos.leverage || 1);
        // v113.60: 清理正确的引擎运行时状态
        delete this.engine._peakPnlPct?.[sym];
        delete this.engine._openTime?.[sym];
        delete this.engine._posATR?.[sym];
        delete this.engine._closedSymbols?.[sym];
        delete this.engine._openedThisScan?.[sym];
        delete this.engine.guardian.positions[sym];
        res.json({ success: true, result });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });

    // API: 引擎启动
    this.app.post('/api/engine/start', this._adminAuth, (req, res) => {
      try {
        const result = this.engine.startEngine();
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // API: 引擎停止
    this.app.post('/api/engine/stop', this._adminAuth, (req, res) => {
      try {
        const result = this.engine.stopEngine();
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // API: 获取配置
    this.app.get('/api/config', (req, res) => {
      res.json(this.engine.getConfig());
    });

    // API: 更新配置
    this.app.post('/api/config', this._adminAuth, (req, res) => {
      try {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          try {
            const updates = JSON.parse(body);
            const applied = this.engine.updateConfig(updates);
            res.json({ success: true, applied });
          } catch (e2) {
            res.status(400).json({ error: 'Invalid JSON' });
          }
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // API: 交易历史
    this.app.get('/api/trades', (req, res) => {
      const limit = parseInt(req.query.limit) || 50;
      const log = this.engine.tradeLog || [];
      res.json(log.slice(-limit));
    });

    // v113.64: K线数据 + 买卖点标记 — 供仪表盘渲染
    this.app.get('/api/klines/:symbol', async (req, res) => {
      try {
        const symbol = req.params.symbol.toUpperCase();
        const interval = req.query.interval || '15m';
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);

        // 1. 获取K线数据 — 优先用 DataBus 缓存
        let klines = this.engine?.dataBus?.klines?.[symbol] || [];

        // 2. 如果 DataBus 没有，从 Binance API 拉
        if (!klines.length) {
          const https = require('https');
          const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
          klines = await new Promise((resolve, reject) => {
            https.get(url, { timeout: 8000 }, (r) => {
              let d = '';
              r.on('data', c => d += c);
              r.on('end', () => {
                try {
                  const raw = JSON.parse(d);
                  resolve(raw.map(k => ({
                    time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
                    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
                  })));
                } catch(e) { reject(e); }
              });
            }).on('error', reject);
          });
        }

        // 3. 获取该交易对的买卖标记 — 从交易记录中找
        const marks = [];

        // 管理员交易记录
        const adminTrades = this.engine?.tradeLog || [];
        for (const t of adminTrades) {
          if (t.symbol === symbol || t.symbol === symbol.replace('USDT', '')) {
            marks.push({
              time: t.timestamp || t.time,
              type: t.action === 'LONG' || t.action === 'BUY' ? 'B' : 'S',
              price: t.price || t.entryPrice,
              side: t.action,
              reason: t.reason || '',
            });
          }
        }

        // 用户 CEX 交易记录
        try {
          const fs = require('fs');
          const path = require('path');
          const cexTradesFile = path.join(__dirname, '..', 'data', 'cex-user-trades.json');
          if (fs.existsSync(cexTradesFile)) {
            const cexTrades = JSON.parse(fs.readFileSync(cexTradesFile, 'utf8'));
            for (const t of cexTrades) {
              if (t.symbol === symbol) {
                marks.push({
                  time: t.timestamp,
                  type: t.action === 'LONG' || t.action === 'BUY' ? 'B' : (t.action === 'CLOSE' ? 'S' : 'S'),
                  price: t.price,
                  side: t.action,
                  reason: t.reason || '',
                });
              }
            }
          }
        } catch(e) { /* ignore */ }

        // 去重并按时间排序
        marks.sort((a, b) => a.time - b.time);

        // 只返回最近的标记（K线范围内的）
        const klineStartTime = klines.length > 0 ? klines[0].time : 0;
        const klineEndTime = klines.length > 0 ? klines[klines.length - 1].time : Date.now();
        const filteredMarks = marks.filter(m => m.time >= klineStartTime && m.time <= klineEndTime + 3600000);

        res.json({
          symbol,
          interval,
          klines: klines.slice(-limit),
          marks: filteredMarks,
          currentPrice: this.engine?.dataBus?.marketData?.[symbol]?.price || 0,
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // v113.64: 用户持仓列表（带K线图数据）
    this.app.get('/api/user/chart-data', async (req, res) => {
      const token = (req.headers.authorization || '').replace('Bearer ', '') || req.headers['x-api-key'];
      const session = token ? (typeof getSession === 'function' ? getSession(token) : null) : null;
      if (!session) return res.status(401).json({ error: '未登录' });

      const wallet = session.wallet?.toLowerCase();
      try {
        const fs = require('fs');
        const path = require('path');

        // 获取用户持仓
        let positions = [];
        const cexTrader = this.engine?.cexUserTrader;
        if (cexTrader) {
          const client = cexTrader._clients?.[wallet];
          if (client) {
            try {
              positions = await client.getAllPositions();
            } catch(e) { /* ignore */ }
          }
        }

        // 获取用户交易记录
        let trades = [];
        const tradesFile = path.join(__dirname, '..', 'data', 'cex-user-trades.json');
        if (fs.existsSync(tradesFile)) {
          const allTrades = JSON.parse(fs.readFileSync(tradesFile, 'utf8'));
          trades = allTrades.filter(t => t.wallet === wallet).slice(-50);
        }

        // 获取每个持仓币的K线
        const charts = {};
        for (const pos of positions) {
          try {
            const symbol = pos.symbol;
            let klines = this.engine?.dataBus?.klines?.[symbol] || [];
            if (!klines.length) {
              // 拉 Binance K线
              const https = require('https');
              const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=80`;
              klines = await new Promise((resolve) => {
                https.get(url, { timeout: 6000 }, (r) => {
                  let d = '';
                  r.on('data', c => d += c);
                  r.on('end', () => {
                    try {
                      const raw = JSON.parse(d);
                      resolve(raw.map(k => ({
                        time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
                        low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
                      })));
                    } catch(e) { resolve([]); }
                  });
                }).on('error', () => resolve([]));
              });
            }

            // 该币种的交易标记
            const marks = trades
              .filter(t => t.symbol === symbol)
              .map(t => ({
                time: t.timestamp,
                type: t.action === 'LONG' ? 'B' : 'S',
                price: t.price,
                side: t.action,
                reason: t.reason || '',
              }))
              .sort((a, b) => a.time - b.time);

            charts[symbol] = { klines, marks, currentPrice: pos.markPrice };
          } catch(e) { /* skip */ }
        }

        res.json({ positions, charts, trades });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // API: AI决策统计
    this.app.get('/api/decisions', (req, res) => {
      try {
        if (this.engine.aiEngine && typeof this.engine.aiEngine.getStats === 'function') {
          res.json(this.engine.aiEngine.getStats());
        } else {
          res.json({ total: 0, wins: 0, losses: 0, message: 'AI 引擎未初始化' });
        }
      } catch (e) {
        res.json({ total: 0, wins: 0, losses: 0, error: e.message });
      }
    });

    // API: DeepSeek 大模型状态
    this.app.get('/api/deepseek/status', (req, res) => {
      try {
        const ds = this.engine.aiEngine && this.engine.aiEngine.deepseek;
        if (!ds) return res.json({ connected: false, reason: '未初始化' });
        res.json({
          connected: !!ds.apiKey,
          model: ds.model,
          apiKeyPrefix: ds.apiKey ? ds.apiKey.slice(0, 8) + '...' : 'N/A',
          strategyParams: ds.strategyParams,
          performance: typeof ds.getPerformanceSummary === 'function' ? ds.getPerformanceSummary() : {},
        });
      } catch (e) {
        res.json({ connected: false, error: e.message });
      }
    });

    // API: 余额
    this.app.get('/api/balance', async (req, res) => {
      // 直接返回缓存 — 不再每次都调Binance API
      // 余额由 /api/status 每30秒刷新一次，这里复用缓存
      const balance = this._cachedBalance || this.engine._cachedBalance || { balance: 0, available: 0, unrealizedPnl: 0 };
      res.json(balance);
    });

    // API: 备份状态
    this.app.get('/api/backup/status', (req, res) => {
      try {
        const backupStatus = this.engine.backupManager.getStatus();
        res.json(backupStatus);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // API: 手动触发链上备份
    this.app.post('/api/backup/trigger', this._adminAuth, async (req, res) => {
      try {
        const result = await this.engine.backupManager.backupNow();
        res.json({ success: true, result });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });

    // ═══════════════════════════════
    // v64 新增 API
    // ═══════════════════════════════

    // API: 神经网络状态
    this.app.get('/api/neural-net', (req, res) => {
      try {
        const sm = this.engine?.strategyManager;
        const nn = sm?.neuralNet || sm?.strategies?.neuralNet;
        if (!nn) return res.json({ enabled: false });
        const stats = nn.getStats ? nn.getStats() : {};
        const model = nn.model || {};
        res.json({
          enabled: true,
          trainCount: stats.trainCount || model.trainCount || 0,
          accuracy: stats.avgAccuracy || stats.accuracy || model.accuracy || 0,
          loss: stats.loss || model.loss || 0,
          lastTrain: model.lastTrain || 0,
          layers: model.architecture || [8, 16, 8, 1],
          sampleCount: model.sampleCount || 0,
          predictions: stats.recentPredictions || [],
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // API: 策略信号
    this.app.get('/api/strategy-signals', (req, res) => {
      try {
        const sm = this.engine?.strategyManager;
        if (!sm) return res.json({ strategies: [], signals: [] });
        const signals = [];
        const marketData = this.engine.dataBus?.marketData || {};
        // v112: 读取引擎最近的信号分析
        const lastSignals = this.engine._lastSignals || [];
        const signalMap = {};
        for (const s of lastSignals) {
          signalMap[s.symbol] = s;
        }
        for (const [sym, md] of Object.entries(marketData)) {
          if (!md.price) continue;
          const cached = signalMap[sym];
          if (cached) {
            signals.push({
              symbol: sym,
              price: md.price,
              change: md.change24h || md.change || 0,
              signal: cached.dir === 'LONG' ? 'BUY' : cached.dir === 'SHORT' ? 'SELL' : 'NEUTRAL',
              score: cached.score || cached.strength || 0,
              strength: cached.strength || 0,
              confidence: cached.confidence || 0,
            });
          } else {
            signals.push({
              symbol: sym,
              price: md.price,
              change: md.change24h || md.change || 0,
              signal: 'NEUTRAL',
              score: 0,
              strength: 0,
              confidence: 0,
            });
          }
        }
        res.json({
          strategies: sm.strategies ? Object.keys(sm.strategies) : [],
          signals: signals.slice(0, 30),
          activeCount: signals.filter(s => s.signal !== 'NEUTRAL').length,
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // API: DEX 聚合器报价
    this.app.get('/api/dex-quotes', async (req, res) => {
      try {
        // v112: 从 Dexscreener API 获取实时 DEX 报价
        const https = require('https');
        const dexPairs = [
          { url: 'https://api.dexscreener.com/latest/dex/pairs/bsc/0xcaaf3c41a40103a23eeaa4bba468af3cf5b0e0d8', tokenIn: 'ARK', tokenOut: 'USDT' },
        ];
        const quotes = [];
        for (const pair of dexPairs) {
          try {
            const data = await new Promise((resolve, reject) => {
              https.get(pair.url, (resp) => {
                let body = '';
                resp.on('data', d => body += d);
                resp.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
              }).on('error', reject);
              setTimeout(() => reject(new Error('timeout')), 5000);
            });
            if (data && data.pair) {
              const p = data.pair;
              quotes.push({
                tokenIn: pair.tokenIn,
                tokenOut: pair.tokenOut,
                routes: [{ dex: p.dexId || 'PancakeSwap', amountOut: p.priceUsd || '0' }],
                bestDex: p.dexId || 'PancakeSwap',
                price: p.priceUsd,
                liquidity: p.liquidity?.usd || 0,
                timestamp: Date.now(),
              });
            }
          } catch(e) {}
        }
        res.json({
          quotes,
          dexList: ['PancakeSwap V2', 'Biswap', 'ApeSwap'],
          enabled: true,
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // API: TWAP/VWAP 执行状态
    this.app.get('/api/twap-status', (req, res) => {
      try {
        const twapPath = require('path').join(__dirname, '..', 'data', 'twap-vwap-trades.json');
        const fs = require('fs');
        let trades = [];
        if (fs.existsSync(twapPath)) {
          trades = JSON.parse(fs.readFileSync(twapPath, 'utf8'));
        }
        const active = trades.filter(t => t.status === 'running' || t.status === 'pending');
        res.json({
          activeOrders: active,
          history: trades.slice(-20).reverse(),
          totalOrders: trades.length,
          activeCount: active.length,
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // API: 自动训练状态
    this.app.get('/api/auto-trainer', (req, res) => {
      try {
        const at = this.engine?.autoTrainer;
        if (!at) return res.json({ enabled: false });
        res.json({
          enabled: true,
          ...at.getStatus(),
          history: at.getHistory ? at.getHistory(10) : [],
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // API: 通知历史
    this.app.get('/api/notifications', (req, res) => {
      try {
        const n = this.engine?.notifier;
        if (!n) return res.json({ notifications: [], enabled: false });
        res.json({
          notifications: n.getHistory ? n.getHistory(50) : [],
          enabled: true,
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // API: 全市场总览（28个交易对）
    this.app.get('/api/market-overview', (req, res) => {
      try {
        const marketData = this.engine.dataBus?.marketData || {};
        const overview = [];
        for (const [sym, md] of Object.entries(marketData)) {
          overview.push({
            symbol: sym,
            price: md.price || 0,
            change24h: md.change24h || 0,
            volume: md.volume || 0,
            high24h: md.high24h || 0,
            low24h: md.low24h || 0,
          });
        }
        // 按成交量排序
        overview.sort((a, b) => (b.volume || 0) - (a.volume || 0));
        res.json({
          symbols: overview,
          total: overview.length,
          gainers: overview.filter(s => s.change24h > 0).length,
          losers: overview.filter(s => s.change24h < 0).length,
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // API: 多用户全局状态（如果有多用户系统）
    this.app.get('/api/admin/users', this._adminAuth, async (req, res) => {
      try {
        // 优先尝试 MultiEngine（多用户模式）
        const multiEngine = this.engine.multiEngine || this.engine._multiEngine;
        if (multiEngine && multiEngine.users && Object.keys(multiEngine.users).length > 0) {
          const userList = [];
          for (const [uid, engine] of Object.entries(multiEngine.users)) {
            try {
              const status = engine.getStatus();
              const balance = await engine.trader.getBalance().catch(() => null);
              userList.push({
                userId: uid,
                wallet: engine.userConfig?.wallet || uid,
                running: status.running,
                cycleCount: status.cycleCount,
                positions: status.positions,
                positionCount: status.positionCount,
                balance: balance || { balance: 0, available: 0, unrealizedPnl: 0 },
                totalPnl: status.stats?.totalPnl || 0,
                wins: status.stats?.wins || 0,
                losses: status.stats?.losses || 0,
                totalTrades: status.stats?.totalTrades || 0,
                winRate: status.winRate,
                strategy: engine.userConfig?.strategy || 'balanced',
                recentTrades: status.recentTrades || [],
                uptime: status.uptime,
              });
            } catch (e) { /* skip user */ }
          }
          return res.json({ multiUserMode: true, totalUsers: userList.length, activeUsers: userList.filter(u=>u.running).length, users: userList });
        }

        // SaaS 模式 — 从 saas-users.json + user-trader-state.json + cex-user-trader-state.json 读取所有注册用户
        const fs = require('fs');
        const path = require('path');
        const usersFile = path.join(__dirname, '..', 'data', 'saas-users.json');
        const traderStateFile = path.join(__dirname, '..', 'data', 'user-trader-state.json');
        const cexStateFile = path.join(__dirname, '..', 'data', 'cex-user-trader-state.json');
        const cexTradesFile = path.join(__dirname, '..', 'data', 'cex-user-trades.json');

        let saasUsers = {};
        try { saasUsers = JSON.parse(fs.readFileSync(usersFile, 'utf8')); } catch(e) {}

        let traderState = { userStates: {} };
        try { traderState = JSON.parse(fs.readFileSync(traderStateFile, 'utf8')); } catch(e) {}

        let cexState = { states: {}, stats: {} };
        try { cexState = JSON.parse(fs.readFileSync(cexStateFile, 'utf8')); } catch(e) {}

        let cexTrades = [];
        try { cexTrades = JSON.parse(fs.readFileSync(cexTradesFile, 'utf8')); } catch(e) {}

        // 管理员钱包地址
        const bbMgr = this.bbStrategyManager || this.engine?._bbStrategyManager;
        const adminWallet = bbMgr?.ADMIN_WALLETS?.[0] || '0xfa3b90c574469909d20848273c06752a22fde74a';

        // 管理员引擎数据（当前运行中的 Engine）
        const adminStatus = this.engine.getStatus();
        // B策略模式下engine是dummy，trader可能为null
        let adminBalance = null;
        let bbRunning = false, bbCycle = 0, bbAdminPositions = null, bbAdminPnl = 0;
        if (bbMgr) {
          const adminBb = bbMgr.getAdminStatus?.();
          if (adminBb) {
            adminBalance = { balance: adminBb.balance || 0, available: 0, unrealizedPnl: 0 };
            bbRunning = bbMgr.running || false;
            bbCycle = bbMgr._cycleCount || 0;
            bbAdminPositions = adminBb.positions || null;
            bbAdminPnl = adminBb.totalPnlUsd || 0;
          }
        }
        if (!adminBalance && this.engine.trader && typeof this.engine.trader.getBalance === 'function') {
          try { adminBalance = await this.engine.trader.getBalance(); } catch(e) {}
        }

        const userList = [];

        // BB策略返回的positions是数组，前端需要字典格式
        let adminPosDict = {};
        if (Array.isArray(bbAdminPositions)) {
          for (const p of bbAdminPositions) {
            adminPosDict[p.symbol] = {
              side: p.side,
              entryPrice: p.entryPrice,
              amount: p.qty,
              qty: p.qty,
              leverage: p.leverage,
              pnl: p.pnlUsd,
              markPrice: p.currentPrice,
              openTime: p.openTime,
              _source: 'bb-realtime',
            };
          }
        }

        // 添加管理员自己
        userList.push({
          userId: 'admin',
          wallet: '管理员',
          walletFull: adminWallet,
          running: (this.engine.running || false) || (bbRunning),
          cycleCount: bbCycle || this.engine.cycleCount || 0,
          positions: Object.keys(adminPosDict).length > 0 ? adminPosDict : (adminStatus.positions || {}),
          positionCount: Object.keys(adminPosDict).length || adminStatus.positionCount || 0,
          balance: adminBalance || { balance: 0, available: 0, unrealizedPnl: 0 },
          totalPnl: bbAdminPnl || adminStatus.state?.totalPnl || 0,
          wins: adminStatus.state?.wins || 0,
          losses: adminStatus.state?.losses || 0,
          totalTrades: adminStatus.state?.totalTrades || 0,
          winRate: (adminStatus.state?.totalTrades > 0)
            ? ((adminStatus.state.wins / adminStatus.state.totalTrades) * 100).toFixed(1) + '%'
            : 'N/A',
          strategy: 'admin',
          exchangeMode: saasUsers[adminWallet]?.exchangeMode || saasUsers[adminWallet.toLowerCase()]?.exchangeMode || 'cex',
          recentTrades: adminStatus.recentTrades || [],
          uptime: 0,
        });

        // 添加所有注册用户
        // v101: 对有API Key的CEX用户实时查询余额和持仓
        const { decrypt: _decryptKey } = require('../core/crypto-utils');
        const https2 = require('https');
        const crypto2 = require('crypto');

        // 内联轻量CEX查询（避免循环依赖）
        async function cexBalanceQuery(apiKey, apiSecret) {
          return new Promise((resolve) => {
            try {
              const qs = 'timestamp=' + Date.now() + '&recvWindow=5000';
              const sig = crypto2.createHmac('sha256', apiSecret).update(qs).digest('hex');
              const req = https2.request({ hostname: 'fapi.binance.com', path: '/fapi/v3/balance?' + qs + '&signature=' + sig, method: 'GET', headers: { 'X-MBX-APIKEY': apiKey } }, res => {
                let d = ''; res.on('data', c => d += c);
                res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
              });
              req.on('error', () => resolve(null));
              req.setTimeout(5000, () => { req.destroy(); resolve(null); });
              req.end();
            } catch(e) { resolve(null); }
          });
        }
        async function cexPositionsQuery(apiKey, apiSecret) {
          return new Promise((resolve) => {
            try {
              const qs = 'timestamp=' + Date.now() + '&recvWindow=5000';
              const sig = crypto2.createHmac('sha256', apiSecret).update(qs).digest('hex');
              const req = https2.request({ hostname: 'fapi.binance.com', path: '/fapi/v3/positionRisk?' + qs + '&signature=' + sig, method: 'GET', headers: { 'X-MBX-APIKEY': apiKey } }, res => {
                let d = ''; res.on('data', c => d += c);
                res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
              });
              req.on('error', () => resolve(null));
              req.setTimeout(5000, () => { req.destroy(); resolve(null); });
              req.end();
            } catch(e) { resolve(null); }
          });
        }

        for (const [addr, u] of Object.entries(saasUsers)) {
          const userState = traderState.userStates?.[addr] || { positions: {} };
          const positions = userState.positions || {};
          // 合并CEX持仓（静态来源）
          const cexPositions = cexState.states?.[addr]?.positions || {};
          const allPositions = { ...positions };
          for (const [sym, cp] of Object.entries(cexPositions)) {
            allPositions['CEX_' + sym] = cp;
          }

          const tradeAmount = u.tradeAmount || 0;

          // CEX交易统计
          const cexStats = cexState.stats?.[addr] || {};
          const userCexTrades = cexTrades.filter(t => t.wallet === addr);
          const wins = (traderState.userStats?.[addr]?.wins || 0) + (cexStats.wins || 0);
          const losses = (traderState.userStats?.[addr]?.losses || 0) + (cexStats.losses || 0);
          const totalPnl = (traderState.userStats?.[addr]?.totalPnl || 0) + (cexStats.totalPnl || 0) || 0;
          const totalTrades = wins + losses;
          const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) + '%' : 'N/A';

          // v101: 实时查询CEX余额和持仓
          let realBalance = u.usdtBalance || 0;
          let realPositions = { ...allPositions };
          let positionCount = Object.keys(realPositions).length;
          let unrealizedPnl = 0;
          let cexApiKeyValid = !!u.binanceApiKey;

          if (u.binanceApiKey && u.binanceSecret) {
            // v101: 解密API Key
            const realApiKey = _decryptKey(u.binanceApiKey);
            const realApiSecret = _decryptKey(u.binanceSecret);
            // 实时查余额
            const balData = await cexBalanceQuery(realApiKey, realApiSecret);
            if (Array.isArray(balData)) {
              const usdtCex = balData.find(b => b.asset === 'USDT');
              if (usdtCex) {
                realBalance = parseFloat(usdtCex.balance) || 0;
                unrealizedPnl = parseFloat(usdtCex.crossUnPnl) || 0;
              }
            } else if (balData && balData.code) {
              // API Key无效，标记
              cexApiKeyValid = false;
              // 不清空余额，保留上次的显示
            }

            // 实时查持仓
            const posData = await cexPositionsQuery(realApiKey, realApiSecret);
            if (Array.isArray(posData)) {
              // 用链上真实持仓替换静态持仓
              realPositions = {};
              for (const p of posData) {
                const amt = Math.abs(parseFloat(p.positionAmt));
                if (amt === 0) continue;
                realPositions[p.symbol] = {
                  side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
                  entryPrice: parseFloat(p.entryPrice),
                  amount: amt,
                  qty: amt,
                  leverage: parseInt(p.leverage) || 3,
                  pnl: parseFloat(p.unRealizedProfit) || 0,
                  markPrice: parseFloat(p.markPrice) || 0,
                  openTime: cexState.states?.[addr]?.positions?.[p.symbol]?.openTime || 0,
                  sl: cexState.states?.[addr]?.positions?.[p.symbol]?.sl || 0,
                  tp: cexState.states?.[addr]?.positions?.[p.symbol]?.tp || 0,
                  _source: 'realtime',
                };
              }
              positionCount = Object.keys(realPositions).length;
            }
          } else {
            // 无API Key的普通用户 — 用BSC链上余额
            try {
              const bscData = await new Promise((resolve) => {
                const body = JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getBalance',params:[addr,'latest']});
                const req = https2.request({hostname:'bsc-rpc.publicnode.com',path:'/',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}}, res => {
                  let d=''; res.on('data',c=>d+=c); res.on('end',()=>{try{resolve(JSON.parse(d))}catch(e){resolve(null)}});
                });
                req.on('error',()=>resolve(null));
                req.write(body); req.end();
              });
              if (bscData?.result) {
                const bnbBal = parseInt(bscData.result,16)/1e18;
                // 也查USDT
                const usdtAddr = '0x55d398326f99059fF775485246999027B3197955';
                const callData = '0x70a08231' + addr.slice(2).padStart(64,'0');
                const usdtData = await new Promise((resolve) => {
                  const body2 = JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to:usdtAddr,data:callData},'latest']});
                  const req2 = https2.request({hostname:'bsc-rpc.publicnode.com',path:'/',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body2)}}, res => {
                    let d=''; res.on('data',c=>d+=c); res.on('end',()=>{try{resolve(JSON.parse(d))}catch(e){resolve(null)}});
                  });
                  req2.on('error',()=>resolve(null));
                  req2.write(body2); req2.end();
                });
                const usdtBal = usdtData?.result ? parseInt(usdtData.result,16)/1e18 : 0;
                realBalance = usdtBal; // 用链上USDT
              }
            } catch(e) {}
          }

          // 从BB策略管理器获取该用户的实时持仓
          const bbUserStatus = bbMgr?.getAllUsersStatus?.()?.find(s => s.wallet?.toLowerCase() === addr.toLowerCase());
          if (bbUserStatus) {
            // BB策略持仓覆盖静态持仓
            if (bbUserStatus.positions && bbUserStatus.positions.length > 0) {
              realPositions = {};
              for (const p of bbUserStatus.positions) {
                realPositions[p.symbol] = {
                  side: p.side,
                  entryPrice: p.entryPrice,
                  amount: p.qty,
                  qty: p.qty,
                  leverage: p.leverage,
                  pnl: p.pnlUsd,
                  markPrice: p.currentPrice,
                  openTime: p.openTime,
                  _source: 'bb-realtime',
                };
              }
              positionCount = Object.keys(realPositions).length;
            }
            unrealizedPnl = bbUserStatus.totalPnlUsd || unrealizedPnl;
          }

          userList.push({
            userId: addr,
            wallet: addr.slice(0, 6) + '...' + addr.slice(-4),
            walletFull: addr,
            running: (u.tradingEnabled && cexApiKeyValid) || !!bbUserStatus,
            cycleCount: userState.lastCycle || 0,
            positions: realPositions,
            positionCount: positionCount,
            balance: { balance: realBalance, available: realBalance, unrealizedPnl: unrealizedPnl },
            tradeAmount: tradeAmount,
            totalPnl: totalPnl,
            unrealizedPnl: unrealizedPnl,
            wins: wins,
            losses: losses,
            totalTrades: totalTrades,
            winRate: winRate,
            cexTrades: userCexTrades.slice(-10).reverse(),
            strategy: u.strategy || 'balanced',
            recentTrades: userCexTrades.slice(-5).reverse(),
            hasApiKey: !!u.binanceApiKey,
            cexApiKeyValid: cexApiKeyValid,
            // 算力 Token状态
            bscWalletAddr: u.bscWalletAddr || null,
            gatesFeeBalance: u.gatesFeeBalance || 0,
            gatesFeeApproved: u.gatesFeeApproved || false,
            gatesFeeLow: u.gatesFeeLow || false,
            exchangeMode: u.exchangeMode || 'cex', // 'cex' | 'dex'
            uptime: u.lastActive ? Math.floor((Date.now() - u.lastActive) / 1000) : 0,
          });
        }

        res.json({
          multiUserMode: false,
          totalUsers: userList.length,
          activeUsers: userList.filter(u => u.running).length,
          users: userList,
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // ═══════════════════════════════
    // v65 新增：回测+网格搜索+资金费率套利 API
    // ═══════════════════════════════

    // ═══ 注销/删除普通用户 (管理员专用) ═══
    this.app.post('/api/admin/delete-user', this._adminAuth, async (req, res) => {
      try {
        const { wallet } = req.body;
        if (!wallet) return res.status(400).json({ error: '缺少钱包地址' });

        const fs = require('fs');
        const pathMod = require('path');
        const usersFile = pathMod.join(__dirname, '..', 'data', 'saas-users.json');

        // 管理员钱包不可注销
        const ADMIN_WALLETS = [
          '0xfa3b90c574469909d20848273c06752a22fde74a',
          '0xe6ddf0771c7610dba77eb5a07ba7771dd7f5e91e',
        ];
        if (ADMIN_WALLETS.some(w => w.toLowerCase() === wallet.toLowerCase())) {
          return res.status(403).json({ error: '不能注销管理员账户' });
        }

        // 读取用户数据
        let saasUsers = {};
        try { saasUsers = JSON.parse(fs.readFileSync(usersFile, 'utf8')); } catch(e) {}
        if (!saasUsers[wallet.toLowerCase()] && !saasUsers[wallet]) {
          return res.status(404).json({ error: '用户不存在' });
        }
        const userKey = saasUsers[wallet.toLowerCase()] ? wallet.toLowerCase() : wallet;
        const userInfo = saasUsers[userKey];

        // 停止该用户的BB引擎
        const bbMgr = this.bbStrategyManager || this.engine?._bbStrategyManager;
        if (bbMgr && bbMgr._engines && bbMgr._engines[userKey]) {
          try {
            bbMgr._engines[userKey].stop();
            delete bbMgr._engines[userKey];
            console.log(`[Dashboard] 已停止用户 ${userKey.slice(0,10)}... 的BB引擎`);
          } catch(e) { console.log(`[Dashboard] 停止引擎失败: ${e.message}`); }
        }

        // 从saas-users.json删除用户
        delete saasUsers[userKey];
        fs.writeFileSync(usersFile, JSON.stringify(saasUsers, null, 2));

        // 清除该用户的session
        try {
          const sessionsFile = pathMod.join(__dirname, '..', 'data', 'saas-sessions.json');
          if (fs.existsSync(sessionsFile)) {
            const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
            let removed = 0;
            for (const [token, sess] of Object.entries(sessions)) {
              if (sess.walletAddress && sess.walletAddress.toLowerCase() === userKey.toLowerCase()) {
                delete sessions[token];
                removed++;
              }
            }
            if (removed > 0) {
              fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2));
              console.log(`[Dashboard] 清除 ${removed} 个session`);
            }
          }
        } catch(e) { console.log(`[Dashboard] 清除session失败: ${e.message}`); }

        // 清除该用户的交易状态
        try {
          const cexStateFile = pathMod.join(__dirname, '..', 'data', 'cex-user-trader-state.json');
          if (fs.existsSync(cexStateFile)) {
            const cexState = JSON.parse(fs.readFileSync(cexStateFile, 'utf8'));
            if (cexState.states) delete cexState.states[userKey];
            if (cexState.stats) delete cexState.stats[userKey];
            fs.writeFileSync(cexStateFile, JSON.stringify(cexState, null, 2));
          }
        } catch(e) { console.log(`[Dashboard] 清除CEX状态失败: ${e.message}`); }

        console.log(`[Dashboard] ✅ 用户 ${userKey.slice(0,10)}... 已注销`);
        res.json({
          success: true,
          message: `用户 ${userKey.slice(0,6)}...${userKey.slice(-4)} 已注销`,
          deletedWallet: userKey,
          userInfo: { strategy: userInfo.strategy, tradeAmount: userInfo.tradeAmount },
        });
      } catch (e) {
        console.error('[Dashboard] 注销用户失败:', e);
        res.status(500).json({ error: '注销失败: ' + e.message });
      }
    });

    const _fs = require('fs');
    const _backtestDataDir = path.join(__dirname, '..', 'data');

    // API: 策略回测报告
    this.app.get('/api/backtest-report', (req, res) => {
      try {
        const reportPath = path.join(_backtestDataDir, 'backtest-report.json');
        if (!_fs.existsSync(reportPath)) return res.json({ enabled: false, message: '回测尚未运行' });
        const report = JSON.parse(_fs.readFileSync(reportPath, 'utf8'));
        res.json({
          enabled: true,
          timestamp: report.timestamp,
          perSymbol: report.perSymbol || {},
          multiSymbol: report.multiSymbol || {},
          ranking: report.ranking || [],
          garbage: report.garbage || [],
          weak: report.weak || [],
          good: report.good || [],
          excellent: report.excellent || [],
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // API: 网格搜索报告
    this.app.get('/api/grid-search-report', (req, res) => {
      try {
        const reportPath = path.join(_backtestDataDir, 'grid-search-report.json');
        if (!_fs.existsSync(reportPath)) return res.json({ enabled: false, message: '网格搜索尚未运行' });
        const report = JSON.parse(_fs.readFileSync(reportPath, 'utf8'));
        res.json({
          enabled: true,
          timestamp: report.timestamp,
          totalCombos: report.totalCombos || 0,
          best: report.best || {},
          top20: report.top20 || [],
          sensitivity: report.sensitivity || {},
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // API: 资金费率套利报告
    this.app.get('/api/funding-arb-report', (req, res) => {
      try {
        const reportPath = path.join(_backtestDataDir, 'funding-arb-report.json');
        if (!_fs.existsSync(reportPath)) return res.json({ enabled: false, message: '资金费率套利尚未运行' });
        const report = JSON.parse(_fs.readFileSync(reportPath, 'utf8'));
        res.json({
          enabled: true,
          timestamp: report.timestamp,
          currentOpportunities: report.currentOpportunities || [],
          backtestResults: report.backtestResults || [],
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // API: 触发回测（异步执行）
    this.app.post('/api/run-backtest', (req, res) => {
      try {
        const { execFile } = require('child_process');
        const scriptPath = path.join(__dirname, '..', 'backtest', 'strategy-backtest.js');
        execFile("node", [scriptPath], { cwd: path.join(__dirname, '..'), timeout: 120000 }, (err) => {
          if (err) console.error('[Backtest] error:', err.message);
          else console.log('[Backtest] done');
        });
        res.json({ success: true, message: '回测已启动，约30-60秒后完成' });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // API: 触发网格搜索（异步执行）
    this.app.post('/api/run-grid-search', this._adminAuth, (req, res) => {
      try {
        const { execFile } = require('child_process');
        const scriptPath = path.join(__dirname, '..', 'backtest', 'grid-search.js');
        execFile("node", [scriptPath], { cwd: path.join(__dirname, '..'), timeout: 600000 }, (err) => {
          if (err) console.error('[GridSearch] error:', err.message);
          else console.log('[GridSearch] done');
        });
        res.json({ success: true, message: '网格搜索已启动，约5-10分钟后完成' });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // API: 触发资金费率套利扫描（异步执行）
    this.app.post('/api/run-funding-arb', this._adminAuth, (req, res) => {
      try {
        const { execFile } = require('child_process');
        const scriptPath = path.join(__dirname, '..', 'backtest', 'funding-arb.js');
        execFile("node", [scriptPath], { cwd: path.join(__dirname, '..'), timeout: 60000 }, (err) => {
          if (err) console.error('[FundingArb] error:', err.message);
          else console.log('[FundingArb] done');
        });
        res.json({ success: true, message: '资金费率套利扫描已启动，约15-30秒后完成' });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // ═══════════════════════════════
    // v66 新增 API: 5个新策略
    // ═══════════════════════════════

    // v73: stat-arb已禁用
    this.app.get('/api/stat-arb', (req, res) => res.json({ enabled: false }));

    // v73: market-maker已禁用
    this.app.get('/api/market-maker', (req, res) => res.json({ enabled: false }));

    // v73: options-greeks已禁用
    this.app.get('/api/options-greeks', (req, res) => res.json({ enabled: false }));

    // API: 期权定价计算
    this.app.post('/api/options-price', this._adminAuth, (req, res) => {
      try {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          const { type, S, K, T, r, sigma } = JSON.parse(body);
          const sm = this.engine?.strategyManager;
          // v73: options-greeks已禁用
          if (!og) return res.status(500).json({ error: 'OptionsGreeks not initialized' });
          const price = og.priceOption(type, S, K, T, r || 0.05, sigma);
          const greeks = og.calculateGreeks(type, S, K, T, r || 0.05, sigma);
          res.json({ price, greeks });
        });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // API: MEV检测
    this.app.get('/api/mev', (req, res) => {
      try {
        const sm = this.engine?.strategyManager;
        // v73: mev-bot已禁用
        const opportunities = [];
        res.json({ enabled: true, summary, signal, opportunities });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // API: MEV三明治开关
    this.app.post('/api/mev/toggle-sandwich', this._adminAuth, (req, res) => {
      try {
        const sm = this.engine?.strategyManager;
        // v73: mev-bot已禁用
        const enabled = false;
        res.json({ success: true, sandwichEnabled: enabled });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // API: 多服务器监控
    this.app.get('/api/multi-server', (req, res) => {
      try {
        const sm = this.engine?.strategyManager;
        // v73: multi-server已禁用
        const signal = {};
        res.json({ enabled: true, dashboard, signal });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // API: 添加服务器
    this.app.post('/api/multi-server/add', this._adminAuth, (req, res) => {
      try {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          const cfg = JSON.parse(body);
          const sm = this.engine?.strategyManager;
          // v73: multi-server已禁用
          const result = {};
          res.json(result);
        });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // API: 手动健康检查
    this.app.post('/api/multi-server/health-check', this._adminAuth, async (req, res) => {
      try {
        const sm = this.engine?.strategyManager;
        // v73: multi-server已禁用
        const results = [];
        res.json({ success: true, results });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ═══════════════════════════════════════════
    // v66: 策略配置API + 回测API
    // ═══════════════════════════════════════════

    // 策略权重配置
    this.app.get('/api/strategy-config', (req, res) => {
      try {
        const sm = this.engine?.strategyManager;
        if (!sm) return res.status(500).json({ error: 'StrategyManager not initialized' });
        res.json(sm.getStrategyConfig());
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    this.app.post('/api/strategy-config/weight', this._adminAuth, (req, res) => {
      try {
        const sm = this.engine?.strategyManager;
        if (!sm) return res.status(500).json({ error: 'StrategyManager not initialized' });
        const { strategy, weight } = req.body;
        const result = sm.setWeight(strategy, parseFloat(weight));
        res.json(result);
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    this.app.post('/api/strategy-config/toggle', this._adminAuth, (req, res) => {
      try {
        const sm = this.engine?.strategyManager;
        if (!sm) return res.status(500).json({ error: 'StrategyManager not initialized' });
        const { strategy, enabled } = req.body;
        const result = sm.toggleStrategy(strategy, enabled);
        res.json(result);
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 所有策略摘要
    this.app.get('/api/strategies-summary', (req, res) => {
      try {
        const sm = this.engine?.strategyManager;
        if (!sm) return res.status(500).json({ error: 'StrategyManager not initialized' });
        res.json(sm.getAllSummaries());
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ═══════════════════════════════════════════
    // v71: 用户 Binance API Key 验证 + 服务器IP
    // ═══════════════════════════════════════════

    // API: 获取服务器公网IP（用于IP白名单设置）
    this.app.get('/api/server-ip', async (req, res) => {
      try {
        const https2 = require('https');
        const ip = await new Promise((resolve, reject) => {
          https2.get('https://api.ipify.org?format=json', { timeout: 5000 }, (r) => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => { try { resolve(JSON.parse(d).ip); } catch(e) { reject(e); } });
          }).on('error', reject);
        });
        res.json({ ip });
      } catch (e) {
        res.json({ ip: null, error: '无法获取服务器IP' });
      }
    });

    // API: 验证用户 Binance API Key（v121: 强制检查 Withdraw 提现权限）
    this.app.post('/api/verify-api-key', async (req, res) => {
      try {
        const { apiKey, secretKey, walletAddress } = req.body;
        if (!apiKey || !secretKey) {
          return res.json({ success: false, error: '请提供 API Key 和 Secret Key' });
        }

        const crypto = require('crypto');
        const https2 = require('https');

        // ═══════ v121: 第一步 — 验证 Futures 交易权限 ═══════
        const ts1 = Date.now();
        const qs1 = `timestamp=${ts1}`;
        const sig1 = crypto.createHmac('sha256', secretKey).update(qs1).digest('hex');
        const futuresUrl = `https://fapi.binance.com/fapi/v3/balance?${qs1}&signature=${sig1}`;

        let accountData = null;
        let isFutures = false;
        let usdtBalance = 0;
        try {
          accountData = await new Promise((resolve, reject) => {
            const req2 = https2.get(futuresUrl, {
              headers: { 'X-MBX-APIKEY': apiKey },
              timeout: 10000,
            }, (r) => {
              let d = '';
              r.on('data', c => d += c);
              r.on('end', () => {
                try {
                  const json = JSON.parse(d);
                  if (json.code) reject(new Error(json.msg || 'Futures验证失败'));
                  else resolve(json);
                } catch(e) { reject(e); }
              });
            });
            req2.on('error', reject);
            req2.setTimeout(10000, () => { req2.destroy(); reject(new Error('请求超时')); });
          });
          isFutures = true;
          const usdt = (accountData || []).find(b => b.asset === 'USDT');
          usdtBalance = usdt ? parseFloat(usdt.balance || 0) : 0;
        } catch (e) {
          let errMsg = e.message || '';
          if (errMsg.includes('-1002') || errMsg.includes('authorized')) {
            return res.json({ success: false, error: 'API Key 没有开启「合约交易」权限，请在 Binance API 管理页面勾选后重新创建', needFutures: true });
          }
          return res.json({ success: false, error: 'Futures API 验证失败: ' + errMsg });
        }

        // ═══════ v121: 第二步 — 验证 Withdraw 提现权限（必须）═══════
        // 用 /sapi/v1/capital/config/getall 检测提现权限
        // 返回 -1002 = 没有 Withdraw 权限 → 拒绝绑定
        // 返回 network 列表 = 有 Withdraw 权限 → 允许绑定
        const ts2 = Date.now();
        const qs2 = `timestamp=${ts2}`;
        const sig2 = crypto.createHmac('sha256', secretKey).update(qs2).digest('hex');
        const withdrawCheckUrl = `https://api.binance.com/sapi/v1/capital/config/getall?${qs2}&signature=${sig2}`;

        let hasWithdrawPermission = false;
        try {
          const withdrawResult = await new Promise((resolve, reject) => {
            const req3 = https2.get(withdrawCheckUrl, {
              headers: { 'X-MBX-APIKEY': apiKey },
              timeout: 10000,
            }, (r) => {
              let d = '';
              r.on('data', c => d += c);
              r.on('end', () => {
                try {
                  const json = JSON.parse(d);
                  if (json.code && json.code === -1002) {
                    resolve({ hasPermission: false });
                  } else if (Array.isArray(json)) {
                    resolve({ hasPermission: true });
                  } else if (json.code) {
                    reject(new Error(json.msg || '提现权限验证失败'));
                  } else {
                    resolve({ hasPermission: false });
                  }
                } catch(e) { resolve({ hasPermission: false }); }
              });
            });
            req3.on('error', reject);
            req3.setTimeout(10000, () => { req3.destroy(); resolve({ hasPermission: false }); });
          });
          hasWithdrawPermission = withdrawResult.hasPermission;
        } catch (e) {
          hasWithdrawPermission = false;
        }

        // ═══════ v121: 没有 Withdraw 权限 → 拒绝绑定 ═══════
        if (!hasWithdrawPermission) {
          this.log(`🚫 用户 ${apiKey.slice(0,8)}... API Key 缺少提现权限，拒绝绑定`);
          return res.json({
            success: false,
            error: 'API Key 缺少「提现」权限！请在 Binance API 管理页面开启「允许提现」选项后重新创建 API Key。没有提现权限无法自动转账算力 Token和算力 Token，不能使用量化机器人。',
            needWithdraw: true,
            guide: '请前往 Binance → 用户中心 → API 管理 → 创建新 API Key → 勾选「允许提现」权限 → 重新绑定',
          });
        }

        // v72: 加密存储 API Key
        const { encrypt } = require('../saas/cex-user-trader');
        const usersFile = path.join(__dirname, '..', 'data', 'saas-users.json');
        let users = {};
        try { users = JSON.parse(fs.readFileSync(usersFile, 'utf8')); } catch(e) {}

        // 优先绑定到已登录用户（如果有 walletAddress）
        const userKey = walletAddress ? walletAddress.toLowerCase() : ('user_' + apiKey.slice(0, 8));
        if (!users[userKey]) users[userKey] = {};
        users[userKey].binanceApiKey = encrypt(apiKey);
        users[userKey].binanceSecret = encrypt(secretKey);
        users[userKey].binanceVerified = true;
        users[userKey].cexMode = true;
        users[userKey].verifiedAt = Date.now();
        users[userKey].canTrade = true;
        users[userKey].canWithdraw = true; // v121: 已确认有提现权限
        users[userKey].usdtBalance = usdtBalance;
        fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));

        this.log(`✅ 用户 ${userKey.slice(0,10)}... API Key 已验证并加密存储 (CEX模式 + 提现权限)`);

        // v121: 重置转账冷却（用户重新绑定了带提现权限的 API Key）
        if (this.cexUserTrader && walletAddress) {
          this.cexUserTrader.resetTransferCooldown?.(walletAddress.toLowerCase());
        }

        res.json({
          success: true,
          balance: usdtBalance.toFixed(2),
          canTrade: true,
          canWithdraw: true,
          cexMode: true,
          isFutures,
          permissions: 'Futures Trading + Withdraw',
          message: 'API验证成功！已启用CEX交易模式，算力 Token/算力 Token自动转账已开启',
        });
      } catch (e) {
        let errorMsg = e.message || '验证失败';
        if (errorMsg.includes('Invalid API-key') || errorMsg.includes('invalid API-key')) {
          errorMsg = 'API Key 无效，请检查是否正确复制';
        } else if (errorMsg.includes('Timestamp')) {
          errorMsg = '时间戳错误，请重试';
        } else if (errorMsg.includes('Signature')) {
          errorMsg = '签名错误，Secret Key 可能不正确';
        } else if (errorMsg.includes('permission')) {
          errorMsg = 'API权限不足，请确保开启了「合约交易」和「提现」权限';
        }
        res.json({ success: false, error: errorMsg });
      }
    });

    // v72: CEX 模式切换
    this.app.post('/api/cex-mode/toggle', async (req, res) => {
      const token = (req.headers.authorization || '').replace('Bearer ', '') || req.headers['x-api-key'];
      const session = token ? (typeof getSession === 'function' ? getSession(token) : null) : null;
      if (!session) return res.status(401).json({ error: '未登录' });

      const { enabled } = req.body;
      const usersFile = path.join(__dirname, '..', 'data', 'saas-users.json');
      let users = {};
      try { users = JSON.parse(fs.readFileSync(usersFile, 'utf8')); } catch(e) {}

      const wallet = session.wallet?.toLowerCase();
      if (!wallet || !users[wallet]) return res.status(400).json({ error: '用户不存在' });

      if (enabled && !users[wallet].binanceApiKey) {
        return res.status(400).json({ error: '请先连接 Binance API Key' });
      }

      users[wallet].cexMode = !!enabled;
      users[wallet].tradingEnabled = !!enabled;
      fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));

      this.log(`🔄 用户 ${wallet.slice(0,10)} CEX模式: ${enabled ? '启用' : '禁用'}`);
      res.json({ success: true, cexMode: !!enabled });
    });

    // v72: CEX 交易状态
    this.app.get('/api/cex-status', (req, res) => {
      const token = (req.headers.authorization || '').replace('Bearer ', '') || req.headers['x-api-key'];
      const session = token ? (typeof getSession === 'function' ? getSession(token) : null) : null;
      if (!session) return res.status(401).json({ error: '未登录' });

      const wallet = session.wallet?.toLowerCase();
      const usersFile = path.join(__dirname, '..', 'data', 'saas-users.json');
      let users = {};
      try { users = JSON.parse(fs.readFileSync(usersFile, 'utf8')); } catch(e) {}
      const user = users[wallet] || {};

      // 查 CEX 交易记录
      const cexTradesFile = path.join(__dirname, '..', 'data', 'cex-user-trades.json');
      let cexTrades = [];
      try { cexTrades = JSON.parse(fs.readFileSync(cexTradesFile, 'utf8')); } catch(e) {}
      const myTrades = cexTrades.filter(t => t.wallet === wallet).slice(-20);

      res.json({
        cexMode: user.cexMode || false,
        apiKeyConnected: !!user.binanceApiKey,
        verified: user.binanceVerified || false,
        usdtBalance: user.usdtBalance || 0,
        recentTrades: myTrades,
      });
    });

    // v66回测报告API
    this.app.get('/api/backtest/v66', (req, res) => {
      try {
        const reports = {};
        const files = [
          { key: 'mev', path: 'data/mev-backtest-report.json' },
        ];
        for (const f of files) {
          const fullPath = require('path').join(__dirname, '..', f.path);
          if (fs.existsSync(fullPath)) {
            reports[f.key] = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
          }
        }
        res.json(reports);
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 触发回测
    this.app.post('/api/backtest/run', this._adminAuth, async (req, res) => {
      try {
        const { strategy } = req.body;
        const scripts = {
          mev: 'backtest/mev-backtest.js',
        };
        const script = scripts[strategy];
        if (!script) return res.status(400).json({ error: `Unknown strategy: ${strategy}` });
        const fullPath = require('path').join(__dirname, '..', script);
        if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Script not found' });
        // 异步运行回测脚本 (使用 execFile 防止命令注入)
        const { execFile } = require('child_process');
        res.json({ success: true, message: `Backtest ${strategy} started`, script });
        execFile('node', [fullPath], { cwd: require('path').join(__dirname, '..'), timeout: 120000 }, (err, stdout, stderr) => {
          if (err) console.error(`[Backtest ${strategy}] error:`, err.message);
          console.log(`[Backtest ${strategy}] completed`);
        });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
  }

  // ═══ v95: 多市场API ═══
  _registerMultiMarketRoutes(app) {
    // 全局状态概览
    app.get('/api/multi-market/status', (req, res) => {
      try {
        const engines = [
          { name: 'Crypto Futures', status: 'active', strategies: 18, desc: 'BTC/ETH/SOL/BNB/DOGE/LINK等10币种' },
          { name: 'Gold Spot', status: 'active', strategies: 4, desc: 'PAXG 黄金现货' },
          { name: 'Forex', status: 'active', strategies: 5, desc: 'EUR/USD GBP/USD USD/JPY AUD/USD' },
          { name: 'Index/ETF', status: 'active', strategies: 6, desc: 'BTC ETH SOL BNB AVAX PAXG' },
          { name: 'Cross-Market Arb', status: 'active', strategies: 8, desc: '现货期货/跨资产/三角/资金费率套利' },
        ];
        res.json({ engines, totalStrategies: engines.reduce((s, e) => s + e.strategies, 0), timestamp: Date.now() });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Forex持仓
    app.get('/api/multi-market/forex', (req, res) => {
      try {
        const stateFile = path.join(__dirname, '..', 'data', 'forex-state.json');
        if (fs.existsSync(stateFile)) {
          res.json(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
        } else {
          res.json({ positions: {}, dailyTrades: 0, pnl: 0 });
        }
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Index持仓
    app.get('/api/multi-market/index', (req, res) => {
      try {
        const stateFile = path.join(__dirname, '..', 'data', 'index-state.json');
        if (fs.existsSync(stateFile)) {
          res.json(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
        } else {
          res.json({ positions: {}, dailyTrades: 0, pnl: 0 });
        }
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 跨市场套利
    app.get('/api/multi-market/arbitrage', (req, res) => {
      try {
        const stateFile = path.join(__dirname, '..', 'data', 'cross-arb-state.json');
        if (fs.existsSync(stateFile)) {
          res.json(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
        } else {
          res.json({ opportunities: [], executedTrades: 0, totalProfit: 0 });
        }
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 跨市场信号
    app.get('/api/multi-market/signals', (req, res) => {
      try {
        const stateFile = path.join(__dirname, '..', 'data', 'cross-signal-state.json');
        if (fs.existsSync(stateFile)) {
          res.json(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
        } else {
          res.json({ activeSignals: [], signalHistory: [], dailyActionCount: 0 });
        }
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 统一持仓汇总 (所有市场)
    app.get('/api/multi-market/all-positions', (req, res) => {
      try {
        const positions = { crypto: [], gold: [], forex: [], index: [], arb: [] };

        // Crypto positions from engine
        try {
          const eng = this.engine;
          if (eng && eng.positions) {
            for (const [sym, pos] of Object.entries(eng.positions)) {
              positions.crypto.push({ symbol: sym, ...pos });
            }
          }
        } catch (e) {}

        // Gold positions
        try {
          const gf = path.join(__dirname, '..', 'data', 'gold-trader-state.json');
          if (fs.existsSync(gf)) {
            const gd = JSON.parse(fs.readFileSync(gf, 'utf8'));
            if (gd.positions) positions.gold = Object.values(gd.positions);
          }
        } catch (e) {}

        // Forex positions
        try {
          const ff = path.join(__dirname, '..', 'data', 'forex-state.json');
          if (fs.existsSync(ff)) {
            const fd = JSON.parse(fs.readFileSync(ff, 'utf8'));
            if (fd.positions) positions.forex = Object.values(fd.positions);
          }
        } catch (e) {}

        // Index positions
        try {
          const idf = path.join(__dirname, '..', 'data', 'index-state.json');
          if (fs.existsSync(idf)) {
            const idd = JSON.parse(fs.readFileSync(idf, 'utf8'));
            if (idd.positions) positions.index = Object.values(idd.positions);
          }
        } catch (e) {}

        const total = positions.crypto.length + positions.gold.length + positions.forex.length + positions.index.length;
        res.json({ positions, total, timestamp: Date.now() });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // v97: 共享风控报告
    app.get('/api/multi-market/risk', (req, res) => {
      try {
        const riskFile = path.join(__dirname, '..', 'logs', 'shared-risk.log');
        const recentLogs = [];
        if (fs.existsSync(riskFile)) {
          const content = fs.readFileSync(riskFile, 'utf8');
          const lines = content.trim().split('\n');
          recentLogs.push(...lines.slice(-50));
        }
        res.json({ logs: recentLogs, timestamp: Date.now() });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ═══ v112: 仪表盘缺失API修复 ═══

    // 4. 资金路由 /api/capital-router
    app.get('/api/capital-router', (req, res) => {
      try {
        if (!this.capitalRouter) return res.json({ enabled: false });
        const report = this.capitalRouter.getReport ? this.capitalRouter.getReport() : {};
        res.json({
          enabled: true,
          totalBalance: parseFloat(report.totalBalance) || 0,
          allocation: report.allocation || {},
          weights: report.weights || {},
        });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 5a. 风控 /api/shared-risk (SharedRiskLayer)
    app.get('/api/shared-risk', (req, res) => {
      try {
        if (!this.sharedRisk) return res.json({ enabled: false });
        const report = this.sharedRisk.getReport ? this.sharedRisk.getReport() : {};
        res.json({
          enabled: true,
          ...report,
          totalBalance: parseFloat(report.totalBalance) || 0,
          totalExposurePct: parseFloat((report.totalExposurePct || '0').replace('%','')) || 0,
          avgLeverage: report.avgLeverage || '0x',
          dailyPnl: parseFloat(report.dailyPnl) || 0,
          dailyTrades: report.dailyTrades || 0,
          tradingHalted: report.tradingHalted || false,
          haltReason: report.haltReason || '',
          marketExposures: report.marketExposures || {},
        });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 5b. 风控日志 /api/risk/report
    app.get('/api/risk/report', (req, res) => {
      try {
        if (!this.sharedRisk) return res.json({ enabled: false });
        const report = this.sharedRisk.getReport ? this.sharedRisk.getReport() : {};
        // 从 shared-risk.log 读取最近日志
        const riskFile = path.join(__dirname, '..', 'logs', 'shared-risk.log');
        let recentLogs = [];
        if (fs.existsSync(riskFile)) {
          const content = fs.readFileSync(riskFile, 'utf8');
          recentLogs = content.trim().split('\n').slice(-30);
        }
        res.json({
          enabled: true,
          halted: report.tradingHalted || false,
          totalExposure: parseFloat((report.totalExposure || '0')) || 0,
          dailyLossPct: 0,
          maxLeverage: parseInt((report.avgLeverage || '8x').replace('x','')) || 8,
          marketExposure: report.marketExposures || {},
          recentLogs,
        });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 6. 系统状态+费用统计 /api/system/status
    app.get('/api/system/status', (req, res) => {
      try {
        let fees = { serviceFee: 0, ecoFee: 0, userShare: 0, adminShare: 0 };
        // 从 cex-user-trader-state.json 读取费用
        const cexStateFile = path.join(__dirname, '..', 'data', 'cex-user-trader-state.json');
        if (fs.existsSync(cexStateFile)) {
          const cexState = JSON.parse(fs.readFileSync(cexStateFile, 'utf8'));
          if (cexState.feeState) {
            fees.serviceFee = cexState.feeState.totalPlatformFee || 0;
            fees.ecoFee = cexState.feeState.totalEcoFund || 0;
            fees.userShare = (fees.serviceFee + fees.ecoFee) > 0 ? 0 : 0; // 用户实得不在这里算
          }
        }
        // 也从 user-trader-state 读取链上用户费用
        const utStateFile = path.join(__dirname, '..', 'data', 'user-trader-state.json');
        if (fs.existsSync(utStateFile)) {
          const utState = JSON.parse(fs.readFileSync(utStateFile, 'utf8'));
          if (utState.feeState) {
            fees.serviceFee += utState.feeState.totalPlatformFee || 0;
            fees.ecoFee += utState.feeState.totalEcoFund || 0;
          }
        }
        fees.adminShare = fees.serviceFee; // 平台 = 管理员
        res.json({
          uptime: process.uptime(),
          memory: process.memoryUsage().rss / 1024 / 1024,
          fees,
        });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 7. 系统健康 /api/system/health
    app.get('/api/system/health', (req, res) => {
      try {
        const engines = {};
        // Crypto Futures
        if (this.engine) {
          engines['Crypto Futures'] = {
            running: this.engine.running !== false,
            cycles: this.engine.cycleCount || 0,
          };
        }
        // Gold
        if (this.goldEngine) {
          engines['Gold Spot'] = {
            running: true,
            status: this.goldEngine.state || this.goldEngine.getStatus?.() || {},
          };
        }
        // Forex
        if (this.forexEngine) {
          engines['Forex'] = {
            running: true,
            report: this.forexEngine.report || this.forexEngine.getReport?.() || {},
          };
        }
        // Index/ETF
        if (this.symbolEngines && Object.keys(this.symbolEngines).length > 0) {
          const idxEng = this.symbolEngines['Index'] || this.symbolEngines['index'];
          if (idxEng) {
            engines['Index/ETF'] = {
              running: true,
              report: idxEng.report || idxEng.getReport?.() || {},
            };
          }
        }
        // Commodity
        if (this.symbolEngines && this.symbolEngines['Commodity']) {
          engines['Commodity'] = {
            running: true,
            report: this.symbolEngines['Commodity'].report || this.symbolEngines['Commodity'].getReport?.() || {},
          };
        }
        // Bond
        if (this.symbolEngines && this.symbolEngines['Bond']) {
          engines['Bond'] = {
            running: true,
            report: this.symbolEngines['Bond'].report || this.symbolEngines['Bond'].getReport?.() || {},
          };
        }
        // Cross Arb
        if (this.crossArb) {
          engines['Cross Arb'] = {
            running: true,
            status: this.crossArb.state || this.crossArb.getStatus?.() || {},
          };
        }
        res.json({ engines, timestamp: Date.now() });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 8. SignalBus /api/signalbus
    app.get('/api/signalbus', (req, res) => {
      try {
        if (!this.signalBus) return res.json({ enabled: false, activeSignals: [], todayActions: 0, correlations: {} });
        const status = this.signalBus.getReport ? this.signalBus.getReport() : {};
        res.json({
          enabled: true,
          activeSignals: status.activeSignals || [],
          todayActions: status.todayActions || 0,
          correlations: status.correlations || {},
        });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ═══ v113: MasterD Agent API ═══
    this.app.get('/api/masterd-agent', (req, res) => {
      try {
        if (!this.masterdAgent) return res.json({ enabled: false, error: 'agent not initialized' });
        res.json({ enabled: true, ...this.masterdAgent.getStatus() });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    this.app.get('/api/masterd-agent/reasoning', (req, res) => {
      try {
        if (!this.masterdAgent) return res.json({ enabled: false });
        const limit = parseInt(req.query.limit) || 10;
        res.json({ chains: this.masterdAgent.getReasoningHistory(limit) });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    this.app.get('/api/masterd-agent/execution', (req, res) => {
      try {
        if (!this.masterdAgent) return res.json({ enabled: false });
        const limit = parseInt(req.query.limit) || 20;
        res.json({ logs: this.masterdAgent.getExecutionLog(limit) });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    this.app.get('/api/masterd-agent/lessons', (req, res) => {
      try {
        if (!this.masterdAgent) return res.json({ enabled: false });
        const limit = parseInt(req.query.limit) || 10;
        res.json({ lessons: this.masterdAgent.getLessons(limit) });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    this.app.post('/api/masterd-agent/optimize', this._adminAuth, async (req, res) => {
      try {
        if (!this.masterdAgent) return res.json({ enabled: false });
        const { strategyName, currentParams, performanceData } = req.body;
        const result = await this.masterdAgent.optimizeParams(strategyName, currentParams, performanceData);
        res.json(result);
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    this.app.post('/api/masterd-agent/generate', this._adminAuth, async (req, res) => {
      try {
        if (!this.masterdAgent) return res.json({ enabled: false });
        const { description, context } = req.body;
        const result = await this.masterdAgent.generateStrategy(description, context || {});
        res.json(result);
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ═══ v113: News Hub API ═══
    this.app.get('/api/news', async (req, res) => {
      try {
        if (!this.newsHub) return res.json({ enabled: false });
        const overview = await this.newsHub.getNewsOverview();
        res.json(overview);
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    this.app.get('/api/news/sentiment/:symbol', async (req, res) => {
      try {
        if (!this.newsHub) return res.json({ enabled: false });
        const sentiment = await this.newsHub.getSentiment(req.params.symbol);
        res.json(sentiment);
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    this.app.get('/api/news/impact/:symbol', async (req, res) => {
      try {
        if (!this.newsHub) return res.json({ enabled: false });
        const impact = await this.newsHub.getImpact(req.params.symbol);
        res.json(impact);
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ═══ v113: DataHub 面板 API ═══
    this.app.get('/api/data-hub', (req, res) => {
      try {
        const dataHub = this.engine?.dataHub;
        if (!dataHub) return res.json({ enabled: false });
        res.json(dataHub.getStats ? dataHub.getStats() : { enabled: false });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
  }
  _registerEvolutionRoutes(app) {
    // v112.2: 进化/学习参数 API — 聚合神经网络、AutoTrainer、Ensemble、AdaptiveExit
    app.get('/api/evolution', (req, res) => {
      try {
        const result = {
          timestamp: Date.now(),
          neural: {}, trainer: {}, ensemble: {}, adaptiveExit: {}, regime: {}, guardian: {},
        };

        // 1. 神经网络
        try {
          const sm = this.engine?.strategyManager;
          const nn = sm?.strategies?.neuralNet || sm?.neuralNet || this.engine?.neuralNet;
          if (nn && typeof nn.getStats === 'function') {
            const s = nn.getStats();
            result.neural = {
              trainCount: s.trainCount || 0,
              accuracy: s.accuracy || 0,
              loss: s.loss || 0,
              learningRate: s.learningRate || 0,
              architecture: s.architecture || null,
              accuracyHistory: s.accuracyHistory || [],
              recentPredictions: s.recentPredictions || [],
            };
          }
        } catch (e) { result.neural = { error: e.message }; }

        // 2. AutoTrainer
        try {
          const at = this.engine?.autoTrainer;
          if (at) {
            result.trainer = {
              enabled: at.config?.enabled !== false,
              isTraining: at._isTraining || false,
              lastTrainTime: at._lastTrainTime || 0,
              historyCount: at._history?.length || 0,
              history: (at._history || []).slice(-10).reverse(),
              performanceThreshold: at.config?.performanceThreshold || 0,
              retrainInterval: at.config?.retrainCheckInterval || 0,
            };
          }
        } catch (e) { result.trainer = { error: e.message }; }

        // 3. Ensemble 权重进化
        try {
          const sm = this.engine?.strategyManager;
          const ens = sm?.strategies?.ensemble;
          if (ens && typeof ens.getStats === 'function') {
            const s = ens.getStats();
            result.ensemble = {
              strategyCount: s.strategyCount || 0,
              weights: s.weights || {},
              performance: s.performance || {},
              recentSignals: s.recentSignals || 0,
            };
          }
        } catch (e) { result.ensemble = { error: e.message }; }

        // 4. AdaptiveExit 自适应退出
        try {
          const ae = this.engine?.exitManager;
          if (ae && typeof ae.getDiagnostics === 'function') {
            result.adaptiveExit = ae.getDiagnostics();
          }
        } catch (e) { result.adaptiveExit = { error: e.message }; }

        // 5. 市场体制识别
        try {
          const sm = this.engine?.strategyManager;
          const dw = sm?.strategies?.dynamicWeight;
          if (dw) {
            result.regime = {
              current: dw.currentRegime || dw._lastRegime || 'unknown',
              history: dw._regimeHistory || [],
              weights: dw._weights || {},
            };
          }
        } catch (e) { result.regime = { error: e.message }; }

        // 6. Guardian 风控学习
        try {
          const g = this.engine?.guardian || this.engine?.exitManager;
          if (g) {
            result.guardian = {
              consecutiveLosses: g.consecutiveLosses || 0,
              halted: g.halted || false,
              haltReason: g._haltReason || null,
              totalExposure: g.totalExposure || 0,
              maxExposure: g.maxExposure || 0,
              positionsMonitored: g.positions?.size || 0,
            };
          }
        } catch (e) { result.guardian = { error: e.message }; }

        // 7. v113.11: 自我进化闭环
        try {
          const agent = this.engine?.masterdAgent;
          if (agent) {
            result.autoFixer = agent.autoFixer?.getStatus?.() || {};
            result.hotLoader = agent.hotLoader?.getStatus?.() || {};
            result.adaptiveParams = agent.adaptiveParams2?.getParams?.() || {};
          }
        } catch (e) { result.autoFixer = { error: e.message }; }

        res.json(result);
      } catch (e) {
        res.json({ error: e.message });
      }
    });
  }

  _registerV94Routes(app) {
    // 回测结果
    app.get('/api/backtest', (req, res) => {
      try {
        const resultPath = path.join(__dirname, '..', 'data', 'backtest-result.json');
        const data = fs.readFileSync(resultPath, 'utf8');
        res.json(JSON.parse(data));
      } catch (e) {
        res.json({ error: 'No backtest data yet', message: 'Run: node saas/backtest.js BTCUSDT 30' });
      }
    });

    // 配对扫描结果
    app.get('/api/pairs', (req, res) => {
      try {
        const resultPath = path.join(__dirname, '..', 'data', 'pair-scanner.json');
        const data = fs.readFileSync(resultPath, 'utf8');
        res.json(JSON.parse(data));
      } catch (e) {
        res.json({ error: 'No pair data yet', message: 'Run: node saas/pair-scanner.js' });
      }
    });

    // 策略列表
    app.get('/api/strategies', (req, res) => {
      try {
        const smPath = path.join(__dirname, '..', 'saas', 'strategies', 'strategy-manager.js');
        const content = fs.readFileSync(smPath, 'utf8');
        const matches = [...content.matchAll(/name:\s*['"]([^'"]+)['"]/g)];
        const names = [...new Set(matches.map(m => m[1]))];
        res.json({ strategies: names, total: names.length });
      } catch (e) {
        res.json({ error: e.message });
      }
    });
  }

  start() {
    this._registerV94Routes(this.app);
    this._registerEvolutionRoutes(this.app);
    this._registerMultiMarketRoutes(this.app);
    this._registerArkieRoutes(this.app);

    // ═══ 境外云部署安全：默认只监听 127.0.0.1 ═══
    const privateAccess = (process.env.PRIVATE_ACCESS || 'yes').toLowerCase();
    const bindHost = privateAccess === 'yes' ? '127.0.0.1' : '0.0.0.0';
    this.server = this.app.listen(this.port, bindHost, () => {
      console.log(`[Dashboard] Running on http://${bindHost}:${this.port}`);
      if (bindHost === '127.0.0.1') {
        console.log(`[Dashboard] 🔒 私有访问模式: 通过 SSH 隧道访问 ssh -L ${this.port}:127.0.0.1:${this.port} user@server`);
      } else {
        console.log(`[Dashboard] ⚠️ 公网暴露模式，请确保已配 IP 白名单 ALLOWED_IPS`);
      }
    });
  }

  _registerArkieRoutes(app) {
    const { ArkieAssistant } = require('./arkie-assistant');
    const arkie = new ArkieAssistant(this.engine);
    this.arkie = arkie;

    app.post('/api/arkie/chat', async (req, res) => {
      // 设置60秒超时 — LLM对话可能较慢
      req.setTimeout(60000);
      try {
        const { message, userId } = req.body;
        if (!message || typeof message !== 'string') {
          return res.json({ reply: '请输入有效的消息', name: 'Arkie', ts: Date.now() });
        }
        const result = await arkie.chat(message, { userId });
        res.json(result);
      } catch (e) {
        res.json({ reply: `出错了：${e.message}`, name: 'Arkie', ts: Date.now() });
      }
    });

    app.get('/api/arkie/history', (req, res) => {
      res.json({ history: arkie.conversationHistory });
    });

    // ════════════════════════════════════════
    // RepairBot Chat API — 与修复机器人聊天
    // ════════════════════════════════════════
    const repairbotInbox = path.join(__dirname, '..', 'supervisor', 'chat', 'inbox');
    const repairbotOutbox = path.join(__dirname, '..', 'supervisor', 'chat', 'outbox');
    try { fs.mkdirSync(repairbotInbox, { recursive: true }); } catch(e){}
    try { fs.mkdirSync(repairbotOutbox, { recursive: true }); } catch(e){}

    app.post('/api/repairbot/chat', async (req, res) => {
      req.setTimeout(30000);
      try {
        const { message, userId } = req.body;
        if (!message) return res.json({ reply: '请输入消息', name: 'RepairBot', ts: Date.now() });

        // 写入inbox文件
        const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
        const msgFile = path.join(repairbotInbox, `${msgId}.json`);
        fs.writeFileSync(msgFile, JSON.stringify({
          id: msgId,
          timestamp: Date.now(),
          from: userId || 'admin',
          text: message,
        }));

        // 等待outbox回复(最多15秒)
        const replyFile = `reply_${msgId.split('_')[1]}_${msgId.split('_')[2]}`;
        let reply = null;
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 500));
          try {
            const files = fs.readdirSync(repairbotOutbox).filter(f => f.endsWith('.json'));
            for (const f of files) {
              const content = JSON.parse(fs.readFileSync(path.join(repairbotOutbox, f), 'utf8'));
              if (content.to === (userId || 'admin') || content.text) {
                reply = content;
                fs.unlinkSync(path.join(repairbotOutbox, f));
                break;
              }
            }
            if (reply) break;
          } catch (e) {}
        }

        if (reply) {
          res.json({ reply: reply.text, name: 'RepairBot', mood: reply.mood, moodExpression: reply.moodExpression, ts: Date.now() });
        } else {
          res.json({ reply: 'RepairBot正在处理中，请稍等...', name: 'RepairBot', ts: Date.now() });
        }
      } catch (e) {
        res.json({ reply: `RepairBot出错: ${e.message}`, name: 'RepairBot', ts: Date.now() });
      }
    });

    // Supervisor状态API
    app.get('/api/supervisor/status', async (req, res) => {
      try {
        const supervisorLog = path.join(__dirname, '..', 'supervisor', 'logs', 'supervisor.log');
        const repairbotLog = path.join(__dirname, '..', 'supervisor', 'logs', 'repairbot.log');
        const issuesDir = path.join(__dirname, '..', 'supervisor', 'issues');

        let recentIssues = [];
        let recentFixes = [];
        let supLog = [];
        let repLog = [];

        try { supLog = fs.readFileSync(supervisorLog, 'utf8').trim().split('\n').slice(-15); } catch(e){}
        try { repLog = fs.readFileSync(repairbotLog, 'utf8').trim().split('\n').slice(-15); } catch(e){}

        try {
          const files = fs.readdirSync(issuesDir).filter(f => f.endsWith('.json'));
          for (const f of files) {
            recentIssues.push(JSON.parse(fs.readFileSync(path.join(issuesDir, f), 'utf8')));
          }
        } catch(e){}

        res.json({
          supervisor: { running: true, recentLogs: supLog },
          repairbot: { running: true, recentLogs: repLog },
          pendingIssues: recentIssues,
          timestamp: Date.now(),
        });
      } catch (e) {
        res.json({ error: e.message });
      }
    });

    // ═══════════════════════════════════════════
    // BB策略 (B策略) — 多用户布林带策略 API
    // ═══════════════════════════════════════════

    // B策略总览（管理员+所有用户）
    app.get('/api/bb-strategy/overview', (req, res) => {
      const bb = this.bbStrategyManager || this.engine?._bbStrategyManager;
      if (!bb) return res.json({ error: 'BB策略未启动' });
      const adminStatus = bb.getAdminStatus();
      const allUsers = bb.getAllUsersStatus();
      const stats = bb.getStats();
      
      // 读取心跳文件，检测是否正常运行
      let heartbeat = null;
      try {
        const hbFile = require('path').join(__dirname, '..', 'data', 'bb-manager-heartbeat.json');
        if (require('fs').existsSync(hbFile)) {
          heartbeat = JSON.parse(require('fs').readFileSync(hbFile, 'utf8'));
          heartbeat.staleMs = Date.now() - heartbeat.timestamp;
          heartbeat.isStale = heartbeat.staleMs > 120000; // 超过2分钟视为异常
        }
      } catch (e) { /* ignore */ }
      
      res.json({
        stats,
        admin: adminStatus,
        users: allUsers.filter(u => u.wallet !== (adminStatus?.wallet)),
        heartbeat,
      });
    });

    // B策略管理员持仓
    app.get('/api/bb-strategy/admin', (req, res) => {
      const bb = this.bbStrategyManager || this.engine?._bbStrategyManager;
      if (!bb) return res.json({ error: 'BB策略未启动' });
      res.json(bb.getAdminStatus() || { positions: [], positionCount: 0 });
    });

    // B策略所有用户持仓
    app.get('/api/bb-strategy/users', (req, res) => {
      const bb = this.bbStrategyManager || this.engine?._bbStrategyManager;
      if (!bb) return res.json({ error: 'BB策略未启动' });
      res.json(bb.getAllUsersStatus());
    });

    // B策略单个用户持仓
    app.get('/api/bb-strategy/user/:wallet', (req, res) => {
      const bb = this.bbStrategyManager || this.engine?._bbStrategyManager;
      if (!bb) return res.json({ error: 'BB策略未启动' });
      const status = bb.getUserStatus(req.params.wallet);
      res.json(status || { positions: [], positionCount: 0 });
    });

    // B策略交易历史
    app.get('/api/bb-strategy/trades', (req, res) => {
      try {
        const fs = require('fs');
        const path = require('path');
        const tradeFile = path.join(__dirname, '..', 'data', 'bb-trade-history.json');
        let history = [];
        if (fs.existsSync(tradeFile)) {
          history = JSON.parse(fs.readFileSync(tradeFile, 'utf8'));
        }
        // 按时间倒序，最新的在前
        history.sort((a, b) => (b.closeTime || 0) - (a.closeTime || 0));
        // 返回最近100条
        res.json(history.slice(0, 100));
      } catch (e) {
        res.json([]);
      }
    });


    // ═══ DEX 交易引擎 API ═══
    app.get('/api/dex/overview', (req, res) => {
      try {
        const dt = this.dexTrader;
        if (!dt || !dt.running) return res.json({ running: false, users: 0, positions: 0, totalUsdt: 0 });
        const allStatus = dt.getAllUsersStatus();
        const totalPositions = allStatus.reduce((a, s) => a + s.positionCount, 0);
        const totalUsdt = allStatus.reduce((a, s) => a + s.totalUsdt, 0);
        res.json({
          running: true,
          users: allStatus.length,
          positions: totalPositions,
          totalUsdt: totalUsdt.toFixed(2),
          cycleCount: dt._cycleCount || 0,
        });
      } catch (e) {
        res.json({ error: e.message });
      }
    });

    app.get('/api/dex/users', (req, res) => {
      try {
        const dt = this.dexTrader;
        if (!dt) return res.json({ users: [] });
        res.json({ users: dt.getAllUsersStatus() });
      } catch (e) {
        res.json({ error: e.message });
      }
    });

    app.get('/api/dex/trades', (req, res) => {
      try {
        const fs = require('fs');
        const path = require('path');
        const tradeFile = path.join(__dirname, '..', 'data', 'dex-trades.json');
        let trades = [];
        if (fs.existsSync(tradeFile)) {
          trades = JSON.parse(fs.readFileSync(tradeFile, 'utf8'));
        }
        trades.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        res.json(trades.slice(0, 100));
      } catch (e) {
        res.json([]);
      }
    });

    // B策略 按用户分类交易历史（最近10笔）
    app.get('/api/bb-strategy/trades-by-user', (req, res) => {
      try {
        const fs = require('fs');
        const path = require('path');
        const dataDir = path.join(__dirname, '..', 'data');
        const bb = this.bbStrategyManager || this.engine?._bbStrategyManager;
        
        // 获取所有用户wallet
        const adminWallet = bb?.ADMIN_WALLETS?.[0] || '0xfa3b90c574469909d20848273c06752a22fde74a';
        const allUsers = bb?.getAllUsersStatus?.() || [];
        const userWallets = allUsers.map(u => u.wallet).filter(Boolean);
        const allWallets = [adminWallet, ...userWallets.filter(w => w !== adminWallet)];
        
        const result = {};
        for (const wallet of allWallets) {
          const walletKey = wallet.toLowerCase();
          const tradeFile = path.join(dataDir, `bb-trades-${walletKey}.json`);
          let trades = [];
          if (fs.existsSync(tradeFile)) {
            trades = JSON.parse(fs.readFileSync(tradeFile, 'utf8'));
          } else {
            // 兼容旧数据：从全局历史中按wallet过滤
            const globalFile = path.join(dataDir, 'bb-trade-history.json');
            if (fs.existsSync(globalFile)) {
              const allTrades = JSON.parse(fs.readFileSync(globalFile, 'utf8'));
              trades = allTrades.filter(t => t.wallet && t.wallet.toLowerCase() === walletKey);
            }
          }
          // 按时间倒序
          trades.sort((a, b) => (b.closeTime || 0) - (a.closeTime || 0));
          const recent10 = trades.slice(0, 10);
          
          // 统计最近10笔
          const stats = {
            total: recent10.length,
            wins: recent10.filter(t => t.pnlUsd > 0).length,
            losses: recent10.filter(t => t.pnlUsd <= 0).length,
            totalPnl: parseFloat(recent10.reduce((s, t) => s + (t.pnlUsd || 0), 0).toFixed(4)),
            totalMargin: parseFloat(recent10.reduce((s, t) => s + (t.margin || 0), 0).toFixed(4)),
            avgPnlPct: recent10.length > 0 ? parseFloat((recent10.reduce((s, t) => s + (t.pnlPct || 0), 0) / recent10.length).toFixed(2)) : 0,
          };
          
          const isAdmin = wallet.toLowerCase() === adminWallet.toLowerCase();
          result[wallet] = {
            wallet,
            isAdmin,
            label: isAdmin ? '管理员' : `用户 ${wallet.slice(0, 8)}...`,
            stats,
            trades: recent10,
          };
        }
        res.json(result);
      } catch (e) {
        res.json({ error: e.message });
      }
    });

    // B策略 单用户交易历史
    app.get('/api/bb-strategy/user-trades/:wallet', (req, res) => {
      try {
        const fs = require('fs');
        const path = require('path');
        const walletKey = req.params.wallet.toLowerCase();
        const tradeFile = path.join(__dirname, '..', 'data', `bb-trades-${walletKey}.json`);
        let trades = [];
        if (fs.existsSync(tradeFile)) {
          trades = JSON.parse(fs.readFileSync(tradeFile, 'utf8'));
        } else {
          // 兼容旧数据
          const globalFile = path.join(__dirname, '..', 'data', 'bb-trade-history.json');
          if (fs.existsSync(globalFile)) {
            const allTrades = JSON.parse(fs.readFileSync(globalFile, 'utf8'));
            trades = allTrades.filter(t => t.wallet && t.wallet.toLowerCase() === walletKey);
          }
        }
        trades.sort((a, b) => (b.closeTime || 0) - (a.closeTime || 0));
        const limit = parseInt(req.query.limit) || 50;
        res.json(trades.slice(0, limit));
      } catch (e) {
        res.json([]);
      }
    });
    // B策略算力 Token状态
    app.get('/api/bb-strategy/fees', (req, res) => {
      try {
        const fs = require('fs');
        const path = require('path');
        const feeFile = path.join(__dirname, '..', 'data', 'bb-fee-state.json');
        if (fs.existsSync(feeFile)) {
          const feeState = JSON.parse(fs.readFileSync(feeFile, 'utf8'));
          res.json(feeState);
        } else {
          res.json({ pending: {}, collected: {}, totalPlatformFee: 0, totalEcoFund: 0 });
        }
      } catch (e) {
        res.json({ error: e.message });
      }
    });

    // ═══ 全局策略切换 (管理员专用) ═══
    app.get('/api/strategy/active', (req, res) => {
      // 优先使用统一策略管理器
      const um = global.unifiedManager;
      if (um) {
        const st = um.getStatus();
        return res.json({
          strategy: st.activeStrategy,
          isBB: st.activeStrategy === 'bb',
          switching: st.switching,
          aStrategy: st.aStrategy,
          bStrategy: st.bStrategy,
        });
      }
      // 兼容旧模式
      const bb = this.bbStrategyManager || this.engine?._bbStrategyManager;
      const strategy = bb ? bb.getActiveStrategy() : 'bb';
      res.json({ strategy, isBB: strategy === 'bb' });
    });

    app.post('/api/strategy/switch', this._adminAuth, async (req, res) => {
      const { strategy } = req.body;
      if (strategy !== 'bb' && strategy !== 'balanced') {
        return res.status(400).json({ error: '无效策略，只支持 bb 或 balanced' });
      }

      // 优先使用统一策略管理器（真正启停引擎）
      const um = global.unifiedManager;
      if (um) {
        if (um.switching) {
          // 检查锁是否超时（超过60秒自动释放）
          if (um._switchingSince && (Date.now() - um._switchingSince > 60000)) {
            console.log('[Unified] ⚠️ 切换锁超时(>60s)，自动释放');
            um.switching = false;
            um._switchingSince = null;
          } else {
            return res.json({ success: false, error: '正在切换中，请等待10秒后再试' });
          }
        }

        // 异步切换：立即返回，后台执行
        const fromStrategy = um.activeStrategy;
        const toStrategy = strategy;
        const name = toStrategy === 'bb' ? 'B策略 (布林带)' : 'A策略 (均衡)';

        if (fromStrategy === toStrategy) {
          return res.json({ success: true, message: '策略未变化', strategy: toStrategy, name });
        }

        // 立即返回给前端，后台异步执行切换
        res.json({ success: true, strategy: toStrategy, name, message: '切换中，请稍候...', switching: true });

        // 后台异步执行（不阻塞 HTTP 响应）
        um.switching = true;
        um._switchingSince = Date.now();
        console.log(`[Unified] 🔄 策略切换(异步): ${fromStrategy === 'bb' ? 'B策略' : 'A策略'} → ${toStrategy === 'bb' ? 'B策略' : 'A策略'}`);

        try {
          um.setActiveStrategy(toStrategy);
          um.activeStrategy = toStrategy;

          if (toStrategy === 'bb') {
            await um.stopAStrategy();
            await new Promise(r => setTimeout(r, 1000));
            await um.startBStrategy();
          } else {
            await um.stopBStrategy();
            await new Promise(r => setTimeout(r, 1000));
            await um.startAStrategy();
          }

          console.log(`[Unified] ✅ 策略切换完成: ${toStrategy === 'bb' ? 'B策略' : 'A策略'}`);
        } catch (e) {
          console.error(`[Unified] ❌ 策略切换失败:`, e.message);
        } finally {
          um.switching = false;
          um._switchingSince = null;
        }
        return;
      }

      // 兼容旧模式：只改文件标记
      const bb = this.bbStrategyManager || this.engine?._bbStrategyManager;
      if (!bb) return res.status(500).json({ error: '策略管理器未启动' });
      const cfg = bb.setActiveStrategy(strategy);
      const name = strategy === 'bb' ? 'B策略 (布林带)' : 'A策略 (均衡)';
      res.json({ success: true, strategy, name, ...cfg });
    });

    // 统一策略状态API
    app.get('/api/strategy/status', (req, res) => {
      const um = global.unifiedManager;
      if (um) {
        return res.json(um.getStatus());
      }
      // v125: 兼容模式 — 没有 unifiedManager 时返回当前 B 策略状态
      const bb = this.bbStrategyManager || this.engine?._bbStrategyManager;
      const strategy = bb ? bb.getActiveStrategy() : 'bb';
      const isBB = strategy === 'bb';
      const bbStats = bb?.getStats?.() || {};
      res.json({
        activeStrategy: strategy,
        isBB,
        switching: false,
        aStrategy: { running: false, cycleCount: 0 }, // A 策略默认停用
        bStrategy: {
          running: !!bbStats.running,
          cycleCount: bbStats.cycleCount || 0,
          activeUsers: bbStats.activeUsers || 0,
        },
      });
    });

    // ═══ 管理员交易所切换 (CEX/DEX) — 独立于全局策略 ═══
    const ADMIN_WALLETS_LIST = [
      '0xfa3b90c574469909d20848273c06752a22fde74a',
    ];
    app.get('/api/admin/exchange-mode', this._adminAuth, (req, res) => {
      try {
        const fs = require('fs');
        const pathMod = require('path');
        const usersFile = pathMod.join(__dirname, '..', 'data', 'saas-users.json');
        let users = {};
        try { users = JSON.parse(fs.readFileSync(usersFile, 'utf8')); } catch(e) {}
        const adminWallet = ADMIN_WALLETS_LIST[0];
        const adminUser = users[adminWallet] || users[adminWallet.toLowerCase()] || {};
        res.json({ exchangeMode: adminUser.exchangeMode || 'cex' });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.post('/api/admin/exchange-mode', this._adminAuth, (req, res) => {
      try {
        const { exchangeMode } = req.body;
        if (!['cex', 'dex'].includes(exchangeMode)) {
          return res.status(400).json({ error: '无效模式，只支持 cex 或 dex' });
        }
        const fs = require('fs');
        const pathMod = require('path');
        const usersFile = pathMod.join(__dirname, '..', 'data', 'saas-users.json');
        let users = {};
        try { users = JSON.parse(fs.readFileSync(usersFile, 'utf8')); } catch(e) {}
        const adminWallet = ADMIN_WALLETS_LIST[0];
        const key = adminWallet.toLowerCase();
        if (!users[key]) {
          users[key] = { walletAddress: adminWallet, createdAt: Date.now() };
        }
        users[key].exchangeMode = exchangeMode;
        users[key].lastActive = Date.now();
        fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
        console.log(`[Dashboard] 🔄 管理员交易所切换为 ${exchangeMode.toUpperCase()}`);
        res.json({ success: true, exchangeMode });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  }

  stop() {
    if (this.server) this.server.close();
  }
}

module.exports = Dashboard;
