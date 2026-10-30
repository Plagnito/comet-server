// Connexion WebSocket temps réel (mail en direct, présence, signaling P2P).
// Reconnexion automatique. handlers = { 'mail:new': fn, 'presence': fn, 'rtc:signal': fn, '*': fn }
export function connectRealtime(token, handlers = {}) {
  let ws = null;
  let closed = false;
  let retry = null;

  function open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      handlers[m.type]?.(m);
      handlers['*']?.(m);
    };
    ws.onclose = () => { if (!closed) retry = setTimeout(open, 2000); };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }
  open();

  return {
    send: (obj) => { try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); } catch {} },
    close: () => { closed = true; clearTimeout(retry); try { ws?.close(); } catch {} },
  };
}
