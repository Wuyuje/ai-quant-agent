/* ARK Citizen Tools - engine: 底層邏輯與模組數據可視化 */
(function () {
  "use strict";

  function t(k) { return window.t ? window.t(k) : k; }
  function fmt(n, d) { return window.fmt ? window.fmt(n, d) : n; }
  function fmtCompact(n) { return window.fmtCompact ? window.fmtCompact(n) : n; }
  function compound(p, r, d) { return window.compound ? window.compound(p, r, d) : p; }

  /* ═══ ARK 六大模組（白皮書 v18） ═══ */
  var MODULES = [
    {
      id: "EM", icon: "⚙️", color: "#35e0f5",
      name: { "zh-TW": "EM 智能發幣模組", "zh-CN": "EM 智能发币模块", en: "EM Emission Manager", ja: "EM スマート発行", ko: "EM 스마트 발행", es: "EM Emisor", vi: "EM Phat hanh" },
      desc: {
        "zh-TW": "ARK 的「資源動力爐」。沒有中央銀行，所有代幣發行都由 EM 持續計算、判斷策略，以 ARK 債券形式增發。",
        "zh-CN": "ARK 的「资源动力炉」。没有中央银行，所有代币发行都由 EM 持续计算、判断策略，以 ARK 债券形式增发。",
        en: "ARK's emission engine. No central bank - EM continuously computes and issues ARK through bonds.",
        ja: "ARK の発行エンジン。中央銀行なしで EM が継続計算し、債券で発行。",
        ko: "ARK의 발행 엔진. 중앙은행 없이 EM이 계산하여 채권으로 발행.",
        es: "Motor de emision de ARK. Sin banco central, EM calcula y emite via bonos.",
        vi: "Dong co phat hanh ARK. Khong co ngan hang trung uong, EM tinh toan va phat hanh qua trai phieu."
      },
      io: ["Premium 溢價指數", "市場信心", "債券發行", "鑄幣合約"]
    },
    {
      id: "RBS", icon: "🛡️", color: "#7c9bff",
      name: { "zh-TW": "RBS 市值穩定模組", "zh-CN": "RBS 市值稳定模块", en: "RBS Stabilizer", ja: "RBS 安定化", ko: "RBS 안정화", es: "RBS Estabilizador", vi: "RBS On dinh" },
      desc: {
        "zh-TW": "ARK 的「價格監管機構」。設價格緩衝區 (Cushion) 與價格牆 (Wall)：偏低自動回購銷毀，過高拋售平抑，把斷崖暴跌變成平滑曲線。",
        "zh-CN": "ARK 的「价格监管机构」。设价格缓冲区 (Cushion) 与价格墙 (Wall)：偏低自动回购销毁，过高抛售平抑，把断崖暴跌变成平滑曲线。",
        en: "ARK's price regulator. Cushion + Wall zones: auto buyback & burn when low, sell when high - smoothing crashes.",
        ja: "ARK の価格規制機関。クッションとウォール：安値で買戻しバーン、高値で売却し急落を平滑化。",
        ko: "ARK의 가격 규제 기관. 쿠션과 월: 저가 매수·소각, 고가 매도로 급락 완화.",
        es: "Regulador de precio de ARK. Cushion + Wall: recompra y quema si baja, vende si sube.",
        vi: "Co quan dieu tiet gia ARK. Cushion + Wall: mua lai & dot khi thap, ban khi cao."
      },
      io: ["價格緩衝區", "價格牆", "國庫資金", "DAO 投票"]
    },
    {
      id: "YRF", icon: "🔥", color: "#f2c14e",
      name: { "zh-TW": "YRF 收益回購模組", "zh-CN": "YRF 收益回购模块", en: "YRF Buyback", ja: "YRF 買戻し", ko: "YRF 바이백", es: "YRF Recompra", vi: "YRF Mua lai" },
      desc: {
        "zh-TW": "收益回購與銷毀。透過回購銷毀 (Burn) 持續製造通縮，市場上的幣越來越少，你手裡的幣越來越多。",
        "zh-CN": "收益回购与销毁。通过回购销毁 (Burn) 持续制造通缩，市场上的币越来越少，你手里的币越来越多。",
        en: "Revenue buyback & burn. Continuous deflation - supply shrinks while your stack grows.",
        ja: "収益買戻しとバーン。継続的なデフレで供給が減り、保有量が増える。",
        ko: "수익 바이백 & 소각. 지속적 디플레이션으로 공급 감소, 보유량 증가.",
        es: "Recompra y quema. Deflacion continua: la oferta baja mientras tu posicion crece.",
        vi: "Mua lai & dot. Giam phat lien tuc: nguon cung giam, vi ban tang."
      },
      io: ["交易手續費", "回購", "銷毀 (Burn)", "通縮"]
    },
    {
      id: "RCM", icon: "📊", color: "#4ade80",
      name: { "zh-TW": "RCM 運行週期監控", "zh-CN": "RCM 运行周期监控", en: "RCM Cycle Monitor", ja: "RCM サイクル監視", ko: "RCM 사이클 모니터", es: "RCM Monitor", vi: "RCM Giam sat chu ky" },
      desc: {
        "zh-TW": "運行週期監控模組。測算長週期複利效應，長鎖倉跨越層級：540 天 vs 720 天不是差 0.1%，而是複利基數每天翻倍放大。",
        "zh-CN": "运行周期监控模块。测算长周期复利效应，长锁仓跨越层级：540 天 vs 720 天不是差 0.1%，而是复利基数每天翻倍放大。",
        en: "Cycle monitoring. Measures long-horizon compound effects - 540d vs 720d is not 0.1%, it is compounding on a bigger base daily.",
        ja: "サイクル監視。長期複利効果を測定。540日と720日の差は0.1%ではなく、複利基数の差。",
        ko: "사이클 모니터. 장기 복리 효과 측정. 540일과 720일의 차이는 0.1%가 아니라 복리 기반의 차이.",
        es: "Monitor de ciclos. Mide el efecto compuesto a largo plazo: 540d vs 720d no es 0.1%, es base compuesta.",
        vi: "Giam sat chu ky. Do hieu ung lai kep dai han: 540 ngay vs 720 ngay khong phai 0.1%."
      },
      io: ["週期測算", "複利軌跡", "回報預估"]
    },
    {
      id: "POL", icon: "💧", color: "#c084fc",
      name: { "zh-TW": "POL 協議自有流動性", "zh-CN": "POL 协议自有流动性", en: "POL Protocol Liquidity", ja: "POL プロトコル流動性", ko: "POL 프로토콜 유동성", es: "POL Liquidez", vi: "POL Thanh khoan" },
      desc: {
        "zh-TW": "Protocol Owned Liquidity。購買債券時：一半 USDT 買 ARK，與另一半 USDT 組成 LP 永久鎖倉，解鎖權限轉入黑洞。",
        "zh-CN": "Protocol Owned Liquidity。购买债券时：一半 USDT 买 ARK，与另一半 USDT 组成 LP 永久锁仓，解锁权限转入黑洞。",
        en: "Protocol Owned Liquidity. On bond purchase: half the USDT buys ARK, paired with the rest as permanently locked LP; unlock rights sent to black hole.",
        ja: "プロトコル自有流動性。債券購入時：半額USDTでARK購入、残りとLPを永久ロック、解除権限はブラックホールへ。",
        ko: "프로토콜 자체 유동성. 채권 구매 시 절반 USDT로 ARK 매수, 나머지와 LP 영구 잠금, 해제 권한은 블랙홀.",
        es: "Liquidez propia del protocolo. Al comprar bonos: mitad en ARK, resto forma LP bloqueada permanentemente.",
        vi: "Thanh khoan tu co. Khi mua trai phieu: nua USDT mua ARK, con lai tao LP khoa vinh vien."
      },
      io: ["債券購買", "50% 買 ARK", "LP 永久鎖倉", "黑洞地址"]
    },
    {
      id: "DAO", icon: "🏛️", color: "#ff6b81",
      name: { "zh-TW": "DAO 治理與多簽", "zh-CN": "DAO 治理与多签", en: "DAO Governance", ja: "DAO ガバナンス", ko: "DAO 거버넌스", es: "DAO Gobernanza", vi: "DAO Quan tri" },
      desc: {
        "zh-TW": "社區治理。RBS 資金耗盡時由 ARK DAO 投票決定是否從國庫回流。所有交易經過 DAO 多簽錢包，合約權限已拋棄。",
        "zh-CN": "社区治理。RBS 资金耗尽时由 ARK DAO 投票决定是否从国库回流。所有交易经过 DAO 多签钱包，合约权限已抛弃。",
        en: "Community governance. When RBS funds deplete, ARK DAO votes on treasury回流. All trades via DAO multisig; contract permissions renounced.",
        ja: "コミュニティガバナンス。RBS資金枯渇時は DAO 投票で国庫からの補充を決定。全取引はマルチシグ経由、権限は放棄済み。",
        ko: "커뮤니티 거버넌스. RBS 자금 소진 시 DAO 투표로 국고 환류 결정. 모든 거래는 멀티시그, 권한 포기.",
        es: "Gobernanza comunitaria. Si el fondo RBS se agota, el DAO vota el retorno del tesoro. Todo via multisig; permisos renunciados.",
        vi: "Quan tri cong dong. Khi quy RBS can, DAO bo phieu. Moi giao dich qua multisig; da tu bo quyen."
      },
      io: ["DAO 投票", "國庫", "多簽錢包", "權限拋棄"]
    }
  ];
  window.ARK_MODULES = MODULES;

  function renderModules() {
    var box = document.getElementById("engineModules");
    if (!box) return;
    var lg = window.I18NRT ? window.I18NRT.get() : "zh-TW";
    box.innerHTML = MODULES.map(function (m) {
      var nm = m.name[lg] || m.name["zh-TW"];
      var ds = m.desc[lg] || m.desc["zh-TW"];
      return '<div class="mod-card" style="border-left-color:' + m.color + '">' +
        '<div class="mod-head"><span class="mod-ico">' + m.icon + '</span>' +
        '<span class="mod-id" style="color:' + m.color + '">' + m.id + '</span></div>' +
        '<div class="mod-name">' + nm + '</div>' +
        '<p class="mod-desc">' + ds + '</p>' +
        '<div class="mod-io">' + m.io.map(function (x) { return '<span class="chip">' + x + '</span>'; }).join("") + '</div>' +
        '</div>';
    }).join("");
  }
  window.renderModules = renderModules;

  /* ═══ 恆定乘積做市曲線 (x·y=k) ═══ */
  function renderAmmCurve() {
    var el = document.getElementById("ammChart");
    if (!el || !window.makeChart) return;
    var k = 1;
    var xs = [], ys = [];
    for (var i = 1; i <= 100; i++) {
      var x = i / 10;          // ARK in pool (relative)
      xs.push(x.toFixed(1));
      ys.push(k / x);          // USDT in pool
    }
    window.makeChart("ammChart", {
      type: "line",
      data: {
        labels: xs,
        datasets: [{
          label: "USDT (y) = k / ARK (x)",
          data: ys, borderColor: "#35e0f5",
          backgroundColor: "rgba(53,224,245,.08)",
          fill: true, tension: .25, pointRadius: 0, borderWidth: 2
        }]
      },
      options: window.baseOpts("x · y = k  (恆定乘積)")
    });
  }
  window.renderAmmCurve = renderAmmCurve;

  /* ═══ 雙池結構（國庫 + 流動性池） ═══ */
  function renderPools(d) {
    var box = document.getElementById("poolBars");
    if (!box) return;
    var usdt = (d && d.poolUsdt) || 0;
    var ark = (d && d.poolArk) || 0;
    var tvl = (d && d.liquidityUsd) || usdt * 2;
    var maxV = Math.max(usdt, tvl - usdt > 0 ? tvl - usdt : usdt);

    function bar(label, val, max, cls) {
      var p = max > 0 ? (val / max * 100) : 0;
      return '<div class="pool-row"><span class="pool-lab">' + label + '</span>' +
        '<div class="pool-track"><div class="pool-fill ' + cls + '" style="width:' + p.toFixed(1) + '%"></div></div>' +
        '<span class="pool-val">$' + fmtCompact(val) + '</span></div>';
    }
    box.innerHTML =
      bar("USDT 側", usdt, maxV, "cyan") +
      bar("ARK 側 (估值)", tvl - usdt > 0 ? tvl - usdt : usdt, maxV, "gold");
  }
  window.renderPools = renderPools;

  /* ═══ 價格區間儀表（RBS 緩衝區 / 價格牆） ═══ */
  function renderRbsGauge(price) {
    var el = document.getElementById("rbsGauge");
    if (!el) return;
    el.innerHTML =
      '<div class="gauge-wrap">' +
      '<div class="gauge-label top">價格牆 (Wall) — 過高拋售平抑</div>' +
      '<div class="gauge-track">' +
      '<div class="gauge-zone over"></div>' +
      '<div class="gauge-zone cushion"></div>' +
      '<div class="gauge-zone under"></div>' +
      '<div class="gauge-marker" id="rbsMarker"></div>' +
      '</div>' +
      '<div class="gauge-label bottom">價格緩衝區 (Cushion) — 偏低回購銷毀</div>' +
      '</div>';
    var marker = document.getElementById("rbsMarker");
    if (marker) {
      // 簡易位置：以當前價相對 24h 高低推斷（無高低資料時置中）
      var pos = 50;
      if (window._arkStats && window._arkStats.pc24 != null) {
        pos = 50 + Math.max(-40, Math.min(40, window._arkStats.pc24 * 8));
      }
      marker.style.left = pos + "%";
      marker.title = "$" + Number(price || 0).toFixed(4);
    }
  }
  window.renderRbsGauge = renderRbsGauge;

  /* ═══ 複利效應放大（540 vs 720） ═══ */
  function renderCompoundGap() {
    var el = document.getElementById("gapChart");
    if (!el || !window.makeChart) return;
    var amt = 1000;
    var r540 = 0.8, r720 = 0.9;      // 白皮書示例日收益率
    var labels = [];
    for (var d = 0; d <= 540; d += 15) labels.push(d);
    function series(r, cap) {
      return labels.map(function (d) { return d <= cap ? compound(amt, r, d) : null; });
    }
    window.makeChart("gapChart", {
      type: "line",
      data: {
        labels: labels.map(function (d) { return d + t("common.day"); }),
        datasets: [
          { label: "540d @0.8%" + t("common.day"), data: series(r540, 540), borderColor: "#7c9bff", backgroundColor: "transparent", tension: .3, pointRadius: 0, borderWidth: 2 },
          { label: "720d @0.9%" + t("common.day"), data: series(r720, 720), borderColor: "#f2c14e", backgroundColor: "transparent", tension: .3, pointRadius: 0, borderWidth: 2 }
        ]
      },
      options: window.baseOpts("540d vs 720d 複利差距")
    });
    // 18 個月對照
    var m540 = compound(amt, r540, 540);
    var m720 = compound(amt, r720, 540);
    var e1 = document.getElementById("gap540");
    var e2 = document.getElementById("gap720");
    if (e1) e1.textContent = fmtCompact(m540) + " ARK";
    if (e2) e2.textContent = fmtCompact(m720) + " ARK";
  }
  window.renderCompoundGap = renderCompoundGap;

  /* ═══ 初始化 ═══ */
  document.addEventListener("DOMContentLoaded", function () {
    if (document.getElementById("engineModules")) renderModules();
    if (document.getElementById("ammChart")) renderAmmCurve();
    if (document.getElementById("gapChart")) renderCompoundGap();
    if (document.getElementById("rbsGauge")) renderRbsGauge(0);
  });

  // 收到鏈上數據時同步
  var _prevOnChain = window.onChainData;
  window.onChainData = function (d) {
    if (typeof _prevOnChain === "function") _prevOnChain(d);
    renderPools({ poolUsdt: d.usdt, poolArk: d.ark });
    if (d.price) renderRbsGauge(d.price);
  };

  var _prevLang = window.onLangChange;
  window.onLangChange = function (lg) {
    if (typeof _prevLang === "function") _prevLang(lg);
    renderModules();
  };
})();
