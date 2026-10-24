/* ARK Citizen Tools - 錢包登入 + 付費牆（前端） */
(function () {
  "use strict";

  var KEY_ADDR = "ark_auth_addr";
  var state = { addr: "", plan: "free", pro: false, until: 0 };
  // ⭐ 暴露給其他模組（ads.js 等使用）
  Object.defineProperty(window, "arkState", {
    get: function () { return state; },
    set: function (v) { state = v || { addr: "", plan: "free", pro: false, until: 0 }; },
    configurable: true
  });

  function t(k) { return window.t ? window.t(k) : k; }
  function $(id) { return document.getElementById(id); }

  function setStatus(txt, cls) {
    var e = $("auStatus");
    if (e) { e.textContent = txt || ""; e.className = "mut " + (cls || ""); }
    // 同時更新付款狀態
    var p = $("payStatus");
    if (p && txt) { p.textContent = txt; p.className = "inv-status " + (cls || ""); }
  }

  /* ── 連接錢包 ── */
  function connectWallet() {
    console.log("[connectWallet] 開始, hasWallet=", window.hasWallet ? window.hasWallet() : "NO_FUNC",
      "walletName=", window.walletName ? window.walletName() : "?");
    // ① 無注入 provider → 彈錢包選擇（手機友好）
    if (!window.hasWallet || !window.hasWallet()) {
      console.log("[connectWallet] 無 provider → 彈選擇/引導");
      if (window.arkShowWalletPicker) window.arkShowWalletPicker();
      else if (window.showWalletGuide) window.showWalletGuide();
      else alert(t("au.noWallet"));
      return;
    }
    setStatus("連接 " + (window.walletName ? window.walletName() : "wallet") + "…", "");
    window.walletConnect().then(function (addr) {
      console.log("[connectWallet] 拿到地址:", addr);
      window._arkAddr = addr;
      login(addr);
    }).catch(function (e) {
      console.warn("[connectWallet] 失敗:", e && e.message);
      var msg = String(e && e.message || e);
      if (msg.indexOf("NO_WALLET") >= 0 || msg.indexOf("no account") >= 0) {
        if (window.showWalletGuide) window.showWalletGuide();
        else alert(t("au.noWallet"));
      } else if (msg.indexOf("user rejected") >= 0 || msg.indexOf("4001") >= 0) {
        setStatus("已取消", "");
      } else {
        setStatus(msg.slice(0, 70), "dn");
      }
    });
  }
  window.connectWallet = connectWallet;

  /* ── 簽名登入 ── */
  function login(addr) {
    console.log("[login] start addr=", addr);
    setStatus(t("au.signing"), "");
    if (window.ensureBSC) {
      window.ensureBSC().catch(function () { /* 繼續，可能已在 BSC */ });
    }
    fetch("/api/auth/nonce?addr=" + encodeURIComponent(addr))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) throw new Error(d.error);
        return window.walletSign(d.message, addr).then(function (sig) {
          console.log("[login] 簽名成功");
          return fetch("/api/auth/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ addr: addr, message: d.message, signature: sig })
          }).then(function (r) { return r.json(); });
        });
      })
      .then(function (d) {
        if (!d.ok) throw new Error(d.error || "verify failed");
        try { localStorage.setItem(KEY_ADDR, d.addr); localStorage.setItem('ark_addr', d.addr); } catch (e) {}
        try { sessionStorage.setItem(KEY_ADDR, d.addr); } catch (e) {}
        window._arkAddr = d.addr;
        state = { addr: d.addr, plan: d.plan, pro: d.pro, until: d.until };
        renderAuth();
        setStatus(t("au.loggedIn") + ": " + d.addr.slice(0, 6) + "..." + d.addr.slice(-4), "up");
        // 記錄 provider 供付款使用
        window._arkProvider = window.arkProvider ? window.arkProvider() : null;
        // ⭐ 通知其他模組（ads.js 載入投放記錄）
        if (typeof window.onArkLogin === "function") window.onArkLogin(d.addr);
        // ⭐ 登录成功 → 刷新 PRO 状态 + 隐藏广告
        window.ARK_PRO = !!d.pro; window.ARK_ADDR = d.addr;
        if (typeof window.applyGates === "function") window.applyGates();
        if (typeof window.updateUpgradeBanner === "function") window.updateUpgradeBanner();
        if (typeof window.updateCoefLock === "function") window.updateCoefLock();
        // ⭐ 登录后若有待处理升级 → 自动进入支付流程
        if (window._pendingUpgradePlan) {
          var _p = window._pendingUpgradePlan; window._pendingUpgradePlan = null;
          if (typeof window.startUpgrade === "function") setTimeout(function () { window.startUpgrade(_p); }, 600);
        }
      })
      .catch(function (e) { setStatus(String(e.message || e).slice(0, 60), "dn"); });
  }
  window.login = login;

  // ⭐ 刷新用户状态（支付后）
  window.refreshAuth = function () {
    var addr = (state && state.addr) || (function(){ try { return localStorage.getItem(KEY_ADDR); } catch(e){ return null; } })();
    if (!addr) return;
    fetch("/api/me?addr=" + encodeURIComponent(addr))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        state = { addr: d.addr || addr, plan: d.plan, pro: !!d.pro, until: d.until, whitelist: !!d.whitelist };
        window.ARK_PRO = !!d.pro;
        window.ARK_ADDR = d.addr || addr;
        renderAuth();
        if (typeof window.applyGates === "function") window.applyGates();
        if (typeof window.updateUpgradeBanner === "function") window.updateUpgradeBanner();
        if (typeof window.updateCoefLock === "function") window.updateCoefLock();
      }).catch(function () {});
  };

  function logout() {
    console.log("[logout] 清理登入狀態");
    try { localStorage.removeItem(KEY_ADDR); } catch (e) {}
    try { sessionStorage.removeItem(KEY_ADDR); } catch (e) {}
    try { localStorage.removeItem("ark_pay_pending"); } catch (e) {}
    window._arkAddr = "";
    window._arkProvider = null;
    window._arkState = null;
    state = { addr: "", plan: "free", pro: false, until: 0 };
    renderAuth();
    setStatus(t("au.loggedOut"), "");
  }
  window.logout = logout;

  /* ── 恢復登入狀態 ── */
  function restore() {
    var a = "";
    try { a = localStorage.getItem(KEY_ADDR) || localStorage.getItem('ark_addr') || ""; } catch (e) {}
    if (!a) { renderAuth(); if (typeof window.updateUpgradeBanner === "function") window.updateUpgradeBanner(); return; }
    fetch("/api/me?addr=" + encodeURIComponent(a)).then(function (r) { return r.json(); }).then(function (d) {
      state = { addr: d.addr, plan: d.plan, pro: !!d.pro, until: d.until, whitelist: !!d.whitelist };
      // ⭐ 同步 PRO 状态 + 刷新 UI（广告/门控）
      window.ARK_PRO = !!d.pro;
      window.ARK_ADDR = d.addr;
      renderAuth();
      if (typeof window.applyGates === "function") window.applyGates();
      if (typeof window.updateUpgradeBanner === "function") window.updateUpgradeBanner();
      if (typeof window.updateCoefLock === "function") window.updateCoefLock();
      setStatus(t("au.loggedIn") + ": " + a.slice(0, 6) + "..." + a.slice(-4), "up");
    }).catch(function () { renderAuth(); });
  }

  function renderAuth() {
    var box = $("authBox");
    if (!box) return;
    if (state.addr) {
      var untilTxt = state.pro ? new Date(state.until).toLocaleDateString() : "-";
      box.innerHTML =
        '<span class="tag mono">' + state.addr.slice(0, 6) + "..." + state.addr.slice(-4) + '</span>' +
        '<span class="tag ' + (state.pro ? "up" : "") + '">' + (state.pro ? "PRO" : "FREE") + '</span>' +
        (state.pro ? '<span class="tag">至 ' + untilTxt + '</span>' : '') +
        (state.pro ? '' : '<button class="btn primary mini" onclick="openPay()">' + t("au.upgrade") + '</button>') +
        '<button class="btn ghost mini" onclick="logout()">' + t("au.logout") + '</button>';
    } else {
      box.innerHTML = '<button class="btn primary mini" onclick="connectWallet()">' + t("au.login") + '</button>' +
        '<span class="mut" id="auStatus"></span>';
    }
    applyGates();
  }

  /* ── 付費牆：PRO 功能鎖定 ── */
  function applyGates() {
    var locked = !state.pro;
    document.querySelectorAll("[data-pro]").forEach(function (el) {
      el.classList.toggle("locked", locked);
      var ov = el.querySelector(".lock-ov");
      if (locked && !ov) {
        var d = document.createElement("div");
        d.className = "lock-ov";
        d.innerHTML = '<div class="lock-in"><span>🔒 PRO</span><button class="btn primary mini" onclick="openPay()">' + t("au.upgrade") + '</button></div>';
        el.appendChild(d);
      } else if (!locked && ov) {
        ov.remove();
      }
    });
  }
  window.applyGates = applyGates;

  /* ── 付費彈窗 ── */
  function openPay() {
    if (!state.addr) {
      // 未登入 → 先弹钱包选择
      if (!window.hasWallet || !window.hasWallet()) {
        if (window.arkShowWalletPicker) window.arkShowWalletPicker();
        else connectWallet();
      } else {
        connectWallet();
      }
      return;
    }
    var m = $("payModal");
    if (m) m.classList.add("on");
    loadPlans();
  }
  window.openPay = openPay;

  function closePay() {
    var m = $("payModal");
    if (m) m.classList.remove("on");
  }
  window.closePay = closePay;

  var PLANS_CACHE = null;
  function loadPlans() {
    if (PLANS_CACHE) { renderPlans(PLANS_CACHE); return; }
    fetch("/api/plans").then(function (r) { return r.json(); }).then(function (d) {
      PLANS_CACHE = d;
      renderPlans(d);
    });
  }

  function renderPlans(d) {
    var box = $("payPlans");
    if (!box) return;
    if (!d || !d.plans) {
      box.innerHTML = '<div class="dn" style="grid-column:1/-1;text-align:center">方案載入失敗，請重新整理</div>';
      return;
    }
    var keys = ["pro", "vip"];   // 測試 / 專業 / 旗艦
    var html = keys.map(function (k) {
      var p = d.plans[k];
      if (!p) return "";                  // ⭐ 方案不存在 → 跳過（不崩潰）
      var nm = (p.name && (p.name[window.I18NRT ? window.I18NRT.get() : "zh-TW"])) || k;
      return '<div class="pay-plan">' +
        '<div class="pp-name">' + nm + '</div>' +
        '<div class="pp-price">' + p.ark + ' <small>ARK</small></div>' +
        '<div class="mut">' + ((p.label && (p.label[window.I18NRT ? window.I18NRT.get() : "zh-TW"] || p.label.en)) || (p.months + ' 月')) + '</div>' +
        '<button class="btn primary" style="width:100%;margin-top:12px" onclick="buyPlan(\'' + k + '\')">' + t("au.buy") + '</button></div>';
    }).join("");
    box.innerHTML = html || '<div class="dn" style="grid-column:1/-1;text-align:center">暫無可用方案</div>';
    var pt = $("payTo");
    if (pt) pt.textContent = d.payTo;
    window._payTo = d.payTo;
  }

  /* ── 購買：產生發票 → 轉帳 → 輪詢確認 ── */
  function buyPlan(plan) {
    fetch("/api/invoice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addr: state.addr, plan: plan })
    }).then(function (r) { return r.json(); }).then(function (inv) {
      if (inv.error) { alert(inv.error); return; }
      // ⭐ 記錄付款意圖（跳轉回來可續接）
      if (window.arkSaveIntent) window.arkSaveIntent(plan, inv.id);
      showInvoice(inv);
    });
  }
  window.buyPlan = buyPlan;

  function showInvoice(inv) {
    var box = $("payInvoice");
    if (!box) return;
    box.style.display = "block";
    var ARK_TOKEN = "0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D";
    box.innerHTML =
      '<div class="inv-head">' +
        '<span class="mut">訂單 ' + inv.id + '</span>' +
        '<span class="inv-amount">' + inv.ark + ' ARK</span>' +
      '</div>' +
      '<div class="inv-row"><span class="mut">收款地址</span>' +
        '<button class="btn ghost mini" onclick="arkCopyText(\'' + inv.payTo + '\')">複製</button></div>' +
      '<div class="mono inv-addr" style="text-align:center;letter-spacing:.5px">' +
        inv.payTo.slice(0, 8) + '...' + inv.payTo.slice(-6) + '</div>' +
      '<div class="inv-bal" id="invBal">正在檢查餘額…</div>' +
      '<button class="btn primary inv-paybtn" id="invPayBtn" onclick="payWithWallet(\'' + inv.id + '\',\'' + inv.payTo + '\',' + inv.ark + ')">' + t("au.payNow") + '</button>' +
      '<div class="inv-status" id="payStatus">按上方按鈕，錢包將彈出轉帳確認</div>';
    checkMyBalance();
  }

  /* ── 檢查用戶 ARK / BNB 餘額 ── */
  function checkMyBalance() {
    var p = window.arkActiveProvider ? window.arkActiveProvider() : (window.ethereum || window.tokenpocket);
    if (!p || !state.addr) return;
    var ARK_TOKEN = "0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D";
    var addr = state.addr;
    var pad = addr.slice(2).toLowerCase().padStart(64, "0");
    Promise.all([
      p.request({ method: "eth_call", params: [{ to: ARK_TOKEN, data: "0x70a08231" + pad }, "latest"] }).catch(function () { return "0x0"; }),
      p.request({ method: "eth_getBalance", params: [addr, "latest"] }).catch(function () { return "0x0"; })
    ]).then(function (r) {
      var ark = Number(BigInt(r[0] || "0x0")) / 1e18;
      var bnb = Number(BigInt(r[1] || "0x0")) / 1e18;
      var el = $("invBal");
      if (!el) return;
      var ok = ark >= 0.01;
      var gasOk = bnb >= 0.0001;
      el.innerHTML =
        '<span class="tag ' + (ok ? "up" : "dn") + '">ARK: ' + ark.toFixed(4) + '</span>' +
        '<span class="tag ' + (gasOk ? "up" : "dn") + '">BNB: ' + bnb.toFixed(5) + '</span>' +
        (!ok ? '<span class="dn">⚠️ ARK 不足</span>' : '') +
        (!gasOk ? '<span class="dn">⚠️ BNB 不足（gas）</span>' : '');
      var btn = $("invPayBtn");
      if (btn) btn.disabled = !ok || !gasOk;
    });
  }
  window.checkMyBalance = checkMyBalance;

  function arkCopyText(s) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(s);
      else {
        var t = document.createElement("textarea"); t.value = s; document.body.appendChild(t); t.select();
        document.execCommand("copy"); document.body.removeChild(t);
      }
      alert("已複製：\n" + s);
    } catch (e) { alert("請手動複製：\n" + s); }
  }
  window.arkCopyText = arkCopyText;

  /* ── 用錢包轉 ARK（統一入口，自動跳轉錢包） ── */
  function payWithWallet(invId, payTo, arkAmount) {
    console.log("[payWithWallet]", invId, payTo, arkAmount);
    // ⭐ 优先走【分配合约】（自动三级分润）
    if (window.arkPayViaContract) {
      setPayStatus("通过合约支付（自动分润）…");
      window.arkPayViaContract(arkAmount, {
        onStatus: function (m) { setPayStatus(m); },
        onSent: function (h) {
          setPayStatus(t("au.txSent") + ": " + String(h).slice(0, 20) + "...");
          pollInvoice(invId, h, 0);
        },
        onError: function (m) {
          // 合约失败 → 回退到直接转账
          console.warn("[payWithWallet] contract failed, fallback:", m);
          _payDirect(invId, payTo, arkAmount);
        }
      });
      return;
    }
    _payDirect(invId, payTo, arkAmount);
  }

  function _payDirect(invId, payTo, arkAmount) {
    if (!window.arkPay) {
      setPayStatus("付款模組未載入，請重新整理", "dn");
      console.error("arkPay missing");
      return;
    }
    if (!payTo) {
      setPayStatus("收款地址缺失", "dn");
      return;
    }
    window.arkPay(payTo, arkAmount, {
      label: "inv:" + invId,
      onStatus: function (m) { setPayStatus(m); },
      onSent: function (h) {
        setPayStatus(t("au.txSent") + ": " + String(h).slice(0, 20) + "...");
        pollInvoice(invId, h, 0);
      },
      onError: function (m) {
        if (m === "NO_LOGIN") setPayStatus("請先錢包登入", "dn");
        else if (m === "NO_WALLET") setPayStatus("未檢測到錢包，請在錢包 App 內打開", "dn");
        else if (m === "USER_REJECTED" || m.indexOf("4001") >= 0) setPayStatus("你取消了轉帳", "dn");
        else if (m === "INSUFFICIENT" || m.indexOf("insufficient") >= 0) setPayStatus("餘額不足（需 ARK + BNB gas）", "dn");
        else setPayStatus("失敗：" + String(m).slice(0, 80), "dn");
      }
    });
  }
  window.payWithWallet = payWithWallet;   // ⭐ 導出（按鈕 onclick 調用）

  function setPayStatus(s, cls) {
    var e = $("payStatus");
    if (e) { e.textContent = s; e.className = "mut " + (cls || ""); }
  }

  function pollInvoice(invId, txHash, n) {
    if (n > 60) { setPayStatus(t("au.timeout"), "dn"); return; }
    fetch("/api/invoice/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invId: invId, txHash: txHash })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.status === "paid") {
        if (window.arkClearIntent) window.arkClearIntent();
        setPayStatus(t("au.paid") + " ✅", "up");
        // ⭐ 支付成功 → 刷新状态 + 显示绑定码
        setTimeout(function () {
          if (window.refreshAuth) window.refreshAuth();
          restore();
          _onUpgraded(state.addr);
        }, 1200);
      } else {
        setPayStatus((d.detail || t("au.waiting")) + " (" + (n + 1) + ")");
        setTimeout(function () { pollInvoice(invId, txHash, n + 1); }, 5000);
      }
    }).catch(function () {
      setTimeout(function () { pollInvoice(invId, txHash, n + 1); }, 5000);
    });
  }

  document.addEventListener("DOMContentLoaded", restore);
})();

