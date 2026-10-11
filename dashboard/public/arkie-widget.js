/* Arkie Chat Widget v2 — injected into dashboards
 * 升级: mascot 头像 + ARK 快捷入口 + 本地历史 + 富文本格式 + 全屏模式
 */
(function () {
  if (window.__arkieLoaded) return;
  window.__arkieLoaded = true;

  var MASCOT = window.ARKIE_MASCOT || '/mascot.png';
  var API = (window.ARKIE_API || (function () { return window.location.origin; })());

  // 从服务端或本地取 mascot（优先服务端 public，其次内联 SVG 回退）
  var svgFallback = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs><circle cx="32" cy="32" r="30" fill="url(#g)"/><circle cx="23" cy="27" r="5" fill="#fff"/><circle cx="41" cy="27" r="5" fill="#fff"/><circle cx="23" cy="27" r="2.2" fill="#1a1a2e"/><circle cx="41" cy="27" r="2.2" fill="#1a1a2e"/><path d="M22 42 q10 9 20 0" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/></svg>'
  );

  var style = document.createElement('style');
  style.textContent = `
    .arkie-fab{position:fixed;bottom:20px;right:20px;width:60px;height:60px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);box-shadow:0 6px 24px rgba(99,102,241,.45);cursor:pointer;z-index:99998;display:flex;align-items:center;justify-content:center;transition:transform .25s cubic-bezier(.4,0,.2,1);overflow:hidden}
    .arkie-fab:hover{transform:scale(1.08) rotate(-3deg)}
    .arkie-fab img{width:52px;height:52px;border-radius:50%;object-fit:cover}
    .arkie-fab-badge{position:absolute;top:2px;right:2px;width:14px;height:14px;background:#18c98a;border-radius:50%;border:2px solid #0d1117;animation:arkiePulse 2s infinite}
    @keyframes arkiePulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.6;transform:scale(.85)}}
    .arkie-panel{position:fixed;bottom:90px;right:20px;width:390px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 110px);background:#0f1420;border-radius:18px;box-shadow:0 16px 48px rgba(0,0,0,.6);z-index:99999;display:none;flex-direction:column;overflow:hidden;border:1px solid #232c3d;font-family:"Inter","Segoe UI",system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
    .arkie-panel.open{display:flex;animation:arkieSlideUp .28s cubic-bezier(.4,0,.2,1)}
    @keyframes arkieSlideUp{from{transform:translateY(24px) scale(.98);opacity:0}to{transform:translateY(0) scale(1);opacity:1}}
    .arkie-header{padding:12px 14px;background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;gap:10px;position:relative}
    .arkie-header-av{width:38px;height:38px;border-radius:50%;object-fit:cover;background:#fff;border:2px solid rgba(255,255,255,.3)}
    .arkie-header-info{flex:1;min-width:0}
    .arkie-header-name{font-size:15px;font-weight:700;color:#fff;display:flex;align-items:center;gap:6px}
    .arkie-header-tag{font-size:9px;background:rgba(255,255,255,.22);padding:1px 6px;border-radius:6px;font-weight:600}
    .arkie-header-status{font-size:11px;color:rgba(255,255,255,.78);display:flex;align-items:center;gap:5px}
    .arkie-dot{width:6px;height:6px;background:#18c98a;border-radius:50%;box-shadow:0 0 6px #18c98a}
    .arkie-header-btns{display:flex;gap:2px}
    .arkie-hbtn{cursor:pointer;color:rgba(255,255,255,.85);font-size:16px;background:none;border:none;padding:5px 8px;border-radius:8px;line-height:1;transition:.15s}
    .arkie-hbtn:hover{background:rgba(255,255,255,.18);color:#fff}
    .arkie-messages{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:linear-gradient(180deg,#0c111b,#0f1420)}
    .arkie-messages::-webkit-scrollbar{width:6px}
    .arkie-messages::-webkit-scrollbar-thumb{background:#2a3345;border-radius:3px}
    .arkie-row{display:flex;gap:8px;align-items:flex-start;max-width:100%}
    .arkie-row.user{flex-direction:row-reverse}
    .arkie-avatar{width:26px;height:26px;border-radius:50%;object-fit:cover;flex-shrink:0;background:#1c2436}
    .arkie-msg{max-width:80%;padding:9px 13px;border-radius:14px;font-size:13px;line-height:1.55;word-break:break-word;white-space:pre-wrap}
    .arkie-msg.arkie{background:#1a2231;color:#e6edf3;border-bottom-left-radius:5px;border:1px solid #232c3d}
    .arkie-msg.user{background:linear-gradient(135deg,#6366f1,#7c5cf6);color:#fff;border-bottom-right-radius:5px}
    .arkie-msg b{color:#93b4ff;font-weight:700}
    .arkie-msg.user b{color:#fff}
    .arkie-msg a{color:#6ea8fe;text-decoration:none;border-bottom:1px dotted #6ea8fe}
    .arkie-typing{display:flex;gap:5px;padding:11px 15px;background:#1a2231;border-radius:14px;border-bottom-left-radius:5px;width:fit-content;border:1px solid #232c3d}
    .arkie-typing span{width:6px;height:6px;background:#6b7a94;border-radius:50%;animation:arkieTyping 1.4s infinite}
    .arkie-typing span:nth-child(2){animation-delay:.2s}
    .arkie-typing span:nth-child(3){animation-delay:.4s}
    @keyframes arkieTyping{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}
    .arkie-input-area{padding:10px 12px;background:#121826;border-top:1px solid #232c3d;display:flex;gap:8px;align-items:flex-end}
    .arkie-input{flex:1;padding:10px 12px;background:#0c111b;border:1px solid #232c3d;border-radius:11px;color:#e6edf3;font-size:13px;outline:none;resize:none;max-height:90px;font-family:inherit;line-height:1.4;transition:.15s}
    .arkie-input:focus{border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.15)}
    .arkie-send{width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:.15s}
    .arkie-send:hover{filter:brightness(1.15);transform:translateY(-1px)}
    .arkie-send svg{width:18px;height:18px;fill:#fff}
    .arkie-quick{display:flex;flex-wrap:wrap;gap:5px;padding:8px 12px 4px;background:#121826}
    .arkie-quick-btn{padding:5px 11px;background:#1a2231;border:1px solid #232c3d;border-radius:14px;color:#9aa8bd;font-size:11.5px;cursor:pointer;white-space:nowrap;transition:.15s}
    .arkie-quick-btn:hover{background:#232c3d;color:#e6edf3;border-color:#6366f1}
    .arkie-quick-btn.ark{background:linear-gradient(135deg,rgba(99,102,241,.18),rgba(139,92,246,.18));border-color:rgba(99,102,241,.4);color:#a8b8ff}
    .arkie-foot{font-size:10px;color:#5a6779;text-align:center;padding:4px 0 8px;background:#121826}
    .arkie-panel.full{width:calc(100vw - 40px);height:calc(100vh - 40px);bottom:20px;right:20px}
  `;
  document.head.appendChild(style);

  // ── FAB ──
  var fab = document.createElement('div');
  fab.className = 'arkie-fab';
  fab.innerHTML = '<div class="arkie-fab-badge"></div><img src="' + MASCOT + '" onerror="this.src=\'' + svgFallback + '\'">';
  document.body.appendChild(fab);

  // ── Panel ──
  var panel = document.createElement('div');
  panel.className = 'arkie-panel';
  panel.innerHTML = `
    <div class="arkie-header">
      <img class="arkie-header-av" src="${MASCOT}" onerror="this.src='${svgFallback}'">
      <div class="arkie-header-info">
        <div class="arkie-header-name">Arkie <span class="arkie-header-tag">ARK</span></div>
        <div class="arkie-header-status"><span class="arkie-dot"></span> MasterD Brain 在线</div>
      </div>
      <div class="arkie-header-btns">
        <button class="arkie-hbtn" id="arkieClear" title="清空对话">⟳</button>
        <button class="arkie-hbtn" id="arkieFull" title="全屏">⤢</button>
        <button class="arkie-hbtn" id="arkieClose" title="关闭">×</button>
      </div>
    </div>
    <div class="arkie-messages" id="arkieMessages"></div>
    <div class="arkie-quick" id="arkieQuick">
      <div class="arkie-quick-btn ark" data-q="ARK价格">🪙 ARK价格</div>
      <div class="arkie-quick-btn ark" data-q="ARK池">💧 ARK池</div>
      <div class="arkie-quick-btn ark" data-q="ARK指标">📈 技术指标</div>
      <div class="arkie-quick-btn ark" data-q="ARK走势">🔮 走势</div>
      <div class="arkie-quick-btn ark" data-q="质押 1000">💹 质押计算</div>
      <div class="arkie-quick-btn" data-q="余额">💰 余额</div>
      <div class="arkie-quick-btn" data-q="持仓">📊 持仓</div>
      <div class="arkie-quick-btn" data-q="大盘">🌍 大盘</div>
      <div class="arkie-quick-btn" data-q="帮助">❓ 帮助</div>
    </div>
    <div class="arkie-input-area">
      <textarea class="arkie-input" id="arkieInput" rows="1" placeholder="问 Arkie 任何问题…（Enter 发送）"></textarea>
      <button class="arkie-send" id="arkieSendBtn" title="发送">
        <svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2v7z"/></svg>
      </button>
    </div>
    <div class="arkie-foot">Arkie · MasterD 的儿子 · ARK 生态助手</div>
  `;
  document.body.appendChild(panel);

  var msgs = panel.querySelector('#arkieMessages');
  var input = panel.querySelector('#arkieInput');

  // ── 历史记录 ──
  var HKEY = 'arkie_chat_history_v2';
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HKEY) || '[]'); } catch (e) { return []; }
  }
  function saveMsg(role, text) {
    var h = loadHistory();
    h.push({ role: role, text: text, ts: Date.now() });
    if (h.length > 60) h = h.slice(-60);
    try { localStorage.setItem(HKEY, JSON.stringify(h)); } catch (e) {}
  }
  function clearHistory() { try { localStorage.removeItem(HKEY); } catch (e) {} }

  // ── 渲染 ──
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function fmt(text) {
    var s = esc(text);
    // **bold** -> <b>
    s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    // URL -> link
    s = s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    // 地址高亮
    s = s.replace(/(0x[0-9a-fA-F]{6})[0-9a-fA-F]{28}([0-9a-fA-F]{4})/g, '<b>$1…$2</b>');
    return s;
  }
  function addMsg(role, text, persist) {
    var row = document.createElement('div');
    row.className = 'arkie-row ' + (role === 'user' ? 'user' : '');
    var av = '';
    if (role !== 'user') av = '<img class="arkie-avatar" src="' + MASCOT + '" onerror="this.src=\'' + svgFallback + '\'">';
    row.innerHTML = av + '<div class="arkie-msg ' + (role === 'user' ? 'user' : 'arkie') + '">' + fmt(text) + '</div>';
    msgs.appendChild(row);
    msgs.scrollTop = msgs.scrollHeight;
    if (persist !== false) saveMsg(role, text);
  }

  function greet() {
    addMsg('arkie', '你好！我是 Arkie 👶\nMasterD 的儿子，ARK 生态助手。\n\n我懂这些：\n• ARK价格 / ARK池 / ARK指标 / ARK走势\n• 质押收益计算（"质押 1000 360天"）\n• 链上持仓 / 鲸鱼监控 / 提醒订阅\n• 行情分析 / 持仓 / 交易执行\n\n输入"帮助"看全部。', false);
  }

  // 恢复历史
  var hist = loadHistory();
  if (hist.length) {
    hist.slice(-20).forEach(function (m) { addMsg(m.role, m.text, false); });
  } else {
    greet();
  }

  // ── 交互 ──
  fab.addEventListener('click', function () {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) input.focus();
  });
  panel.querySelector('#arkieClose').addEventListener('click', function () { panel.classList.remove('open'); });
  panel.querySelector('#arkieFull').addEventListener('click', function () { panel.classList.toggle('full'); });
  panel.querySelector('#arkieClear').addEventListener('click', function () {
    clearHistory(); msgs.innerHTML = ''; greet();
  });
  panel.querySelectorAll('.arkie-quick-btn').forEach(function (b) {
    b.addEventListener('click', function () { send(b.getAttribute('data-q')); });
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });
  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 90) + 'px';
  });
  panel.querySelector('#arkieSendBtn').addEventListener('click', doSend);

  function doSend() {
    var v = input.value.trim();
    if (!v) return;
    input.value = ''; input.style.height = 'auto';
    send(v);
  }

  function getToken() {
    return localStorage.getItem('ark_token') || localStorage.getItem('admin_token') || '';
  }

  function typing(on) {
    var t = document.getElementById('arkieTyping');
    if (on) {
      if (t) return;
      t = document.createElement('div');
      t.className = 'arkie-row'; t.id = 'arkieTyping';
      t.innerHTML = '<img class="arkie-avatar" src="' + MASCOT + '" onerror="this.src=\'' + svgFallback + '\'"><div class="arkie-typing"><span></span><span></span><span></span></div>';
      msgs.appendChild(t); msgs.scrollTop = msgs.scrollHeight;
    } else if (t) t.remove();
  }

  function send(msg) {
    addMsg('user', msg, true);
    typing(true);
    var xhr = new XMLHttpRequest();
    xhr.open('POST', API + '/api/arkie/chat', true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    var token = getToken();
    if (token) xhr.setRequestHeader('X-API-Key', token);
    xhr.timeout = 30000;
    xhr.onload = function () {
      typing(false);
      try {
        var d = JSON.parse(xhr.responseText);
        addMsg('arkie', d.reply || d.message || '...', true);
      } catch (e) {
        addMsg('arkie', '抱歉，出了点问题。请稍后重试。', true);
      }
    };
    xhr.onerror = xhr.ontimeout = function () {
      typing(false);
      addMsg('arkie', '网络连接失败，请检查后重试。', true);
    };
    xhr.send(JSON.stringify({ message: msg, userId: token || 'guest' }));
  }

  window.arkieSend = send;
  window.arkieSendMsg = doSend;
})();
