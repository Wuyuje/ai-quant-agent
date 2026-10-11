/* Arkie 实时推送客户端 — WebSocket 连接到 /arkie/ws
 * 用法:
 *   <script src="/arkie-realtime-client.js"></script>
 *   <script>
 *     ArkieRT.onPrice(d => console.log('ARK', d.ark.price));
 *     ArkieRT.onAlert(d => alert('触发: ' + d.price));
 *     ArkieRT.onWhale(d => console.log('鲸鱼', d.amt));
 *   </script>
 */
(function () {
  if (window.ArkieRT) return;
  var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/arkie/ws';
  var ws = null, reconnectTimer = null, attempt = 0;
  var handlers = { price: [], alert: [], whale: [], status: [] };

  function connect() {
    try { ws = new WebSocket(url); } catch (e) { return retry(); }
    ws.onopen = function () {
      attempt = 0;
      emit('status', { connected: true });
      ws.send(JSON.stringify({ type: 'subscribe', topic: 'ark', minWhale: 100000 }));
    };
    ws.onmessage = function (ev) {
      try {
        var m = JSON.parse(ev.data);
        if (m.type === 'price') emit('price', m.data);
        else if (m.type === 'alert') emit('alert', m.data);
        else if (m.type === 'whale') emit('whale', m.data);
      } catch (e) {}
    };
    ws.onclose = function () { emit('status', { connected: false }); retry(); };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  function retry() {
    if (reconnectTimer) return;
    attempt++;
    var delay = Math.min(30000, 1000 * Math.pow(2, Math.min(attempt, 5)));
    reconnectTimer = setTimeout(function () { reconnectTimer = null; connect(); }, delay);
  }

  function emit(type, data) {
    (handlers[type] || []).forEach(function (fn) { try { fn(data); } catch (e) {} });
    // 自定义事件
    try { window.dispatchEvent(new CustomEvent('arkie:' + type, { detail: data })); } catch (e) {}
  }

  window.ArkieRT = {
    on: function (type, fn) { (handlers[type] = handlers[type] || []).push(fn); return this; },
    onPrice: function (fn) { return this.on('price', fn); },
    onAlert: function (fn) { return this.on('alert', fn); },
    onWhale: function (fn) { return this.on('whale', fn); },
    onStatus: function (fn) { return this.on('status', fn); },
    setMinWhale: function (n) { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'subscribe', topic: 'ark', minWhale: n })); },
    get ready() { return ws && ws.readyState === 1; }
  };

  connect();
})();
