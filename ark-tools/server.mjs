/**
 * ARK Citizen Tools - backend
 * 靜態服務 + 通知 API + 鏈上數據代理
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as PAY from "./pay.mjs";
import * as REF from "./refer.mjs";
import * as ADS from "./ads.mjs";
import * as CHAT from "./arkchat.mjs";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "18080", 10);
const ROOT = __dirname;
const STATE_DIR = path.join(ROOT, "state");

// ⭐ 白名单地址（永久 PRO，无需充值，测试/特殊账户）
const ARK_WHITELIST = new Set([
  "0xb5e113dd2fcb87a458191c3b0e2d606129455d4e"   // 测试白名单
]);
function isWhitelisted(addr){ return ARK_WHITELIST.has(String(addr||"").toLowerCase()); }
/* ⭐ VIP 校验：白名单 或 有效付费会员 */
function isVip(addr) {
  const a = String(addr || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) return false;
  if (isWhitelisted(a)) return true;
  try { return PAY.isPro(a); } catch (e) { return false; }
}
/* ⭐ VIP 门禁：不通过则返回 403 */
function requireVip(res, addr) {
  if (isVip(addr)) return true;
  sendJSON(res, 403, { error: "vip_required", detail: "此功能需要 VIP 会员" });
  return false;
}

const CHAIN = {
  rpc: [
    "https://bsc-rpc.publicnode.com",
    "https://1rpc.io/bnb",
    "https://bsc-dataseed.binance.org",
    "https://bsc-dataseed1.defibit.io",
    "https://rpc.ankr.com/bsc"
  ],
  pair: "0xCAaF3c41a40103a23Eeaa4BbA468AF3cF5b0e0D8",
  arkie: "0x6cd3025F851F36e74937D4e652f6AE9D4b2E88cF",
  arkiePair: "0x41EceDC0C020153E4526cB8a3dDBc5a3F252b184",
  gark: "0x911f12D137D74E5917877f87cf8A8bB2FDde557f",
  // 收款地址（管理員在 .env 或環境變數設定，預設為官方手續費地址）
  payTo: process.env.PAY_TO || "0xd9D1c7dCf7CB6181A61ed0E70F64fe7Ddd4B9495",
  ark: "0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D",
  usdt: "0x55d398326f99059fF775485246999027B3197955",
  decimals: 18
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".avi": "video/x-msvideo",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".bin": "application/octet-stream"
};

function ensureState() {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch (e) {}
}

function send(res, code, body, type) {
  res.writeHead(code, {
    "Content-Type": type || "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin"
  });
  res.end(body);
}

function sendJSON(res, code, obj) {
  send(res, code, JSON.stringify(obj), "application/json; charset=utf-8");
}

async function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/* ── 鏈上資料（BSC RPC getReserves） ── */
async function rpcCall(method, params) {
  const urls = CHAIN.rpc.slice();
  while (urls.length) {
    const url = urls.shift();
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
      });
      const d = await r.json();
      if (d && d.result) return d.result;
    } catch (e) { /* try next */ }
  }
  throw new Error("all rpc failed");
}

let chainCache = { t: 0, d: null };
async function getChain() {
  if (chainCache.d && Date.now() - chainCache.t < 30000) return chainCache.d;
  const a = await getArk();
  const out = {
    price: a.priceUsd || 0,
    poolUsdt: a.poolUsdt || 0,
    poolArk: a.poolArk || 0,
    pair: CHAIN.pair,
    ts: a.ts
  };
  chainCache = { t: Date.now(), d: out };
  return out;
}




/* ── 錢包簽名驗證（EIP-191，純 JS，已驗證正確） ── */
import crypto from "node:crypto";

const NONCE_DIR = path.join(__dirname, "state");
function noncePath() { return path.join(NONCE_DIR, "nonces.json"); }
function readNonces() { try { return JSON.parse(fs.readFileSync(noncePath(), "utf8")); } catch (e) { return {}; } }
function writeNonces(v) { try { fs.mkdirSync(NONCE_DIR, { recursive: true }); fs.writeFileSync(noncePath(), JSON.stringify(v)); } catch (e) {} }

/* ═══ secp256k1 常數 ═══ */
const SECP_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const SECP_Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const SECP_Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;

function sMod(a, m) { const r = a % m; return r < 0n ? r + m : r; }
function sEgcd(a, b) { if (b === 0n) return [a, 1n, 0n]; const [g, x, y] = sEgcd(b, a % b); return [g, y, x - (a / b | 0n) * y]; }
function sInv(a, m) { const [g, x] = sEgcd(sMod(a, m), m); return sMod(x, m); }
function sAdd(p, q) {
  if (!p) return q; if (!q) return p;
  if (p[0] === q[0]) {
    if (sMod(p[1] + q[1], SECP_P) === 0n) return null;
    const l = sMod(3n * p[0] * p[0] * sInv(2n * p[1], SECP_P), SECP_P);
    return [sMod(l * l - 2n * p[0], SECP_P), sMod(l * (p[0] - sMod(l * l - 2n * p[0], SECP_P)) - p[1], SECP_P)];
  }
  const l = sMod((q[1] - p[1]) * sInv(q[0] - p[0], SECP_P), SECP_P);
  return [sMod(l * l - p[0] - q[0], SECP_P), sMod(l * (p[0] - sMod(l * l - p[0] - q[0], SECP_P)) - p[1], SECP_P)];
}
function sMul(k, p) { let r = null; k = sMod(k, SECP_N); while (k > 0n) { if (k & 1n) r = sAdd(r, p); p = sAdd(p, p); k >>= 1n; } return r; }
function sPow(b, e, m) { let r = 1n; b = sMod(b, m); while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }
function sG() { return [SECP_Gx, SECP_Gy]; }

/* ═══ Keccak-256（純 JS） ═══ */
const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];
const KECCAK_R = [[0,36,3,41,18],[1,44,10,45,2],[62,6,43,15,61],[28,55,25,21,56],[27,20,39,8,14]];
const U64 = (1n << 64n) - 1n;
function kRotl(x, n) { n %= 64n; return ((x << n) | (x >> (64n - n))) & U64; }

function keccak256(input) {
  const rate = 136;
  const msg = Buffer.from(input);
  const pad = rate - (msg.length % rate);
  const padded = Buffer.concat([msg, Buffer.alloc(pad)]);
  padded[msg.length] = 0x01;
  padded[padded.length - 1] |= 0x80;
  const st = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) st[i] ^= padded.readBigUInt64LE(off + i * 8);
    for (let rnd = 0; rnd < 24; rnd++) {
      const C = [], D = [];
      for (let x = 0; x < 5; x++) C[x] = st[x] ^ st[x+5] ^ st[x+10] ^ st[x+15] ^ st[x+20];
      for (let x = 0; x < 5; x++) D[x] = C[(x+4)%5] ^ kRotl(C[(x+1)%5], 1n);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) st[x+5*y] ^= D[x];
      const B = new Array(25).fill(0n);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y+5*((2*x+3*y)%5)] = kRotl(st[x+5*y], BigInt(KECCAK_R[x][y]));
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) st[x+5*y] = B[x+5*y] ^ ((~B[(x+1)%5+5*y]) & B[(x+2)%5+5*y]);
      st[0] ^= KECCAK_RC[rnd];
    }
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(st[i] & U64, i * 8);
  return out;
}

/* ═══ 公鑰恢復 + 地址 ═══ */
function pubToAddress(pub) {
  const hex = pub[0].toString(16).padStart(64, "0") + pub[1].toString(16).padStart(64, "0");
  const h = keccak256(Buffer.from(hex, "hex"));
  return "0x" + h.slice(12).toString("hex");
}

function recoverPubKey(hashBuf, rBuf, sBuf, v) {
  const r = BigInt("0x" + rBuf.toString("hex"));
  const s = BigInt("0x" + sBuf.toString("hex"));
  const e = BigInt("0x" + hashBuf.toString("hex"));

  // 標準 ECDSA 恢復: Q = r^-1 * (s*R - e*G)
  const x = r;
  const y2 = sMod(x*x*x + 7n, SECP_P);
  let y = sPow(y2, (SECP_P + 1n) / 4n, SECP_P);
  if (sMod(y*y, SECP_P) !== y2) return null;
  if ((y & 1n) !== BigInt(v - 27)) y = SECP_P - y;

  const R = [x, y];
  const rInv = sInv(r, SECP_N);

  // ⭐ 正確公式: Q = rInv * (s*R + (-e)*G)
  const sR = sMul(sMod(s * rInv, SECP_N), R);
  const eG = sMul(sMod(-e * rInv, SECP_N), sG());
  const Q = sAdd(sR, eG);
  return Q;
}

function verifyEthSignature(message, signature, expectedAddr) {
  try {
    if (!signature || signature.length < 130) return false;
    const sigHex = signature.startsWith("0x") ? signature.slice(2) : signature;
    // EIP-191
    const msgBytes = Buffer.from(message, "utf8");
    const prefix = Buffer.from("\x19Ethereum Signed Message:\n" + msgBytes.length, "utf8");
    const full = Buffer.concat([prefix, msgBytes]);
    const msgHash = keccak256(full);

    const sig = Buffer.from(sigHex, "hex");
    const r = sig.slice(0, 32);
    const s = sig.slice(32, 64);
    let v = sig[64];
    if (v < 27) v += 27;

    const pub = recoverPubKey(msgHash, r, s, v);
    if (!pub) return false;
    const addr = pubToAddress(pub);
    return addr.toLowerCase() === String(expectedAddr).toLowerCase();
  } catch (e) {
    console.error("[verify] error:", e.message);
    return false;
  }
}

function issueNonce(addr) {
  const n = readNonces();
  const nonce = crypto.randomBytes(16).toString("hex");
  n[String(addr).toLowerCase()] = { nonce, t: Date.now() };
  writeNonces(n);
  return nonce;
}
function consumeNonce(addr, nonce) {
  const n = readNonces();
  const rec = n[String(addr).toLowerCase()];
  if (!rec || rec.nonce !== nonce) return false;
  if (Date.now() - rec.t > 10 * 60 * 1000) return false;
  delete n[String(addr).toLowerCase()];
  writeNonces(n);
  return true;
}

/* ── ARK 完整市場數據（Dexscreener + 鏈上） ── */
let arkCache = { t: 0, d: null };
async function getArk() {
  if (arkCache.d && Date.now() - arkCache.t < 30000) return arkCache.d;
  const out = { ts: Date.now(), pair: CHAIN.pair, ark: CHAIN.ark };
  try {
    const r = await fetch("https://api.dexscreener.com/latest/dex/pairs/bsc/" + CHAIN.pair, {
      headers: { "User-Agent": "ark-citizen-tools" }
    });
    const d = await r.json();
    const p = d.pair || (d.pairs || [])[0];
    if (p) {
      out.priceUsd = parseFloat(p.priceUsd || 0);
      out.priceNative = parseFloat(p.priceNative || 0);
      out.marketCap = p.marketCap || null;
      out.fdv = p.fdv || null;
      out.liquidityUsd = (p.liquidity && p.liquidity.usd) || null;
      out.liquidityBase = (p.liquidity && p.liquidity.base) || null;
      out.liquidityQuote = (p.liquidity && p.liquidity.quote) || null;
      out.volume = p.volume || {};
      out.priceChange = p.priceChange || {};
      out.txns = p.txns || {};
      out.pairCreatedAt = p.pairCreatedAt || null;
      out.dexId = p.dexId || "bsc";
    }
  } catch (e) { out.error = "dex: " + e.message; }

  // 鏈上: getReserves + totalSupply
  try {
    const hex = await rpcCall("eth_call", [{ to: CHAIN.pair, data: "0x0902f1ac" }, "latest"]);
    const b = hex.slice(2);
    const r0 = BigInt("0x" + b.slice(0, 64));
    const r1 = BigInt("0x" + b.slice(64, 128));
    const D = Math.pow(10, CHAIN.decimals);
    out.poolUsdt = Number(r0) / D;
    out.poolArk = Number(r1) / D;
    if (!out.priceUsd && out.poolArk > 0) out.priceUsd = out.poolUsdt / out.poolArk;
    out.reservesUpdated = parseInt("0x" + b.slice(192, 256), 16) || null;
  } catch (e) { out.reservesError = e.message; }

  try {
    const ts = await rpcCall("eth_call", [{ to: CHAIN.ark, data: "0x18160ddd" }, "latest"]);
    out.totalSupply = Number(BigInt(ts)) / Math.pow(10, CHAIN.decimals);
  } catch (e) { /* ignore */ }

  arkCache = { t: Date.now(), d: out };
  return out;
}


/* ── ARKIE 子幣市場數據 ── */
let arkieCache = { t: 0, d: null };
async function getArkie() {
  if (arkieCache.d && Date.now() - arkieCache.t < 30000) return arkieCache.d;
  const out = { ts: Date.now(), pair: CHAIN.arkiePair, token: CHAIN.arkie, parent: CHAIN.ark };
  try {
    const r = await fetch("https://api.dexscreener.com/latest/dex/pairs/bsc/" + CHAIN.arkiePair, {
      headers: { "User-Agent": "ark-citizen-tools" }
    });
    const d = await r.json();
    const p = d.pair || (d.pairs || [])[0];
    if (p) {
      out.priceUsd = parseFloat(p.priceUsd || 0);
      out.priceInArk = parseFloat(p.priceNative || 0);
      out.marketCap = p.marketCap || null;
      out.fdv = p.fdv || null;
      out.liquidityUsd = (p.liquidity && p.liquidity.usd) || null;
      out.liquidityBase = (p.liquidity && p.liquidity.base) || null;
      out.liquidityQuote = (p.liquidity && p.liquidity.quote) || null;
      out.volume = p.volume || {};
      out.priceChange = p.priceChange || {};
      out.txns = p.txns || {};
      out.pairCreatedAt = p.pairCreatedAt || null;
      out.name = (p.baseToken && p.baseToken.name) || "Arkie";
      out.symbol = (p.baseToken && p.baseToken.symbol) || "ARKIE";
    }
  } catch (e) { out.error = "dex: " + e.message; }

  // 鏈上: ARKIE/ARK 儲備
  try {
    const hex = await rpcCall("eth_call", [{ to: CHAIN.arkiePair, data: "0x0902f1ac" }, "latest"]);
    const b = hex.slice(2);
    out.poolArkie = Number(BigInt("0x" + b.slice(0, 64))) / 1e18;
    out.poolArk = Number(BigInt("0x" + b.slice(64, 128))) / 1e18;
  } catch (e) { /* ignore */ }

  // 鏈上: ARKIE totalSupply
  try {
    const ts = await rpcCall("eth_call", [{ to: CHAIN.arkie, data: "0x18160ddd" }, "latest"]);
    out.totalSupply = Number(BigInt(ts)) / 1e18;
    out.circulating = out.totalSupply; // 若無 burn 記錄則視為相同
  } catch (e) { /* ignore */ }

  arkieCache = { t: Date.now(), d: out };
  return out;
}

