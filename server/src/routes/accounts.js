import { Router } from 'express';
import { db } from '../db.js';
import { authRequired } from '../auth.js';
import { escapeHtml } from '../util/html.js';
import { validateBody, mailAccountSchema } from '../util/validate.js';
import { seal } from '../services/seal.js';
import { apercu } from '../services/apercu.js';
import { testConnection, syncAccount, closeTransport } from '../services/mailbridge.js';
import { enqueueMail } from '../services/outbox.js';
import { notifyUser } from '../ws.js';
import { PROVIDERS, isOAuthProvider, isConfigured, configuredProviders, signState, verifyState, buildAuthUrl, exchangeCode, extractEmail } from '../services/oauth.js';

// Lance une 1ʳᵉ synchro en arrière-plan puis prévient le client (succès OU échec) :
// la boîte se rafraîchit toute seule et l'erreur éventuelle (last_error) devient
// visible sans rechargement manuel.
function firstSync(userId, account) {
  syncAccount(account)
    .catch(() => {})
    .finally(() => { try { notifyUser(userId, { type: 'mail:ext', accountId: account.id }); } catch {} });
}

const router = Router();

// URI de redirection OAuth. DOIT correspondre EXACTEMENT à celle déclarée chez le
// fournisseur. En prod (derrière le tunnel), fixez COMET_BASE_URL pour la rendre
// déterministe ; sinon on la déduit de la requête (pratique en local/localhost).
const baseUrlFor = (req) => (process.env.COMET_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
const redirectUriFor = (req, provider) => `${baseUrlFor(req)}/api/accounts/oauth/${provider}/callback`;
const callbackPage = (title, msg, nonce) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui;background:#0b1020;color:#e6e9f5;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:420px;padding:24px">
<div style="font-size:40px">✦</div><h2>${title}</h2><p style="color:#9aa3c7">${msg}</p>
<p style="color:#6b7399;font-size:13px">Vous pouvez fermer cette fenêtre.</p></div>
<script nonce="${nonce}">try{window.opener&&window.opener.postMessage({comet:'oauth-done'},'*')}catch(e){}setTimeout(()=>window.close(),2500)</script>`;

// ── OAuth : RETOUR du fournisseur (navigation navigateur, donc PAS de bearer) ──
// Défini avant le verrou d'authentification : l'état signé porte l'utilisateur.
router.get('/oauth/:provider/callback', async (req, res) => {
  const provider = req.params.provider;
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  const nonce = res.locals.scriptNonce;
  if (req.query.error) return res.status(400).send(callbackPage('Connexion refusée', escapeHtml(req.query.error_description || req.query.error), nonce));
  const st = verifyState(String(req.query.state || ''));
  if (!st || st.provider !== provider || !isOAuthProvider(provider)) return res.status(400).send(callbackPage('Lien invalide', 'État de connexion expiré ou invalide.', nonce));
  try {
    const redirectUri = redirectUriFor(req, provider);
    const tok = await exchangeCode(provider, String(req.query.code || ''), redirectUri);
    if (!tok.refresh_token) throw new Error('Aucun jeton de rafraîchissement reçu (réautorisez en accordant l’accès hors-ligne).');
    const email = await extractEmail(provider, tok); // via id_token (pas d'appel ressource)
    const p = PROVIDERS[provider];
    const expiry = new Date(Date.now() + (Number(tok.expires_in) || 3600) * 1000).toISOString();
    const existing = db.prepare('SELECT id FROM mail_accounts WHERE user_id = ? AND email = ?').get(st.uid, email);
    if (existing) {
      db.prepare(`UPDATE mail_accounts SET provider = ?, oauth_refresh = ?, oauth_access = ?, oauth_expiry = ?, enabled = 1, last_error = NULL WHERE id = ?`)
        .run(provider, seal(tok.refresh_token), seal(tok.access_token), expiry, existing.id);
    } else {
      db.prepare(`INSERT INTO mail_accounts (user_id, email, label, imap_host, imap_port, smtp_host, smtp_port, username, sealed_pass, provider, oauth_refresh, oauth_access, oauth_expiry)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(st.uid, email, p.label, p.imapHost, p.imapPort, p.smtpHost, p.smtpPort, email, seal(''), provider, seal(tok.refresh_token), seal(tok.access_token), expiry);
    }
    const acct = db.prepare('SELECT * FROM mail_accounts WHERE user_id = ? AND email = ?').get(st.uid, email);
    firstSync(st.uid, acct); // 1ʳᵉ synchro en arrière-plan + notification client
    res.send(callbackPage('Compte connecté ✓', `${escapeHtml(email)} est maintenant relié à Comet via ${escapeHtml(p.label)}.`, nonce));
  } catch (e) {
    res.status(502).send(callbackPage('Connexion impossible', escapeHtml(e.message || e), nonce));
  }
});

router.use(authRequired);

// Quels fournisseurs OAuth sont prêts (client id/secret présents côté serveur)
router.get('/oauth/providers', (req, res) => res.json({ configured: configuredProviders() }));

// Démarrage du flux : renvoie l'URL de consentement (ouverte en popup côté client)
router.get('/oauth/:provider/start', (req, res) => {
  const provider = req.params.provider;
  if (!isOAuthProvider(provider)) return res.status(404).json({ error: 'Fournisseur inconnu' });
  if (!isConfigured(provider)) return res.status(400).json({ error: `OAuth ${PROVIDERS[provider].label} non configuré sur ce serveur` });
  const redirectUri = redirectUriFor(req, provider);
  const state = signState({ uid: req.user.id, provider, t: Date.now() });
  res.json({ url: buildAuthUrl(provider, { state, redirectUri }) });
});

