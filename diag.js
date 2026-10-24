/* ARK Citizen Tools - 環境診斷工具 */
(function () {
  "use strict";

  function diag() {
    var out = [];
    var ua = navigator.userAgent || "";
    out.push("UA: " + ua.slice(0, 100));
    out.push("协议: " + location.protocol);
    out.push("window.ethereum: " + (window.ethereum ? "有" : "无"));
    out.push("window.tokenpocket: " + (window.tokenpocket ? "有" : "无"));
    out.push("window.okxwallet: " + (window.okxwallet ? "有" : "无"));
    out.push("window.web3: " + (window.web3 ? "有" : "无"));
    out.push("window.WalletConnectEthereumProvider: " + (window.WalletConnectEthereumProvider ? "有" : "无"));

    if (window.ethereum) {
      out.push("--- window.ethereum ---");
      out.push("isMetaMask: " + window.ethereum.isMetaMask);
      out.push("isTokenPocket: " + window.ethereum.isTokenPocket);
      out.push("isOKXWallet: " + window.ethereum.isOkxWallet);
      out.push("chainId: " + window.ethereum.chainId);
      out.push("selectedAddress: " + window.ethereum.selectedAddress);
      out.push("providers数组: " + (window.ethereum.providers ? window.ethereum.providers.length : "无"));
      // 探测支持的方法
      out.push("有request: " + (typeof window.ethereum.request === "function"));
      out.push("有send: " + (typeof window.ethereum.send === "function"));
    }
    // 已登录状态
    try { out.push("localStorage.ark_auth_addr: " + (localStorage.getItem("ark_auth_addr") || "(空)")); } catch (e) {}

    return out.join("\n");
  }
  window.arkDiag = function () {
    var s = diag();
    console.log(s);
    alert(s);
    return s;
  };

  // 自動檢測多錢包衝突
  function checkMultiWallet() {
    if (window.ethereum && window.ethereum.providers && window.ethereum.providers.length > 1) {
      console.warn("[diag] 檢測到多個錢包注入:", window.ethereum.providers.map(function (p) {
        return p.isMetaMask ? "MetaMask" : p.isTokenPocket ? "TP" : p.isOkxWallet ? "OKX" : "Other";
      }));
      // 讓用戶選擇
      var pick = window.ethereum.providers.find(function (p) { return p.isTokenPocket; })
        || window.ethereum.providers.find(function (p) { return p.isMetaMask; })
        || window.ethereum.providers[0];
      if (pick) {
        window.ethereum = pick;   // 覆蓋為首選
        console.log("[diag] 已選擇 provider:", pick.isTokenPocket ? "TP" : pick.isMetaMask ? "MetaMask" : "Other");
      }
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    checkMultiWallet();
    // 5秒後若還沒登入，提示可查看診斷
    setTimeout(function () {
      if (!localStorage.getItem("ark_auth_addr") && window.ethereum) {
        console.log("[diag] 尚未登入。執行 arkDiag() 查看環境");
      }
    }, 3000);
  });
})();
