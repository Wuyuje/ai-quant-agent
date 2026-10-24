/* ARK Citizen Tools - core: compound calculator, charts, on-chain data */
(function () {
  "use strict";

  /* ── 鎖倉方案（ARK 白皮書 v18） ── */
  var PLANS = {
    flex:    { days: 0,    rateMin: 0.21, rateMax: 0.60, label: "活期 / Flex" },
    "180":   { days: 180,  rateMin: 0.24, rateMax: 0.90, label: "180 天" },
    "360":   { days: 360,  rateMin: 0.25, rateMax: 1.00, label: "360 天" },
    "540":   { days: 540,  rateMin: 0.26, rateMax: 1.00, label: "540 天" },
    "720":   { days: 720,  rateMin: 0.27, rateMax: 1.00, label: "720 天" },
    "long":  { days: 1080, rateMin: 0.28, rateMax: 1.00, label: "長效質押 (1080天)" },
    "max":   { days: 1440, rateMin: 0.30, rateMax: 1.00, label: "永久質押 (1440天)" }
  };
  window.PLANS = PLANS;

  /* ── 燃燒費率表（解鎖週期越長，燃燒越低） ── */
  var BURN_TABLE = [
    { period: "活期 / 0 天",      rate: 0.30, note: "即時解鎖，燃燒最高" },
    { period: "180 天",          rate: 0.15, note: "短期鎖倉" },
    { period: "360 天",          rate: 0.10, note: "標準週期" },
    { period: "540 天",          rate: 0.05, note: "長週期優惠" },
    { period: "720 天",          rate: 0.02, note: "超長週期" },
    { period: "長效 1080 天",     rate: 0.00, note: "長效質押，免燃燒" },
    { period: "永久 1440 天",     rate: 0.00, note: "永久質押，免燃燒 + 治理權重" }
  ];
  window.BURN_TABLE = BURN_TABLE;

  /* ── 鏈上參數 ── */
  var CHAIN = {
    rpc: ["https://bsc-dataseed.binance.org", "https://bsc-dataseed1.defibit.io", "https://rpc.ankr.com/bsc"],
    pair: "0xCAaF3c41a40103a23Eeaa4BbA468AF3cF5b0e0D8",
    ark:  "0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D",
    usdt: "0x55d398326f99059fF775485246999027B3197955",
    decimals: 18
  };
  window.CHAIN = CHAIN;

  /* ── 複利公式（規格書指定） ── */
  function compound(principal, dailyRatePct, days) {
    var per = dailyRatePct / 100 / 2;   // 每次 Rebase 比率
    var n = Math.round(days * 2);       // Rebase 次數
    return principal * Math.pow(1 + per, n);
  }
  window.compound = compound;


  /* ── 單利 / 複利（規格書原式為複利，單利為線性） ── */
  var calcType = "compound";
  function setCalcType(t) {
    calcType = t;
    var s = document.getElementById("ct-simple"), c = document.getElementById("ct-compound");
    if (s) s.classList.toggle("active", t === "simple");
    if (c) c.classList.toggle("active", t === "compound");
    runCalc();
  }
  window.setCalcType = setCalcType;

  function compute(principal, dailyRatePct, days) {
    if (calcType === "simple") return principal * (1 + dailyRatePct / 100 * days);
    return compound(principal, dailyRatePct, days);
  }
  window.compute = compute;

  /* ── 數字格式化 ── */
  function fmt(n, dp) {
    if (n === null || n === undefined || isNaN(n)) return "-";
    dp = dp === undefined ? 2 : dp;
    var s = Number(n).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
    return s;
  }
  function fmtCompact(n) {
    n = Number(n) || 0;
    var abs = Math.abs(n);
    var dec = abs >= 1000 ? 0 : 2;   // 大数取整，小数保留2位
    return n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }
  window.fmt = fmt;
  window.fmtCompact = fmtCompact;

  /* ── 建立成長曲線資料 ── */
  function growthSeries(principal, dailyRatePct, days, points) {
    points = points || 60;
    var step = Math.max(1, Math.floor(days / points));
    var xs = [], ys = [];
    for (var d = 0; d <= days; d += step) {
      xs.push(d);
      ys.push(compound(principal, dailyRatePct, d));
    }
    if (xs[xs.length - 1] !== days) {
      xs.push(days);
      ys.push(compound(principal, dailyRatePct, days));
    }
    return { xs: xs, ys: ys };
  }
  window.growthSeries = growthSeries;

  /* ── 鏈上讀取（PancakeSwap V2 getReserves） ── */
  function rpcCall(method, params) {
    var urls = CHAIN.rpc.slice();
    function tryNext() {
      if (!urls.length) return Promise.reject(new Error("all rpc failed"));
      var url = urls.shift();
      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params })
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (d && d.result) return d.result;
        throw new Error("no result");
      }).catch(function () { return tryNext(); });
    }
    return tryNext();
  }

  function fetchChain() {
    return rpcCall("eth_call", [{ to: CHAIN.pair, data: "0x0902f1ac" }, "latest"])
      .then(function (hex) {
        var b = hex.slice(2);
        var r0 = BigInt("0x" + b.slice(0, 64));   // USDT
        var r1 = BigInt("0x" + b.slice(64, 128)); // ARK
        var D = Math.pow(10, CHAIN.decimals);
        var usdt = Number(r0) / D;
        var ark = Number(r1) / D;
        return {
          usdt: usdt,
          ark: ark,
          price: ark > 0 ? usdt / ark : 0,
          ts: Date.now()
        };
      });
  }
  window.fetchChain = fetchChain;

  /* ── Chart.js 輔助 ── */
  var THEME = {
    cyan: "#35e0f5", gold: "#f2c14e", blue: "#7c9bff",
    dim: "#93a4c8", grid: "rgba(147,164,200,.14)", text: "#e8eefc"
  };
  window.ARK_THEME = THEME;

  function baseOpts(title) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: THEME.dim, boxWidth: 12, font: { size: 11 } } },
        title: title ? { display: true, text: title, color: THEME.text, font: { size: 12 } } : { display: false },
        tooltip: {
          backgroundColor: "rgba(10,18,38,.95)", borderColor: THEME.cyan, borderWidth: 1,
          titleColor: THEME.text, bodyColor: THEME.dim
        }
      },
      scales: {
        x: { ticks: { color: THEME.dim, font: { size: 10 } }, grid: { color: THEME.grid } },
        y: { ticks: { color: THEME.dim, font: { size: 10 } }, grid: { color: THEME.grid } }
      }
    };
  }
  window.baseOpts = baseOpts;

  function makeChart(canvasId, cfg) {
    var el = document.getElementById(canvasId);
    if (!el) return null;
    if (el._chart) { el._chart.destroy(); }
    el._chart = new Chart(el.getContext("2d"), cfg);
    return el._chart;
  }
  window.makeChart = makeChart;

  /* ── 計算器 ── */
  /* ⭐ 選方案 → 自動填天數與收益率 */
  function onPlanChange() {
    var sel = document.getElementById("cPlan");
    if (!sel) return;
    var P = PLANS[sel.value];
    if (!P) return;
    var dEl = document.getElementById("cDays");
    var rEl = document.getElementById("cRate");
    if (dEl && P.days > 0) dEl.value = P.days;
    if (rEl) rEl.value = P.rateMax;    // 用最高參考收益率
    runCalc();
  }
  window.onPlanChange = onPlanChange;

  function runCalc() {
    var amt = parseFloat((document.getElementById("cAmount") || {}).value) || 0;
    var planKey = (document.getElementById("cPlan") || {}).value || "360";
    var rate = parseFloat((document.getElementById("cRate") || {}).value);
    var days = parseInt((document.getElementById("cDays") || {}).value, 10);

    var P = PLANS[planKey] || PLANS["360"];
    if (isNaN(rate)) rate = P.rateMax;
    if (isNaN(days) || days <= 0) days = P.days || 360;

    var finalAmt = compute(amt, rate, days);
    var gain = finalAmt - amt;
    var multiple = amt > 0 ? finalAmt / amt : 0;
    var dailyYield = amt * (rate / 100);
    var apr = (Math.pow(1 + rate / 100 / 2, 730) - 1) * 100;

    function set(id, v) { var e = document.getElementById(id); if (e) e.textContent = v; }
    set("rFinal", fmt(finalAmt, 2) + " ARK");
    set("rGain", "+" + fmt(gain, 2) + " ARK");
    set("rMult", multiple.toFixed(2) + "x");
    set("rDaily", fmt(dailyYield, 2) + " ARK");
    set("rApr", fmt(apr, 0) + "%");

    var s = (function () {
      var pts = [], step = Math.max(1, Math.floor(days / 60));
      for (var d = 0; d <= days; d += step) pts.push({ x: d, y: compute(amt, rate, d) });
      if (pts[pts.length - 1].x !== days) pts.push({ x: days, y: compute(amt, rate, days) });
      return { xs: pts.map(function (p) { return p.x; }), ys: pts.map(function (p) { return p.y; }) };
    })();
    makeChart("calcChart", {
      type: "line",
      data: {
        labels: s.xs.map(function (d) { return t("common.day") + " " + d; }),
        datasets: [{
          label: "ARK",
          data: s.ys,
          borderColor: THEME.cyan,
          backgroundColor: "rgba(53,224,245,.12)",
          fill: true, tension: .35, pointRadius: 0, borderWidth: 2
        }]
      },
      options: baseOpts()
    });
  }
  window.runCalc = runCalc;

  /* ── 方案對比圖 ── */
  function runCompare() {
    var amt = parseFloat((document.getElementById("pAmount") || {}).value) || 1000;
    var colors = [THEME.blue, THEME.gold, THEME.cyan, "#4ade80", "#c084fc"];
    var keys = ["360", "540", "720", "long", "max"];
    var maxDays = 1440;
    var labels = [];
    for (var d = 0; d <= maxDays; d += 15) labels.push(d);
    var sets = keys.map(function (k, i) {
      return {
        label: PLANS[k].label,
        data: labels.map(function (d) { return d <= PLANS[k].days ? compound(amt, PLANS[k].rateMax, d) : null; }),
        borderColor: colors[i], backgroundColor: "transparent",
        tension: .35, pointRadius: 0, borderWidth: 2
      };
    });
    makeChart("compareChart", {
      type: "line",
      data: { labels: labels.map(function (d) { return t("common.day") + " " + d; }), datasets: sets },
      options: baseOpts()
    });

    keys.slice(0, 5).forEach(function (k, i) {
      var P = PLANS[k];
      if (!P) return;
      var fin = compound(amt, P.rateMax, P.days);
      var e1 = document.getElementById("plansCard" + (i + 1));
      if (e1) {
        e1.innerHTML =
          '<div class="pc-title">' + P.label + '</div>' +
          '<div class="pc-big">' + fin.toFixed(0) + ' ARK</div>' +
          '<div class="pc-sub">' + (fin / amt).toFixed(1) + 'x · ' +
          (P.rateMin * 100).toFixed(0) + '-' + (P.rateMax * 100).toFixed(0) + '% ' + t("calc.rate") + '</div>';
      }
    });
  }
  window.runCompare = runCompare;

  /* ── 燃燒費率表 ── */
  function renderBurn() {
    var tb = document.getElementById("burnTbody");
    if (!tb) return;
    tb.innerHTML = BURN_TABLE.map(function (r) {
      return '<tr><td>' + r.period + '</td><td class="dn">' + (r.rate * 100).toFixed(0) + '%</td><td class="mut">' + r.note + '</td></tr>';
    }).join("");
  }
  window.renderBurn = renderBurn;

  /* ── 鏈上數據卡（/api/ark 全量 + 前端 RPC 回退） ── */
  function pctCls(v) { return v >= 0 ? "up" : "dn"; }
  function pctStr(v) { return (v >= 0 ? "+" : "") + Number(v).toFixed(2) + "%"; }

  function paintChain(d) {
    function set(id, v) { var e = document.getElementById(id); if (e) e.textContent = v; }
    set("chPrice", "$" + Number(d.price || d.priceUsd || 0).toFixed(4));
    var chg = d.priceChange && d.priceChange.h24;
    var ce = document.getElementById("chChg");
    if (ce && chg != null) { ce.textContent = t("chain.chg24") + " " + pctStr(chg); ce.className = "mut " + pctCls(chg); }
    if (d.marketCap) set("chMcap", "$" + fmtCompact(d.marketCap));
    if (d.fdv) set("chFdv", "$" + fmtCompact(d.fdv));
    var ark = d.poolArk || d.ark || 0;
    var usdt = d.poolUsdt || d.usdt || 0;
    set("chArkPool", fmtCompact(ark) + " ARK");
    set("chUsdtPool", "$" + fmtCompact(usdt));
    set("chTvl", "$" + fmtCompact(d.liquidityUsd || usdt * 2));
    if (d.totalSupply) set("chSupply", fmtCompact(d.totalSupply) + " ARK");
    var v24 = (d.volume && d.volume.h24) || 0;
    if (v24) set("chVol24", "$" + fmtCompact(v24));
    window._lastChain = { ts: d.ts || Date.now(), price: Number(d.price || d.priceUsd || 0), usdt: usdt, ark: ark };
    if (typeof window.onChainData === "function") window.onChainData(window._lastChain);
  }
  window.paintChain = paintChain;

  function loadChain() {
    function set(id, v) { var e = document.getElementById(id); if (e) e.textContent = v; }
    fetch("/api/ark").then(function (r) { return r.json(); }).then(function (d) {
      if (d && !d.error) paintChain(d);
      else throw new Error("ark api");
    }).catch(function () {
      // 回退：前端直連 RPC
      fetchChain().then(function (d) {
        paintChain({ price: d.price, poolArk: d.ark, poolUsdt: d.usdt, ts: d.ts });
      }).catch(function () { set("chPrice", t("common.error")); });
    });
  }
  window.loadChain = loadChain;


  /* ── KPI（從鏈上/快照統計） ── */
  function loadKPI() {
    fetch("/api/stats").then(function (r) { return r.json(); }).then(function (d) {
      var set = function (id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };
      set("kpiTrades", d.trades != null ? d.trades : "-");
      set("kpiHolders", d.holders != null ? d.holders : "-");
      set("kpiDays", d.days != null ? d.days : "-");
    }).catch(function () {
      // 後端沒有 /api/stats 時，用快照天數回退
      var snaps = [];
      try { snaps = JSON.parse(localStorage.getItem("ark_snapshots")) || []; } catch (e) {}
      var days = snaps.length ? Math.max(1, Math.ceil((Date.now() - snaps[0].ts) / 864e5)) : 1;
      var set = function (id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };
      set("kpiTrades", snaps.length);
      set("kpiHolders", "-");
      set("kpiDays", days);
    });
  }
  window.loadKPI = loadKPI;

  /* ── 買入量 / 賣出量（/api/ark 多週期） ── */
  function loadFlow() {
    var set = function (id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };
    fetch("/api/ark").then(function (r) { return r.json(); }).then(function (d) {
      var txns = d.txns || {};
      var h24 = txns.h24 || {};
      var buys = h24.buys || 0, sells = h24.sells || 0;
      var net = buys - sells;
      set("flowBuy", fmtCompact(buys) + " tx");
      set("flowBuySub", "$" + fmtCompact(((d.volume || {}).h24 || 0) / 2));
      set("flowSell", fmtCompact(sells) + " tx");
      set("flowSellSub", "$" + fmtCompact(((d.volume || {}).h24 || 0) / 2));
      var ne = document.getElementById("flowNet");
      if (ne) { ne.textContent = (net >= 0 ? "+" : "") + fmtCompact(net) + " tx"; ne.className = "cv " + (net >= 0 ? "up" : "dn"); }
      // 多週期表
      var tb = document.getElementById("flowTbody");
      if (tb) {
        var rows = [["m5", t("flow.m5")], ["h1", t("flow.h1")], ["h6", t("flow.h6")], ["h24", t("flow.h24")]];
        tb.innerHTML = rows.map(function (r) {
          var x = txns[r[0]] || {};
          var b = x.buys || 0, s = x.sells || 0, n = b - s;
          return '<tr><td>' + r[1] + '</td><td class="up">' + fmt(b) + '</td><td class="dn">' + fmt(s) +
            '</td><td class="' + (n >= 0 ? "up" : "dn") + '">' + (n >= 0 ? "+" : "") + fmt(n) + '</td></tr>';
        }).join("");
      }
      window._flow = { buys: buys, sells: sells, vol24: (d.volume || {}).h24 || 0, priceChange: d.priceChange || {} };
    }).catch(function () {
      set("flowBuy", "-"); set("flowSell", "-");
    });
  }
  window.loadFlow = loadFlow;

  /* ── 錢包連接（EIP-1193，僅讀地址，不簽名） ── */
  var walletAddr = "";
  /* ══ 钱包断开时彻底清理（不再残留上一个钱包的数据）══ */
  function _clearWalletState() {
    walletAddr = "";
    try { window.walletAddr = ""; } catch (e) {}
    try { window.ARK_ADDR = ""; } catch (e) {}
    try { window.ARK_PRO = undefined; } catch (e) {}
    try {
      localStorage.removeItem("ark_addr");
      localStorage.removeItem("ark_auth_addr");
      localStorage.removeItem("ark_token");
    } catch (e) {}
    try { if (window.arkSwitchAddr) window.arkSwitchAddr(""); } catch (e) {}
  }
  window.arkClearWallet = _clearWalletState;
  function toggleWallet() {
    if (walletAddr) { _clearWalletState(); renderWallet(); return; }
    if (!window.ethereum) { alert("No Web3 wallet detected"); return; }
    window.ethereum.request({ method: "eth_requestAccounts" }).then(function (accs) {
      var _a = (accs && accs[0]) || "";
      walletAddr = _a;
      try { window.walletAddr = _a; } catch (e) {}
      /* ══ 切换到新地址：先清理旧钱包界面数据，再渲染 ══ */
      try { if (window.arkSwitchAddr) window.arkSwitchAddr(_a); } catch (e) {}
      renderWallet();
    }).catch(function (e) { alert("Connect failed: " + (e.message || e)); });
  }
  window.toggleWallet = toggleWallet;

  /* ══ 监听钱包插件的账户切换/断开事件（MetaMask 内部切换也能捕获）══ */
  try {
    if (window.ethereum && window.ethereum.on) {
      window.ethereum.on('accountsChanged', function (accs) {
        var _a = (accs && accs[0]) || "";
        if (_a) {
          walletAddr = _a;
          try { window.walletAddr = _a; } catch (e) {}
          try { if (window.arkSwitchAddr) window.arkSwitchAddr(_a); } catch (e) {}
        } else {
          try { _clearWalletState(); } catch (e) {}
        }
        try { renderWallet(); } catch (e) {}
      });
      window.ethereum.on('disconnect', function () {
        try { _clearWalletState(); } catch (e) {}
        try { renderWallet(); } catch (e) {}
      });
    }
  } catch (e) {}

  function renderWallet() {
    var b = document.getElementById("walletBtn");
    if (!b) return;
    if (walletAddr) {
      b.textContent = walletAddr.slice(0, 6) + "..." + walletAddr.slice(-4);
      b.classList.add("on");
      b.title = t("nav.disconnect");
    } else {
      b.textContent = t("nav.wallet");
      b.classList.remove("on");
      b.title = "";
    }
  }

  /* ── 初始化 ── */
  document.addEventListener("DOMContentLoaded", function () {
    renderBurn();
    if (document.getElementById("calcChart")) runCalc();
    if (document.getElementById("compareChart")) runCompare();
    if (document.getElementById("chPrice")) loadChain();
    if (document.getElementById("kpiTrades")) loadKPI();
    if (document.getElementById("flowBuy")) loadFlow();
    setInterval(loadChain, 60000);
    setInterval(loadFlow, 120000);
  });

  window.onLangChange = function () {
    if (document.getElementById("compareChart")) runCompare();
    renderBurn();
    renderWallet();
  };
})();

