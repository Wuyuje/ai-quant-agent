/* 緊急診斷工具 — 在頁面上顯示環境狀態 */
(function () {
  "use strict";

  function collect() {
    var out = [];
    var ua = navigator.userAgent || "";
    out.push("【環境】");
    out.push("UA: " + ua.slice(0, 80));
    out.push("協議: " + location.protocol);
    out.push("手機: " + /android|iphone|ipad|ipod|mobile/i.test(ua));
    out.push("");
    out.push("【錢包】");
    out.push("window.ethereum: " + (window.ethereum ? "✅有" : "❌無"));
    out.push("window.tokenpocket: " + (window.tokenpocket ? "✅有" : "❌無"));
    out.push("window.okxwallet: " + (window.okxwallet ? "✅有" : "❌無"));
    if (window.ethereum) {
      out.push("isTokenPocket: " + !!window.ethereum.isTokenPocket);
      out.push("isMetaMask: " + !!window.ethereum.isMetaMask);
      out.push("chainId: " + (window.ethereum.chainId || "?"));
      out.push("selectedAddress: " + (window.ethereum.selectedAddress || "?"));
    }
    out.push("");
    out.push("【模組】");
    out.push("window.arkPay: " + (typeof window.arkPay));
    out.push("window.hasWallet: " + (typeof window.hasWallet));
    out.push("window.arkActiveProvider: " + (typeof window.arkActiveProvider));
    out.push("window.arkState: " + (window.arkState ? "addr=" + (window.arkState.addr||"空") : "❌無"));
    out.push("");
    out.push("【登入態】");
    var ls = "";
    try { ls = localStorage.getItem("ark_auth_addr") || ""; } catch (e) {}
    out.push("localStorage 地址: " + (ls ? ls.slice(0,10)+"..." : "❌空"));
    out.push("");
    out.push("【收款】");
    out.push("_adsPayTo: " + (window._adsPayTo || "❌無"));
    return out.join("\n");
  }
  window.arkDebug = function () {
    var s = collect();
    console.log(s);
    // 顯示在頁面上（不只 console）
    var m = document.getElementById("debugModal");
    if (!m) {
      m = document.createElement("div");
      m.id = "debugModal";
      m.className = "pay-modal";
      document.body.appendChild(m);
    }
    m.classList.add("on");
    m.innerHTML = '<div class="pay-dialog"><div class="pay-head"><h3>🔍 環境診斷</h3>' +
      '<button class="btn ghost mini" onclick="document.getElementById(\'debugModal\').classList.remove(\'on\')">✕</button></div>' +
      '<pre style="white-space:pre-wrap;font-size:11px;line-height:1.6;color:#93a4c8;max-height:60vh;overflow:auto">' +
      s.replace(/</g, "&lt;") + "\n\n=== 日誌 ===\n" + (LOGS.slice(-20).join("\n") || "(無)") + '</pre>' +
      '<button class="btn primary" style="width:100%;margin-top:12px" onclick="arkCopyDebug()">複製診斷結果</button></div>';
    return s;
  };

  /* ⭐ 實時日誌面板（捕獲所有 [arkPay]/[adPay] 日誌並顯示） */
  var LOGS = [];
  var _origLog = console.log, _origWarn = console.warn, _origErr = console.error;
  function _capture(type, args) {
    var msg = Array.prototype.slice.call(args).map(function (a) {
      try { return typeof a === "object" ? JSON.stringify(a) : String(a); } catch (e) { return String(a); }
    }).join(" ");
    LOGS.push("[" + type + "] " + msg);
    if (LOGS.length > 50) LOGS.shift();
    renderLogPanel();
  }
  console.log = function () { _origLog.apply(console, arguments); _capture("log", arguments); };
  console.warn = function () { _origWarn.apply(console, arguments); _capture("warn", arguments); };
  console.error = function () { _origErr.apply(console, arguments); _capture("err", arguments); };

  function renderLogPanel() {
    if (location.search.indexOf("debug") < 0) return;
    var p = document.getElementById("logPanel");
    if (!p) {
      p = document.createElement("div");
      p.id = "logPanel";
      p.style.cssText = "position:fixed;left:8px;right:8px;bottom:8px;max-height:38vh;overflow:auto;z-index:9999;" +
        "background:rgba(6,11,24,.96);border:1px solid rgba(53,224,245,.4);border-radius:10px;padding:10px;" +
        "font-size:10.5px;line-height:1.55;font-family:monospace;color:#93a4c8;white-space:pre-wrap";
      document.body.appendChild(p);
    }
    p.textContent = "=== 實時日誌 ===\n" + (LOGS.slice(-25).join("\n") || "(等待操作…)");
  }
  window.arkLogs = function () { return LOGS.join("\n"); };
  window.arkClearLogs = function () { LOGS = []; renderLogPanel(); };

  window.arkCopyDebug = function () {
    var s = collect();
    try {
      if (navigator.clipboard) navigator.clipboard.writeText(s);
      else { var t=document.createElement("textarea"); t.value=s; document.body.appendChild(t); t.select(); document.execCommand("copy"); document.body.removeChild(t); }
      alert("已複製診斷結果，可貼給我");
    } catch (e) { alert(s); }
  };

  // 自動在頁面角落加一個診斷按鈕（僅當 URL 帶 ?debug）
  document.addEventListener("DOMContentLoaded", function () {
    if (location.search.indexOf("debug") < 0) return;
    var b = document.createElement("button");
    b.className = "btn primary";
    b.style.cssText = "position:fixed;right:12px;bottom:80px;z-index:9999;font-size:12px;padding:10px 14px";
    b.textContent = "🔍 診斷";
    b.onclick = window.arkDebug;
    document.body.appendChild(b);
  });
})();