/* ── 統計（交易數 / 持有者 / 運行天數） ── */
const BOOT_TS = Date.now();
async function getStats() {
  const snaps = readSnaps();
  let holders = null, trades = null;
  try {
    const a = await getArk();
    const tx = (a.txns && a.txns.h24) || {};
    trades = (tx.buys || 0) + (tx.sells || 0);
    holders = a.holders != null ? a.holders : null;
  } catch (e) { /* ignore */ }
  const days = snaps.length
    ? Math.max(1, Math.ceil((Date.now() - snaps[0].ts) / 864e5))
    : Math.max(1, Math.ceil((Date.now() - BOOT_TS) / 864e5));
  return {
    trades: trades != null ? trades : snaps.length,
    holders: holders != null ? holders : "-",
    days: days,
    ts: Date.now()
  };
}

/* ── 快照 ── */
function snapPath() { return path.join(STATE_DIR, "snapshots.json"); }
function readSnaps() {
  try { return JSON.parse(fs.readFileSync(snapPath(), "utf8")); } catch (e) { return []; }
}
function writeSnaps(v) {
  ensureState();
  try { fs.writeFileSync(snapPath(), JSON.stringify(v)); } catch (e) {}
}

async function snapshotTick() {
  try {
    const d = await getChain();
    const snaps = readSnaps();
    const last = snaps[snaps.length - 1];
    if (last && d.ts - last.ts < 5 * 60 * 1000) return;
    snaps.push({ ts: d.ts, price: d.price, usdt: d.poolUsdt, ark: d.poolArk });
    writeSnaps(snaps.slice(-5000));
  } catch (e) { /* ignore */ }
}

/* ── 通知 ── */
async function notifyTelegram(token, chat, msg) {
  if (!token || !chat) return { ok: false, error: "missing tgToken/tgChat" };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: msg, disable_web_page_preview: true })
    });
    const d = await r.json();
    return d.ok ? { ok: true, detail: "telegram sent" } : { ok: false, error: d.description || "tg error" };
  } catch (e) {
    return { ok: false, error: "tg: " + e.message };
  }
}

async function notifyWechat(key, msg, title) {
  if (!key) return { ok: false, error: "missing wxKey" };
  try {
    const url = `https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`;
    const _title = title || "ARK Citizen Tools";
    const body = new URLSearchParams({ title: _title, desp: msg });
    const r = await fetch(url, { method: "POST", body });
    const d = await r.json();
    const ok = d && (d.code === 0 || d.data);
    return ok ? { ok: true, detail: "wechat sent" } : { ok: false, error: (d && d.message) || "wx error" };
  } catch (e) {
    return { ok: false, error: "wx: " + e.message };
  }
}

