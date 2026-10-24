/* ARK Citizen Tools - 廣告位前端（申請 + 付款 + 展示） */
(function () {
  "use strict";

  /* 🔒 安全: HTML转义 + URL校验 */
  function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");}
  function safeUrl(u){u=String(u||"");return /^https?:\/\//i.test(u)?u:"#";}
  function safeImg(u){u=String(u||"");return /^https?:\/\//i.test(u)||/^data:image\//i.test(u)||/^\//.test(u)?u:"";}

  function $id(i) { return document.getElementById(i); }

  /* ⭐ 取得當前登入地址（多來源 + 大小寫容錯） */
  function myAddr() {
    // ① auth.js 暴露的 state
    try {
      if (window.arkState && window.arkState.addr) return String(window.arkState.addr);
    } catch (e) {}
    // ② window._arkAddr（auth.js 登入時設）
    try {
      if (window._arkAddr) return String(window._arkAddr);
    } catch (e) {}
    // ③ localStorage
    try {
      var a = localStorage.getItem("ark_auth_addr");
      if (a && /^0x[0-9a-f]{40}$/i.test(a)) return a;
    } catch (e) {}
    // ④ sessionStorage
    try {
      var b2 = sessionStorage.getItem("ark_auth_addr");
      if (b2 && /^0x[0-9a-f]{40}$/i.test(b2)) return b2;
    } catch (e) {}
    return "";
  }
  window.arkMyAddr = myAddr;
  function t(k) { return window.t ? window.t(k) : k; }
  function fmt(n, d) { return window.fmt ? window.fmt(n, d) : n; }

  var SLOTS = null, PAYTO = null;
  var current = { slot: "", months: 1 };

  /* ── 載入廣告位設定 ── */
  function loadSlots() {
    fetch("/api/ads/slots").then(function (r) { return r.json(); }).then(function (d) {
      SLOTS = d.slots; PAYTO = d.payTo;
      window._adsPayTo = d.payTo;
      renderSlots(d);
    });
  }

  function renderSlots(d) {
    var box = $id("adSlots");
    if (!box) return;
    var lg = window.I18NRT ? window.I18NRT.get() : "zh-TW";
    var keys = Object.keys(d.slots);
    box.innerHTML = keys.map(function (k) {
      var s = d.slots[k];
      var nm = (s.name && (s.name[lg] || s.name["zh-TW"])) || k;
      var ds = (s.desc && (s.desc[lg] || s.desc["zh-TW"])) || "";
      var icon = k === "hero" ? "🏆" : k === "side" ? "📌" : "🔗";
      return '<div class="card partner-card">' +
        '<div class="pc-head">' + icon + ' ' + nm + '</div>' +
        '<div class="pc-body mut">' + ds + '</div>' +
        '<div class="pc-price">' + s.pricePerMonth + ' <small>ARK / 月</small></div>' +
        '<button class="btn primary" style="width:100%;margin-top:12px" onclick="adOpenForm(\'' + k + '\')">投放</button>' +
        '</div>';
    }).join("");
    // 更新 durations
    var sel = $id("adMonths");
    if (sel) sel.innerHTML = d.durations.map(function (m) {
      return '<option value="' + m + '">' + m + ' 個月</option>';
    }).join("");
  }

  /* ── 打開申請表 ── */
  function adOpenForm(slot) {
    var a = myAddr();
    console.log("[adOpenForm] slot=", slot, "myAddr=", a,
      "arkState=", window.arkState ? ("addr=" + (window.arkState.addr || "空")) : "undefined",
      "ls=", (function(){ try { return localStorage.getItem("ark_auth_addr") || "空"; } catch(e){ return "err"; } })());
    if (!a) {
      alert("請先「錢包登入」\n\n（若已登入，請重新整理頁面）");
      // ⭐ 不再彈錢包選擇器，改為直接觸發登入
      if (window.connectWallet) window.connectWallet();
      return;
    }
    current.slot = slot;
    var m = $id("adModal");
    if (!m) return;
    m.classList.add("on");
    var s = SLOTS[slot];
    var lg = window.I18NRT ? window.I18NRT.get() : "zh-TW";
    $id("adFormTitle").textContent = "投放：" + ((s.name[lg] || s.name["zh-TW"]));
    updatePrice();
  }
  window.adOpenForm = adOpenForm;

  function adCloseForm() {
    var m = $id("adModal");
    if (m) m.classList.remove("on");
  }
  window.adCloseForm = adCloseForm;

  function adOnMonthsChange() {
    current.months = parseInt($id("adMonths").value, 10) || 1;
    updatePrice();
  }
  window.adOnMonthsChange = adOnMonthsChange;

  function updatePrice() {
    if (!SLOTS || !current.slot) return;
    var s = SLOTS[current.slot];
    var total = s.pricePerMonth * current.months;
    $id("adTotal").textContent = total + " ARK";
    window._adTotal = total;
  }

  /* ── 提交申請 → 生成訂單 ── */
  function adSubmit() {
    var data = {
      addr: myAddr(),
      slot: current.slot,
      months: current.months,
      title: $id("adTitle").value.trim(),
      url: $id("adUrl").value.trim(),
      image: $id("adImage").value.trim(),
      contact: $id("adContact").value.trim(),
      desc: $id("adDesc").value.trim()
    };
    if (!data.title) { alert("請填寫項目名稱"); return; }
    if (!/^https?:\/\//.test(data.url)) { alert("請填寫完整連結（含 https://）"); return; }

    fetch("/api/ads/create", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { alert(d.error); return; }
      showAdPay(d);
    }).catch(function (e) { alert("提交失敗: " + e.message); });
  }
  window.adSubmit = adSubmit;

  function showAdPay(ad) {
    var box = $id("adPayBox");
    box.style.display = "block";
    // ⭐ 緩存訂單資訊（付款時取收款地址）
    window._adCache = window._adCache || [];
    if (!window._adCache.find(function (x) { return x.id === ad.id; })) window._adCache.push(ad);
    if (ad.payTo) window._adsPayTo = ad.payTo;
    var shortAddr = ad.payTo.slice(0, 8) + "..." + ad.payTo.slice(-6);
    box.innerHTML =
      '<div class="mut">訂單 ' + ad.id + '</div>' +
      '<div class="inv-amount" style="margin:8px 0">' + ad.ark + ' ARK</div>' +
      '<div class="inv-row"><span class="mut">收款地址</span>' +
        '<button class="btn ghost mini" onclick="adCopy(\'' + ad.payTo + '\')">複製完整地址</button></div>' +
      '<div class="mono inv-addr" style="text-align:center;letter-spacing:.5px">' + shortAddr + '</div>' +
      '<button class="btn primary inv-paybtn" style="margin-top:12px" onclick="adPay(\'' + ad.id + '\',' + ad.ark + ',\'' + ad.payTo + '\')">用錢包支付</button>' +
      '<div class="inv-status" id="adPayStatus">付款後由管理員審核，通過即上架</div>';
  }

  function adCopy(s) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(s);
      else { var t=document.createElement("textarea"); t.value=s; document.body.appendChild(t); t.select(); document.execCommand("copy"); document.body.removeChild(t); }
      alert("已複製收款地址");
    } catch (e) { alert("請手動複製：\n" + s); }
  }
  window.adCopy = adCopy;

  /* ── 付款（統一入口，自動跳轉錢包） ── */
  function adPay(adId, arkAmount, payToParam) {
    console.log("[adPay] start", adId, arkAmount, "payTo=", window._adsPayTo);
    var st = $id("adPayStatus");
    function say(msg, cls) { if (st) { st.textContent = msg; if (cls) st.className = "inv-status " + cls; } }

    // 多重回退取收款地址
    var payTo = payToParam || window._adsPayTo;
    if (!payTo) {
      var ad = (window._adCache || []).find(function (x) { return x.id === adId; });
      payTo = ad && ad.payTo;
    }
    if (!payTo) {
      say("收款地址缺失，請重新整理頁面", "dn");
      console.error("[adPay] no payTo");
      return;
    }
    if (!window.arkPay) {
      say("付款模組未載入，請重新整理", "dn");
      return;
    }

    window.arkPay(payTo, arkAmount, {
      label: "ad:" + adId,
      onStatus: function (m) { say(m); },
      onSent: function (h) {
        say("交易已送出：" + String(h).slice(0, 20) + "...");
        pollAd(adId, h, 0);
      },
      onError: function (m) {
        if (m === "NO_LOGIN") say("請先錢包登入", "dn");
        else if (m === "NO_WALLET") say("未檢測到錢包，請在錢包 App 內打開", "dn");
        else if (m === "USER_REJECTED" || m.indexOf("4001") >= 0) say("你取消了轉帳", "dn");
        else if (m === "INSUFFICIENT" || m.indexOf("insufficient") >= 0) say("餘額不足（需 ARK + BNB gas）", "dn");
        else say("失敗：" + String(m).slice(0, 80), "dn");
      }
    });
  }
  window.adPay = adPay;   // ⭐ 關鍵：導出到全域（按鈕 onclick 才能調用）
  console.log("[ads.js] window.adPay 已導出");

  function pollAd(adId, txHash, n) {
    if (n > 60) return;
    fetch("/api/ads/check", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adId: adId, txHash: txHash })
    }).then(function (r) { return r.json(); }).then(function (d) {
      var st = $id("adPayStatus");
      if (d.status === "pending_review") {
        if (st) st.innerHTML = '<span class="up">✅ 付款成功！已提交審核，管理員通過後自動上架（通常 24 小時內）</span>';
        loadMyAds();
      } else {
        if (st) st.textContent = (d.detail || "等待確認") + " (" + (n + 1) + ")";
        setTimeout(function () { pollAd(adId, txHash, n + 1); }, 5000);
      }
    }).catch(function () { setTimeout(function () { pollAd(adId, txHash, n + 1); }, 5000); });
  }

  /* ── 我的投放 ── */
  function loadMyAds() {
    if (!myAddr()) return;
    fetch("/api/ads/mine?addr=" + encodeURIComponent(myAddr()))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var box = $id("adMineList");
        if (!box) return;
        // ⭐ 過濾：不顯示「待付款」（未支付）的記錄
        var ads = (d.ads || []).filter(function (a) {
          return a.status !== "pending_pay";
        });
        box.innerHTML = ads.length ? ads.map(function (a) {
          var stMap = {
            pending_review: '<span style="color:var(--gold)">待審核</span>',
            active: '<span class="up">投放中</span>',
            expired: '<span class="mut">已過期</span>',
            rejected: '<span class="dn">已拒絕</span>'
          };
          return '<tr><td>' + esc(a.title) + '</td><td>' + esc(a.slot) + '</td>' +
            '<td>' + esc(a.months) + '月</td><td>' + esc(a.ark) + ' ARK</td>' +
            '<td>' + (stMap[a.status] || esc(a.status)) + '</td></tr>';
        }).join("") : '<tr><td colspan="5" class="mut">尚無投放記錄</td></tr>';
      });
  }
  window.loadMyAds = loadMyAds;

  /* ── 前台展示有效廣告 ── */
  function renderActiveAds() {
    // Hero 位
    fetch("/api/ads/active?slot=hero").then(function (r) { return r.json(); }).then(function (d) {
      var box = $id("adHeroSlot");
      if (!box || !d.ads || !d.ads.length) return;
      box.style.display = "block";
      box.innerHTML = d.ads.map(function (a) {
        return '<a class="ad-banner" href="' + safeUrl(a.url) + '" target="_blank" rel="noopener" onclick="adTrack(\'' + esc(a.id) + '\')">' +
          (a.image ? '<img src="' + safeImg(a.image) + '" alt="">' : '') +
          '<div><b>' + esc(a.title) + '</b><div class="mut">' + esc(a.desc || "") + '</div></div></a>';
      }).join("");
      d.ads.forEach(function (a) { fetch("/api/ads/track", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: a.id, type: "view" }) }); });
    }).catch(function () {});

    // 側欄位
    fetch("/api/ads/active?slot=side").then(function (r) { return r.json(); }).then(function (d) {
      var box = $id("adSideSlot");
      if (!box || !d.ads || !d.ads.length) return;
      box.style.display = "block";
      box.innerHTML = d.ads.map(function (a) {
        return '<a class="ad-side" href="' + safeUrl(a.url) + '" target="_blank" rel="noopener" onclick="adTrack(\'' + esc(a.id) + '\')">' +
          '<b>' + esc(a.title) + '</b><div class="mut">' + esc(a.desc || "") + '</div></a>';
      }).join("");
    }).catch(function () {});

    // ⭐ 全部位置（通用）
    fetch("/api/ads/active").then(function (r) { return r.json(); }).then(function (d) {
      var box = $id("adAllSlots");
      if (!box || !d.ads || !d.ads.length) return;
      box.style.display = "block";
      box.innerHTML = '<div class="mut" style="margin-bottom:8px">📢 合作推廣</div>' +
        d.ads.map(function (a) {
          var icon = a.slot === "hero" ? "🏆" : a.slot === "side" ? "📌" : "🔗";
          return '<a class="ad-side" href="' + safeUrl(a.url) + '" target="_blank" rel="noopener" onclick="adTrack(\'' + esc(a.id) + '\')">' +
            icon + ' <b>' + esc(a.title) + '</b><div class="mut">' + esc(a.desc || "") + '</div></a>';
        }).join("");
    }).catch(function () {});
  }
  window.renderActiveAds = renderActiveAds;
  window.adTrack = function (id) {
    fetch("/api/ads/track", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: id, type: "click" }) });
  };

  // ⭐ 登入成功回調
  window.onArkLogin = function (addr) {
    loadMyAds();
  };

  document.addEventListener("DOMContentLoaded", function () {
    if ($id("adSlots")) loadSlots();
    if ($id("adHeroSlot") || $id("adSideSlot")) renderActiveAds();
    var sel = $id("adMonths");
    if (sel) sel.addEventListener("change", adOnMonthsChange);
    // 若已登入，載入我的投放
    setTimeout(function () { if (myAddr()) loadMyAds(); }, 1500);
  });

  // 監聽登入狀態變化（auth.js 登入成功後會觸發）
  var _prevLang = window.onLangChange;
  window.addEventListener("storage", function (e) {
    if (e.key === "ark_auth_addr") loadMyAds();
  });
})();
