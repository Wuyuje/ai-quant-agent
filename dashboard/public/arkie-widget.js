/* Arkie Chat Widget — injected into dashboards */
(function() {
  if (window.__arkieLoaded) return;
  window.__arkieLoaded = true;

  var style = document.createElement('style');
  style.textContent = `
    .arkie-fab{position:fixed;bottom:20px;right:20px;width:60px;height:60px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);box-shadow:0 4px 20px rgba(99,102,241,.4);cursor:pointer;z-index:99998;display:flex;align-items:center;justify-content:center;transition:transform .3s}
    .arkie-fab:hover{transform:scale(1.1)}
    .arkie-fab img{width:40px;height:40px;border-radius:50%}
    .arkie-fab-badge{position:absolute;top:-2px;right:-2px;width:16px;height:16px;background:#3fb950;border-radius:50%;border:2px solid #0d1117;animation:pulse 2s infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
    .arkie-panel{position:fixed;bottom:90px;right:20px;width:380px;max-width:calc(100vw - 40px);height:520px;max-height:calc(100vh - 120px);background:#161b22;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.5);z-index:99999;display:none;flex-direction:column;overflow:hidden;border:1px solid #30363d}
    .arkie-panel.open{display:flex;animation:slideUp .3s ease}
    @keyframes slideUp{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}
    .arkie-header{padding:12px 16px;background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;gap:10px}
    .arkie-header img{width:36px;height:36px;border-radius:50%;background:#fff;padding:2px}
    .arkie-header-info{flex:1}
    .arkie-header-name{font-size:15px;font-weight:700;color:#fff}
    .arkie-header-status{font-size:11px;color:rgba(255,255,255,.7)}
    .arkie-header-close{cursor:pointer;color:rgba(255,255,255,.8);font-size:20px;background:none;border:none;padding:4px 8px}
    .arkie-header-close:hover{color:#fff}
    .arkie-messages{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#0d1117}
    .arkie-messages::-webkit-scrollbar{width:6px}
    .arkie-messages::-webkit-scrollbar-thumb{background:#30363d;border-radius:3px}
    .arkie-msg{max-width:85%;padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
    .arkie-msg.arkie{align-self:flex-start;background:#1c2128;color:#e6edf3;border-bottom-left-radius:4px}
    .arkie-msg.user{align-self:flex-end;background:#6366f1;color:#fff;border-bottom-right-radius:4px}
    .arkie-msg.system{align-self:center;background:#21262d;color:#8b949e;font-size:12px;border-radius:8px}
    .arkie-typing{align-self:flex-start;padding:8px 16px;background:#1c2128;border-radius:12px;border-bottom-left-radius:4px}
    .arkie-typing span{display:inline-block;width:6px;height:6px;background:#8b949e;border-radius:50%;margin:0 1px;animation:typing 1.4s infinite}
    .arkie-typing span:nth-child(2){animation-delay:.2s}
    .arkie-typing span:nth-child(3){animation-delay:.4s}
    @keyframes typing{0%,60%,100%{opacity:.3;transform:scale(.8)}30%{opacity:1;transform:scale(1)}}
    .arkie-input-area{padding:10px 12px;background:#161b22;border-top:1px solid #30363d;display:flex;gap:8px}
    .arkie-input{flex:1;padding:8px 12px;background:#0d1117;border:1px solid #30363d;border-radius:8px;color:#e6edf3;font-size:13px;outline:none;resize:none;max-height:80px;font-family:inherit}
    .arkie-input:focus{border-color:#6366f1}
    .arkie-send{width:36px;height:36px;border-radius:8px;background:#6366f1;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}
    .arkie-send:hover{background:#5457e6}
    .arkie-send svg{width:18px;height:18px;fill:#fff}
    .arkie-quick{display:flex;flex-wrap:wrap;gap:4px;padding:4px 12px;background:#161b22}
    .arkie-quick-btn{padding:4px 10px;background:#21262d;border:1px solid #30363d;border-radius:12px;color:#8b949e;font-size:11px;cursor:pointer;white-space:nowrap}
    .arkie-quick-btn:hover{background:#30363d;color:#e6edf3}
  `;
  document.head.appendChild(style);

  // Create FAB
  var fab = document.createElement('div');
  fab.className = 'arkie-fab';
  fab.innerHTML = '<div class="arkie-fab-badge"></div><div style="font-size:28px">🧠</div>';
  document.body.appendChild(fab);

  // Create panel
  var panel = document.createElement('div');
  panel.className = 'arkie-panel';
  panel.innerHTML = `
    <div class="arkie-header">
      <div style="font-size:24px">🧠</div>
      <div class="arkie-header-info">
        <div class="arkie-header-name">Arkie</div>
        <div class="arkie-header-status">● MasterD Brain 在线</div>
      </div>
      <button class="arkie-header-close" onclick="document.querySelector('.arkie-panel').classList.remove('open')">×</button>
    </div>
    <div class="arkie-messages" id="arkieMessages">
      <div class="arkie-msg arkie">你好！我是 Arkie 👶\n我是 MasterD 的儿子，继承了他的分析基因。\n我可以帮你查行情、看持仓、分析市场、执行交易。\n\n输入"帮助"查看我能做什么！</div>
    </div>
    <div class="arkie-quick">
      <div class="arkie-quick-btn" onclick="arkieSend('余额')">💰 余额</div>
      <div class="arkie-quick-btn" onclick="arkieSend('持仓')">📊 持仓</div>
      <div class="arkie-quick-btn" onclick="arkieSend('交易记录')">📋 记录</div>
      <div class="arkie-quick-btn" onclick="arkieSend('大盘')">🌍 大盘</div>
      <div class="arkie-quick-btn" onclick="arkieSend('Brain状态')">🧠 Brain</div>
      <div class="arkie-quick-btn" onclick="arkieSend('帮助')">❓ 帮助</div>
    </div>
    <div class="arkie-input-area">
      <input type="text" class="arkie-input" id="arkieInput" placeholder="问 Arkie 任何问题..." onkeydown="if(event.key==='Enter')arkieSendMsg()">
      <button class="arkie-send" onclick="arkieSendMsg()">
        <svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2v7z"/></svg>
      </button>
    </div>
  `;
  document.body.appendChild(panel);

  fab.addEventListener('click', function() {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) {
      document.getElementById('arkieInput').focus();
    }
  });

  function getApiBase() {
    var loc = window.location;
    return loc.origin;
  }

  function getToken() {
    return localStorage.getItem('ark_token') || localStorage.getItem('admin_token') || '';
  }

  window.arkieSendMsg = function() {
    var input = document.getElementById('arkieInput');
    var msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    arkieSend(msg);
  };

  window.arkieSend = function(msg) {
    var msgs = document.getElementById('arkieMessages');
    // Add user message
    var userDiv = document.createElement('div');
    userDiv.className = 'arkie-msg user';
    userDiv.textContent = msg;
    msgs.appendChild(userDiv);
    msgs.scrollTop = msgs.scrollHeight;

    // Typing indicator
    var typing = document.createElement('div');
    typing.className = 'arkie-typing';
    typing.id = 'arkieTyping';
    typing.innerHTML = '<span></span><span></span><span></span>';
    msgs.appendChild(typing);
    msgs.scrollTop = msgs.scrollHeight;

    // API call
    var xhr = new XMLHttpRequest();
    var apiBase = getApiBase();
    xhr.open('POST', apiBase + '/api/arkie/chat', true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    var token = getToken();
    if (token) xhr.setRequestHeader('X-API-Key', token);
    xhr.timeout = 30000;

    xhr.onload = function() {
      var t = document.getElementById('arkieTyping');
      if (t) t.remove();
      try {
        var data = JSON.parse(xhr.responseText);
        var replyDiv = document.createElement('div');
        replyDiv.className = 'arkie-msg arkie';
        replyDiv.textContent = data.reply || data.message || '...';
        msgs.appendChild(replyDiv);
      } catch(e) {
        var errDiv = document.createElement('div');
        errDiv.className = 'arkie-msg arkie';
        errDiv.textContent = '抱歉，出了点问题。请稍后重试。';
        msgs.appendChild(errDiv);
      }
      msgs.scrollTop = msgs.scrollHeight;
    };

    xhr.onerror = xhr.ontimeout = function() {
      var t = document.getElementById('arkieTyping');
      if (t) t.remove();
      var errDiv = document.createElement('div');
      errDiv.className = 'arkie-msg arkie';
      errDiv.textContent = '网络连接失败，请检查后重试。';
      msgs.appendChild(errDiv);
      msgs.scrollTop = msgs.scrollHeight;
    };

    xhr.send(JSON.stringify({ message: msg, userId: getToken() }));
  };
})();