/* 构造推送文案 (Markdown, Server酱支持) */
function buildCoefMsg(a, coef, threshold, turb) {
  const LF2 = String.fromCharCode(10);
  const pr = a.priceUsd != null ? Number(a.priceUsd).toFixed(6) : "-";
  const released = Number((turb && turb.released) || a.released || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const total = Number((turb && turb.total) || a.total || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const minR = Number((turb && turb.min24h) || a.min24h || 0).toFixed(4);
  const maxR = Number((turb && turb.max24h) || a.max24h || 0).toFixed(4);
  const cycle = Number((turb && turb.cycleSec) || a.cycleSec || 0);
  const relPct = Number((turb && turb.releasePct) || a.releasePct || 0).toFixed(2);
  // 官方公式: 实际到手 ARK 比例 = 0.78 × 涡轮系数 - 0.02
  const actualRate = 0.78 * Number(coef) - 0.02;
  const actualPct = (actualRate * 100).toFixed(2);
  const ts = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  return [
    "## 🚀 ARK 涡轮系数达标",
    "",
    "**当前系数:** " + Number(coef).toFixed(6) + "    **你的阈值:** " + Number(threshold).toFixed(4),
    "",
    "---",
    "",
    "### 💰 收益换算",
    "- **实际到手 ARK 比例:** **" + actualPct + "%**",
    "- **公式:** ARK奖励 × (0.78 × 涡轮系数 − 0.02)",
    "- **举例:** 奖励 100 ARK → 实际到手约 **" + actualPct + " ARK**",
    "",
    "### 📊 链上数据",
    "- **ARK 价格:** $" + pr,
    "- **24h 系数区间:** " + minR + " ~ " + maxR,
    "- **已释放 / 总量:** " + released + " / " + total,
    "- **释放进度:** " + relPct + "%",
    "- **释放周期:** " + cycle + "s",
    "",
    "> " + ts + " (UTC+8)",
    "",
    "系数已达到你设定的阈值, 请及时关注。"
  ].join(LF2);
}

/* ── 路由 ── */
/* 🔒 简单限流: 每IP每分钟最多 N 次写操作 */
const _rl = new Map();
function rateLimit(req, limit = 60, windowMs = 60000) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || (req.socket && req.socket.remoteAddress) || "?";
  const now = Date.now();
  let e = _rl.get(ip);
  if (!e || now - e.t > windowMs) { e = { n: 0, t: now }; _rl.set(ip, e); }
  e.n++;
  if (_rl.size > 5000) { for (const [k, v] of _rl) if (now - v.t > windowMs * 2) _rl.delete(k); }
  return e.n <= limit;
}

async function handleAPI(req, res, url) {
  const p = url.pathname;

  // 🔒 限流（仅对写操作）
  if (req.method === "POST" && !rateLimit(req, 60, 60000)) {
    return sendJSON(res, 429, { error: "too many requests, slow down" });
  }

  // 📡 電報號加速器節點資訊（管理員可選配置）
  if (p === "/api/tg-accel/nodes") {
    let cfg = { nodes: [], mtproto: {} };
    try {
      const raw = fs.readFileSync(path.join(ROOT, "tg-accel-config.json"), "utf8");
      cfg = JSON.parse(raw);
    } catch (e) { /* 無配置檔時用預設 */ }
    const defaultNodes = [
      { id: "auto", name: "智能加速（自動選線）", host: "auto", port: 443, tag: "推薦", region: "Auto" },
      { id: "sg", name: "新加坡 · 直連", host: "sg.ark-gate.io", port: 443, tag: "低延遲", region: "SG" },
      { id: "jp", name: "日本 · 直連", host: "jp.ark-gate.io", port: 443, tag: "穩定", region: "JP" },
      { id: "hk", name: "香港 · 直連", host: "hk.ark-gate.io", port: 443, tag: "高速", region: "HK" }
    ];
    const nodes = (Array.isArray(cfg.nodes) && cfg.nodes.length) ? cfg.nodes : defaultNodes;
    return sendJSON(res, 200, { ok: true, nodes, mtproto: cfg.mtproto || {} });
  }

  if (p === "/api/health") {
    return sendJSON(res, 200, { ok: true, ts: Date.now(), uptime: Math.floor(process.uptime()) });
  }

  if (p === "/api/chain") {
    try {
      const d = await getChain();
      return sendJSON(res, 200, d);
    } catch (e) {
      return sendJSON(res, 502, { error: e.message });
    }
  }

  if (p === "/api/ark") {
    try { return sendJSON(res, 200, await getArk()); }
    catch (e) { return sendJSON(res, 502, { error: e.message }); }
  }

  /* ═══ 官方质押实时数据（ARK 官网 API） ═══ */
  if (p === "/api/stakes") {
    try {
      const r = await fetch("https://0xfantasy.ark.pro/v1/bond-rebasing-config", {
        headers: { "Origin": "https://www.ark.pro", "Referer": "https://www.ark.pro/", "User-Agent": "Mozilla/5.0" }
      });
      const d = await r.json();
      const modes = (Array.isArray(d) ? d : []).map(m => ({
        modeId: m.modeId,
        rate: parseFloat(m.interestRate || 0),      // 每次 rebase 利率
        staking: parseFloat(m.totalStakingArk || 0),
        lpBonded: parseFloat(m.totalLpBondedArk || 0),
        updatedAt: m.updatedAt
      })).filter(m => m.modeId !== 100);   // 100 = 特殊池，可选保留
      const all = (Array.isArray(d) ? d : []).map(m => ({
        modeId: m.modeId, rate: parseFloat(m.interestRate || 0), staking: parseFloat(m.totalStakingArk || 0)
      }));
      return sendJSON(res, 200, { modes, all, rebaseHours: 12, ts: Date.now() });
    } catch (e) {
      return sendJSON(res, 502, { error: e.message });
    }
  }

  /* ═══ 收益看板 (Portfolio) ═══ */
  if (p === "/api/portfolio") {
    // 輸入: ?amount=ARK數量&plan=stakePlan&days=持倉天數
    const amount = parseFloat(url.searchParams.get("amount") || "0");
    const plan = url.searchParams.get("plan") || "360";
    const days = parseInt(url.searchParams.get("days") || "0", 10);
    if (!(amount >= 0)) return sendJSON(res, 400, { error: "bad amount" });
    const ark = await getArk().catch(() => null);
    const price = ark && ark.priceUsd ? ark.priceUsd : null;
    const rate = dailyRateForPlan(plan); // 日收益率(小數)
    const effDays = Math.max(0, days);
    const earnedArk = amount * (Math.pow(1 + rate, effDays) - 1);
    const curArk = amount + earnedArk;
    return sendJSON(res, 200, {
      amount, plan, days: effDays,
      dailyRate: rate,
      price,
      valueUsd: price ? amount * price : null,
      earnedArk: +earnedArk.toFixed(6),
      currentArk: +curArk.toFixed(6),
      valueUsdNow: price ? +(curArk * price).toFixed(2) : null,
      earnedUsd: price ? +(earnedArk * price).toFixed(2) : null,
      apy: +((Math.pow(1 + rate, 365) - 1) * 100).toFixed(2),
      ts: Date.now(),
      source: "pancakeswap-v2"
    });
  }

  /* ═══ 鏈上持倉讀取 (Holdings) ═══ */
  if (p === "/api/holdings") {
    const addr = (url.searchParams.get("addr") || "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return sendJSON(res, 400, { error: "bad address" });
    const A = addr.toLowerCase().slice(2).padStart(64, "0");
    const call = async (to, method) => {
      try {
        const hex = await rpcCall("eth_call", [{ to, data: method + A }, "latest"]);
        if (!hex || hex === "0x") return 0n;
        return BigInt(hex);
      } catch (e) { return null; }
    };
    const [ark, arkie, gark, bnb] = await Promise.all([
      call(CHAIN.ark, "0x70a08231"),
      call(CHAIN.arkie, "0x70a08231"),
      call(CHAIN.gark, "0x70a08231"),
      rpcCall("eth_getBalance", [addr, "latest"]).then(h => h ? BigInt(h) : 0n).catch(() => 0n),
    ]);
    const arkInfo = await getArk().catch(() => null);
    const arkieInfo = await getArkie().catch(() => null);
    const f = (v, d = 18) => v == null ? null : Number(v) / Math.pow(10, d);
    const arkBal = f(ark);
    const arkieBal = f(arkie);
    const garkBal = f(gark);
    const arkP = arkInfo && arkInfo.priceUsd ? arkInfo.priceUsd : null;
    const arkieP = arkieInfo && arkieInfo.priceUsd ? arkieInfo.priceUsd : null;
    const totalUsd = (arkBal != null && arkP ? arkBal * arkP : 0) + (arkieBal != null && arkieP ? arkieBal * arkieP : 0);
    return sendJSON(res, 200, {
      addr, bnb: f(bnb), ark: arkBal, arkie: arkieBal, gark: garkBal,
      arkPrice: arkP, arkiePrice: arkieP,
      arkUsd: arkBal != null && arkP ? +(arkBal * arkP).toFixed(2) : null,
      arkieUsd: arkieBal != null && arkieP ? +(arkieBal * arkieP).toFixed(2) : null,
      totalUsd: +totalUsd.toFixed(2),
      ts: Date.now()
    });
  }

  /* ═══ 鯨魚監控 (Whale Watch) ═══ */
  if (p === "/api/whales") {
    const minArk = parseFloat(url.searchParams.get("min") || "10000");
    try {
      const latest = parseInt(await rpcCall("eth_blockNumber", []), 16);
      const from = Math.max(0, latest - 50); // 最近 ~50 块(约2-3分钟，避免RPC拒绝)
      const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
      const logs = await rpcCall("eth_getLogs", [{
        fromBlock: "0x" + from.toString(16),
        toBlock: "latest",
        address: CHAIN.ark,
        topics: [TRANSFER]
      }]);
      const out = [];
      for (const lg of (logs || [])) {
        try {
          const val = Number(BigInt(lg.data)) / 1e18;
          if (val < minArk) continue;
          const fromA = "0x" + lg.topics[1].slice(26);
          const toA = "0x" + lg.topics[2].slice(26);
          out.push({
            amount: +val.toFixed(2),
            from: fromA, to: toA,
            tx: lg.transactionHash,
            block: parseInt(lg.blockNumber, 16),
            ts: Date.now()
          });
        } catch (e) {}
      }
      out.sort((a, b) => b.amount - a.amount);
      return sendJSON(res, 200, { min: minArk, scannedBlocks: 50, count: out.length, transfers: out.slice(0, 40), ts: Date.now() });
    } catch (e) {
      return sendJSON(res, 502, { error: e.message });
    }
  }

  /* ═══ 價格預警 (Alerts) — CRUD ═══ */
  if (p === "/api/alerts" && req.method === "POST") {
    let b;
    try { b = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
    const { addr, kind, target } = b || {};
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr || "")) return sendJSON(res, 400, { error: "bad address" });
    if (!requireVip(res, addr)) return;
    if (!["above", "below", "change"].includes(kind)) return sendJSON(res, 400, { error: "bad kind" });
    const t = parseFloat(target);
    if (!(t > 0)) return sendJSON(res, 400, { error: "bad target" });
    const al = loadAlerts();
    const id = crypto.randomBytes(6).toString("hex");
    al.push({ id, addr: addr.toLowerCase(), kind, target: t, created: Date.now(), triggered: false });
    saveAlerts(al);
    return sendJSON(res, 200, { ok: true, id, count: al.filter(a => a.addr === addr.toLowerCase()).length });
  }

  if (p === "/api/alerts" && req.method === "GET") {
    const addr = (url.searchParams.get("addr") || "").toLowerCase();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return sendJSON(res, 400, { error: "bad address" });
    if (!requireVip(res, addr)) return;
    const list = loadAlerts().filter(a => a.addr === addr);
    return sendJSON(res, 200, { alerts: list });
  }

  if (p === "/api/alerts/delete" && req.method === "POST") {
    let b;
    try { b = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
    const { addr, id } = b || {};
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr || "") || !id) return sendJSON(res, 400, { error: "bad params" });
    const al = loadAlerts();
    const filtered = al.filter(a => !(a.addr === addr.toLowerCase() && a.id === id));
    saveAlerts(filtered);
    return sendJSON(res, 200, { ok: true });
  }

  /* ═══ 分享卡片數據 ═══ */
  if (p === "/api/share-card") {
    const amount = parseFloat(url.searchParams.get("amount") || "0");
    const plan = url.searchParams.get("plan") || "360";
    const days = parseInt(url.searchParams.get("days") || "0", 10);
    const ark = await getArk().catch(() => null);
    const price = ark && ark.priceUsd ? ark.priceUsd : null;
    const rate = dailyRateForPlan(plan);
    const earned = amount * (Math.pow(1 + rate, Math.max(0, days)) - 1);
    return sendJSON(res, 200, {
      amount, days: Math.max(0, days), plan,
      earnedArk: +earned.toFixed(4),
      earnedUsd: price ? +(earned * price).toFixed(2) : null,
      currentArk: +(amount + earned).toFixed(4),
      price,
      ts: Date.now()
    });
  }


  /* ═══ 用戶 / 付費 API ═══ */
  if (p === "/api/auth/nonce") {
    const addr = url.searchParams.get("addr") || "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return sendJSON(res, 400, { error: "bad address" });
    const nonce = issueNonce(addr);
    const msg = `ARK Citizen Tools login\naddress: ${addr.toLowerCase()}\nnonce: ${nonce}`;
    return sendJSON(res, 200, { nonce, message: msg });
  }

  if (p === "/api/auth/verify" && req.method === "POST") {
    let b;
    try { b = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
    const { addr, message, signature } = b || {};
    if (!addr || !message || !signature) return sendJSON(res, 400, { error: "missing fields" });
    const m = /nonce: ([0-9a-f]+)/.exec(message);
    if (!m || !consumeNonce(addr, m[1])) return sendJSON(res, 401, { error: "bad nonce" });
    if (!verifyEthSignature(message, signature, addr)) return sendJSON(res, 401, { error: "bad signature" });
    // ⭐ 白名单: 登录即永久 PRO
    if (isWhitelisted(addr)) {
      const wl = Date.now() + 100 * 365 * 86400000;
      const u = PAY.upsertUser(addr, { lastLogin: Date.now(), plan: "whitelist", until: wl });
      return sendJSON(res, 200, { ok: true, addr: addr.toLowerCase(), plan: "whitelist", until: wl, pro: true, whitelist: true });
    }
    const u = PAY.upsertUser(addr, { lastLogin: Date.now() });
    const pro = PAY.isPro(addr);
    return sendJSON(res, 200, { ok: true, addr: addr.toLowerCase(), plan: pro ? u.plan : "free", until: pro ? u.until : 0, pro });
  }

  if (p === "/api/me") {
    const addr = url.searchParams.get("addr") || "";
    // ⭐ 白名单: 直接给 PRO（无需充值）
    if (isWhitelisted(addr)) {
      const wl = Date.now() + 100 * 365 * 86400000;  // 100年
      try { PAY.upsertUser(addr.toLowerCase(), { plan: "whitelist", until: wl }); } catch(e){}
      return sendJSON(res, 200, { addr: addr.toLowerCase(), plan: "whitelist", pro: true, until: wl, whitelist: true, totalPaid: 0 });
    }
    // ⭐ 合法地址 → 自动建档（保证后续能生成绑定码 / 充值）
    if (/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      let u = PAY.getUser(addr);
      if (!u) { try { u = PAY.upsertUser(addr, { lastLogin: Date.now() }); } catch(e){ u = PAY.getUser(addr); } }
    }
    const u = PAY.getUser(addr);
    if (!u) return sendJSON(res, 200, { addr: addr.toLowerCase(), plan: "free", pro: false, until: 0 });
    const pro = PAY.isPro(addr);
    return sendJSON(res, 200, { addr: u.addr, plan: pro ? u.plan : "free", pro, until: pro ? u.until : 0, totalPaid: u.totalPaid || 0, whitelist: isWhitelisted(addr) });
  }

  /* ═══ 海报图片保存（base64 → 文件 → URL） ═══ */
  if (p === "/api/saveimg" && req.method === "POST") {
    let b;
    try { b = JSON.parse(await readBody(req, 8 * 1024 * 1024)); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
    const dataUrl = b.data || "";
    const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/.exec(dataUrl);
    if (!m) return sendJSON(res, 400, { error: "bad image" });
    const ext = m[1] === "jpeg" ? "jpg" : m[1];
    const id = crypto.randomBytes(8).toString("hex");
    const dir = path.join(ROOT, "posters");
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    const fn = path.join(dir, id + "." + ext);
    try { fs.writeFileSync(fn, Buffer.from(m[2], "base64")); } catch (e) { return sendJSON(res, 500, { error: "write fail" }); }
    return sendJSON(res, 200, { url: "/posters/" + id + "." + ext, id });
  }

  /* ═══ 通用文件/视频上传（base64 → 文件 → URL） ═══ */
  if (p === "/api/uploadfile" && req.method === "POST") {
    let b;
    try { b = JSON.parse(await readBody(req, 60 * 1024 * 1024)); } catch (e) { return sendJSON(res, 400, { error: "bad json or too large (max 60MB)" }); }
    const dataUrl = b.data || "";
    const m = /^data:([a-zA-Z0-9.+\/-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) return sendJSON(res, 400, { error: "bad data url" });
    const mime = m[1].toLowerCase();
    const MIME_EXT = {
      "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/x-msvideo": "avi", "video/mpeg": "mpeg",
      "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/wav": "wav", "audio/ogg": "ogg", "audio/webm": "weba",
      "application/pdf": "pdf", "application/zip": "zip", "application/x-zip-compressed": "zip",
      "application/msword": "doc", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
      "application/vnd.ms-excel": "xls", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
      "text/plain": "txt", "text/csv": "csv", "application/json": "json", "application/octet-stream": "bin"
    };
    const ext = MIME_EXT[mime] || (mime.split("/")[1] || "bin").replace(/[^a-z0-9]/g, "").slice(0, 6);
    const buf = Buffer.from(m[2], "base64");
    const MAX = 60 * 1024 * 1024;
    if (buf.length > MAX) return sendJSON(res, 413, { error: "file too large (max 60MB)" });
    const id = crypto.randomBytes(8).toString("hex");
    const dir = path.join(ROOT, "posters");
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    const fn = path.join(dir, id + "." + ext);
    try { fs.writeFileSync(fn, buf); } catch (e) { return sendJSON(res, 500, { error: "write fail" }); }
    return sendJSON(res, 200, { url: "/posters/" + id + "." + ext, id, size: buf.length, mime, ext });
  }

  /* ═══ ARK Chat API ═══ */
  if (p === "/api/chat/me") {
    const addr = (url.searchParams.get("addr") || "").toLowerCase();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return sendJSON(res, 400, { error: "bad address" });
    return sendJSON(res, 200, CHAT.ensureUser(addr));
  }
  if (p === "/api/chat/profile" && req.method === "POST") {
    let b; try { b = JSON.parse(await readBody(req)); } catch(e){ return sendJSON(res,400,{error:"bad json"}); }
    return sendJSON(res, 200, CHAT.setProfile(b.addr, { name: b.name, avatar: b.avatar }));
  }
  if (p === "/api/chat/sethandle" && req.method === "POST") {
    let b; try { b = JSON.parse(await readBody(req)); } catch(e){ return sendJSON(res,400,{error:"bad json"}); }
    const r = CHAT.setHandle(b.addr, b.handle);
    return sendJSON(res, r.ok?200:400, r);
  }
  if (p === "/api/chat/find") {
    const q = url.searchParams.get("q") || "";
    const u = CHAT.findUser(q);
    return sendJSON(res, u ? 200 : 404, u || { error: "not found" });
  }
  if (p === "/api/chat/search") {
    return sendJSON(res, 200, { users: CHAT.searchUsers(url.searchParams.get("q") || "") });
  }
  if (p === "/api/chat/friends") {
    const addr = (url.searchParams.get("addr") || "").toLowerCase();
    return sendJSON(res, 200, { friends: CHAT.listFriends(addr) });
  }
  if (p === "/api/chat/requests") {
    const addr = (url.searchParams.get("addr") || "").toLowerCase();
    return sendJSON(res, 200, { requests: CHAT.listRequests(addr) });
  }
  if (p === "/api/chat/addfriend" && req.method === "POST") {
    let b; try { b = JSON.parse(await readBody(req)); } catch(e){ return sendJSON(res,400,{error:"bad json"}); }
    const r = CHAT.addFriendRequest(b.from, b.to);
    return sendJSON(res, r.ok?200:400, r);
  }
  if (p === "/api/chat/accept" && req.method === "POST") {
    let b; try { b = JSON.parse(await readBody(req)); } catch(e){ return sendJSON(res,400,{error:"bad json"}); }
    const r = CHAT.acceptFriend(b.from, b.to);
    if (r.ok) { try { _chatBroadcast(b.to.toLowerCase(), { type:"friend", from:b.from }); } catch(e){} }
    return sendJSON(res, r.ok?200:400, r);
  }
  if (p === "/api/chat/reject" && req.method === "POST") {
    let b; try { b = JSON.parse(await readBody(req)); } catch(e){ return sendJSON(res,400,{error:"bad json"}); }
    return sendJSON(res, 200, CHAT.rejectFriend(b.from, b.to));
  }
  if (p === "/api/chat/messages") {
    const a = (url.searchParams.get("a") || "").toLowerCase();
    const b = (url.searchParams.get("b") || "").toLowerCase();
    const lim = parseInt(url.searchParams.get("limit") || "50", 10);
    return sendJSON(res, 200, { messages: CHAT.getMessages(a, b, lim) });
  }
  if (p === "/api/chat/send" && req.method === "POST") {
    let b; try { b = JSON.parse(await readBody(req)); } catch(e){ return sendJSON(res,400,{error:"bad json"}); }
    const msg = CHAT.sendMessage(b.from, b.to, b.text, b.type || "text", b.extra);
    // 只推给对方（自己已本地显示，避免重复）
    _chatBroadcast(b.to.toLowerCase(), { type:"msg", chatId: CHAT.chatId(b.from,b.to), msg });
    return sendJSON(res, 200, msg);
  }
  if (p === "/api/chat/groups") {
    const addr = (url.searchParams.get("addr") || "").toLowerCase();
    return sendJSON(res, 200, { groups: CHAT.listGroups(addr) });
  }
  /* 群成员（含在线状态）— 会议用 */
  if (p === "/api/chat/group/members") {
    const gid = url.searchParams.get("gid") || "";
    const me = (url.searchParams.get("me") || "").toLowerCase();
    const groups = CHAT.listGroups(me);
    const g = groups.find(x => x.gid === gid);
    if (!g) return sendJSON(res, 404, { error: "not in group" });
    const online = CHAT.onlineList();
    const members = (g.members || []).map(a => ({ addr: a, online: online.indexOf(a) >= 0 }));
    return sendJSON(res, 200, { gid, name: g.name, members });
  }
  if (p === "/api/chat/group/create" && req.method === "POST") {
    let b; try { b = JSON.parse(await readBody(req)); } catch(e){ return sendJSON(res,400,{error:"bad json"}); }
    return sendJSON(res, 200, CHAT.createGroup(b.owner, b.name, b.members));
  }
  if (p === "/api/chat/group/send" && req.method === "POST") {
    let b; try { b = JSON.parse(await readBody(req)); } catch(e){ return sendJSON(res,400,{error:"bad json"}); }
    const r = CHAT.groupSend(b.from, b.gid, b.text, b.type || "text", b.extra);
    if (r.ok) {
      const g = CHAT.listGroups(b.from).find(x => x.gid === b.gid);
      (g ? g.members : []).forEach(m => _chatBroadcast(m, { type:"gmsg", gid:b.gid, msg:r.msg }));
    }
    return sendJSON(res, r.ok?200:400, r);
  }
  if (p === "/api/chat/group/messages") {
    const gid = url.searchParams.get("gid") || "";
    return sendJSON(res, 200, { messages: CHAT.groupMessages(gid, parseInt(url.searchParams.get("limit")||"50",10)) });
  }
  if (p === "/api/chat/unread") {
    const addr=(url.searchParams.get("addr")||"").toLowerCase();
    return sendJSON(res,200,{ unread: CHAT.getUnread(addr), online: CHAT.onlineList() });
  }
  if (p === "/api/chat/read" && req.method==="POST") {
    let b; try{b=JSON.parse(await readBody(req))}catch(e){return sendJSON(res,400,{error:"bad"})}
    return sendJSON(res,200, CHAT.markRead(b.addr,b.chatId));
  }
  if (p === "/api/chat/recall" && req.method==="POST") {
    let b; try{b=JSON.parse(await readBody(req))}catch(e){return sendJSON(res,400,{error:"bad"})}
    const r=CHAT.recall(b.addr,b.chatId,b.msgId);
    if (r.ok){ _chatBroadcast(b.to,{type:"recall",chatId:b.chatId,msgId:b.msgId}); _chatBroadcast(b.addr,{type:"recall",chatId:b.chatId,msgId:b.msgId}); }
    return sendJSON(res,r.ok?200:400,r);
  }
  if (p === "/api/chat/feed") {
    return sendJSON(res, 200, { posts: CHAT.feed(50) });
  }
  if (p === "/api/chat/post" && req.method === "POST") {
    let b; try { b = JSON.parse(await readBody(req)); } catch(e){ return sendJSON(res,400,{error:"bad json"}); }
    return sendJSON(res, 200, CHAT.post(b.addr, b.text, b.image));
  }
  if (p === "/api/chat/like" && req.method === "POST") {
    let b; try { b = JSON.parse(await readBody(req)); } catch(e){ return sendJSON(res,400,{error:"bad json"}); }
    return sendJSON(res, 200, CHAT.likePost(b.addr, b.pid));
  }
  if (p === "/api/chat/comment" && req.method === "POST") {
    let b; try { b = JSON.parse(await readBody(req)); } catch(e){ return sendJSON(res,400,{error:"bad json"}); }
    return sendJSON(res, 200, CHAT.commentPost(b.addr, b.pid, b.text));
  }

  /* ═══ 推广系统 ═══ */
  if (p === "/api/ref/me") {
    const addr = (url.searchParams.get("addr") || "").toLowerCase();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return sendJSON(res, 400, { error: "bad address" });
    REF.ensureUser(addr);
    return sendJSON(res, 200, REF.userStats(addr));
  }
  if (p === "/api/ref/log") {
    const addr = (url.searchParams.get("addr") || "").toLowerCase();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return sendJSON(res, 400, { error: "bad address" });
    return sendJSON(res, 200, { log: REF.userLog(addr) });
  }
  if (p === "/api/ref/bind" && req.method === "POST") {
    let b;
    try { b = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
    const r = REF.ensureUser(b.addr, b.code);
    return sendJSON(res, r ? 200 : 400, r || { error: "bad" });
  }
  if (p === "/api/ref/resolve") {
    const code = (url.searchParams.get("code") || "").trim();
    const db = (() => { try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, "referrals.json"), "utf8")) || {}; } catch(e){ return {}; } })();
    const addr = Object.keys(db).find(a => db[a].code === code.toUpperCase());
    if (!addr) return sendJSON(res, 404, { error: "not found" });
    return sendJSON(res, 200, { addr, code: code.toUpperCase() });
  }
  if (p === "/api/ref/leaderboard") {
    return sendJSON(res, 200, { board: REF.leaderboard(20) });
  }
  if (p === "/api/ref/withdraw" && req.method === "POST") {
    let b;
    try { b = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
    const r = REF.withdraw(b.addr, b.amount, b.currency || "ARK");
    return sendJSON(res, r.ok ? 200 : 400, r);
  }

  if (p === "/api/plans") {
    return sendJSON(res, 200, { plans: PAY.PRICING, payTo: CHAIN.payTo });
  }

  if (p === "/api/invoice" && req.method === "POST") {
    let b;
    try { b = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
    const { addr, plan } = b || {};
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr || "")) return sendJSON(res, 400, { error: "bad address" });
    try {
      const inv = PAY.createInvoice(addr, plan);
      return sendJSON(res, 200, { ...inv, payTo: CHAIN.payTo, token: CHAIN.ark });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  if (p === "/api/invoice/check" && req.method === "POST") {
    let b;
    try { b = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
    const { invId, txHash } = b || {};
    const db = PAY.getInvoices();
    const inv = db.invoices[invId];
    if (!inv) return sendJSON(res, 404, { error: "invoice not found" });
    if (inv.status === "paid") return sendJSON(res, 200, { ok: true, status: "paid", until: (PAY.getUser(inv.addr) || {}).until });
    // 鏈上驗證該 txHash
    try {
      const receipt = await rpcCall("eth_getTransactionReceipt", [txHash]);
      if (!receipt) return sendJSON(res, 200, { ok: false, status: "pending", detail: "tx not found yet" });
      // ⭐ 支持两种付费方式:
      //   A. 直接转 ARK 到 payTo（旧）
      //   B. 通过分配合约 pay()（新，tx.to = 合约）
      const REFERRAL = "0x5e715816cc6d726b47f7bf3f4ee5ed34fb2615b4";
      const to = (receipt.to || "").toLowerCase();
      const logs = receipt.logs || [];
      const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
      let amount = 0, from = "";
      const isContract = (to === REFERRAL);
      if (isContract) {
        // 合约付费: 找【用户→合约】的 Transfer，金额即付费额
        for (const lg of logs) {
          if ((lg.address || "").toLowerCase() !== CHAIN.ark.toLowerCase()) continue;
          if (!lg.topics || lg.topics[0] !== TRANSFER) continue;
          const toA = "0x" + lg.topics[2].slice(26).toLowerCase();
          if (toA !== REFERRAL) continue;
          from = "0x" + lg.topics[1].slice(26).toLowerCase();
          amount = Number(BigInt(lg.data)) / 1e18;
          break;
        }
      } else {
        // 直接转账: 找【用户→payTo】
        if (to !== CHAIN.ark.toLowerCase()) return sendJSON(res, 200, { ok: false, status: "pending", detail: "not ARK tx" });
        for (const lg of logs) {
          if ((lg.address || "").toLowerCase() !== CHAIN.ark.toLowerCase()) continue;
          if (!lg.topics || lg.topics[0] !== TRANSFER) continue;
          const toA = "0x" + lg.topics[2].slice(26).toLowerCase();
          if (toA !== CHAIN.payTo.toLowerCase()) continue;
          from = "0x" + lg.topics[1].slice(26).toLowerCase();
          amount = Number(BigInt(lg.data)) / 1e18;
          break;
        }
      }
      if (!amount) return sendJSON(res, 200, { ok: false, status: "pending", detail: "no ARK transfer found" });
      const r = PAY.markPaid(invId, txHash, from, amount);
      if (r.ok && !isContract) { try { REF.ensureUser(from); REF.distribute(from, amount, "pro"); } catch(e){} }  // 合约付费已自动分润
      return sendJSON(res, r.ok ? 200 : 400, { ...r, status: r.ok ? "paid" : "pending" });
    } catch (e) {
      return sendJSON(res, 502, { ok: false, error: e.message });
    }
  }

  if (p === "/api/invoices") {
    const addr = (url.searchParams.get("addr") || "").toLowerCase();
    const db = PAY.getInvoices();
    const list = Object.values(db.invoices).filter(x => x.addr === addr).slice(-50).reverse();
    return sendJSON(res, 200, { invoices: list });
  }

  /* ═══ 後台（簡單密碼保護） ═══ */
  if (p === "/api/admin/revenue") {
    const key = url.searchParams.get("key") || "";
    const ADMIN_KEY = process.env.ADMIN_KEY || "ark2026";
    if (key !== ADMIN_KEY) return sendJSON(res, 401, { error: "unauthorized" });
    return sendJSON(res, 200, PAY.revenueStats());
  }

  if (p === "/admin") {
    return serveAdmin(res);
  }


  /* ═══ 廣告位 API ═══ */
  if (p === "/api/ads/slots") {
    return sendJSON(res, 200, { slots: ADS.AD_SLOTS, durations: ADS.DURATIONS, payTo: CHAIN.payTo });
  }

  if (p === "/api/ads/active") {
    const slot = url.searchParams.get("slot") || null;
    return sendJSON(res, 200, { ads: ADS.getActiveAds(slot) });
  }

  if (p === "/api/ads/create" && req.method === "POST") {
    let b;
    try { b = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
    // 🔒 需求: 投放广告必须先升级 PRO
    const creator = (b.addr || "").toLowerCase();
    if (!/^0x[0-9a-fA-F]{40}$/.test(creator)) return sendJSON(res, 400, { error: "bad address" });
    if (!PAY.isPro(creator)) return sendJSON(res, 403, { error: "pro_required", detail: "投放广告需先升级 PRO 会员" });
    try {
      const ad = ADS.createAd(b);
      return sendJSON(res, 200, { ...ad, payTo: CHAIN.payTo, token: CHAIN.ark });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  /* ═══ 广告位展示的系统（管理员配置，PRO 可用） ═══ */
  if (p === "/api/systems") {
    return sendJSON(res, 200, { systems: loadSystems() });
  }
  if (p === "/api/systems/save" && req.method === "POST") {
    let b;
    try { b = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
    const ADMIN_KEY = process.env.ADMIN_KEY || "ark2026";
    if ((b.key || "") !== ADMIN_KEY) return sendJSON(res, 403, { error: "forbidden" });
    saveSystems(b.systems || []);
    return sendJSON(res, 200, { ok: true });
  }

  if (p === "/api/ads/check" && req.method === "POST") {
    let b;
    try { b = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
    const { adId, txHash } = b || {};
    try {
      const receipt = await rpcCall("eth_getTransactionReceipt", [txHash]);
      if (!receipt) return sendJSON(res, 200, { ok: false, status: "pending", detail: "tx not found" });
      if ((receipt.to || "").toLowerCase() !== CHAIN.ark.toLowerCase()) {
        return sendJSON(res, 200, { ok: false, status: "pending", detail: "not ARK tx" });
      }
      let amount = 0, from = "";
      for (const lg of (receipt.logs || [])) {
        if ((lg.address || "").toLowerCase() !== CHAIN.ark.toLowerCase()) continue;
        if (!lg.topics || lg.topics[0] !== "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef") continue;
        const toA = "0x" + lg.topics[2].slice(26).toLowerCase();
        if (toA !== CHAIN.payTo.toLowerCase()) continue;
        from = "0x" + lg.topics[1].slice(26).toLowerCase();
        amount = Number(BigInt(lg.data)) / 1e18;
        break;
      }
      if (!amount) return sendJSON(res, 200, { ok: false, status: "pending", detail: "no ARK transfer" });
      const r = ADS.markAdPaid(adId, txHash, amount);
      return sendJSON(res, r.ok ? 200 : 400, { ...r, status: r.ok ? "pending_review" : "pending_pay" });
    } catch (e) { return sendJSON(res, 502, { ok: false, error: e.message }); }
  }

  if (p === "/api/ads/mine") {
    const addr = (url.searchParams.get("addr") || "").toLowerCase();
    const list = ADS.listAds().filter(x => x.addr === addr);
    return sendJSON(res, 200, { ads: list });
  }

  if (p === "/api/ads/track" && req.method === "POST") {
    let b;
    try { b = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
    ADS.trackAd(b.id, b.type);
    return sendJSON(res, 200, { ok: true });
  }

  /* 管理員審核 */
  if (p === "/api/admin/ads") {
    const key = url.searchParams.get("key") || "";
    if (key !== (process.env.ADMIN_KEY || "ark2026")) return sendJSON(res, 401, { error: "unauthorized" });
    const status = url.searchParams.get("status") || null;
    return sendJSON(res, 200, { ads: ADS.listAds(status), stats: ADS.adStats() });
  }

  if (p === "/api/admin/ads/review" && req.method === "POST") {
    let b;
    try { b = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
    if (b.key !== (process.env.ADMIN_KEY || "ark2026")) return sendJSON(res, 401, { error: "unauthorized" });
    const r = ADS.reviewAd(b.adId, !!b.approve);
    return sendJSON(res, r.ok ? 200 : 400, r);
  }

  /* ═══ 删除广告（管理员） ═══ */
  if (p === "/api/admin/ads/delete" && req.method === "POST") {
    let b;
    try { b = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
    if (b.key !== (process.env.ADMIN_KEY || "ark2026")) return sendJSON(res, 401, { error: "unauthorized" });
    if (b.adId) {
      const r = ADS.deleteAd(b.adId);
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    if (Array.isArray(b.adIds)) {
      const r = ADS.deleteAds(b.adIds);
      return sendJSON(res, 200, r);
    }
    return sendJSON(res, 400, { error: "missing adId" });
  }

  /* ═══ 联系表单 ═══ */
  if (p === "/api/contact" && req.method === "POST") {
    let b;
    try { b = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
    const { contact, body, addr } = b || {};
    if (!body || String(body).trim().length < 2) return sendJSON(res, 400, { error: "訊息太短" });
    const list = loadContacts();
    const id = crypto.randomBytes(6).toString("hex");
    const rec = {
      id, addr: (addr || "").toLowerCase() || null,
      contact: String(contact || "").slice(0, 200),
      body: String(body).slice(0, 2000),
      ip: (req.headers["x-forwarded-for"] || "").split(",")[0] || "",
      created: Date.now(), read: false
    };
    list.push(rec);
    if (list.length > 500) list.splice(0, list.length - 500);
    saveContacts(list);
    // 尝试通知（若配置了 Telegram）
    try {
      const tgTok = process.env.TG_BOT_TOKEN, tgChat = process.env.TG_CHAT_ID;
      if (tgTok && tgChat) await notifyTelegram(tgTok, tgChat, '📩 新联系: ' + rec.contact + '\n' + rec.body.slice(0, 300));
    } catch (e) {}
    return sendJSON(res, 200, { ok: true, id });
  }

  if (p === "/api/contact/list") {
    const key = url.searchParams.get("key") || "";
    const ADMIN_KEY = process.env.ADMIN_KEY || "ark2026";
    if (key !== ADMIN_KEY) return sendJSON(res, 403, { error: "forbidden" });
    return sendJSON(res, 200, { messages: loadContacts() });
  }

  if (p === "/api/contact/read" && req.method === "POST") {
    let b;
    try { b = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
    const ADMIN_KEY = process.env.ADMIN_KEY || "ark2026";
    if ((b.key || "") !== ADMIN_KEY) return sendJSON(res, 403, { error: "forbidden" });
    const list = loadContacts();
    const m = list.find(x => x.id === b.id);
    if (m) { m.read = true; saveContacts(list); }
    return sendJSON(res, 200, { ok: true });
  }

  /* ═══ 实时系数 (Coefficient) ═══ */
  if (p === "/api/coefficient") {
    try {
      const a = await getArk().catch(() => null);
      if (!a) return sendJSON(res, 502, { error: "no data" });
      const poolArk = a.liquidityBase || 0;
      const poolUsdt = a.liquidityQuote || 0;
      const price = a.priceUsd || 0;
      const vol = (a.volume && a.volume.h24) || 0;
      const txns = a.txns && a.txns.h24 ? a.txns.h24 : { buys: 0, sells: 0 };
      // ── 系数定义 ──
      // 1. 底池比（USDT/ARK）：越高说明买盘越强/价格上涨
      const poolRatio = poolArk > 0 ? poolUsdt / poolArk : 0;
      // 2. 买卖比：>1 买盘强
      const bsRatio = txns.sells > 0 ? txns.buys / txns.sells : (txns.buys > 0 ? 2 : 1);
      // 3. 换手率（量/流动性）
      const turnover = poolUsdt * 2 > 0 ? vol / (poolUsdt * 2) : 0;
      // 4. 综合系数（0-100 评分）
      let score = 50;
      if (poolRatio > price) score += 10; else if (poolRatio < price) score -= 10;
      if (bsRatio > 1.1) score += 15; else if (bsRatio < 0.9) score -= 15;
      if (turnover > 0.15) score += 15; else if (turnover < 0.03) score -= 10;
      const pc = a.priceChange || {};
      if ((pc.h1 || 0) > 1) score += 10; else if ((pc.h1 || 0) < -1) score -= 10;
      score = Math.max(0, Math.min(100, score));
      return sendJSON(res, 200, {
        poolRatio: +poolRatio.toFixed(6),
        bsRatio: +bsRatio.toFixed(4),
        turnover: +turnover.toFixed(6),
        score,
        price,
        poolArk: +poolArk.toFixed(2),
        poolUsdt: +poolUsdt.toFixed(2),
        buys: txns.buys, sells: txns.sells,
        ts: Date.now()
      });
    } catch (e) {
      return sendJSON(res, 502, { error: e.message });
    }
  }

  /* ═══ 跨设备绑定码（手机升级 → 电脑使用） ═══ */
  // 生成绑定码（已登录用户）
  if (p === "/api/bind/gen" && req.method === "POST") {
    let b;
    try { b = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
    const addr = (b.addr || "").toLowerCase();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return sendJSON(res, 400, { error: "bad address" });
    // ⭐ 合法地址自动建档（无需先"登录一次"）
    let u = PAY.getUser(addr);
    if (!u) { try { u = PAY.upsertUser(addr, { lastLogin: Date.now() }); } catch(e){ u = PAY.getUser(addr); } }
    if (!u) return sendJSON(res, 404, { error: "user not found", detail: "地址无效" });
    // 已登录用户才能生成（防止滥用）
    // 生成6位码（数字+字母）
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    const rnd = crypto.randomBytes(8);
    for (let i = 0; i < 6; i++) code += chars[rnd[i] % chars.length];
    const binds = loadBinds();
    binds[code] = { addr, created: Date.now(), exp: Date.now() + 30 * 60 * 1000 }; // 30分钟有效
    // 清理过期
    for (const k of Object.keys(binds)) if (binds[k].exp < Date.now()) delete binds[k];
    saveBinds(binds);
    return sendJSON(res, 200, { ok: true, code, expMin: 30, addr: addr.slice(0, 6) + "..." + addr.slice(-4) });
  }

  // 用绑定码登录（电脑端）
  if (p === "/api/bind/use" && req.method === "POST") {
    let b;
    try { b = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
    const code = String(b.code || "").toUpperCase().trim();
    const binds = loadBinds();
    const rec = binds[code];
    if (!rec) return sendJSON(res, 404, { error: "invalid_code", detail: "绑定码无效或已过期" });
    if (rec.exp < Date.now()) { delete binds[code]; saveBinds(binds); return sendJSON(res, 410, { error: "expired" }); }
    const u = PAY.getUser(rec.addr);
    const pro = PAY.isPro(rec.addr);
    // 生成登录令牌（24小时）
    const token = crypto.randomBytes(24).toString("hex");
    const toks = loadTokens();
    toks[token] = { addr: rec.addr, exp: Date.now() + 24 * 3600 * 1000 };
    saveTokens(toks);
    delete binds[code]; saveBinds(binds); // 一次性
    return sendJSON(res, 200, { ok: true, token, addr: rec.addr, plan: pro ? u.plan : "free", pro, until: pro ? u.until : 0 });
  }

  // 用令牌验证（电脑端后续请求）
  if (p === "/api/bind/me") {
    const token = url.searchParams.get("token") || "";
    const toks = loadTokens();
    const rec = toks[token];
    if (!rec || rec.exp < Date.now()) return sendJSON(res, 401, { error: "invalid token" });
    const u = PAY.getUser(rec.addr);
    const pro = PAY.isPro(rec.addr);
    return sendJSON(res, 200, { addr: rec.addr, plan: pro ? u.plan : "free", pro, until: pro ? u.until : 0 });
  }

  /* 测试推送(仅本机调试, 不发真实消息, 只返回将要发送的内容) */
  if (p === "/api/coef-push-test") {
    try {
      const list = loadCoefAlerts();
      const turb = await readTurbineOnChain();
      const a = await getArk().catch(() => ({}));
      const out = [];
      for (const al of list) {
        const th = Number(al.threshold);
        const hit = turb.coefficient >= th;
        const title = 'ARK 涡轮系数 ' + turb.coefficient.toFixed(4) + ' 达标 | 到手 ' + ((0.78*turb.coefficient-0.02)*100).toFixed(2) + '%';
        out.push({
          addr: al.addr,
          threshold: th,
          channel: al.channel,
          coef: turb.coefficient,
          hit: hit,
          action: hit ? 'WILL PUSH' : 'SKIP (未达阈值)',
          title: title,
          msgLen: buildCoefMsg(a, turb.coefficient, th, turb).length
        });
      }
      return sendJSON(res, 200, { coef: turb.coefficient, alerts: out });
    } catch (e) { return sendJSON(res, 502, { error: e.message }); }
  }

  /* 推送文案预览(调试用) */
  if (p === "/api/coef-msg-preview") {
    try {
      const turb = await readTurbineOnChain();
      const a = await getArk().catch(() => ({}));
      const th = Number(url.searchParams.get("th") || "0.45");
      const msg = buildCoefMsg(a, turb.coefficient, th, turb);
      const title = 'ARK 涡轮系数 ' + turb.coefficient.toFixed(4) + ' 达标 | 到手 ' + ((0.78 * turb.coefficient - 0.02) * 100).toFixed(2) + '%';
      return sendJSON(res, 200, { title, msg, coef: turb.coefficient, actualRatePct: +((0.78*turb.coefficient-0.02)*100).toFixed(4) });
    } catch (e) { return sendJSON(res, 502, { error: e.message }); }
  }

  /* 实时综合系数 (链上秒级: 涡轮释放进度 + 底池实时比) */
  if (p === "/api/coef-live") {
    try {
      const turb = await readTurbineOnChain();
      const pool = await readPoolLive();
      if (!turb) return sendJSON(res, 502, { error: "no turbine" });
      const baseCoef = turb.coefficient;
      const minR = turb.min24h, maxR = turb.max24h;
      const span = maxR - minR;
      const pos = span > 0 ? Math.min(1, Math.max(0, (baseCoef - minR) / span)) : 0;
      // 实时综合系数 = 基础系数 + 底池动量微调(让数字真实随交易变动)
      // 底池比变化率映射到 ±span*5% 区间，不改变区间外框
      let momentum = 0;
      if (pool && typeof pool.dRatio === "number" && pool.ratio > 0) {
        momentum = pool.dRatio / pool.ratio;   // 相对变化率
      }
      const adj = Math.max(-1, Math.min(1, momentum * 1000)); // 放大到可感知
      const coef = Math.max(minR, Math.min(maxR, baseCoef + adj * span * 0.05));
      const actualRate = 0.78 * coef - 0.02;
      return sendJSON(res, 200, {
        coefficient: +coef.toFixed(6),
        baseCoef: +baseCoef.toFixed(6),
        momentum: +momentum.toFixed(8),
        momentumAdj: +adj.toFixed(6),
        actualRate: +actualRate.toFixed(6),
        actualRatePct: +(actualRate * 100).toFixed(4),
        formula: "实际到手ARK = ARK奖励 × (0.78 × 涡轮系数 - 0.02)",
        coefficient6: turb.coefficient6,
        min24h: minR,
        max24h: maxR,
        position: +(pos * 100).toFixed(4),
        progress: +(turb.progress || 0).toFixed(6),
        released: +(turb.released || 0).toFixed(4),
        total: turb.total,
        remaining: turb.remaining,
        releasePct: turb.releasePct,
        cycleSec: turb.cycleSec,
        poolRatio: pool ? pool.ratio : null,
        poolUsdt: pool ? pool.poolUsdt : null,
        poolArk: pool ? pool.poolArk : null,
        dRatio: pool ? pool.dRatio : 0,
        dUsdt: pool ? pool.dUsdt : 0,
        dArk: pool ? pool.dArk : 0,
        tickMs: pool ? pool.tickMs : 0,
        price: pool && pool.poolArk > 0 ? +(pool.poolUsdt / pool.poolArk).toFixed(8) : 0,
        source: "chain-live",
        contract: turb.contract,
        pair: ARK_PAIR,
        ts: Date.now()
      });
    } catch (e) {
      return sendJSON(res, 502, { error: e.message });
    }
  }

  /* ═══ 涡轮共识系数 (链上真实读取) ═══ */
  if (p === "/api/turbine") {
    try {
      const t = await readTurbineOnChain();
      if (!t) return sendJSON(res, 502, { error: "no data" });
      return sendJSON(res, 200, { ...t, ts: Date.now() });
    } catch (e) {
      return sendJSON(res, 502, { error: e.message });
    }
  }

  /* ═══ 系数提醒订阅 (PRO) ═══ */
  /* ═══ 通知配置（按地址持久化到服务器，换设备不丢） ═══ */
  if (p === "/api/noti-config" && req.method === "POST") {
    let b;
    try { b = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
    const addr = (b.addr || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) return sendJSON(res, 400, { error: "bad address" });
    const dir = path.join(STATE_DIR, "noticonf");
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    // 读取已有配置，保留 proUntil（首次绑定时写入 PRO 到期时间）
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(path.join(dir, addr + ".json"), "utf8")) || {}; } catch (e) {}
    let proUntil = prev.proUntil || 0;
    // 若用户当前是 PRO，则刷新 proUntil = 当前 PRO 到期时间
    try {
      const u = PAY.getUser(addr);
      if (u && u.plan !== "free" && u.until > Date.now()) proUntil = u.until;
    } catch (e) {}
    const cfg = {
      addr,
      tgToken: String(b.tgToken || ""),
      tgChat: String(b.tgChat || ""),
      wxKey: String(b.wxKey || ""),
      proUntil,                    // ⭐ 绑定时记录的 PRO 到期时间
      updated: Date.now()
    };
    try { fs.writeFileSync(path.join(dir, addr + ".json"), JSON.stringify(cfg, null, 1)); }
    catch (e) { return sendJSON(res, 500, { error: "write fail" }); }
    return sendJSON(res, 200, { ok: true, proUntil });
  }
  if (p === "/api/noti-config" && req.method === "GET") {
    const addr = (url.searchParams.get("addr") || "").toLowerCase();
    const full = url.searchParams.get("full") === "1";
    if (!/^0x[0-9a-f]{40}$/.test(addr)) return sendJSON(res, 400, { error: "bad address" });
    const fp = path.join(STATE_DIR, "noticonf", addr + ".json");
    try {
      const cfg = JSON.parse(fs.readFileSync(fp, "utf8"));
      if (full) {
        // 完整返回（用于同地址换设备恢复）
        let proUntil = cfg.proUntil || 0;
        // 实时同步最新 PRO 到期时间（以会员系统为准）
        try {
          const u = PAY.getUser(addr);
          if (u && u.plan !== "free" && u.until > Date.now()) proUntil = u.until;
        } catch (e) {}
        return sendJSON(res, 200, {
          ok: true,
          tgToken: cfg.tgToken || "",
          tgChat: cfg.tgChat || "",
          wxKey: cfg.wxKey || "",
          hasTg: !!(cfg.tgToken && cfg.tgChat),
          hasWx: !!cfg.wxKey,
          proUntil,                                  // ⭐ 记录/同步的 PRO 到期时间
          proActive: proUntil > Date.now(),          // ⭐ 是否在付费有效期内
          updated: cfg.updated || 0
        });
      }
      // 脱敏
      let proUntil2 = cfg.proUntil || 0;
      try {
        const u = PAY.getUser(addr);
        if (u && u.plan !== "free" && u.until > Date.now()) proUntil2 = u.until;
      } catch (e) {}
      return sendJSON(res, 200, {
        ok: true,
        tgToken: cfg.tgToken ? cfg.tgToken.slice(0, 8) + "..." : "",
        tgChat: cfg.tgChat || "",
        wxKey: cfg.wxKey ? cfg.wxKey.slice(0, 8) + "..." : "",
        hasTg: !!(cfg.tgToken && cfg.tgChat),
        hasWx: !!cfg.wxKey,
        proUntil: proUntil2,
        proActive: proUntil2 > Date.now(),
        updated: cfg.updated || 0
      });
    } catch (e) { return sendJSON(res, 200, { ok: true, hasTg: false, hasWx: false }); }
  }

  if (p === "/api/coef-alert" && req.method === "POST") {
    let b;
    try { b = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
    const { addr, threshold, channel, target } = b || {};
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr || "")) return sendJSON(res, 400, { error: "bad address" });
    // PRO 检查
    if (!PAY.isPro(addr)) return sendJSON(res, 403, { error: "pro_required", detail: "系数提醒为 PRO 功能，请先升级" });
    const th = parseFloat(threshold);
    if (!(th > 0 && th <= 1)) return sendJSON(res, 400, { error: "threshold 0.01-1" });
    const ch = (channel || "telegram").toLowerCase();
    if (!["telegram", "wechat"].includes(ch)) return sendJSON(res, 400, { error: "channel: telegram|wechat" });
    if (!target) return sendJSON(res, 400, { error: "missing target (bot token / sendkey)" });
    // FIX: 最新设定唯一生效 - 同一用户(无论任何通道)的所有旧记录全部移除, 只保留本次保存的一条
    const _allBefore = loadCoefAlerts();
    const _removed = _allBefore.filter(x => x.addr === addr.toLowerCase());
    const _old = _allBefore.filter(x => x.addr !== addr.toLowerCase());
    const id = crypto.randomBytes(6).toString("hex");
    _old.push({
      id,
      addr: addr.toLowerCase(),
      threshold: th,
      channel: ch,
      target: String(target),
      created: Date.now(),
      lastFired: 0,
      _wasAbove: false,
      _nearNotified: false,
      _failCount: 0
    });
    saveCoefAlerts(_old);
    if (_removed.length) {
      console.log('[coef-alert] 用户 ' + addr.toLowerCase() + ' 保存新阈值 ' + th + '，已自动清除 ' + _removed.length + ' 条旧设定');
    }
    return sendJSON(res, 200, { ok: true, id, replaced: _removed.length });
  }

  if (p === "/api/coef-alert" && req.method === "GET") {
    const addr = (url.searchParams.get("addr") || "").toLowerCase();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return sendJSON(res, 400, { error: "bad address" });
    // FIX: 本人查询返回完整 target，供前端回填输入框；
    //      同时保留 targetMasked 供列表展示，避免将截断值写回存储
    const list = loadCoefAlerts().filter(x => x.addr === addr).map(x => ({
      id: x.id,
      addr: x.addr,
      threshold: x.threshold,
      channel: x.channel,
      target: x.target || "",
      targetMasked: x.target ? (String(x.target).slice(0, 8) + "...") : "",
      created: x.created,
      lastFired: x.lastFired || 0,
      _wasAbove: !!x._wasAbove,
      _nearNotified: !!x._nearNotified
    }));
    return sendJSON(res, 200, { alerts: list, isPro: PAY.isPro(addr) });
  }

  if (p === "/api/coef-alert/delete" && req.method === "POST") {
    let b;
    try { b = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
    const { addr, id } = b || {};
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr || "")) return sendJSON(res, 400, { error: "bad address" });
    const list = loadCoefAlerts().filter(x => !(x.addr === addr.toLowerCase() && x.id === id));
    saveCoefAlerts(list);
    return sendJSON(res, 200, { ok: true });
  }

  /* ═══ 汇率 API (USDT → 各国法币) ═══ */
  if (p === "/api/fx") {
    try {
      const r = await fetch("https://open.er-api.com/v6/latest/USD", {
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      const d = await r.json();
      if (d && d.rates) {
        const wanted = ["CNY", "TWD", "HKD", "JPY", "KRW", "EUR", "GBP", "SGD", "MYR", "THB", "VND", "INR", "AUD", "CAD"];
        const rates = { USDT: 1 };
        for (const c of wanted) if (d.rates[c] != null) rates[c] = d.rates[c];
        return sendJSON(res, 200, { base: "USD", rates, source: "er-api", ts: Date.now() });
      }
      return sendJSON(res, 502, { error: "no rates" });
    } catch (e) {
      return sendJSON(res, 502, { error: e.message });
    }
  }

  /* ═══ ARK 实时 K 线 (GeckoTerminal OHLCV) ═══ */
  if (p === "/api/kline") {
    const tf = url.searchParams.get("tf") || "hour";   // minute | hour | day
    const limit = parseInt(url.searchParams.get("limit") || "168", 10);
    try {
      const u = "https://api.geckoterminal.com/api/v2/networks/bsc/pools/0xCAaF3c41a40103a23Eeaa4BbA468AF3cF5b0e0D8/ohlcv/" + tf + "?aggregate=1&limit=" + Math.min(limit, 1000);
      const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } });
      const d = await r.json();
      const list = (d.data && d.data.attributes && d.data.attributes.ohlcv_list) || [];
      // ohlcv_list: [[ts, o, h, l, c, v], ...] 降序→升序
      const candles = list.map(r => ({
        t: r[0], o: parseFloat(r[1]), h: parseFloat(r[2]), l: parseFloat(r[3]), c: parseFloat(r[4]), v: parseFloat(r[5])
      })).reverse();
      return sendJSON(res, 200, { tf, count: candles.length, candles, ts: Date.now() });
    } catch (e) {
      return sendJSON(res, 502, { error: e.message });
    }
  }

  /* ═══ Arkie 聊天 (轻量版, 基于工具站数据) ═══ */
  if (p === "/api/chat" && req.method === "POST") {
    let b;
    try { b = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
    const msg = ((b && b.message) || "").trim();
    if (!msg) return sendJSON(res, 200, { reply: "请说点什么吧 🙂" });
    try {
      const reply = await arkieChat(msg, b.wallet || null, b.history || []);
      return sendJSON(res, 200, { reply, name: "Arkie", ts: Date.now() });
    } catch (e) {
      return sendJSON(res, 200, { reply: "处理出错: " + e.message });
    }
  }

  if (p === "/api/arkie") {
    try { return sendJSON(res, 200, await getArkie()); }
    catch (e) { return sendJSON(res, 502, { error: e.message }); }
  }

  if (p === "/api/stats") {
    try { return sendJSON(res, 200, await getStats()); }
    catch (e) { return sendJSON(res, 200, { trades: readSnaps().length, holders: "-", days: 1 }); }
  }

  if (p === "/api/snapshots") {
    const snaps = readSnaps();
    const range = url.searchParams.get("range") || "all";
    let cut = 0;
    const now = Date.now();
    if (range === "7d") cut = now - 7 * 864e5;
    else if (range === "30d") cut = now - 30 * 864e5;
    return sendJSON(res, 200, { snapshots: snaps.filter(s => s.ts >= cut) });
  }

  if (p === "/api/notify" && req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { ok: false, error: "bad json" }); }
    if (body.addr && !requireVip(res, body.addr)) return;
    const msg = body.message || "ARK Citizen Tools";
    const results = [];
    if (body.tgToken && body.tgChat) results.push(await notifyTelegram(body.tgToken, body.tgChat, msg));
    if (body.wxKey) results.push(await notifyWechat(body.wxKey, msg));
    if (!results.length) return sendJSON(res, 400, { ok: false, error: "no channel configured" });
    const anyOk = results.some(r => r.ok);
    const detail = results.map(r => r.ok ? (r.detail || "ok") : (r.error || "fail")).join(" | ");
    return sendJSON(res, anyOk ? 200 : 502, { ok: anyOk, detail });
  }

  return sendJSON(res, 404, { error: "not found" });
}

function serveStatic(req, res, url) {
  let p;
  try { p = decodeURIComponent(url.pathname); }
  catch (e) { return send(res, 400, "bad request"); }   // ⭐ 畸形 URL 不再崩溃
  if (p === "/" || p === "") p = "/index.html";
  // 🔒 安全：禁止访问敏感目录/文件
  const blocked = /(^|\/)(\.env|\.pk_key|state|node_modules|\.git)(\/|$)/i;
  if (blocked.test(p)) return send(res, 403, "forbidden");
  const fp = path.normalize(path.join(ROOT, p));
  if (!fp.startsWith(ROOT)) return send(res, 403, "forbidden");
  // 🔒 安全：只允许白名单扩展名（防止 src/.json/.md 泄露）
  const ext0 = path.extname(fp).toLowerCase();
  const ALLOWED = [".html", ".js", ".css", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".map", ".mp4", ".webm", ".mov", ".m4a", ".mp3", ".wav", ".ogg", ".pdf", ".zip", ".txt", ".csv", ".json"];
  if (!ALLOWED.includes(ext0)) return send(res, 403, "forbidden");
  // 🔒 安全：禁止直接访问源码类 JS（只允许前端白名单脚本）
  const base0 = path.basename(fp).toLowerCase();
  // 🔒 仅拦截后端源码（前端页面依赖的 JS 必须放行）
  const BLOCKED_JS = ["server.mjs", "pay.mjs", "ads.mjs"];
  if (BLOCKED_JS.includes(base0)) return send(res, 403, "forbidden");
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, "not found");
    const ext = path.extname(fp).toLowerCase();
    // ⭐ HTML 完全禁缓存; JS/CSS 短缓存(60秒)避免手機舊版
    const headers = {
      "Content-Type": MIME[ext] || "application/octet-stream"
    };
    if (ext === ".html") {
      headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0";
      headers["Pragma"] = "no-cache";
      headers["Expires"] = "0";
    } else if (ext === ".js" || ext === ".css") {
      headers["Cache-Control"] = "no-cache, must-revalidate, max-age=0";
    } else {
      headers["Cache-Control"] = "public, max-age=3600";
    }
    // ⭐ HTTP Range 支持（视频/音频拖动进度条必需）
    const range = req.headers["range"];
    if (range && /^bytes=/.test(range)) {
      const parts = range.replace(/bytes=/, "").split("-");
      const total = st.size;
      let start = parseInt(parts[0], 10);
      let end = parts[1] ? parseInt(parts[1], 10) : total - 1;
      if (isNaN(start)) start = 0;
      if (isNaN(end) || end >= total) end = total - 1;
      if (start > end || start >= total) {
        res.writeHead(416, { "Content-Range": `bytes */${total}` });
        return res.end();
      }
      headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
      headers["Accept-Ranges"] = "bytes";
      headers["Content-Length"] = (end - start + 1);
      res.writeHead(206, headers);
      return fs.createReadStream(fp, { start, end }).pipe(res);
    }
    headers["Accept-Ranges"] = "bytes";
    headers["Content-Length"] = st.size;
    res.writeHead(200, headers);
    fs.createReadStream(fp).pipe(res);
  });
}


/* ── 後台頁面（收入 + 廣告審核） ── */
function serveAdmin(res) {
  const html = `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ARK 工具站 · 管理後台</title>
<link rel="stylesheet" href="/style.css">
<style>
body{padding:24px;background:var(--bg)}
.adm-head{display:flex;align-items:center;gap:14px;margin-bottom:20px;flex-wrap:wrap}
.adm-head h1{font-size:20px;font-weight:900;background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.kpi2{background:var(--surface);border:1px solid var(--border);border-radius:13px;padding:15px}
.kpi2 .k{color:var(--text-dim);font-size:12px;margin-bottom:5px}
.kpi2 .v{font-size:21px;font-weight:900;color:var(--cyan)}
.kpi2 .v.gold{color:var(--gold)}
.adm-tabs{display:flex;gap:8px;margin-bottom:18px}
.adm-tabs .btn.active{background:var(--grad);color:#06121f;border-color:transparent}
.adm-panel{display:none}
.adm-panel.on{display:block}
.row-acts{display:flex;gap:6px}
.badge-pending{color:var(--gold)}.badge-active{color:var(--up)}.badge-rej{color:var(--danger)}
</style></head><body>
<div class="adm-head">
  <h1>🛠 ARK 工具站 · 管理後台</h1>
  <input id="admKey" type="password" placeholder="管理密碼" value="ark2026" style="margin-left:auto">
  <button class="btn primary" onclick="loadAll()">刷新</button>
  <a class="btn ghost" href="/">返回前台</a>
</div>

<div class="adm-tabs">
  <button class="btn ghost active" id="tab-rev" onclick="switchTab('rev')">💰 收入</button>
  <button class="btn ghost" id="tab-ads" onclick="switchTab('ads')">📢 廣告審核</button>
  <button class="btn ghost" id="tab-msg" onclick="switchTab('msg')">📩 联系消息 <span id="msgBadge"></span></button>
</div>

<!-- 收入 -->
<div class="adm-panel on" id="panel-rev">
  <div class="kpi-grid" id="revKpi"></div>
  <div class="card"><div class="mut" style="margin-bottom:10px">最近付款</div>
    <div class="scroll-x"><table><thead><tr><th>時間</th><th>地址</th><th>方案</th><th>ARK</th><th>Tx</th></tr></thead>
    <tbody id="revTbody"></tbody></table></div>
  </div>
</div>

<!-- 廣告 -->
<div class="adm-panel" id="panel-msg">
  <div class="card"><div class="mut" style="margin-bottom:10px">用户留言（最新在前）</div>
    <div class="scroll-x"><table><thead><tr><th>时间</th><th>联系方式</th><th>内容</th><th>状态</th><th></th></tr></thead>
    <tbody id="msgTbody"><tr><td colspan="5" class="mut">加载中…</td></tr></tbody></table></div>
  </div>
</div>

<div class="adm-panel" id="panel-ads">
  <div class="kpi-grid" id="adsKpi"></div>
  <div class="card" style="margin-bottom:16px">
    <div class="mut" style="margin-bottom:10px">待審核</div>
    <div class="scroll-x"><table><thead><tr><th>項目</th><th>位置</th><th>時長</th><th>ARK</th><th>連結</th><th>操作</th></tr></thead>
    <tbody id="adsPending"></tbody></table></div>
  </div>
  <div class="card">
    <div class="mut" style="margin-bottom:10px">全部投放</div>
    <div class="scroll-x"><table><thead><tr><th>項目</th><th>位置</th><th>狀態</th><th>曝光</th><th>點擊</th><th>到期</th></tr></thead>
    <tbody id="adsAll"></tbody></table></div>
  </div>
</div>

<script>
function short(s){return s?String(s).slice(0,10)+"..."+String(s).slice(-6):"-"}
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}
function safeUrl(u){u=String(u||"");return /^https?:[/][/]/i.test(u)?u:"#"}
function key(){return document.getElementById("admKey").value}
function switchTab(t){
  ["rev","ads","msg"].forEach(function(k){
    document.getElementById("panel-"+k).classList.toggle("on",k===t);
    document.getElementById("tab-"+k).classList.toggle("active",k===t);
  });
  if(t==="ads")loadAds();
  if(t==="msg")loadMsg();
}
function loadAll(){loadRev();loadAds();loadMsg();}

function loadMsg(){
  fetch("/api/contact/list?key="+encodeURIComponent(key())).then(function(r){return r.json()}).then(function(d){
    var list=(d.messages||[]).slice().reverse();
    var unread=list.filter(function(m){return !m.read}).length;
    var badge=document.getElementById("msgBadge");
    if(badge) badge.textContent = unread>0 ? "("+unread+")" : "";
    var tb=document.getElementById("msgTbody");
    if(!list.length){tb.innerHTML='<tr><td colspan="5" class="mut">暂无留言</td></tr>';return;}
    tb.innerHTML=list.map(function(m){
      var t=new Date(m.created).toLocaleString();
      var st=m.read?'<span class="badge-active">已读</span>':'<span class="badge-pending">未读</span>';
      var body=String(m.body||"").replace(/</g,"&lt;").replace(/\\n/g,"<br>");
      var act=m.read?"":'<button class="btn ghost mini" onclick="markRead(\\''+m.id+'\\')">标为已读</button>';
      return '<tr><td style="white-space:nowrap">'+t+'</td><td>'+String(m.contact||"-").replace(/</g,"&lt;")+'</td><td style="max-width:400px">'+body+'</td><td>'+st+'</td><td>'+act+'</td></tr>';
    }).join("");
  }).catch(function(){document.getElementById("msgTbody").innerHTML='<tr><td colspan="5" class="mut">加载失败</td></tr>';});
}
function markRead(id){
  fetch("/api/contact/read",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:key(),id:id})}).then(function(){loadMsg()});
}
function delAd(id){
  if(!confirm("確定刪除此廣告？此操作不可恢復")) return;
  fetch("/api/admin/ads/delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:key(),adId:id})})
    .then(function(r){return r.json()}).then(function(d){
      if(d.ok){alert("✅ 已刪除");loadAds();}
      else alert("❌ "+(d.error||"失敗"));
    });
}
// 事件委派（避免内联 onclick 引号问题）
document.addEventListener("click", function(e){
  var t = e.target;
  if (t && t.classList && t.classList.contains("del-ad-btn")) {
    var id = t.getAttribute("data-id");
    if (id) delAd(id);
  }
});
function loadRev(){
  fetch("/api/admin/revenue?key="+encodeURIComponent(key())).then(function(r){return r.json()}).then(function(d){
    if(d.error){document.getElementById("revKpi").innerHTML='<p class="dn">'+d.error+'</p>';return;}
    document.getElementById("revKpi").innerHTML=
      '<div class="kpi2"><div class="k">總收入</div><div class="v gold">'+(d.totalArk||0)+' ARK</div></div>'+
      '<div class="kpi2"><div class="k">已付款</div><div class="v">'+d.paidCount+'</div></div>'+
      '<div class="kpi2"><div class="k">待付款</div><div class="v">'+d.pendingCount+'</div></div>'+
      '<div class="kpi2"><div class="k">總用戶</div><div class="v">'+d.users+'</div></div>'+
      '<div class="kpi2"><div class="k">付費用戶</div><div class="v">'+d.proUsers+'</div></div>';
    document.getElementById("revTbody").innerHTML=(d.recent||[]).map(function(x){
      return '<tr><td class="mut">'+new Date(x.ts).toLocaleString()+'</td><td class="mono">'+short(x.addr)+
        '</td><td>'+x.plan+'</td><td class="up">'+x.ark+'</td><td class="mono mut">'+short(x.tx)+'</td></tr>';
    }).join("")||'<tr><td colspan="5" class="mut">尚無付款</td></tr>';
  }).catch(function(e){});
}

function loadAds(){
  fetch("/api/admin/ads?key="+encodeURIComponent(key())).then(function(r){return r.json()}).then(function(d){
    if(d.error){document.getElementById("adsKpi").innerHTML='<p class="dn">'+d.error+'</p>';return;}
    var s=d.stats||{};
    document.getElementById("adsKpi").innerHTML=
      '<div class="kpi2"><div class="k">廣告收入</div><div class="v gold">'+(s.totalArk||0)+' ARK</div></div>'+
      '<div class="kpi2"><div class="k">投放中</div><div class="v">'+s.active+'</div></div>'+
      '<div class="kpi2"><div class="k">待審核</div><div class="v">'+s.pendingReview+'</div></div>'+
      '<div class="kpi2"><div class="k">待付款</div><div class="v">'+s.pendingPay+'</div></div>'+
      '<div class="kpi2"><div class="k">總曝光</div><div class="v">'+s.totalViews+'</div></div>'+
      '<div class="kpi2"><div class="k">總點擊</div><div class="v">'+s.totalClicks+'</div></div>';
    var pend=(d.ads||[]).filter(function(a){return a.status==="pending_review"});
    document.getElementById("adsPending").innerHTML=pend.map(function(a){
      return '<tr><td><b>'+esc(a.title)+'</b><div class="mut">'+esc(a.desc)+'</div></td><td>'+esc(a.slot)+
        '</td><td>'+esc(a.months)+'月</td><td class="up">'+esc(a.ark)+'</td>'+
        '<td><a href="'+safeUrl(a.url)+'" target="_blank" rel="noopener" class="up">連結</a></td>'+
        '<td class="row-acts"><button class="btn primary mini" onclick="review(&quot;'+a.id+'&quot;,true)">通過</button>'+
        '<button class="btn ghost mini" onclick="review(&quot;'+a.id+'&quot;,false)">拒絕</button></td></tr>';
    }).join("")||'<tr><td colspan="6" class="mut">無待審核廣告</td></tr>';

    var stMap={pending_pay:'<span class="badge-pending">待付款</span>',pending_review:'<span class="badge-pending">待審核</span>',active:'<span class="badge-active">投放中</span>',expired:'<span class="mut">已過期</span>',rejected:'<span class="badge-rej">已拒絕</span>'};
    document.getElementById("adsAll").innerHTML=(d.ads||[]).map(function(a){
      return '<tr><td>'+esc(a.title)+'</td><td>'+esc(a.slot)+'</td><td>'+(stMap[a.status]||a.status)+
        '</td><td>'+(a.views||0)+'</td><td>'+(a.clicks||0)+'</td>'+
        '<td class="mut">'+(a.endsAt?new Date(a.endsAt).toLocaleDateString():'-')+'</td>'+
        '<td><button class="btn ghost mini del-ad-btn" data-id="'+esc(a.id)+'" style="color:#f2555f">刪除</button></td></tr>';
    }).join("")||'<tr><td colspan="7" class="mut">尚無投放</td></tr>';
  }).catch(function(e){});
}

function review(id,ok){
  fetch("/api/admin/ads/review",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({key:key(),adId:id,approve:ok})}).then(function(r){return r.json()}).then(function(d){
      if(d.error)alert(d.error); else {alert(ok?"已通過並上架":"已拒絕");loadAds();}
  });
}
loadAll();
setInterval(loadAll,20000);
</script></body></html>`;
 res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache" });;
  res.end(html);
}

function fmtFull(n, dec) {
  n = Number(n) || 0;
  if (dec == null) dec = Math.abs(n) >= 1000 ? 0 : 2;
  return n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

/* ═══ Arkie 轻量问答（基于工具站链上数据） ═══ */
async function arkieChat(msg, wallet) {
  const m = msg.toLowerCase();
  if (/^(你好|hi|hello|嗨|hey|在吗)/.test(m)) {
    return '你好！我是 Arkie，ARK 生态助手。\n可以问我：\n• ARK价格 / ARK池 / 质押计算\n• 我的持仓（需地址）/ 鲸鱼\n• ARK 涨到 10 提醒我\n输入“帮助”看全部。';
  }
  if (msg.includes("帮助") || m.includes("help") || msg.includes("能做什么")) {
    return '📖 Arkie 能力：\n\n🪙 “ARK价格” — 实时行情\n💧 “ARK池” — 流动性\n💹 “质押 1000 360天” — 收益\n👛 “我的持仓 0x...” — 链上余额\n🐋 “鲸鱼” — 大额转账\n🔔 “ARK 涨到 10 提醒我”\n📈 “技术指标” — RSI/MA';
  }
  if (m.includes("价格") || m.includes("price") || m.includes("行情")) {
    if (m.includes("arkie")) {
      const k = await getArkie().catch(() => null);
      const a = await getArk().catch(() => null);
      if (k) return '🪙 ARKIE 价格：$' + k.priceUsd + '\nARK 计价：' + (a ? (k.priceUsd / a.priceUsd).toFixed(4) : '?') + ' ARK';
    }
    const a = await getArk().catch(() => null);
    if (a) return '🪙 ARK 价格：$' + a.priceUsd + '\n24h：' + ((a.priceChange && a.priceChange.h24) || 0).toFixed(2) + '%\n市值：$' + fmtFull(a.marketCap || 0) + '\n流动性：$' + fmtFull(a.liquidityUsd || 0);
  }
  if (m.includes("池") || m.includes("流动性")) {
    const a = await getArk().catch(() => null);
    if (a) return '💧 ARK 流动性池\n底池USD：$' + fmtFull(a.liquidityUsd || 0) + '\n底池ARK：' + fmtFull(a.liquidityBase || 0) + '\n24h成交：$' + fmtFull((a.volume && a.volume.h24) || 0);
  }
  if (msg.includes("质押") || m.includes("stake")) {
    const amtM = msg.match(/([0-9][0-9,]*)/);
    const amt = amtM ? parseFloat(amtM[1].replace(/,/g, '')) : 0;
    const dayM = msg.match(/([0-9]+)\s*天/);
    const day = dayM ? parseInt(dayM[1], 10) : 360;
    if (amt <= 0) return '💹 用法：“质押 1000 360天”（360天方案日收益 0.28%）';
    const rate = 0.0028;
    const earned = amt * (Math.pow(1 + rate, day) - 1);
    return '💹 质押 ' + amt.toLocaleString() + ' ARK · ' + day + ' 天\n到期可得：' + (amt + earned).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' ARK\n净增：+' + earned.toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' ARK';
  }
  if (msg.includes("鲸鱼") || m.includes("whale")) {
    try {
      const blk = await fetch("https://bsc-rpc.publicnode.com", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) }).then(r => r.json());
      const latest = parseInt(blk.result, 16);
      const logs = await fetch("https://bsc-rpc.publicnode.com", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ fromBlock: "0x" + (latest - 30).toString(16), toBlock: "latest", address: CHAIN.ark, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"] }] }) }).then(r => r.json());
      const arr = (logs.result || []).map(lg => ({ amt: Number(BigInt(lg.data)) / 1e18, from: "0x" + lg.topics[1].slice(26), to: "0x" + lg.topics[2].slice(26) })).filter(x => x.amt >= 10000).sort((a, b) => b.amt - a.amt);
      if (!arr.length) return '🐋 最近约30区块内无 >1万 ARK 大额转账。';
      let t = '🐋 最近大额：\n';
      for (const w of arr.slice(0, 6)) t += '• ' + w.amt.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' ARK  ' + w.from.slice(0, 8) + '…→' + w.to.slice(0, 8) + '…\n';
      return t;
    } catch (e) { return '查询失败: ' + e.message; }
  }
  const addrM = msg.match(/0x[0-9a-fA-F]{40}/);
  if (addrM || msg.includes("持仓") || msg.includes("余额")) {
    const addr = addrM ? addrM[0] : (wallet || null);
    if (!addr) return '👛 请提供地址，如：“我的持仓 0xB5E1...”';
    try {
      const A = addr.toLowerCase().slice(2).padStart(64, "0");
      const call = async (to) => {
        const r = await fetch("https://bsc-rpc.publicnode.com", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data: "0x70a08231" + A }, "latest"] }) }).then(r => r.json());
        return r.result && r.result !== "0x" ? BigInt(r.result) : 0n;
      };
      const [ark, arkie, gark] = await Promise.all([call(CHAIN.ark), call(CHAIN.arkie), call(CHAIN.gark)]);
      const f = v => (Number(v) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 4 });
      return '👛 持仓 (' + addr.slice(0, 6) + '...' + addr.slice(-4) + ')\n\nARK：' + f(ark) + '\nARKIE：' + f(arkie) + '\ngARK：' + f(gark);
    } catch (e) { return '查询失败: ' + e.message; }
  }
  if (msg.includes("订阅") || msg.includes("提醒")) {
    const above = msg.match(/(?:涨到|涨破|高于|突破|above)\s*([\d.]+)/i);
    const below = msg.match(/(?:跌到|跌破|低于|below)\s*([\d.]+)/i);
    if (above || below) {
      const kind = above ? 'above' : 'below';
      const target = parseFloat((above || below)[1]);
      const al = loadAlerts();
      al.push({ id: crypto.randomBytes(6).toString("hex"), addr: (wallet || "guest").toLowerCase(), kind, target, created: Date.now(), triggered: false });
      saveAlerts(al);
      return '✅ 已订阅：ARK ' + (kind === 'above' ? '涨到 ≥ $' : '跌到 ≤ $') + target;
    }
    return '🔔 用法：“ARK 涨到 10 提醒我”';
  }
  if (msg.includes("指标") || msg.includes("rsi") || msg.includes("均线") || msg.includes("布林")) {
    try {
      const gt = await fetch("https://api.geckoterminal.com/api/v2/networks/bsc/pools/0xCAaF3c41a40103a23Eeaa4BbA468AF3cF5b0e0D8/ohlcv/hour?aggregate=1&limit=100").then(r => r.json());
      const list = (gt.data && gt.data.attributes && gt.data.attributes.ohlcv_list) || [];
      if (list.length < 30) return '⚠️ K线数据不足。';
      const closes = list.map(r => parseFloat(r[4])).reverse();
      const n = closes.length, price = closes[n - 1];
      let g = 0, l = 0;
      for (let i = n - 14; i < n; i++) { const c = closes[i] - closes[i - 1]; if (c >= 0) g += c; else l -= c; }
      const rsi = l === 0 ? 100 : 100 - 100 / (1 + g / l);
      const ma = k => closes.slice(-k).reduce((a, b) => a + b, 0) / k;
      return '📈 ARK 技术指标（1h）\n现价：$' + price.toFixed(4) + '\nRSI(14)：' + rsi.toFixed(1) + '\nMA7：' + ma(7).toFixed(4) + ' | MA25：' + ma(25).toFixed(4) + '\n' + (rsi > 70 ? '⚠️ 超买' : rsi < 30 ? '💡 超卖' : '中性');
    } catch (e) { return '查询失败: ' + e.message; }
  }
  // 默认 → LLM 智能回答
  try {
    const llm = await arkieLLM(msg, (arguments[2] || []));
    if (llm) return llm;
  } catch (e) {}
  return '我是 Arkie 🪙\n可以问我：\n• ARK价格 / ARK池 / 技术指标\n• 质押 1000 360天\n• 我的持仓 0x...\n• 鲸鱼 / 订阅提醒\n输入“帮助”看全部。';
}

/* ═══ Arkie LLM 兜底（关键词未命中时用大模型智能回答） ═══ */
// 从多个位置读取 OpenRouter key
let OR_KEY = process.env.OPENROUTER_API_KEY || "";
if (!OR_KEY) {
  try {
    const envPaths = [path.join(ROOT, ".env"), "/app/workspace/ai-quant-agent/.env"];
    for (const ep of envPaths) {
      if (fs.existsSync(ep)) {
        const m = fs.readFileSync(ep, "utf8").match(/OPENROUTER_API_KEY=(\S+)/);
        if (m) { OR_KEY = m[1]; break; }
      }
    }
  } catch (e) {}
}
const OR_MODELS = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "google/gemma-4-31b-it:free"
];

async function arkieLLM(msg, history) {
  if (!OR_KEY || OR_KEY.length < 20) return null;
  const sys = '你是 Arkie，ARK 生态助手（MasterD 的儿子）。简洁专业，中文回答，200字内。\n' +
    '【ARK】指 BSC 上的 BEP-20 代币，合约 0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D，' +
    'PancakeSwap V2 交易对 0xCAaF3c41a40103a23Eeaa4BbA468AF3cF5b0e0D8，' +
    '生态含 ARKIE 子币与 gARK 治理币，有质押复利机制。ARK 合法，有推广制度但不涉及传销，全球合法。' +
    '不要把 ARK 与其他同名项目混淆。';
  const msgs = [{ role: "system", content: sys }];
  if (Array.isArray(history)) {
    for (const h of history.slice(-6)) {
      if (h.role && h.content) msgs.push({ role: h.role === 'user' ? 'user' : 'assistant', content: String(h.content).slice(0, 500) });
    }
  }
  msgs.push({ role: "user", content: msg });
  for (const model of OR_MODELS) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + OR_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: msgs, max_tokens: 400, temperature: 0.6 })
      });
      const d = await r.json();
      const txt = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
      if (txt && txt.length > 3) return txt.trim();
    } catch (e) { continue; }
  }
  return null;
}


