/* ARK Citizen Tools - 一鍵跳轉錢包支付
 * 點「用錢包支付」→ 自動喚起當前登入的錢包 App 並彈出授權
 */
(function () {
  "use strict";
  console.log("[paylink] loaded v1.9.0");

  var ARK_TOKEN = "0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D";

  function isInWallet() {
    return !!(window.ethereum || window.tokenpocket || window.okxwallet);
  }
  function isMobile() { return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent || ""); }
  function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent || ""); }

  /* 偵測當前錢包類型（從 UA 或已連接的 provider） */
  function detectWallet() {
    var ua = navigator.userAgent || "";
    var p = window.ethereum || window.tokenpocket || window.okxwallet || null;
    if (p) {
      if (p.isTokenPocket || window.tokenpocket) return "tp";
      if (p.isMetaMask) return "metamask";
      if (p.isOkxWallet || window.okxwallet) return "okx";
    }
    if (/TokenPocket|TPWallet/i.test(ua)) return "tp";
    if (/MetaMask/i.test(ua)) return "metamask";
    if (/OKApp|OKX/i.test(ua)) return "okx";
    // 從 localStorage 上次用的錢包
    try { return localStorage.getItem("ark_wallet_type") || "tp"; } catch (e) { return "tp"; }
  }
  window.arkDetectWallet = detectWallet;

  function saveWalletType(w) {
    try { localStorage.setItem("ark_wallet_type", w); } catch (e) {}
  }
  window.arkSaveWalletType = saveWalletType;

  /* ── 產生「錢包 App 喚起連結」 ── */
  function buildWalletLink(wallet, dappUrl) {
    var host = dappUrl.replace(/^https?:\/\//, "");
    var full = encodeURIComponent(dappUrl);
    switch (wallet) {
      case "tp":
        // TokenPocket: 打開 DApp
        return "tpoutside://pull.activity?param=" + encodeURIComponent(JSON.stringify({ url: dappUrl }));
      case "metamask":
        return "https://metamask.app.link/dapp/" + host;
      case "okx":
        return "okx://wallet/dapp/url?dappUrl=" + full;
      case "bitget":
        return "bitkeep://bkconnect?action=dapp&url=" + full;
      case "imtoken":
        return "imtokenv2://navigate/DappView?url=" + full;
      default:
        return null;
    }
  }
  window.arkBuildWalletLink = buildWalletLink;

  /* ── 喚起錢包 App ── */
  function openWalletApp(cb) {
    var w = detectWallet();
    var url = location.origin + location.pathname + location.search + location.hash;
    var link = buildWalletLink(w, url);
    if (!link) { if (cb) cb(false); return; }

    var left = false;
    var onHide = function () { if (document.hidden) left = true; };
    document.addEventListener("visibilitychange", onHide, { once: true });

    try { location.href = link; } catch (e) {}

    setTimeout(function () {
      document.removeEventListener("visibilitychange", onHide);
      if (cb) cb(left || document.hidden);
    }, 1200);
  }
  window.arkOpenWalletApp = openWalletApp;

  /* ── 統一付款入口（核心） ── */
  function pay(toAddr, amountArk, opts) {
    opts = opts || {};
    var statusFn = opts.onStatus || function () {};
    var doneFn = opts.onSent || function () {};
    var errFn = opts.onError || function () {};

    console.log("[arkPay] to=", toAddr, "ark=", amountArk, "inWallet=", isInWallet(), "mobile=", isMobile());

    var addr = (window.arkState && window.arkState.addr) ||
               (function () { try { return localStorage.getItem("ark_auth_addr"); } catch (e) { return ""; } })();
    if (!addr) { console.warn("[arkPay] NO_LOGIN"); errFn("NO_LOGIN"); return; }
    if (!toAddr) { console.warn("[arkPay] NO_PAYTO"); errFn("NO_PAYTO"); return; }

    var amt;
    try { amt = BigInt(Math.round(Number(amountArk) * 1e18)); }
    catch (e) { errFn("BAD_AMOUNT"); return; }

    // ⭐ 已在錢包 App 內（有 provider）→ 直接調用，絕不彈選擇器
    var prov = window.arkProvider ? window.arkProvider() : (window.ethereum || window.tokenpocket || null);
    if (prov && typeof prov.request === "function") {
      console.log("[arkPay] in-wallet mode, provider=", prov.isTokenPocket ? "TP" : prov.isMetaMask ? "MM" : "other");
      statusFn("請在錢包確認轉帳…");
      var data = "0xa9059cbb" +
        toAddr.slice(2).toLowerCase().padStart(64, "0") +
        amt.toString(16).padStart(64, "0");
      var tx = { from: addr, to: ARK_TOKEN, data: data, value: "0x0" };

      prov.request({ method: "eth_sendTransaction", params: [tx] })
        .then(function (h) { doneFn(h); })
        .catch(function (e1) {
          console.warn("[arkPay] first attempt failed:", e1 && e1.message);
          // 回退：帶 gas 估算重試
          return prov.request({ method: "eth_estimateGas", params: [tx] })
            .then(function (gas) {
              tx.gas = gas;
              return prov.request({ method: "eth_sendTransaction", params: [tx] });
            })
            .then(function (h) { doneFn(h); })
            .catch(function (e2) {
              var msg = String((e2 && e2.message) || e2 || e1 || "");
              console.error("[arkPay] both attempts failed:", msg);
              // ⭐ 明確報錯，不彈錢包選擇器
              if (msg.indexOf("4001") >= 0 || msg.indexOf("reject") >= 0 || msg.indexOf("cancel") >= 0) {
                errFn("USER_REJECTED");
              } else if (msg.indexOf("insufficient") >= 0 || msg.indexOf("balance") >= 0) {
                errFn("INSUFFICIENT");
              } else {
                errFn(msg || "UNKNOWN");
              }
            });
        });
      return;
    }

    // ② 無 provider（純手機瀏覽器）→ 引導跳轉錢包
    if (isMobile()) {
      console.log("[arkPay] no provider, mobile browser → deep link");
      statusFn("正在喚起錢包 App…");
      try {
        localStorage.setItem("ark_pay_pending", JSON.stringify({
          to: toAddr, ark: Number(amountArk), ts: Date.now(), label: opts.label || ""
        }));
      } catch (e) {}

      openWalletApp(function (left) {
        if (!left) {
          statusFn("未偵測到錢包 App");
          if (window.arkShowWalletPicker) window.arkShowWalletPicker();
        } else {
          statusFn("已跳轉到錢包，請在錢包中確認轉帳");
        }
      });
      return;
    }

    // ③ 桌面無 provider → 彈錢包選擇（WalletConnect）
    statusFn("請選擇錢包");
    if (window.arkShowWalletPicker) window.arkShowWalletPicker();
    else errFn("NO_WALLET");
  }

  window.arkPay = pay;

  /* ── 跳轉回來後自動續接付款 ── */
  function resumePendingPay() {
    var raw = null;
    try { raw = localStorage.getItem("ark_pay_pending"); } catch (e) {}
    if (!raw) return;
    var p = null;
    try { p = JSON.parse(raw); } catch (e) { return; }
    if (!p || Date.now() - p.ts > 30 * 60 * 1000) { try { localStorage.removeItem("ark_pay_pending"); } catch (e) {} return; }
    // 只有在錢包 App 內才續接
    if (!isInWallet()) return;

    var addr = "";
    try { addr = localStorage.getItem("ark_auth_addr") || ""; } catch (e) {}
    if (!addr) return;

    setTimeout(function () {
      try { localStorage.removeItem("ark_pay_pending"); } catch (e) {}
      // 自動觸發付款
      pay(p.to, p.ark, {
        label: p.label,
        onStatus: function (m) { var e = document.getElementById("adPayStatus"); if (e) e.textContent = m; },
        onSent: function (h) {
          var e = document.getElementById("adPayStatus");
          if (e) e.textContent = "交易已送出：" + String(h).slice(0, 20) + "...";
        },
        onError: function (m) { var e = document.getElementById("adPayStatus"); if (e) e.textContent = "失敗：" + m.slice(0, 60); }
      });
    }, 800);
  }

  document.addEventListener("DOMContentLoaded", function () {
    setTimeout(resumePendingPay, 1500);
  });
})();