/* ═══ 方案按鈕組（手機友好，替代原生 <select>） ═══ */
(function () {
  "use strict";
  var PLANS = window.PLANS || {};
  var ORDER = ["flex", "180", "360", "540", "720", "long", "max"];

  function renderChips(containerId, selectId, onChange) {
    var box = document.getElementById(containerId);
    var sel = document.getElementById(selectId);
    if (!box || !sel) return;

    box.innerHTML = ORDER.map(function (k) {
      var P = PLANS[k];
      if (!P) return "";
      var label = P.days > 0 ? (P.days + " 天") : "活期";
      if (k === "long") label = "長效 1080";
      if (k === "max") label = "永久 1440";
      return '<div class="plan-chip" data-k="' + k + '">' + label + '</div>';
    }).join("");

    function setActive(k) {
      box.querySelectorAll(".plan-chip").forEach(function (c) {
        c.classList.toggle("active", c.getAttribute("data-k") === k);
      });
    }

    box.querySelectorAll(".plan-chip").forEach(function (c) {
      c.addEventListener("click", function () {
        var k = c.getAttribute("data-k");
        sel.value = k;
        setActive(k);
        if (typeof onChange === "function") onChange(k);
      });
    });

    setActive(sel.value || "360");
  }

  window.renderPlanChips = renderChips;

  document.addEventListener("DOMContentLoaded", function () {
    // 計算器
    renderChips("cPlanChips", "cPlan", function (k) {
      if (typeof window.onPlanChange === "function") window.onPlanChange();
    });
    // 帳戶管理
    renderChips("aPlanChips", "aPlan", function (k) {
      // 帳戶下拉只是取值，無需額外處理
    });
    // ⭐ 收益看板方案（pfPlan）
    renderChips("pfPlanChips", "pfPlan", function (k) {
      if (typeof pfFetch === "function") pfFetch();
    });
    // 收益看板 + 預警
    if (typeof window.initPortfolio === "function") window.initPortfolio();
  });

  /* ══════════ 收益看板 (Portfolio) ══════════ */
  function pfFetch() {
    var _a = document.getElementById("pfAmt");
    var _p = document.getElementById("pfPlan");
    var _d = document.getElementById("pfDays");
    var amt = parseFloat((_a && _a.value) || "0");
    var plan = (_p && _p.value) || "360";
    var days = parseInt((_d && _d.value) || "0", 10);
    fetch("/api/portfolio?amount=" + amt + "&plan=" + plan + "&days=" + days)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) return;
        var set = function (id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };
        set("pfUsd", d.valueUsd != null ? "$" + d.valueUsd.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—");
        set("pfEarnArk", "+" + d.earnedArk.toLocaleString(undefined, { maximumFractionDigits: 2 }) + " ARK");
        set("pfEarnUsd", d.earnedUsd != null ? "+$" + d.earnedUsd.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—");
        set("pfCurArk", d.currentArk.toLocaleString(undefined, { maximumFractionDigits: 2 }) + " ARK");
        set("pfApy", d.apy + "%");
        set("pfPrice", d.price != null ? "$" + d.price : "—");
      })
      .catch(function () {});
  }

  function pfShare() {
    var _a2 = document.getElementById("pfAmt"), _p2 = document.getElementById("pfPlan"), _d2 = document.getElementById("pfDays");
    var amt = parseFloat((_a2 && _a2.value) || "0");
    var plan = (_p2 && _p2.value) || "360";
    var days = parseInt((_d2 && _d2.value) || "0", 10);
    fetch("/api/share-card?amount=" + amt + "&plan=" + plan + "&days=" + days)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var msg = "我持有 " + d.amount + " ARK，已賺 +" + d.earnedArk + " ARK" +
          (d.earnedUsd != null ? "（≈$" + d.earnedUsd + "）" : "") +
          "\nARK 現價 $" + d.price + "\n— ARK Citizen Tools";
        if (navigator.clipboard) {
          navigator.clipboard.writeText(msg).then(function () { alert("✅ 分享文案已複製到剪貼簿\n\n" + msg); });
        } else {
          alert(msg);
        }
      })
      .catch(function () {});
  }

  /* ══════════ 價格預警 (Alerts) ══════════ */
    /* ⭐ 兼容: walletAddr 可能定义在别的 IIFE */
  function _wa() {
    var a = "";
    try { a = (typeof walletAddr !== "undefined" && walletAddr) || window.walletAddr || window.ARK_ADDR || ""; } catch (e) {}
    if (a) return a;
    /* FIX: 令牌自动登录是异步的，地址可能还没写入内存变量，从 localStorage 兜底 */
    try { a = localStorage.getItem("ark_auth_addr") || localStorage.getItem("ark_addr") || ""; } catch (e) {}
    return a || "";
  }
  /* ⭐⭐ 关键修复: 把 _wa 挂到全局，供 IIFE 外部定义的 window.loadCoefAlerts / addCoefAlert 调用 */
  window._wa = _wa;

  /* ══════════ 钱包切换隔离核心 ══════════ */
  /* 问题: 以前切换钱包只清 walletAddr, 但 window.ARK_ADDR 和 localStorage 里的旧地址还在,
     _wa() 会从 localStorage 读到旧地址 -> 看到别人的阀值/持仓/提醒。
     这里做一个统一的"地址变化 -> 清理界面上所有跨钱包数据" 入口。 */
  window.__ARK_UI_ADDR = "";
  window.arkSwitchAddr = function (newAddr) {
    var _old = window.__ARK_UI_ADDR || "";
    var _new = newAddr ? String(newAddr).toLowerCase() : "";
    if (_old === _new) return false;
    window.__ARK_UI_ADDR = _new;
    /* 清理所有跨钱包异步数据的界面残留 */
    try {
      window.__ARK_SAVED_ALERT = null;
      window.__ARK_ALERT_ADDR = null;
      var _ids = ['coefTh', 'coefTarget', 'coefCh'];
      _ids.forEach(function (id) {
        var e = document.getElementById(id);
        if (e) { e.removeAttribute('data-saved'); if (id !== 'coefCh') e.value = ''; }
      });
      var _h = document.getElementById('coefHint'); if (_h) _h.textContent = '';
      var _tb = document.getElementById('coefTbody');
      if (_tb) _tb.innerHTML = '<tr><td colspan="4" class="mut" style="text-align:center">加载中…</td></tr>';
      var _al = document.getElementById('alTbody');
      if (_al) _al.innerHTML = '<tr><td colspan="4" class="mut" style="text-align:center">加载中…</td></tr>';
      var _at = document.getElementById('alTarget'); if (_at) _at.value = '';
      var _hd = document.getElementById('hdAddr'); if (_hd) _hd.value = _new;
      ['hdArk','hdArkie','hdGark','hdBnb','hdTotal','hdArkUsd'].forEach(function (id) {
        var e = document.getElementById(id); if (e) e.textContent = '—';
      });
      var _pl = document.getElementById('pfTracked'); if (_pl) _pl.textContent = '—';
      var _pr = document.getElementById('refAmt'); if (_pr) _pr.textContent = '—';
      var _pe = document.getElementById('refEarn'); if (_pe) _pe.textContent = '—';
    } catch (e) {}
    /* 新地址就绪后，立即拉该地址自己的数据 */
    setTimeout(function () {
      try { window.refreshProState && window.refreshProState(); } catch (e) {}
      try { window.loadCoefAlerts && window.loadCoefAlerts(); } catch (e) {}
      try { window.alRender && window.alRender(); } catch (e) {}
      try { window.hdFetch && window.hdFetch(); } catch (e) {}
      try { window.pfFetch && window.pfFetch(); } catch (e) {}
      try { window.refreshRef && window.refreshRef(); } catch (e) {}
      try { window.loadStakes && window.loadStakes(); } catch (e) {}
      try { document.dispatchEvent(new CustomEvent('ark:addrchange', { detail: { addr: _new } })); } catch (e) {}
    }, 60);
    return true;
  };

function alRender() {
    var tb = document.getElementById("alTbody");
    if (!tb) return;
    var _w = _wa();
    if (!_w) {
      tb.innerHTML = '<tr><td colspan="4" class="mut" style="text-align:center">連接錢包後可查看</td></tr>';
      return;
    }
    fetch("/api/alerts?addr=" + _w)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var list = d.alerts || [];
        if (!list.length) { tb.innerHTML = '<tr><td colspan="4" class="mut" style="text-align:center">尚無預警</td></tr>'; return; }
        tb.innerHTML = list.map(function (a) {
          var st = a.triggered ? '<span style="color:#16c784">✓ 已觸發</span>' : '<span class="mut">監控中</span>';
          var kindTxt = a.kind === "above" ? "漲破 ≥" : "跌破 ≤";
          return '<tr><td>' + kindTxt + '</td><td>$' + a.target + '</td><td>' + st + '</td>' +
            '<td><button class="btn" style="padding:4px 10px;font-size:12px" onclick="delAlert(\'' + a.id + '\')">刪除</button></td></tr>';
        }).join("");
      })
      .catch(function () {});
  }

  window.alRender = alRender;
  window.delAlert = function (id) {
    if (!_wa()) return;
    fetch("/api/alerts/delete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addr: _wa(), id: id })
    }).then(function () { alRender(); });
  };

  function alAdd() {
    if (!_wa()) { alert("請先連接錢包（右上角）"); return; }
    var _ak = document.getElementById("alKind"), _at = document.getElementById("alTarget");
    var kind = (_ak && _ak.value) || "above";
    var target = parseFloat((_at && _at.value) || "0");
    if (!(target > 0)) { alert("請輸入有效的目標價"); return; }
    fetch("/api/alerts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addr: _wa(), kind: kind, target: target })
    }).then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.ok) { var _at2=document.getElementById("alTarget"); if(_at2) _at2.value=""; alRender(); }
        else alert("新增失敗: " + (d.error || "?"));
      });
  }

  window.initPortfolio = function () {
    var run = document.getElementById("pfRun");
    if (run) run.addEventListener("click", pfFetch);
    var sh = document.getElementById("pfShare");
    if (sh) sh.addEventListener("click", pfShare);
    var aadd = document.getElementById("alAdd");
    if (aadd) aadd.addEventListener("click", alAdd);
    var hd = document.getElementById("hdRun");
    if (hd) hd.addEventListener("click", hdFetch);
    var wh = document.getElementById("whRun");
    if (wh) wh.addEventListener("click", whFetch);
    pfFetch();
    alRender();
    // 若有錢包，自動填持倉地址
    if (_wa()) { var a = document.getElementById("hdAddr"); if (a) a.value = _wa(); hdFetch(); }
    whFetch();
    setInterval(function () { alRender(); }, 30000);
  };

  /* ══════════ 鏈上持倉 (Holdings) ══════════ */
  function hdFetch() {
    /* ⭐ 隔离: 优先用当前钱包地址，不再默认拿旧地址 */
    var _hd = document.getElementById("hdAddr");
    var addr = ((_hd && _hd.value) || _wa() || "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) { return; }
    fetch("/api/holdings?addr=" + addr)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) return;
        var set = function (id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };
        var nk = function (v, d) { return v == null ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: d == null ? 4 : d }); };
        set("hdArk", nk(d.ark) + " ARK");
        set("hdArkie", nk(d.arkie) + " ARKIE");
        set("hdGark", nk(d.gark) + " gARK");
        set("hdBnb", nk(d.bnb, 6) + " BNB");
        set("hdTotal", d.totalUsd != null ? "$" + d.totalUsd.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—");
        set("hdArkUsd", d.arkUsd != null ? "$" + d.arkUsd.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—");
      })
      .catch(function () {});
  }

  /* ══════════ 鯨魚監控 (Whales) ══════════ */
  function whFetch() {
    var _wm = document.getElementById("whMin");
    var min = parseFloat((_wm && _wm.value) || "1000");
    var tb = document.getElementById("whTbody");
    var info = document.getElementById("whInfo");
    if (info) info.textContent = "讀取中…";
    fetch("/api/whales?min=" + min)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { if (info) info.textContent = "❌ " + d.error; return; }
        if (info) info.textContent = "掃描 " + d.scannedBlocks + " 區塊 · 找到 " + d.count + " 筆大額轉賬";
        var list = d.transfers || [];
        if (!list.length) { tb.innerHTML = '<tr><td colspan="4" class="mut" style="text-align:center">暫無大額轉賬</td></tr>'; return; }
        tb.innerHTML = list.map(function (t) {
          var txShort = t.tx ? (t.tx.slice(0, 8) + "…" + t.tx.slice(-6)) : "-";
          return '<tr><td style="color:#16c784;font-weight:600">' + t.amount.toLocaleString() + '</td>' +
            '<td class="mut" style="font-family:monospace">' + t.from.slice(0, 8) + '…</td>' +
            '<td class="mut" style="font-family:monospace">' + t.to.slice(0, 8) + '…</td>' +
            '<td><a href="https://bscscan.com/tx/' + t.tx + '" target="_blank" rel="noopener" class="mut" style="font-family:monospace">' + txShort + '</a></td></tr>';
        }).join("");
      })
      .catch(function () { if (info) info.textContent = "讀取失敗"; });
  }
})();

/* ══════════ 联系表单 (Contact) ══════════ */
window.openContact = function () {
  var m = document.getElementById('contactModal');
  if (m) { m.classList.add('on'); var c = document.getElementById('ctContact'); if (c) c.focus(); }
};
window.closeContact = function () {
  var m = document.getElementById('contactModal');
  if (m) m.classList.remove('on');
};
window.submitContact = function () {
  var contact = (document.getElementById('ctContact').value || '').trim();
  var body = (document.getElementById('ctBody').value || '').trim();
  var st = document.getElementById('ctStatus');
  if (body.length < 2) { st.textContent = '请填写訊息内容'; st.style.color = '#f2555f'; return; }
  st.textContent = '发送中…'; st.style.color = '';
  fetch('/api/contact', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contact: contact, body: body, addr: _wa() })
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (d.ok) {
      st.textContent = '✅ 已发送，管理员会尽快回复';
      st.style.color = '#18c98a';
      document.getElementById('ctContact').value = '';
      document.getElementById('ctBody').value = '';
      setTimeout(closeContact, 2000);
    } else {
      st.textContent = '❌ ' + (d.error || '发送失败');
      st.style.color = '#f2555f';
    }
  }).catch(function () { st.textContent = '❌ 网络错误'; st.style.color = '#f2555f'; });
};

