/* 電報號加速器 · ARK 生態工具
   前端邏輯：節點列表、延遲探測、目標跳轉、MTProto 資訊
   ⚠️ 節點配置由 /api/tg-accel/nodes 提供；若不可用則用內建預設 */
(function () {
  'use strict';

  var NODES = [];
  var MT = { server: '', port: '', secret: '' };
  var selected = null;

  /* ---------- 內建預設節點（後端不可用時的 fallback） ---------- */
  var FALLBACK = {
    nodes: [
      { id: 'auto', name: '智能加速（自動選線）', host: 'auto', port: 443, tag: '推薦', region: 'Auto' },
      { id: 'sg', name: '新加坡 · 直連', host: 'sg.ark-gate.io', port: 443, tag: '低延遲', region: 'SG' },
      { id: 'jp', name: '日本 · 直連', host: 'jp.ark-gate.io', port: 443, tag: '穩定', region: 'JP' },
      { id: 'hk', name: '香港 · 直連', host: 'hk.ark-gate.io', port: 443, tag: '高速', region: 'HK' }
    ],
    mtproto: { server: '', port: '', secret: '' }
  };

  /* ---------- 工具 ---------- */
  function $(id) { return document.getElementById(id); }

  function toast(msg, isErr) {
    var box = $('mtMsg');
    if (!box) return;
    box.textContent = msg;
    box.style.display = 'block';
    box.style.background = isErr ? 'rgba(242,85,95,.09)' : 'rgba(76,222,128,.08)';
    box.style.borderColor = isErr ? 'rgba(242,85,95,.28)' : 'rgba(76,222,128,.25)';
    box.style.color = isErr ? '#f8a0a5' : '#8fe6ab';
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { box.style.display = 'none'; }, 4000);
  }

  /* ---------- 打開電報號 ---------- */
  window.openTarget = function () {
    var raw = ($('tgTarget').value || '').trim();
    var msg = $('tgTargetMsg');
    if (!raw) {
      msg.textContent = '請先輸入電報號或頻道連結';
      msg.style.color = '#f5c46b';
      return;
    }
    var target = raw;
    // 純數字手機號 → tg://resolve 不適用，走網頁登錄
    if (/^\+?[0-9\s\-]{6,20}$/.test(raw)) {
      window.open('https://web.telegram.org/a/', '_blank', 'noopener');
      msg.textContent = '已打開 Telegram 網頁版，請用 ' + raw + ' 登錄';
      msg.style.color = '#8fe6ab';
      return;
    }
    // @username / t.me/xxx / 完整連結
    var uname = raw;
    var m = raw.match(/(?:t\.me\/|@)([A-Za-z0-9_]{4,})/);
    if (m) uname = m[1];
    else uname = raw.replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{4,}$/.test(uname)) {
      msg.textContent = '格式無法識別，請輸入 @用戶名 或 t.me 連結';
      msg.style.color = '#f5c46b';
      return;
    }
    var url = 'https://t.me/' + uname;
    window.open(url, '_blank', 'noopener');
    msg.textContent = '正在打開 t.me/' + uname;
    msg.style.color = '#8fe6ab';
  };

  /* ---------- 延遲探測 ---------- */
  function probe(node) {
    return new Promise(function (resolve) {
      if (node.host === 'auto' || !node.host) { resolve(Object.assign({}, node, { lat: null, status: 'auto' })); return; }
      var t0 = Date.now();
      var img = new Image();
      var done = false;
      var timer = setTimeout(function () {
        if (done) return; done = true;
        resolve(Object.assign({}, node, { lat: null, status: 'timeout' }));
      }, 4000);
      img.onload = img.onerror = function () {
        if (done) return; done = true;
        clearTimeout(timer);
        var dt = Date.now() - t0;
        resolve(Object.assign({}, node, { lat: dt, status: dt < 900 ? 'ok' : 'warn' }));
      };
      img.src = 'https://' + node.host + ':' + node.port + '/favicon.ico?_=' + Date.now();
    });
  }

  function latColor(s) {
    if (s === 'ok') return 'var(--green)';
    if (s === 'warn') return 'var(--gold)';
    if (s === 'timeout') return 'var(--red)';
    return 'var(--dim)';
  }

  function render() {
    var box = $('nodeList');
    if (!box) return;
    box.innerHTML = '';
    NODES.forEach(function (n, i) {
      var row = document.createElement('div');
      row.className = 'node';
      var dotCls = n.status === 'ok' ? '' : (n.status === 'warn' ? 'warn' : 'off');
      var latTxt = n.lat != null ? n.lat + ' ms' : (n.status === 'timeout' ? '超時' : (n.host === 'auto' ? '自動' : '—'));
      row.innerHTML =
        '<div class="dot ' + dotCls + '"></div>' +
        '<div class="info"><div class="nm">' + n.name + (n.tag ? ' <span class="tag">' + n.tag + '</span>' : '') + '</div>' +
        '<div class="meta">' + (n.host === 'auto' ? '由系統自動選擇最佳線路' : (n.host + ':' + n.port)) + '</div></div>' +
        '<div class="lat" style="color:' + latColor(n.status) + '">' + latTxt + '</div>' +
        '<button class="btn ghost mini" data-i="' + i + '">啟用</button>';
      row.querySelector('button').addEventListener('click', function () { pick(i); });
      box.appendChild(row);
    });
  }

  function pick(i) {
    selected = NODES[i];
    var name = selected.name;
    if (selected.host === 'auto') {
      // 自動：挑最低延遲
      var best = null;
      NODES.forEach(function (n) { if (n.lat != null && (!best || n.lat < best.lat)) best = n; });
      if (best) { name = best.name; }
    }
    toast('已啟用加速線路：' + name);
  }

  window.probeAll = function () {
    var st = $('probeStatus');
    if (st) st.textContent = '測速中…';
    Promise.all(NODES.map(probe)).then(function (res) {
      NODES = res;
      render();
      var okCount = res.filter(function (n) { return n.status === 'ok'; }).length;
      if (st) st.textContent = '完成，' + okCount + ' 條線路可用';
    }).catch(function () {
      if (st) st.textContent = '測速失敗';
    });
  };

  /* ---------- MTProto 複製 ---------- */
  window.copyMt = function () {
    if (!MT.server) { toast('暫無可用 MTProto 節點', true); return; }
    var txt = 'Server: ' + MT.server + '\nPort: ' + MT.port + '\nSecret: ' + MT.secret;
    navigator.clipboard.writeText(txt).then(function () { toast('已複製代理資訊，貼到 Telegram 設定即可'); },
      function () { toast('複製失敗，請手動選取', true); });
  };

  window.copyMtLink = function () {
    if (!MT.server) { toast('暫無可用 MTProto 節點', true); return; }
    var link = 'tg://proxy?server=' + MT.server + '&port=' + MT.port + '&secret=' + MT.secret;
    navigator.clipboard.writeText(link).then(function () { toast('已複製，貼到瀏覽器打開可一鍵導入'); },
      function () { toast('複製失敗，請手動選取', true); });
  };

  /* ---------- 初始化 ---------- */
  function fillMt() {
    $('mtServer').textContent = MT.server || '—';
    $('mtPort').textContent = MT.port || '—';
    $('mtSecret').textContent = MT.secret ? (MT.secret.slice(0, 12) + '…') : '—';
    var w = $('mtWarn');
    if (!MT.server) {
      w.textContent = '提示：MTProto 節點尚未配置，管理員可在後台 /api/tg-accel/nodes 設定 server / port / secret 後自動生效。';
      w.style.display = 'block';
      document.querySelectorAll('#mtprotoCard .btn').forEach(function (b) { b.style.opacity = .55; });
    } else {
      w.style.display = 'none';
    }
  }

  function init() {
    fetch('/api/tg-accel/nodes', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var d = (j && j.nodes && j.nodes.length) ? j : FALLBACK;
        NODES = d.nodes.map(function (n) { return Object.assign({ lat: null, status: null }, n); });
        MT = d.mtproto || { server: '', port: '', secret: '' };
        render(); fillMt(); probeAll();
      })
      .catch(function () {
        NODES = FALLBACK.nodes.map(function (n) { return Object.assign({ lat: null, status: null }, n); });
        MT = FALLBACK.mtproto;
        render(); fillMt(); probeAll();
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
