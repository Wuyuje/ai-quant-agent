/* ARK Citizen Tools - phase3: history snapshots, notifications */
(function () {
  "use strict";

  var SNAP_KEY = "ark_snapshots";
  var NOTI_KEY = "ark_noti";

  function load(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function t(k) { return window.t ? window.t(k) : k; }
  function fmt(n, d) { return window.fmt ? window.fmt(n, d) : n; }

  var histRange = "30";

  /* ── 每次拿到鏈上數據就存一筆快照 ── */
  window.onChainData = function (d) {
    var snaps = load(SNAP_KEY, []);
    var last = snaps[snaps.length - 1];
    // 每 5 分鐘最多一筆
    if (last && d.ts - last.ts < 5 * 60 * 1000) return;
    snaps.push({ ts: d.ts, price: d.price, usdt: d.usdt, ark: d.ark });
    save(SNAP_KEY, snaps.slice(-2000));
    renderHistory();
  };

  /* ── 歷史走勢圖 ── */
  function renderHistory() {
    var el = document.getElementById("histChart");
    if (!el || !window.makeChart) return;
    var snaps = load(SNAP_KEY, []);
    var now = Date.now();
    var cut = 0;
    if (histRange === "7d") cut = now - 7 * 864e5;
    else if (histRange === "30d") cut = now - 30 * 864e5;
    var pts = snaps.filter(function (s) { return s.ts >= cut; });

    if (!pts.length && window._lastChain) {
      pts = [{ ts: window._lastChain.ts, price: window._lastChain.price }];
    }

    window.makeChart("histChart", {
      type: "line",
      data: {
        labels: pts.map(function (s) {
          var d = new Date(s.ts);
          return (d.getMonth() + 1) + "/" + d.getDate() + " " +
            String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
        }),
        datasets: [{
          label: t("chain.price"),
          data: pts.map(function (s) { return s.price; }),
          borderColor: "#f2c14e", backgroundColor: "rgba(242,193,78,.12)",
          fill: true, tension: .3, pointRadius: 0, borderWidth: 2
        }]
      },
      options: window.baseOpts()
    });
  }
  window.renderHistory = renderHistory;

  function setRange(r) {
    histRange = r;
    ["7d", "30d", "all"].forEach(function (k) {
      var b = document.getElementById("hbtn-" + k);
      if (b) b.classList.toggle("active", k === r);
    });
    renderHistory();
  }
  window.setRange = setRange;

  /* ── CSV 匯出 ── */
  function exportCSV() {
    var snaps = load(SNAP_KEY, []);
    if (!snaps.length) { alert(t("common.none")); return; }
    var lines = ["timestamp,datetime,ark_price,pool_usdt,pool_ark"];
    snaps.forEach(function (s) {
      lines.push([
        s.ts, new Date(s.ts).toISOString(),
        s.price != null ? s.price.toFixed(8) : "",
        s.usdt != null ? s.usdt.toFixed(4) : "",
        s.ark != null ? s.ark.toFixed(4) : ""
      ].join(","));
    });
    var blob = new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "ark-history-" + new Date().toISOString().slice(0, 10) + ".csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }
  window.exportCSV = exportCSV;

  /* ── 通知設定 ── */
  function switchNoti(tab) {
    ["tg", "wx"].forEach(function (k) {
      var p = document.getElementById("noti-" + k);
      var b = document.getElementById("notibtn-" + k);
      if (p) p.style.display = (k === tab) ? "block" : "none";
      if (b) b.classList.toggle("active", k === tab);
    });
  }
  window.switchNoti = switchNoti;


  /* ── 綁定 / 解綁 ── */
  function bindNoti() {
    var cfg = {
      tgToken: (document.getElementById("tgToken") || {}).value || "",
      tgChat: (document.getElementById("tgChat") || {}).value || "",
      wxKey: (document.getElementById("wxKey") || {}).value || ""
    };
    if (!cfg.tgToken && !cfg.wxKey) { alert(t("common.none")); return; }
    save(NOTI_KEY, cfg);
    setNotiStatus(t("noti.bound"));
    postNoti(cfg, "ARK Citizen Tools - bound OK");
  }
  window.bindNoti = bindNoti;

  function unbindNoti() {
    save(NOTI_KEY, {});
    ["tgToken", "tgChat", "wxKey"].forEach(function (id) {
      var e = document.getElementById(id); if (e) e.value = "";
    });
    setNotiStatus("");
    updateBindBtn(false);
    // ⭐ 同步清空服务器绑定
    var addr = (window.arkState && window.arkState.addr) || (function(){ try { return localStorage.getItem("ark_auth_addr") || localStorage.getItem("ark_addr") || ""; } catch(e){ return ""; } })();
    if (addr) {
      fetch("/api/noti-config", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addr: addr, tgToken: "", tgChat: "", wxKey: "" })
      }).catch(function(){});
    }
    alert(t("noti.unbind") + " OK");
  }
  window.unbindNoti = unbindNoti;

  function setNotiStatus(s) {
    var e = document.getElementById("notiStatus");
    if (e) e.textContent = s;
  }

  
  // ⭐ 统一地址获取：优先全局 → 云端接口 → 本地存储
  function getMyAddr() {
    var a = (window.arkState && window.arkState.addr) || "";
    if (a) return String(a).toLowerCase();
    try { a = localStorage.getItem("ark_auth_addr") || localStorage.getItem("ark_addr") || ""; } catch(e) {}
    if (a) return String(a).toLowerCase();
    return "";
  }

function saveNoti() {
    var cfg = {
      tgToken: (document.getElementById("tgToken") || {}).value || "",
      tgChat: (document.getElementById("tgChat") || {}).value || "",
      wxKey: (document.getElementById("wxKey") || {}).value || ""
    };
    save(NOTI_KEY, cfg);   // 本地存一份
    // ⭐ 同步到服务器（换设备/清缓存不丢）
    var addr = getMyAddr();
    if (!addr) {
      // ⭐ 地址还没准备好，等 1.5 秒重试一次（登录恢复常有延迟）
      setTimeout(function(){ saveNoti(); }, 1500);
      var st0 = document.getElementById("notiStatus");
      if (st0) { st0.textContent = "⏳ 等待钱包地址就绪，正在重试…"; st0.style.color = "#8ba3c7"; }
      return;
    }
    var st = document.getElementById("notiStatus");
    if (st) { st.textContent = "⏳ 正在同步到云端…"; st.style.color = "#8ba3c7"; }
    fetch("/api/noti-config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addr: addr, tgToken: cfg.tgToken, tgChat: cfg.tgChat, wxKey: cfg.wxKey })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (st) {
        if (d.ok) {
          // ⭐ 显示"绑定成功 + PRO 有效期内免二次绑定"
          var extra = "";
          if (d.proUntil && d.proUntil > Date.now()) {
            var days = Math.ceil((d.proUntil - Date.now()) / 86400000);
            extra = " · PRO 有效期内（剩 " + days + " 天）无需二次绑定";
          }
          st.textContent = "✅ 已保存并绑定到云端" + extra + "（换设备/清缓存不丢）";
          st.style.color = "#18c98a";
          updateBindBtn(true);
        }
        else { st.textContent = "⚠️ 本地已存，云端同步失败: " + (d.error || ""); st.style.color = "#f5a623"; }
      }
    }).catch(function (e) {
      if (st) { st.textContent = "⚠️ 本地已存，云端同步失败: " + e.message; st.style.color = "#f5a623"; }
    });
  }
  window.saveNoti = saveNoti;

  /* ⭐ 更新绑定按钮状态（已绑定 → 显示 ✓） */
  function updateBindBtn(bound) {
    var btn = document.querySelector('[data-i18n="noti.save"]') ||
              document.querySelector('#notiActionArea .btn.primary');
    if (!btn) {
      var all = document.querySelectorAll('#notiActionArea .btn.primary');
      btn = all[0];
    }
    if (!btn) return;
    if (bound) {
      btn.textContent = "✅ 已绑定（有效期内免二次绑定）";
      btn.classList.add("bound");
      btn.style.background = "linear-gradient(135deg,#18c98a,#0fa36f)";
      btn.style.color = "#fff";
    } else {
      btn.textContent = t("noti.save");
      btn.classList.remove("bound");
      btn.style.background = "";
      btn.style.color = "";
    }
  }
  window.updateBindBtn = updateBindBtn;

  function testNoti() {
    var cfg = load(NOTI_KEY, {});
    if (!cfg.tgToken && !cfg.wxKey) {
      cfg = {
        tgToken: (document.getElementById("tgToken") || {}).value || "",
        tgChat: (document.getElementById("tgChat") || {}).value || "",
        wxKey: (document.getElementById("wxKey") || {}).value || ""
      };
    }
    // 🔊 本地长提醒（长语音+音乐+振动，循环直到确认）
    try { window.speakArk && window.speakArk('ARK 提醒测试，长语音加音乐加振动，循环播放直到你确认'); } catch(e){}
    // ☁️ 同时发到云端通道（Telegram / 微信）
    postNoti(cfg, "ARK Citizen Tools - test OK");
  }
  window.testNoti = testNoti;

  function postNoti(cfg, msg) {
    var st = document.getElementById("notiStatus");
    // ⭐ 格式预检
    if (cfg.wxKey) {
      if (/^wxid_/i.test(cfg.wxKey)) {
        var m1 = "❌ 你填的是微信个人号 ID（wxid_开头），不是 SendKey\n\n正确做法：\n① 打开 https://sct.ftqq.com/ 微信扫码登录\n② 复制 SendKey（SCT 开头，约 40 位）\n③ 粘贴后再点发送测试";
        if (st) { st.textContent = m1; st.style.color = "#f2555f"; }
        alert(m1); return;
      }
      if (!/^SCT/i.test(cfg.wxKey)) {
        var m2 = "❌ SendKey 格式不对，应以 SCT 开头\n\n请检查是否复制完整（约 40 位字符）";
        if (st) { st.textContent = m2; st.style.color = "#f2555f"; }
        alert(m2); return;
      }
    }
    if (cfg.tgToken && cfg.tgChat) {
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(cfg.tgToken.trim())) {
        var m3 = "❌ Bot Token 格式不对（应为 数字:字母数字）";
        if (st) { st.textContent = m3; st.style.color = "#f2555f"; }
        alert(m3); return;
      }
      if (!/^-?\d+$/.test(cfg.tgChat.trim())) {
        var m4 = "❌ Chat ID 应为纯数字";
        if (st) { st.textContent = m4; st.style.color = "#f2555f"; }
        alert(m4); return;
      }
    }
    fetch("/api/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tgToken: cfg.tgToken, tgChat: cfg.tgChat, wxKey: cfg.wxKey,
        message: msg
      })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) {
        var okMsg = "✅ 发送成功！\n\n请去微信「服务通知」查看（不是聊天列表）\n若没收到，检查微信是否屏蔽了服务通知";
        if (st) { st.textContent = okMsg.split("\n")[0]; st.style.color = "#18c98a"; }
        alert(okMsg);
      } else {
        var detail = d.detail || d.error || "";
        var failMsg;
        if (/错误的Key|invalid|AUTH/i.test(detail)) {
          failMsg = "❌ SendKey 无效\n\n服务器返回: " + detail + "\n\n请重新获取：\n① https://sct.ftqq.com/ 微信扫码登录\n② 复制 SendKey（SCT 开头约40位）\n③ 确认完整后重试";
        } else {
          failMsg = "❌ 发送失败: " + detail;
        }
        if (st) { st.textContent = failMsg.split("\n")[0]; st.style.color = "#f2555f"; }
        alert(failMsg);
      }
    }).catch(function (e) { alert("❌ 网络错误: " + e.message); });
  }

  /* ── 初始化：恢復表單 ── */
  document.addEventListener("DOMContentLoaded", function () {
    var cfg = load(NOTI_KEY, {});
    function set(id, v) { var e = document.getElementById(id); if (e && v) e.value = v; }
    set("tgToken", cfg.tgToken); set("tgChat", cfg.tgChat); set("wxKey", cfg.wxKey);
    switchNoti("tg");
    setRange("30d");
    setNotiStatus(cfg.tgToken || cfg.wxKey ? t("noti.bound") : "");
    if (cfg.tgToken || cfg.wxKey) updateBindBtn(true);

    // ⭐ 从服务器拉取云端配置（换设备/清缓存不丢）
    // 兼容多来源地址：window.arkState / window.state / localStorage / window.ARK_ADDR
    function getAddr() {
      try {
        if (window.arkState && window.arkState.addr) return window.arkState.addr;
        if (window.state && window.state.addr) return window.state.addr;
        if (window.ARK_ADDR) return window.ARK_ADDR;
        return localStorage.getItem("ark_auth_addr") || localStorage.getItem("ark_addr") || "";
      } catch(e) { return ""; }
    }
    var _lastRestored = "";
    function loadFromServer(force) {
      var addr = getAddr();
      if (!addr) return false;
      // 表单为空(例如刚重新登录) → 即使同地址也强制恢复
      var formEmpty = !((document.getElementById("tgToken") || {}).value || (document.getElementById("wxKey") || {}).value);
      if (formEmpty) force = true;
      // 已恢复过同一地址且非强制 → 跳过（避免重复覆盖用户刚填的内容）
      if (!force && _lastRestored === addr) return false;
      var myAddr = addr;
      fetch("/api/noti-config?addr=" + encodeURIComponent(addr) + "&full=1")
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || !d.ok) return;
          // ⚠️ 地址已变（用户切换账户）→ 丢弃这次结果
          if (getAddr().toLowerCase() !== myAddr.toLowerCase()) return;
          var hasCloud = d.hasTg || d.hasWx;
          var hasLocal = cfg.tgToken || cfg.wxKey;
          if (hasCloud) {
            // ⭐ 云端有配置 → 完整恢复到表单（换设备/清缓存不丢）
            if (d.tgToken) set("tgToken", d.tgToken);
            if (d.tgChat) set("tgChat", d.tgChat);
            if (d.wxKey) set("wxKey", d.wxKey);
            // ⭐ 記錄已恢復的值（供 coefChHint 使用，避免被清空）
            window.__ARK_NOTI_RESTORED = { tgToken: d.tgToken || "", tgChat: d.tgChat || "", wxKey: d.wxKey || "" };
            // ⭐ 同时填「係數漲高提醒」面板的輸入框（coefTarget）
            try {
              var ct = document.getElementById("coefTarget");
              if (ct && d.wxKey) {
                var chSel = (document.getElementById("coefCh") || {}).value;
                if (chSel === "wechat" || !chSel) ct.value = d.wxKey;
              }
              if (ct && d.tgToken && d.tgChat) {
                var chSel2 = (document.getElementById("coefCh") || {}).value;
                if (chSel2 === "telegram") ct.value = d.tgToken + "|" + d.tgChat;
              }
            } catch (e) {}
            // 同步到本地
            var merged = { tgToken: d.tgToken || "", tgChat: d.tgChat || "", wxKey: d.wxKey || "" };
            save(NOTI_KEY, merged);
            cfg = merged;
            _lastRestored = myAddr;
            var st = document.getElementById("notiStatus");
            if (st) {
              var proMsg = "";
              if (d.proActive) {
                var dd = Math.ceil((d.proUntil - Date.now()) / 86400000);
                proMsg = " · PRO 有效期内（剩 " + dd + " 天）无需二次绑定";
              }
              st.textContent = "☁️ 已从云端恢复绑定" + (d.hasTg ? " · Telegram" : "") + (d.hasWx ? " · 微信" : "") + proMsg + "（无需重新绑定）";
              st.style.color = "#18c98a";
            }
            updateBindBtn(true);
          } else if (hasLocal) {
            // 本地有但云端没有 → 自动上传
            _lastRestored = myAddr;
            fetch("/api/noti-config", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ addr: addr, tgToken: cfg.tgToken, tgChat: cfg.tgChat, wxKey: cfg.wxKey })
            }).then(function(){ var st2 = document.getElementById("notiStatus"); if (st2) { st2.textContent = "☁️ 已将本地配置同步到云端"; st2.style.color = "#18c98a"; } }).catch(function(){});
          }
        }).catch(function () {});
      return true;
    }
    window.loadNotiFromServer = loadFromServer;

    // ⭐ 多重触发 + 重试（解决 auth2.js 异步 restore 的时序问题）
    var _tries = 0;
    function tryRestore() {
      _tries++;
      if (loadFromServer(false)) return;               // 成功取到地址 → 停止重试
      if (_tries < 120) setTimeout(tryRestore, 500);    // 持续重试最长 60 秒（登录慢也不怕）
    }
    setTimeout(tryRestore, 300);

    // 钱包登录/账户切换后立即重拉
    window.addEventListener("ark:auth", function(){ setTimeout(function(){ loadFromServer(true); }, 400); });
    // 页面从后台切回时重拉（防漏）
    document.addEventListener("visibilitychange", function(){ if (!document.hidden) loadFromServer(false); });
  });
})();

  var _prevLangHook = window.onLangChange;
  window.onLangChange = function (lg) {
    if (typeof _prevLangHook === "function") _prevLangHook(lg);
    renderHistory();
  };
