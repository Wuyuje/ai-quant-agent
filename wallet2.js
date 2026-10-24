/* ARK Citizen Tools - 錢包適配層 v3（多錢包衝突處理 + 手機 TP 優先） */
(function () {
  "use strict";

  var BSC = {
    chainId: "0x38",
    chainName: "BNB Smart Chain",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: ["https://bsc-dataseed.binance.org"],
    blockExplorerUrls: ["https://bscscan.com"]
  };

  var DAPP_URL = location.origin;

  /* ── provider 選擇（處理多錢包衝突） ── */
  var _chosen = null;

  function pickProvider() {
    if (_chosen) return _chosen;

    // ⭐ TP 官方推薦：優先用 window.ethereum（EIP-1193 標準）
    //    window.tokenpocket 只用於 Tron 等非 EVM 鏈，EVM 請用 ethereum
    // ① 手機錢包內建瀏覽器：用頂層 window.ethereum
    var ua = navigator.userAgent || "";
    var isTP = /TokenPocket|TPWallet/i.test(ua) || (window.ethereum && window.ethereum.isTokenPocket);
    var isMM = /MetaMask/i.test(ua) || (window.ethereum && window.ethereum.isMetaMask);
    var isOKX = /OKApp|OKX/i.test(ua) || (window.ethereum && window.ethereum.isOkxWallet);

    // ② 多錢包衝突：window.ethereum.providers 是陣列
    if (window.ethereum && window.ethereum.providers && window.ethereum.providers.length) {
      var list = window.ethereum.providers;
      // 優先 TP（如果 UA 是 TP）
      if (isTP) { _chosen = list.find(function (p) { return p.isTokenPocket; }); }
      if (!_chosen && isMM) { _chosen = list.find(function (p) { return p.isMetaMask; }); }
      if (!_chosen && isOKX) { _chosen = list.find(function (p) { return p.isOkxWallet; }); }
      if (!_chosen) _chosen = list[0];
      if (_chosen) { window.ethereum = _chosen; return _chosen; }
    }

    // ③ 專用命名空間（僅在無 window.ethereum 時）
    if (!window.ethereum) {
      if (isTP && window.tokenpocket) { _chosen = window.tokenpocket; return _chosen; }
      if (isOKX && window.okxwallet) { _chosen = window.okxwallet; return _chosen; }
    }

    // ④ 單一 provider（window.ethereum 優先）
    if (window.ethereum && typeof window.ethereum.request === "function") { _chosen = window.ethereum; return _chosen; }
    if (window.tokenpocket && typeof window.tokenpocket.request === "function") { _chosen = window.tokenpocket; return _chosen; }
    if (window.okxwallet && window.okxwallet.request) { _chosen = window.okxwallet; return _chosen; }
    if (window.web3 && window.web3.currentProvider) { _chosen = window.web3.currentProvider; return _chosen; }

    return null;
  }

  window.arkProvider = pickProvider;
  function hasWallet() { return !!pickProvider(); }
  window.hasWallet = hasWallet;

  function walletName() {
    var p = pickProvider();
    if (!p) return "None";
    if (p.isTokenPocket || window.tokenpocket) return "TP Wallet";
    if (p.isMetaMask) return "MetaMask";
    if (p.isOkxWallet || window.okxwallet) return "OKX Wallet";
    return "Injected";
  }
  window.walletName = walletName;

  function isMobile() { return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent || ""); }
  function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent || ""); }
  window.arkIsMobile = isMobile;

  function inWalletApp() {
    var p = pickProvider();
    return !!p;   // 有 provider 就是已在錢包內
  }
  window.arkIsInApp = inWalletApp;

  /* ── 切鏈 ── */
  /* ⭐ 帶超時的 Promise（防止錢包不響應導致卡死） */
  function withTimeout(promise, ms, fallback) {
    return Promise.race([
      promise,
      new Promise(function (resolve) {
        setTimeout(function () { resolve(fallback); }, ms);
      })
    ]).catch(function () { return fallback; });
  }

  function ensureBSC() {
    var p = pickProvider();
    if (!p) return Promise.resolve(false);   // ⭐ 不 reject，避免阻斷登入
    // ⭐ 3 秒超時：錢包不響應就跳過切鏈，讓登入繼續
    return withTimeout(
      p.request({ method: "eth_chainId" }),
      3000, null
    ).then(function (cid) {
      if (!cid) return true;                   // 拿不到 chainId → 跳過
      var c = String(cid).toLowerCase();
      if (c === "0x38" || c === "56") return true;
      // 需要切鏈：2 秒超時
      return withTimeout(
        p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x38" }] }),
        5000, true
      ).catch(function () { return true; });
    });
  }
  window.ensureBSC = ensureBSC;

  /* ── 連接 ── */
  function connect() {
    var p = pickProvider();
    if (!p) return Promise.reject(new Error("NO_WALLET"));
    console.log("[walletConnect] 請求帳號…");
    // ⭐ 30 秒超時（用戶需要在錢包確認）
    return withTimeout(
      p.request({ method: "eth_requestAccounts" }),
      30000, null
    ).then(function (accs) {
      if (!accs || !accs[0]) throw new Error("no account (超時或被拒絕)");
      console.log("[walletConnect] 拿到帳號:", accs[0]);
      window._arkAddr = accs[0];
      _chosen = p;
      // ⭐ 切鏈失敗不影響登入
      return ensureBSC().then(function () { return accs[0]; });
    });
  }
  window.walletConnect = connect;

  /* ── 簽名 ── */
  function sign(message, addr) {
    var p = pickProvider();
    if (!p) return Promise.reject(new Error("NO_WALLET"));
    console.log("[walletSign] 請求簽名…");
    // ⭐ 60 秒超時（用戶可能需要時間確認）
    return withTimeout(
      p.request({ method: "personal_sign", params: [message, addr] })
        .catch(function () { return p.request({ method: "personal_sign", params: [addr, message] }); })
        .catch(function () { return p.request({ method: "eth_sign", params: [addr, message] }); }),
      60000, null
    ).then(function (sig) {
      if (!sig) throw new Error("簽名超時或被拒絕");
      return sig;
    });
  }
  window.walletSign = sign;

  /* ── 發送 ERC20 ── */
  function sendToken(tokenAddr, toAddr, amountWei) {
    var p = pickProvider();
    if (!p) return Promise.reject(new Error("NO_WALLET"));
    var data = "0xa9059cbb" +
      toAddr.slice(2).toLowerCase().padStart(64, "0") +
      amountWei.toString(16).padStart(64, "0");
    var tx = { from: window._arkAddr || undefined, to: tokenAddr, data: data, value: "0x0" };
    return p.request({ method: "eth_sendTransaction", params: [tx] })
      .catch(function (e1) {
        // 回退：帶 gas
        return p.request({ method: "eth_estimateGas", params: [tx] })
          .then(function (gas) { tx.gas = gas; return p.request({ method: "eth_sendTransaction", params: [tx] }); })
          .catch(function () { throw e1; });
      });
  }
  window.walletSendToken = sendToken;

  /* ── 發送 ARK（封装：地址+数量） ── */
  var ARK_CONTRACT = "0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D";
  window.walletSendArk = function (toAddr, amountArk) {
    var amountWei = BigInt(Math.round(Number(amountArk) * 1e6)) * BigInt(1e12); // 1e18
    return sendToken(ARK_CONTRACT, toAddr, amountWei).then(function (resp) {
      // resp 可能是 txHash 字符串或对象
      var tx = (typeof resp === "string") ? resp : (resp && (resp.result || resp.hash || resp.transactionHash));
      if (!tx) throw new Error("无交易哈希返回");
      window._lastTx = tx;
      return tx;
    });
  };

  /* ── 事件 ── */
  document.addEventListener("DOMContentLoaded", function () {
    var p = pickProvider();
    if (p && typeof p.on === "function") {
      try {
        p.on("accountsChanged", function (accs) {
          if (!accs || !accs.length) { if (window.logout) window.logout(); return; }
          window._arkAddr = accs[0];
          if (window._onAccountChange) window._onAccountChange(accs[0]);
        });
        p.on("chainChanged", function () { if (window.refreshNet) window.refreshNet(); });
      } catch (e) {}
    }
  });
})();