/* ══════════ 钱包选择器（手机跳转 App / 电脑装插件） ══════════ */
(function(){
  "use strict";
  function isMobile(){ return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent||""); }

  window.arkShowWalletPicker = function(){
    // 已在内置浏览器 → 直接连
    if (window.ethereum) { if (window.connectWallet) window.connectWallet(); return; }

    // ⭐ 带上升级意图（跳转回来可自动续接）
    var _intent = '';
    try {
      var it = JSON.parse(localStorage.getItem('ark_upgrade_intent') || 'null');
      if (it && it.plan) _intent = '#upgrade=' + encodeURIComponent(it.plan);
    } catch(e){}
    var dapp = location.href.split('#')[0] + _intent;
    var host = location.host;
    var isMob = isMobile();

    // 构建选择弹窗
    var old = document.getElementById('arkWalletPicker');
    if (old) old.remove();
    var div = document.createElement('div');
    div.id = 'arkWalletPicker';
    div.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(6,11,24,.9);display:flex;align-items:center;justify-content:center;padding:20px';
    // 各钱包官方 logo（本地图片，已下载）
    function wlogo(name){ return '<img src="images/wallet-'+name+'.png" style="width:24px;height:24px;border-radius:5px;object-fit:contain" alt="">'; }
    var wallets = isMob ? [
      { n:'TokenPocket', icon:wlogo('tp'), tpTransfer:true, url:'#' },
      { n:'MetaMask', icon:wlogo('metamask'), url:'https://metamask.app.link/dapp/'+host },
      { n:'OKX Wallet', icon:wlogo('okx'), url:'okx://wallet/dapp/url?dappUrl='+encodeURIComponent(dapp) },
      { n:'Bitget', icon:wlogo('bitget'), url:'https://bkcode.vip?action=dapp&url='+encodeURIComponent(dapp) }
    ] : [
      { n:'MetaMask', icon:wlogo('metamask'), url:'https://metamask.io/download/', tip:'安装插件' },
      { n:'OKX Web3', icon:wlogo('okx'), url:'https://www.okx.com/web3', tip:'安装插件' },
      { n:'Binance Web3', icon:wlogo('binance'), url:'https://www.binance.com/zh-CN/web3wallet', tip:'安装插件' }
    ];
    div.innerHTML =
      '<div style="background:#0f1420;border:1px solid #232c3d;border-radius:16px;max-width:360px;width:100%;padding:20px">'+
      '<div style="font-size:16px;font-weight:800;color:#35e0f5;margin-bottom:4px">选择钱包登录</div>'+
      '<div style="font-size:12px;color:#8b95a8;margin-bottom:16px">'+(isMob?'点击后跳转到钱包 App（其中打开本站）':'安装插件后刷新页面再登录')+'</div>'+
      wallets.map(function(w){
        var _click = w.tpTransfer ? ' onclick="arkOpenTpWallet();return false"' : '';
        return '<a href="'+w.url+'"' + _click + ' ' + (isMob?'':'target="_blank" rel="noopener"')+' style="display:flex;align-items:center;gap:12px;padding:12px 14px;margin-bottom:8px;background:#161d2b;border:1px solid #232c3d;border-radius:10px;text-decoration:none;color:#e6edf3;font-size:14px;font-weight:600">'+
          '<span style="width:26px;height:26px;display:flex;align-items:center">'+w.icon+'</span>'+w.n+
          '<span style="margin-left:auto;color:#5a6779;font-size:11px">'+(w.tip||(isMob?'打开 App':'下载'))+'</span></a>';
      }).join('')+
      '<button onclick="document.getElementById(\'arkWalletPicker\').remove()" style="width:100%;margin-top:8px;padding:10px;background:none;border:1px solid #232c3d;border-radius:10px;color:#8b95a8;font-size:13px;cursor:pointer">取消</button>'+
      '</div>';
    document.body.appendChild(div);
  };
})();

