/**
 * Arkie 实时推送模块 (WebSocket + SSE)
 * 功能:
 *   1. ARK/ARKIE 实时价格推送（每 5 秒）
 *   2. 价格突破/跌破订阅触发
 *   3. 鲸鱼大额转账告警
 * 使用: const rt = require('./arkie-realtime'); rt.attach(httpServer, engine);
 * 前端: <script src="/arkie-realtime-client.js"></script>
 */
const { WebSocketServer } = require('ws');

const ARK_PAIR = '0xCAaF3c41a40103a23Eeaa4BbA468AF3cF5b0e0D8';
const ARKIE_PAIR = '0x41EceDC0C020153E4526cB8a3dDBc5a3F252b184';
const ARK_TOKEN = '0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D';
const RPC = 'https://bsc-rpc.publicnode.com';
const DATA_DIR = require('path').join(__dirname, '..', 'data');
const SUBS_FILE = require('path').join(DATA_DIR, 'arkie-subs.json');

function _fs() { return require('fs'); }
function loadSubs() {
  try { return JSON.parse(_fs().readFileSync(SUBS_FILE, 'utf8')) || []; } catch (e) { return []; }
}
function saveSubs(list) {
  try {
    _fs().mkdirSync(DATA_DIR, { recursive: true });
    _fs().writeFileSync(SUBS_FILE, JSON.stringify(list, null, 1));
  } catch (e) {}
}

async function fetchPrice(pair) {
  try {
    const r = await fetch('https://api.dexscreener.com/latest/dex/pairs/bsc/' + pair, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const d = await r.json();
    const p = (d.pairs && d.pairs[0]) || d.pair || {};
    return {
      price: parseFloat(p.priceUsd || 0),
      change: p.priceChange || {},
      vol: (p.volume && p.volume.h24) || 0,
      liq: (p.liquidity && p.liquidity.usd) || 0,
      ts: Date.now()
    };
  } catch (e) { return null; }
}

async function fetchWhales(minArk) {
  try {
    const blk = await fetch(RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })
    }).then(r => r.json());
    const latest = parseInt(blk.result, 16);
    const from = latest - 30;
    const logs = await fetch(RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
        params: [{ fromBlock: '0x' + from.toString(16), toBlock: 'latest', address: ARK_TOKEN,
          topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'] }]
      })
    }).then(r => r.json());
    return (logs.result || []).map(lg => ({
      amt: Number(BigInt(lg.data)) / 1e18,
      from: '0x' + lg.topics[1].slice(26),
      to: '0x' + lg.topics[2].slice(26),
      tx: lg.transactionHash
    })).filter(x => x.amt >= (minArk || 1000));
  } catch (e) { return []; }
}

function attach(httpServer, engine) {
  const wss = new WebSocketServer({ server: httpServer, path: '/arkie/ws' });
  const clients = new Set();
  let lastWhaleTx = new Set();
  let lastPrice = null;

  wss.on('connection', (ws, req) => {
    clients.add(ws);
    ws.isAlive = true;
    ws._send = (o) => { try { ws.send(JSON.stringify(o)); } catch (e) {} };
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'subscribe') {
          ws.topic = msg.topic || 'ark';
          ws.minWhale = msg.minWhale || 100000;
          ws._send({ type: 'subscribed', topic: ws.topic, ts: Date.now() });
        }
        if (msg.type === 'ping') ws._send({ type: 'pong', ts: Date.now() });
      } catch (e) {}
    });
    ws.on('close', () => clients.delete(ws));
    // 立即推一次快照
    if (lastPrice) ws._send({ type: 'price', data: lastPrice });
  });

  // ── 价格轮询 (5秒) ──
  let priceTimer = setInterval(async () => {
    const [ark, arkie] = await Promise.all([fetchPrice(ARK_PAIR), fetchPrice(ARKIE_PAIR)]);
    if (!ark && !arkie) return;
    lastPrice = { ark, arkie, ts: Date.now() };
    broadcast({ type: 'price', data: lastPrice });

    // ── 订阅触发检查 ──
    if (ark && ark.price > 0) {
      const subs = loadSubs();
      let dirty = false;
      for (const s of subs) {
        if (s.triggered) continue;
        const hit = (s.kind === 'above' && ark.price >= s.target) || (s.kind === 'below' && ark.price <= s.target);
        if (hit) {
          s.triggered = true; s.triggeredAt = Date.now(); s.triggeredPrice = ark.price;
          dirty = true;
          broadcast({ type: 'alert', data: { userId: s.userId, kind: s.kind, target: s.target, price: ark.price, ts: Date.now() } });
        }
      }
      if (dirty) saveSubs(subs);
    }
  }, 5000);

  // ── 鲸鱼轮询 (30秒) ──
  let whaleTimer = setInterval(async () => {
    const whales = await fetchWhales(100000);
    for (const w of whales) {
      const key = w.tx + w.amt;
      if (lastWhaleTx.has(key)) continue;
      lastWhaleTx.add(key);
      broadcast({ type: 'whale', data: w });
      // 清理旧集合
      if (lastWhaleTx.size > 500) lastWhaleTx = new Set([...lastWhaleTx].slice(-200));
    }
  }, 30000);

  function broadcast(o) {
    const s = JSON.stringify(o);
    for (const ws of clients) {
      if (ws.readyState === 1) { try { ws.send(s); } catch (e) {} }
    }
  }

  // ── 心跳 ──
  const hb = setInterval(() => {
    for (const ws of clients) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} clients.delete(ws); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) {}
    }
  }, 30000);

  console.log('[Arkie RT] WebSocket 已挂载: /arkie/ws');
  return {
    stop() { clearInterval(priceTimer); clearInterval(whaleTimer); clearInterval(hb); wss.close(); },
    broadcast, fetchPrice, fetchWhales
  };
}

module.exports = { attach, fetchPrice, fetchWhales };
