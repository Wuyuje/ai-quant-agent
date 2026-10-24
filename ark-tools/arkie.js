/* ARK Citizen Tools - ARKIE 子幣：底層邏輯與生態可視化 */
(function () {
  "use strict";

  function t(k) { return window.t ? window.t(k) : k; }
  function fmt(n, d) { return window.fmt ? window.fmt(n, d) : n; }
  function fC(n) { return window.fmtCompact ? window.fmtCompact(n) : n; }

  /* ═══ ARKIE 生態定位（白皮書 v18） ═══ */
  var ARKIE_ROLES = [
    {
      icon: "🎯", key: "arkie.role.exec",
      title: { "zh-TW": "數字世界智能執行官", "zh-CN": "数字世界智能执行官", en: "Digital Executive Officer", ja: "デジタル執行官", ko: "디지털 집행관", es: "Ejecutivo Digital", vi: "Giam doc so" },
      desc: {
        "zh-TW": "不是陪聊機器人。它是每位方舟公民的數字分身與得力助手，存在的意義是將人類繁重勞動轉化為智能合約自動執行的成果。",
        "zh-CN": "不是陪聊机器人。它是每位方舟公民的数字分身与得力助手，存在的意义是将人类繁重劳动转化为智能合约自动执行的成果。",
        en: "Not a chatbot. It is every citizen's digital twin, turning heavy human labour into smart-contract automated delivery.",
        ja: "雑談ボットではない。各市民のデジタル分身であり、重労働をスマートコントラクト自動執行へ変換する。",
        ko: "단순 챗봇이 아닙니다. 시민의 디지털 분신이며, 무거운 노동을 스마트 계약 자동 실행으로 전환합니다.",
        es: "No es un chatbot. Es el gemelo digital de cada ciudadano; convierte el trabajo pesado en entrega automatizada.",
        vi: "Khong phai chatbot. La ban sao so cua moi cong dan, chuyen lao dong nang thanh tu dong hoa."
      }
    },
    {
      icon: "📦", key: "arkie.role.delivery",
      title: { "zh-TW": "Delivery 交付邏輯", "zh-CN": "Delivery 交付逻辑", en: "Delivery-First Logic", ja: "デリバリー優先", ko: "납품 우선", es: "Entrega Primero", vi: "Giao ket qua" },
      desc: {
        "zh-TW": "傳統 AI 停留在「信息輸出」。ARKIE 的核心是「交付結果」：直接給任務清單、SOP 流程、做好排版的 PPT、切好分鏡的腳本。",
        "zh-CN": "传统 AI 停留在「信息输出」。ARKIE 的核心是「交付结果」：直接给任务清单、SOP 流程、做好排版的 PPT、切好分镜的脚本。",
        en: "Legacy AI outputs information. ARKIE delivers results: task lists, SOP flows, formatted decks, shot-listed scripts.",
        ja: "従来AIは情報出力止まり。ARKIEは結果を納品：タスクリスト、SOP、整形済みPPT、絵コンテ付き台本。",
        ko: "기존 AI는 정보 출력. ARKIE는 결과 납품: 작업 목록, SOP, 서식 PPT, 스토리보드 스크립트.",
        es: "La IA tradicional emite informacion. ARKIE entrega resultados: listas, SOP, PPT formateado, guiones.",
        vi: "AI cu chi xuat thong tin. ARKIE giao ket qua: danh sach, SOP, PPT, kich ban."
      }
    },
    {
      icon: "🧠", key: "arkie.role.five",
      title: { "zh-TW": "五段進化能力", "zh-CN": "五段进化能力", en: "Five-Stage Evolution", ja: "五段階進化", ko: "5단계 진화", es: "Evolucion en Cinco Etapas", vi: "Nam buoc tien hoa" },
      desc: {
        "zh-TW": "① 寫文案腳本 ② 語音講解 ③ 看圖表資料 ④ 整理 SOP 體系 ⑤ 會做事（拆解目標 → 追蹤 → 復盤）",
        "zh-CN": "① 写文案脚本 ② 语音讲解 ③ 看图表资料 ④ 整理 SOP 体系 ⑤ 会做事（拆解目标 → 追踪 → 复盘）",
        en: "1. Copywriting 2. Voice narration 3. Chart reading 4. SOP building 5. Executing (decompose -> track -> review)",
        ja: "1. コピー執筆 2. 音声解説 3. チャート読解 4. SOP構築 5. 実行（分解→追跡→振り返り）",
        ko: "1. 카피 2. 음성 해설 3. 차트 판독 4. SOP 구축 5. 실행(분해→추적→복기)",
        es: "1. Copy 2. Narracion 3. Lectura de graficos 4. SOP 5. Ejecucion (desglosar->seguir->revisar)",
        vi: "1. Copy 2. Thuyet minh 3. Doc bieu do 4. Xay SOP 5. Thuc thi (chia nho -> theo doi -> tong ket)"
      }
    }
  ];

  /* ═══ 造血閉環（輸入端 → 輸出端） ═══ */
  var FLYWHEEL_IN = [
    { k: "arkie.fw.sub",  v: "C 端訂閱 / 按量付費" },
    { k: "arkie.fw.api",  v: "B 端 API / 私有化部署" },
    { k: "arkie.fw.402",  v: "402 協議結算費" },
    { k: "arkie.fw.market", v: "插件市場抽成" }
  ];
  var FLYWHEEL_OUT = [
    { k: "arkie.fw.gpu",  v: "擴充 GPU 算力" },
    { k: "arkie.fw.model", v: "訓練阿奇更強" },
    { k: "arkie.fw.burn", v: "回購代幣並銷毀" },
    { k: "arkie.fw.holder", v: "持有人被動增值" }
  ];

  function renderArkieRoles() {
    var box = document.getElementById("arkieRoles");
    if (!box) return;
    var lg = window.I18NRT ? window.I18NRT.get() : "zh-TW";
    box.innerHTML = ARKIE_ROLES.map(function (r) {
      return '<div class="mod-card" style="border-left-color:#f2c14e">' +
        '<div class="mod-head"><span class="mod-ico">' + r.icon + '</span></div>' +
        '<div class="mod-name">' + (r.title[lg] || r.title["zh-TW"]) + '</div>' +
        '<p class="mod-desc">' + (r.desc[lg] || r.desc["zh-TW"]) + '</p></div>';
    }).join("");
  }
  window.renderArkieRoles = renderArkieRoles;

  function renderFlywheel() {
    var el = document.getElementById("flywheel");
    if (!el) return;
    el.innerHTML =
      '<div class="fw-side in"><div class="fw-title">' + t("arkie.fw.in") + '</div>' +
      FLYWHEEL_IN.map(function (x) { return '<div class="fw-item">' + t(x.k) + '</div>'; }).join("") + '</div>' +
      '<div class="fw-core">♻️<div class="fw-core-txt">' + t("arkie.fw.core") + '</div></div>' +
      '<div class="fw-side out"><div class="fw-title">' + t("arkie.fw.out") + '</div>' +
      FLYWHEEL_OUT.map(function (x) { return '<div class="fw-item">' + t(x.k) + '</div>'; }).join("") + '</div>';
  }
  window.renderFlywheel = renderFlywheel;

  /* ═══ ARKIE 市場數據 ═══ */
  function paintArkie(d) {
    function set(id, v) { var e = document.getElementById(id); if (e) e.textContent = v; }
    if (d.priceUsd != null) set("akPrice", "$" + Number(d.priceUsd).toFixed(4));
    if (d.priceInArk != null) set("akPriceArk", Number(d.priceInArk).toFixed(4) + " ARK");
    if (d.marketCap) set("akMcap", "$" + fC(d.marketCap));
    if (d.liquidityUsd) set("akLiq", "$" + fC(d.liquidityUsd));
    if (d.totalSupply) set("akSupply", fC(d.totalSupply) + " ARKIE");
    if (d.poolArkie) set("akPoolArkie", fC(d.poolArkie) + " ARKIE");
    if (d.poolArk) set("akPoolArk", fC(d.poolArk) + " ARK");
    var v24 = (d.volume && d.volume.h24) || 0;
    if (v24) set("akVol24", "$" + fC(v24));
    var pc = d.priceChange || {};
    var ce = document.getElementById("akChg");
    if (ce && pc.h24 != null) {
      ce.textContent = pc.h24 + "% (24h)";
      ce.className = "mut " + (pc.h24 >= 0 ? "up" : "dn");
    }
    // 交易表
    var tb = document.getElementById("akTbody");
    if (tb && d.txns) {
      var rows = [["m5", t("flow.m5")], ["h1", t("flow.h1")], ["h6", t("flow.h6")], ["h24", t("flow.h24")]];
      tb.innerHTML = rows.map(function (r) {
        var x = d.txns[r[0]] || {};
        var b = x.buys || 0, s = x.sells || 0, n = b - s;
        return '<tr><td>' + r[1] + '</td><td class="up">' + fmt(b) + '</td><td class="dn">' + fmt(s) +
          '</td><td class="' + (n >= 0 ? "up" : "dn") + '">' + (n >= 0 ? "+" : "") + fmt(n) + '</td></tr>';
    }).join("");
    }
    window._arkie = d;
  }
  window.paintArkie = paintArkie;

  function loadArkie() {
    fetch("/api/arkie").then(function (r) { return r.json(); }).then(function (d) {
      if (d && !d.error) paintArkie(d);
    }).catch(function () {});
  }
  window.loadArkie = loadArkie;

  /* ═══ ARKIE/ARK 兌換計算器 ═══ */
  function runArkieSwap() {
    var amt = parseFloat((document.getElementById("akAmt") || {}).value) || 0;
    var mode = (document.getElementById("akMode") || {}).value || "ark2arkie";
    var d = window._arkie || {};
    var rate = d.priceInArk || 3.7751;   // 1 ARKIE = N ARK
    var out, label;
    if (mode === "ark2arkie") {
      out = rate > 0 ? amt / rate : 0;
      label = "ARKIE";
    } else {
      out = amt * rate;
      label = "ARK";
    }
    var e1 = document.getElementById("akOut");
    if (e1) e1.textContent = fmt(out, 4) + " " + label;
    var e2 = document.getElementById("akRate");
    if (e2) e2.textContent = "1 ARKIE = " + Number(rate).toFixed(4) + " ARK";
  }
  window.runArkieSwap = runArkieSwap;

  /* ═══ ARKIE 分配結構（圖表） ═══ */
  function renderArkieAlloc() {
    var el = document.getElementById("akAllocChart");
    if (!el || !window.makeChart) return;
    // 生態分配（示意：依白皮書「質押/流動性/生態/團隊/國庫」）
    var labels = ["質押 Staking", "流動性 LP", "生態 Eco", "國庫 Treasury", "團隊 Team"];
    var vals = [40, 25, 18, 12, 5];
    window.makeChart("akAllocChart", {
      type: "doughnut",
      data: {
        labels: labels,
        datasets: [{
          data: vals,
          backgroundColor: ["#35e0f5", "#7c9bff", "#f2c14e", "#4ade80", "#c084fc"],
          borderColor: "#0e1830", borderWidth: 2
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: "right", labels: { color: "#93a4c8", boxWidth: 12, font: { size: 11 } } },
          tooltip: { backgroundColor: "rgba(10,18,38,.95)", borderColor: "#35e0f5", borderWidth: 1, titleColor: "#e8eefc", bodyColor: "#93a4c8" }
        }
      }
    });
  }
  window.renderArkieAlloc = renderArkieAlloc;

  /* ═══ 初始化 ═══ */
  document.addEventListener("DOMContentLoaded", function () {
    if (document.getElementById("arkieRoles")) renderArkieRoles();
    if (document.getElementById("flywheel")) renderFlywheel();
    if (document.getElementById("akPrice")) loadArkie();
    if (document.getElementById("akAmt")) runArkieSwap();
    if (document.getElementById("akAllocChart")) renderArkieAlloc();
    setInterval(loadArkie, 60000);
  });

  var _p = window.onLangChange;
  window.onLangChange = function (lg) {
    if (typeof _p === "function") _p(lg);
    renderArkieRoles();
    renderFlywheel();
  };
})();
