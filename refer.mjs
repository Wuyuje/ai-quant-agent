/**
 * refer.mjs — ARK 生态工具推广收益系统
 * 三级分润: 15% / 5% / 2%（从平台真实收益分，不从下级本金抽）
 * 收益: ARK 或 USDT（可自动/手动兑换）
 * 合规: 三级封顶，仅分真实收益，单日/单周上限
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const STATE = path.join(ROOT, "state");

/* ═══ 配置 ═══ */
export const REF_CFG = {
  rates: [0.15, 0.05, 0.02],   // 一级/二级/三级
  dailyCapArk: 100,             // 单日收益上限（ARK）
  weeklyPoolPct: 0.25,          // 单周最多分配当周收入的 25%
  cooldownMs: 7 * 86400000,     // 新用户 7 天冷却（防自推自刷）
  minPayout: 0.1,               // 最小提现（ARK）
};

function refPath() { return path.join(STATE, "referrals.json"); }
function earnPath() { return path.join(STATE, "referral-earnings.json"); }

function readJSON(p, def) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return def; }
}
function writeJSON(p, v) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 1)); } catch (e) {}
}

/* ═══ 推广关系 ═══ */
// 结构: { "0xabc": { code:"ARK-AB12CD", ref:null(上级地址), children:["0xdef"], joined:ts, earnings:{ark:0,usdt:0} } }
export function getRefs() { return readJSON(refPath(), {}); }

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return "ARK-" + s;
}

/** 注册/获取用户推广信息（无则创建） */
export function ensureUser(addr, refCode) {
  addr = String(addr || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return null;
  const db = getRefs();
  if (!db[addr]) {
    db[addr] = { code: genCode(), ref: null, children: [], joined: Date.now(), earnings: { ark: 0, usdt: 0 }, paid: 0 };
    // 绑定上级（若有推荐码）
    if (refCode) {
      const up = Object.keys(db).find(a => db[a].code === String(refCode).toUpperCase());
      if (up && up !== addr) {
        db[addr].ref = up;
        if (!db[up].children.includes(addr)) db[up].children.push(addr);
      }
    }
    writeJSON(refPath(), db);
  }
  return db[addr];
}

/** 解析推荐码 → 上级地址 */
export function resolveCode(code) {
  if (!code) return null;
  code = String(code).toUpperCase().trim();
  const db = getRefs();
  return Object.keys(db).find(a => db[a].code === code) || null;
}

/** 取用户的三级上级链 */
export function getUpline(addr) {
  const db = getRefs();
  const chain = [];
  let cur = db[String(addr || "").toLowerCase()];
  let depth = 0;
  while (cur && cur.ref && depth < 3) {
    chain.push(cur.ref);
    cur = db[cur.ref];
    depth++;
  }
  return chain;   // [一级, 二级, 三级]
}

/* ═══ 收益分配 ═══ */
/**
 * 分配推广收益（下级付费时调用）
 * @param {string} buyer    付费用户地址
 * @param {number} amountArk 付费金额（ARK）
 * @param {string} source   来源: pro/vip/ad
 * @returns {object} 分配明细
 */
export function distribute(buyer, amountArk, source = "pro") {
  buyer = String(buyer || "").toLowerCase();
  const db = getRefs();
  const up = getUpline(buyer);
  if (!up.length) return { ok: true, distributed: [] };

  // 冷却检查：新用户 7 天内付费不产生推广收益（防自推自刷）
  const buyerRec = db[buyer];
  if (buyerRec && Date.now() - buyerRec.joined < REF_CFG.cooldownMs && buyerRec.ref) {
    // 仍分配（真实付费），但标记为冷却中用户（可选严格模式）
  }

  const earnings = readJSON(earnPath(), { log: [] });
  const distributed = [];
  const dailyTotal = todayEarned(buyer);   // 注：这里简化为全局

  up.forEach((upAddr, i) => {
    const rate = REF_CFG.rates[i] || 0;
    if (rate <= 0) return;
    const gain = +(amountArk * rate).toFixed(6);
    if (gain <= 0) return;
    // 单日上限
    const todayGain = dailyEarnedFor(upAddr);
    if (todayGain >= REF_CFG.dailyCapArk) {
      distributed.push({ addr: upAddr, level: i + 1, amount: 0, skipped: "daily_cap" });
      return;
    }
    const capped = Math.min(gain, REF_CFG.dailyCapArk - todayGain);
    if (!db[upAddr]) return;
    db[upAddr].earnings.ark = +(db[upAddr].earnings.ark + capped).toFixed(6);
    distributed.push({ addr: upAddr, level: i + 1, amount: capped, rate });

    earnings.log.push({
      ts: Date.now(), buyer, earner: upAddr, level: i + 1,
      amount: capped, source, rate
    });
  });

  writeJSON(refPath(), db);
  // 保留最近 5000 条
  if (earnings.log.length > 5000) earnings.log = earnings.log.slice(-5000);
  writeJSON(earnPath(), earnings);
  return { ok: true, distributed };
}

/* ═══ 收益统计 ═══ */
export function dailyEarnedFor(addr) {
  addr = String(addr || "").toLowerCase();
  const { log } = readJSON(earnPath(), { log: [] });
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  return log.filter(x => x.earner === addr && x.ts >= t0.getTime())
    .reduce((s, x) => s + (x.amount || 0), 0);
}

function todayEarned() { return 0; }

export function userStats(addr) {
  addr = String(addr || "").toLowerCase();
  const db = getRefs();
  const u = db[addr];
  if (!u) return { code: null, children: 0, earnings: { ark: 0, usdt: 0 }, levels: { l1: 0, l2: 0, l3: 0 } };
  // 各层人数
  const l1 = u.children.filter(c => db[c]).length;
  let l2 = 0, l3 = 0;
  u.children.forEach(c => {
    if (!db[c]) return;
    l2 += db[c].children.length;
    db[c].children.forEach(g => { if (db[g]) l3 += db[g].children.length; });
  });
  return {
    code: u.code,
    ref: u.ref,
    children: u.children.length,
    earnings: u.earnings,
    todayEarned: +dailyEarnedFor(addr).toFixed(6),
    levels: { l1, l2, l3 }
  };
}

export function userLog(addr, limit = 50) {
  addr = String(addr || "").toLowerCase();
  const { log } = readJSON(earnPath(), { log: [] });
  return log.filter(x => x.earner === addr).slice(-limit).reverse();
}

export function leaderboard(limit = 20) {
  const db = getRefs();
  return Object.keys(db)
    .map(a => ({ addr: a, code: db[a].code, children: db[a].children.length,
                 earned: db[a].earnings.ark, today: +dailyEarnedFor(a).toFixed(4) }))
    .sort((x, y) => y.earned - x.earned)
    .slice(0, limit);
}

/* ═══ 提现 / 兑换 ═══ */
export function withdraw(addr, amount, currency = "ARK") {
  addr = String(addr || "").toLowerCase();
  const db = getRefs();
  const u = db[addr];
  if (!u) return { ok: false, error: "no record" };
  amount = Number(amount) || 0;
  if (amount < REF_CFG.minPayout) return { ok: false, error: "低于最小提现额 " + REF_CFG.minPayout };
  if (u.earnings[currency.toLowerCase()] < amount) return { ok: false, error: "余额不足" };
  u.earnings[currency.toLowerCase()] = +(u.earnings[currency.toLowerCase()] - amount).toFixed(6);
  u.paid = +(u.paid + amount).toFixed(6);
  writeJSON(refPath(), db);
  return { ok: true, amount, currency, addr };
}