/* ═══ 广告位展示的系统（管理员配置） ═══ */
const SYSTEMS_FILE = path.join(STATE_DIR, "systems.json");
function loadSystems() {
  try {
    const v = JSON.parse(fs.readFileSync(SYSTEMS_FILE, "utf8"));
    if (Array.isArray(v) && v.length) return v;
  } catch (e) {}
  // 默认：ARK 生态系统（聊天固定为大卡，此处只列其余系统）
  return [
    { id: "quant", name: "量化机器人", desc: "币安 10 分钟永续 · AI 选币 + 指标确认", url: "", icon: "🤖", badge: "SOON", free: false },
    { id: "poly5", name: "Poly5 预测", desc: "BTC 5 分钟事件合约预测系统", url: "", icon: "📈", badge: "SOON", free: false },
  ];
}
function saveSystems(v) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(SYSTEMS_FILE, JSON.stringify(v, null, 1)); } catch (e) {}
}

/* ═══ 跨设备绑定码存储 ═══ */
const BINDS_FILE = path.join(STATE_DIR, "binds.json");
const TOKENS_FILE = path.join(STATE_DIR, "tokens.json");
function loadBinds() { try { return JSON.parse(fs.readFileSync(BINDS_FILE, "utf8")) || {}; } catch (e) { return {}; } }
function saveBinds(v) { try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(BINDS_FILE, JSON.stringify(v)); } catch (e) {} }
function loadTokens() { try { return JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8")) || {}; } catch (e) { return {}; } }
function saveTokens(v) { try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(TOKENS_FILE, JSON.stringify(v)); } catch (e) {} }

/* ═══ 系数提醒存储 ═══ */
const COEF_FILE = path.join(STATE_DIR, "coef-alerts.json");
function loadCoefAlerts() {
  try { return JSON.parse(fs.readFileSync(COEF_FILE, "utf8")) || []; } catch (e) { return []; }
}
function saveCoefAlerts(a) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(COEF_FILE, JSON.stringify(a, null, 1)); } catch (e) {}
}

