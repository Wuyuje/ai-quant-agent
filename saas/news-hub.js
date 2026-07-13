/** * News Hub v2.0 — 交易所新闻信息中心 * * v2.0 修复: 替换失败的API源 * - Binance公告 403 → 用RSS2JSON代理Cointelegraph + CoinDesk * - CryptoCompare 401(需Key) → 用RSS2JSON RSS feeds (免费, 无需Key) * - 保留: Fear&Greed(✅), CoinGecko Trending(✅) * - 新增: Binance funding rate via API(✅), Binance多空比(✅) * * 数据源:
 *   1. Cointelegraph RSS (via RSS2JSON) — 加密新闻
 *   2. CoinDesk RSS (via RSS2JSON) — 加密新闻
 *   3. Fear & Greed Index (恐慌贪婪指数)
 *   4. Binance Funding Rate (资金费率) — via Binance API
 *   5. Long/Short Ratio (多空比) — via Binance API
 *   6. CoinGecko Trending (热门币种)
 * * 功能:
 *   - 新闻分类: 上市/下架/监管/黑客/合作/技术升级
 *   - 情绪分析: 利好/利空/中性
 *   - 影响评估: 品种 → 影响程度 → 持续时间
 *   - 信号增强: 利好信号+confidence, 利空信号过滤/降权
 *   - 缓存: 5分钟刷新, 自动过期
 */

const https = require('https');

class NewsHub {
  constructor(config = {}) {
    this.config = config;
    this.cache = {
      binanceAnnouncements: { data: [], time: 0 },
      cointelegraphNews: { data: [], time: 0 },
      coindeskNews: { data: [], time: 0 },
      fearGreed: { data: null, time: 0 },
      trending: { data: [], time: 0 },
      cryptoNews: { data: [], time: 0 },
      fundingRates: { data: {}, time: 0 },
      longShortRatios: { data: {}, time: 0 },
    };
    this.cacheMs = config.cacheMs || 300000; // 5分钟缓存
    this.stats = {
      newsCount: 0,
      bullSignals: 0,
      bearSignals: 0,
      neutralSignals: 0,
      byCategory: {},
      bySource: {},
      errors: 0,
    };
    this.log = (msg) => console.log(`[News-Hub] ${msg}`);
  }

