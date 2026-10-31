import { getToken, setToken } from './api.js';
// Connexion WebSocket temps réel (mail en direct, présence, signaling P2P).
// Reconnexion automatique. handlers = { 'mail:new': fn, 'presence': fn, 'rtc:signal': fn, '*': fn }
export function connectRealtime(token, handlers = {}) {
  let ws = null;
  let closed = false;
  let retry = null;
  let generation = 0;

  function open() {
    token = getToken();
    if (!token || closed) return;
    const usedToken = token;
    const current = ++generation;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // Le jeton ne passe jamais dans l'adresse (journaux du tunnel, du proxy) : il part dans
    // le premier message, dès l'ouverture.
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    const socket = ws;
    socket.onopen = () => { try { socket.send(JSON.stringify({ type: 'auth', token: usedToken })); } catch {} };
    socket.onmessage = (e) => {
      if (current !== generation) return;
      let m; try { m = JSON.parse(e.data); } catch { return; }
      handlers[m.type]?.(m);
      handlers['*']?.(m);
    };
    socket.onclose = (event) => {
      if (closed || current !== generation) return;
      if (event.code === 4001 && usedToken === getToken()) {
        setToken(null); window.dispatchEvent(new Event('comet:auth-expired'));
      }
      if (!closed) retry = setTimeout(open, 2000);
    };
    socket.onerror = () => { try { socket.close(); } catch {} };
  }
  open();
  const changed = () => { generation++; clearTimeout(retry); try { ws?.close(); } catch {} open(); };
  window.addEventListener('comet:token-changed', changed);

  return {
    send: (obj) => { try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); } catch {} },
    close: () => { closed = true; generation++; window.removeEventListener('comet:token-changed', changed); clearTimeout(retry); try { ws?.close(); } catch {} },
  };
}