/* ══════════ TP 直接调起转账授权 ══════════ */
window.arkTpTransfer = function (plan) {
  plan = plan || (function(){ try { var it=JSON.parse(localStorage.getItem('ark_upgrade_intent')||'null'); return it&&it.plan||'pro'; }catch(e){ return 'pro'; } })();
  var ARK = '0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D';
  var PAYTO = '0xfA3b90c574469909D20848273C06752a22fdE74a';
  var AMOUNTS = { pro: '1', vip: '10' };
  var amount = AMOUNTS[plan] || AMOUNTS.test;
  // TP 官方转账协议
  // 发送方地址（若已知）
  var fromAddr = '';
  try { fromAddr = localStorage.getItem('ark_addr') || (window._arkAddr || ''); } catch(e){}
  var param = {
    Protocol: 'ScanProtocol',
    version: 'v1.0',
    blockchain: 'bsc',
    action: 'transfer',
    from: fromAddr,                    // ⭐ 官方要求 from
    to: PAYTO,
    amount: amount,
    contract: ARK,
    symbol: 'ARK',
    precision: '18',
    memo: 'ARK' + plan.toUpperCase()
  };
  var link = 'tpoutside://pull.activity?param=' + encodeURIComponent(JSON.stringify(param));
  // 记录升级意图（回来后识别）
  try { localStorage.setItem('ark_upgrade_intent', JSON.stringify({ plan: plan, ts: Date.now(), amount: amount, payTo: PAYTO })); } catch(e){}
  try { localStorage.setItem('ark_tp_pending', JSON.stringify({ plan: plan, ts: Date.now() })); } catch(e){}
  location.href = link;
};

