/**
 * ARK Citizen Tools - 廣告位系統
 * 項目方在線申請 → 付 ARK → 管理員審核 → 自動上架
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, "state");

/* ── 廣告位類型 ── */
export const AD_SLOTS = {
  hero:   { name: { "zh-TW": "首頁推薦位", en: "Hero Banner" },  pricePerMonth: 50, desc: { "zh-TW": "Hero 下方置頂展示", en: "Top banner below hero" } },
  side:   { name: { "zh-TW": "側欄廣告位", en: "Sidebar Ad" },   pricePerMonth: 30, desc: { "zh-TW": "常駐側欄 · 全站可見", en: "Fixed sidebar, site-wide" } },
  listing:{ name: { "zh-TW": "生態收錄",   en: "Eco Listing" },  pricePerMonth: 10, desc: { "zh-TW": "工具/DApp 收錄 + 介紹頁", en: "Tool/DApp listing page" } }
};

export const DURATIONS = [1, 3, 6, 12];   // 月

function adsPath() { return path.join(STATE_DIR, "ads.json"); }
function readAds() {
  try { return JSON.parse(fs.readFileSync(adsPath(), "utf8")); } catch (e) { return { ads: [], usedTx: {} }; }
}
function writeAds(v) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(adsPath(), JSON.stringify(v, null, 1)); } catch (e) {}
}

/* ── 建立廣告申請 ── */
export function createAd(data) {
  const { addr, slot, months, title, url, image, contact, desc } = data || {};
  if (!AD_SLOTS[slot]) throw new Error("invalid slot");
  if (!DURATIONS.includes(Number(months))) throw new Error("invalid duration");
  if (!title || title.length < 2) throw new Error("title required");
  if (!/^https?:\/\//.test(url || "")) throw new Error("valid url required");
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr || "")) throw new Error("wallet required");

  const slotCfg = AD_SLOTS[slot];
  const ark = slotCfg.pricePerMonth * Number(months);
  const id = "ad_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const ad = {
    id,
    addr: addr.toLowerCase(),
    slot,
    months: Number(months),
    ark,
    title: String(title).slice(0, 60),
    url: String(url).slice(0, 300),
    image: String(image || "").slice(0, 500),
    contact: String(contact || "").slice(0, 100),
    desc: String(desc || "").slice(0, 200),
    status: "pending_pay",     // pending_pay | pending_review | active | expired | rejected
    created: Date.now(),
    paidAt: null,
    txHash: null,
    reviewedAt: null,
    startsAt: null,
    endsAt: null,
    views: 0,
    clicks: 0
  };
  const db = readAds();
  db.ads.push(ad);
  writeAds(db);
  return ad;
}

/* ── 付款完成 ── */
export function markAdPaid(adId, txHash, amountArk) {
  const db = readAds();
  const ad = db.ads.find(x => x.id === adId);
  if (!ad) return { ok: false, error: "ad not found" };
  if (ad.status !== "pending_pay") return { ok: false, error: "invalid status: " + ad.status };
  if (db.usedTx[String(txHash).toLowerCase()]) return { ok: false, error: "tx already used" };
  if (Number(amountArk) < ad.ark * 0.98) return { ok: false, error: "amount too low" };

  ad.status = "pending_review";
  ad.paidAt = Date.now();
  ad.txHash = txHash;
  db.usedTx[String(txHash).toLowerCase()] = adId;
  writeAds(db);
  return { ok: true, ad };
}

/* ── 管理員審核 ── */
export function reviewAd(adId, approve) {
  const db = readAds();
  const ad = db.ads.find(x => x.id === adId);
  if (!ad) return { ok: false, error: "ad not found" };
  if (ad.status !== "pending_review") return { ok: false, error: "not pending review" };
  ad.reviewedAt = Date.now();
  if (approve) {
    ad.status = "active";
    ad.startsAt = Date.now();
    ad.endsAt = Date.now() + ad.months * 30 * 86400000;
  } else {
    ad.status = "rejected";
  }
  writeAds(db);
  return { ok: true, ad };
}

/* ── 刪除廣告（管理員） ── */
export function deleteAd(adId) {
  const db = readAds();
  const idx = db.ads.findIndex(x => x.id === adId);
  if (idx < 0) return { ok: false, error: "ad not found" };
  const removed = db.ads.splice(idx, 1)[0];
  writeAds(db);
  return { ok: true, removed: { id: removed.id, title: removed.title, status: removed.status } };
}

/* ── 批量刪除（管理員） ── */
export function deleteAds(ids) {
  const db = readAds();
  const set = new Set(ids || []);
  const before = db.ads.length;
  db.ads = db.ads.filter(x => !set.has(x.id));
  writeAds(db);
  return { ok: true, deleted: before - db.ads.length };
}

/* ── 取得有效廣告（前台渲染用） ── */
export function getActiveAds(slot) {
  const db = readAds();
  const now = Date.now();
  return db.ads.filter(x =>
    x.status === "active" &&
    (!slot || x.slot === slot) &&
    x.endsAt > now
  ).map(x => ({
    id: x.id, slot: x.slot, title: x.title, url: x.url,
    image: x.image, desc: x.desc, endsAt: x.endsAt
  }));
}

/* ── 點擊/曝光統計 ── */
export function trackAd(adId, type) {
  const db = readAds();
  const ad = db.ads.find(x => x.id === adId);
  if (!ad) return;
  if (type === "click") ad.clicks = (ad.clicks || 0) + 1;
  else ad.views = (ad.views || 0) + 1;
  writeAds(db);
}

/* ── 列表（管理員） ── */
export function listAds(status) {
  const db = readAds();
  let list = db.ads.slice().sort((a, b) => b.created - a.created);
  if (status) list = list.filter(x => x.status === status);
  return list;
}

/* ── 統計 ── */
export function adStats() {
  const db = readAds();
  const now = Date.now();
  const active = db.ads.filter(x => x.status === "active" && x.endsAt > now);
  const pending = db.ads.filter(x => x.status === "pending_review");
  const unpaid = db.ads.filter(x => x.status === "pending_pay");
  const totalArk = db.ads.filter(x => x.paidAt).reduce((a, x) => a + x.ark, 0);
  return {
    total: db.ads.length,
    active: active.length,
    pendingReview: pending.length,
    pendingPay: unpaid.length,
    totalArk: Math.round(totalArk * 100) / 100,
    totalViews: db.ads.reduce((a, x) => a + (x.views || 0), 0),
    totalClicks: db.ads.reduce((a, x) => a + (x.clicks || 0), 0)
  };
}

/* ── 過期清理 ── */
export function expireAds() {
  const db = readAds();
  const now = Date.now();
  let n = 0;
  for (const ad of db.ads) {
    if (ad.status === "active" && ad.endsAt <= now) { ad.status = "expired"; n++; }
  }
  if (n) writeAds(db);
  return n;
}