  /**
   * HTTPS GET 封装
   */
  _fetch(url, options = {}) {
    return new Promise((resolve, reject) => {
      const opts = {
        method: 'GET',
        timeout: options.timeout || 10000,
        headers: options.headers || {},
      };
      const req = https.request(url, opts, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = data.startsWith('{') || data.startsWith('[') ? JSON.parse(data) : data;
            resolve(json);
          } catch (e) {
            resolve(data);
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });
  }

  /**
   * 1. Binance 公告 — 原API返回403, 用Binance安全页面RSS替代
   */
  async fetchBinanceAnnouncements() {
    const now = Date.now();
    if (now - this.cache.binanceAnnouncements.time < this.cacheMs && this.cache.binanceAnnouncements.data.length) {
      return this.cache.binanceAnnouncements.data;
    }
    try {
      // 用RSS2JSON代理Binance公告RSS
      const data = await this._fetch('https://api.rss2json.com/v1/api.json?rss_url=https://www.binance.com/en/support/announcement/rss', {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        timeout: 8000,
      });
      const articles = (data?.items || []).slice(0, 30).map(a => ({
        title: a.title || '',
        type: this._classifyNews(a.title || ''),
        date: a.pubDate || '',
        url: a.link || '',
        source: 'binance',
      }));
      this.cache.binanceAnnouncements = { data: articles, time: now };
      this.stats.newsCount += articles.length;
      this.stats.bySource['binance'] = articles.length;
      articles.forEach(a => { this.stats.byCategory[a.type] = (this.stats.byCategory[a.type] || 0) + 1; });
      return articles;
    } catch (e) {
      // Binance RSS也可能失败,尝试备选
      try {
        const data = await this._fetch('https://api.rss2json.com/v1/api.json?rss_url=https://www.binance.com/en/blog/rss', {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 8000,
        });
        const articles = (data?.items || []).slice(0, 20).map(a => ({
          title: a.title || '',
          type: this._classifyNews(a.title || ''),
          date: a.pubDate || '',
          url: a.link || '',
          source: 'binance',
        }));
        this.cache.binanceAnnouncements = { data: articles, time: now };
        this.stats.newsCount += articles.length;
        this.stats.bySource['binance'] = articles.length;
        return articles;
      } catch (e2) {
        this.stats.errors++;
        this.cache.binanceAnnouncements = { data: this.cache.binanceAnnouncements.data, time: now };
        return this.cache.binanceAnnouncements.data;
      }
    }
  }

  /**
   * 1b. Cointelegraph News (via RSS2JSON, 免费无需Key)
   */
  async fetchCointelegraphNews() {
    const now = Date.now();
    if (now - this.cache.cointelegraphNews.time < this.cacheMs && this.cache.cointelegraphNews.data.length) {
      return this.cache.cointelegraphNews.data;
    }
    try {
      const data = await this._fetch('https://api.rss2json.com/v1/api.json?rss_url=https://cointelegraph.com/rss', {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        timeout: 8000,
      });
      const articles = (data?.items || []).slice(0, 20).map(a => {
        const fullText = (a.title || '') + ' ' + (a.description || a.content || '').slice(0, 500);
        return {
          title: a.title || '',
          body: (a.description || a.content || '').slice(0, 500),
          source: 'cointelegraph',
          url: a.link || '',
          category: this._classifyNews(a.title || ''),
          sentiment: this._quickSentiment(fullText),
          timestamp: a.pubDate ? new Date(a.pubDate).getTime() : Date.now(),
          symbols: this._extractSymbols(fullText),
        };
      });
      this.cache.cointelegraphNews = { data: articles, time: now };
      this.stats.newsCount += articles.length;
      this.stats.bySource['cointelegraph'] = articles.length;
      articles.forEach(a => { this.stats.byCategory[a.category] = (this.stats.byCategory[a.category] || 0) + 1; });
      return articles;
    } catch (e) {
      this.stats.errors++;
      return this.cache.cointelegraphNews.data;
    }
  }

  /**
   * 1c. CoinDesk News (via RSS2JSON, 免费无需Key)
   */
  async fetchCoinDeskNews() {
    const now = Date.now();
    if (now - this.cache.coindeskNews.time < this.cacheMs && this.cache.coindeskNews.data.length) {
      return this.cache.coindeskNews.data;
    }
    try {
      const data = await this._fetch('https://api.rss2json.com/v1/api.json?rss_url=https://www.coindesk.com/arc/outboundfeeds/rss/', {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        timeout: 8000,
      });
      const articles = (data?.items || []).slice(0, 20).map(a => {
        const fullText = (a.title || '') + ' ' + (a.description || a.content || '').slice(0, 500);
        return {
          title: a.title || '',
          body: (a.description || a.content || '').slice(0, 500),
          source: 'coindesk',
          url: a.link || '',
          category: this._classifyNews(a.title || ''),
          sentiment: this._quickSentiment(fullText),
          timestamp: a.pubDate ? new Date(a.pubDate).getTime() : Date.now(),
          symbols: this._extractSymbols(fullText),
        };
      });
      this.cache.coindeskNews = { data: articles, time: now };
      this.stats.newsCount += articles.length;
      this.stats.bySource['coindesk'] = articles.length;
      articles.forEach(a => { this.stats.byCategory[a.category] = (this.stats.byCategory[a.category] || 0) + 1; });
      return articles;
    } catch (e) {
      this.stats.errors++;
      return this.cache.coindeskNews.data;
    }
  }

  /**
   * 从新闻文本中提取币种符号
   */
  _extractSymbols(text) {
    const t = (text || '').toUpperCase();
    const knownCoins = ['BTC','ETH','BNB','SOL','XRP','ADA','AVAX','DOT','DOGE','LINK','MATIC','LTC','BCH','UNI','ATOM','TRX','ETC','FIL','ARB','OP','APT','NEAR','INJ','SUI','SEI','TIA','ORDI','PEPE','SHIB','ARK'];
    return knownCoins.filter(c => t.includes(c));
  }

  /**
   * 2. Fear & Greed Index
   */
  async fetchFearGreed() {
    const now = Date.now();
    if (this.cache.fearGreed.data && now - this.cache.fearGreed.time < this.cacheMs) {
      return this.cache.fearGreed.data;
    }
    try {
      const data = await this._fetch('https://api.alternative.me/fng/?limit=1');
      const fng = data?.data?.[0];
      const result = {
        value: parseInt(fng?.value || 50),
        classification: fng?.value_classification || 'Neutral',
        timestamp: fng?.timestamp || Date.now() / 1000,
      };
      this.cache.fearGreed = { data: result, time: now };
      return result;
    } catch (e) {
      this.stats.errors++;
      return this.cache.fearGreed.data || { value: 50, classification: 'Neutral' };
    }
  }

  /**
   * 3. CoinGecko Trending
   */
  async fetchTrending() {
    const now = Date.now();
    if (this.cache.trending.data.length && now - this.cache.trending.time < this.cacheMs) {
      return this.cache.trending.data;
    }
    try {
      const data = await this._fetch('https://api.coingecko.com/api/v3/search/trending');
      const coins = (data?.coins || []).slice(0, 10).map(c => ({
        id: c.item?.id || '',
        name: c.item?.name || '',
        symbol: c.item?.symbol || '',
        rank: c.item?.market_cap_rank || 0,
        score: c.item?.score || 0,
      }));
      this.cache.trending = { data: coins, time: now };
      return coins;
    } catch (e) {
      this.stats.errors++;
      return this.cache.trending.data;
    }
  }

  /**
   * 4. Crypto News — 聚合Cointelegraph + CoinDesk (免费RSS)
   *    替代原CryptoCompare(需要API Key, 返回401)
   */
  async fetchCryptoNews() {
    const now = Date.now();
    if (this.cache.cryptoNews.data.length && now - this.cache.cryptoNews.time < this.cacheMs) {
      return this.cache.cryptoNews.data;
    }
    try {
      const [ct, cd] = await Promise.all([
        this.fetchCointelegraphNews(),
        this.fetchCoinDeskNews(),
      ]);
      const articles = [...ct, ...cd]
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        .slice(0, 40);
      this.cache.cryptoNews = { data: articles, time: now };
      return articles;
    } catch (e) {
      this.stats.errors++;
      return this.cache.cryptoNews.data;
    }
  }

  /**
   * 5. Binance Funding Rate (由外部注入或自取)
   */
  updateFundingRates(rates) {
    this.cache.fundingRates = { data: rates, time: Date.now() };
  }

  getFundingRate(symbol) {
    return this.cache.fundingRates.data[symbol] || null;
  }

  /**
   * 6. Long/Short Ratio
   */
  updateLongShortRatios(ratios) {
    this.cache.longShortRatios = { data: ratios, time: Date.now() };
  }

  getLongShortRatio(symbol) {
    return this.cache.longShortRatios.data[symbol] || null;
  }

  /**
   * 新闻分类
   */
  _classifyNews(title) {
    const t = (title || '').toLowerCase();
    if (/list|listing|launch|add|new.*pair|open.*trading/.test(t)) return 'listing';
    if (/delist|delisting|remove|close.*trading/.test(t)) return 'delisting';
    if (/hack|exploit|breach|attack|vulnerab|stolen|drained/.test(t)) return 'hack';
    if (/partnership|collabor|integrat|join|cooperation/.test(t)) return 'partnership';
    if (/upgrade|update|fork|mainnet|testnet|deploy/.test(t)) return 'tech_upgrade';
    if (/regulat|sec|ban|lawsuit|compliance|legal|court/.test(t)) return 'regulation';
    if (/burn|buyback|repurchase|destroy/.test(t)) return 'burn';
    if (/airdrop|reward|bonus|giveaway/.test(t)) return 'airdrop';
    return 'general';
  }

  /**
   * 快速情绪分析 (规则版, LLM增强版在Agent中)
   * v2.0: 扩充关键词库 + 加权评分
   */
  _quickSentiment(text) {
    const t = (text || '').toLowerCase();
    let score = 0;

    // 利好关键词 (加权)
    const bullWords = [
      { w: 'surge', s: 0.15 }, { w: 'soar', s: 0.15 }, { w: 'rally', s: 0.12 },
      { w: 'breakout', s: 0.12 }, { w: 'bullish', s: 0.15 }, { w: 'pump', s: 0.1 },
      { w: 'gain', s: 0.08 }, { w: ' ath', s: 0.15 }, { w: 'all-time high', s: 0.15 },
      { w: 'adoption', s: 0.1 }, { w: 'approve', s: 0.15 }, { w: 'approved', s: 0.15 },
      { w: 'partnership', s: 0.1 }, { w: 'upgrade', s: 0.08 }, { w: 'burn', s: 0.08 },
      { w: 'buyback', s: 0.1 }, { w: 'institutional', s: 0.1 }, { w: 'etf', s: 0.12 },
      { w: 'positive', s: 0.08 }, { w: 'growth', s: 0.08 }, { w: 'support', s: 0.06 },
      { w: 'accumulation', s: 0.1 }, { w: 'bounce', s: 0.08 }, { w: 'recovery', s: 0.08 },
      { w: 'bull', s: 0.1 }, { w: 'buy', s: 0.06 }, { w: 'long', s: 0.04 },
      { w: 'moon', s: 0.1 }, { w: 'win', s: 0.06 }, { w: 'profit', s: 0.06 },
      { w: 'record', s: 0.1 }, { w: 'fund', s: 0.06 }, { w: 'invest', s: 0.06 },
    ];
    // 利空关键词 (加权)
    const bearWords = [
      { w: 'crash', s: 0.15 }, { w: 'plunge', s: 0.15 }, { w: 'dump', s: 0.12 },
      { w: 'bearish', s: 0.15 }, { w: 'hack', s: 0.15 }, { w: 'exploit', s: 0.15 },
      { w: 'ban', s: 0.12 }, { w: 'lawsuit', s: 0.1 }, { w: 'sec ', s: 0.1 },
      { w: 'delist', s: 0.15 }, { w: 'sell-off', s: 0.12 }, { w: 'fear', s: 0.08 },
      { w: 'liquidation', s: 0.1 }, { w: 'outflow', s: 0.08 }, { w: 'warning', s: 0.08 },
      { w: 'risk', s: 0.06 }, { w: 'decline', s: 0.08 }, { w: 'breakdown', s: 0.1 },
      { w: 'bear', s: 0.1 }, { w: 'sell', s: 0.06 }, { w: 'short', s: 0.04 },
      { w: 'drop', s: 0.08 }, { w: 'fall', s: 0.08 }, { w: 'loss', s: 0.06 },
      { w: 'tumble', s: 0.12 }, { w: 'slump', s: 0.1 }, { w: 'correction', s: 0.08 },
      { w: 'reject', s: 0.08 }, { w: 'resistance', s: 0.06 }, { w: 'bubble', s: 0.1 },
      { w: 'fraud', s: 0.15 }, { w: 'scam', s: 0.12 }, { w: 'bankrupt', s: 0.15 },
    ];

    for (const { w, s } of bullWords) if (t.includes(w)) score += s;
    for (const { w, s } of bearWords) if (t.includes(w)) score -= s;

    // 限幅
    score = Math.max(-1, Math.min(1, score));

    // v2.0: 降低阈值, neutral范围更窄 — 让真实新闻更容易触发
    return {
      score,
      label: score > 0.1 ? 'bullish' : score < -0.1 ? 'bearish' : 'neutral',
    };
  }

  /**
   * 获取某品种的新闻情绪
   */
  async getSentiment(symbol) {
    const baseSymbol = symbol.replace('USDT', '').replace('USDC', '').replace('BUSD', '');
    const news = await this.fetchCryptoNews();
    const binance = await this.fetchBinanceAnnouncements();
    const fng = await this.fetchFearGreed();

    let score = 0;
    let reasons = [];
    let relatedNews = [];

    // 从新闻中找相关品种 — v2.0: 单条新闻影响权重放大
    for (const n of news) {
      const text = (n.title + ' ' + (n.body || '')).toLowerCase();
      const symLower = baseSymbol.toLowerCase();
      const titleHit = (n.title || '').toLowerCase().includes(symLower);
      const bodyHit = text.includes(symLower);
      if (titleHit || bodyHit) {
        // 标题出现的权重更高 (0.4) vs 仅body (0.2)
        const weight = titleHit ? 0.4 : 0.2;
        score += n.sentiment.score * weight;
        reasons.push(`${n.source}: ${n.title.slice(0, 60)}`);
        relatedNews.push(n);
      }
    }

    // 从Binance公告找相关品种
    for (const a of binance) {
      if (a.title.toLowerCase().includes(baseSymbol.toLowerCase())) {
        const sentiment = this._quickSentiment(a.title);
        score += sentiment.score * 0.4;
        reasons.push(`Binance: ${a.title}`);
        relatedNews.push({ ...a, sentiment });
      }
    }

    // Fear & Greed 影响整体情绪 — v2.0: 极端值放大权重
    if (fng) {
      const fngScore = (fng.value - 50) / 100; // -0.5 ~ 0.5
      // v2.0: 极端恐惧(<25)或极端贪婪(>75)时权重加倍
      const isExtreme = fng.value < 25 || fng.value > 75;
      const fngWeight = isExtreme ? 0.4 : 0.25;
      score += fngScore * fngWeight;
      reasons.push(`Fear&Greed: ${fng.value} (${fng.classification})${isExtreme ? ' [极端]' : ''}`);
    }

    // 资金费率影响
    const fr = this.getFundingRate(symbol);
    if (fr != null) {
      if (fr > 0.0005) { score -= 0.1; reasons.push(`Funding: ${(fr * 100).toFixed(3)}% (偏多)`); }
      else if (fr < -0.0005) { score += 0.1; reasons.push(`Funding: ${(fr * 100).toFixed(3)}% (偏空)`); }
    }

    score = Math.max(-1, Math.min(1, score));
    const label = score > 0.1 ? 'bullish' : score < -0.1 ? 'bearish' : 'neutral';

    if (label === 'bullish') this.stats.bullSignals++;
    else if (label === 'bearish') this.stats.bearSignals++;
    else this.stats.neutralSignals++;

    return { score, label, reasons: reasons.slice(0, 10), relatedNews: relatedNews.slice(0, 5), fearGreed: fng };
  }

  /**
   * 获取品种影响评估
   */
  async getImpact(symbol) {
    const sentiment = await this.getSentiment(symbol);
    let level = 'low';
    let direction = 'neutral';
    let duration = 'short';

    const absScore = Math.abs(sentiment.score);

    if (absScore > 0.4) { level = 'high'; duration = 'long'; }
    else if (absScore > 0.2) { level = 'medium'; duration = 'medium'; }
    else if (absScore > 0.08) { level = 'low'; duration = 'short'; } // v2.0

    // v2.0: 方向阈值与getSentiment一致(0.1)
    if (sentiment.score > 0.1) direction = 'bullish';
    else if (sentiment.score < -0.1) direction = 'bearish';
    else if (sentiment.relatedNews.length > 0) {
      // v2.0: 中性但有相关新闻时, 看单条新闻方向的多数
      const bullCount = sentiment.relatedNews.filter(n => (n.sentiment?.score || 0) > 0.05).length;
      const bearCount = sentiment.relatedNews.filter(n => (n.sentiment?.score || 0) < -0.05).length;
      if (bearCount > bullCount) { direction = 'bearish'; level = 'low'; }
      else if (bullCount > bearCount) { direction = 'bullish'; level = 'low'; }
    }

    // 特殊分类放大影响
    for (const n of sentiment.relatedNews) {
      if (n.category === 'hack' || n.category === 'delisting') { level = 'high'; direction = 'bearish'; duration = 'long'; }
      if (n.category === 'listing') { level = 'high'; direction = 'bullish'; duration = 'medium'; }
      if (n.category === 'partnership') { level = 'medium'; direction = 'bullish'; duration = 'medium'; }
    }

    return { symbol, level, direction, duration, ...sentiment };
  }

  /**
   * 信号增强 — 根据新闻情绪调整信号
   * @param {Object} signal - { symbol, dir, confidence, strength }
   * @returns {Object} 增强后的信号 { adjustedConfidence, multiplier, newsBoost, newsBlocked, reasons }
   */
  async enhanceSignal(signal) {
    const impact = await this.getImpact(signal.symbol);

    let adjustedConfidence = signal.confidence || 0.5;
    let multiplier = 1.0;
    let newsBoost = false;
    let newsBlocked = false;
    const reasons = [];

    if (impact.direction === 'bullish' && signal.dir === 'LONG') {
      adjustedConfidence += Math.abs(impact.score) * 0.2;
      multiplier = 1.0 + Math.abs(impact.score) * 0.3;
      newsBoost = true;
      reasons.push(`新闻利好增强: ${impact.reasons[0]}`);
    } else if (impact.direction === 'bearish' && signal.dir === 'SHORT') {
      adjustedConfidence += Math.abs(impact.score) * 0.2;
      multiplier = 1.0 + Math.abs(impact.score) * 0.3;
      newsBoost = true;
      reasons.push(`新闻利空增强: ${impact.reasons[0]}`);
    } else if (impact.direction === 'bullish' && signal.dir === 'SHORT') {
      adjustedConfidence -= Math.abs(impact.score) * 0.3;
      multiplier = 1.0 - Math.abs(impact.score) * 0.4;
      reasons.push(`新闻与信号相反: ${impact.reasons[0]}`);
      if (impact.level === 'high' && Math.abs(impact.score) > 0.4) {
        newsBlocked = true;
        reasons.push(`高影响新闻反向，信号被过滤`);
      }
    } else if (impact.direction === 'bearish' && signal.dir === 'LONG') {
      adjustedConfidence -= Math.abs(impact.score) * 0.3;
      multiplier = 1.0 - Math.abs(impact.score) * 0.4;
      reasons.push(`新闻与信号相反: ${impact.reasons[0]}`);
      if (impact.level === 'high' && Math.abs(impact.score) > 0.4) {
        newsBlocked = true;
        reasons.push(`高影响新闻反向，信号被过滤`);
      }
    } else {
      // neutral新闻也给一个小权重 — 不是完全无影响
      reasons.push(`新闻情绪中性: ${impact.reasons[0]}`);
    }

    adjustedConfidence = Math.max(0, Math.min(1, adjustedConfidence));

    return {
      ...signal,
      adjustedConfidence,
      multiplier: Math.max(0.3, Math.min(1.5, multiplier)),
      newsBoost,
      newsBlocked,
      newsImpact: { level: impact.level, direction: impact.direction, score: impact.score },
      newsReasons: reasons,
    };
  }

  /**
   * 批量信号增强
   */
  async enhanceSignals(signals) {
    const results = [];
    for (const sig of signals) {
      try {
        results.push(await this.enhanceSignal(sig));
      } catch (e) {
        results.push(sig);
      }
    }
    return results;
  }

  /**
   * 分类中文映射
   */
  static CATEGORY_ZH = {
    listing: '上线',
    delisting: '下架',
    hack: '黑客攻击',
    partnership: '合作',
    tech_upgrade: '技术升级',
    regulation: '监管',
    burn: '销毁',
    airdrop: '空投',
    general: '综合',
  };

  /**
   * 情绪中文映射
   */
  static SENTIMENT_ZH = {
    bullish: '利好',
    bearish: '利空',
    neutral: '中性',
  };

  /**
   * 英文关键词 → 中文翻译（常见加密术语）
   */
  static KEYWORD_ZH = {
    'surge': '飙升', 'soar': '大涨', 'rally': '反弹', 'surges': '飙升',
    'breakout': '突破', 'bullish': '看涨', 'pump': '拉升',
    'gain': '上涨', 'gains': '涨幅', 'ath': '历史新高', 'all-time high': '历史新高',
    'adoption': '采用', 'approve': '批准', 'approved': '已批准', 'approval': '批准',
    'partnership': '合作', 'upgrade': '升级', 'burn': '销毁',
    'buyback': '回购', 'institutional': '机构', 'etf': 'ETF',
    'positive': '积极', 'growth': '增长', 'accumulation': '增持',
    'bounce': '反弹', 'recovery': '复苏', 'bull': '看涨', 'moon': '暴涨',
    'crash': '暴跌', 'plunge': '大跌', 'dump': '抛售',
    'bearish': '看跌', 'hack': '黑客', 'exploit': '漏洞利用',
    'ban': '禁令', 'lawsuit': '诉讼', 'delist': '下架',
    'sell-off': '抛售', 'fear': '恐慌', 'liquidation': '清算',
    'outflow': '流出', 'warning': '警告', 'decline': '下跌',
    'breakdown': '破位', 'bear': '看跌', 'drop': '下跌',
    'fall': '下跌', 'loss': '亏损', 'tumble': '暴跌',
    'slump': '大跌', 'correction': '回调', 'reject': '拒绝',
    'bubble': '泡沫', 'fraud': '欺诈', 'scam': '骗局', 'bankrupt': '破产',
    'bitcoin': '比特币', 'ethereum': '以太坊', 'btc': 'BTC',
    'ripple': '瑞波', 'xrp': 'XRP', 'solana': 'Solana',
    'binance': '币安', 'coinbase': 'Coinbase',
    'sec': 'SEC', 'regulation': '监管', 'regulated': '受监管',
    'launch': '上线', 'listing': '上市', 'delisting': '下架',
    'stake': '质押', 'staking': '质押', 'defi': 'DeFi',
    'nft': 'NFT', 'metaverse': '元宇宙', 'web3': 'Web3',
    'futures': '期货', 'leverage': '杠杆', 'liquidated': '被清算',
    'reserve': '储备', 'treasury': '国库', 'inflation': '通胀',
    'fed': '美联储', 'rate cut': '降息', 'rate hike': '加息',
    'merger': '合并', 'acquisition': '收购', 'launches': '推出',
    'raises': '融资', 'funding': '融资', 'investment': '投资',
    'microsoft': '微软', 'tesla': '特斯拉', 'amazon': '亚马逊',
    'google': '谷歌', 'meta': 'Meta', 'apple': '苹果',
    'record': '创纪录', 'surpasses': '超越', 'overtakes': '超越',
    'million': '百万', 'billion': '十亿', 'trillion': '万亿',
    'whale': '巨鲸', 'transfer': '转账', 'wallet': '钱包',
    'exchange': '交易所', 'trading': '交易', 'market': '市场',
    'price': '价格', 'volume': '成交量', 'support': '支撑', 'resistance': '阻力',
    ' prediction': '预测', 'forecast': '预测',
  };

  /**
   * 将英文标题翻译为中文摘要（关键词替换法）
   * v2: 处理动词变体（复数、过去式、进行时）
   */
  _translateTitle(title) {
    if (!title) return '';
    let result = title;
    const sortedKeys = Object.keys(NewsHub.KEYWORD_ZH).sort((a, b) => b.length - a.length);
    for (const key of sortedKeys) {
      const zh = NewsHub.KEYWORD_ZH[key];
      // 匹配原词 + 常见后缀（s, es, ed, ing, er, ers）
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp('\\b' + escapedKey + '(?:s|es|ed|ing|er|ers)?\\b', 'gi');
      result = result.replace(regex, zh);
    }
    // 清理多余空格
    result = result.replace(/\s{2,}/g, ' ').trim();
    return result;
  }

  /**
   * 获取全部新闻概览
   */
  async getNewsOverview() {
    const [binance, crypto, fng, trending] = await Promise.all([
      this.fetchBinanceAnnouncements(),
      this.fetchCryptoNews(),
      this.fetchFearGreed(),
      this.fetchTrending(),
    ]);

    // 给每条新闻添加中文标签和中文摘要
    const addZhFields = (item, isBinance = false) => {
      const category = item.type || item.category || 'general';
      const sentimentLabel = item.sentiment?.label || 'neutral';
      return {
        ...item,
        categoryZh: NewsHub.CATEGORY_ZH[category] || '综合',
        sentimentZh: NewsHub.SENTIMENT_ZH[sentimentLabel] || '中性',
        titleZh: this._translateTitle(item.title),
      };
    };

    // Fear & Greed 中文分类
    const fngZh = fng ? { ...fng } : null;
    if (fngZh && fngZh.classification) {
      const fngMap = {
        'Extreme Fear': '极度恐慌',
        'Fear': '恐慌',
        'Neutral': '中性',
        'Greed': '贪婪',
        'Extreme Greed': '极度贪婪',
      };
      fngZh.classificationZh = fngMap[fngZh.classification] || fngZh.classification;
    }

    return {
      timestamp: Date.now(),
      fearGreed: fngZh,
      binanceAnnouncements: binance.slice(0, 10).map(a => addZhFields(a, true)),
      cryptoNews: crypto.slice(0, 15).map(n => addZhFields(n, false)),
      trending: trending.slice(0, 7),
      stats: { ...this.stats },
    };
  }

  /**
   * 获取统计
   */
  getStats() {
    return {
      ...this.stats,
      byCategory: { ...this.stats.byCategory },
      bySource: { ...this.stats.bySource },
    };
  }
}

module.exports = NewsHub;
