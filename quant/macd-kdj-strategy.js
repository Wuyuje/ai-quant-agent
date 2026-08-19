// ═══════════════════════════════════════════════════════════
// macd-kdj-strategy.js — MACD金叉/死叉 + KDJ交叉 双向策略
// 周期: 5m 看盘
//
// 规则(用户定义):
//   开多: MACD金叉 (DIF上穿DEA)
//   平多: KDJ死叉 (J线下穿K线 且 下穿D线)
//   开空: MACD死叉 (DIF下穿DEA)
//   平空: KDJ金叉 (J线上穿K线 且 上穿D线)
//
// MACD(12,26,9): DIF=EMA12-EMA26, DEA=DIF的9EMA
// KDJ(9,3,3): RSV=(C-L9)/(H9-L9)*100, K=EMA(RSV,3), D=EMA(K,3), J=3K-2D
// ═══════════════════════════════════════════════════════════

function toArray(a) {
  if (Array.isArray(a)) {
    const first = a[0];
    if (first && !Array.isArray(first)) return a;
    return a.map(r => ({ open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: r[5] }));
  }
  return a || [];
}

class MacdKdjStrategy {
  constructor(opts = {}) {
    this.period = opts.period || '5m';   // 看盘周期
    // MACD
    this.fast = opts.fast || 12;
    this.slow = opts.slow || 26;
    this.signal = opts.signal || 9;
    // KDJ
    this.rsvN = opts.rsvN || 9;
    this.kN = opts.kN || 3;
    this.dN = opts.dN || 3;
    this.minBars = opts.minBars || 40;
  }

