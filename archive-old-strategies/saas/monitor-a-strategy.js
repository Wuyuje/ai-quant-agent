/**
 * A策略定时监控 — 每小时记录一次各用户表现+模型训练进度
 * 保存到 data/a-strategy-monitor.json (数组,最多10条,超出自动删最旧)
 * 仪表盘通过 /api/a-strategy/monitor 读取展示
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 10010;
const DATA_FILE = path.join(__dirname, '..', 'data', 'a-strategy-monitor.json');
const MAX_RECORDS = 10;          // 最多保留10条
const INTERVAL = 60 * 60 * 1000; // 1小时记录一次

function fetchJson(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

async function record() {
  const ts = new Date().toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'});
  const neural = await fetchJson(`http://localhost:${PORT}/api/neural-net`);
  const users = await fetchJson(`http://localhost:${PORT}/api/a-strategy/users`);
  const summary = {
    ts,
    neuralTrainCount: neural?.trainCount || 0,
    neuralAccuracy: neural ? +(neural.accuracy * 100).toFixed(1) : 0,
    totalTrades: 0, totalPnl: 0, totalWins: 0,
    users: [],
  };
  if (Array.isArray(users)) {
    summary.totalTrades = users.reduce((s,u)=>s+(u.trades||0),0);
    summary.totalWins = users.reduce((s,u)=>s+(u.wins||0),0);
    summary.totalPnl = +users.reduce((s,u)=>s+(u.realizedPnl||0),0).toFixed(2);
    summary.users = users.map(u => ({
      wallet: u.wallet.slice(0,10),
      isAdmin: !!u.isAdmin,
      positions: u.positionCount||0,
      trades: u.trades||0,
      wins: u.wins||0,
      losses: u.losses||0,
      realizedPnl: +(u.realizedPnl||0).toFixed(2),
    }));
  }
  // 读取现有记录,追加,超出MAX删除最旧的
  let records = [];
  try { records = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch(e) { records = []; }
  if (!Array.isArray(records)) records = [];
  records.push(summary);
  if (records.length > MAX_RECORDS) records = records.slice(-MAX_RECORDS);
  fs.writeFileSync(DATA_FILE, JSON.stringify(records, null, 2));
  console.log(`[监控] ${ts} 总${summary.totalTrades}t胜${summary.totalWins}盈亏$${summary.totalPnl} → ${records.length}条记录`);
  return summary;
}

// 立即记录一次,然后每小时记录
record();
setInterval(record, INTERVAL);
console.log('A策略监控已启动,每小时记录1次,最多保留10条 → ' + DATA_FILE);
