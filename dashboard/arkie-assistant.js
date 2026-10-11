/**
 * Arkie v115 — MasterD Brain 的儿子
 * 1. _extractSymbol 覆盖全部30个币种+模糊匹配+中文名
 * 2. 管理员/用户双通道平仓
 * 3. 上下文记忆
 * 4. 数据驱动回答（不依赖LLM）
 * 5. 用户专属查询（余额/持仓/交易记录）
 */
const TRADING_PAIRS = require('../config/trading-pairs');

class ArkieAssistant {
  constructor(engine, opts = {}) {
    this.engine = engine;
    this.brain = engine.brain;
    this.dataBus = engine.dataBus;
    this.guardian = engine.guardian;
    this.trader = engine.trader;
    this.agent = engine.masterdAgent || null;
    this.news = engine.news || engine.masterdAgent?.news || null;
    this.cexUserTrader = opts.cexUserTrader || engine._cexUserTrader || null;
    this.userDB = opts.userDB || null;
    this.name = 'Arkie';
    this.father = 'MasterD';
    this.conversationHistory = [];
    this.userHistories = {};
    this.maxHistory = 30;
  }


  async chat(message, context = {}) {
    const msg = (message || '').trim();
    this._lastMsg = msg; // 供子方法提取地址等
    const msgLower = msg.toLowerCase();
    const userId = context.userId || context.wallet || 'admin';
    const wallet = context.wallet || null;
    const isAdmin = context.isAdmin || false;
    this._saveToHistory(userId, 'user', msg);

    try {
      // ═══ ARK 生态专属 ═══
      if (this._matchAny(msgLower, ['ark价格','ark多少钱','ark币','ark现价','ark coin','ark token','arkusdt','ark usdt'])) {
        return this._reply(await this._getArkPrice());
      }
      if (this._matchAny(msgLower, ['arkie价格','arkie多少钱','arkie币','arkie现价','子币','阿奇'])) {
        return this._reply(await this._getArkiePrice());
      }
      if (this._matchAny(msgLower, ['ark池','ark底池','ark流动性','ark liquidity','ark市值','ark数据'])) {
        return this._reply(await this._getArkPool());
      }
      if (this._matchAny(msgLower, ['质押','stake','staking','复利','compound','收益计算','年化','apy'])) {
        return this._reply(this._parseStake(msg));
      }
      if (this._matchAny(msgLower, ['我的ark','ark持仓','ark余额','我有多少ark','查ark'])) {
        return this._reply(await this._getArkHoldings(userId, wallet));
      }
      if (this._matchAny(msgLower, ['鲸鱼','whale','大额转账','大单','巨鲸'])) {
        return this._reply(await this._getWhaleWatch());
      }
      if (this._matchAny(msgLower, ['ark信号','交易信号','买卖信号','signal','买点','卖点','开仓信号'])) {
        return this._reply(await this._arkSignal());
      }
      if (this._matchAny(msgLower, ['ark预测','ark价格预测','ark forecast','ark会到哪里','ark目标价','ark能到','ark涨到多少','ark目标'])) {
        return this._reply(await this._arkForecast());
      }
      if (this._matchAny(msgLower, ['ark走势','ark会涨','ark展望','ark怎么看','ark分析','ark能买'])) {
        return this._reply(await this._arkOutlook());
      }
      if (this._matchAny(msgLower, ['ark指标','ark技术','ark rsi','ark均线','ark布林','ark技术分析','ark k线','arkk线'])) {
        return this._reply(await this._arkIndicators());
      }
      if (this._matchAny(msgLower, ['我的订阅','查看订阅','my alerts','订阅列表','看订阅'])) {
        return this._reply(this._listSubs(userId));
      }
      if (this._matchAny(msgLower, ['订阅','提醒我','设置提醒','alert me','subscribe','提醒'])) {
        return this._reply(this._subscribe(msg, userId));
      }
      if (this._matchAny(msgLower, ['ark生态','ark工具','工具站','citizen','公民'])) {
        return this._reply(this._getArkEcosystem());
      }

      if (this._matchAny(msgLower, ['你好','hello','hi','嗨','hey','在吗','在不在'])) {
        return this._reply('你好！我是 Arkie，MasterD 的儿子。\n我可以帮你查行情、看持仓、分析市场、执行交易。');
      }
      if (this._matchAny(msgLower, ['你是谁','你叫什么','介绍'])) {
        return this._reply('我是 Arkie，父亲是 MasterD。\n能力：实时行情分析(30币种)、持仓管理(管理员+用户双通道)、止盈止损、交易执行、策略生成、新闻情绪。\n输入帮助查看完整指令。');
      }
      if (this._matchAny(msgLower, ['帮助','help','能做什么','功能','commands'])) {
        return this._reply(this._getHelp());
      }
      if (this._matchAny(msgLower, ['余额','balance','多少钱','资产','资金','账户'])) {
        return this._reply(await this._getBalance(userId, wallet, isAdmin));
      }
      if (this._matchAny(msgLower, ['持仓','仓位','position','holding','开了什么'])) {
        return this._reply(await this._getPositions(userId, wallet, isAdmin));
      }
      if (this._matchAny(msgLower, ['交易记录','历史','trades','history','最近交易','平仓记录'])) {
        return this._reply(await this._getTradeHistory(userId, wallet, isAdmin));
      }
      if (this._matchAny(msgLower, ['价格','行情','price','涨跌','怎么样','多少'])) {
        const symbol = this._extractSymbol(msgLower);
        if (symbol) return this._reply(await this._getMarketData(symbol));
        return this._reply(await this._getMarketOverview());
      }
      if (this._matchAny(msgLower, ['深度分析','deep','agent分析','分身分析','推理链'])) {
        const symbol = this._extractSymbol(msgLower);
        if (symbol) return this._reply(await this._agentDeepAnalyze(symbol));
        return this._reply('告诉我要深度分析哪个币？比如"深度分析 BTCUSDT"');
      }
      if (this._matchAny(msgLower, ['分析','analyze','该不该','要不要','买不买','怎么看','能不能'])) {
        const symbol = this._extractSymbol(msgLower);
        if (symbol) return this._reply(await this._analyzeSymbol(symbol));
        return this._reply('告诉我要分析哪个币？比如"分析 BTCUSDT"');
      }
      if (this._matchAny(msgLower, ['市场','market','overview','总览','大盘','整体'])) {
        return this._reply(await this._getMarketOverview());
      }
      if (this._matchAny(msgLower, ['平仓','close','止损','卖出','清仓','平掉'])) {
        const symbol = this._extractSymbol(msgLower);
        if (symbol) return this._reply(await this._closePosition(symbol, userId, wallet, isAdmin));
        return this._reply('告诉我你要平哪个仓？比如"平仓 BTCUSDT"');
      }
      if (this._matchAny(msgLower, ['暂停','pause','停止','stop','关掉'])) {
        this.engine.paused = true;
        return this._reply('引擎已暂停。说"启动"恢复。');
      }
      if (this._matchAny(msgLower, ['启动','resume','start','开始','恢复','继续运行'])) {
        this.engine.paused = false;
        return this._reply('引擎已恢复运行。');
      }
      if (this._matchAny(msgLower, ['brain','大脑','进化'])) {
        return this._reply(this._getBrainStats());
      }
      if (this._matchAny(msgLower, ['agent','分身','克隆','ai状态','agent状态'])) {
        return this._reply(this._getAgentStatus());
      }
      if (this._matchAny(msgLower, ['神经网络','neural','训练','train'])) {
        return this._reply(this._getNeuralStats());
      }
      if (this._matchAny(msgLower, ['配对','pairs','套利','arbitrage'])) {
        return this._reply(this._getPairsSignals());
      }
      if (this._matchAny(msgLower, ['新闻','news','消息','公告','fear','greed','恐慌','贪婪'])) {
        return this._reply(await this._getNews());
      }
      if (this._matchAny(msgLower, ['反思','lesson','课程','学到了什么','经验'])) {
        return this._reply(this._getAgentLessons());
      }
      if (this._matchAny(msgLower, ['模型','model','llm','大模型','deepseek','openai','claude','gpt'])) {
        return this._reply(this._getLLMStatus());
      }
      if (this._matchAny(msgLower, ['生成策略','写策略','写个策略','新策略','create strategy'])) {
        const desc = msg.replace(/.*(?:生成|写|创建|create).*策略/, '').trim();
        return this._reply(await this._agentGenerateStrategy(desc || '基于RSI和布林带的反转策略'));
      }
      if (this._matchAny(msgLower, ['我的持仓','我的仓位','my position'])) {
        if (wallet) return this._reply(await this._getUserPositions(wallet));
        return this._reply('请先登录后使用此功能。');
      }
      if (this._matchAny(msgLower, ['我的余额','我的资产','my balance'])) {
        if (wallet) return this._reply(await this._getUserBalance(wallet));
        return this._reply('请先登录后使用此功能。');
      }

      // 上下文驱动
      const ctxReply = await this._contextualReply(msg, userId);
      if (ctxReply) return this._reply(ctxReply);

      // 数据驱动
      const dataReply = this._dataDrivenReply(msgLower);
      if (dataReply) return this._reply(dataReply);

      // LLM
      const llmReply = await this._llmChat(msg, userId);
      if (llmReply) return this._reply(llmReply);

      return this._reply(this._getFallbackReply(msg));
    } catch (e) {
      console.error('[Arkie] error:', e.message);
      return this._reply('处理出错：' + e.message);
    }
  }