/* ═══ 联系表单存储 ═══ */
const CONTACTS_FILE = path.join(STATE_DIR, "contacts.json");
function loadContacts() {
  try { return JSON.parse(fs.readFileSync(CONTACTS_FILE, "utf8")) || []; } catch (e) { return []; }
}
function saveContacts(a) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify(a, null, 1));
  } catch (e) {}
}

/* ═══ 收益看板 / 預警 輔助 ═══ */
const ALERTS_FILE = path.join(STATE_DIR, "alerts.json");
function loadAlerts() {
  try { return JSON.parse(fs.readFileSync(ALERTS_FILE, "utf8")) || []; }
  catch (e) { return []; }
}
function saveAlerts(a) {
  try { fs.writeFileSync(ALERTS_FILE, JSON.stringify(a, null, 1)); } catch (e) {}
}

// 鎖倉方案 → 日收益率(小數)。與前端方案保持一致(參考值)
const PLAN_DAILY = {
  flex: 0.0,
  "180": 0.0022,
  "360": 0.0028,
  "540": 0.0033,
  "720": 0.0038,
  long: 0.0042,
  max: 0.0045
};
function dailyRateForPlan(plan) {
  return PLAN_DAILY[String(plan)] != null ? PLAN_DAILY[String(plan)] : PLAN_DAILY["360"];
}