/* ══════════ 收益分享海报 (Poster) ══════════ */
window.genPoster = function () {
  var amt = parseFloat(document.getElementById('pfAmt').value || '0');
  var plan = document.getElementById('pfPlan').value;
  var days = parseInt(document.getElementById('pfDays').value || '0', 10);
  fetch('/api/share-card?amount=' + amt + '&plan=' + plan + '&days=' + days)
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var cv = document.createElement('canvas');
      cv.width = 750; cv.height = 1000;
      var x = cv.getContext('2d');
      // 背景
      var g = x.createLinearGradient(0, 0, 750, 1000);
      g.addColorStop(0, '#0a0e17'); g.addColorStop(0.5, '#111a2e'); g.addColorStop(1, '#0f1420');
      x.fillStyle = g; x.fillRect(0, 0, 750, 1000);
      // 光晕
      var rg = x.createRadialGradient(375, 300, 50, 375, 300, 500);
      rg.addColorStop(0, 'rgba(99,102,241,.25)'); rg.addColorStop(1, 'rgba(99,102,241,0)');
      x.fillStyle = rg; x.fillRect(0, 0, 750, 1000);
      // 边框
      x.strokeStyle = 'rgba(53,224,245,.3)'; x.lineWidth = 3;
      x.strokeRect(20, 20, 710, 960);
      // 顶部品牌
      x.fillStyle = '#35e0f5'; x.font = 'bold 30px sans-serif'; x.textAlign = 'center';
      x.fillText('ARK CITIZEN TOOLS', 375, 90);
      x.fillStyle = '#8b95a8'; x.font = '18px sans-serif';
      x.fillText('ARK 复利收益报告', 375, 125);
      // 头像占位圆
      x.beginPath(); x.arc(375, 220, 55, 0, Math.PI * 2);
      x.fillStyle = 'rgba(99,102,241,.2)'; x.fill();
      x.strokeStyle = 'rgba(53,224,245,.5)'; x.lineWidth = 2; x.stroke();
      x.fillStyle = '#35e0f5'; x.font = 'bold 44px sans-serif';
      x.fillText('ARK', 375, 237);
      // 主数据
      x.fillStyle = '#9aa8bd'; x.font = '20px sans-serif';
      x.fillText('我的持仓', 375, 330);
      x.fillStyle = '#fff'; x.font = 'bold 56px sans-serif';
      x.fillText(Number(d.amount).toLocaleString() + ' ARK', 375, 395);
      // 收益
      x.fillStyle = '#9aa8bd'; x.font = '20px sans-serif';
      x.fillText('累计赚取', 375, 470);
      x.fillStyle = '#18c98a'; x.font = 'bold 52px sans-serif';
      x.fillText('+' + Number(d.earnedArk).toLocaleString() + ' ARK', 375, 535);
      if (d.earnedUsd != null) {
        x.fillStyle = '#18c98a'; x.font = 'bold 32px sans-serif';
        x.fillText('≈ $' + Number(d.earnedUsd).toLocaleString(), 375, 585);
      }
      // 分割线
      x.strokeStyle = 'rgba(255,255,255,.1)'; x.lineWidth = 1;
      x.beginPath(); x.moveTo(100, 630); x.lineTo(650, 630); x.stroke();
      // 明细
      x.textAlign = 'left'; x.fillStyle = '#8b95a8'; x.font = '19px sans-serif';
      x.fillText('当前总量', 110, 690); x.fillText('持有天数', 110, 735);
      x.fillText('ARK 现价', 110, 780); x.fillText('参考年化', 110, 825);
      x.textAlign = 'right'; x.fillStyle = '#e6edf3'; x.font = 'bold 20px monospace';
      x.fillText(Number(d.currentArk).toLocaleString() + ' ARK', 640, 690);
      x.fillText(d.days + ' 天', 640, 735);
      x.fillText('$' + Number(d.price || 0).toFixed(4), 640, 780);
      x.fillText(((Math.pow(1 + 0.0028, 365) - 1) * 100).toFixed(0) + '%', 640, 825);
      // 底部
      x.textAlign = 'center'; x.fillStyle = '#5a6779'; x.font = '16px sans-serif';
      x.fillText('ARK Citizen Tools · 复利引擎与链上数据', 375, 900);
      x.fillStyle = '#35e0f5'; x.font = 'bold 17px monospace';
      x.fillText('65.20.68.166:18080', 375, 930);
      // 下载
      var dataUrl = cv.toDataURL('image/png');
      _showPosterModal(dataUrl, 'ARK-收益报告-' + Date.now() + '.png');
    })
    .catch(function (e) { alert('生成失败: ' + e.message); });
};

/* ══════════ ARK 实时 K 线 ══════════ */
window.loadKline = function (tf, limit) {
  // 标签高亮
  ['1h','4h','1d','7d','30d'].forEach(function (k) {
    var b = document.getElementById('kbtn-' + k);
    if (b) b.classList.remove('active');
  });
  var key = tf === 'day' ? '30d' : (limit >= 240 ? '4h' : limit >= 168 ? '7d' : limit >= 24 ? '1d' : '1h');
  var ab = document.getElementById('kbtn-' + key);
  if (ab) ab.classList.add('active');

  fetch('/api/kline?tf=' + tf + '&limit=' + limit)
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var cs = d.candles || [];
      if (!cs.length) return;
      var labels = cs.map(function (c) {
        var dt = new Date(c.t * 1000);
        return tf === 'day' ? (dt.getMonth() + 1) + '/' + dt.getDate()
          : (dt.getMonth() + 1) + '/' + dt.getDate() + ' ' + dt.getHours() + ':' + (dt.getMinutes() < 10 ? '0' : '') + dt.getMinutes();
      });
      var closes = cs.map(function (c) { return c.c; });
      var highs = cs.map(function (c) { return c.h; });
      var lows = cs.map(function (c) { return c.l; });
      // 统计
      var first = closes[0], last = closes[closes.length - 1];
      var chg = (last - first) / first * 100;
      var hi = Math.max.apply(null, highs), lo = Math.min.apply(null, lows);
      var st = document.getElementById('klineStats');
      if (st) {
        st.innerHTML =
          '<span>最新: <b style="color:#e6edf3">$' + last.toFixed(4) + '</b></span>' +
          '<span>区间涨跌: <b style="color:' + (chg >= 0 ? '#18c98a' : '#f2555f') + '">' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%</b></span>' +
          '<span>最高: <b style="color:#18c98a">$' + hi.toFixed(4) + '</b></span>' +
          '<span>最低: <b style="color:#f2555f">$' + lo.toFixed(4) + '</b></span>' +
          '<span class="mut">' + cs.length + ' 根K线</span>';
      }
      // 图
      var el = document.getElementById('histChart');
      if (!el) return;
      if (el._chart) { try { el._chart.destroy(); } catch (e) {} }
      el._chart = new Chart(el.getContext('2d'), {
        type: 'line',
        data: {
          labels: labels,
          datasets: [
            { label: 'ARK', data: closes, borderColor: '#35e0f5', backgroundColor: 'rgba(53,224,245,.08)', fill: true, tension: .25, pointRadius: 0, borderWidth: 2 },
            { label: '高点', data: highs, borderColor: 'rgba(24,201,138,.45)', borderWidth: 1, pointRadius: 0, fill: false },
            { label: '低点', data: lows, borderColor: 'rgba(242,85,95,.45)', borderWidth: 1, pointRadius: 0, fill: false }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { labels: { color: '#8b95a8', font: { size: 11 } } } },
          scales: {
            x: { ticks: { color: '#5a6779', maxTicksLimit: 8, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,.04)' } },
            y: { ticks: { color: '#5a6779', font: { size: 10 }, callback: function (v) { return '$' + Number(v).toFixed(3); } }, grid: { color: 'rgba(255,255,255,.04)' } }
          }
        }
      });
    })
    .catch(function (e) { console.log('kline err', e); });
};
// 首屏加载
document.addEventListener('DOMContentLoaded', function () {
  setTimeout(function () { if (typeof loadKline === 'function') loadKline('minute', 60); }, 800);
});

/* ══════════ 收益法币换算 ══════════ */
var _fxRates = null;
function _fxLoad() {
  return fetch('/api/fx').then(function (r) { return r.json(); }).then(function (d) {
    if (d.rates) { _fxRates = d.rates; }
    return _fxRates;
  }).catch(function () { return _fxRates; });
}
window.runCalcFx = function () {
  var el = document.getElementById('fxCur');
  if (!el) return;
  var cur = el.value || 'USDT';
  var amount = parseFloat(document.getElementById('cAmount').value || '0');
  var days = parseFloat(document.getElementById('cDays').value || '0');
  var rate = parseFloat(document.getElementById('cRate').value || '1') / 100; // 日收益率
  var compound = (document.getElementById('ct-compound') || {}).classList && document.getElementById('ct-compound').classList.contains('active');

  _fxLoad().then(function (rates) {
    if (!rates) return;
    var fx = rates[cur] || 1;
    // 拿 ARK 价格
    return fetch('/api/chain').then(function (r) { return r.json(); }).then(function (c) {
      var arkPrice = c.price || 0;   // USD
      var usdNow = amount * arkPrice;
      // 收益计算（与计算器一致：复利/单利）
      var gained;
      if (compound) gained = amount * (Math.pow(1 + rate, days) - 1);
      else gained = amount * rate * days;
      var endArk = amount + gained;
      var usdEnd = endArk * arkPrice;
      var usdGain = endArk * arkPrice - usdNow;
      var set = function (id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };
      var fmt = function (n) {
        if (cur === 'VND' || cur === 'JPY' || cur === 'KRW' || cur === 'INR') {
          return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
        }
        return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
      };
      var sym = cur === 'USDT' ? '$' : '';
      set('fxNow', sym + fmt(usdNow * fx) + ' ' + (cur === 'USDT' ? '' : cur));
      set('fxEnd', sym + fmt(usdEnd * fx) + ' ' + (cur === 'USDT' ? '' : cur));
      set('fxGain', '+' + sym + fmt(usdGain * fx) + ' ' + (cur === 'USDT' ? '' : cur));
      set('fxRate', '1 USD = ' + Number(fx).toFixed(cur === 'VND' || cur === 'KRW' ? 0 : 4) + ' ' + cur);
      var note = document.getElementById('fxNote');
      if (note) note.textContent = 'ARK 现价 $' + arkPrice.toFixed(4) + ' · 汇率实时更新（er-api）';
    });
  });
};
// 扩展 runCalc，计算后顺带刷新换算
(function () {
  var orig = window.runCalc;
  if (typeof orig === 'function') {
    window.runCalc = function () {
      var r = orig.apply(this, arguments);
      setTimeout(function () { try { window.runCalcFx(); } catch (e) {} }, 100);
      return r;
    };
  }
})();
document.addEventListener('DOMContentLoaded', function () {
  setTimeout(function () { if (typeof runCalcFx === 'function') runCalcFx(); }, 1500);
});

/* ══════════ 涡轮共识系数 + 提醒 ══════════ */
window.loadCoef = function () {
  fetch('/api/coef-live').then(function (r) { return r.json(); }).then(function (d) {
    if (d.error) return;
    var set = function (id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };
    var c = d.coefficient;
    window.__ARK_REAL_COEF = c;
    var el = document.getElementById('coefScore');
    if (el) {
      el.textContent = c.toFixed(6);
      el.style.color = c >= 0.5 ? '#18c98a' : c >= 0.3 ? '#35e0f5' : '#f5a623';
    }
    var mom = document.getElementById('coefMomentum');
    if (mom) {
      var mv = Number(d.momentum || 0) * 100;
      mom.textContent = (mv >= 0 ? '▲ +' : '▼ ') + mv.toFixed(4) + '%';
      mom.style.color = mv >= 0 ? '#18c98a' : '#ff5c7a';
    }
    var lb = document.getElementById('coefLabel');
    if (lb) lb.textContent = c >= 0.5 ? '🔥 系数高（涡轮奖励丰厚）' : c >= 0.3 ? '📈 中等' : '📉 系数低';
    set('coefPr', (d.min24h||0).toFixed(4) + ' ~ ' + (d.max24h||0).toFixed(4));
    set('coefSrc', '链上实时 ' + (d.contract ? d.contract.slice(0,8)+'…' : ''));
    set('coefBs', Number(d.released||0).toLocaleString('en-US',{maximumFractionDigits:0}) + ' / ' + Number(d.total||0).toLocaleString('en-US',{maximumFractionDigits:0}));
    set('coefTo', (d.releasePct||0) + '%');
    set('coefTx', (d.cycleSec||0)+'s');
    set('coefSrc', '链上实时 · ' + (d.pair ? d.pair.slice(0,8)+'…' : '') + ' · ' + new Date().toLocaleTimeString());
    var act = document.getElementById('coefActual');
    if (act && typeof d.actualRatePct === 'number') {
      act.textContent = d.actualRatePct.toFixed(2) + '%';
      act.style.color = d.actualRatePct >= 15 ? '#18c98a' : d.actualRatePct >= 12 ? '#35e0f5' : '#f5a623';
    }
    var _hint = document.getElementById('coefThHint');
    var _thEl = document.getElementById('coefTh');
    if (_hint && _thEl && typeof c === 'number') {
      var _th = parseFloat(_thEl.value || '0');
      if (_th > 0) {
        var _gap = c - _th;
        _hint.innerHTML = _gap >= 0
          ? '<span style="color:#18c98a;font-weight:700">✅ 当前系数 ' + c.toFixed(6) + ' 已达阈值 ' + _th.toFixed(4) + '（超出 +' + _gap.toFixed(6) + '）→ 会推送</span>'
          : '<span style="color:#f5a623;font-weight:700">⏳ 当前系数 ' + c.toFixed(6) + ' 低于阈值 ' + _th.toFixed(4) + '（差 ' + _gap.toFixed(6) + '）→ 暂不推送</span>';
      }
    }
  }).catch(function () {});
};
window.coefChHint = function () {
  var ch = document.getElementById('coefCh').value;
  var lab = document.getElementById('coefTargetLabel');
  var inp = document.getElementById('coefTarget');
  var gd = document.getElementById('coefGuide');
  var hint = document.getElementById('coefHint');
  if (hint) hint.innerHTML = '';
  // ⭐ 已恢复的云端配置优先，不清空用户已保存的值
  var _restored = window.__ARK_NOTI_RESTORED || {};
  if (ch === 'telegram') {
    lab.textContent = 'Bot Token|Chat ID';
    inp.placeholder = '123456:ABC...|你的chatId';
    if (_restored.tgToken && _restored.tgChat) inp.value = _restored.tgToken + '|' + _restored.tgChat;
    else inp.value = '';
    if (gd) gd.innerHTML =
      '<div style="font-weight:700;color:#35e0f5;margin-bottom:6px">✈️ 电报号(Telegram)绑定操作步骤</div>' +
      '<div>① 在 Telegram 里搜索官方机器人 <b style="color:#f5c46b">@BotFather</b> → 发送 <b style="color:#f5c46b">/newbot</b></div>' +
      '<div>② 按提示给机器人起名（昵称随便，用户名须以 <b style="color:#f5c46b">bot</b> 结尾，且全球唯一）</div>' +
      '<div>③ BotFather 会返回一串 <b style="color:#f5c46b">Bot Token</b>（形如 <code style="color:#35e0f5">8123456789:AAH...</code>）→ 复制它</div>' +
      '<div>④ 在 Telegram 里搜索你刚建的机器人，点 <b style="color:#f5c46b">开始 / START</b>，给它发一条任意消息</div>' +
      '<div>⑤ 搜索机器人 <b style="color:#f5c46b">@userinfobot</b> 并发送任意消息 → 它会回复你的 <b style="color:#f5c46b">Chat ID</b>（一串数字）</div>' +
      '<div>⑥ 回到本页：通道选「Telegram」→ 按格式 <b style="color:#f5c46b">BotToken|ChatID</b>（中间用竖线 | 分隔）粘贴 → 点「测试发送」</div>' +
      '<div>⑦ 测试成功后再点「添加提醒」保存</div>' +
      '<div style="margin-top:6px;color:#f2555f">⚠️ 格式必须是 <b>Token|ChatID</b>，中间必须有竖线 |；群组 ChatID 以 - 开头</div>' +
      '<div style="margin-top:4px;color:#8ba3c7">💡 没收到消息？确认机器人未被拉黑、且你已给它发过 START</div>';
  } else {
    lab.textContent = 'Server酱 SendKey';
    inp.placeholder = 'SCT...';
    /* FIX: 不再暴力清空 SendKey —— 已有合法值就保留，只有空值/格式不符才用已保存值或清空 */
    var _curV = String(inp.value || '').trim();
    if (_curV && /^SCT/i.test(_curV)) {
      /* 当前已是合法 SendKey，保留不动（避免回填后被清空） */
    } else if (_restored.wxKey) {
      inp.value = _restored.wxKey;
    } else {
      inp.value = '';
    }
    if (gd) gd.innerHTML =
      '<div style="font-weight:700;color:#35e0f5;margin-bottom:6px">📱 微信提醒配置说明</div>' +
      '<div>① 打开 <a href="https://sct.ftqq.com/" target="_blank" rel="noopener" style="color:#35e0f5">sct.ftqq.com</a> → 微信扫码登录</div>' +
      '<div>② 复制「SendKey」（<b style="color:#f5c46b">SCT 开头，约 40 位</b>）</div>' +
      '<div>③ 通道选「微信」→ 粘贴 SendKey → 点「测试发送」</div>' +
      '<div>④ 微信里看 <b style="color:#f5c46b">「服务通知」</b>（不是聊天列表）</div>' +
      '<div style="margin-top:6px;color:#f2555f">⚠️ 不要填 wxid_xxx（那是微信个人号 ID，不是 SendKey）</div>';
  }
};
/* ══════════ 提醒目标格式校验 ══════════ */

/* ⭐⭐ 全局安全兜底: 任何作用域调用 _wa() 都不会报错 */
if (typeof window._wa !== 'function') {
  window._wa = function () {
    var a = '';
    try { a = window.walletAddr || window.ARK_ADDR || ''; } catch (e) {}
    if (a) return a;
    try { a = localStorage.getItem('ark_auth_addr') || localStorage.getItem('ark_addr') || ''; } catch (e) {}
    return a || '';
  };
}
/* 把全局 _wa 提升为裸标识符，IIFE 外部代码也能直接用 _wa() */
var _wa = window._wa;