  _emaSeries(v, n) {
    const out = new Array(v.length).fill(null);
    if (v.length < n) return out;
    const k = 2 / (n + 1);
    let e = v[0]; out[0] = e;
    for (let i = 1; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
    return out;
  }

  // MACD: 返回 {dif:[], dea:[], hist:[]}
  macd(closes) {
    const n = closes.length;
    const eFast = this._emaSeries(closes, this.fast);
    const eSlow = this._emaSeries(closes, this.slow);
    const dif = new Array(n).fill(null);
    for (let i = Math.max(this.fast, this.slow) - 1; i < n; i++) {
      if (eFast[i] != null && eSlow[i] != null) dif[i] = eFast[i] - eSlow[i];
    }
    // DEA = DIF 的 signal EMA
    const start = dif.findIndex(v => v != null);
    const dea = new Array(n).fill(null);
    if (start >= 0) {
      const k = 2 / (this.signal + 1);
      let e = dif[start]; dea[start] = e;
      for (let i = start + 1; i < n; i++) {
        if (dif[i] == null) continue;
        e = dif[i] * k + e * (1 - k); dea[i] = e;
      }
    }
    return { dif, dea };
  }

  // KDJ: 返回 {k:[], d:[], j:[]}
  kdj(klines) {
    const n = klines.length;
    const K = new Array(n).fill(null), D = new Array(n).fill(null), J = new Array(n).fill(null);
    const kPer = 1 / this.kN, dPer = 1 / this.dN;
    let prevK = 50, prevD = 50;
    for (let i = this.rsvN - 1; i < n; i++) {
      let ll = Infinity, hh = -Infinity;
      for (let t = i - this.rsvN + 1; t <= i; t++) {
        ll = Math.min(ll, +klines[t].low);
        hh = Math.max(hh, +klines[t].high);
      }
      const c = +klines[i].close;
      const rsv = (hh !== ll) ? ((c - ll) / (hh - ll)) * 100 : 50;
      const kNow = kPer * rsv + (1 - kPer) * prevK;
      const dNow = dPer * kNow + (1 - dPer) * prevD;
      K[i] = kNow; D[i] = dNow; J[i] = 3 * kNow - 2 * dNow;
      prevK = kNow; prevD = dNow;
    }
    return { k: K, d: D, j: J };
  }

  /**
   * 判断当前bar信号。返回动作串:
   *   'OPEN_LONG'  开多 (MACD金叉)
   *   'OPEN_SHORT' 开空 (MACD死叉)
   *   'CLOSE_LONG' 平多 (KDJ死叉: J下穿K且D)
   *   'CLOSE_SHORT'平空 (KDJ金叉: J上穿K且D)
   *   'NONE' 无
   */
  signal(klines) {
    const arr = toArray(klines);
    const closes = arr.map(k => +k.close);
    if (closes.length < this.minBars) return { action: 'NONE', reason: '数据不足' };
    const { dif, dea } = this.macd(closes);
    const { k, d, j } = this.kdj(arr);
    const i = arr.length - 1;

    // MACD金叉/死叉 (当前bar与昨bar)
    let macdAct = 'NONE';
    if (i >= 1 && dif[i] != null && dif[i-1] != null && dea[i] != null && dea[i-1] != null) {
      if (dif[i-1] <= dea[i-1] && dif[i] > dea[i]) macdAct = 'GOLD';    // 金叉
      if (dif[i-1] >= dea[i-1] && dif[i] < dea[i]) macdAct = 'DEAD';    // 死叉
    }
    // KDJ交叉 (当前bar与前bar)
    let kdjAct = 'NONE';
    if (i >= 1 && j[i] != null && j[i-1] != null && k[i] != null && d[i] != null && k[i-1] != null && d[i-1] != null) {
      const jDownK = j[i-1] >= k[i-1] && j[i] < k[i];     // J下穿K
      const jDownD = j[i-1] >= d[i-1] && j[i] < d[i];     // J下穿D
      const jUpK   = j[i-1] <= k[i-1] && j[i] > k[i];     // J上穿K
      const jUpD   = j[i-1] <= d[i-1] && j[i] > d[i];     // J上穿D
      if (jDownK && jDownD) kdjAct = 'DEAD';   // KDJ死叉 → 平多
      if (jUpK && jUpD)     kdjAct = 'GOLD';    // KDJ金叉 → 平空
    }
    // 组合: 开仓看MACD, 平仓看KDJ
    if (macdAct === 'GOLD') return { action: 'OPEN_LONG', reason: `MACD金叉(DIF ${dif[i].toFixed(4)} 上穿DEA ${dea[i].toFixed(4)})做多`, macd: { dif: dif[i], dea: dea[i] }, kdj: { j: j[i], k: k[i], d: d[i] } };
    if (macdAct === 'DEAD') return { action: 'OPEN_SHORT', reason: `MACD死叉(DIF ${dif[i].toFixed(4)} 下穿DEA ${dea[i].toFixed(4)})做空`, macd: { dif: dif[i], dea: dea[i] }, kdj: { j: j[i], k: k[i], d: d[i] } };
    return { action: 'NONE', reason: `MACD=${macdAct} KDJ=${kdjAct} 无新开仓信号`, macd: { dif: dif[i], dea: dea[i] }, kdj: { j: j[i], k: k[i], d: d[i] } };
  }

  /**
   * 持仓管理: 平仓看KDJ交叉 (平多=KDJ死叉, 平空=KDJ金叉)
   * 返回 {action:'CLOSE'|'HOLD', reason}
   */
  manage(pos, klines) {
    const arr = toArray(klines);
    const { k, d, j } = this.kdj(arr);
    const i = arr.length - 1;
    if (i < 1 || j[i] == null || j[i-1] == null) return { action: 'HOLD' };
    if (pos.side === 'LONG') {
      const jDownK = j[i-1] >= k[i-1] && j[i] < k[i];
      const jDownD = j[i-1] >= d[i-1] && j[i] < d[i];
      if (jDownK && jDownD) return { action: 'CLOSE', reason: `KDJ死叉(J ${j[i].toFixed(1)} 下穿K ${k[i].toFixed(1)} 和D ${d[i].toFixed(1)})平多` };
    } else if (pos.side === 'SHORT') {
      const jUpK = j[i-1] <= k[i-1] && j[i] > k[i];
      const jUpD = j[i-1] <= d[i-1] && j[i] > d[i];
      if (jUpK && jUpD) return { action: 'CLOSE', reason: `KDJ金叉(J ${j[i].toFixed(1)} 上穿K ${k[i].toFixed(1)} 和D ${d[i].toFixed(1)})平空` };
    }
    return { action: 'HOLD' };
  }
}

module.exports = { MacdKdjStrategy, toArray };