/**
 * arkchat.mjs — ARK Chat 聊天系统（集成到 ARK 工具站）
 * 功能: 好友 / 1对1聊天 / 群聊 / 消息记录
 * 身份: 复用钱包地址（0x...）作为账号
 * 存储: SQLite（state/arkchat.db）
 * 实时: WebSocket
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const DB_FILE = path.join(ROOT, "state", "arkchat.json");

function read() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch (e) { return { users: {}, friends: {}, requests: {}, groups: {}, messages: {}, posts: {} }; }
}
function write(d) {
  try {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 1));
  } catch (e) {}
}

/* ═══ 用户 ═══ */
export function ensureUser(addr, name) {
  addr = String(addr || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return null;
  const db = read();
  if (!db.users[addr]) {
    db.users[addr] = {
      addr,
      handle: "",                                    // @用户名
      uid: String(Math.floor(100000 + Math.random() * 900000)),  // 6位数字ID
      name: name || (addr.slice(0, 6) + "…" + addr.slice(-4)),
      avatar: "",
      online: false,
      lastSeen: Date.now(),
      created: Date.now()
    };
    write(db);
  }
  // 老用户补字段
  const u = read().users[addr];
  if (u && !u.uid) { u.uid = String(Math.floor(100000 + Math.random() * 900000)); const d2 = read(); d2.users[addr] = u; write(d2); }
  return u;
}

/** 设置用户名 @handle（唯一） */
export function setHandle(addr, handle) {
  addr = String(addr || "").toLowerCase();
  handle = String(handle || "").trim().replace(/^@/, "");
  if (!/^[a-zA-Z0-9_]{3,16}$/.test(handle)) return { ok: false, error: "用户名3-16位字母数字下划线" };
  const db = read();
  if (!db.users[addr]) return { ok: false, error: "用户不存在" };
  // 检查唯一
  const taken = Object.keys(db.users).find(a => a !== addr && (db.users[a].handle || "").toLowerCase() === handle.toLowerCase());
  if (taken) return { ok: false, error: "用户名已被占用" };
  db.users[addr].handle = handle;
  db.users[addr].name = "@" + handle;
  write(db);
  return { ok: true, handle };
}

/** 按 @handle 或 uid 或地址查找 */
export function findUser(query) {
  const db = read();
  let q = String(query || "").trim().replace(/^@/, "").toLowerCase();
  if (!q) return null;
  // 地址
  if (/^0x[0-9a-f]{40}$/.test(q)) return db.users[q] || null;
  // uid
  if (/^\d{6}$/.test(q)) {
    const a = Object.keys(db.users).find(x => db.users[x].uid === q);
    return a ? db.users[a] : null;
  }
  // handle
  const a2 = Object.keys(db.users).find(x => (db.users[x].handle || "").toLowerCase() === q);
  return a2 ? db.users[a2] : null;
}
export function setProfile(addr, patch) {
  addr = String(addr || "").toLowerCase();
  const db = read();
  if (!db.users[addr]) ensureUser(addr);
  const db2 = read();
  Object.assign(db2.users[addr], patch || {}, { lastSeen: Date.now() });
  write(db2);
  return db2.users[addr];
}

/* ═══ 在线状态 ═══ */
export function setOnline(addr, online) {
  addr = String(addr||"").toLowerCase();
  const db = read();
  if (db.users[addr]) { db.users[addr].online = !!online; db.users[addr].lastSeen = Date.now(); write(db); }
}
export function onlineList() {
  const db = read();
  const now = Date.now();
  return Object.values(db.users).filter(u => u.online || (now - (u.lastSeen||0) < 120000)).map(u => u.addr);
}

/* ═══ 未读 ═══ */
export function markRead(addr, chatId) {
  addr = addr.toLowerCase();
  const db = read();
  db.unread = db.unread || {};
  db.unread[addr] = db.unread[addr] || {};
  db.unread[addr][chatId] = 0;
  write(db);
  return { ok: true };
}
export function bumpUnread(addr, chatId) {
  addr = addr.toLowerCase();
  const db = read();
  db.unread = db.unread || {};
  db.unread[addr] = db.unread[addr] || {};
  db.unread[addr][chatId] = (db.unread[addr][chatId] || 0) + 1;
  write(db);
}
export function getUnread(addr) {
  const db = read();
  return (db.unread || {})[addr.toLowerCase()] || {};
}

/* ═══ 撤回 ═══ */
export function recall(addr, chatId, msgId) {
  addr = addr.toLowerCase();
  const db = read();
  const arr = db.messages[chatId] || [];
  const m = arr.find(x => x.id === msgId);
  if (!m) return { ok: false, error: "消息不存在" };
  if (m.from !== addr) return { ok: false, error: "只能撤回自己的" };
  if (Date.now() - m.ts > 120000) return { ok: false, error: "超过2分钟不能撤回" };
  m.text = "[已撤回]";
  m.recalled = true;
  write(db);
  return { ok: true };
}

/* ═══ 好友 ═══ */
export function addFriendRequest(from, to) {
  from = from.toLowerCase(); to = to.toLowerCase();
  if (from === to) return { ok: false, error: "不能加自己" };
  const db = read();
  if (!db.users[to]) return { ok: false, error: "用户不存在" };
  if ((db.friends[from] || []).includes(to)) return { ok: false, error: "已是好友" };
  db.requests[to] = db.requests[to] || {};
  db.requests[to][from] = { from, to, ts: Date.now(), status: "pending" };
  write(db);
  return { ok: true };
}
export function acceptFriend(from, to) {
  // from 同意 to 的请求
  from = from.toLowerCase(); to = to.toLowerCase();
  const db = read();
  if (!db.requests[from] || !db.requests[from][to]) return { ok: false, error: "无此请求" };
  db.friends[from] = db.friends[from] || [];
  db.friends[to] = db.friends[to] || [];
  if (!db.friends[from].includes(to)) db.friends[from].push(to);
  if (!db.friends[to].includes(from)) db.friends[to].push(from);
  delete db.requests[from][to];
  // 建私聊会话
  const cid = chatId(from, to);
  db.messages[cid] = db.messages[cid] || [];
  write(db);
  return { ok: true, chatId: cid };
}
export function rejectFriend(from, to) {
  from = from.toLowerCase(); to = to.toLowerCase();
  const db = read();
  if (db.requests[from]) delete db.requests[from][to];
  write(db);
  return { ok: true };
}
export function listFriends(addr) {
  addr = addr.toLowerCase();
  const db = read();
  return (db.friends[addr] || []).map(a => db.users[a] || { addr: a, name: a.slice(0,8) });
}
export function listRequests(addr) {
  addr = addr.toLowerCase();
  const db = read();
  const req = db.requests[addr] || {};
  return Object.values(req).map(r => ({ ...r, user: db.users[r.from] || { addr: r.from } }));
}
export function searchUsers(q) {
  const db = read();
  q = String(q || "").toLowerCase().replace(/^@/, "");
  return Object.values(db.users).filter(u =>
    u.addr.includes(q) || (u.handle || "").toLowerCase().includes(q) || u.uid === q || (u.name || "").toLowerCase().includes(q)
  ).slice(0, 20);
}

/* ═══ 会话 ═══ */
export function chatId(a, b) {
  return [a.toLowerCase(), b.toLowerCase()].sort().join("_");
}
export function sendMessage(from, to, text, type = "text", extra) {
  from = from.toLowerCase(); to = to.toLowerCase();
  const db = read();
  const cid = chatId(from, to);
  db.messages[cid] = db.messages[cid] || [];
  const msg = {
    id: crypto.randomBytes(8).toString("hex"),
    from, to, text: String(text || "").slice(0, 2000),
    type, extra: extra || null,
    ts: Date.now()
  };
  // 未读+1
  bumpUnread(to, cid);
  db.messages[cid].push(msg);
  if (db.messages[cid].length > 2000) db.messages[cid] = db.messages[cid].slice(-2000);
  write(db);
  return msg;
}
export function getMessages(a, b, limit = 50) {
  const db = read();
  const cid = chatId(a, b);
  return (db.messages[cid] || []).slice(-limit);
}

/* ═══ 群聊 ═══ */
export function createGroup(owner, name, members) {
  owner = owner.toLowerCase();
  const db = read();
  const gid = "g_" + crypto.randomBytes(6).toString("hex");
  const mem = new Set([owner, ...(members || []).map(m => m.toLowerCase())]);
  db.groups[gid] = { gid, name: String(name || "群聊").slice(0, 40), owner, members: [...mem], created: Date.now() };
  db.messages[gid] = db.messages[gid] || [];
  write(db);
  return db.groups[gid];
}
export function groupSend(from, gid, text, type = "text", extra) {
  from = from.toLowerCase();
  const db = read();
  const g = db.groups[gid];
  if (!g || !g.members.includes(from)) return { ok: false, error: "不在群里" };
  db.messages[gid] = db.messages[gid] || [];
  const msg = { id: crypto.randomBytes(8).toString("hex"), from, gid, text: String(text||"").slice(0,2000), type, extra: extra || null, ts: Date.now() };
  db.messages[gid].push(msg);
  write(db);
  return { ok: true, msg };
}
export function listGroups(addr) {
  addr = addr.toLowerCase();
  const db = read();
  return Object.values(db.groups).filter(g => g.members.includes(addr));
}
export function groupMessages(gid, limit = 50) {
  const db = read();
  return (db.messages[gid] || []).slice(-limit);
}

/* ═══ 动态/朋友圈 ═══ */
export function post(addr, text, image) {
  addr = addr.toLowerCase();
  const db = read();
  db.posts = db.posts || [];
  const p = { id: crypto.randomBytes(6).toString("hex"), addr, text: String(text||"").slice(0,2000), image: image || null, likes: [], comments: [], ts: Date.now() };
  db.posts.unshift(p);
  if (db.posts.length > 500) db.posts = db.posts.slice(0, 500);
  write(db);
  return p;
}
export function feed(limit = 50) {
  const db = read();
  return (db.posts || []).slice(0, limit).map(p => ({ ...p, user: db.users[p.addr] || { addr: p.addr } }));
}
export function likePost(addr, pid) {
  addr = addr.toLowerCase();
  const db = read();
  const p = (db.posts || []).find(x => x.id === pid);
  if (!p) return { ok: false };
  p.likes = p.likes || [];
  const i = p.likes.indexOf(addr);
  if (i >= 0) p.likes.splice(i, 1); else p.likes.push(addr);
  write(db);
  return { ok: true, likes: p.likes.length };
}
export function commentPost(addr, pid, text) {
  addr = addr.toLowerCase();
  const db = read();
  const p = (db.posts || []).find(x => x.id === pid);
  if (!p) return { ok: false };
  p.comments = p.comments || [];
  p.comments.push({ addr, text: String(text||"").slice(0,500), ts: Date.now() });
  write(db);
  return { ok: true };
}