/* ── 網路狀態 + 切換 BSC ── */
(function () {
  function $(id) { return document.getElementById(id); }
  function provider() { return window.arkProvider ? window.arkProvider() : (window.ethereum || null); }

  function refreshNet() {
    var p = provider();
    var nm = $("netName");
    if (!p || !nm) return;
    p.request({ method: "eth_chainId" }).then(function (cid) {
      var hex = String(cid).toLowerCase();
      if (hex === "0x38" || hex === "56") {
        nm.textContent = "BSC (56)";
        nm.className = "ok";
      } else {
        var map = { "0x1": "Ethereum", "0x89": "Polygon", "0xa4b1": "Arbitrum", "0x2105": "Base" };
        nm.textContent = (map[hex] || hex) + " → 需切換";
        nm.className = "bad";
      }
    }).catch(function () {});
  }
  window.refreshNet = refreshNet;

  window.switchBSC = function () {
    if (!window.ensureBSC) return;
    window.ensureBSC().then(function () {
      refreshNet();
      alert("已切換到 BSC ✅");
    }).catch(function (e) {
      alert("切換失敗，請在 TP 錢包手動切換到 BNB Smart Chain\n" + String(e.message || e).slice(0, 80));
    });
  };

  document.addEventListener("DOMContentLoaded", function () {
    refreshNet();
    setInterval(refreshNet, 5000);
  });
})();

