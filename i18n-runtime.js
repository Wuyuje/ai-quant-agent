/* ARK Citizen Tools - i18n runtime (language switch engine) */
(function () {
  var SUPPORTED = ["zh-TW", "zh-CN", "en", "ja", "ko", "es", "vi"];
  var STORE_KEY = "ark_lang";

  function detect() {
    try {
      var saved = localStorage.getItem(STORE_KEY);
      if (saved && SUPPORTED.indexOf(saved) >= 0) return saved;
    } catch (e) {}
    var list = (navigator.languages && navigator.languages.length)
      ? navigator.languages : [navigator.language || "zh-TW"];
    for (var i = 0; i < list.length; i++) {
      var lg = String(list[i] || "");
      var low = lg.toLowerCase();
      if (low.indexOf("zh") === 0) {
        // zh-CN / zh-SG / zh-MY / zh-Hans -> Simplified
        if (/cn|sg|my|hans/i.test(lg)) return "zh-CN";
        return "zh-TW";
      }
      if (low.indexOf("ja") === 0) return "ja";
      if (low.indexOf("ko") === 0) return "ko";
      if (low.indexOf("es") === 0) return "es";
      if (low.indexOf("vi") === 0) return "vi";
      if (low.indexOf("en") === 0) return "en";
    }
    return "zh-TW";
  }

  var current = detect();

  function t(key) {
    var d = (window.I18N && window.I18N[current]) || {};
    if (d[key] != null) return d[key];
    var fb = (window.I18N && window.I18N["zh-TW"]) || {};
    return fb[key] != null ? fb[key] : key;
  }

  function apply(root) {
    root = root || document;
    var els = root.querySelectorAll("[data-i18n]");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var key = el.getAttribute("data-i18n");
      var val = t(key);
      if (el.hasAttribute("data-i18n-attr")) {
        el.setAttribute(el.getAttribute("data-i18n-attr"), val);
      } else if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        el.setAttribute("placeholder", val);
      } else {
        el.textContent = val;
      }
    }
    document.documentElement.setAttribute("lang",
      current === "zh-TW" ? "zh-Hant" : current === "zh-CN" ? "zh-Hans" : current);
  }

  function set(lang) {
    if (SUPPORTED.indexOf(lang) < 0) return;
    current = lang;
    try { localStorage.setItem(STORE_KEY, lang); } catch (e) {}
    apply();
    if (typeof window.onLangChange === "function") window.onLangChange(lang);
    var sel = document.getElementById("langSel");
    if (sel) sel.value = lang;
  }

  function get() { return current; }

  window.I18NRT = { t: t, apply: apply, set: set, get: get, supported: SUPPORTED };
  window.t = t;

  document.addEventListener("DOMContentLoaded", function () {
    apply();
    var sel = document.getElementById("langSel");
    if (sel) {
      sel.value = current;
      sel.addEventListener("change", function () { set(this.value); });
    }
  });
})();