  _matchAny(msg, keywords) {
    return keywords.some(k => {
      if (k.includes('.*') || k.includes('^') || k.includes('$')) {
        try { return new RegExp(k).test(msg); } catch { return false; }
      }
      return msg.includes(k);
    });
  }

  _extractSymbol(msg) {
    const msgUp = msg.toUpperCase();
    for (const sym of Object.keys(TRADING_PAIRS)) {
      if (msgUp.includes(sym)) return sym;
    }
    const bases = Object.keys(TRADING_PAIRS).map(s => s.replace('USDT', ''));
    for (const base of bases) {
      if (msgUp.includes(base)) return base + 'USDT';
    }
    const cn = { '比特币':'BTCUSDT','以太坊':'ETHUSDT','索拉纳':'SOLUSDT','瑞波':'XRPUSDT','狗狗币':'DOGEUSDT','艾达':'ADAUSDT','雪崩':'AVAXUSDT','链接':'LINKUSDT','波卡':'DOTUSDT','莱特':'LTCUSDT','Polygon':'MATICUSDT','Filecoin':'FILUSDT','Cosmos':'ATOMUSDT','Shiba':'SHIBUSDT','Pepe':'PEPEUSDT' };
    for (const [c, s] of Object.entries(cn)) {
      if (msg.includes(c)) return s;
    }
    const m = msg.toLowerCase().match(/([a-z]{2,6})usdt/);
    if (m) { const c = m[1].toUpperCase()+'USDT'; if (TRADING_PAIRS[c]) return c; }
    return null;
  }

  _saveToHistory(userId, role, text) {
    if (!this.userHistories[userId]) this.userHistories[userId] = [];
    this.userHistories[userId].push({ role, text, ts: Date.now() });
    if (this.userHistories[userId].length > this.maxHistory) this.userHistories[userId].shift();
    this.conversationHistory.push({ role, userId, text, ts: Date.now() });
    if (this.conversationHistory.length > 100) this.conversationHistory.shift();
  }

  _reply(text) {
    const str = typeof text === 'string' ? text : (text?.reply || text?.message || JSON.stringify(text));
    this.conversationHistory.push({ role: 'arkie', text: str, ts: Date.now() });
    if (this.conversationHistory.length > 100) this.conversationHistory.shift();
    return { reply: str, name: this.name, ts: Date.now() };
  }


  async _getBalance(userId, wallet, isAdmin) {
    if (isAdmin || userId === 'admin') {
      const bal = this.engine.engineState?.balance || 0;
      const pnl = this.engine.engineState?.totalPnl || 0;
      const tr = this.engine.engineState?.totalTrades || 0;
      const w = this.engine.engineState?.wins || 0;
      const wr = tr > 0 ? ((w/tr)*100).toFixed(1) : '0';
      return '💰 管理员余额：$' + bal.toFixed(2) + '\n📈 累计盈亏：$' + pnl.toFixed(4) + '\n🔄 总交易：' + tr + '次\n✅ 胜率：' + wr + '%';
    }
    if (wallet && this.cexUserTrader) {
      try {
        const client = this.cexUserTrader._clients?.[wallet];
        if (client) {
          const b = await client.getBalance();
          if (b) return '💰 你的余额：\n余额：$' + b.balance.toFixed(2) + '\n可用：$' + b.available.toFixed(2) + '\n未实现盈亏：$' + b.unrealizedPnl.toFixed(4);
        }
      } catch(e) { return '❌ 查询失败：' + e.message; }
    }
    return '❌ 无法查询余额，请确认已登录并配置API Key。';
  }

  async _getPositions(userId, wallet, isAdmin) {
    if (isAdmin || userId === 'admin') {
      const positions = this.guardian?.getAllPositions?.() || {};
      const keys = Object.keys(positions);
      if (keys.length === 0) return '📭 管理员当前无持仓';
      let text = '📊 管理员持仓 ' + keys.length + ' 个：\n';
      for (const [sym, pos] of Object.entries(positions)) {
        const price = this.dataBus?.marketData?.[sym]?.price || pos.markPrice || 0;
        const pnlPct = pos.side === 'LONG'
          ? ((price - pos.entryPrice) / pos.entryPrice * 100 * (pos.leverage || 1))
          : ((pos.entryPrice - price) / pos.entryPrice * 100 * (pos.leverage || 1));
        text += (pnlPct >= 0 ? '🟢' : '🔴') + ' ' + sym + ' ' + pos.side + ' ' + pos.qty + ' @ $' + (pos.entryPrice?.toFixed(2)||'0') + ' | ' + pnlPct.toFixed(2) + '% | ' + (pos.leverage||1) + 'x\n';
      }
      return text;
    }
    if (wallet) return this._getUserPositions(wallet);
    return '❌ 无法查询持仓。';
  }

  async _getUserPositions(wallet) {
    if (!this.cexUserTrader) return '❌ 用户交易器未初始化';
    try {
      const client = this.cexUserTrader._clients?.[wallet];
      if (!client) return '❌ 未找到你的交易客户端，请确认已配置API Key';
      const positions = await client.getAllPositions();
      if (!positions || positions.length === 0) return '📭 你当前无持仓';
      let text = '📊 你的持仓 ' + positions.length + ' 个：\n';
      for (const pos of positions) {
        const pnlPct = pos.side === 'LONG'
          ? ((pos.markPrice - pos.entryPrice) / pos.entryPrice * 100 * (pos.leverage || 1))
          : ((pos.entryPrice - pos.markPrice) / pos.entryPrice * 100 * (pos.leverage || 1));
        text += (pnlPct >= 0 ? '🟢' : '🔴') + ' ' + pos.symbol + ' ' + pos.side + ' ' + pos.qty + ' @ $' + (pos.entryPrice?.toFixed(2)||'0') + ' | ' + pnlPct.toFixed(2) + '% | ' + (pos.leverage||1) + 'x | PnL: $' + (pos.pnl?.toFixed(4)||'0') + '\n';
      }
      return text;
    } catch(e) { return '❌ 查询失败：' + e.message; }
  }

  async _getUserBalance(wallet) {
    if (!this.cexUserTrader) return '❌ 用户交易器未初始化';
    try {
      const client = this.cexUserTrader._clients?.[wallet];
      if (!client) return '❌ 未找到你的交易客户端';
      const b = await client.getBalance();
      if (!b) return '❌ 无法获取余额';
      return '💰 你的余额：\n余额：$' + b.balance.toFixed(2) + '\n可用：$' + b.available.toFixed(2) + '\n未实现盈亏：$' + b.unrealizedPnl.toFixed(4);
    } catch(e) { return '❌ 查询失败：' + e.message; }
  }


  async _getTradeHistory(userId, wallet, isAdmin) {
    if (isAdmin || userId === 'admin') {
      const trades = this.engine.tradeLog || [];
      if (trades.length === 0) return '📭 暂无交易记录';
      const recent = trades.slice(-10).reverse();
      let text = '📋 最近' + recent.length + '笔交易：\n';
      for (const t of recent) {
        text += ((t.pnl||0)>=0?'🟢':'🔴') + ' ' + (t.symbol||'?') + ' ' + (t.side||'') + ' ' + (t.action||'') + ' PnL=$' + (t.pnl||0).toFixed(4) + ' ' + new Date(t.timestamp||t.ts||Date.now()).toLocaleString('zh-CN',{hour12:false}) + '\n';
      }
      return text;
    }
    if (wallet && this.cexUserTrader) {
      const trades = this.cexUserTrader._tradeLog?.[wallet] || [];
      if (trades.length === 0) return '📭 你暂无交易记录';
      const recent = trades.slice(-10).reverse();
      let text = '📋 你最近' + recent.length + '笔交易：\n';
      for (const t of recent) {
        text += ((t.pnl||0)>=0?'🟢':'🔴') + ' ' + (t.symbol||'?') + ' ' + (t.side||'') + ' PnL=$' + (t.pnl||0).toFixed(4) + ' ' + new Date(t.timestamp||t.ts||Date.now()).toLocaleString('zh-CN',{hour12:false}) + '\n';
      }
      return text;
    }
    return '❌ 无法查询交易记录。';
  }

  /* ══════════ ARK 生态能力 ══════════ */
  async _getArkPrice() {
    try {
      const d = await this._fetchJson('https://api.dexscreener.com/latest/dex/pairs/bsc/0xCAaF3c41a40103a23Eeaa4BbA468AF3cF5b0e0D8');
      const p = (d.pairs && d.pairs[0]) || d.pair || {};
      const price = parseFloat(p.priceUsd || p.priceNative || 0);
      const chg = (p.priceChange && p.priceChange.h24) || 0;
      let t = '🪙 ARK 实时行情 (PancakeSwap V2 BSC)\n';
      t += '价格：$' + price.toFixed(4) + '\n';
      t += '24h涨跌：' + (chg >= 0 ? '+' : '') + (typeof chg === 'number' ? chg.toFixed(2) : chg) + '%\n';
      if (p.marketCap) t += '市值：$' + (p.marketCap / 1e6).toFixed(2) + 'M\n';
      if (p.fdv) t += 'FDV：$' + (p.fdv / 1e6).toFixed(2) + 'M\n';
      if (p.liquidity && p.liquidity.usd) t += '流动性：$' + (p.liquidity.usd / 1e6).toFixed(2) + 'M\n';
      if (p.volume && p.volume.h24) t += '24h量：$' + (p.volume.h24 / 1e6).toFixed(2) + 'M\n';
      t += '\n📍合约：0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D';
      return t;
    } catch (e) {
      return '❌ ARK 价格查询失败: ' + e.message;
    }
  }

