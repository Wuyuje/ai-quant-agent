/* ARK Citizen Tools - WalletConnect 錢包選擇（手機友好）
 * 用 WalletConnect v2 中繼協議，手機瀏覽器點擊即彈出錢包選擇
 */
(function () {
  "use strict";

  var WC_PROJECT_ID = "d2f2b5c9c7d94b0f9a1e2d3c4b5a6978"; // 佔位，可替換
  var CHAIN_ID = 56;   // BSC
  var loaded = false;

  /* ── 錢包清單（手機主流） ── */
  var WALLETS = [
    { id: "tp",       name: "TokenPocket",  icon: "🔵", scheme: "tpoutside" },
    { id: "metamask", name: "MetaMask",     icon: "🦊", scheme: "metamask" },
    { id: "okx",      name: "OKX Wallet",   icon: "⚫", scheme: "okx" },
    { id: "bitget",   name: "Bitget Wallet",icon: "🔷", scheme: "bitkeep" },
    { id: "imtoken",  name: "imToken",      icon: "🔷", scheme: "imtokenv2" },
    { id: "wc",       name: "WalletConnect",icon: "🌈", scheme: "wc" }
  ];

  function isMobile() { return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent || ""); }
  function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent || ""); }
  function isAndroid() { return /android/i.test(navigator.userAgent || ""); }
  function inWalletApp() {
    var ua = navigator.userAgent || "";
    return /TokenPocket|TPWallet|MetaMask|OKApp|OKX|BitKeep|imToken/i.test(ua) || !!window.ethereum;
  }

  function dappUrl() {
    return location.href.split("#")[0];
  }

  /* ── 各錢包 Deep Link ── */
  function buildLink(walletId, url) {
    var host = url.replace(/^https?:\/\//, "");
    var full = encodeURIComponent(url);
    switch (walletId) {
      case "tp":
        return {
          ios: "tpoutside://pull.activity?param=" + encodeURIComponent(JSON.stringify({ url: url })),
          android: "tpoutside://pull.activity?param=" + encodeURIComponent(JSON.stringify({ url: url }))
        };
      case "metamask":
        return { ios: "https://metamask.app.link/dapp/" + host, android: "https://metamask.app.link/dapp/" + host };
      case "okx":
        return { ios: "okx://wallet/dapp/url?dappUrl=" + full, android: "okx://wallet/dapp/url?dappUrl=" + full };
      case "bitget":
        return { ios: "bitkeep://bkconnect?action=dapp&url=" + full, android: "bitkeep://bkconnect?action=dapp&url=" + full };
      case "imtoken":
        return { ios: "imtokenv2://navigate/DappView?url=" + full, android: "imtokenv2://navigate/DappView?url=" + full };
      default:
        return null;
    }
  }

  /* ── 彈出錢包選擇 ── */
  function showPicker() {
    var m = document.getElementById("wcPicker");
    if (!m) {
      m = document.createElement("div");
      m.id = "wcPicker";
      m.className = "pay-modal";
      document.body.appendChild(m);
    }
    var url = dappUrl();
    var httpWarn = location.protocol !== "https:"
      ? '<div class="wg-warn">⚠️ 目前 HTTP 連接，部分錢包會拒絕。若無法跳轉，請在錢包 App 內直接打開網址。</div>' : '';

    m.innerHTML =
      '<div class="pay-dialog" style="max-width:440px">' +
      '<div class="pay-head">' +
        '<h3>選擇錢包</h3>' +
        '<button class="btn ghost mini" onclick="document.getElementById(\'wcPicker\').classList.remove(\'on\')">✕</button>' +
      '</div>' +
      '<p class="mut" style="margin-bottom:14px">點擊錢包將自動跳轉並打開本站</p>' +
      '<div class="wp-grid">' +
        WALLETS.map(function (w) {
          return '<div class="wp-item" onclick="arkPickWallet(\'' + w.id + '\')">' +
            '<span class="wp-ico">' + w.icon + '</span>' +
            '<span class="wp-name">' + w.name + '</span>' +
          '</div>';
        }).join("") +
      '</div>' +
      '<div class="wg-copy">' +
        '<input class="mono" id="wpUrl" value="' + url + '" readonly>' +
        '<button class="btn primary" onclick="arkCopyUrl()">複製</button>' +
      '</div>' +
      '<div class="wg-tip" style="margin-top:12px">' +
        '<b>找不到錢包？</b> 複製上方網址 → 打開錢包 App → 「發現 / DApp 瀏覽器」→ 貼上' +
      '</div>' +
      httpWarn +
      '</div>';
    m.classList.add("on");
  }
  window.arkShowWalletPicker = showPicker;

  /* ── 選擇錢包 → 跳轉 ── */
  function pickWallet(id) {
    // ⭐ WalletConnect：走官方 SDK（支持 QR / 手機跳轉）
    if (id === "wc" && window.arkConnectWC) {
      var el = document.getElementById("wcPicker");
      var tip = document.getElementById("wcLoading") || document.createElement("div");
      tip.id = "wcLoading"; tip.className = "wg-tip"; tip.style.marginTop = "12px";
      tip.textContent = "正在啟動 WalletConnect…請在彈出的視窗中選擇你的錢包";
      var dlg = document.querySelector("#wcPicker .pay-dialog");
      if (dlg && !dlg.querySelector("#wcLoading")) dlg.appendChild(tip);
      window.arkConnectWC().then(function (addr) {
        if (window.login) window.login(addr);
      }).catch(function (e) {
        tip.textContent = "WalletConnect 連接失敗：" + String(e.message || e).slice(0, 60);
        tip.className = "wg-warn";
      });
      return;
    }
    var url = dappUrl();
    var link = buildLink(id, url);
    if (!link) { arkCopyUrl(); return; }
    var target = isIOS() ? link.ios : link.android;

    // 方案：先嘗試 scheme 跳轉，失敗則 fallback
    var now = Date.now();
    var timer = null;

    // 記錄是否離開頁面（跳轉成功）
    var onHide = function () { if (document.hidden) clearTimeout(timer); };
    document.addEventListener("visibilitychange", onHide, { once: true });

    try { window.location.href = target; } catch (e) {}

    // 800ms 後若還在頁面 → 顯示複製提示
    timer = setTimeout(function () {
      if (Date.now() - now < 2000 && !document.hidden) {
        var tip = document.getElementById("wpTip") || document.createElement("div");
        tip.id = "wpTip";
        tip.className = "wg-warn";
        tip.style.marginTop = "12px";
        tip.textContent = "未偵測到錢包 App。請手動複製網址，在錢包 App 內打開。";
        var dlg = document.querySelector("#wcPicker .pay-dialog");
        if (dlg && !dlg.querySelector("#wpTip")) dlg.appendChild(tip);
      }
    }, 1500);
  }
  window.arkPickWallet = pickWallet;

  function copyUrl() {
    var el = document.getElementById("wpUrl");
    if (!el) return;
    el.select();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(el.value);
      else document.execCommand("copy");
      alert("已複製網址：\n" + el.value + "\n\n打開錢包 App → 發現/DApp → 貼上打開");
    } catch (e) { alert("請手動複製：" + el.value); }
  }
  window.arkCopyUrl = copyUrl;

  /* ── 對外統一入口：連接錢包 ── */
  function connect() {
    // ① 已在錢包 App 內 → 直接用注入的 provider
    if (window.ethereum) {
      return window.walletConnect ? window.walletConnect() : Promise.reject(new Error("NO_WALLET"));
    }
    // ② 手機瀏覽器（無注入）→ 彈錢包選擇
    if (isMobile()) {
      showPicker();
      return Promise.reject(new Error("PICK_WALLET"));
    }
    // ③ 桌面無錢包 → 也彈選擇
    showPicker();
    return Promise.reject(new Error("PICK_WALLET"));
  }
  window.arkConnect = connect;

  window.__arkWalletList = WALLETS;
})();