/* ══════════ 一体化升级流程（选钱包→连接→自动创建订单→转账→开通→绑定码） ══════════ */
(function () {
  "use strict";
  var _pendingPlan = null;

  // 入口：点"升級PRO" → 未登录先登录，登录后自动进入支付
  // ⭐ 跳转回来自动续接升级（供 flow.js 调用）
  window._arkResumePay = function (plan) {
    var addr = (window.state && window.state.addr) || (function(){ try { return localStorage.getItem("ark_auth_addr") || localStorage.getItem("ark_addr"); } catch(e){ return null; } })();
    if (!addr) return;
    _doUpgrade(addr, plan || "pro");
  };
  // ⭐ 启动时检查升级意图（跳转回来）
  (function(){
    try {
      var it = JSON.parse(localStorage.getItem("ark_upgrade_intent") || "null");
      if (!it) return;
      if (Date.now() - it.ts > 3600*1000) { localStorage.removeItem("ark_upgrade_intent"); return; }
      // 等登录完成
      var tries = 0;
      var tm = setInterval(function(){
        tries++;
        var addr = (window.state && window.state.addr) || (function(){ try { return localStorage.getItem("ark_auth_addr") || localStorage.getItem("ark_addr"); } catch(e){ return null; } })();
        var inWallet = !!(window.ethereum || window.tokenpocket);
        if (addr && inWallet) {
          clearInterval(tm); localStorage.removeItem("ark_upgrade_intent");
          setTimeout(function(){ if (window._doUpgradePublic) window._doUpgradePublic(addr, it.plan); }, 1000);
        }
        if (tries > 60) clearInterval(tm);
      }, 500);
    } catch(e){}
  })();

  // ⭐ 启动时读取 URL 中的升级意图
  (function(){
    var m = /#upgrade=([^&]+)/.exec(location.hash || "");
    if (m) {
      try { localStorage.setItem("ark_upgrade_intent", JSON.stringify({ plan: decodeURIComponent(m[1]), ts: Date.now() })); } catch(e){}
      try { history.replaceState(null,"",location.pathname+location.search); } catch(e){}
    }
  })();
  window.startUpgrade = function (plan) {
    _pendingPlan = plan || "pro";
    // ⭐ 保存升级意图（跨 App 保留）
    try { localStorage.setItem("ark_upgrade_intent", JSON.stringify({ plan: _pendingPlan, ts: Date.now() })); } catch(e){}
    var addr = (window.state && window.state.addr) || (function(){ try { return localStorage.getItem("ark_auth_addr") || localStorage.getItem("ark_addr"); } catch(e){ return null; } })();
    if (!addr) {
      // ① 未登录 → 弹钱包 → 连接 → 登录
      window._pendingUpgradePlan = _pendingPlan;
      if (window.arkShowWalletPicker && (!window.hasWallet || !window.hasWallet())) {
        window.arkShowWalletPicker();
      } else if (window.connectWallet) {
        window.connectWallet();
      }
      return;
    }
    // 已登录 → 直接建单
    _doUpgrade(addr, _pendingPlan);
  };

  // ②③④ 建单 → 转账 → 轮询
  window._doUpgradePublic = function(a,p){ return _doUpgrade(a,p); };
  function _doUpgrade(addr, plan) {
    fetch("/api/invoice", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addr: addr, plan: plan })
    }).then(function (r) { return r.json(); }).then(function (inv) {
      if (inv.error) { alert("创建订单失败: " + inv.error); return; }
      _doTransfer(inv, addr);
    }).catch(function () { alert("网络错误"); });
  }

  function _doTransfer(inv, addr) {
    var payTo = inv.payTo || window._payTo;
    var amountArk = inv.ark;
    if (!window.walletSendArk) { alert("钱包不支持自动转账，请手动转 " + amountArk + " ARK 到 " + payTo); return; }
    // ③ 钱包弹转账确认
    window.walletSendArk(payTo, amountArk).then(function (txHash) {
      // ④ 链上确认 → 轮询
      _pollConfirm(inv.id, txHash, addr, 0);
    }).catch(function (e) {
      alert("转账未完成: " + (e && e.message || "用户取消"));
    });
  }

  function _pollConfirm(invId, txHash, addr, n) {
    if (n > 24) return;
    fetch("/api/invoice/check", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invId: invId, txHash: txHash })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok && d.status === "paid") {
        // ⑤ 开通成功 → 显示绑定码
        _onUpgraded(addr);
      } else {
        setTimeout(function () { _pollConfirm(invId, txHash, addr, n + 1); }, 5000);
      }
    }).catch(function () { setTimeout(function () { _pollConfirm(invId, txHash, addr, n + 1); }, 5000); });
  }

  function _onUpgraded(addr) {
    // 刷新状态
    if (window.refreshAuth) window.refreshAuth();
    // 生成绑定码
    fetch("/api/bind/gen", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addr: addr })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) _showBindSuccess(d.code);
    });
  }

  function _showBindSuccess(code) {
    var m = document.getElementById("payModal");
    if (!m) return;
    m.innerHTML = '<div class="pay-dialog" style="text-align:center">' +
      '<div style="font-size:44px;margin-bottom:10px">🎉</div>' +
      '<div style="font-size:19px;font-weight:800;color:#18c98a">升级成功！PRO 已开通</div>' +
      '<div class="mut" style="margin:12px 0 6px;font-size:13px">你的跨设备绑定码（30分钟内有效）</div>' +
      '<div style="font-size:40px;font-weight:900;font-family:ui-monospace,monospace;color:#35e0f5;letter-spacing:8px;margin:12px 0">' + code + '</div>' +
      '<div class="mut" style="font-size:12px;margin-bottom:18px">在电脑端输入此码即可登录使用（免装插件）</div>' +
      '<button class="btn ghost mini" onclick="navigator.clipboard&&navigator.clipboard.writeText(\'' + code + '\');this.textContent=\'✅ 已复制\'">复制绑定码</button>' +
      '<button class="btn primary" style="width:100%;margin-top:12px" onclick="location.reload()">完成</button>' +
      '</div>';
  }
})();
