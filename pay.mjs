/**
 * ARK Citizen Tools - 付費系統（鏈上收 ARK）
 * 用戶用錢包轉 ARK 到收款地址，後端監聽鏈上交易自動開通
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const STATE_DIR = path.join(ROOT, "state");

export const PRICING = {
  free:  { name: { "zh-TW": "免費版", "zh-CN": "免费版", en: "Free" }, ark: 0, months: 0 },
  pro:   { name: { "zh-TW": "專業版", "zh-CN": "专业版", en: "Pro" }, ark: 1, months: 1, label: { "zh-TW": "1 個月", "zh-CN": "1 个月", en: "1 Month" } },
  vip:   { name: { "zh-TW": "旗艦版", "zh-CN": "旗舰版", en: "VIP" }, ark: 10, months: 12, label: { "zh-TW": "1 年", "zh-CN": "1 年", en: "1 Year" } }
};

export function payPath() { return path.join(STATE_DIR, "payments.json"); }
export function userPath() { return path.join(STATE_DIR, "users.json"); }

export function readJSON(p, def) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return def; }
}
export function writeJSON(p, v) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 1)); } catch (e) {}
}

/* ── 用戶 ── */
export function getUsers() { return readJSON(userPath(), {}); }

export function upsertUser(addr, patch) {
  const db = getUsers();
  addr = String(addr).toLowerCase();
  const now = Date.now();
  if (!db[addr]) {
    db[addr] = { addr, created: now, plan: "free", until: 0, totalPaid: 0, payments: [] };
  }
  Object.assign(db[addr], patch || {});
  writeJSON(userPath(), db);
  return db[addr];
}

export function getUser(addr) {
  const db = getUsers();
  return db[String(addr).toLowerCase()] || null;
}

export function isPro(addr) {
  const u = getUser(addr);
  if (!u) return false;
  if (u.plan === "free") return false;
  return u.until > Date.now();
}

/* ── 付款單 ── */
export function createInvoice(addr, plan) {
  const p = PRICING[plan];
  if (!p || p.ark <= 0) throw new Error("invalid plan");
  const id = "inv_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const inv = {
    id, addr: String(addr).toLowerCase(), plan,
    ark: p.ark, months: p.months,
    created: Date.now(),
    status: "pending",      // pending | paid | expired
    txHash: null, paidAt: null
  };
  const db = readJSON(payPath(), { invoices: {}, usedTx: {} });
  db.invoices[id] = inv;
  writeJSON(payPath(), db);
  return inv;
}

export function getInvoices() { return readJSON(payPath(), { invoices: {}, usedTx: {} }); }

export function markPaid(invId, txHash, fromAddr, amountArk) {
  const db = readJSON(payPath(), { invoices: {}, usedTx: {} });
  const inv = db.invoices[invId];
  if (!inv) return { ok: false, error: "invoice not found" };
  if (inv.status === "paid") return { ok: false, error: "already paid" };
  if (db.usedTx[String(txHash).toLowerCase()]) return { ok: false, error: "tx already used" };
  if (Number(amountArk) < inv.ark * 0.98) return { ok: false, error: "amount too low" };

  inv.status = "paid";
  inv.txHash = txHash;
  inv.paidAt = Date.now();
  inv.paidFrom = String(fromAddr).toLowerCase();
  inv.paidAmount = Number(amountArk);
  db.usedTx[String(txHash).toLowerCase()] = invId;
  writeJSON(payPath(), db);

  // 開通
  const u = getUser(inv.addr) || upsertUser(inv.addr, {});
  const base = u.until > Date.now() ? u.until : Date.now();
  const until = base + inv.months * 30 * 86400000;
  upsertUser(inv.addr, {
    plan: inv.plan,
    until,
    totalPaid: (u.totalPaid || 0) + Number(amountArk),
    payments: [...(u.payments || []), { txHash, plan: inv.plan, ark: Number(amountArk), ts: Date.now() }]
  });
  return { ok: true, until };
}

/* ── 統計（給後台） ── */
export function revenueStats() {
  const db = readJSON(payPath(), { invoices: {}, usedTx: {} });
  const users = getUsers();
  const inv = Object.values(db.invoices);
  const paid = inv.filter(x => x.status === "paid");
  const totalArk = paid.reduce((a, x) => a + (x.paidAmount || x.ark || 0), 0);
  const active = Object.values(users).filter(u => u.plan !== "free" && u.until > Date.now());
  return {
    invoices: inv.length,
    paidCount: paid.length,
    pendingCount: inv.filter(x => x.status === "pending").length,
    totalArk: Math.round(totalArk * 10000) / 10000,
    users: Object.keys(users).length,
    proUsers: active.length,
    recent: paid.slice(-20).reverse().map(x => ({
      id: x.id, addr: x.addr, plan: x.plan, ark: x.paidAmount || x.ark,
      ts: x.paidAt, tx: x.txHash
    }))
  };
}

/* ── 清理過期訂單 ── */
export function expireInvoices(maxAgeMs = 30 * 60 * 1000) {
  const db = readJSON(payPath(), { invoices: {}, usedTx: {} });
  const now = Date.now();
  let n = 0;
  for (const k in db.invoices) {
    const x = db.invoices[k];
    if (x.status === "pending" && now - x.created > maxAgeMs) { x.status = "expired"; n++; }
  }
  if (n) writeJSON(payPath(), db);
  return n;
}