/* ══════════ 💾 保存綁定（係數提醒通道 → 雲端，付費期內免二次綁定） ══════════ */
window.saveCoefBinding = function () {
  var hint = document.getElementById('coefHint');
  var ch = (document.getElementById('coefCh') || {}).value || 'wechat';
  var target = ((document.getElementById('coefTarget') || {}).value || '').trim();
  var th = parseFloat((document.getElementById('coefTh') || {}).value || '0.5');
  function say(msg, color) {
    if (hint) { hint.innerHTML = msg; hint.style.color = color || '#8ba3c7'; }
  }
  // ① 取地址
  var addr = (window.arkState && window.arkState.addr) || window.ARK_ADDR || '';
  if (!addr) { try { addr = localStorage.getItem('ark_auth_addr') || localStorage.getItem('ark_addr') || ''; } catch (e) {} }
  if (!addr) { say('❌ 請先連接錢包（右上角）再保存', '#f2555f'); return; }
  // ② 校驗目標
  if (!target) { say('❌ 請先填寫 ' + (ch === 'wechat' ? 'Server醬 SendKey' : 'Bot Token|Chat ID'), '#f2555f'); return; }
  if (ch === 'wechat' && !/^SCT/i.test(target)) { say('❌ SendKey 格式不對，應以 SCT 開頭', '#f2555f'); return; }
  if (ch === 'wechat' && /^wxid_/i.test(target)) { say('❌ 這是微信個人號 ID，不是 SendKey', '#f2555f'); return; }

  say('⏳ 正在保存到雲端…', '#8ba3c7');

  var body = { addr: addr, tgToken: '', tgChat: '', wxKey: '' };
  if (ch === 'wechat') body.wxKey = target;
  else { var p = target.split('|'); body.tgToken = (p[0] || '').trim(); body.tgChat = (p[1] || '').trim(); }

  fetch('/api/noti-config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (!d || !d.ok) { say('❌ 保存失敗：' + ((d && d.error) || '未知錯誤'), '#f2555f'); return; }
    // ③ 建立/更新提醒订阅（阈值必须真正写入云端，失败要提示）
    if (th > 0 && th <= 1) {
      fetch('/api/coef-alert', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addr: addr, threshold: th, channel: ch, target: target })
      }).then(function (rr) { return rr.json(); }).then(function (dd) {
        if (dd && dd.ok) {
          // 写入成功 → 立即回读确认，并把 data-saved 标记上
          try {
            var _thEl = document.getElementById('coefTh');
            var _tgEl = document.getElementById('coefTarget');
            if (_thEl) { _thEl.setAttribute('data-saved', '1'); _thEl.removeAttribute('data-user'); }
            if (_tgEl) { _tgEl.setAttribute('data-saved', '1'); _tgEl.removeAttribute('data-user'); }
            window.__ARK_SAVED_ALERT = { id: dd.id, threshold: th, channel: ch, target: target };
            try { window.__ARK_ALERT_ADDR = _wa ? String(_wa() || '').toLowerCase() : ''; } catch (e) {}
            /* ⭐⭐ FIX: 刚保存完，输入框里是用户填的值，不能让 loadCoefAlerts 回读覆盖/清空。
               标记 __ARK_KEEP_INPUT 让回读逻辑跳过输入框。 */
            try { window.__ARK_KEEP_INPUT = Date.now(); } catch (e) {}
            if (typeof window.loadCoefAlerts === 'function') setTimeout(function(){ try { window.__ARK_KEEP_INPUT = 0; } catch(e){} }, 1200);
          } catch (e) {}
          console.log('[coef] 阈值已保存到云端: ' + th);
        } else {
          var _msg = (dd && dd.error === 'pro_required')
            ? '🔒 系数提醒是 VIP 功能，请先升级会员'
            : '❌ 阈值保存失败：' + ((dd && dd.error) || '未知错误');
          say(_msg, '#f2555f');
          console.warn('[coef] 阈值保存失败', dd);
        }
      }).catch(function (ee) {
        say('❌ 阈值写入网络错误：' + ee.message, '#f2555f');
      });
    } else {
      say('❌ 阈值需在 0.01 ~ 1 之间，当前值无效：' + th, '#f2555f');
      return;
    }
    var extra = '';
    if (d.proUntil && d.proUntil > Date.now()) {
      var days = Math.ceil((d.proUntil - Date.now()) / 86400000);
      extra = ' · PRO 有效期内（剩 ' + days + ' 天）免二次綁定';
    }
    say('✅ 已保存並綁定到雲端' + extra + '（換設備/清緩存不丟）', '#18c98a');
    // ⭐ 同步填回「提醒設置」面板的 wxKey，保持一致
    try {
      if (ch === 'wechat') { var w = document.getElementById('wxKey'); if (w) w.value = target; }
      else { var t1 = document.getElementById('tgToken'); var t2 = document.getElementById('tgChat');
             if (t1) t1.value = (p[0]||'').trim(); if (t2) t2.value = (p[1]||'').trim(); }
    } catch (e) {}
    if (typeof window.updateBindBtn === 'function') window.updateBindBtn(true);
    try { localStorage.setItem('ark_noti', JSON.stringify(body)); } catch (e) {}
  }).catch(function (e) {
    say('❌ 網絡錯誤：' + e.message, '#f2555f');
  });
};

function checkTargetFormat(ch, target) {
  if (ch === 'wechat') {
    if (/^wxid_/i.test(target)) {
      return '❌ <b>你填的是微信个人号 ID（wxid_开头），这不是 SendKey</b><br><br>' +
        '正确做法：<br>' +
        '① 打开 <a href="https://sct.ftqq.com/" target="_blank" style="color:#35e0f5">sct.ftqq.com</a> 微信扫码登录<br>' +
        '② 复制「SendKey」（<b>SCT 开头，约 40 位</b>）<br>' +
        '③ 粘贴到上面输入框';
    }
    if (!/^SCT/i.test(target)) {
      return '❌ SendKey 格式不对，应以 <b>SCT</b> 开头<br>请检查是否复制完整（约 40 位字符）';
    }
    if (target.length < 20) {
      return '❌ SendKey 太短（当前 ' + target.length + ' 位），应该是约 40 位<br>请重新完整复制';
    }
  } else if (ch === 'telegram') {
    if (target.indexOf('|') < 0) {
      return '❌ Telegram 格式应为：<b>BotToken|ChatID</b><br>例: 123456789:ABCdef...|123456789<br>中间用竖线 | 分隔';
    }
    var parts = target.split('|');
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(parts[0].trim())) {
      return '❌ Bot Token 格式不对（应为 数字:字母数字）';
    }
    if (!/^-?\d+$/.test(parts[1].trim())) {
      return '❌ Chat ID 应为纯数字（群组以 - 开头）';
    }
  }
  return null;
}
window.checkTargetFormat = checkTargetFormat;

/* ══════════ ⭐⭐ FIX: 用户输入保护 ══════════
   用户在 coefTh/coefTarget 里敲任何字，就打 data-user=1 标记，
   后续所有自动回填逻辑（loadCoefAlerts / 8秒定时器）看到这个标记就不再覆盖。
   这样用户可以从容填完再点保存，不会被定时刷新冲掉。 */
document.addEventListener('DOMContentLoaded', function () {
  try {
    ['coefTh', 'coefTarget'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      var mark = function () { try { el.setAttribute('data-user', '1'); } catch (e) {} };
      el.addEventListener('input', mark, { passive: true });
      el.addEventListener('change', mark, { passive: true });
      el.addEventListener('keyup', mark, { passive: true });
      el.addEventListener('paste', mark, { passive: true });
    });
    console.log('[coef] 用户输入保护已启用');
    /* ⭐ 便利功能：点进输入框自动全选已有内容，直接输入即覆盖，避免误拼接 */
    ['coefTh', 'coefTarget'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('focus', function () {
        try { setTimeout(function(){ el.select(); }, 10); } catch (e) {}
      });
    });
  } catch (e) { console.warn('[coef] 输入保护绑定失败', e); }
});

/* ══════════ 测试发送（验证通道配置）══════════ */
window.testCoefChannel = function () {
  var ch = document.getElementById('coefCh').value;
  var target = (document.getElementById('coefTarget').value || '').trim();
  var hint = document.getElementById('coefHint');
  if (!target) {
    hint.innerHTML = '❌ 请先在上方「提醒目标」输入框填入 ' + (ch === 'wechat' ? 'Server酱 SendKey' : 'BotToken|ChatID');
    hint.style.color = '#f2555f';
    return;
  }
  var fmtErr = checkTargetFormat(ch, target);
  if (fmtErr) { hint.innerHTML = fmtErr; hint.style.color = '#f2555f'; return; }

  hint.textContent = '⏳ 正在发送测试消息…';
  hint.style.color = '#8ba3c7';

  var body = { message: '🔔 ARK 工具站测试消息\n\n如果你收到这条消息，说明提醒配置正确！\n时间: ' + new Date().toLocaleString('zh-CN') };
  if (ch === 'wechat') body.wxKey = target;
  else {
    var p = target.split('|');
    body.tgToken = p[0].trim();
    body.tgChat = p[1].trim();
  }

  fetch('/api/notify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (d.ok) {
      hint.innerHTML = '✅ <b>发送成功！</b><br>请去微信「服务通知」查看（不是聊天列表）<br>若没收到，检查微信是否屏蔽了服务通知';
      hint.style.color = '#18c98a';
    } else {
      var msg = d.detail || d.error || '未知错误';
      if (/错误的Key|invalid.*key|AUTH/i.test(msg)) {
        hint.innerHTML = '❌ <b>SendKey 无效</b><br><br>' +
          '请重新获取：<br>' +
          '① 打开 <a href="https://sct.ftqq.com/" target="_blank" style="color:#35e0f5">sct.ftqq.com</a><br>' +
          '② 微信扫码登录 → 复制 SendKey<br>' +
          '③ 确认是 SCT 开头、约 40 位<br><br>' +
          '<span style="font-size:11px;opacity:.7">服务器返回: ' + msg + '</span>';
      } else {
        hint.innerHTML = '❌ 发送失败：' + msg;
      }
      hint.style.color = '#f2555f';
    }
  }).catch(function (e) {
    hint.innerHTML = '❌ 网络错误：' + e.message;
    hint.style.color = '#f2555f';
  });
};

window.addCoefAlert = function () {
  var _w = _wa(); if (!_w) { alert('请先连接钱包（右上角）'); return; }
  var th = parseFloat(document.getElementById('coefTh').value || '0');
  var ch = document.getElementById('coefCh').value;
  var target = (document.getElementById('coefTarget').value || '').trim();
  var hint = document.getElementById('coefHint');
  // ⭐ 修正: 系数范围 0.01~1（原代码写成 1-100 是 bug）
  if (!(th > 0 && th <= 1)) { hint.textContent = '❌ 阈值需在 0.01 ~ 1 之间（例: 0.5）'; hint.style.color = '#f2555f'; return; }
  if (!target) { hint.textContent = '❌ 请填提醒目标'; hint.style.color = '#f2555f'; return; }
  // ⭐ Key 格式预检
  var fmtErr = checkTargetFormat(ch, target);
  if (fmtErr) { hint.innerHTML = fmtErr; hint.style.color = '#f2555f'; return; }
  fetch('/api/coef-alert', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addr: _w, threshold: th, channel: ch, target: target })
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (d.ok) { hint.textContent = '✅ 已添加提醒（阈值 ' + th + ' · ' + (ch === 'wechat' ? '微信' : 'Telegram') + '）'; hint.style.color = '#18c98a'; loadCoefAlerts(); }
    else if (d.error === 'pro_required') { hint.innerHTML = '🔒 系数提醒是 <b>VIP</b> 功能，请先升级会员'; hint.style.color = '#f5a623'; }
    else { hint.textContent = '❌ ' + (d.error || '失败'); hint.style.color = '#f2555f'; }
  }).catch(function () { hint.textContent = '❌ 网络错误'; hint.style.color = '#f2555f'; });
};
window.loadCoefAlerts = function (_retry) {
  _retry = _retry || 0;
  var _a = _wa();
  /* ⭐ FIX: 切换钱包/地址后必须重置脏标记，否则新地址会沿用旧地址的回填值，
     造成"不同钱包登录显示同一个阈值"的错觉 */
  try {
    _a = _a ? String(_a).toLowerCase() : '';
    if (window.__ARK_ALERT_ADDR !== _a) {
      window.__ARK_ALERT_ADDR = _a;
      var _e1 = document.getElementById('coefTh');
      var _e2 = document.getElementById('coefTarget');
      var _e3 = document.getElementById('coefCh');
      /* ⭐⭐ FIX: 用户正在输入时不能清空！以前无条件 e.value='' ，配合下方 8 秒 setInterval
         定时调用，导致用户填一半就被清掉，"页面太快来不及保存"。
         现在只清 data-saved 标记，输入框有内容一律保留。 */
      if (_e1) _e1.removeAttribute('data-saved');
      if (_e2) _e2.removeAttribute('data-saved');
      if (_e3) _e3.removeAttribute('data-saved');
      window.__ARK_SAVED_ALERT = null;
      var _h = document.getElementById('coefHint');
      if (_h) _h.textContent = '';
      var _tb0 = document.getElementById('coefTbody');
      if (_tb0) _tb0.innerHTML = '<tr><td colspan="4" class="mut" style="text-align:center">加载中…</td></tr>';
    }
  } catch (e) {}
  if (!_a) {
    /* FIX: 地址未就绪（令牌登录尚未返回）时重试，而不是直接放弃 */
    if (_retry < 12) setTimeout(function () { window.loadCoefAlerts(_retry + 1); }, 500);
    return;
  }
  fetch('/api/coef-alert?addr=' + _a).then(function (r) { return r.json(); }).then(function (d) {
    var tb = document.getElementById('coefTbody');
    var list = d.alerts || [];
    if (tb) {
      if (!list.length) {
        tb.innerHTML = '<tr><td colspan="4" class="mut" style="text-align:center">暂无提醒</td></tr>';
      } else {
        tb.innerHTML = list.map(function (a) {
          var tgt = a.targetMasked || (a.target ? String(a.target).slice(0,8)+'...' : '');
          return '<tr><td>≥ ' + a.threshold + '</td><td>' + a.channel + '<div style="font-size:10px;opacity:.5;font-family:ui-monospace,monospace">' + tgt + '</div></td>' +
            '<td>' + (a.lastFired ? '<span style="color:#18c98a">已触发</span>' : '<span class="mut">监控中</span>') + '</td>' +
            '<td><button class="btn ghost mini" onclick="delCoefAlert(\'' + a.id + '\')">删除</button></td></tr>';
        }).join('');
      }
    }
    /* FIX: 回填保存的阈值/渠道/发送密钥到输入框，
       让用户重新登录后仍能看到自己的设置。
       优先取最近一条（按 created 倒序），确保显示的是最新阈值 */
    try {
      var al = null;
      if (list.length) {
        var _sorted = list.slice().sort(function (a, b) {
          return (Number(b && b.created) || 0) - (Number(a && a.created) || 0);
        });
        for (var i = 0; i < _sorted.length; i++) {
          var _it = _sorted[i];
          if (_it && Number(_it.threshold) > 0) { al = _it; break; }
        }
      }
      if (!al) {
        /* ⭐⭐ FIX: 当前地址没有任何提醒时，绝不显示别人的阈值——但也不能清空用户正在填的内容！
           以前无条件清空，配合 8 秒定时器，用户填一半就被抹掉，"页面太快来不及保存"。
           现在：用户正在输入 / 刚保存过 → 保留输入；否则只清标记不碰值。 */
        try {
          var _t1 = document.getElementById('coefTh');
          var _t2 = document.getElementById('coefTarget');
          var _ae = document.activeElement;
          var _typing = !!(_ae && (_ae.id === 'coefTh' || _ae.id === 'coefTarget'));
          var _justSaved = false;
          try { _justSaved = !!(window.__ARK_KEEP_INPUT && (Date.now() - window.__ARK_KEEP_INPUT) < 1500); } catch (e) {}
          if (_t1) _t1.removeAttribute('data-saved');
          if (_t2) _t2.removeAttribute('data-saved');
          if (!_typing && !_justSaved) {
            /* 只有在用户完全没在输入、也没刚保存时，才按地址隔离清理 */
            var _curAddr = _wa ? String(_wa() || '').toLowerCase() : '';
            var _lastAddr = '';
            try { _lastAddr = String(window.__ARK_INPUT_ADDR || ''); } catch (e) {}
            if (_curAddr && _lastAddr && _curAddr !== _lastAddr) {
              if (_t1) _t1.value = '';
              if (_t2) _t2.value = '';
              window.__ARK_SAVED_ALERT = null;
            }
          }
          try { window.__ARK_INPUT_ADDR = _wa ? String(_wa() || '').toLowerCase() : ''; } catch (e) {}
        } catch (e) {}
      }
      if (al) {
        var thEl = document.getElementById('coefTh');
        var chEl = document.getElementById('coefCh');
        var tgEl = document.getElementById('coefTarget');
        // 阈值：只要云端有值就写入（不依赖 data-saved 标记，避免首次登录被默认值 0.45 挡住）
        /* ⭐⭐ FIX: 用户手动改过输入框（data-user=1）→ 永不自动回填覆盖，避免"填一半被冲掉" */
        var _userTh = thEl && thEl.getAttribute('data-user') === '1';
        var _userTg = tgEl && tgEl.getAttribute('data-user') === '1';
        var _keepNow = false;
        try { _keepNow = !!(window.__ARK_KEEP_INPUT && (Date.now() - window.__ARK_KEEP_INPUT) < 1500); } catch (e) {}
        if (thEl && Number(al.threshold) > 0 && !_userTh && !_keepNow) {
          var _saved = String(al.threshold);
          thEl.value = _saved;
          thEl.setAttribute('data-saved', '1');
        }
        /* FIX: 先写 SendKey，再切通道 —— 反过来会被 coefChHint 清空 */
        if (tgEl && al.target && !_userTg && !_keepNow) {
          tgEl.value = String(al.target);
          tgEl.setAttribute('data-saved', '1');
        }
        if (chEl && al.channel) {
          chEl.value = al.channel;
          try { if (typeof coefChHint === 'function') coefChHint(); } catch (e) {}
        }
        /* FIX: 切通道后可能被 coefChHint 清空，最后再兜底写一次 SendKey */
        if (tgEl && al.target && tgEl.getAttribute('data-user') !== '1') {
          var _afterV = String(tgEl.value || '').trim();
          if (!_afterV && al.target) {
            tgEl.value = String(al.target);
            tgEl.setAttribute('data-saved', '1');
          }
        }
        window.__ARK_SAVED_ALERT = { id: al.id, threshold: al.threshold, channel: al.channel, target: al.target };
        try { window.arkUpdateStatus && window.arkUpdateStatus(); } catch (e) {}
        console.log('[coef] 已回填云端设置: 阈值=' + al.threshold);
      }
    } catch (e) { console.warn('[coef] 回填异常', e); }
  }).catch(function () {});
};
window.delCoefAlert = function (id) {
  fetch('/api/coef-alert/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ addr: _wa(), id: id }) })
    .then(function () { loadCoefAlerts(); });
};
document.addEventListener('DOMContentLoaded', function () {
  setTimeout(function () {
    if (typeof loadCoef === 'function') { loadCoef(); startCoefTicker(); }
    /* FIX: 页面加载后立即回填已保存的阈值/渠道/发送密钥 */
    try { window.loadCoefAlerts && window.loadCoefAlerts(); } catch (e) {}
    setTimeout(function () { try { window.loadCoefAlerts && window.loadCoefAlerts(); } catch (e) {} }, 2500);
  }, 1000);
});

/* FIX: 登录/钱包连接后自动回填（避免重新登录后设置消失） */
window.arkRefillAlerts = function () {
  try { window.loadCoefAlerts && window.loadCoefAlerts(); } catch (e) {}
};
setInterval(function () {
  try {
    if (typeof window.loadCoefAlerts !== 'function') return;
    var _cur = _wa ? String(_wa() || '').toLowerCase() : '';
    /* ⭐ FIX: 地址变了立刻重新拉取该地址自己的设置；地址没变则按需补填 */
    if (_cur && window.__ARK_ALERT_ADDR !== _cur) { window.loadCoefAlerts(); return; }
    var thEl = document.getElementById('coefTh');
    var tgEl = document.getElementById('coefTarget');
    /* ⭐⭐ FIX: 只在输入框"完全为空"时才自动回填。
       以前条件含 !_thSaved（未保存标记），用户填了内容但还没点保存时
       每8秒也会触发 loadCoefAlerts()，导致输入被清空、来不及点保存。
       现在只要用户输入框有内容就一律跳过，绝不打扰用户输入。 */
    /* coefTh 有默认值 0.45，不能用是否为空判断；改用 data-saved 标记：
       没保存过 → 才需要从云端回填。保存过 → 跳过，绝不打扰。 */
    var _thSaved = thEl && thEl.getAttribute('data-saved') === '1';
    var _tgSaved = tgEl && tgEl.getAttribute('data-saved') === '1';
    var _focusIn = false;
    try {
      var _ae = document.activeElement;
      _focusIn = !!(_ae && (_ae.id === 'coefTh' || _ae.id === 'coefTarget'));
    } catch (e) {}
    if (_focusIn) return;                       // 用户正在输入 → 完全不打扰
    if (!_thSaved && !_tgSaved) window.loadCoefAlerts();
  } catch (e) {}
}, 8000);

/* ══════════ PRO 升级：电脑/手机自适应引导 ══════════ */
document.addEventListener('DOMContentLoaded', function () {
  var ua = navigator.userAgent || '';
  var isMobile = /android|iphone|ipad|ipod|mobile/i.test(ua);
  var gd = document.getElementById('guideDesktop');
  var gm = document.getElementById('guideMobile');
  if (gd && gm) {
    if (isMobile) { gm.style.display = 'flex'; gd.style.display = 'none'; }
    else { gd.style.display = 'flex'; gm.style.display = 'none'; }
  }
  // 电脑端检测：有浏览器钱包插件？
  if (!isMobile) {
    setTimeout(function () {
      var hasExt = !!(window.ethereum || window.okxwallet);
      if (!hasExt) {
        var note = document.getElementById('guideDesktop');
        if (note) {
          var tip = document.createElement('div');
          tip.style.cssText = 'margin-top:8px;padding:8px 10px;border-radius:8px;background:rgba(242,85,95,.12);color:#f2555f;font-size:12px';
          tip.textContent = '⚠️ 未检测到浏览器钱包插件，请先安装（见下方链接）';
          note.appendChild(tip);
        }
      }
    }, 1500);
  }
});

/* ══════════ 升级广告 + 跨设备绑定 ══════════ */
(function () {
  // 显示升级广告（非 PRO 显示）
  function updateUpgradeBanner() {
    var b = document.getElementById('upgradeBanner');
    if (!b) return;
    var isPro = false;
    try { isPro = (window.ARK_PRO === true) || (typeof window.__proState === 'function' && window.__proState()); } catch (e) { isPro = false; }
    b.style.display = isPro ? 'none' : 'flex';
  }
  window.updateUpgradeBanner = updateUpgradeBanner;
  // 立即显示（不延迟，避免用户看不到）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { updateUpgradeBanner(); setTimeout(updateUpgradeBanner, 1600); });
  } else {
    updateUpgradeBanner(); setTimeout(updateUpgradeBanner, 1600);
  }

  // 登录状态变化时更新
  window.addEventListener('ark:auth', updateUpgradeBanner);

  // 生成绑定码（手机端升级后）
  window.genBindCode = function () {
    var addr = localStorage.getItem('ark_auth_addr') || localStorage.getItem('ark_addr') || (window.ARK_ADDR || '');
    if (!addr) { alert('请先登录（钱包）'); return; }
    fetch('/api/bind/gen', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addr: addr })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) {
        var box = document.getElementById('bindCodeBox');
        if (box) {
          box.style.display = 'block';
          box.innerHTML = '<div style="text-align:center"><div class="mut">你的绑定码（30分钟内有效）</div>' +
            '<div style="font-size:36px;font-weight:900;font-family:ui-monospace,monospace;color:#35e0f5;letter-spacing:6px;margin:12px 0">' + d.code + '</div>' +
            '<div class="mut" style="font-size:12px">在电脑端输入此码即可登录（免装插件）</div></div>';
        }
      } else alert('生成失败: ' + (d.error || '?'));
    });
  };

  // 用绑定码登录（电脑端）
  window.useBindCode = function () {
    var inp = document.getElementById('bindInput');
    var code = (inp && inp.value || '').trim().toUpperCase();
    if (code.length !== 6) { alert('请输入6位绑定码'); return; }
    fetch('/api/bind/use', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) {
        try {
          localStorage.setItem('ark_addr', d.addr);
          localStorage.setItem('ark_token', d.token);
        } catch (e) {}
        alert('✅ 登录成功！' + (d.pro ? ' VIP 已激活' : ''));
        location.reload();
      } else alert('❌ ' + (d.detail || d.error || '绑定码无效'));
    }).catch(function () { alert('❌ 网络错误'); });
  };

  // 检查令牌（电脑端自动登录）
  var tok = (function () { try { return localStorage.getItem('ark_token'); } catch (e) { return null; } })();
  if (tok) {
    fetch('/api/bind/me?token=' + tok).then(function (r) { return r.json(); }).then(function (d) {
      if (d.addr) {
        window.ARK_PRO = d.pro; window.ARK_ADDR = d.addr;
        try { localStorage.setItem('ark_addr', d.addr); } catch (e) {}
        updateUpgradeBanner();
        /* FIX: 登录成功后立即回填阈值/渠道/发送密钥，不再等定时器 */
        try { window.loadCoefAlerts && window.loadCoefAlerts(); } catch (e) {}
        setTimeout(function () { try { window.loadCoefAlerts && window.loadCoefAlerts(); } catch (e) {} }, 600);
      }
    }).catch(function () {});
  }
})();

