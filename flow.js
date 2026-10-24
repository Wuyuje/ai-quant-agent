/* ARK Citizen Tools - 優化付款流程（4步 → 2步）
 * 1) 登入狀態持久化（跳轉回來自動恢復）
 * 2) 升級 PRO 一鍵直達轉帳確認
 * 3) 支付意圖暫存（跳轉回來自動續接）
 */
(function () {
  "use strict";

  var KEY_ADDR = "ark_auth_addr";
  var KEY_INTENT = "ark_pay_intent";     // 付款意圖（跳轉前存）
  var KEY_LAST_TS = "ark_last_active";

  function $(id) { return document.getElementById(id); }
  function t(k) { return window.t ? window.t(k) : k; }

  /* ── 付款意圖持久化 ── */
  function saveIntent(plan, invId) {
    try {
      localStorage.setItem(KEY_INTENT, JSON.stringify({
        plan: plan, invId: invId, ts: Date.now()
      }));
    } catch (e) {}
  }
  window.arkSaveIntent = saveIntent;

  function readIntent() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY_INTENT) || "null");
      if (!v) return null;
      if (Date.now() - v.ts > 60 * 60 * 1000) { clearIntent(); return null; }  // 1小時過期
      return v;
    } catch (e) { return null; }
  }
  window.arkReadIntent = readIntent;

  function clearIntent() {
    try { localStorage.removeItem(KEY_INTENT); } catch (e) {}
  }
  window.arkClearIntent = clearIntent;

  /* ── 跳轉前：存入意圖到 URL hash（跨 App 保留） ── */
  function buildDeepLinkWithIntent(baseLink, plan, invId) {
    // 把意圖放在 URL 中，跳轉回來後可續接
    var u = new URL(location.href);
    u.hash = "#pay=" + encodeURIComponent(plan) + "&inv=" + encodeURIComponent(invId);
    return { link: baseLink, url: u.toString() };
  }
  window.arkBuildIntentLink = buildDeepLinkWithIntent;

  /* ── 啟動時：檢查是否有待處理的付款意圖 ── */
  function resumePayFlow() {
    // ① URL hash 帶意圖
    var m = /[#&]pay=([^&]+)&inv=([^&]+)/.exec(location.hash || "");
    var wantPlan = m ? decodeURIComponent(m[1]) : null;
    var wantInv = m ? decodeURIComponent(m[2]) : null;

    // ② localStorage 意圖
    if (!wantPlan) {
      var it = readIntent();
      if (it) { wantPlan = it.plan; wantInv = it.invId; }
    }
    if (!wantPlan) return;

    // 清理 URL hash
    if (location.hash) {
      try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
    }

    // 等登入完成 → 自動續接付款
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      var hasAddr = false;
      try { hasAddr = !!localStorage.getItem(KEY_ADDR); } catch (e) {}
      var inWallet = !!(window.ethereum || window.tokenpocket);

      if (hasAddr && inWallet) {
        clearInterval(timer);
        // 自動重啟付款
        setTimeout(function () {
          if (window._arkResumePay) window._arkResumePay(wantPlan, wantInv);
        }, 800);
      }
      if (tries > 60) clearInterval(timer);   // 最多等 60 秒
    }, 500);
  }
  window.arkResumePayFlow = resumePayFlow;

  /* ── 記錄活躍時間（判斷是否需要重新登入） ── */
  function touchActive() {
    try { localStorage.setItem(KEY_LAST_TS, String(Date.now())); } catch (e) {}
  }
  window.arkTouchActive = touchActive;

  function isSessionFresh() {
    try {
      var ts = parseInt(localStorage.getItem(KEY_LAST_TS) || "0", 10);
      return Date.now() - ts < 7 * 24 * 3600 * 1000;   // 7 天內免重簽
    } catch (e) { return false; }
  }
  window.arkSessionFresh = isSessionFresh;

  document.addEventListener("DOMContentLoaded", function () {
    touchActive();
    setInterval(touchActive, 60000);
    // 延遲執行，等 auth.js 初始化完
    setTimeout(resumePayFlow, 1200);
  });
})();