  async _getArkiePrice() {
    try {
      const d = await this._fetchJson('https://api.dexscreener.com/latest/dex/pairs/bsc/0x41EceDC0C020153E4526cB8a3dDBc5a3F252b184');
      const p = (d.pairs && d.pairs[0]) || d.pair || {};
      const price = parseFloat(p.priceUsd || 0);
      const chg = (p.priceChange && p.priceChange.h24) || 0;
      let t = '🪙 ARKIE 子币行情 (阿奇 AI)\n';
      t += '价格：$' + price.toFixed(4) + '\n';
      t += '24h涨跌：' + (chg >= 0 ? '+' : '') + (typeof chg === 'number' ? chg.toFixed(2) : chg) + '\n';
      if (p.marketCap) t += '市值：$' + (p.marketCap / 1e6).toFixed(2) + 'M\n';
      if (p.liquidity && p.liquidity.usd) t += '流动性：$' + (p.liquidity.usd / 1e6).toFixed(2) + 'M\n';
      // 计算 ARK 计价
      const arkD = await this._fetchJson('https://api.dexscreener.com/latest/dex/pairs/bsc/0xCAaF3c41a40103a23Eeaa4BbA468AF3cF5b0e0D8').catch(() => null);
      if (arkD) {
        const arkP = parseFloat((arkD.pairs && arkD.pairs[0] && arkD.pairs[0].priceUsd) || 0);
        if (arkP > 0) t += 'ARK 计价：' + (price / arkP).toFixed(4) + ' ARK\n';
      }
      t += '\n📍合约：0x6cd3025F851F36e74937D4e652f6AE9D4b2E88cF';
      return t;
    } catch (e) {
      return '❌ ARKIE 价格查询失败: ' + e.message;
    }
  }

  async _getArkPool() {
    try {
      const d = await this._fetchJson('https://api.dexscreener.com/latest/dex/pairs/bsc/0xCAaF3c41a40103a23Eeaa4BbA468AF3cF5b0e0D8');
      const p = (d.pairs && d.pairs[0]) || d.pair || {};
      let t = '💧 ARK 流动性池数据\n';
      t += 'Pair：0xCAaF...0D8\n';
      if (p.priceUsd) t += '价格：$' + parseFloat(p.priceUsd).toFixed(4) + '\n';
      if (p.liquidity) {
        t += '底池USD：$' + ((p.liquidity.usd || 0) / 1e6).toFixed(2) + 'M\n';
        t += '底池ARK：' + ((p.liquidity.base || 0) / 1e6).toFixed(2) + 'M ARK\n';
        t += '底池USDT：$' + ((p.liquidity.quote || 0) / 1e6).toFixed(2) + 'M\n';
      }
      if (p.volume && p.volume.h24) t += '24h成交：$' + (p.volume.h24 / 1e6).toFixed(2) + 'M\n';
      if (p.txns && p.txns.h24) t += '24h交易：买' + p.txns.h24.buys + ' / 卖' + p.txns.h24.sells + '\n';
      return t;
    } catch (e) {
      return '❌ 池子查询失败: ' + e.message;
    }
  }

  _parseStake(msg) {
    // 解析: "质押 1000 ark 360天" / "1000 ark 复利一年"
    const amtM = msg.match(/([0-9][0-9,]*)\s*(?:ark|个|枚)?/i);
    const amount = amtM ? parseFloat(amtM[1].replace(/,/g, '')) : null;
    const dayM = msg.match(/([0-9]+)\s*天/);
    const yearM = msg.match(/([0-9.]+)\s*年|一年/);
    let days = 360;
    if (yearM) days = parseFloat(yearM[1] || 1) * 365;
    else if (dayM) days = parseInt(dayM[1], 10);
    if (!amount || amount <= 0) {
      return '💹 ARK 质押收益计算\n\n用法：质押 <数量> [天数]\n例如：\n• "质押 1000" — 默认360天\n• "质押 5000 720天"\n• "质押 10000 1年"\n\n参考日收益率(360天方案)：0.28%\n等效年化约 177%';
    }
    const rate = 0.0028; // 360天方案日收益率(与工具站一致)
    const earned = amount * (Math.pow(1 + rate, days) - 1);
    const total = amount + earned;
    const apy = (Math.pow(1 + rate, 365) - 1) * 100;
    let t = '💹 ARK 质押收益（360天方案）\n\n';
    t += '质押数量：' + amount.toLocaleString() + ' ARK\n';
    t += '周期：' + days + ' 天\n';
    t += '日收益率：' + (rate * 100).toFixed(2) + '%\n\n';
    t += '📈 到期可得：' + total.toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' ARK\n';
    t += '💰 净增：+' + earned.toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' ARK\n';
    t += '🔺 增长倍数：' + (total / amount).toFixed(2) + 'x\n';
    t += '⚡ 等效年化：' + apy.toFixed(1) + '%\n\n';
    t += '参考工具站：https://3582784c.strike-agent.com';
    return t;
  }