/* ══════════ 广告位系统（VIP 可用） ══════════ */
/* ══════════ 生態系統區塊（ARK 生態工具集合）══════════ */
window.ARK_ECO_DEFAULT = [
  { id: "tgaccel", icon: "✈️", name: "電報號加速器", desc: "一鍵打開 Telegram · 多線路加速 · MTProto 客戶端加速", url: "tg-accel.html", badge: "NEW", free: true },
  { id: "quant", icon: "🤖", name: "量化機器人", desc: "幣安 10 分鐘永續 · AI 選幣 + 指標確認", url: "", badge: "SOON", free: false },
  { id: "poly5", icon: "📈", name: "Poly5 預測", desc: "BTC 5 分鐘事件合約預測系統", url: "", badge: "SOON", free: false }
];

window.loadSystems = function () {
  var grid = document.getElementById('ecoGrid');
  if (!grid) return;
  fetch('/api/systems').then(function (r) { return r.json(); }).then(function (d) {
    var list = (d.systems && d.systems.length) ? d.systems : window.ARK_ECO_DEFAULT;
    renderEco(list);
  }).catch(function () { renderEco(window.ARK_ECO_DEFAULT); });
};

function renderEco(list) {
  var grid = document.getElementById('ecoGrid');
  if (!grid) return;
  // 聊天已固定为大卡，栅格只显示其余系统
  list = (list || []).filter(function (x) { return x.id !== 'chat'; });
  var isPro = !!window.ARK_PRO;
  grid.innerHTML = list.map(function (s) {
    var soon = !s.url;
    var locked = false; // 統一由 data-pro 門控處理（避免雙重遮罩）
    var lock = locked ? '<div style="position:absolute;inset:0;background:rgba(6,11,24,.72);display:flex;align-items:center;justify-content:center;border-radius:12px;font-size:12px;color:var(--gold)">🔒 VIP</div>' : '';
    var badge = s.badge ? '<span style="position:absolute;top:10px;right:10px;font-size:10px;padding:2px 7px;border-radius:8px;background:rgba(53,224,245,.16);color:#35e0f5;font-weight:700">' + s.badge + '</span>' : '';
    var btn;
    if (soon) btn = '<button class="btn ghost mini" disabled style="width:100%;opacity:.55;cursor:not-allowed">即將上線</button>';
    else if (locked) btn = '<button class="btn primary mini" onclick="typeof openPay===\'function\'&&openPay()" style="width:100%">升級解鎖</button>';
    else btn = '<a class="btn primary mini" href="' + s.url + '" style="width:100%">進入使用</a>';
    return '<div class="card" style="position:relative;padding:18px;text-align:center;overflow:hidden">' + lock + badge +
      '<div style="font-size:34px;margin-bottom:10px;line-height:1">' + (s.icon || '🔗') + '</div>' +
      '<div style="font-weight:700;color:#e6edf3;font-size:15px">' + (s.name || '') + '</div>' +
      '<div class="mut" style="font-size:12.5px;margin:8px 0 14px;min-height:34px">' + (s.desc || '') + '</div>' +
      btn + '</div>';
  }).join('');
  var hint = document.getElementById('ecoHint');
  if (hint) hint.textContent = 'ARK 生態持續擴展中 · 新工具陸續上線';
}
window.renderEco = renderEco;

