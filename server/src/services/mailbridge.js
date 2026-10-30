import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { db } from '../db.js';
import { seal, unseal } from './seal.js';
import { refreshAccessToken, isOAuthProvider } from './oauth.js';
import { notifyUser } from '../ws.js';

const imapSecure = (port) => Number(port) === 993;
const smtpSecure = (port) => Number(port) === 465;

// ── OAuth : jeton d'accès frais (rafraîchi et re-scellé si expiré) ───────────
async function freshAccessToken(account) {
  const now = Date.now();
  const exp = account.oauth_expiry ? Date.parse(account.oauth_expiry) : 0;
  if (account.oauth_access && exp - 60000 > now) return unseal(account.oauth_access); // encore valable (marge 1 min)
  const refresh = unseal(account.oauth_refresh);
  const tok = await refreshAccessToken(account.provider, refresh);
  const access = tok.access_token;
  const expiry = new Date(now + (Number(tok.expires_in) || 3600) * 1000).toISOString();
  // Google ne renvoie pas toujours un nouveau refresh_token ; Microsoft le fait tourner.
  const sets = ['oauth_access = ?', 'oauth_expiry = ?']; const params = [seal(access), expiry];
  if (tok.refresh_token) { sets.push('oauth_refresh = ?'); params.push(seal(tok.refresh_token)); }
  params.push(account.id);
  db.prepare(`UPDATE mail_accounts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  account.oauth_access = seal(access); account.oauth_expiry = expiry; // garde l'objet à jour pour le reste du tick
  return access;
}

// Construit l'objet d'auth IMAP (mot de passe d'app ou XOAUTH2 selon le compte).
async function imapAuth(account) {
  if (isOAuthProvider(account.provider)) return { user: account.username, accessToken: await freshAccessToken(account) };
  return { user: account.username, pass: unseal(account.sealed_pass) };
}
async function smtpAuth(account) {
  if (isOAuthProvider(account.provider)) return { type: 'OAuth2', user: account.username, accessToken: await freshAccessToken(account) };
  return { user: account.username, pass: unseal(account.sealed_pass) };
}

// Vérifie que les identifiants fonctionnent (IMAP + SMTP) avant d'enregistrer le compte.
export async function testConnection(cfg) {
  const imap = new ImapFlow({ host: cfg.imapHost, port: Number(cfg.imapPort), secure: imapSecure(cfg.imapPort), auth: { user: cfg.username, pass: cfg.password }, logger: false });
  await imap.connect();
  await imap.logout();
  const t = nodemailer.createTransport({ host: cfg.smtpHost, port: Number(cfg.smtpPort), secure: smtpSecure(cfg.smtpPort), auth: { user: cfg.username, pass: cfg.password } });
  await t.verify();
  return true;
}

// Récupère les nouveaux messages (UID > last_uid) sur un client DÉJÀ connecté dont
// INBOX est sélectionnée (verrou ou mailboxOpen). Partagé par le sondage one-shot
// (syncAccount) et par la réception en push (IDLE). On ne stocke PAS le HTML (jamais
// affiché par le lecteur) et on demande à mailparser de ne pas le (re)générer
// (skipTextToHtml) → moins de CPU et d'écritures ; le texte reste dérivé du HTML pour
// les e-mails sans partie texte (html→texte, comportement inchangé).
export async function fetchNewMessages(account, client) {
  const uidNext = (client.mailbox && client.mailbox.uidNext) || 1;
  // 1ʳᵉ synchro : on ne récupère que les ~30 plus récents (pas tout l'historique)
  const start = account.last_uid > 0 ? account.last_uid + 1 : Math.max(1, uidNext - 30);
  if (start >= uidNext) {
    db.prepare("UPDATE mail_accounts SET last_sync = datetime('now'), last_error = NULL WHERE id = ?").run(account.id);
    return 0;
  }
  const ins = db.prepare(`INSERT OR IGNORE INTO ext_messages
    (account_id, direction, uid, message_id, from_addr, from_name, to_addr, subject, body_text, body_html, date, folder, is_read)
    VALUES (?, 'in', ?, ?, ?, ?, ?, ?, ?, '', ?, 'inbox', 0)`);
  let maxUid = account.last_uid, added = 0;
  for await (const msg of client.fetch(`${start}:*`, { uid: true, source: true }, { uid: true })) {
    maxUid = Math.max(maxUid, msg.uid);
    try {
      const p = await simpleParser(msg.source, { skipTextToHtml: true, skipTextLinks: true });
      const from = (p.from && p.from.value && p.from.value[0]) || {};
      ins.run(account.id, msg.uid, p.messageId || null, from.address || '', from.name || '',
        (p.to && p.to.text) || '', p.subject || '(sans objet)', p.text || '',
        p.date ? p.date.toISOString() : null);
      added++;
    } catch { /* message illisible : on l'ignore */ }
  }
  if (maxUid > account.last_uid) { db.prepare('UPDATE mail_accounts SET last_uid = ? WHERE id = ?').run(maxUid, account.id); account.last_uid = maxUid; }
  db.prepare("UPDATE mail_accounts SET last_sync = datetime('now'), last_error = NULL WHERE id = ?").run(account.id);
  return added;
}

// Synchro one-shot : ouvre une connexion, récupère les nouveaux messages, ferme.
// Utilisée par le bouton « Synchroniser » et comme REPLI du mode push (IDLE).
export async function syncAccount(account) {
  const client = new ImapFlow({ host: account.imap_host, port: account.imap_port, secure: imapSecure(account.imap_port), auth: await imapAuth(account), logger: false });
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    let added = 0;
    try { added = await fetchNewMessages(account, client); } finally { lock.release(); }
    await client.logout();
    return added;
  } catch (e) {
    // Message plus actionnable pour les comptes OAuth (cause n°1 d'une boîte vide :
    // accès IMAP non activé côté fournisseur, ou autorisation à renouveler).
    let detail = String(e.message || e);
    if (isOAuthProvider(account.provider) && /auth|credential|login|token|invalid/i.test(detail)) {
      detail += ' — vérifiez que l’accès IMAP est activé chez votre fournisseur (Gmail : Paramètres → Transfert et POP/IMAP) puis reconnectez le compte.';
    }
    try { db.prepare('UPDATE mail_accounts SET last_error = ? WHERE id = ?').run(detail.slice(0, 300), account.id); } catch {}
    try { await client.logout(); } catch { /* déjà fermé */ }
    throw new Error(detail);
  }
}

// ── Transports SMTP poolés & mis en cache par compte ────────────────────────
// Recréer un transport à CHAQUE envoi refait tout le handshake TCP+TLS+AUTH, la
// partie chère en CPU. On garde donc un transport POOLÉ par compte : nodemailer
// réutilise la connexion SMTP entre envois. La clé inclut hôte/port/identifiant
// (et le jeton OAuth courant) → tout changement d'identifiant recrée proprement le
// transport (l'ancien est fermé). Pour les comptes OAuth, la clé change quand le
// jeton tourne (~1 h) : le pool reste effectif à l'intérieur de cette fenêtre.
const transports = new Map(); // account.id -> { key, t }

function transportKeyFor(account, auth) {
  return [account.smtp_host, account.smtp_port, account.username, auth.pass || auth.accessToken || ''].join('|');
}

async function getTransport(account) {
  const auth = await smtpAuth(account); // rafraîchit le jeton OAuth au besoin
  const key = transportKeyFor(account, auth);
  const cached = transports.get(account.id);
  if (cached && cached.key === key) return cached.t;
  if (cached) { try { cached.t.close(); } catch { /* déjà fermé */ } }
  const t = nodemailer.createTransport({
    host: account.smtp_host, port: Number(account.smtp_port), secure: smtpSecure(account.smtp_port),
    requireTLS: !smtpSecure(account.smtp_port), // STARTTLS sur 587 (Outlook)
    pool: true, maxConnections: 2, maxMessages: 50,
    auth,
  });
  transports.set(account.id, { key, t });
  return t;
}

// Ferme et oublie le transport d'un compte (identifiants modifiés / compte supprimé).
export function closeTransport(accountId) {
  const cached = transports.get(Number(accountId));
  if (cached) { try { cached.t.close(); } catch { /* déjà fermé */ } transports.delete(Number(accountId)); }
}

// Envoie un message via le compte externe (SMTP) et le journalise dans « Envoyés ».
export async function sendMail(account, { to, cc, subject, text, html, inReplyTo }) {
  const t = await getTransport(account);
  const info = await t.sendMail({
    from: account.label ? `${account.label} <${account.email}>` : account.email,
    to, cc: cc || undefined, subject: subject || '', text: text || '', html: html || undefined,
    inReplyTo: inReplyTo || undefined,
  });
  db.prepare(`INSERT INTO ext_messages (account_id, direction, message_id, from_addr, to_addr, subject, body_text, date, folder, is_read)
              VALUES (?, 'out', ?, ?, ?, ?, ?, datetime('now'), 'sent', 1)`)
    .run(account.id, info.messageId || null, account.email, Array.isArray(to) ? to.join(', ') : String(to || ''), subject || '', text || '');
  return info;
}

// ── Réception en push (IMAP IDLE) ────────────────────────────────────────────
// Au lieu de rouvrir une connexion IMAP toutes les 3 min par compte (handshake TLS
// répété = charge réseau + CPU, et jusqu'à 3 min de latence), on garde UNE connexion
// persistante par compte qui reste en IDLE : le serveur pousse un évènement 'exists'
// à l'arrivée de courrier → on ne récupère QUE les nouveaux messages, instantanément.
// Robustesse : reconnexion automatique à back-off, et un sondage de sécurité peu
// fréquent. Si l'IDLE échoue pour un compte, ce compte RETOMBE sur le sondage
// one-shot (syncAccount) → le courrier continue d'arriver quoi qu'il arrive.
const idle = new Map(); // account.id -> { client, busy, pending, closing, backoff, timer, lastSafety }

function reloadAccount(id) { try { return db.prepare('SELECT * FROM mail_accounts WHERE id = ?').get(id); } catch { return null; } }

// Vide la file des nouveaux messages sur la connexion IDLE d'un compte (ré-entrant :
// un 'exists' arrivé pendant un fetch est retraité derrière via `pending`).
async function drain(id) {
  const st = idle.get(id);
  if (!st || !st.client) return;
  if (st.busy) { st.pending = true; return; }
  st.busy = true;
  try {
    do {
      st.pending = false;
      const account = reloadAccount(id);
      if (!account) break;
      const n = await fetchNewMessages(account, st.client);
      if (n > 0) notifyUser(account.user_id, { type: 'mail:ext', accountId: id });
    } while (st.pending);
  } catch { /* la connexion se refermera puis rekonnectera si nécessaire */ }
  finally { st.busy = false; }
}

async function openIdle(account) {
  const id = account.id;
  let st = idle.get(id);
  if (!st) { st = {}; idle.set(id, st); }
  if (st.closing || st.client) return;
  let client;
  try {
    client = new ImapFlow({ host: account.imap_host, port: account.imap_port, secure: imapSecure(account.imap_port), auth: await imapAuth(account), logger: false, emitLogs: false });
    client.on('error', () => { /* 'close' enchaîne la reconnexion */ });
    client.on('close', () => { const s = idle.get(id); if (!s || s.closing) return; s.client = null; scheduleReconnect(id, account); });
    client.on('exists', () => { drain(id); });
    await client.connect();
    await client.mailboxOpen('INBOX');
    st.client = client; st.backoff = 0;
    await drain(id); // rattrapage à la connexion
  } catch (e) {
    try { db.prepare('UPDATE mail_accounts SET last_error = ? WHERE id = ?').run(String(e && e.message ? e.message : e).slice(0, 300), id); } catch { /* */ }
    if (client) { try { await client.logout(); } catch { /* */ } }
    st.client = null;
    scheduleReconnect(id, account);
  }
}

function scheduleReconnect(id, account) {
  const st = idle.get(id);
  if (!st || st.closing || st.timer) return;
  const n = Math.min((st.backoff || 0) + 1, 6); st.backoff = n;
  const delay = [5000, 15000, 30000, 60000, 120000, 300000][n - 1];
  st.timer = setTimeout(() => {
    const s = idle.get(id);
    if (!s) return; s.timer = null;
    if (s.closing) return;
    openIdle(reloadAccount(id) || account);
  }, delay);
  st.timer.unref?.();
}

function stopIdle(id) {
  const st = idle.get(id);
  if (!st) return;
  st.closing = true;
  if (st.timer) { clearTimeout(st.timer); st.timer = null; }
  if (st.client) { const c = st.client; st.client = null; c.logout().catch(() => {}); }
  idle.delete(id);
}

// Démarre la réception push pour tous les comptes activés + un filet de sécurité.
export function startMailSync(safetyMs = 2 * 60000) {
  const reconcile = () => {
    let accounts = [];
    try { accounts = db.prepare('SELECT * FROM mail_accounts WHERE enabled = 1').all(); } catch { return []; }
    const active = new Set(accounts.map((a) => a.id));
    for (const a of accounts) if (!idle.has(a.id)) openIdle(a);            // nouveaux comptes → IDLE
    for (const id of [...idle.keys()]) if (!active.has(id)) stopIdle(id);  // comptes retirés → on ferme
    return accounts;
  };
  const tick = () => {
    for (const a of reconcile()) {
      const st = idle.get(a.id);
      if (st && st.client) {
        // IDLE actif : filet léger, au plus toutes les 15 min (rattrape un 'exists' manqué)
        if (Date.now() - (st.lastSafety || 0) > 15 * 60000) { st.lastSafety = Date.now(); drain(a.id); }
      } else {
        // Pas d'IDLE (échec / back-off en cours) : sondage one-shot pour continuer à recevoir
        syncAccount(reloadAccount(a.id) || a)
          .then((n) => { if (n > 0) notifyUser(a.user_id, { type: 'mail:ext', accountId: a.id }); })
          .catch(() => { /* erreur journalisée dans last_error */ });
      }
    }
  };
  setTimeout(reconcile, 3000);
  const t = setInterval(tick, safetyMs);
  t.unref?.();
  return t;
}