// 預警輪詢: 每分鐘檢查未觸發的預警
async function alertTick() {
  try {
    const al = loadAlerts();
    if (!al.length) return;
    const ark = await getArk().catch(() => null);
    const price = ark && ark.priceUsd ? ark.priceUsd : null;
    if (!price) return;
    let dirty = false;
    for (const a of al) {
      if (a.triggered) continue;
      let hit = false;
      if (a.kind === "above" && price >= a.target) hit = true;
      if (a.kind === "below" && price <= a.target) hit = true;
      if (hit) {
        a.triggered = true; a.triggeredAt = Date.now(); a.triggeredPrice = price;
        dirty = true;
        // 嘗試推播(若用戶已設 notify 通道)
        try { await notifyAlert(a, price); } catch (e) {}
      }
    }
    if (dirty) saveAlerts(al);
  } catch (e) {}
}

async function notifyAlert(a, price) {
  const msg = `ARK 價格預警: 目前 $${price.toFixed(4)} (條件: ${a.kind} ${a.target})`;
  try {
    const u = PAY.getUser ? PAY.getUser(a.addr) : null;
    const tg = u && (u.telegram || u.tgChatId);
    const tk = u && u.tgToken;
    if (tg && tk) await notifyTelegram(tk, tg, msg);
  } catch (e) {}
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    return send(res, 204, "", "text/plain");
  }

  if (url.pathname.startsWith("/api/")) {
    try {
      return await handleAPI(req, res, url);
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  // 後台頁面（不走靜態）
  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    return serveAdmin(res);
  }

  try { serveStatic(req, res, url); }
  catch (e) { try { send(res, 500, "error"); } catch (e2) {} }
});