/* ══════════ 涡轮系数实时刷新 ══════════ */
var _coefTimer = null, _coefBase = null, _coefCache = null;
function startCoefTicker() {
  if (_coefTimer) clearInterval(_coefTimer);
  // ① 每 2 秒拉一次链上实时综合系数
  function pullChain() {
    fetch('/api/coef-live').then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) return;
      _coefCache = d;
      _coefBase = { min: d.min24h, max: d.max24h, released: d.released, total: d.total, pct: d.releasePct, cycle: d.cycleSec };
      // 实时刷新主数字
      var el = document.getElementById('coefScore');
      if (el && typeof d.coefficient === 'number') {
        el.textContent = d.coefficient.toFixed(6);
        el.style.color = d.coefficient >= 0.5 ? '#18c98a' : d.coefficient >= 0.3 ? '#35e0f5' : '#f5a623';
      }
      var mom = document.getElementById('coefMomentum');
      if (mom) {
        var mv = Number(d.momentum || 0) * 100;
        mom.textContent = (mv >= 0 ? '▲ +' : '▼ ') + mv.toFixed(4) + '%';
        mom.style.color = mv >= 0 ? '#18c98a' : '#ff5c7a';
      }
      var pr = document.getElementById('coefPr');
      if (pr) pr.textContent = (d.min24h||0).toFixed(4) + ' ~ ' + (d.max24h||0).toFixed(4);
      var bs = document.getElementById('coefBs');
      if (bs) bs.textContent = Number(d.released||0).toLocaleString('en-US',{maximumFractionDigits:0}) + ' / ' + Number(d.total||0).toLocaleString('en-US',{maximumFractionDigits:0});
      var to = document.getElementById('coefTo');
      if (to) to.textContent = Number(d.progress||0).toFixed(4) + '%';
      var tx = document.getElementById('coefTx');
      if (tx) tx.textContent = (d.cycleSec||0) + 's';
      var lbl = document.getElementById('coefLabel');
      if (lbl) lbl.textContent = d.coefficient >= 0.226 ? '🔥 区间上限' : d.coefficient >= 0.22 ? '📈 中高位' : '📉 中低位';
      var act = document.getElementById('coefActual');
      if (act && typeof d.actualRatePct === 'number') {
        act.textContent = d.actualRatePct.toFixed(2) + '%';
        act.style.color = d.actualRatePct >= 15 ? '#18c98a' : d.actualRatePct >= 12 ? '#35e0f5' : '#f5a623';
      }
      var src = document.getElementById('coefSrc');
      if (src) src.textContent = '链上实时 · ' + (d.pair ? d.pair.slice(0,8)+'…' : '') + ' · ' + new Date().toLocaleTimeString();
      // 阈值对比提示（实时更新）
      var hint = document.getElementById('coefThHint');
      var thEl = document.getElementById('coefTh');
      if (hint && thEl && typeof d.coefficient === 'number') {
        var th = parseFloat(thEl.value || '0');
        if (th > 0) {
          var gap = d.coefficient - th;
          if (gap >= 0) {
            hint.innerHTML = '<span style="color:#18c98a;font-weight:700">✅ 当前系数 ' + d.coefficient.toFixed(6) + ' 已达阈值 ' + th.toFixed(4) + '（超出 +' + gap.toFixed(6) + '）→ 会推送</span>';
          } else {
            hint.innerHTML = '<span style="color:#f5a623;font-weight:700">⏳ 当前系数 ' + d.coefficient.toFixed(6) + ' 低于阈值 ' + th.toFixed(4) + '（差 ' + gap.toFixed(6) + '）→ 暂不推送</span>';
          }
        }
      }
    }).catch(function () {});
  }
  pullChain();
  setInterval(pullChain, 2000);
  // ② 装饰元素 coefFlicker 同步显示链上真实系数（不再用随机数，避免与真实值不一致）
  _coefTimer = setInterval(function () {
    if (!_coefCache) return;
    var v = _coefCache.coefficient;
    if (typeof v !== 'number') return;
    var fl = document.getElementById('coefFlicker');
    if (fl) {
      fl.textContent = '链上实时 ' + v.toFixed(6);
      fl.style.color = v >= 0.5 ? '#18c98a' : v >= 0.3 ? '#35e0f5' : '#f5a623';
    }
  }, 1000);
}
window.startCoefTicker = startCoefTicker;
/* 阈值输入框改动 → 立即刷新对比提示 */
(function () {
  var bind = function () {
    var thEl = document.getElementById('coefTh');
    if (!thEl || thEl.__bound) return;
    thEl.__bound = true;
    thEl.addEventListener('input', function () { window.loadCoef(); });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();

/* ══════════ 长提示语音 + 音乐 + 振动（三合一，循环不停） ══════════ */
window.ARK_VOICE = true;   // 默认开启语音提醒(用户可在开关里关闭)
window._ARK_ALARM = { on:false, timers:[], ctx:null, voiceTimer:null, vibTimer:null, musicTimer:null };

/* 选甜美女声（中文优先） */
window.arkPickVoice = function () {
  try {
    if (!('speechSynthesis' in window)) return null;
    var voices = window.speechSynthesis.getVoices() || [];
    if (!voices.length) return null;
    var fem = /female|女|xiaoxiao|xiaoyi|yaoyao|huihui|xiaomo|mei|ting|sinji|婷|小娜|晓晓|晓伊|美|甜甜|zhiyu|tian/;
    var zhFem = voices.find(function(v){ return /zh|cmn|Chinese/i.test(v.lang) && fem.test(v.name); });
    if (zhFem) return zhFem;
    var zh = voices.find(function(v){ return /zh|cmn/i.test(v.lang); });
    if (zh) return zh;
    var anyFem = voices.find(function(v){ return fem.test(v.name); });
    if (anyFem) return anyFem;
    return voices[0];
  } catch(e) { return null; }
};
if ('speechSynthesis' in window) {
  try {
    window.speechSynthesis.onvoiceschanged = function(){ window.speechSynthesis.getVoices(); };
    window.speechSynthesis.getVoices();
  } catch(e){}
}

/* 检测是否有中文语音包 */
window.arkHasChineseVoice = function () {
  try {
    if (!('speechSynthesis' in window)) return false;
    var vs = window.speechSynthesis.getVoices() || [];
    return vs.some(function(v){ return /zh|cmn|Chinese/i.test(v.lang); });
  } catch(e){ return false; }
};

/* ── 音乐：合成一段约 8 秒的悦耳旋律（无需音频文件） ── */
window.arkMusic = function () {
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    if (!window._arkAC) window._arkAC = new AC();
    var ctx = window._arkAC;
    window._ARK_ALARM.ctx = ctx;
    if (ctx.state === 'suspended') ctx.resume();

    // 上行旋律：C5 E5 G5 C6 → 停顿 → G5 E5 C5（约 8 秒）
    var seq = [
      [523.25, 0.5], [659.25, 0.5], [783.99, 0.5], [1046.50, 1.0],   // C5 E5 G5 C6
      [783.99, 0.4], [659.25, 0.4], [523.25, 0.8],                   // G5 E5 C5
      [587.33, 0.4], [698.46, 0.4], [880.00, 1.2],                   // D5 F5 A5
      [880.00, 0.4], [783.99, 0.4], [659.25, 1.0]                    // A5 G5 E5
    ];
    var t = ctx.currentTime + 0.05;
    seq.forEach(function (n) {
      var osc = ctx.createOscillator();
      var g = ctx.createGain();
      osc.connect(g); g.connect(ctx.destination);
      osc.type = 'triangle';
      osc.frequency.value = n[0];
      g.gain.setValueAtTime(0.001, t);
      g.gain.exponentialRampToValueAtTime(0.45, t + 0.04);
      g.gain.exponentialRampToValueAtTime(0.25, t + n[1] * 0.5);
      g.gain.exponentialRampToValueAtTime(0.001, t + n[1]);
      osc.start(t);
      osc.stop(t + n[1] + 0.03);
      t += n[1] + 0.12;
    });
    return true;
  } catch(e) { return false; }
};

/* ── 长语音：把提醒拆成多段播报，总长约 10 秒 ── */
window.arkLongVoice = function (text) {
  try {
    if (!('speechSynthesis' in window)) return false;
    if (!window.arkHasChineseVoice()) return false;   // 无中文语音包则不念（用音乐+振动代替）
    window.speechSynthesis.cancel();
    var parts = text.split(/[，,。！!]/).filter(function(x){ return x.trim(); });
    if (parts.length < 2) parts = [text];
    var u = new SpeechSynthesisUtterance(parts.join('。'));
    var v = window.arkPickVoice();
    if (v) u.voice = v;
    u.lang = 'zh-CN';
    u.rate = 0.9;      // 稍慢 → 更清晰、更长
    u.pitch = 1.3;     // 甜美女声
    u.volume = 1.0;
    window.speechSynthesis.speak(u);
    return true;
  } catch(e) { return false; }
};

/* ══════════ 主提醒：循环播放，直到用户确认/切回页面 ══════════ */
window.speakArk = function (text) {
  window._ARK_ALARM = window._ARK_ALARM || { on:false, timers:[], ctx:null };
  var A = window._ARK_ALARM;
  window.arkStopAlarm();          // 先停掉上一个
  A.on = true;
  var played = false;

  // ① 立即：长语音 + 音乐 + 振动
  try { if (window.arkLongVoice(text)) played = true; } catch(e){}
  try { if (window.arkMusic()) played = true; } catch(e){}
  try { if (navigator.vibrate) { navigator.vibrate([500,200,500,200,800]); played = true; } } catch(e){}

  // ② 语音循环：每 ~12 秒重念一次
  A.voiceTimer = setInterval(function(){
    if (!A.on) return;
    try { window.arkLongVoice(text); } catch(e){}
  }, 12000);

  // ③ 音乐循环：每 ~9 秒重播一次
  A.musicTimer = setInterval(function(){
    if (!A.on) return;
    try { window.arkMusic(); } catch(e){}
  }, 9000);

  // ④ 振动循环：每 2.5 秒补一次短振（持续提醒）
  A.vibTimer = setInterval(function(){
    if (!A.on) return;
    try { if (navigator.vibrate) navigator.vibrate([300,150,300]); } catch(e){}
  }, 2500);

  // ⑤ 视觉：红色闪烁横幅 + 确认按钮
  try { window.arkAlarmBanner(text); } catch(e){}
  return played;
};

/* 停止提醒 */
window.arkStopAlarm = function () {
  var A = window._ARK_ALARM;
  if (!A) return;
  A.on = false;
  try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch(e){}
  try { if (navigator.vibrate) navigator.vibrate(0); } catch(e){}
  [A.voiceTimer, A.musicTimer, A.vibTimer].forEach(function(t){ try{ clearInterval(t); }catch(e){} });
  A.voiceTimer = A.musicTimer = A.vibTimer = null;
  try { var b = document.getElementById('arkAlarmBanner'); if (b) b.remove(); } catch(e){}
  window._arkAlarmStopped = true;
};

/* 视觉：红色闪烁横幅 + 「我知道了」按钮 */
window.arkAlarmBanner = function (text) {
  try {
    var old = document.getElementById('arkAlarmBanner'); if (old) old.remove();
    var d = document.createElement('div');
    d.id = 'arkAlarmBanner';
    d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;background:linear-gradient(90deg,#e63946,#f77f00,#e63946);color:#fff;padding:16px 18px;font-size:15px;font-weight:800;box-shadow:0 6px 24px rgba(0,0,0,.5);display:flex;align-items:center;gap:12px;animation:arkAlarmBlink 1s infinite';
    var span = document.createElement('div');
    span.style.cssText = 'flex:1;line-height:1.5';
    span.innerHTML = '🔔 提醒<br><span style="font-weight:600;font-size:13px">' + text + '</span>';
    var btn = document.createElement('button');
    btn.textContent = '我知道了';
    btn.style.cssText = 'background:#fff;color:#e63946;border:0;border-radius:8px;padding:10px 16px;font-weight:800;font-size:14px;cursor:pointer;white-space:nowrap';
    btn.onclick = function(){ window.arkStopAlarm(); };
    d.appendChild(span); d.appendChild(btn);
    if (!document.getElementById('arkAlarmStyle')) {
      var st = document.createElement('style'); st.id = 'arkAlarmStyle';
      st.textContent = '@keyframes arkAlarmBlink{0%,100%{opacity:1}50%{opacity:.75}}';
      document.head.appendChild(st);
    }
    document.body.appendChild(d);
  } catch(e){}
};

/* 首次用户交互解锁音频（浏览器要求） */
(function(){
  function markUnlocked(){
    window._arkAudioUnlocked = true;
    try {
      var st = document.getElementById('arkVoiceState');
      if (st) { st.textContent = '已解锁'; st.style.color = '#18c98a'; }
    } catch(e){}
  }
  function unlock(){
    var okVoice = false, okAudio = false;
    try {
      if ('speechSynthesis' in window) {
        var u = new SpeechSynthesisUtterance('');
        u.volume = 0; window.speechSynthesis.speak(u);
        okVoice = true;
      }
    } catch(e){}
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC && !window._arkAC) window._arkAC = new AC();
      if (window._arkAC && window._arkAC.state === 'suspended') window._arkAC.resume();
      okAudio = true;
    } catch(e){}
    if (okVoice || okAudio) markUnlocked();
    document.removeEventListener('touchstart', unlock);
    document.removeEventListener('click', unlock);
    document.removeEventListener('keydown', unlock);
  }
  document.addEventListener('touchstart', unlock, {once:true, passive:true});
  document.addEventListener('click', unlock, {once:true});
  document.addEventListener('keydown', unlock, {once:true});
  // 额外兜底: 页面可见性变化 / 滚动 / 任意指针动作都尝试解锁
  ['pointerdown','scroll','touchmove'].forEach(function(ev){
    document.addEventListener(ev, function(){ try{ unlock(); }catch(e){} }, {once:true, passive:true});
  });
  document.addEventListener('visibilitychange', function(){
    if (!document.hidden && window._ARK_ALARM && window._ARK_ALARM.on) window.arkStopAlarm();
  });
  window.addEventListener('focus', function(){
    if (window._ARK_ALARM && window._ARK_ALARM.on) window.arkStopAlarm();
  });
})();
window.arkUnlockAudio = function(){ window._arkAudioUnlocked = true; };

window.testVoice = function () {
  var ok = window.speakArk('ARK 提醒测试，长语音加音乐加振动，循环播放直到你确认');
  if (ok) { window.arkToast && window.arkToast('提醒已触发（长语音/音乐/振动，循环中）'); }
  else { window.arkToast && window.arkToast('已尝试提示（部分浏览器禁语音，已用音乐+振动代替）'); }
};
// 语音开关持久化
document.addEventListener('DOMContentLoaded', function () {
  var cb = document.getElementById('coefVoice');
  if (cb) {
    /* ⭐ FIX: 语音开关按钱包地址分键，不再跨钱包互相影响 */
    function _voiceKey() {
      var a = '';
      try { a = String((window.__ARK_UI_ADDR || (window._wa && window._wa()) || '')).toLowerCase(); } catch (e) {}
      return a ? ('ark_voice__' + a) : 'ark_voice';
    }
    function _loadVoice() {
      try {
        var _saved = localStorage.getItem(_voiceKey());
        cb.checked = (_saved === null) ? true : (_saved === '1');
        if (_saved === null) { try { localStorage.setItem(_voiceKey(), '1'); } catch (e) {} }
      } catch (e) { cb.checked = true; }
      window.ARK_VOICE = cb.checked;
    }
    _loadVoice();
    cb.addEventListener('change', function () {
      window.ARK_VOICE = cb.checked;
      try { localStorage.setItem(_voiceKey(), cb.checked ? '1' : '0'); } catch (e) {}
      if (cb.checked) window.speakArk('语音提醒已开启');
    });
    /* 切换钱包后重新读取该钱包自己的语音开关 */
    document.addEventListener('ark:addrchange', _loadVoice);
  }
});
// 轮询系数：达到本地阈值时语音播报（每30秒检查）
(function () {
  // 无冷却: 边沿触发(未达标 -> 达标 播报一次), 每次重新达标都单独提醒
  var _wasAbove = false;
  // FIX: 优先用后端 WS 推送的真实系数，回退到 coefScore 文本
  window.__ARK_REAL_COEF = null;
  setInterval(function () {
    if (!window.ARK_VOICE) return;
    var th = parseFloat((document.getElementById('coefTh') || {}).value || '0.5');
    var cur = window.__ARK_REAL_COEF;
    if (cur == null) {
      var el = document.getElementById('coefScore');
      if (!el) return;
      cur = parseFloat(el.textContent || '');
    }
    if (!(cur >= 0) || !(th > 0)) return;
    if (cur < th) { _wasAbove = false; return; }
    if (_wasAbove) return;          // 同一段达标期不重复播报
    _wasAbove = true;
    window.speakArk('注意，ARK 涡轮系数已达 ' + cur.toFixed(4) + '，超过阈值 ' + th.toFixed(4));
  }, 30000);
})();

/* ═══ 提醒状态面板实时刷新（系数/阈值/差距/进度/语音状态）═══ */
window.arkUpdateStatus = function () {
  try {
    var thEl = document.getElementById('coefTh');
    var th = thEl ? parseFloat(thEl.value || '0') : 0;
    var cur = window.__ARK_REAL_COEF;
    if (cur == null) {
      var sc = document.getElementById('coefScore');
      if (sc) cur = parseFloat(sc.textContent || '');
    }
    var curEl = document.getElementById('arkCurCoef');
    var thValEl = document.getElementById('arkThVal');
    var gapEl = document.getElementById('arkGapVal');
    var progEl = document.getElementById('arkProgVal');
    var fireEl = document.getElementById('arkFireState');
    var barEl = document.getElementById('arkProgBar');

    if (curEl) {
      if (cur >= 0) {
        curEl.textContent = Number(cur).toFixed(6);
        curEl.style.color = cur >= 0.5 ? '#18c98a' : cur >= 0.3 ? '#35e0f5' : '#f5a623';
      } else curEl.textContent = '—';
    }
    if (thValEl) thValEl.textContent = th > 0 ? Number(th).toFixed(6) : '未设置';

    if (cur >= 0 && th > 0) {
      var gap = th - cur;
      var pct = (cur / th) * 100;
      if (gapEl) {
        if (gap > 0) {
          gapEl.textContent = '还差 ' + gap.toFixed(6);
          gapEl.style.color = '#f5a623';
        } else {
          gapEl.textContent = '已超出 ' + Math.abs(gap).toFixed(6);
          gapEl.style.color = '#18c98a';
        }
      }
      if (progEl) {
        progEl.textContent = pct.toFixed(2) + '%';
        progEl.style.color = pct >= 100 ? '#18c98a' : pct >= 99.5 ? '#f5a623' : '#35e0f5';
      }
      if (barEl) barEl.style.width = Math.max(0, Math.min(100, pct)) + '%';
      if (fireEl) {
        if (cur >= th) {
          fireEl.textContent = '✅ 已达标（会推送）';
          fireEl.style.color = '#18c98a';
        } else if (pct >= 99.5) {
          fireEl.textContent = '⚠️ 临界（即将达标）';
          fireEl.style.color = '#f5a623';
        } else {
          fireEl.textContent = '⏳ 等待达标（不会推送）';
          fireEl.style.color = '#8a9bb0';
        }
      }
    }
  } catch (e) {}
};
setInterval(function () { try { window.arkUpdateStatus(); } catch (e) {} }, 2000);
document.addEventListener('DOMContentLoaded', function () { try { window.arkUpdateStatus(); } catch (e) {} });

/* ═══ 接近阈值预警（达到 99.5% 提前语音播报，只播一次）═══ */
(function () {
  var _nearFired = false;
  setInterval(function () {
    try {
      if (!window.ARK_VOICE) return;
      var thEl = document.getElementById('coefTh');
      var th = thEl ? parseFloat(thEl.value || '0') : 0;
      var cur = window.__ARK_REAL_COEF;
      if (cur == null) {
        var sc = document.getElementById('coefScore');
        if (sc) cur = parseFloat(sc.textContent || '');
      }
      if (!(cur >= 0) || !(th > 0)) return;
      var pct = (cur / th) * 100;
      if (cur >= th) { _nearFired = false; return; }   // 达标交给正式提醒
      if (pct < 99.5) { _nearFired = false; return; }
      if (_nearFired) return;
      _nearFired = true;
      window.speakArk('注意，ARK 涡轮系数已达 ' + Number(cur).toFixed(6) + '，非常接近你的阈值 ' + Number(th).toFixed(6) + '，马上要达标了');
      window.arkToast && window.arkToast('⚠️ 系数接近阈值 ' + pct.toFixed(2) + '%');
    } catch (e) {}
  }, 30000);
})();

/* ═══ 系数实时 WebSocket：后端达标即推送，页面立刻语音提醒（B方案）═══ */
(function () {
  var ws = null, retry = 0, closedByUs = false;
  function myAddr() {
    try {
      return (window.ARK_ADDR || localStorage.getItem('ark_auth_addr') || localStorage.getItem('ark_addr') || '').toLowerCase();
    } catch (e) { return ''; }
  }
  function connect() {
    try {
      var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      var a = myAddr();
      var q = a ? ('?addr=' + encodeURIComponent(a)) : '';
      ws = new WebSocket(proto + location.host + '/coef/ws' + q);
      ws.onopen = function () {
        retry = 0;
        // 登录后地址可能才拿到，补发一次 auth 声明
        var a2 = myAddr();
        if (a2) { try { ws.send(JSON.stringify({ type: 'auth', addr: a2 })); } catch (e) {} }
      };
      ws.onmessage = function (ev) {
        var d = null;
        try { d = JSON.parse(ev.data); } catch (e) { return; }
        if (!d || !d.type) return;
        if (d.type === 'coef') {
          // 真实系数 → 写进 __ARK_REAL_COEF，并刷新 coefScore 显示
          if (typeof d.coefficient === 'number') {
            window.__ARK_REAL_COEF = d.coefficient;
            var el = document.getElementById('coefScore');
            if (el) {
              el.textContent = d.coefficient.toFixed(4);
              el.style.color = d.coefficient >= 0.5 ? '#18c98a' : d.coefficient >= 0.3 ? '#35e0f5' : '#f5a623';
            }
          }
        } else if (d.type === 'coef_near') {
          var me2 = myAddr();
          if (d.addr && me2 && String(d.addr).toLowerCase() !== me2) return;
          try {
            if (window.ARK_VOICE) window.speakArk(d.text || 'ARK 涡轮系数非常接近阈值');
            window.arkToast && window.arkToast('⚠️ 系数已达阈值 ' + (d.percent||0).toFixed(2) + '%');
          } catch (e) {}
        } else if (d.type === 'coef_alert') {
          // 后端判定达标 → 仅播报给该地址本人的页面（按用户隔离）
          var me = myAddr();
          if (d.addr && me && String(d.addr).toLowerCase() !== me) return;
          try {
            if (window.ARK_VOICE) window.speakArk(d.text || 'ARK 涡轮系数已达阈值');
          } catch (e) {}
        }
      };
      ws.onclose = function () {
        if (closedByUs) return;
        retry = Math.min(retry + 1, 10);
        setTimeout(connect, Math.min(2000 * retry, 30000));
      };
      ws.onerror = function () { try { ws.close(); } catch (e) {} };
    } catch (e) {
      setTimeout(connect, 5000);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', connect);
  else connect();
  // 登录/切换钱包后，补发地址声明
  function pushAuth() {
    try { if (ws && ws.readyState === 1) { var a = myAddr(); if (a) ws.send(JSON.stringify({ type: 'auth', addr: a })); } } catch (e) {}
  }
  window.addEventListener('ark:auth', pushAuth);
  // FIX: 登录是异步的, 只在8秒内补发会漏。改为持续补发(每3秒, 最多40次=约2分钟)
  var _authTries = 0;
  var _authTimer = setInterval(function () {
    _authTries++;
    var a = myAddr();
    if (a) {
      // 一旦拿到地址, 立即声明给后端(多次声明无害, 后端幂等)
      try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'auth', addr: a })); } catch (e) {}
      // 拿到地址后再补发几次确保成功, 然后停止
      if (_authTries > 3) { clearInterval(_authTimer); }
    }
    if (_authTries >= 40) clearInterval(_authTimer);
  }, 3000);
  window.addEventListener('beforeunload', function () { closedByUs = true; try { ws && ws.close(); } catch (e) {} });
})();

/* ══════════ 涡轮系数 VIP 锁定 ══════════ */
function updateCoefLock() {
  var isPro = false;
  try { isPro = (window.ARK_PRO === true) || (typeof window.__proState === 'function' && window.__proState()); } catch (e) {}
  var lock = document.getElementById('coefProLock');
  var content = document.getElementById('coefContent');
  if (lock && content) {
    // ⭐ 修复: 未拿到 PRO 状态前(undefined)不锁死, 默认显示; 明确非PRO才隐藏
    if (isPro === true) {
      lock.style.display = 'none';
      content.style.display = 'block';
    } else if (window.ARK_PRO === false) {
      lock.style.display = 'block';
      content.style.display = 'none';
    } else {
      // 状态未知: 先显示内容, 避免下拉框被锁死弹不开
      lock.style.display = 'none';
      content.style.display = 'block';
    }
  }
}
window.updateCoefLock = updateCoefLock;

// ⭐ 主动轮询 /api/me 拿 PRO 状态(不依赖事件时序)
function refreshProState() {
  try {
    var addr = window.ARK_ADDR || '';
    if (!addr) { try { addr = localStorage.getItem('ark_addr') || ''; } catch (e) {} }
    if (!addr) return;
    fetch('/api/me?addr=' + encodeURIComponent(addr))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.addr) {
          window.ARK_PRO = !!d.pro;
          window.ARK_ADDR = d.addr;
          updateCoefLock();
        }
      }).catch(function () {});
  } catch (e) {}
}
window.refreshProState = refreshProState;

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function(){ updateCoefLock(); refreshProState(); });
else { updateCoefLock(); refreshProState(); }
// 多轮重试: 0.3s / 0.8s / 1.6s / 3s / 5s (覆盖钱包异步登录完成)
[300, 800, 1600, 3000, 5000].forEach(function (ms) { setTimeout(function () { refreshProState(); updateCoefLock(); }, ms); });
window.addEventListener('ark:auth', function () { updateCoefLock(); refreshProState(); });

/* ⭐ 手机语音解锁（首次用户交互后允许播放） */
(function(){
  function unlock(){
    try {
      if ('speechSynthesis' in window) {
        var u = new SpeechSynthesisUtterance('');
        u.volume = 0; window.speechSynthesis.speak(u);
      }
    } catch(e){}
    window._arkAudioUnlocked = true;
    document.removeEventListener('touchstart', unlock);
    document.removeEventListener('click', unlock);
  }
  document.addEventListener('touchstart', unlock, {once:true, passive:true});
  document.addEventListener('click', unlock, {once:true});
})();
window.arkUnlockAudio = function(){ window._arkAudioUnlocked = true; };

