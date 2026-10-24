/* ARK Citizen Tools - accounts, address monitor, withdrawal cost */
(function () {
  "use strict";

  var ACC_KEY = "ark_accounts";
  var MON_KEY = "ark_monitors";
  var LOG_KEY = "ark_monlog";

  function load(k, def) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? def : v; }
    catch (e) { return def; }
  }
  function save(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }

  function t(k) { return window.t ? window.t(k) : k; }
  function fmt(n, d) { return window.fmt ? window.fmt(n, d) : n; }
  function compound(p, r, d) { return window.compound ? window.compound(p, r, d) : p; }
  function PLANS() { return window.PLANS || {}; }

  /* ── 帳戶管理 ── */
  function addAccount() {
    var name = (document.getElementById("aName") || {}).value || "";
    var amt = parseFloat((document.getElementById("aAmt") || {}).value) || 0;
    var plan = (document.getElementById("aPlan") || {}).value || "360";
    if (amt <= 0) { alert(t("acc.count") + " > 0"); return; }
    var list = load(ACC_KEY, []);
    list.push({ id: Date.now(), name: name || ("Account " + (list.length + 1)), amt: amt, plan: plan });
    save(ACC_KEY, list);
    document.getElementById("aName").value = "";
    document.getElementById("aAmt").value = "";
    renderAccounts();
  }
  window.addAccount = addAccount;

  function delAccount(id) {
    var list = load(ACC_KEY, []).filter(function (a) { return a.id !== id; });
    save(ACC_KEY, list);
    renderAccounts();
  }
  window.delAccount = delAccount;

  function renderAccounts() {
    var list = load(ACC_KEY, []);
    var P = PLANS();
    var total = 0, daily = 0, yearly = 0;

    list.forEach(function (a) {
      var p = P[a.plan] || P["360"] || { days: 360, rateMax: 1 };
      var rate = p.rateMax || 1;
      total += a.amt;
      daily += a.amt * rate / 100;
      yearly += compound(a.amt, rate, 365) - a.amt;
    });

    function set(id, v) { var e = document.getElementById(id); if (e) e.textContent = v; }
    set("accTotal", fmt(total, 2));
    set("accCount", list.length);
    set("accDaily", fmt(daily, 2));
    set("accYearly", fmt(yearly, 0));

    var tb = document.getElementById("accTbody");
    if (tb) {
      tb.innerHTML = list.length ? list.map(function (a) {
        var p = P[a.plan] || {};
        return '<tr><td>' + a.name + '</td><td>' + fmt(a.amt, 2) + '</td><td>' + (p.label || a.plan) +
          '</td><td class="dn"><button class="btn ghost mini" onclick="delAccount(' + a.id + ')">' + t("common.del") + '</button></td></tr>';
      }).join("") : '<tr><td colspan="4" class="mut">' + t("common.none") + '</td></tr>';
    }

    // 收益曲線（各帳戶 365 天）
    if (document.getElementById("accChart") && window.makeChart) {
      var labels = [];
      for (var d = 0; d <= 365; d += 10) labels.push(d);
      var colors = ["#35e0f5", "#f2c14e", "#7c9bff", "#ff6b81", "#4ade80", "#c084fc"];
      var sets = list.slice(0, 6).map(function (a, i) {
        var p = P[a.plan] || { rateMax: 1 };
        return {
          label: a.name,
          data: labels.map(function (d) { return compound(a.amt, p.rateMax || 1, d); }),
          borderColor: colors[i % colors.length], backgroundColor: "transparent",
          tension: .35, pointRadius: 0, borderWidth: 2
        };
      });
      window.makeChart("accChart", {
        type: "line",
        data: { labels: labels.map(function (d) { return t("common.day") + " " + d; }), datasets: sets },
        options: window.baseOpts()
      });
    }
  }
  window.renderAccounts = renderAccounts;

  /* ── 提領成本建議 ── */
  function runWithdraw() {
    var amt = parseFloat((document.getElementById("wAmt") || {}).value) || 0;
    var bt = window.BURN_TABLE || [];
    var tb = document.getElementById("wTbody");
    if (!tb) return;
    tb.innerHTML = bt.map(function (r) {
      var got = amt * (1 - r.rate);
      var loss = amt * r.rate;
      return '<tr><td>' + r.period + '</td><td class="dn">' + (r.rate * 100).toFixed(0) + '%</td>' +
        '<td class="up">' + fmt(got, 2) + ' ARK</td><td class="dn">-' + fmt(loss, 2) + '</td></tr>';
    }).join("");
  }
  window.runWithdraw = runWithdraw;

  /* ── 地址監控 ── */
  function addMonitor() {
    var addr = ((document.getElementById("mAddr") || {}).value || "").trim();
    var label = ((document.getElementById("mLabel") || {}).value || "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) { alert("0x + 40 hex"); return; }
    var list = load(MON_KEY, []);
    if (list.some(function (m) { return m.addr.toLowerCase() === addr.toLowerCase(); })) { alert("exists"); return; }
    list.push({ addr: addr, label: label || addr.slice(0, 8), added: Date.now() });
    save(MON_KEY, list);
    document.getElementById("mAddr").value = "";
    document.getElementById("mLabel").value = "";
    renderMonitors();
  }
  window.addMonitor = addMonitor;

  function delMonitor(addr) {
    var list = load(MON_KEY, []).filter(function (m) { return m.addr !== addr; });
    save(MON_KEY, list);
    renderMonitors();
  }
  window.delMonitor = delMonitor;

  function renderMonitors() {
    var list = load(MON_KEY, []);
    var tb = document.getElementById("mTbody");
    if (!tb) return;
    tb.innerHTML = list.length ? list.map(function (m) {
      return '<tr><td>' + m.label + '</td><td class="mut mono">' + m.addr.slice(0, 10) + '...' + m.addr.slice(-6) +
        '</td><td class="dn"><button class="btn ghost mini" onclick="delMonitor(\'' + m.addr + '\')">' + t("common.del") + '</button></td></tr>';
    }).join("") : '<tr><td colspan="3" class="mut">' + t("common.none") + '</td></tr>';
  }
  window.renderMonitors = renderMonitors;

  function addLog(addr, msg) {
    var logs = load(LOG_KEY, []);
    logs.unshift({ t: Date.now(), addr: addr, msg: msg });
    save(LOG_KEY, logs.slice(0, 100));
    renderLogs();
  }
  window.addLog = addLog;

  function renderLogs() {
    var logs = load(LOG_KEY, []);
    var tb = document.getElementById("mLogTbody");
    if (!tb) return;
    tb.innerHTML = logs.length ? logs.map(function (l) {
      var d = new Date(l.t);
      var ts = d.toLocaleString();
      return '<tr><td class="mut">' + ts + '</td><td class="mono">' + l.addr.slice(0, 10) + '...</td><td>' + l.msg + '</td></tr>';
    }).join("") : '<tr><td colspan="3" class="mut">' + t("common.none") + '</td></tr>';
  }
  window.renderLogs = renderLogs;

  document.addEventListener("DOMContentLoaded", function () {
    renderAccounts();
    renderMonitors();
    renderLogs();
    if (document.getElementById("wTbody")) runWithdraw();
  });
})();