function accountView(a) {
  const unread = db.prepare("SELECT COUNT(*) AS n FROM ext_messages WHERE account_id = ? AND folder = 'inbox' AND is_read = 0").get(a.id).n;
  return {
    id: a.id, email: a.email, label: a.label, enabled: !!a.enabled,
    imapHost: a.imap_host, imapPort: a.imap_port, smtpHost: a.smtp_host, smtpPort: a.smtp_port,
    username: a.username, lastSync: a.last_sync, lastError: a.last_error, unread,
    provider: a.provider || 'imap', oauth: a.provider && a.provider !== 'imap',
  };
}
const owned = (id, userId) => db.prepare('SELECT * FROM mail_accounts WHERE id = ? AND user_id = ?').get(id, userId);

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM mail_accounts WHERE user_id = ? ORDER BY id').all(req.user.id);
  res.json({ accounts: rows.map(accountView) });
});

router.post('/', validateBody(mailAccountSchema), async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const cfg = {
    email,
    username: String(b.username || email).trim(),
    password: String(b.password || ''),
    imapHost: String(b.imapHost || '').trim(), imapPort: Number(b.imapPort) || 993,
    smtpHost: String(b.smtpHost || '').trim(), smtpPort: Number(b.smtpPort) || 465,
  };
  if (!email || !cfg.password || !cfg.imapHost || !cfg.smtpHost) return res.status(400).json({ error: 'Champs requis manquants' });

  try { await testConnection(cfg); }
  catch (e) { return res.status(400).json({ error: 'Connexion impossible : ' + (e.message || 'identifiants invalides') }); }

  const info = db.prepare(`INSERT INTO mail_accounts (user_id, email, label, imap_host, imap_port, smtp_host, smtp_port, username, sealed_pass)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.user.id, email, String(b.label || '').slice(0, 60), cfg.imapHost, cfg.imapPort, cfg.smtpHost, cfg.smtpPort, cfg.username, seal(cfg.password));
  const account = db.prepare('SELECT * FROM mail_accounts WHERE id = ?').get(info.lastInsertRowid);
  firstSync(req.user.id, account); // 1ʳᵉ synchro en arrière-plan + notification client
  res.status(201).json({ account: accountView(account) });
});

router.delete('/:id', (req, res) => {
  const a = owned(req.params.id, req.user.id);
  if (!a) return res.status(404).json({ error: 'Compte introuvable' });
  db.prepare('DELETE FROM mail_accounts WHERE id = ?').run(a.id);
  closeTransport(a.id); // libère le transport SMTP poolé du compte supprimé
  res.json({ ok: true });
});

router.post('/:id/sync', async (req, res) => {
  const a = owned(req.params.id, req.user.id);
  if (!a) return res.status(404).json({ error: 'Compte introuvable' });
  try { const added = await syncAccount(a); res.json({ added }); }
  catch (e) { res.status(502).json({ error: 'Synchronisation impossible : ' + e.message }); }
});

router.get('/:id/messages', (req, res) => {
  const a = owned(req.params.id, req.user.id);
  if (!a) return res.status(404).json({ error: 'Compte introuvable' });
  const folder = req.query.folder === 'sent' ? 'sent' : 'inbox';
  // L'aperçu se tire du texte OU, à défaut, du HTML : une boîte IMAP reçoit surtout des
  // lettres d'information qui n'ont aucune version texte, et la liste affichait alors
  // « Aucun aperçu » sur chacune de leurs lignes.
  const rows = db.prepare(`SELECT id, direction, from_addr AS fromAddr, from_name AS fromName, to_addr AS toAddr,
    subject, date, is_read AS isRead, body_text AS bodyText, body_html AS bodyHtml
    FROM ext_messages WHERE account_id = ? AND folder = ? ORDER BY id DESC LIMIT 200`).all(a.id, folder);
  res.json({ messages: rows.map(({ bodyText, bodyHtml, ...m }) => ({
    ...m, isRead: !!m.isRead, snippet: apercu(bodyText, bodyHtml),
  })) });
});

router.get('/:id/messages/:mid', (req, res) => {
  const a = owned(req.params.id, req.user.id);
  if (!a) return res.status(404).json({ error: 'Compte introuvable' });
  const m = db.prepare('SELECT * FROM ext_messages WHERE id = ? AND account_id = ?').get(req.params.mid, a.id);
  if (!m) return res.status(404).json({ error: 'Message introuvable' });
  if (!m.is_read) db.prepare('UPDATE ext_messages SET is_read = 1 WHERE id = ?').run(m.id);
  res.json({ message: {
    id: m.id, direction: m.direction, fromAddr: m.from_addr, fromName: m.from_name, toAddr: m.to_addr,
    subject: m.subject, bodyText: m.body_text, bodyHtml: m.body_html, date: m.date, messageId: m.message_id,
  } });
});

router.post('/:id/send', (req, res) => {
  const a = owned(req.params.id, req.user.id);
  if (!a) return res.status(404).json({ error: 'Compte introuvable' });
  const { to, cc, subject, text, html, inReplyTo } = req.body || {};
  if (!to) return res.status(400).json({ error: 'Destinataire requis' });
  // Mise en file (outbox) : on rend la main tout de suite au lieu de bloquer la
  // requête pendant tout l'aller-retour SMTP. Le worker envoie en arrière-plan via
  // le transport poolé, retente en cas d'échec, et notifie par WebSocket (mail:sent).
  const outboxId = enqueueMail(a.id, req.user.id, { to, cc, subject, text, html, inReplyTo });
  res.status(202).json({ ok: true, queued: true, outboxId: Number(outboxId) });
});

export default router;