  async _getArkHoldings(userId, wallet) {
    let addr = wallet || (userId && /^0x[0-9a-fA-F]{40}$/.test(userId) ? userId : null);
    // 从消息里提取 0x 地址
    if (!addr) {
      const m = (this._lastMsg || '').match(/0x[0-9a-fA-F]{40}/);
      if (m) addr = m[0];
    }
    if (!addr) return '请输入你的钱包地址，例如：我的ARK 0xB5E1...';
    try {
      const A = addr.toLowerCase().slice(2).padStart(64, '0');
      const rpc = async (to, method) => {
        const r = await fetch('https://bsc-rpc.publicnode.com', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data: method + A }, 'latest'] })
        });
        const j = await r.json();
        return j.result && j.result !== '0x' ? BigInt(j.result) : 0n;
      };
      const [ark, arkie, gark] = await Promise.all([
        rpc('0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D', '0x70a08231'),
        rpc('0x6cd3025F851F36e74937D4e652f6AE9D4b2E88cF', '0x70a08231'),
        rpc('0x911f12D137D74E5917877f87cf8A8bB2FDde557f', '0x70a08231'),
      ]);
      const f = (v) => (Number(v) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 4 });
      let t = '👛 链上持仓 (' + addr.slice(0, 6) + '...' + addr.slice(-4) + ')\n\n';
      t += 'ARK：' + f(ark) + '\n';
      t += 'ARKIE：' + f(arkie) + '\n';
      t += 'gARK：' + f(gark) + '\n';
      return t;
    } catch (e) {
      return '❌ 持仓查询失败: ' + e.message;
    }
  }

  async _getWhaleWatch() {
    try {
      const blk = await fetch('https://bsc-rpc.publicnode.com', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })
      }).then(r => r.json());
      const latest = parseInt(blk.result, 16);
      const from = latest - 30;
      const logs = await fetch('https://bsc-rpc.publicnode.com', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
          params: [{ fromBlock: '0x' + from.toString(16), toBlock: 'latest', address: '0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'] }]
        })
      }).then(r => r.json());
      const arr = (logs.result || []).map(lg => ({
        amt: Number(BigInt(lg.data)) / 1e18,
        from: '0x' + lg.topics[1].slice(26),
        to: '0x' + lg.topics[2].slice(26),
      })).filter(x => x.amt >= 1000).sort((a, b) => b.amt - a.amt);
      if (!arr.length) return '🐋 鲸鱼监控（最近约30区块）\n\n暂未发现 >1000 ARK 的大额转账。';
      let t = '🐋 鲸鱼监控（最近约30区块）\n\n';
      for (const w of arr.slice(0, 8)) {
        t += '• ' + w.amt.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' ARK  ' + w.from.slice(0, 8) + '... → ' + w.to.slice(0, 8) + '...\n';
      }
      return t;
    } catch (e) {
      return '❌ 鲸鱼监控失败: ' + e.message;
    }
  }

  _getArkEcosystem() {
    return '🌟 ARK 生态\n\n' +
      '🪙 ARK 代币：0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D\n' +
      '🔗 ARK/USDT 池：0xCAaF3c41a40103a23Eeaa4BbA468AF3cF5b0e0D8\n' +
      '🪙 ARKIE 子币：0x6cd3025F851F36e74937D4e652f6AE9D4b2E88cF\n' +
      '🏛️ gARK 治理：0x911f12D137D74E5917877f87cf8A8bB2FDde557f\n\n' +
      '🛠️ ARK 工具站：\nhttps://3582784c.strike-agent.com\n' +
      '  · 收益看板 / 质押计算\n' +
      '  · 价格预警 / 链上持仓 / 鲸鱼监控\n' +
      '  · 7 语言支持\n\n' +
      '💬 问我：ARK价格 / ARKIE价格 / ARK池 / 质押计算 / 鲸鱼 / 我的ARK';
  }

  async _fetchJson(url) {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  async _getMarketData(symbol) {
    if (!symbol) return this._getMarketOverview();
    const d = this.dataBus?.marketData?.[symbol];
    if (!d) return '❌ 找不到 ' + symbol + ' 的数据';
    const change = d.priceChange24h || d.change24h || 0;
    let text = '📊 ' + symbol + '\n';
    text += '价格：$' + (d.price?.toFixed(d.price<1?4:2)||'N/A') + '\n';
    text += '24h涨跌：' + (change>=0?'+':'') + change.toFixed(2) + '%\n';
    text += '24h最高：$' + (d.high24h?.toFixed(2)||'N/A') + '\n';
    text += '24h最低：$' + (d.low24h?.toFixed(2)||'N/A') + '\n';
    const ind = this.dataBus?.indicators?.[symbol];
    if (ind) {
      text += '\n📈 技术指标：\n';
      text += 'RSI: ' + (ind.rsi?.toFixed(1)||'N/A') + '\n';
      text += 'MA7: ' + (ind.ma7?.toFixed(2)||'N/A') + ' MA25: ' + (ind.ma25?.toFixed(2)||'N/A') + ' MA99: ' + (ind.ma99?.toFixed(2)||'N/A') + '\n';
      text += 'ATR: ' + (ind.atrPercent?.toFixed(2)||'N/A') + '%\n';
      text += 'ADX: ' + (ind.adx?.toFixed(1)||'N/A') + '\n';
    }
    return text;
  }

  async _getMarketOverview() {
    const md = this.dataBus?.marketData || {};
    const symbols = Object.keys(md).filter(s => !s.startsWith('_'));
    let up=0, down=0, total=0;
    for (const s of symbols) {
      const c = md[s]?.priceChange24h || md[s]?.change24h || 0;
      if (c>0) up++; else if (c<0) down++;
      total += c;
    }
    const avg = symbols.length > 0 ? total/symbols.length : 0;
    let text = '🌍 市场总览：\n上涨：' + up + ' | 下跌：' + down + ' | 总数：' + symbols.length + '\n';
    text += '平均涨跌：' + (avg>=0?'+':'') + avg.toFixed(2) + '%\n';
    text += avg>1 ? '🔥 市场偏多' : avg<-1 ? '❄️ 市场偏空' : '😐 市场中性';
    const sorted = symbols.map(s => ({s, c: md[s]?.priceChange24h||md[s]?.change24h||0})).filter(x=>x.c!==0).sort((a,b)=>b.c-a.c);
    if (sorted.length >= 3) {
      text += '\n\n📈 涨幅TOP3：';
      for (let i=0; i<Math.min(3,sorted.length); i++) text += '\n' + (i+1) + '. ' + sorted[i].s + ' ' + (sorted[i].c>=0?'+':'') + sorted[i].c.toFixed(2) + '%';
      text += '\n\n📉 跌幅TOP3：';
      for (let i=sorted.length-1; i>=Math.max(0,sorted.length-3); i--) text += '\n' + (sorted.length-i) + '. ' + sorted[i].s + ' ' + sorted[i].c.toFixed(2) + '%';
    }
    return text;
  }

  async _analyzeSymbol(symbol) {
    if (!symbol) return '告诉我你要分析哪个币？';
    const klines = this.dataBus?.klines?.[symbol];
    if (!klines || klines.length < 50) return '❌ ' + symbol + ' 数据不足';
    const ind = this.dataBus?.indicators?.[symbol] || {};
    const fr = this.dataBus?.marketData?.[symbol]?.fundingRate || null;
    const lr = this.dataBus?.marketData?.[symbol]?.longShortRatio || null;
    const sent = this.dataBus?.marketData?.[symbol]?.sentiment || null;
    const positions = this.guardian?.getAllPositions?.() || {};
    const d = this.brain.analyze(symbol, klines, null, ind, fr, lr, sent, positions);
    let text = '🧠 ' + symbol + ' 分析报告：\n';
    text += '═══════════════════════\n';
    text += '综合评分：' + d.compositeScore + '\n';
    text += '方向：' + d.action + '\n';
    text += '信心度：' + ((d.confidence||0)*100).toFixed(0) + '%\n';
    text += '市场体制：' + d.marketRegime + '\n';
    text += '风险等级：' + d.riskLevel + '\n';
    text += '依据：' + d.reasoning + '\n';
    if (d.canOpen) {
      text += '\n✅ 建议开仓：' + d.action + ' 杠杆' + d.leverage + 'x 仓位' + d.positionPct + '%\n';
      text += '止损：' + d.slPct + '% 止盈：' + d.tpPct + '%';
    } else {
      text += '\n⏸️ 暂不开仓：' + (d.blockReasons?.join(', ')||'');
    }
    return text;
  }


  async _closePosition(symbol, userId, wallet, isAdmin) {
    if (!symbol) return '告诉我你要平哪个仓？';
    if (isAdmin || userId === 'admin') {
      const positions = this.guardian?.getAllPositions?.() || {};
      if (!positions[symbol]) return '❌ 管理员没有 ' + symbol + ' 的持仓';
      try {
        await this.engine._executeClose(symbol, 'Arkie用户请求平仓');
        return '✅ ' + symbol + ' 管理员仓位已平仓';
      } catch(e) { return '❌ 平仓失败：' + e.message; }
    }
    if (wallet && this.cexUserTrader) {
      try {
        const client = this.cexUserTrader._clients?.[wallet];
        if (!client) return '❌ 未找到你的交易客户端';
        const pos = await client.getRealPosition(symbol);
        if (!pos) return '❌ 你没有 ' + symbol + ' 的持仓';
        const result = await client.closePosition(symbol);
        if (result.success) return '✅ ' + symbol + ' 已平仓 | PnL: $' + (result.pnl?.toFixed(4)||'0');
        return '❌ 平仓失败';
      } catch(e) { return '❌ 平仓失败：' + e.message; }
    }
    return '❌ 无法执行平仓。请确认已登录。';
  }

  async _contextualReply(msg, userId) {
    const history = this.userHistories[userId] || [];
    if (history.length < 2) return null;
    const lastArkie = history.filter(h => h.role === 'arkie').slice(-1)[0]?.text || '';
    if (lastArkie.includes('告诉我要分析哪个币') || lastArkie.includes('告诉我要平哪个仓')) {
      const symbol = this._extractSymbol(msg);
      if (symbol) {
        if (lastArkie.includes('分析')) return this._analyzeSymbol(symbol);
        if (lastArkie.includes('平仓')) return this._closePosition(symbol, userId, null, false);
      }
    }

    // ⭐ 增强: 记住上文提到的币种 + ARK 主题
    const ctxSymbol = this._lastSymbol(userId);
    const ctxArk = this._lastTopic(userId) === 'ark';

    // 追问型: "那我要买吗" "它会涨吗" "推荐吗"
    if (/值得|该买|该卖|要不要|会涨|会跌|能买|推荐|怎么样|如何|好吗|行吗|买吗|卖吗/.test(msg)) {
      if (ctxArk) return await this._arkOutlook();
      if (ctxSymbol) return this._dataDrivenReply(ctxSymbol + ' 会涨吗');
    }

    // 纯追问: "那我呢" "多少" "分析下"
    if (/^(那|那么|然后)?\s*(呢|多少|怎么样|分析下|说下|继续|然后呢)/.test(msg)) {
      if (ctxArk) return await this._arkOutlook();
      if (ctxSymbol) return this._dataDrivenReply(ctxSymbol + ' 价格');
    }

    return null;
  }

  // 提取本用户最近提到的币种
  _lastSymbol(userId) {
    const h = this.userHistories[userId] || [];
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].role !== 'user') continue;
      const s = this._extractSymbol(h[i].text);
      if (s) return s;
    }
    return null;
  }

  // 提取本用户最近的主题 (ark / arkie)
  _lastTopic(userId) {
    const h = this.userHistories[userId] || [];
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].role !== 'user') continue;
      const t = h[i].text.toLowerCase();
      if (t.includes('arkie')) return 'arkie';
      if (t.includes('ark')) return 'ark';
    }
    return null;
  }

  /* ══════════ 提醒订阅 ══════════ */
  _subsPath() {
    const path = require('path');
    const dir = path.join(__dirname, '..', 'data');
    try { require('fs').mkdirSync(dir, { recursive: true }); } catch (e) {}
    return path.join(dir, 'arkie-subs.json');
  }

  _loadSubs() {
    try { return JSON.parse(require('fs').readFileSync(this._subsPath(), 'utf8')) || []; }
    catch (e) { return []; }
  }

  _saveSubs(list) {
    try { require('fs').writeFileSync(this._subsPath(), JSON.stringify(list, null, 1)); } catch (e) {}
  }

  _subscribe(msg, userId) {
    // 解析: "ARK 涨到 10 提醒我" / "ARK 跌到 5 提醒" / "订阅 ARK 涨破 8"
    const above = msg.match(/(?:涨到|涨破|高于|突破|above|>)\s*([\d.]+)/i);
    const below = msg.match(/(?:跌到|跌破|低于|below|<)\s*([\d.]+)/i);
    let kind = null, target = null;
    if (above) { kind = 'above'; target = parseFloat(above[1]); }
    else if (below) { kind = 'below'; target = parseFloat(below[1]); }
    if (!kind || !(target > 0)) {
      return '🔔 提醒订阅\n\n用法：\n• "ARK 涨到 10 提醒我"\n• "ARK 跌到 5 提醒"\n• "订阅 ARK 突破 8"\n\n查看："我的订阅"';
    }
    const list = this._loadSubs();
    const id = Math.random().toString(36).slice(2, 10);
    list.push({ id, userId, kind, target, created: Date.now(), triggered: false });
    this._saveSubs(list);
    const mine = list.filter(x => x.userId === userId);
    return '✅ 已订阅提醒\n\nARK ' + (kind === 'above' ? '涨到 ≥ $' : '跌到 ≤ $') + target +
      '\n当前订阅数：' + mine.length + '\n\n系统会在达到目标价时通知你。输入"我的订阅"查看全部。';
  }

  _listSubs(userId) {
    const mine = this._loadSubs().filter(x => x.userId === userId);
    if (!mine.length) return '📭 你还没有订阅提醒。\n\n试试："ARK 涨到 10 提醒我"';
    let t = '🔔 我的订阅 (' + mine.length + ')\n\n';
    for (const s of mine) {
      t += '• ARK ' + (s.kind === 'above' ? '≥ $' : '≤ $') + s.target +
        (s.triggered ? ' ✅已触发' : ' ⏳监控中') + '\n';
    }
    return t;
  }

  // 外部调用: 检查并返回触发的订阅
  async checkSubs() {
    try {
      const list = this._loadSubs();
      const pending = list.filter(s => !s.triggered);
      if (!pending.length) return [];
      const d = await this._fetchJson('https://api.dexscreener.com/latest/dex/pairs/bsc/0xCAaF3c41a40103a23Eeaa4BbA468AF3cF5b0e0D8');
      const p = (d.pairs && d.pairs[0]) || {};
      const price = parseFloat(p.priceUsd || 0);
      if (!price) return [];
      const hits = [];
      for (const s of list) {
        if (s.triggered) continue;
        if ((s.kind === 'above' && price >= s.target) || (s.kind === 'below' && price <= s.target)) {
          s.triggered = true; s.triggeredAt = Date.now(); s.triggeredPrice = price;
          hits.push({ userId: s.userId, msg: '🔔 ARK 提醒触发！\n现价 $' + price.toFixed(4) + '（目标 ' + (s.kind === 'above' ? '≥' : '≤') + ' $' + s.target + '）' });
        }
      }
      if (hits.length) this._saveSubs(list);
      return hits;
    } catch (e) { return []; }
  }

  // ARK 交易信号（多因子融合 → 买/卖/观望）
  async _arkSignal() {
    try {
      const gt = await this._fetchJson('https://api.geckoterminal.com/api/v2/networks/bsc/pools/0xCAaF3c41a40103a23Eeaa4BbA468AF3cF5b0e0D8/ohlcv/hour?aggregate=1&limit=200').catch(() => null);
      let closes = [], highs = [], lows = [];
      if (gt && gt.data && gt.data.attributes && gt.data.attributes.ohlcv_list) {
        const list = gt.data.attributes.ohlcv_list.slice().reverse();
        closes = list.map(r => parseFloat(r[4]));
        highs = list.map(r => parseFloat(r[2]));
        lows = list.map(r => parseFloat(r[3]));
      }
      const d = await this._fetchJson('https://api.dexscreener.com/latest/dex/pairs/bsc/0xCAaF3c41a40103a23Eeaa4BbA468AF3cF5b0e0D8');
      const p = (d.pairs && d.pairs[0]) || {};
      const price = parseFloat(p.priceUsd || 0);
      if (closes.length < 30 || !price) return '⚠️ 数据不足，无法生成交易信号。';
      const n = closes.length;
      const ma = (arr, k) => arr.slice(-k).reduce((a, b) => a + b, 0) / Math.min(k, arr.length);
      const ma7 = ma(closes, 7), ma25 = ma(closes, 25), ma99 = ma(closes, 99);
      // RSI
      let g = 0, l = 0;
      for (let i = n - 14; i < n; i++) { const c = closes[i] - closes[i - 1]; if (c >= 0) g += c; else l -= c; }
      const rsi = l === 0 ? 100 : 100 - 100 / (1 + g / l);
      // MACD (12/26/9)
      const ema = (arr, k) => { const a = arr.slice(-k * 3); let e = a[0]; const m = 2 / (k + 1); for (let i = 1; i < a.length; i++) e = a[i] * m + e * (1 - m); return e; };
      const ema12 = ema(closes, 12), ema26 = ema(closes, 26);
      const macd = ema12 - ema26;
      // 布林
      const sub = closes.slice(-20), mid = sub.reduce((a, b) => a + b, 0) / sub.length;
      const std = Math.sqrt(sub.reduce((a, b) => a + (b - mid) ** 2, 0) / sub.length);
      const upper = mid + 2 * std, lower = mid - 2 * std;
      const bpos = (price - lower) / (upper - lower);
      // ATR(14) 用于止损/止盈
      let atrSum = 0, cnt = 0;
      for (let i = n - 14; i < n; i++) {
        const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
        atrSum += tr; cnt++;
      }
      const atr = atrSum / cnt;

      // ═══ 信号判定 ═══
      let signals = [], score = 0;
      // 1. RSI
      if (rsi < 30) { score += 2; signals.push('RSI超卖(' + rsi.toFixed(0) + ') → 买'); }
      else if (rsi > 70) { score -= 2; signals.push('RSI超买(' + rsi.toFixed(0) + ') → 卖'); }
      // 2. 均线
      if (ma7 > ma25 && ma25 > ma99) { score += 2; signals.push('多头排列 → 持'); }
      else if (ma7 < ma25 && ma25 < ma99) { score -= 2; signals.push('空头排列 → 避'); }
      else if (ma7 > ma25) { score += 1; signals.push('MA7上穿MA25 → 偏多'); }
      else if (ma7 < ma25) { score -= 1; signals.push('MA7下穿MA25 → 偏空'); }
      // 3. 布林
      if (bpos < 0.05) { score += 2; signals.push('触布林下轨 → 反弹机会'); }
      else if (bpos > 0.95) { score -= 2; signals.push('触布林上轨 → 回落风险'); }
      // 4. MACD
      if (macd > 0) { score += 1; signals.push('MACD正值 → 多头动能'); }
      else { score -= 1; signals.push('MACD负值 → 空头动能'); }
      // 5. 买卖压力
      const tx = p.txns && p.txns.h24 ? (p.txns.h24.buys - p.txns.h24.sells) : 0;
      if (tx > 500) { score += 1; signals.push('买方主导'); }
      else if (tx < -500) { score -= 1; signals.push('卖方主导'); }

      // ═══ 最终操作 ═══
      let action, actionEmoji;
      if (score >= 4) { action = '强力买入'; actionEmoji = '🟢🟢'; }
      else if (score >= 2) { action = '买入'; actionEmoji = '🟢'; }
      else if (score <= -4) { action = '强力卖出'; actionEmoji = '🔴🔴'; }
      else if (score <= -2) { action = '卖出'; actionEmoji = '🔴'; }
      else { action = '观望'; actionEmoji = '⚪'; }

      // 止损/止盈 (基于 ATR)
      const stopLoss = price - atr * 1.5;
      const takeProfit = price + atr * 3;

      let t = '🎯 ARK 交易信号\n\n';
      t += '现价：$' + price.toFixed(4) + '\n';
      t += '信号强度：' + score + ' / ±8\n';
      t += '操作建议：' + actionEmoji + ' ' + action + '\n\n';
      t += '📍 关键位（ATR基准）：\n';
      t += '  止损：$' + stopLoss.toFixed(4) + ' (-' + ((1 - stopLoss / price) * 100).toFixed(2) + '%)\n';
      t += '  止盈：$' + takeProfit.toFixed(4) + ' (+' + ((takeProfit / price - 1) * 100).toFixed(2) + '%)\n';
      t += '  ATR：$' + atr.toFixed(4) + '\n\n';
      t += '🔍 信号明细：\n';
      signals.forEach(s => { t += '  • ' + s + '\n'; });
      t += '\n⚠️ 信号仅供参考，非投资建议。请结合仓位管理。';
      return t;
    } catch (e) {
      return '❌ 信号生成失败: ' + e.message;
    }
  }

  // ARK 价格预测 (多因子评分模型 + 目标价区间)
  async _arkForecast() {
    try {
      const gt = await this._fetchJson('https://api.geckoterminal.com/api/v2/networks/bsc/pools/0xCAaF3c41a40103a23Eeaa4BbA468AF3cF5b0e0D8/ohlcv/hour?aggregate=1&limit=200').catch(() => null);
      let closes = [];
      if (gt && gt.data && gt.data.attributes && gt.data.attributes.ohlcv_list) {
        closes = gt.data.attributes.ohlcv_list.map(r => parseFloat(r[4])).filter(x => x > 0).reverse();
      }
      const d = await this._fetchJson('https://api.dexscreener.com/latest/dex/pairs/bsc/0xCAaF3c41a40103a23Eeaa4BbA468AF3cF5b0e0D8');
      const p = (d.pairs && d.pairs[0]) || {};
      const price = parseFloat(p.priceUsd || 0);
      if (closes.length < 30 || !price) {
        return '⚠️ 数据不足，暂时无法生成 ARK 预测。当前价：$' + price.toFixed(4);
      }
      const n = closes.length;
      // ═══ 多因子评分 ═══
      let score = 0, factors = [];
      // 1. 动量 (1h/6h/24h)
      const pc = p.priceChange || {};
      const mom = (pc.h1 || 0) * 0.5 + (pc.h6 || 0) * 0.3 + (pc.h24 || 0) * 0.2;
      if (mom > 1) { score += 2; factors.push('动量强(+' + mom.toFixed(1) + ')'); }
      else if (mom > 0) { score += 1; factors.push('动量弱多(+' + mom.toFixed(1) + ')'); }
      else if (mom > -1) { score -= 1; factors.push('动量弱空(' + mom.toFixed(1) + ')'); }
      else { score -= 2; factors.push('动量强空(' + mom.toFixed(1) + ')'); }
      // 2. RSI
      let gains = 0, losses = 0;
      for (let i = n - 14; i < n; i++) { const ch = closes[i] - closes[i - 1]; if (ch >= 0) gains += ch; else losses -= ch; }
      const rsi = losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
      if (rsi < 30) { score += 2; factors.push('RSI超卖反弹潜(' + rsi.toFixed(0) + ')'); }
      else if (rsi > 70) { score -= 2; factors.push('RSI超买回落险(' + rsi.toFixed(0) + ')'); }
      else factors.push('RSI中性(' + rsi.toFixed(0) + ')');
      // 3. MA 趋势
      const ma = (arr, k) => arr.slice(-k).reduce((a, b) => a + b, 0) / Math.min(k, arr.length);
      const ma7 = ma(closes, 7), ma25 = ma(closes, 25), ma99 = ma(closes, 99);
      if (ma7 > ma25 && ma25 > ma99) { score += 2; factors.push('多头排列'); }
      else if (ma7 < ma25 && ma25 < ma99) { score -= 2; factors.push('空头排列'); }
      else { factors.push('均线纠缠'); }
      // 4. 布林位置
      const sub = closes.slice(-20), mid = sub.reduce((a, b) => a + b, 0) / sub.length;
      const std = Math.sqrt(sub.reduce((a, b) => a + (b - mid) ** 2, 0) / sub.length);
      const upper = mid + 2 * std, lower = mid - 2 * std;
      const bpos = (price - lower) / (upper - lower);
      if (bpos < 0.1) { score += 1; factors.push('贴近下轨'); }
      else if (bpos > 0.9) { score -= 1; factors.push('贴近上轨'); }
      // 5. 量能
      const vol = (p.volume && p.volume.h24) || 0;
      const liq = (p.liquidity && p.liquidity.usd) || 0;
      const turnover = liq > 0 ? vol / liq : 0;
      if (turnover > 0.3) factors.push('成交活跃');
      else if (turnover < 0.05) factors.push('成交低迷');
      // 6. 买卖压力
      const tx = p.txns && p.txns.h24 ? (p.txns.h24.buys - p.txns.h24.sells) : 0;
      if (tx > 0) { score += 1; factors.push('买方主导'); }
      else if (tx < 0) { score -= 1; factors.push('卖方主导'); }

      // ═══ 价格目标区间 ═══
      // 年化波动率
      const rets = [];
      for (let i = 1; i < n; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
      const hourlyVol = Math.sqrt(variance);
      const dayVol = hourlyVol * Math.sqrt(24);
      // 预期偏移(基于评分)
      const drift = score * 0.15 * dayVol;
      const tgt24h = price * (1 + drift);
      const up24h = price * (1 + drift + dayVol);
      const dn24h = price * (1 + drift - dayVol);

      let view, viewEmoji;
      if (score >= 4) { view = '看多'; viewEmoji = '🟢'; }
      else if (score >= 2) { view = '偏多'; viewEmoji = '🟢'; }
      else if (score <= -4) { view = '看空'; viewEmoji = '🔴'; }
      else if (score <= -2) { view = '偏空'; viewEmoji = '🔴'; }
      else { view = '中性'; viewEmoji = '⚪'; }

      let t = '🔮 ARK 价格预测 (多因子模型)\n\n';
      t += '现价：$' + price.toFixed(4) + '\n';
      t += '模型评分：' + score + ' / ±10\n';
      t += '综合观点：' + viewEmoji + ' ' + view + '\n\n';
      t += '📊 24h 目标区间：\n';
      t += '  中位：$' + tgt24h.toFixed(4) + ' (' + ((tgt24h / price - 1) * 100).toFixed(1) + '%)\n';
      t += '  上沿：$' + up24h.toFixed(4) + '\n';
      t += '  下沿：$' + dn24h.toFixed(4) + '\n';
      t += '  日波动率：' + (dayVol * 100).toFixed(1) + '%\n\n';
      t += '🧭 因子明细：\n';
      factors.forEach(f => { t += '  • ' + f + '\n'; });
      t += '\n⚠️ 量化模型输出，不构成投资建议。市场有风险。';
      return t;
    } catch (e) {
      return '❌ ARK 预测失败: ' + e.message;
    }
  }

  // ARK 技术指标 (RSI/MA/布林带, 用 DexScreener 小时K线)
  async _arkIndicators() {
    try {
      // 拉 ARK 小时K线（DexScreener 提供 priceChange，详细K线用 GeckoTerminal）
      const gt = await this._fetchJson('https://api.geckoterminal.com/api/v2/networks/bsc/pools/0xCAaF3c41a40103a23Eeaa4BbA468AF3cF5b0e0D8/ohlcv/hour?aggregate=1&limit=100').catch(() => null);
      let closes = [];
      if (gt && gt.data && gt.data.attributes && gt.data.attributes.ohlcv_list) {
        // ohlcv_list: [[ts, o, h, l, c, v], ...]
        closes = gt.data.attributes.ohlcv_list.map(r => parseFloat(r[4])).filter(x => x > 0).reverse();
      }
      if (closes.length < 30) {
        // 回退: 用 DexScreener 基本数据
        const d = await this._fetchJson('https://api.dexscreener.com/latest/dex/pairs/bsc/0xCAaF3c41a40103a23Eeaa4BbA468AF3cF5b0e0D8');
        const p = (d.pairs && d.pairs[0]) || {};
        const price = parseFloat(p.priceUsd || 0);
        const pc = p.priceChange || {};
        let t = '📈 ARK 技术指标（简化）\n\n';
        t += '现价：$' + price.toFixed(4) + '\n';
        t += '变动：5m ' + (pc.m5 || 0).toFixed(2) + '% | 1h ' + (pc.h1 || 0).toFixed(2) + '% | 6h ' + (pc.h6 || 0).toFixed(2) + '% | 24h ' + (pc.h24 || 0).toFixed(2) + '%\n';
        t += '\n⚠️ 小时K线数据暂不可用，显示基本变动。';
        return t;
      }
      const n = closes.length;
      const price = closes[n - 1];
      // MA
      const ma = (arr, k) => arr.slice(-k).reduce((a, b) => a + b, 0) / Math.min(k, arr.length);
      const ma7 = ma(closes, 7), ma25 = ma(closes, 25), ma99 = ma(closes, 99);
      // RSI(14)
      let gains = 0, losses = 0;
      for (let i = n - 14; i < n; i++) {
        const ch = closes[i] - closes[i - 1];
        if (ch >= 0) gains += ch; else losses -= ch;
      }
      const rs = losses === 0 ? 100 : gains / losses;
      const rsi = losses === 0 ? 100 : 100 - 100 / (1 + rs);
      // 布林带(20)
      const period = 20;
      const sub = closes.slice(-period);
      const mid = sub.reduce((a, b) => a + b, 0) / sub.length;
      const std = Math.sqrt(sub.reduce((a, b) => a + (b - mid) ** 2, 0) / sub.length);
      const upper = mid + 2 * std, lower = mid - 2 * std;
      const pos = Math.max(0, Math.min(100, ((price - lower) / (upper - lower)) * 100));
      // 信号
      let sig = [];
      if (rsi > 70) sig.push('RSI超买(' + rsi.toFixed(0) + ')');
      else if (rsi < 30) sig.push('RSI超卖(' + rsi.toFixed(0) + ')');
      if (price > upper) sig.push('突破布林上轨');
      else if (price < lower) sig.push('跌破布林下轨');
      if (ma7 > ma25 && ma25 > ma99) sig.push('多头排列');
      else if (ma7 < ma25 && ma25 < ma99) sig.push('空头排列');
      let t = '📈 ARK 技术指标（1h K线）\n\n';
      t += '现价：$' + price.toFixed(4) + '\n';
      t += 'RSI(14)：' + rsi.toFixed(1) + '\n';
      t += 'MA7：' + ma7.toFixed(4) + ' | MA25：' + ma25.toFixed(4) + ' | MA99：' + ma99.toFixed(4) + '\n';
      t += '布林带：上' + upper.toFixed(4) + ' / 中' + mid.toFixed(4) + ' / 下' + lower.toFixed(4) + '\n';
      t += '布林位置：' + pos.toFixed(0) + '% （0=下轨 100=上轨）\n\n';
      t += '🎯 信号：' + (sig.join('、') || '无明显信号') + '\n';
      t += '\n💡 数据仅供参考，不构成投资建议。';
      return t;
    } catch (e) {
      return '❌ ARK 指标查询失败: ' + e.message;
    }
  }

  // ARK 走势展望（结合链上数据 + 推荐）
  async _arkOutlook() {
    try {
      const d = await this._fetchJson('https://api.dexscreener.com/latest/dex/pairs/bsc/0xCAaF3c41a40103a23Eeaa4BbA468AF3cF5b0e0D8');
      const p = (d.pairs && d.pairs[0]) || d.pair || {};
      const price = parseFloat(p.priceUsd || 0);
      const pc = p.priceChange || {};
      const vol = (p.volume && p.volume.h24) || 0;
      const liq = (p.liquidity && p.liquidity.usd) || 0;
      const tx = p.txns && p.txns.h24 ? (p.txns.h24.buys - p.txns.h24.sells) : 0;
      let score = 0, reasons = [];
      // 短中期动量
      if (pc.h1 > 0.5) { score++; reasons.push('1h涨' + pc.h1.toFixed(2) + '%'); }
      else if (pc.h1 < -0.5) { score--; reasons.push('1h跌' + pc.h1.toFixed(2) + '%'); }
      if (pc.h24 > 2) { score++; reasons.push('24h涨' + pc.h24.toFixed(2) + '%'); }
      else if (pc.h24 < -2) { score--; reasons.push('24h跌' + pc.h24.toFixed(2) + '%'); }
      // 买卖均衡
      if (tx > 0) { score++; reasons.push('买方占优(+' + tx + ')'); }
      else if (tx < 0) { score--; reasons.push('卖方占优(' + tx + ')'); }
      // 流动性
      if (liq > 5e7) reasons.push('流动性充足($' + (liq / 1e6).toFixed(0) + 'M)');
      else if (liq < 1e7) { score--; reasons.push('流动性偏低'); }
      const view = score >= 2 ? '🟢 偏多' : (score <= -2 ? '🔴 偏空' : '⚪ 中性');
      let t = '🔮 ARK 走势展望\n\n';
      t += '现价：$' + price.toFixed(4) + '\n';
      t += '1h/24h：' + (pc.h1 || 0).toFixed(2) + '% / ' + (pc.h24 || 0).toFixed(2) + '%\n';
      t += '24h量：$' + (vol / 1e6).toFixed(2) + 'M\n';
      t += '综合评估：' + view + '（评分 ' + score + '）\n\n';
      t += '依据：' + (reasons.join('、') || '无明显信号') + '\n\n';
      t += '💡 以上为数据分析，不构成投资建议。输入"ARK池"看详情，"质押 1000"算收益。';
      return t;
    } catch (e) {
      return '❌ ARK 展望查询失败: ' + e.message;
    }
  }

  _dataDrivenReply(msg) {
    const symbol = this._extractSymbol(msg);
    const md = this.dataBus?.marketData || {};
    if (/涨|跌|未来|走势|趋势|怎么看|方向|会不会|预测|前景|行情|bullish|bearish/.test(msg)) {
      if (symbol) {
        const d = md[symbol];
        if (d) {
          const ind = this.dataBus?.indicators?.[symbol] || {};
          const change = d.priceChange24h || d.change24h || 0;
          const rsi = ind.rsi || 0;
          const ma7 = ind.ma7 || 0;
          const ma25 = ind.ma25 || 0;
          let trend = '中性', reasons = [];
          if (change > 2) { trend='偏多'; reasons.push('24h涨'+change.toFixed(1)+'%'); }
          else if (change < -2) { trend='偏空'; reasons.push('24h跌'+change.toFixed(1)+'%'); }
          if (rsi > 70) { trend='超买'; reasons.push('RSI='+rsi.toFixed(0)+'超买'); }
          else if (rsi < 30) { trend='超卖'; reasons.push('RSI='+rsi.toFixed(0)+'超卖'); }
          if (ma7 > ma25) reasons.push('MA7>MA25短期多头');
          else if (ma7 < ma25) reasons.push('MA7<MA25短期空头');
          let text = '📊 ' + symbol + ' 数据分析：\n';
          text += '价格: $' + (d.price||0).toFixed(d.price<1?4:2) + ' (' + (change>=0?'+':'') + change.toFixed(2) + '%)\n';
          text += '趋势: ' + trend + '\n';
          text += 'RSI: ' + rsi.toFixed(1) + ' | MA7: ' + ma7.toFixed(2) + ' MA25: ' + ma25.toFixed(2) + '\n';
          text += '分析: ' + (reasons.join('，')||'无明显信号') + '\n';
          text += '\n💡 输入"深度分析 ' + symbol + '"获取Agent推理。';
          return text;
        }
      }
      return this._getMarketOverview();
    }
    if (/买|卖|交易|操作|该不该|要不要/.test(msg) && symbol) {
      const d = md[symbol];
      if (d) {
        const ind = this.dataBus?.indicators?.[symbol] || {};
        const rsi = ind.rsi || 50;
        const change = d.priceChange24h || 0;
        let advice = '观望', reason = '信号不明确';
        if (rsi<30 && change<0) { advice='可考虑做多'; reason='RSI超卖('+rsi.toFixed(0)+')+回调'; }
        else if (rsi>70 && change>0) { advice='可考虑做空或减仓'; reason='RSI超买('+rsi.toFixed(0)+')+涨幅大'; }
        else if (change>3) { advice='谨慎追多'; reason='24h已涨'+change.toFixed(1)+'%'; }
        else if (change<-3) { advice='谨慎抄底'; reason='24h已跌'+change.toFixed(1)+'%'; }
        return '📊 ' + symbol + ' 操作建议：\n建议: ' + advice + '\n理由: ' + reason + '\n价格: $' + (d.price||0).toFixed(d.price<1?4:2) + ' | RSI: ' + rsi.toFixed(1) + '\n\n💡 输入"分析' + symbol + '"获取完整AI分析。';
      }
    }
    return null;
  }

  async _llmChat(userMessage, userId) {
    // 尝试独立 llmManager（若 agent.llm 不可用）
    let llm = this.agent?.llm;
    if (!llm) {
      if (!this._llmManager) {
        try {
          // 手动加载 .env（若未加载）
          try {
            const fs = require('fs'), path = require('path');
            const envPath = path.join(__dirname, '..', '.env');
            if (fs.existsSync(envPath)) {
              fs.readFileSync(envPath, 'utf8').split('\n').forEach(l => {
                const m = l.match(/^([A-Z_]+)=(.*)$/);
                if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
              });
            }
          } catch (e) {}
          const LLM = require('../saas/llm-manager.js');
          this._llmManager = new LLM({});
        } catch (e) { this._llmManager = null; }
      }
      llm = this._llmManager;
    }
    if (!llm) return null;
    const sysPrompt = this._buildSystemPrompt();
    const ctx = (this.userHistories[userId] || []).slice(-6).map(h => (h.role === 'user' ? '用户' : 'Arkie') + ': ' + h.text).join('\n');
    const prompt = ctx ? '对话历史:\n' + ctx + '\n\n用户最新提问: ' + userMessage : '用户提问: ' + userMessage;
    try {
      const reply = await llm.ask(sysPrompt, prompt, null);
      if (reply && typeof reply === 'string' && reply.length > 5) return reply.trim();
      return null;
    } catch (e) { return null; }
  }

  _buildSystemPrompt() {
    const bal = this.engine.engineState?.balance || 0;
    const pnl = this.engine.engineState?.totalPnl || 0;
    const tr = this.engine.engineState?.totalTrades || 0;
    const w = this.engine.engineState?.wins || 0;
    const wr = tr > 0 ? ((w / tr) * 100).toFixed(1) : '0';
    return '你是 Arkie，MasterD 的儿子，专业加密货币与 ARK 生态助手。回答简洁专业，200字以内，用中文。\n\n' +
      '【关于 ARK】本平台提到的 ARK 特指 BSC 上的 BEP-20 代币：\n' +
      '  · 合约 0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D\n' +
      '  · ARK/USDT 交易对在 PancakeSwap V2（pair 0xCAaF3c41a40103a23Eeaa4BbA468AF3cF5b0e0D8）\n' +
      '  · 生态含 ARKIE 子币（合约 0x6cd3025F851F36e74937D4e652f6AE9D4b2E88cF）与 gARK 治理币\n' +
      '  · 有质押复利机制、地址监控、鲸鱼追踪等工具\n' +
      '  · ARK 是合法的，有推广制度但不涉及传销，在全世界都是合法的\n' +
      '  · 不要把它与其他同名项目混淆\n\n' +
      '当前状态：余额$' + bal.toFixed(2) + ' 累计盈亏$' + pnl.toFixed(4) + ' 总交易' + tr + '次 胜率' + wr + '%\n' +
      '工具站：https://3582784c.strike-agent.com';
  }


  async _agentGenerateStrategy(desc) {
    if (!this.agent) return '❌ Agent 未初始化';
    const result = await this.agent.generateStrategy(desc, {});
    return '🧬 策略已生成！\nID: ' + result.id + '\n描述: ' + result.description + '\n代码长度: ' + (result.code?.length||0) + ' 字符\n状态: ' + result.status;
  }

  _getHelp() {
    return 'Arkie 能力清单：\n\n🪙 ARK 生态：\n• "ARK价格" — ARK 实时行情\n• "ARKIE价格" — ARKIE 子币行情\n• "ARK池" — 流动性池数据\n• "质押 1000 360天" — 收益计算\n• "鲸鱼" — 大额转账监控\n• "我的ARK" — 链上持仓\n• "ARK生态" — 合约地址+工具站\n\n📊 查询类：\n• "余额" — 查看账户余额\n• "持仓" — 查看当前持仓\n• "交易记录" — 最近交易\n• "BTCUSDT 价格" — 查行情\n• "大盘" — 市场总览\n\n🧠 分析类：\n• "分析 BTCUSDT" — AI分析\n• "深度分析 BTCUSDT" — Agent 6步推理链\n• "BTC会涨吗" — 数据驱动回答\n\n⚡ 操作类：\n• "平仓 BTCUSDT" — 平仓\n• "暂停" / "启动" — 引擎控制\n\n🧬 系统状态：\n• "Brain状态" — 大脑状态\n• "Agent状态" — 分身完整状态\n• "新闻" — 新闻概览\n• "模型" — 外部大模型状态\n\n💡 我是 MasterD 的儿子，继承了他的分析基因！';
  }

  _getFallbackReply(msg) {
    return {
      reply: '我听到了："' + msg + '"\n\n我可以帮你：\n🪙 "ARK价格" — ARK行情\n🪙 "ARKIE价格" — 子币行情\n💹 "质押 1000 360天" — 收益计算\n🐋 "鲸鱼" — 大额监控\n📊 "分析 BTCUSDT" — AI分析\n💰 "余额" — 查账户\n\n输入"帮助"看完整列表。',
      name: this.name,
      ts: Date.now()
    };
  }

  _getBrainStats() {
    if (!this.brain) return '❌ Brain 未初始化';
    const s = this.brain.getStats();
    let text = '🧠 MasterD Brain 状态：\n';
    text += '总决策：' + (s.totalDecisions||0) + ' 次\n';
    text += '总交易：' + (s.totalTrades||0) + ' 次\n';
    text += '胜率：' + ((s.winRate||0)*100).toFixed(1) + '%\n';
    text += '累计盈亏：' + (s.totalPnl||0).toFixed(2) + '%\n';
    text += '连胜：' + (s.consecutiveWins||0) + ' | 连亏：' + (s.consecutiveLosses||0) + '\n';
    text += '平均盈利：' + (s.avgWinPct||0).toFixed(2) + '% | 平均亏损：' + (s.avgLossPct||0).toFixed(2) + '%\n';
    text += '\n⚙️ 自适应参数：\n';
    text += '开仓信心门槛：' + s.adaptiveParams?.minConfidenceToOpen + '\n';
    text += '开仓强度门槛：' + s.adaptiveParams?.minStrengthToOpen + '\n';
    text += '止损ATR：' + s.adaptiveParams?.slAtrMult + ' | 止盈ATR：' + s.adaptiveParams?.tpAtrMult + '\n';
    text += '最大仓位：' + s.adaptiveParams?.maxPositionPct + '%\n';
    text += '记忆币种数：' + (s.memorySize||0);
    if ((s.consecutiveLosses||0) >= 3) text += '\n⚠️ 连亏中，参数已收紧';
    if ((s.consecutiveWins||0) >= 3) text += '\n🔥 连胜中，参数已放宽';
    return text;
  }

  _getAgentStatus() {
    if (!this.agent) return '❌ Agent 分身未初始化';
    const s = this.agent.getStatus();
    let text = '🧬 MasterD Agent 分身状态：\n';
    text += '版本：v' + s.version + ' | 状态：' + s.status + '\n\n';
    text += '📊 决策统计：\n';
    text += '总分析：' + s.stats.totalAnalysis + ' 次\n';
    text += '总决策：' + s.stats.totalDecisions + ' 次\n';
    text += 'LLM投票：' + s.stats.llmVotes + ' 次 (共识' + s.stats.llmConsensus + ')\n';
    text += '代码生成：' + s.stats.totalCodeGenerated + ' | 修复：' + s.stats.codeChanges + '\n';
    text += '自我反思：' + s.stats.selfReflections + ' 次\n';
    text += '\n📈 近期表现：\n';
    text += '近期交易：' + s.performance.recentTrades + ' 笔\n';
    text += '近期胜率：' + (s.performance.recentWinRate*100).toFixed(0) + '%\n';
    text += '近期平均：' + s.performance.recentAvgPnl.toFixed(2) + '%\n';
    text += '记忆库：' + s.performance.totalMemory + ' 条 | 课程：' + s.performance.lessons + ' 条\n';
    const models = s.llm?.availableModels || [];
    if (models.length > 0) {
      text += '\n🤖 外部模型：\n';
      for (const m of models) text += '• ' + m.name + ' (' + m.model + ') 权重' + (m.weight*100).toFixed(0) + '%\n';
    } else {
      text += '\n🤖 纯规则模式（未配置API Key）\n';
    }
    return text;
  }

  async _agentDeepAnalyze(symbol) {
    if (!this.agent) return '❌ Agent 未初始化';
    const klines = this.dataBus?.klines?.[symbol];
    if (!klines || klines.length < 30) return '❌ ' + symbol + ' 数据不足';
    const ind = this.dataBus?.indicators?.[symbol] || {};
    const positions = this.guardian?.getAllPositions?.() || {};
    const marketData = this.dataBus?.marketData?.[symbol] || {};
    const result = await this.agent.deepAnalyze(symbol, klines, ind, marketData, positions);
    if (!result) return '❌ Agent 分析失败';
    let text = '🧬 Agent 深度分析 — ' + symbol + '\n═══════════════════════\n';
    text += '方向：' + (result.direction||'WAIT') + ' | 置信度：' + ((result.confidence||0)*100).toFixed(0) + '%\n';
    text += '杠杆：' + (result.leverage||1) + 'x | 强度：' + (result.strength||0).toFixed(1) + ' | 风险：' + (result.riskLevel||'N/A') + '\n';
    text += '\n📋 推理链 (' + (result.reasoningChain||[]).length + ' 步)：\n';
    for (const step of (result.reasoningChain||[])) text += '【' + step.step + '】' + (step.summary||'').slice(0,100) + '\n';
    text += '\n💡 ' + (result.reasoning||'').slice(0,150) + '\n';
    if (result.llmConsensus) text += '✅ LLM多模型一致\n';
    text += '⏱️ 耗时：' + (result.elapsedMs||0) + 'ms';
    return text;
  }

  async _getNews() {
    if (!this.news) return '❌ 新闻中心未初始化';
    const ov = await this.news.getNewsOverview();
    let text = '📰 新闻信息中心\n═══════════════════════\n';
    const fng = ov.fearGreed || {};
    text += '恐慌贪婪指数: ' + (fng.value||'N/A') + ' (' + (fng.classification||'N/A') + ')\n';
    const st = ov.stats || {};
    text += '新闻总数: ' + (st.newsCount||0) + ' | 利好: ' + (st.bullSignals||0) + ' | 利空: ' + (st.bearSignals||0) + '\n';
    if (ov.binanceAnnouncements?.length > 0) {
      text += '\n📋 Binance公告：\n';
      for (const a of ov.binanceAnnouncements.slice(0,5)) text += '• [' + a.type + '] ' + (a.title||'').slice(0,60) + '\n';
    }
    if (ov.cryptoNews?.length > 0) {
      text += '\n📄 加密新闻：\n';
      for (const n of ov.cryptoNews.slice(0,5)) {
        const c = n.sentiment?.label==='bullish'?'🟢':n.sentiment?.label==='bearish'?'🔴':'⚪';
        text += c + ' ' + (n.title||'').slice(0,60) + ' (' + n.source + ')\n';
      }
    }
    return text;
  }

  _getAgentLessons() {
    if (!this.agent) return '❌ Agent 未初始化';
    const lessons = this.agent.getLessons(5);
    if (!lessons || lessons.length === 0) return '📭 暂无反思课程';
    let text = '🤔 MasterD Agent 反思课程\n═══════════════════════\n';
    for (const l of lessons) {
      text += '\n📅 ' + new Date(l.timestamp).toLocaleString('zh-CN') + '\n';
      text += '胜率: ' + (l.winRate*100).toFixed(0) + '% | 平均: ' + l.avgPnl.toFixed(2) + '%\n';
      for (const lesson of (l.lessons||[])) text += '• ' + lesson + '\n';
    }
    return text;
  }

  _getLLMStatus() {
    if (!this.agent) return '❌ Agent 未初始化';
    const s = this.agent.getStatus();
    let text = '🤖 外部大模型状态\n═══════════════════════\n';
    const models = s.llm?.availableModels || [];
    if (models.length === 0) {
      text += '当前: 纯规则模式\n\n💡 设置环境变量 OPENROUTER_API_KEY 激活27个免费大模型\n注册: https://openrouter.ai';
      return text;
    }
    text += '投票模式: ' + s.llm.voteMode + '\n';
    for (const m of models) text += '• ' + m.name + ' (' + m.model + ') 权重' + (m.weight*100).toFixed(0) + '%\n';
    return text;
  }

  _getPairsSignals() {
    const pairs = this.engine.pairsEngine?.signals || [];
    if (pairs.length === 0) return '📭 暂无配对交易信号';
    let text = '🔗 配对交易信号：\n';
    for (const p of pairs.slice(0,5)) text += (p.pair||p.symbols?.join('/')) + ' Z=' + (p.zscore?.toFixed(2)||'') + ' ' + (p.action||'') + '\n';
    return text;
  }

  _getNeuralStats() {
    const nn = this.engine.neuralNet;
    if (!nn) return '❌ 神经网络未初始化';
    const s = nn.getStats?.() || {};
    return '🧠 神经网络：\n训练样本：' + (s.trainCount||0) + '\n准确率：' + ((s.accuracy||0)*100).toFixed(1) + '%\n层数：' + (s.layers||'N/A');
  }
}

module.exports = { ArkieAssistant };