/* ══════════ 跨设备登录（独立区块） ══════════ */
window.useBindCode2 = function () {
  var el = document.getElementById('bindInput2');
  var code = (el && el.value || '').trim().toUpperCase();
  var st = document.getElementById('bindStatus2');
  if (code.length !== 6) { if (st) { st.textContent = '请输入6位绑定码'; st.style.color='#f2555f'; } return; }
  if (st) { st.textContent = '验证中…'; st.style.color=''; }
  fetch('/api/bind/use', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code })
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (d.ok) {
      try {
        localStorage.setItem('ark_addr', d.addr);
        localStorage.setItem('ark_token', d.token);
      } catch (e) {}
      window.ARK_PRO = d.pro; window.ARK_ADDR = d.addr;
      if (st) { st.textContent = '✅ 登录成功！' + (d.pro ? ' VIP 已激活' : ''); st.style.color='#18c98a'; }
      setTimeout(function () {
        if (typeof window.refreshAuth === 'function') window.refreshAuth();
        if (typeof window.updateUpgradeBanner === 'function') window.updateUpgradeBanner();
        location.reload();
      }, 1200);
    } else {
      if (st) { st.textContent = '❌ ' + (d.detail || d.error || '绑定码无效'); st.style.color='#f2555f'; }
    }
  }).catch(function () { if (st) { st.textContent = '❌ 网络错误'; st.style.color='#f2555f'; } });
};

/* ══════════ 记住输入（ARK数量 + 跨设备登录） ══════════ */
(function () {
  var KEY_ARK = 'ark_saved_amounts';   // 保存各输入框的ARK数量
  var KEY_TOKEN = 'ark_token';

  /* ⭐ FIX: 按钱包地址分键存储，不再全局共享。A 钱包存的数量不会出现在 B 钱包里。 */
  function _addrKey(suffix) {
    var a = '';
    try { a = (window.__ARK_UI_ADDR || '').toLowerCase(); } catch (e) {}
    if (!a) { try { a = String((window._wa && window._wa()) || '').toLowerCase(); } catch (e) {} }
    return a ? ('ark_saved_amounts__' + a) : KEY_ARK;
  }
  function getSaved() {
    try { return JSON.parse(localStorage.getItem(_addrKey()) || '{}'); } catch (e) { return {}; }
  }
  function saveAmount(id, val) {
    try {
      var m = getSaved(); m[id] = val;
      localStorage.setItem(_addrKey(), JSON.stringify(m));
    } catch (e) {}
  }
  // 自动保存 + 恢复（各 ARK 数量输入框）
  var IDS = ['cAmount', 'pfAmt', 'akAmt', 'aAmt'];
  document.addEventListener('DOMContentLoaded', function () {
    var saved = getSaved();
    IDS.forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      // 恢复
      if (saved[id] !== undefined && saved[id] !== '') { el.value = saved[id]; }
      // 输入时自动保存
      el.addEventListener('input', function () { saveAmount(id, el.value); });
      el.addEventListener('change', function () { saveAmount(id, el.value); });
    });
  });

  // 保存按钮（若页面有）
  window.saveArkAmount = function () {
    var saved = {};
    IDS.forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.value) saved[id] = el.value;
    });
    try { localStorage.setItem(_addrKey(), JSON.stringify(saved)); } catch (e) {}
    if (window.arkToast) window.arkToast('已保存 ARK 数量');
    else alert('✅ 已保存');
  };
  window.arkRestoreAmounts = function () {
    var saved = getSaved();
    IDS.forEach(function (id) {
      var el = document.getElementById(id);
      if (el && saved[id] !== undefined) el.value = saved[id];
    });
  };

  /* 跨设备登录持久化（已存 ark_token）+ 自动恢复 */
  window.arkAutoLogin = function () {
    var tok = '';
    try { tok = localStorage.getItem(KEY_TOKEN) || ''; } catch (e) {}
    if (!tok) {
      /* 没有 token 也要尝试回填：localStorage 里可能还有旧地址 */
      try { window.loadCoefAlerts && window.loadCoefAlerts(); } catch (e) {}
      return;
    }
    fetch('/api/bind/me?token=' + encodeURIComponent(tok)).then(function (r) {
      if (r.status === 401) { try { localStorage.removeItem(KEY_TOKEN); } catch(e){} return null; }
      return r.json();
    }).then(function (d) {
      if (!d || !d.addr) return;
      window.ARK_PRO = !!d.pro; window.ARK_ADDR = d.addr;
      try { localStorage.setItem('ark_auth_addr', d.addr); localStorage.setItem('ark_addr', d.addr); } catch (e) {}
      /* FIX: 登录成功后立即回填保存的阈值设置 */
      /* FIX: 登录成功后多档延迟回填，确保 DOM/输入框就绪后一定能拿到云端阈值 */
      try { window.__ARK_SAVED_ALERT = null; } catch (e) {}
      try { window.loadCoefAlerts && window.loadCoefAlerts(); } catch (e) {}
      try { setTimeout(function () { window.loadCoefAlerts && window.loadCoefAlerts(); }, 600); } catch (e) {}
      try { setTimeout(function () { window.loadCoefAlerts && window.loadCoefAlerts(); }, 1500); } catch (e) {}
      try { setTimeout(function () { window.loadCoefAlerts && window.loadCoefAlerts(); }, 3000); } catch (e) {}
      if (typeof window.updateUpgradeBanner === 'function') window.updateUpgradeBanner();
      if (typeof window.updateCoefLock === 'function') window.updateCoefLock();
      if (typeof window.applyGates === 'function') window.applyGates();
      if (window.arkToast) window.arkToast('已自动登录（' + d.addr.slice(0,6) + '...' + d.addr.slice(-4) + '）');
    }).catch(function () {});
  };
  // 启动时尝试自动登录
  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(function () { try { window.arkAutoLogin(); } catch(e){} }, 1000);
  });
})();

/* ══════════ 自定义下拉（替代原生select，TP浏览器兼容） ══════════ */
(function () {
  function buildCustomSelect(sel) {
    if (!sel || sel.dataset.customReady) return;
    sel.dataset.customReady = '1';
    // 创建自定义下拉
    var wrap = document.createElement('div');
    wrap.className = 'csel-wrap';
    wrap.style.cssText = 'position:relative;width:100%';
    var btn = document.createElement('div');
    btn.className = 'csel-btn';
    btn.style.cssText = 'padding:11px 14px;background:#0a101c;border:1px solid var(--line,#252d3f);border-radius:10px;color:#e6edf3;font-size:14px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;user-select:none;-webkit-tap-highlight-color:transparent';
    var list = document.createElement('div');
    list.className = 'csel-list';
    list.style.cssText = 'position:absolute;top:100%;left:0;right:0;z-index:1000;background:#0f1420;border:1px solid var(--line,#252d3f);border-radius:10px;margin-top:4px;max-height:260px;overflow-y:auto;display:none;box-shadow:0 8px 24px rgba(0,0,0,.5)';

    function render() {
      var cur = sel.options[sel.selectedIndex];
      btn.innerHTML = '<span>' + (cur ? cur.text : '请选择') + '</span><span style="opacity:.6">▼</span>';
      list.innerHTML = [].map.call(sel.options, function(o, i) {
        var act = o.selected ? 'background:rgba(53,224,245,.15);color:#35e0f5' : '';
        return '<div data-i="' + i + '" style="padding:11px 14px;cursor:pointer;font-size:14px;color:#e6edf3;' + act + '">' + o.text + '</div>';
      }).join('');
    }
    render();

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = list.style.display === 'block';
      document.querySelectorAll('.csel-list').forEach(function(l){ l.style.display='none'; });
      list.style.display = open ? 'none' : 'block';
    });
    list.addEventListener('click', function (e) {
      var t = e.target.closest('[data-i]');
      if (!t) return;
      e.stopPropagation();
      var idx = parseInt(t.getAttribute('data-i'), 10);
      sel.selectedIndex = idx;
      sel.value = sel.options[idx].value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      render();
      list.style.display = 'none';
    });
    // 同步 select 值变化
    sel.addEventListener('change', render);

    wrap.appendChild(btn);
    wrap.appendChild(list);
    sel.parentNode.insertBefore(wrap, sel);
  }

  document.addEventListener('click', function () {
    document.querySelectorAll('.csel-list').forEach(function(l){ l.style.display='none'; });
  });

  document.addEventListener('DOMContentLoaded', function () {
    // 只处理【可见的】原生 select（隐藏的 chips select 不处理）
    document.querySelectorAll('select').forEach(function (sel) {
      if (sel.offsetParent === null) return;  // 隐藏的跳过
      try { buildCustomSelect(sel); } catch(e){}
    });
    // 动态生成的（如 adMonths）延迟处理
    setTimeout(function () {
      document.querySelectorAll('select').forEach(function (sel) {
        if (sel.offsetParent === null) return;
        try { buildCustomSelect(sel); } catch(e){}
      });
    }, 1500);
  });
})();

/* ══════════ 推广中心 ══════════ */
window.loadReferral = function () {
  var addr = (window.ARK_ADDR) || (function(){ try { return localStorage.getItem('ark_auth_addr') || localStorage.getItem('ark_addr'); } catch(e){ return null; } })();
  if (!addr) return;
  fetch('/api/ref/me?addr=' + encodeURIComponent(addr)).then(function(r){return r.json()}).then(function(d){
    var set = function(id,v){var e=document.getElementById(id); if(e) e.textContent=v;};
    set('refCode', d.code || '—');
    set('refEarnArk', (d.earnings && d.earnings.ark || 0).toFixed(4));
    set('refEarnToday', (d.todayEarned || 0).toFixed(4));
    if (d.levels) { set('refL1', d.levels.l1); set('refL2', d.levels.l2); set('refL3', d.levels.l3); }
    window._refCode = d.code;
  }).catch(function(){});
  // 收益流水
  fetch('/api/ref/log?addr=' + encodeURIComponent(addr)).then(function(r){return r.json()}).then(function(d){
    var box = document.getElementById('refLog');
    if (!box) return;
    var list = d.log || [];
    if (!list.length) { box.textContent = '暂无收益记录'; return; }
    box.innerHTML = list.slice(0,20).map(function(x){
      return '<div style="padding:3px 0;border-bottom:1px dashed #1e2941">' +
        new Date(x.ts).toLocaleString() + ' · L' + x.level + ' · <span style="color:#18c98a">+' + x.amount.toFixed(4) + ' ARK</span></div>';
    }).join('');
  }).catch(function(){});
};
window.copyRefLink = function () {
  if (!window._refCode) { alert('请先连接钱包'); return; }
  var link = location.origin + '/?ref=' + window._refCode;
  if (navigator.clipboard) navigator.clipboard.writeText(link).then(function(){ alert('✅ 推广链接已复制\n' + link); });
  else alert(link);
};
window.refWithdraw = function () {
  var addr = window.ARK_ADDR || (function(){ try { return localStorage.getItem('ark_auth_addr'); } catch(e){ return null; } })();
  var amt = parseFloat((document.getElementById('refWithdrawAmt')||{}).value || '0');
  if (!addr) { alert('请先连接钱包'); return; }
  if (!(amt > 0)) { alert('请输入提现数量'); return; }
  fetch('/api/ref/withdraw', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({addr:addr, amount:amt, currency:'ARK'}) })
    .then(function(r){return r.json()}).then(function(d){
      if (d.ok) { alert('✅ 提现申请已提交：' + amt + ' ARK'); loadReferral(); }
      else alert('❌ ' + (d.error || '失败'));
    }).catch(function(){ alert('网络错误'); });
};
// 自动绑定推荐码（URL ?ref=CODE）
(function(){
  try {
    var m = location.search.match(/[?&]ref=([A-Z0-9-]+)/i);
    if (m) { localStorage.setItem('ark_ref_code', m[1]); }
  } catch(e){}
})();
// 登录后自动注册推广 + 绑定上级
(function(){
  var orig = window.refreshAuth;
  document.addEventListener('DOMContentLoaded', function(){
    setTimeout(function(){
      var addr = (function(){ try { return localStorage.getItem('ark_auth_addr') || localStorage.getItem('ark_addr'); } catch(e){ return null; } })();
      if (!addr) return;
      var ref = ''; try { ref = localStorage.getItem('ark_ref_code') || ''; } catch(e){}
      fetch('/api/ref/bind', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({addr:addr, code:ref}) })
        .then(function(){ loadReferral(); }).catch(function(){});
      setTimeout(loadReferral, 500);
    }, 1500);
  });
})();

/* ══════════ 推广二维码 + 海报 ══════════ */
window._ensureRefCode = function () {
  var addr = window.ARK_ADDR || (function(){ try { return localStorage.getItem('ark_auth_addr') || localStorage.getItem('ark_addr'); } catch(e){ return null; } })();
  // ⭐ 若本地无地址 → 尝试从钱包直接取（已连接过的钱包）
  if (!addr && window.ethereum) {
    return window.ethereum.request({ method: 'eth_accounts' }).then(function(accs){
      if (accs && accs.length) { window.ARK_ADDR = accs[0]; return _ensureRefCodeWith(accs[0]); }
      throw new Error('NO_ADDR');
    }).catch(function(){ throw new Error('NO_ADDR'); });
  }
  if (!addr) return Promise.reject(new Error('NO_ADDR'));
  return _ensureRefCodeWith(addr);
};
function _ensureRefCodeWith(addr) {
  if (window._refCode) return Promise.resolve(window._refCode);
  var ref = ''; try { ref = localStorage.getItem('ark_ref_code') || ''; } catch(e){}
  return fetch('/api/ref/bind', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({addr:addr, code:ref}) })
    .then(function(r){return r.json()}).then(function(d){
      if (d && d.code) { window._refCode = d.code; return d.code; }
      throw new Error('NO_CODE');
    });
};

window.showRefQR = function () {
  window._ensureRefCode().then(function(){ _showRefQRRaw(); }).catch(function(e){
    alert(e.message === 'NO_ADDR' ? '请先连接钱包（右上角登录）' : '推广码获取失败，请重试');
  });
};
function _showRefQRRaw() {
  var box = document.getElementById('refQR');
  if (!box) return;
  var link = location.origin + '/?ref=' + window._refCode;
  if (box.style.display === 'block') { box.style.display = 'none'; return; }
  box.innerHTML = '';
  box.style.display = 'block';
  if (window.QRCode) {
    new QRCode(box, { text: link, width: 144, height: 144, correctLevel: QRCode.CorrectLevel.M });
  } else {
    box.innerHTML = '<div style="color:#000;font-size:11px;padding:8px">二维码库未加载<br>' + window._refCode + '</div>';
  }
};
window.genRefPoster = function () {
  window._ensureRefCode().then(function(){ _genRefPosterRaw(); }).catch(function(e){
    if (e.message === 'NO_ADDR') {
      _showPosterModal2('请先连接钱包', '点击右上角「钱包登录」连接后，再生成推广海报');
      if (typeof window.connectWallet === 'function') { try { window.connectWallet(); } catch(err){} }
    } else {
      _showPosterModal2('获取失败', '推广码获取失败：' + e.message + '，请重试');
    }
  });
};
function _genRefPosterRaw() {
  var link = location.origin + '/?ref=' + window._refCode;
  var cv = document.createElement('canvas');
  cv.width = 750; cv.height = 1000;
  var x = cv.getContext('2d');
  // 背景
  var g = x.createLinearGradient(0, 0, 750, 1000);
  g.addColorStop(0, '#0a0e17'); g.addColorStop(0.5, '#111a2e'); g.addColorStop(1, '#0f1420');
  x.fillStyle = g; x.fillRect(0, 0, 750, 1000);
  // 光晕
  var rg = x.createRadialGradient(375, 250, 50, 375, 250, 450);
  rg.addColorStop(0, 'rgba(53,224,245,.22)'); rg.addColorStop(1, 'rgba(53,224,245,0)');
  x.fillStyle = rg; x.fillRect(0, 0, 750, 1000);
  // 边框
  x.strokeStyle = 'rgba(53,224,245,.35)'; x.lineWidth = 3;
  x.strokeRect(20, 20, 710, 960);
  // 品牌
  x.fillStyle = '#35e0f5'; x.font = 'bold 32px sans-serif'; x.textAlign = 'center';
  x.fillText('ARK CITIZEN TOOLS', 375, 95);
  x.fillStyle = '#8b95a8'; x.font = '18px sans-serif';
  x.fillText('邀请好友 · 赚取持续收益', 375, 132);
  // 头像圆
  x.beginPath(); x.arc(375, 230, 52, 0, Math.PI * 2);
  x.fillStyle = 'rgba(53,224,245,.15)'; x.fill();
  x.strokeStyle = 'rgba(53,224,245,.5)'; x.lineWidth = 2; x.stroke();
  x.fillStyle = '#35e0f5'; x.font = 'bold 34px sans-serif';
  x.fillText('ARK', 375, 243);
  // 收益说明
  x.fillStyle = '#e6edf3'; x.font = 'bold 40px sans-serif';
  x.fillText('三级分润', 375, 340);
  x.fillStyle = '#18c98a'; x.font = 'bold 56px sans-serif';
  x.fillText('15% · 5% · 2%', 375, 410);
  x.fillStyle = '#8b95a8'; x.font = '20px sans-serif';
  x.fillText('推荐好友升级 VIP，持续获得 ARK 收益', 375, 455);
  // QR
  if (window.QRCode) {
    var qrBox = document.createElement('div');
    qrBox.style.cssText = 'position:absolute;left:-9999px';
    document.body.appendChild(qrBox);
    new QRCode(qrBox, { text: link, width: 240, height: 240, correctLevel: QRCode.CorrectLevel.M });
    setTimeout(function () {
      var qc = qrBox.querySelector('canvas') || qrBox.querySelector('img');
      if (qc) {
        x.fillStyle = '#fff';
        x.fillRect(255, 500, 240, 240);
        try { x.drawImage(qc, 255, 500, 240, 240); } catch (e) {}
      }
      // 推广码
      x.fillStyle = '#35e0f5'; x.font = 'bold 34px monospace';
      x.fillText(window._refCode, 375, 800);
      x.fillStyle = '#8b95a8'; x.font = '16px sans-serif';
      x.fillText('扫码注册 或 输入推广码', 375, 840);
      x.fillStyle = '#5a6779'; x.font = '15px sans-serif';
      x.fillText(location.host, 375, 900);
      // 显示海报（弹窗，长按保存）
      var dataUrl = cv.toDataURL('image/png');
      qrBox.remove();
      _showPosterModal(dataUrl, 'ARK-推广海报-' + window._refCode + '.png');
    }, 400);
  } else {
    x.fillStyle = '#fff'; x.fillRect(255, 500, 240, 240);
    x.fillStyle = '#000'; x.font = '16px sans-serif';
    x.fillText('QR:', 375, 620);
  }
};