ensureState();
/* ═══ WebSocket upgrade 统一分发 (noServer 模式, 避免共用 server 冲突) ═══ */
server.on("upgrade", (req, socket, head) => {
  let pathname = "";
  try { pathname = new URL(req.url || "/", "http://localhost").pathname; } catch (e) {}
  let target = null;
  if (pathname === "/coef/ws") target = _coefWss;
  else if (pathname === "/arkchat/ws") target = _wss;
  if (!target) {
    try { socket.destroy(); } catch (e) {}
    return;
  }
  target.handleUpgrade(req, socket, head, (ws) => {
    target.emit("connection", ws, req);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[ARK Citizen Tools] listening on :${PORT}`);
  console.log(`  chain: ${CHAIN.pair}`);
  console.log(`  state: ${STATE_DIR}`);
});

setInterval(snapshotTick, 5 * 60 * 1000);
setInterval(() => { try { ADS.expireAds(); PAY.expireInvoices(); } catch (e) {} }, 10 * 60 * 1000);
setInterval(() => { alertTick(); }, 60 * 1000);
setInterval(() => { coefTick(); }, 30 * 1000);

/* ═══ 链上实时底池读取（秒级刷新，真正的实时数据） ═══ */
const ARK_PAIR = "0xCAaF3c41a40103a23Eeaa4BbA468AF3cF5b0e0D8";
const _RPC = "https://bsc-dataseed.bnbchain.org";
let _poolCache = { at: 0, data: null, prev: null };
async function readPoolLive() {
  const now = Date.now();
  if (_poolCache.data && now - _poolCache.at < 3000) return _poolCache.data;
  try {
    const r = await fetch(_RPC, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: ARK_PAIR, data: "0x0902f1ac" }, "latest"] })
    });
    const j = await r.json();
    if (!j.result || j.result.length < 130) return _poolCache.data;
    const b = j.result.slice(2);
    const r0 = BigInt("0x" + b.slice(0, 64));
    const r1 = BigInt("0x" + b.slice(64, 128));
    const D = Math.pow(10, 18);
    const poolUsdt = Number(r0) / D;
    const poolArk = Number(r1) / D;
    const ratio = poolArk > 0 ? poolUsdt / poolArk : 0;
    const prev = _poolCache.data;
    let dRatio = 0, dUsdt = 0, dArk = 0, tick = 0;
    if (prev) {
      dRatio = ratio - prev.ratio;
      dUsdt = poolUsdt - prev.poolUsdt;
      dArk = poolArk - prev.poolArk;
      tick = now - _poolCache.at;
    }
    const data = {
      poolUsdt: +poolUsdt.toFixed(2),
      poolArk: +poolArk.toFixed(2),
      ratio: +ratio.toFixed(6),
      dRatio: +dRatio.toFixed(6),
      dUsdt: +dUsdt.toFixed(2),
      dArk: +dArk.toFixed(4),
      tickMs: tick,
      ts: now
    };
    _poolCache = { at: now, data, prev };
    return data;
  } catch (e) { return _poolCache.data; }
}

/* ═══ 链上涡轮系数读取（唯一数据源，确定性，无随机） ═══ */
const TURBINE_CONTRACT = "0x8366a748E02F730911Cb5AB4fd049d2E1e0414b7";
const TURBINE_SEL = "0xc3f909d4"; // getConfig()
let _turbCache = { at: 0, data: null };
async function readTurbineOnChain(force) {
  const now = Date.now();
  if (!force && _turbCache.data && now - _turbCache.at < 3000) return _turbCache.data;
  const r = await fetch("https://bsc-dataseed.bnbchain.org", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: TURBINE_CONTRACT, data: TURBINE_SEL }, "latest"] })
  });
  const j = await r.json();
  const hex = (j.result || "").slice(2);
  if (hex.length < 384) return null;
  const slots = [];
  for (let i = 0; i < hex.length; i += 64) slots.push(BigInt("0x" + hex.slice(i, i + 64)));
  const toN = (v, dec) => Number(v) / Math.pow(10, dec || 0);
  const minRatio = toN(slots[4], 4);
  const maxRatio = toN(slots[5], 4);
  const total = toN(slots[3], 18);
  const released = toN(slots[2], 18);
  const cycle = Number(slots[0]);
  const prog = total > 0 ? Math.min(1, Math.max(0, released / total)) : 0;
  // 涡轮系数：按链上释放进度在 [min,max] 区间映射
  const cur = minRatio + prog * (maxRatio - minRatio);
  // 官方公式：实际到手ARK比例 = 0.78 × 涡轮系数 - 0.02
  // 0.78 = 80% × 97.5%  (扣20%买贡献值后, 剩余80%再扣2.5%手续费)
  const actualRate = 0.78 * cur - 0.02;
  const data = {
    coefficient: cur,
    coefficient6: +cur.toFixed(6),
    actualRate: +actualRate.toFixed(6),
    actualRatePct: +(actualRate * 100).toFixed(4),
    formula: "实际到手ARK = ARK奖励 × (0.78 × 涡轮系数 - 0.02)",
    min24h: +minRatio.toFixed(4),
    max24h: +maxRatio.toFixed(4),
    progress: prog * 100,
    total, released,
    releasedRaw: released,
    remaining: +(total - released).toFixed(4),
    releasePct: total ? +((released / total) * 100).toFixed(6) : 0,
    cycleSec: cycle,
    contract: TURBINE_CONTRACT,
    source: "chain"
  };
  _turbCache = { at: now, data };
  return data;
}

/* ═══ 系数提醒轮询（每2分钟）═══ */
async function coefTick() {
  try {
    const list = loadCoefAlerts();
    if (!list.length) return;
    const a = await getArk().catch(() => null);
    if (!a) return;
    const poolArk = a.liquidityBase || 0;
    const poolUsdt = a.liquidityQuote || 0;
    const vol = (a.volume && a.volume.h24) || 0;
    const txns = a.txns && a.txns.h24 ? a.txns.h24 : { buys: 0, sells: 0 };
    // 系数唯一来源: 链上涡轮合约 (与 /api/turbine、仪表盘完全一致)
    const turb = await readTurbineOnChain();
    if (!turb || !(turb.coefficient > 0)) return;
    // 用实时综合系数(含底池动量)作为推送判定值，与仪表盘同源
    const pool = await readPoolLive();
    let momentum = 0;
    if (pool && typeof pool.dRatio === "number" && pool.ratio > 0) momentum = pool.dRatio / pool.ratio;
    const _span = turb.max24h - turb.min24h;
    const _adj = Math.max(-1, Math.min(1, momentum * 1000));
    const coef = Math.max(turb.min24h, Math.min(turb.max24h, turb.coefficient + _adj * _span * 0.05));
    const minRatio = turb.min24h, maxRatio = turb.max24h;
    // FIX: 广播真实系数给所有在线页面 (B方案: 页面内语音)
    try {
      const _p = JSON.stringify({ type: 'coef', coefficient: coef, min24h: minRatio, max24h: maxRatio, released: turb.released, total: turb.total, progress: turb.progress, cycleSec: turb.cycleSec, source: 'chain-live', contract: '0x8366a748E02F730911Cb5AB4fd049d2E1e0414b7', price: a.priceUsd, ts: Date.now() });
      if (_coefWss) _coefWss.clients.forEach(ws => { try { if (ws.readyState === 1) ws.send(_p); } catch (e) {} });
    } catch (e) {}
    let dirty = false;
    for (const al of list) {
      const th = Number(al.threshold);
      if (!isFinite(th) || th <= 0) continue;
      // 严格阈值判定: 未达阈值绝不推送
      if (coef < th) {
        // 记录"当前未达标", 以便下次达标时立即触发(边沿触发)
        if (al._wasAbove) { al._wasAbove = false; dirty = true; }
        // 近阈值预警: 当前系数达到阈值 99.5% 以上但尚未达标 → 定向推送语音事件(不发微信, 避免打扰)
        try {
          var _pct = th > 0 ? (coef / th) * 100 : 0;
          if (_pct >= 99.5 && !al._nearNotified) {
            al._nearNotified = true; dirty = true;
            var _nv = JSON.stringify({ type: 'coef_near', addr: al.addr, coefficient: coef, threshold: th, percent: _pct, text: '注意，ARK 涡轮系数已达 ' + Number(coef).toFixed(6) + '，非常接近你的阈值 ' + Number(th).toFixed(6) + '，马上要达标了', ts: Date.now() });
            if (_coefWss) _coefWss.clients.forEach(ws => { try { if (ws.readyState === 1 && ws.addr && ws.addr === String(al.addr).toLowerCase()) ws.send(_nv); } catch (e) {} });
            console.log('[coefTick] near-threshold', al.addr, _pct.toFixed(2) + '%');
          }
          if (_pct < 99.5 && al._nearNotified) { al._nearNotified = false; dirty = true; }
        } catch (e) {}
        continue;
      }
      // 无冷却: 只要本次达标且上次不是达标状态(或从未推送过) → 立即推送
      // 这样同一段达标期内不会每30秒重复刷屏, 但每次重新达标都单独提醒
      if (al._wasAbove && al.lastFired) continue;
      const _actualPct = ((0.78 * coef - 0.02) * 100).toFixed(2);
      const msg = buildCoefMsg(a, coef, th, turb);
      const msgTitle = '🚀 ARK 涡轮系数达标 | ' + coef.toFixed(4) + ' ≥ ' + th.toFixed(4) + ' | 到手 ' + _actualPct + '%';
      let sent = false;
      try {
        if (al.channel === 'telegram') {
          const [tok, chat] = String(al.target).split('|');
          await notifyTelegram(tok, chat, msg);
          sent = true;
        } else if (al.channel === 'wechat') {
          await notifyWechat(al.target, msg, msgTitle);
          sent = true;
        }
      } catch (e) {
        console.log('[coefTick] notify fail', al.addr, e && e.message);
      }
      // 只有推送成功才记录 lastFired，失败则下轮重试
      if (sent) {
        al.lastFired = Date.now(); al._wasAbove = true;
        al._failCount = 0; al._lastError = '';
        dirty = true;
        console.log('[coefTick] pushed OK', al.addr, 'coef=' + coef.toFixed(6), 'th=' + th.toFixed(6));
      } else {
        al._failCount = (al._failCount || 0) + 1;
        dirty = true;
        console.log('[coefTick] push FAIL #' + al._failCount, al.addr, 'coef=' + coef.toFixed(6), 'th=' + th.toFixed(6));
      }
      // FIX: 定向推送语音事件给该地址的在线页面
      try {
        const _v = JSON.stringify({ type: 'coef_alert', addr: al.addr, coefficient: coef, threshold: al.threshold, price: a.priceUsd, text: '注意，ARK 涡轮系数已达 ' + coef.toFixed(4) + '，超过阈值 ' + Number(al.threshold).toFixed(4), ts: Date.now() });
        if (_coefWss) _coefWss.clients.forEach(ws => { try { if (ws.readyState === 1 && ws.addr && ws.addr === String(al.addr).toLowerCase()) ws.send(_v); } catch (e) {} });
      } catch (e) {}
    }
    if (dirty) saveCoefAlerts(list);
  } catch (e) {}
}
setTimeout(snapshotTick, 3000);

/* ═══ ARK Chat WebSocket ═══ */
const _chatClients = new Map();  // addr → Set<ws>
function _chatBroadcast(addr, obj) {
  const set = _chatClients.get(addr);
  if (!set) return;
  const s = JSON.stringify(obj);
  for (const ws of set) { try { if (ws.readyState === 1) ws.send(s); } catch(e){} }
}
/* ═══ 系数实时 WebSocket (页面内语音提醒 B 方案) ═══ */
const _coefWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
_coefWss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.addr = "";   // 该连接对应的用户地址(用于语音定向推送)
  try {
    const u = new URL(req.url || "/", "http://localhost");
    const a = (u.searchParams.get("addr") || "").toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(a)) ws.addr = a;
  } catch (e) {}
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("error", () => {});
  // 允许页面登录后再声明地址
  ws.on("message", (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m && m.type === "auth" && /^0x[0-9a-fA-F]{40}$/.test(m.addr || "")) {
        ws.addr = m.addr.toLowerCase();
        try { ws.send(JSON.stringify({ type: "auth_ok", addr: ws.addr })); } catch (e) {}
      }
    } catch (e) {}
  });
  try { ws.send(JSON.stringify({ type: "coef_ws_ready", ts: Date.now(), addr: ws.addr })); } catch (e) {}
});
setInterval(() => {
  _coefWss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 30000);

const _wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
_wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === "auth" && /^0x[0-9a-fA-F]{40}$/.test(m.addr || "")) {
        ws.addr = m.addr.toLowerCase();
        CHAT.ensureUser(ws.addr);
        if (!_chatClients.has(ws.addr)) _chatClients.set(ws.addr, new Set());
        _chatClients.get(ws.addr).add(ws);
        try { CHAT.setProfile(ws.addr, {}); } catch(e){}
        try { CHAT.setOnline(ws.addr, true); } catch(e){}
        ws.send(JSON.stringify({ type: "auth_ok", addr: ws.addr }));
      }
      if (m.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      /* ═══ 音视频通话信令转发（WebRTC）═══ */
      if ((m.type === "call" || m.type === "answer" || m.type === "ice" || m.type === "hangup" || m.type === "reject" || m.type === "call_busy") && ws.addr) {
        const to = String(m.to || "").toLowerCase();
        if (/^0x[0-9a-fA-F]{40}$/.test(to)) {
          _chatBroadcast(to, Object.assign({}, m, { from: ws.addr }));
        }
        return;
      }
      /* ═══ 群聊通话信令（按 gid 广播给群成员）═══ */
      if ((m.type === "gcall" || m.type === "goffer" || m.type === "ganswer" || m.type === "gice" || m.type === "ghangup") && ws.addr) {
        const gid = String(m.gid || "");
        try {
          const g = CHAT.listGroups(ws.addr).find(x => x.gid === gid);
          (g ? g.members : []).forEach(mem => { if (mem !== ws.addr) _chatBroadcast(mem, Object.assign({}, m, { from: ws.addr })); });
        } catch(e){}
        return;
      }
    } catch(e){}
  });
  ws.on("close", () => {
    if (ws.addr && _chatClients.has(ws.addr)) {
      _chatClients.get(ws.addr).delete(ws);
      if (!_chatClients.get(ws.addr).size) { _chatClients.delete(ws.addr); try { CHAT.setOnline(ws.addr, false); } catch(e){} }
    }
  });
});
setInterval(() => {
  _wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false; try { ws.ping(); } catch(e){}
  });
}, 30000);
console.log("[ARK Chat] WebSocket 挂载: /arkchat/ws");

