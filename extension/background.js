// Service worker du connecteur. Chiffre les identifiants capturés vers la clé
// publique de l'utilisateur (même format que Comet) et les pousse au serveur.
// Le serveur ne voit que du chiffré ; l'app les importe dans le coffre.

const te = new TextEncoder();
const b64 = (buf) => { const a = new Uint8Array(buf); let s = ''; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); };
const ub64 = (str) => { const bin = atob(str); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; };

// Reproduit encryptMessage de Comet : AES-GCM aléatoire, clé enveloppée RSA-OAEP.
async function encryptForPublic(obj, publicKeyB64) {
  const aes = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, te.encode(JSON.stringify(obj)));
  const raw = await crypto.subtle.exportKey('raw', aes);
  const pub = await crypto.subtle.importKey('spki', ub64(publicKeyB64), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const encKey = b64(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, raw));
  return { ciphertext: b64(ct), iv: b64(iv), encKey };
}

const getCfg = () => chrome.storage.local.get(['server', 'token', 'publicKey', 'email', 'enabled']);

async function pair(server, code) {
  const base = server.replace(/\/$/, '');
  const r = await fetch(base + '/api/extension/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || ('HTTP ' + r.status)); }
  const { token, email, publicKey } = await r.json();
  await chrome.storage.local.set({ server: base, token, email, publicKey, enabled: true });
  return { email };
}

async function capture({ host, username, password, url }) {
  const cfg = await getCfg();
  if (!cfg.enabled || !cfg.token || !cfg.publicKey || !password) return;
  const data = { title: host, username: username || '', password, url: url || ('https://' + host), notes: "Capturé par l'extension Comet" };
  const enc = await encryptForPublic(data, cfg.publicKey);
  await fetch(cfg.server + '/api/extension/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ext-Token': cfg.token },
    body: JSON.stringify({ ...enc, host }),
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'capture') { capture(msg.data).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false })); return true; }
  if (msg.type === 'pair') { pair(msg.server, msg.code).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: false, error: e.message })); return true; }
  if (msg.type === 'status') { getCfg().then((c) => sendResponse({ connected: !!c.token, email: c.email, enabled: !!c.enabled, server: c.server })); return true; }
  if (msg.type === 'setEnabled') { chrome.storage.local.set({ enabled: !!msg.enabled }).then(() => sendResponse({ ok: true })); return true; }
  if (msg.type === 'disconnect') { chrome.storage.local.remove(['token', 'publicKey', 'email']).then(() => chrome.storage.local.set({ enabled: false })).then(() => sendResponse({ ok: true })); return true; }
});