/* ⭐ 海报弹窗（显示图片，长按保存） */
window._showPosterModal = function (dataUrl, filename) {
  // ⭐ 上传到服务器 → 新标签打开图片（TP内长按/下载最可靠）
  fetch('/api/saveimg', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({data:dataUrl}) })
    .then(function(r){return r.json()}).then(function(d){
      if (d && d.url) {
        // 用页面内展示 + 提供"在新窗口打开"按钮
        _renderPosterModal(d.url, filename, true);
      } else {
        _renderPosterModal(dataUrl, filename, false);
      }
    }).catch(function(){ _renderPosterModal(dataUrl, filename, false); });
};
function _renderPosterModal(imgUrl, filename) {
  var old = document.getElementById('posterModal');
  if (old) old.remove();
  var m = document.createElement('div');
  m.id = 'posterModal';
  m.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(6,11,24,.96);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px;overflow:auto';
  m.innerHTML =
    '<div style="color:#35e0f5;font-size:15px;font-weight:700;margin-bottom:12px;text-align:center">📸 截屏保存到相册<br><span style="color:#8b95a8;font-size:12px;font-weight:400">（电源键 + 音量键）</span></div>' +
    '<img id="arkPosterImg" src="' + imgUrl + '" style="max-width:94%;max-height:68vh;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.6);-webkit-touch-callout:default;-webkit-user-select:auto;user-select:auto">' +
    '<button onclick="document.getElementById(\'posterModal\').remove()" style="margin-top:16px;padding:12px 46px;background:#1b2436;color:#e6edf3;border:1px solid #232c3d;border-radius:10px;font-size:15px;cursor:pointer">关闭</button>';
  document.body.appendChild(m);
};

/* ══════════ 链上推荐系统（合约交互） ══════════ */
(function () {
  var REFERRAL = "0x5e715816cc6d726b47f7bf3f4ee5ed34fb2615b4";
  var ARK = "0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D";
  var SEL = {
    referrer: "0x2cf003c2",     // referrer(address)
    earned: "0x008cc262",       // earned(address)
    claimable: "0xc7b92dcb",    // claimable(address)
    withdrawn: "0x8b8e5d93",    // withdrawn(address)
    setReferrer: "0xa18a7bfc",  // setReferrer(address)
    withdraw: "0x3ccfd60b",     // withdraw()
    getRates: "0xc3f909d4"      // getRates()
  };
  function pad(h) { return h.replace(/^0x/, "").padStart(64, "0"); }
  function aArg(a) { return pad(String(a).toLowerCase()); }
  function fromHex(h) { try { return BigInt(h || "0x0"); } catch(e){ return 0n; } }

  function prov() { return window.arkProvider ? window.arkProvider() : (window.ethereum || null); }
  function rpc(method, params) {
    var p = prov();
    if (p && p.request) return p.request({ method: method, params: params });
    // 回退：公共 RPC
    return fetch("https://bsc-dataseed.bnbchain.org", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params })
    }).then(function(r){return r.json()}).then(function(d){ return d.result; });
  }

  // 读取链上推广数据
  window.loadRefOnChain = function () {
    var addr = window.ARK_ADDR || (function(){ try { return localStorage.getItem("ark_auth_addr"); } catch(e){ return null; } })();
    if (!addr) return;
    // 我的推荐人
    rpc("eth_call", [{ to: REFERRAL, data: SEL.referrer + aArg(addr) }, "latest"]).then(function(res){
      var ref = "0x" + (res || "").slice(-40);
      window._myReferrer = (ref === "0x0000000000000000000000000000000000000000") ? null : ref;
    }).catch(function(){});
    // 我的可提取收益
    rpc("eth_call", [{ to: REFERRAL, data: SEL.earned + aArg(addr) }, "latest"]).then(function(res){
      var e = Number(fromHex(res)) / 1e18;
      window._myEarned = e;
      var el = document.getElementById("refChainEarned");
      if (el) el.textContent = e.toFixed(6) + " ARK";
    }).catch(function(){});
    rpc("eth_call", [{ to: REFERRAL, data: SEL.withdrawn + aArg(addr) }, "latest"]).then(function(res){
      var w = Number(fromHex(res)) / 1e18;
      window._myWithdrawn = w;
      var el = document.getElementById("refChainWithdrawn");
      if (el) el.textContent = w.toFixed(6) + " ARK";
    }).catch(function(){});
  };

  // 绑定推荐人（链上）
  window.bindReferrer = function () {
    var code = (document.getElementById("bindRefInput") || {}).value || "";
    code = code.trim();
    var ref = code;
    // 支持"推广码 ARK-XXXXXX" → 需要先解析成地址（链下查）
    if (/^ARK-/i.test(code) || code.length !== 42) {
      fetch("/api/ref/resolve?code=" + encodeURIComponent(code)).then(function(r){return r.json()}).then(function(d){
        if (d && d.addr) { _doBind(d.addr); }
        else alert("推广码无效");
      }).catch(function(){ alert("查询失败"); });
      return;
    }
    _doBind(ref);
  };
  function _doBind(ref) {
    var addr = window.ARK_ADDR || (function(){ try { return localStorage.getItem("ark_auth_addr"); } catch(e){ return null; } })();
    if (!addr) { alert("请先连接钱包"); return; }
    var p = prov();
    if (!p) { alert("未检测到钱包"); return; }
    if (window._myReferrer) { alert("你已绑定推荐人（不可更改）"); return; }
    var data = SEL.setReferrer + aArg(ref);
    p.request({ method: "eth_sendTransaction", params: [{ from: addr, to: REFERRAL, data: data, value: "0x0" }] })
      .then(function(h){ alert("✅ 绑定成功！交易: " + String(h).slice(0,20) + "..."); setTimeout(loadRefOnChain, 3000); })
      .catch(function(e){ alert("❌ 绑定失败: " + ((e && e.message) || "取消")); });
  }

  // 提取链上收益
  window.withdrawOnChain = function () {
    var addr = window.ARK_ADDR || (function(){ try { return localStorage.getItem("ark_auth_addr"); } catch(e){ return null; } })();
    if (!addr) { alert("请先连接钱包"); return; }
    if (!(window._myEarned > 0)) { alert("暂无可提取收益"); return; }
    var p = prov();
    if (!p) { alert("未检测到钱包"); return; }
    /*if (window._myWithdrawn > 0) { alert("已提取: " + window._myWithdrawn + " ARK"); return; }*/
    var data = SEL.withdraw;
    if (p.request) {
      p.request({ method: "eth_sendTransaction", params: [{ from: addr, to: REFERRAL, data: data, value: "0x0" }] })
        .then(function(h){ alert("✅ 提现成功！交易: " + String(h).slice(0,20) + "..."); setTimeout(loadRefOnChain, 3000); })
        .catch(function(e){ alert("❌ 提现失败: " + ((e && e.message) || "取消")); });
    } else {
      // TP deep link 转账不行（合约调用）→ 提示
      alert("请在钱包内操作提现");
    }
  };

  document.addEventListener("DOMContentLoaded", function(){
    setTimeout(loadRefOnChain, 2000);
  });
})();

/* ══════════ 收益看板（真实 ARK 利率 + Rebase 倒计时） ══════════ */
(function () {
  var _stakes = null;
  // 方案 → modeId 映射
  var PLAN_MODE = { flex:1, "180":1, "360":3, "540":4, "720":5, long:6, max:100 };

  // 拉取官方质押数据
  function loadStakes() {
    return fetch('/api/stakes').then(function(r){return r.json()}).then(function(d){
      _stakes = d;
      var modes = d.all || d.modes || [];
      // 显示当前方案利率
      var plan = (document.getElementById('pfPlan')||{}).value || '360';
      var mid = PLAN_MODE[plan] || 3;
      var m = modes.find(function(x){return x.modeId===mid});
      if (m) {
        var el = document.getElementById('pfRateShow');
        if (el) el.textContent = (m.rate*100).toFixed(4) + '% / 12h';
      }
      return d;
    }).catch(function(){return null});
  }

  // 计算下次 rebase（北京时间 00:00 / 12:00）
  function nextRebase() {
    var now = new Date();
    // 北京时间 = UTC+8
    var bj = new Date(now.getTime() + 8*3600*1000);
    var h = bj.getUTCHours();
    var next = new Date(bj);
    if (h < 12) { next.setUTCHours(12,0,0,0); }
    else { next.setUTCDate(next.getUTCDate()+1); next.setUTCHours(0,0,0,0); }
    // 转回真实时间
    return new Date(next.getTime() - 8*3600*1000);
  }

  // 倒计时更新
  function tickCountdown() {
    var next = nextRebase();
    var diff = Math.max(0, Math.floor((next.getTime() - Date.now())/1000));
    var hh = String(Math.floor(diff/3600)).padStart(2,'0');
    var mm = String(Math.floor((diff%3600)/60)).padStart(2,'0');
    var ss = String(diff%60).padStart(2,'0');
    var cd = document.getElementById('pfCountdown');
    if (cd) cd.textContent = hh+':'+mm+':'+ss;
    var nx = document.getElementById('pfNext');
    if (nx) {
      var bj = new Date(next.getTime()+8*3600*1000);
      nx.textContent = bj.getUTCHours().toString().padStart(2,'0') + ':00 (北京时间)';
    }
  }
  function _stakeKey() {
    var a = '';
    try { a = String((window.__ARK_UI_ADDR || (window._wa && window._wa()) || '')).toLowerCase(); } catch (e) {}
    return a ? ('ark_stake_start__' + a) : 'ark_stake_start';
  }
  window._arkStakeKey = _stakeKey;
  function updateTracked() {
    var startTs = (function(){ try { return parseInt(localStorage.getItem(_stakeKey())||'0',10); } catch(e){ return 0; } })();
    if (!startTs) return;
    var el = document.getElementById('pfTracked');
    if (!el) return;
    var ms = Date.now() - startTs;
    var h = Math.floor(ms/3600000), m = Math.floor((ms%3600000)/60000), sec = Math.floor((ms%60000)/1000);
    el.textContent = h + '时' + m + '分' + sec + '秒';
  }
  setInterval(updateTracked, 1000);
  updateTracked();
  setInterval(tickCountdown, 1000);
  tickCountdown();

  // 计算收益（复利，每12h一次）
    // 永久质押利率（官方数据反推）
  var PERM_RATE = 0.003712;   // 每12h (0.3712%)

  // 获取/设置跟踪起始时间
  function getStartTime() {
    try {
      var t = localStorage.getItem(_stakeKey());
      return t ? parseInt(t, 10) : 0;
    } catch(e){ return 0; }
  }
  function setStartTime(ts) {
    try { localStorage.setItem(_stakeKey(), String(ts)); } catch(e){}
  }

  window.pfFetch = function (resetStart) {
    var amt = parseFloat((document.getElementById('pfAmt')||{}).value || '0');
    var plan = (document.getElementById('pfPlan')||{}).value || '360';
    if (!(amt > 0)) return;

    // ⭐ 起始时间：用户必须填（或点默认现在）
    var startTs = getStartTime();
    if (!startTs) {
      // 未设置时间 → 提示用户填
      var hint = document.getElementById('pfHint');
      if (hint) {
        hint.innerHTML = '⚠️ 请先选择【质押开始时间】（你开始质押的时刻），再查看收益';
        hint.style.color = '#f5c46b';
      }
      // 默认用现在（但提示用户改）
      startTs = Date.now();
      setStartTime(startTs);
    } else {
      var hint2 = document.getElementById('pfHint');
      if (hint2) hint2.textContent = '';
    }

    loadStakes().then(function(d){
      // 永久质押用固定利率；其他用官方
      var rate;
      if (plan === 'max' || plan === 'long') { rate = PERM_RATE; }
      else {
        var modes = (d && (d.all || d.modes)) || [];
        var mid = PLAN_MODE[plan] || 3;
        var m = modes.find(function(x){return x.modeId===mid});
        rate = m ? m.rate : 0.002;
      }
      // ⭐ 按"从起始时间到现在"计算
      var elapsedMs = Date.now() - startTs;
      var elapsedH = elapsedMs / 3600000;
      var periods = elapsedH / 12;   // 每12h一次
      var earned = amt * (Math.pow(1 + rate, periods) - 1);
      var cur = amt + earned;

      return fetch('/api/chain').then(function(r){return r.json()}).then(function(c){
        var price = c.price || 0;
        var set = function(id,v){var e=document.getElementById(id);if(e)e.textContent=v;};
        set('pfUsd', '$' + (amt*price).toLocaleString(undefined,{maximumFractionDigits:2}));
        set('pfEarnArk', '+' + earned.toLocaleString(undefined,{maximumFractionDigits:6}) + ' ARK');
        set('pfEarnUsd', '+$' + (earned*price).toLocaleString(undefined,{maximumFractionDigits:4}));
        set('pfCurArk', cur.toLocaleString(undefined,{maximumFractionDigits:6}) + ' ARK');
        var apy = (Math.pow(1+rate, 730) - 1) * 100;
        set('pfApy', apy.toFixed(0) + '%');
        set('pfPrice', '$' + price);
        set('pfRateShow', (rate*100).toFixed(4) + '% / 12h');
        // 已跟踪时长
        var tracked = document.getElementById('pfTracked');
        if (tracked) {
          var hh = Math.floor(elapsedH);
          var mm = Math.floor((elapsedMs % 3600000) / 60000);
          tracked.textContent = hh + '小时' + mm + '分';
        }
      });
    }).catch(function(){});
  };
  window.pfSetStart = function () {
  var dEl=document.getElementById('pfSD'), hEl=document.getElementById('pfSH'), mEl=document.getElementById('pfSM');
  var day=parseInt((dEl||{}).value||'0',10), hour=parseInt((hEl||{}).value||'-1',10), min=parseInt((mEl||{}).value||'0',10);
  if (!(day>0 && hour>=0)) { alert('请填写 日 和 时（如 13 22 0）'); return; }
  var now=new Date();
  var dt=new Date(now.getFullYear(), now.getMonth(), day, hour, min, 0, 0);
  // 如果这个时间在未来 → 说明是上个月
  if (dt.getTime() > Date.now()) dt.setMonth(dt.getMonth()-1);
  try { localStorage.setItem(_stakeKey(), String(dt.getTime())); } catch(e){}
  window.pfFetch();
  var h=document.getElementById('pfHint');
  if(h){h.textContent='✅ 开始时间: '+dt.toLocaleString();h.style.color='#18c98a';}
};
window.pfResetStart = function () {
    if (confirm('重新开始跟踪？将把起始时间设为现在')) {
      window.pfFetch(true);
    }
  };

  // 输入变化自动算
  document.addEventListener('DOMContentLoaded', function(){
    var a = document.getElementById('pfAmt');
    if (a) a.addEventListener('input', function(){ clearTimeout(window._pfT); window._pfT=setTimeout(window.pfFetch, 400); });
    setTimeout(function(){
    loadStakes(); window.pfFetch();
    // 回填起始时间输入框
    var st = (function(){ try { return parseInt(localStorage.getItem(_stakeKey())||'0',10); } catch(e){ return 0; } })();
    if (st) {
      var dt = new Date(st);
      var e1=document.getElementById('pfSD'), e2=document.getElementById('pfSH'), e3=document.getElementById('pfSM');
      if(e1)e1.value=dt.getDate(); if(e2)e2.value=dt.getHours(); if(e3)e3.value=dt.getMinutes();
    }
  }, 1200);
  });
})();

/* ══════════ 生態系統區塊自動載入 ══════════ */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { window.loadSystems(); });
} else {
  window.loadSystems();
}
/* PRO 狀態變化時刷新鎖定狀態 */
window.addEventListener('ark:pro-changed', function () { try { window.loadSystems(); } catch (e) {} });

/* ══════════ PRO 門控兜底（確保未登入/免費用戶一定被鎖）══════════ */
(function () {
  function enforceGates() {
    var isPro = false;
    try {
      isPro = (window.ARK_PRO === true) ||
              (window.arkState && window.arkState.pro === true) ||
              (typeof window.__proState === 'function' && window.__proState() === true);
    } catch (e) { isPro = false; }
    document.querySelectorAll('[data-pro]').forEach(function (el) {
      el.classList.toggle('locked', !isPro);
      var ov = el.querySelector('.lock-ov');
      if (!isPro && !ov) {
        var d = document.createElement('div');
        d.className = 'lock-ov';
        d.innerHTML = '<div class="lock-in"><span>🔒 VIP 會員</span>' +
          '<button class="btn primary mini" onclick="typeof openPay===\'function\'&&openPay()">升級 VIP 解鎖</button></div>';
        el.appendChild(d);
      } else if (isPro && ov) {
        ov.remove();
      }
    });
  }
  window.enforceGates = enforceGates;
  // 多次執行，確保各腳本初始化完成後門控仍正確
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', enforceGates);
  else enforceGates();
  setTimeout(enforceGates, 800);
  setTimeout(enforceGates, 2000);
  // 狀態變化時重跑
  window.addEventListener('ark:auth', enforceGates);
  window.addEventListener('ark:pro-changed', enforceGates);

  // ⭐ 页面加载时初始化提醒通道说明区（默认显示当前选中通道的步骤）
  function initCoefGuide() {
    try { if (typeof window.coefChHint === 'function') window.coefChHint(); } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initCoefGuide);
  else initCoefGuide();
  setTimeout(initCoefGuide, 600);
  setTimeout(initCoefGuide, 1500);
  window.initCoefGuide = initCoefGuide;
})();
