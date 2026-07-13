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
    const msgLower = msg.toLowerCase();
    const userId = context.userId || context.wallet || 'admin';
    const wallet = context.wallet || null;
    const isAdmin = context.isAdmin || false;
    this._saveToHistory(userId, 'user', msg);

    try {
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
      const ctxReply = this._contextualReply(msg, userId);
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

  _contextualReply(msg, userId) {
    const history = this.userHistories[userId] || [];
    if (history.length < 2) return null;
    const lastArkie = history.filter(h=>h.role==='arkie').slice(-1)[0]?.text || '';
    if (lastArkie.includes('告诉我要分析哪个币') || lastArkie.includes('告诉我要平哪个仓')) {
      const symbol = this._extractSymbol(msg);
      if (symbol) {
        if (lastArkie.includes('分析')) return this._analyzeSymbol(symbol);
        if (lastArkie.includes('平仓')) return this._closePosition(symbol, userId, null, false);
      }
    }
    return null;
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
    if (!this.agent?.llm) return null;
    const sysPrompt = this._buildSystemPrompt();
    const ctx = (this.userHistories[userId]||[]).slice(-6).map(h => (h.role==='user'?'用户':'Arkie') + ': ' + h.text).join('\n');
    const prompt = ctx ? '对话历史:\n' + ctx + '\n\n用户最新提问: ' + userMessage : '用户提问: ' + userMessage;
    try {
      const reply = await this.agent.llm.ask(sysPrompt, prompt, null);
      if (reply && typeof reply === 'string' && reply.length > 5) return reply.trim();
      return null;
    } catch(e) { return null; }
  }

  _buildSystemPrompt() {
    const bal = this.engine.engineState?.balance || 0;
    const pnl = this.engine.engineState?.totalPnl || 0;
    const tr = this.engine.engineState?.totalTrades || 0;
    const w = this.engine.engineState?.wins || 0;
    const wr = tr > 0 ? ((w/tr)*100).toFixed(1) : '0';
    const positions = this.guardian?.getAllPositions?.() || {};
    const posList = Object.entries(positions).map(([s,p]) => s+' '+p.side+' '+p.qty+'@'+(p.entryPrice?.toFixed(2)||0)).join('; ') || '无持仓';
    const top = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT'].map(s => {
      const d = this.dataBus?.marketData?.[s];
      return d ? s+'=$'+(d.price?.toFixed(d.price<1?4:2)||0)+'('+((d.priceChange24h||0).toFixed(1))+'%)' : '';
    }).filter(Boolean).join(' | ');
    return '你是Arkie，MasterD的儿子，专业加密货币量化交易助手。回答简洁专业，200字以内。\n当前状态：余额$'+bal.toFixed(2)+' 累计盈亏$'+pnl.toFixed(4)+' 总交易'+tr+'次 胜率'+wr+'%\n持仓：'+posList+'\n主要币种：'+top;
  }


  async _agentGenerateStrategy(desc) {
    if (!this.agent) return '❌ Agent 未初始化';
    const result = await this.agent.generateStrategy(desc, {});
    return '🧬 策略已生成！\nID: ' + result.id + '\n描述: ' + result.description + '\n代码长度: ' + (result.code?.length||0) + ' 字符\n状态: ' + result.status;
  }

  _getHelp() {
    return 'Arkie 能力清单：\n\n📊 查询类：\n• "余额" — 查看账户余额\n• "持仓" — 查看当前持仓\n• "交易记录" — 最近交易\n• "BTCUSDT 价格" — 查行情\n• "大盘" — 市场总览\n\n🧠 分析类：\n• "分析 BTCUSDT" — AI分析\n• "深度分析 BTCUSDT" — Agent 6步推理链\n• "BTC会涨吗" — 数据驱动回答\n\n⚡ 操作类：\n• "平仓 BTCUSDT" — 平仓\n• "暂停" / "启动" — 引擎控制\n\n🧬 系统状态：\n• "Brain状态" — 大脑状态\n• "Agent状态" — 分身完整状态\n• "新闻" — 新闻概览\n• "模型" — 外部大模型状态\n\n💡 我是 MasterD 的儿子，继承了他的分析基因！';
  }

  _getFallbackReply(msg) {
    return '我听到了："' + msg + '"\n\n我目前能做的：\n• "分析 BTCUSDT" — AI分析\n• "深度分析 BTCUSDT" — Agent 6步推理\n• "BTC价格" — 查行情\n• "持仓" — 看仓位\n• "余额" — 查账户\n• "新闻" — 查新闻\n• "平仓 BTCUSDT" — 执行平仓\n\n输入"帮助"看完整列表。';
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