/* ══════════ TP 可靠唤起（多方案降级） ══════════ */
window.arkOpenTpWallet = function (plan) {
  plan = plan || 'pro';
  var dapp = location.href.split('#')[0];
  // 记录升级意图
  try { localStorage.setItem('ark_upgrade_intent', JSON.stringify({ plan: plan, ts: Date.now() })); } catch(e){}
  var ua = navigator.userAgent || '';
  var inTp = /TokenPocket|TPWallet/i.test(ua) || (window.ethereum && window.ethereum.isTokenPocket);

  // 已在 TP 浏览器内 → 直接连接钱包
  if (inTp || window.ethereum) {
    if (window.connectWallet) { window.arkWalletPickerRemove && window.arkWalletPickerRemove(); window.connectWallet(); }
    return;
  }

  // 不在钱包内 → 提示用 TP 浏览器打开
  var el = document.getElementById('arkWalletPicker');
  if (el) el.remove();
  var tip = document.createElement('div');
  tip.id = 'arkTpTip';
  tip.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(6,11,24,.94);display:flex;align-items:center;justify-content:center;padding:24px';
  tip.innerHTML =
    '<div style="background:#0f1420;border:1px solid #232c3d;border-radius:16px;max-width:340px;width:100%;padding:22px;text-align:center">' +
    '<img src="images/wallet-tp.png" style="width:56px;height:56px;border-radius:12px;margin-bottom:12px">' +
    '<div style="font-size:16px;font-weight:800;color:#35e0f5;margin-bottom:8px">请用 TokenPocket 浏览器打开</div>' +
    '<div style="font-size:13px;color:#8b95a8;line-height:1.7;margin-bottom:16px">' +
      '① 打开 <b style="color:#e6edf3">TokenPocket</b> App<br>' +
      '② 点底部 <b style="color:#e6edf3">「发现」/「浏览器」</b><br>' +
      '③ 地址栏输入本站网址<br>' +
      '④ 打开后点"钱包登录"即可授权充值' +
    '</div>' +
    '<div style="background:#0a101c;border:1px solid #232c3d;border-radius:8px;padding:10px;margin-bottom:14px;font-family:ui-monospace,monospace;font-size:12px;color:#35e0f5;word-break:break-all">' + dapp + '</div>' +
    '<button onclick="navigator.clipboard&&navigator.clipboard.writeText(\'' + dapp + '\');this.textContent=\'✅ 已复制网址\'" style="width:100%;padding:11px;background:#1b2436;border:1px solid #232c3d;border-radius:10px;color:#e6edf3;font-size:13px;cursor:pointer;margin-bottom:8px">复制网址</button>' +
    '<button onclick="document.getElementById(\'arkTpTip\').remove()" style="width:100%;padding:10px;background:none;border:1px solid #232c3d;border-radius:10px;color:#8b95a8;font-size:13px;cursor:pointer">关闭</button>' +
    '</div>';
  document.body.appendChild(tip);
};
window.arkWalletPickerRemove = function(){ var e=document.getElementById('arkWalletPicker'); if(e) e.remove(); };

