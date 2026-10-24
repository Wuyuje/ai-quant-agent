/* ARK Citizen Tools - WalletConnect v2（最佳體驗）
 * 用官方 EthereumProvider，支持手機錢包掃碼/跳轉
 */
(function () {
  "use strict";

  var PROJECT_ID = "e2f2b5c9c7d94b0f9a1e2d3c4b5a6978";  // 需替換為真實 ID
  var CHAIN_ID = 56;

  var wcProvider = null;
  var connecting = false;

  function hasWC() {
    return !!(window.WalletConnectEthereumProvider);
  }

  /* ── 用 WalletConnect 連接（彈出 QR / 錢包列表） ── */
  function connectWC() {
    if (!hasWC()) {
      alert("WalletConnect 未載入，請檢查網絡");
      return Promise.reject(new Error("WC_NOT_LOADED"));
    }
    if (connecting) return Promise.reject(new Error("CONNECTING"));
    connecting = true;

    return window.WalletConnectEthereumProvider.init({
      projectId: PROJECT_ID,
      chains: [CHAIN_ID],
      optionalChains: [56],
      showQrModal: true,
      metadata: {
        name: "ARK Citizen Tools",
        description: "ARK 質押收益追蹤與鏈上數據工具",
        url: location.origin,
        icons: [location.origin + "/images/mascot.png"]
      },
      qrModalOptions: {
        themeMode: "dark",
        themeVariables: {
          "--wcm-z-index": "3000"
        }
      }
    }).then(function (p) {
      wcProvider = p;
      window._wcProvider = p;
      return p.enable();     // 觸發連接
    }).then(function (accs) {
      connecting = false;
      if (!accs || !accs[0]) throw new Error("no account");
      window._arkAddr = accs[0];
      // 監聽事件
      if (wcProvider.on) {
        wcProvider.on("accountsChanged", function (a) {
          if (!a || !a.length) { if (window.logout) window.logout(); }
        });
        wcProvider.on("chainChanged", function () { if (window.refreshNet) window.refreshNet(); });
        wcProvider.on("disconnect", function () { if (window.logout) window.logout(); });
      }
      return connectAfterWC(accs[0]);
    }).catch(function (e) {
      connecting = false;
      throw e;
    });
  }
  window.arkConnectWC = connectWC;

  /* ── WC 連接後：切鏈 + 回傳地址 ── */
  function connectAfterWC(addr) {
    return wcProvider.request({ method: "eth_chainId" }).then(function (cid) {
      if (String(cid).toLowerCase() === "0x38") return addr;
      return wcProvider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x38" }]
      }).catch(function () { return addr; });
    });
  }

  /* ── 統一 provider（優先 WC，其次注入） ── */
  function activeProvider() {
    if (wcProvider) return wcProvider;
    return window.arkProvider ? window.arkProvider() : (window.ethereum || null);
  }
  window.arkActiveProvider = activeProvider;

  /* ── 更新全域錢包方法，優先走 WC ── */
  var _origSend = window.walletSendToken;
  window.walletSendToken = function (tokenAddr, toAddr, amountWei) {
    var p = activeProvider();
    // 有注入 provider 且不是 WC → 走原路徑
    if (!wcProvider && p && p === (window.ethereum || null)) {
      return _origSend ? _origSend(tokenAddr, toAddr, amountWei) : Promise.reject(new Error("NO_WALLET"));
    }
    if (!p) return Promise.reject(new Error("NO_WALLET"));

    var data = "0xa9059cbb" +
      toAddr.slice(2).toLowerCase().padStart(64, "0") +
      amountWei.toString(16).padStart(64, "0");

    return p.request({
      method: "eth_sendTransaction",
      params: [{
        from: window._arkAddr,
        to: tokenAddr,
        data: data,
        value: "0x0"
      }]
    });
  };

  var _origSign = window.walletSign;
  window.walletSign = function (message, addr) {
    var p = activeProvider();
    if (!wcProvider && p && p === (window.ethereum || null)) {
      return _origSign ? _origSign(message, addr) : Promise.reject(new Error("NO_WALLET"));
    }
    if (!p) return Promise.reject(new Error("NO_WALLET"));
    return p.request({ method: "personal_sign", params: [message, addr] });
  };

  /* ── 檢查是否已連接 WC ── */
  function wcConnected() {
    return !!(wcProvider && wcProvider.session);
  }
  window.arkWCConnected = wcConnected;
})();