/* ══════════ 通过分配合约付费（推广自动分润） ══════════ */
(function () {
  "use strict";
  var ARK_TOKEN = "0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D";
  var REFERRAL = "0x5e715816cc6d726b47f7bf3f4ee5ed34fb2615b4";   // BSC 主网分配合约

  // 函数选择器
  var SEL_APPROVE = "0x095ea7b3";     // approve(address,uint256) ✅
  var SEL_PAY = "0xc290d691";        // pay(uint256) ✅已验证
  var SEL_ALLOWANCE = "0xdd62ed3e";  // allowance(address,address) ✅
  var SEL_REFERRER = "0x2cf003c2";   // referrer(address) ✅已验证

  function pad(hex) { return hex.replace(/^0x/, "").padStart(64, "0"); }
  function addrArg(a) { return pad(a.toLowerCase()); }
  function uintArg(n) { return pad(n.toString(16)); }

  /** 通过合约付费（含自动分润） */
  window.arkPayViaContract = function (amountArk, opts) {
    opts = opts || {};
    var statusFn = opts.onStatus || function(){}, doneFn = opts.onSent || function(){}, errFn = opts.onError || function(){};
    var addr = (window.ARK_ADDR) || (function(){ try { return localStorage.getItem("ark_auth_addr"); } catch(e){ return ""; } })();
    if (!addr) { errFn("NO_LOGIN"); return; }
    var prov = window.arkProvider ? window.arkProvider() : (window.ethereum || null);
    if (!prov) { errFn("NO_WALLET"); return; }

    var amt;
    try { amt = BigInt(Math.round(Number(amountArk) * 1e18)); } catch(e){ errFn("BAD_AMOUNT"); return; }

    // ① 检查 allowance
    statusFn("检查授权…");
    var dataAllow = SEL_ALLOWANCE + addrArg(addr) + addrArg(REFERRAL);
    prov.request({ method: "eth_call", params: [{ to: ARK_TOKEN, data: dataAllow }, "latest"] })
      .then(function (res) {
        var allowed = BigInt(res || "0x0");
        if (allowed < amt) {
          // ② 需要 approve
          statusFn("请在钱包确认授权 ARK…");
          var dataApprove = SEL_APPROVE + addrArg(REFERRAL) + uintArg(amt);
          return prov.request({ method: "eth_sendTransaction", params: [{ from: addr, to: ARK_TOKEN, data: dataApprove, value: "0x0" }] });
        }
        return null;
      })
      .then(function () {
        // ③ 调用合约 pay()
        statusFn("请在钱包确认付款…");
        var dataPay = SEL_PAY + uintArg(amt);
        return prov.request({ method: "eth_sendTransaction", params: [{ from: addr, to: REFERRAL, data: dataPay, value: "0x0" }] });
      })
      .then(function (h) { doneFn(h); })
      .catch(function (e) { errFn((e && (e.message || e.code)) || "FAIL"); });
  };
})();
