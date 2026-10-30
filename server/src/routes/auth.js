import { Router } from 'express';
import { db, SYSTEM_EMAIL } from '../db.js';
import { hashPassword, verifyPassword, signToken, signTmpToken, verifyTmpToken, publicUser, authRequired } from '../auth.js';
import { assertStrongPassword } from '../util/password.js';
import { validateBody, registerSchema, loginSchema } from '../util/validate.js';
import { deliverMessage } from '../services/mail.js';
import { generateSecret, verifyTotp, otpauthUri, generateRecoveryCodes } from '../services/totp.js';
import { INSCRIPTION_OUVERTE, BOOTSTRAP_TOKEN } from '../config.js';
import { matchesBootstrapToken } from '../util/bootstrap.js';

const router = Router();
// Migration : conserver les administrateurs déjà présents sans rouvrir le setup.
db.prepare("INSERT OR IGNORE INTO settings (k, v) SELECT 'bootstrap_complete', '1' WHERE EXISTS (SELECT 1 FROM users WHERE is_admin = 1)").run();
const bootstrapComplete = () => db.prepare("SELECT v FROM settings WHERE k = 'bootstrap_complete'").get()?.v === '1';

const COLORS = ['#4f46e5', '#db2777', '#0d9488', '#ea580c', '#7c3aed', '#2563eb', '#c026d3', '#16a34a'];
const pickColor = () => COLORS[Math.floor(Math.random() * COLORS.length)];

function normalizeEmail(raw) {
  let email = String(raw || '').trim().toLowerCase();
  if (!email) return null;
  if (!email.includes('@')) email = `${email}@comet.mail`;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
  return email;
}

// Réponse d'authentification : crée une session, puis renvoie jeton + profil + clé privée enveloppée
function authPayload(user, req, res) {
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  const ip = req.ip || req.socket?.remoteAddress || '';
  const sid = db.prepare('INSERT INTO sessions (user_id, user_agent, ip) VALUES (?, ?, ?)').run(user.id, ua, ip).lastInsertRowid;
  return {
    token: signToken(user, sid),
    user: publicUser(user),
    encPrivateKey: user.enc_private_key || null,
  };
}

// Ce que la page de connexion doit proposer, AVANT toute session.
router.get('/options', (req, res) => {
  const bootstrapRequired = !bootstrapComplete();
  res.json({ inscription: INSCRIPTION_OUVERTE || bootstrapRequired, bootstrapRequired });
});

const inscriptionFermee = (req, res, next) => (INSCRIPTION_OUVERTE || !bootstrapComplete() ? next()
  : res.status(403).json({ error: 'Les inscriptions sont fermées sur ce serveur.', code: 'inscription_fermee' }));

router.post('/register', inscriptionFermee, validateBody(registerSchema), (req, res) => {
  const authorizedSetup = matchesBootstrapToken(req.body.bootstrapToken, BOOTSTRAP_TOKEN);
  if (!bootstrapComplete() && !authorizedSetup) {
    return res.status(403).json({ error: "Code d'installation requis pour créer le premier administrateur.", code: 'bootstrap_required' });
  }
  const email = normalizeEmail(req.body.email);
  const displayName = String(req.body.displayName || '').trim();
  const password = String(req.body.password || '');
  const publicKey = req.body.publicKey || null;       // SPKI base64 (généré côté client)
  const encPrivateKey = req.body.encPrivateKey || null; // JSON {salt,iv,data} enveloppé par le mot de passe

  if (!email) return res.status(400).json({ error: 'Adresse e-mail invalide' });
  if (displayName.length < 2) return res.status(400).json({ error: 'Nom trop court' });
  // Politique de mot de passe (≥ 10 car. + score zxcvbn) ; lève une AppError typée
  // captée par le middleware d'erreurs central → { error, code: 'weak_password' }.
  assertStrongPassword(password, [email, displayName]);

  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'Cette adresse est déjà utilisée' });
  }

  const passwordHash = hashPassword(password);
  let info;
  db.exec('BEGIN IMMEDIATE');
  try {
    const first = !bootstrapComplete();
    if ((first && !authorizedSetup) || (!first && !INSCRIPTION_OUVERTE)) {
      db.exec('ROLLBACK');
      return res.status(403).json({ error: 'Création de compte non autorisée' });
    }
    info = db.prepare('INSERT INTO users (email, display_name, password_hash, avatar_color, public_key, enc_private_key, listed, is_admin) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
      .run(email, displayName, passwordHash, pickColor(), publicKey, encPrivateKey, first ? 1 : 0);
    if (first) db.prepare("INSERT INTO settings (k, v) VALUES ('bootstrap_complete', '1') ON CONFLICT(k) DO UPDATE SET v = '1'").run();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    if (error.errcode === 2067 || error.code?.startsWith('ERR_SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'Cette adresse est déjà utilisée' });
    throw error;
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);

  // Mail de bienvenue (non chiffré : message système informatif)
  try {
    const system = db.prepare('SELECT id FROM users WHERE email = ?').get(SYSTEM_EMAIL);
    if (system) {
      deliverMessage({
        senderId: system.id,
        to: [user.id],
        subject: 'Bienvenue sur Comet',
        body:
          `Bonjour ${displayName},

` +
          `Bienvenue sur Comet. Votre adresse ${email} est utilisable uniquement au sein de l'application.

` +
          `Vos messages entre membres sont chiffrés de bout en bout : le serveur ne peut pas les lire.

` +
          `L'équipe Comet`,
        copyToSender: false,
      });
    }
  } catch (e) {
    console.error('welcome mail failed:', e.message);
  }

  res.status(201).json(authPayload(user, req, res));
});

router.post('/login', validateBody(loginSchema), (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  if (!email) return res.status(400).json({ error: 'Adresse e-mail invalide' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  // Un correspondant d'un AUTRE serveur Comet est une ligne `users` sans mot de passe :
  // jamais de connexion, même si un hash venait à y être écrit.
  if (!user || user.distant_domaine || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Identifiants incorrects' });
  }
  if (user.totp_enabled) {
    return res.json({ twoFactorRequired: true, tmpToken: signTmpToken(user) });
  }
  res.json(authPayload(user, req, res));
});

// Seconde étape : vérification du code 2FA (ou code de récupération)
router.post('/2fa/verify', (req, res) => {
  const payload = verifyTmpToken(req.body.tmpToken);
  if (!payload) return res.status(401).json({ error: 'Session de connexion expirée' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
  if (!user || !user.totp_enabled) return res.status(401).json({ error: 'Session invalide' });

  const code = String(req.body.code || '').trim();
  if (verifyTotp(user.totp_secret, code)) return res.json(authPayload(user, req, res));

  // Tentative par code de récupération (à usage unique)
  const codes = JSON.parse(user.recovery_codes || '[]');
  const idx = codes.findIndex((h) => verifyPassword(code.toUpperCase(), h));
  if (idx !== -1) {
    codes.splice(idx, 1);
    db.prepare('UPDATE users SET recovery_codes = ? WHERE id = ?').run(JSON.stringify(codes), user.id);
    return res.json(authPayload(user, req, res));
  }
  res.status(401).json({ error: 'Code incorrect' });
});

router.get('/me', authRequired, (req, res) => {
  res.json({ user: publicUser(req.user), encPrivateKey: req.user.enc_private_key || null });
});

// Définit un mot de passe Comet. Pour un compte sans mot de passe choisi (password_set=0) on
// N'EXIGE PAS l'ancien (l'utilisateur ne le connaît pas) ; sinon on le vérifie. Une
// fois posé, l'utilisateur peut aussi se connecter par e-mail/mot de passe, et le
// front provisionne ses clés E2EE (wrap avec ce mot de passe).
router.post('/set-password', authRequired, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const newPassword = String(req.body.newPassword || '');
  if (user.password_set) {
    if (!verifyPassword(String(req.body.oldPassword || ''), user.password_hash)) {
      return res.status(400).json({ error: 'Mot de passe actuel incorrect' });
    }
  }
  assertStrongPassword(newPassword, [user.email, user.display_name]);
  db.prepare('UPDATE users SET password_hash = ?, password_set = 1 WHERE id = ?').run(hashPassword(newPassword), user.id);
  res.json({ ok: true, user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
});

// Réinitialisation DESTRUCTIVE du mot de passe Comet (E2EE). À utiliser quand
// l'utilisateur a OUBLIÉ son mot de passe Comet : sa clé privée RSA est enveloppée par
// ce mot de passe (cf. client/src/crypto.js) → sans lui, IMPOSSIBLE de la déchiffrer,
// donc impossible de re-sceller ses mails. On repart d'une clé NEUVE (fournie par le
// client, scellée avec le nouveau mot de passe) ; du coup TOUS les mails existants
// (leur clé AES est enveloppée pour l'ANCIENNE clé publique) deviennent illisibles →
// on PURGE la boîte de l'utilisateur. Irréversible : gardé derrière une confirmation
// explicite (confirm === true) côté serveur ET côté client. On NE touche PAS aux mails
// des autres : seules les vues personnelles de CET utilisateur sont supprimées ; les
// lignes `messages` partagées restent lisibles pour les autres destinataires (leur
// propre clé). C'est le mot de passe
// de CHIFFREMENT Comet qu'on réinitialise, distinct de l'identifiant de connexion.
router.post('/reset-password', authRequired, (req, res) => {
  const { newPassword, publicKey, encPrivateKey } = req.body || {};
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: 'Confirmation explicite requise (opération destructive).', code: 'confirm_required' });
  }
  if (!publicKey || !encPrivateKey) {
    return res.status(400).json({ error: 'Nouvelle clé de chiffrement manquante.', code: 'keys_missing' });
  }
  assertStrongPassword(String(newPassword || ''), [req.user.email, req.user.display_name]);

  const uid = req.user.id;
  let purged = 0;
  db.exec('BEGIN');
  try {
    // Purge la boîte de CET utilisateur : ses copies (inbox/envoyés/brouillons/archive/
    // corbeille), ses clés de message enveloppées (inutilisables sans l'ancienne clé),
    // ses lignes destinataire et ses pièces jointes hors-ligne. On NE supprime PAS les
    // lignes `messages` (partagées) → les autres destinataires gardent leur copie.
    purged = db.prepare('DELETE FROM mail_items WHERE user_id = ?').run(uid).changes;
    db.prepare('DELETE FROM message_keys WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM recipients WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM attachments WHERE recipient_id = ?').run(uid);
    // Nouvelle identité de chiffrement + nouveau mot de passe (déjà scellé côté client).
    db.prepare('UPDATE users SET password_hash = ?, password_set = 1, public_key = ?, enc_private_key = ? WHERE id = ?')
      .run(hashPassword(String(newPassword)), publicKey, encPrivateKey, uid);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('[reset-password] échec pour #' + uid + ':', e);
    return res.status(500).json({ error: 'Réinitialisation impossible.', code: 'reset_failed' });
  }
  // Journalisation (jamais silencieux) : une réinitialisation détruit du courrier.
  console.warn(`[reset-password] user #${uid} <${req.user.email}> a réinitialisé son mot de passe Comet — boîte purgée (${purged} éléments), clé E2EE régénérée.`);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  res.json({ ok: true, purged, user: publicUser(u) });
});

// ── Configuration 2FA ───────────────────────────────────────────────────────
router.post('/2fa/setup', authRequired, (req, res) => {
  const secret = generateSecret();
  db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').run(secret, req.user.id);
  res.json({ secret, otpauth: otpauthUri(secret, req.user.email) });
});

router.post('/2fa/enable', authRequired, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user.totp_secret) return res.status(400).json({ error: 'Lancez d\'abord la configuration' });
  if (!verifyTotp(user.totp_secret, req.body.code)) return res.status(400).json({ error: 'Code incorrect' });

  const recovery = generateRecoveryCodes();
  const hashed = JSON.stringify(recovery.map((c) => hashPassword(c)));
  db.prepare('UPDATE users SET totp_enabled = 1, recovery_codes = ? WHERE id = ?').run(hashed, user.id);
  res.json({ ok: true, recoveryCodes: recovery });
});

router.post('/2fa/disable', authRequired, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const code = String(req.body.code || '').trim();
  const okCode = user.totp_enabled && verifyTotp(user.totp_secret, code);
  const okPw = verifyPassword(String(req.body.password || ''), user.password_hash);
  if (!okCode && !okPw) return res.status(400).json({ error: 'Code ou mot de passe requis' });
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL WHERE id = ?').run(user.id);
  res.json({ ok: true });
});

// Provisionnement paresseux des clés E2EE (comptes de démo / existants sans clés)
router.post('/keys', authRequired, (req, res) => {
  const { publicKey, encPrivateKey } = req.body;
  if (!publicKey || !encPrivateKey) return res.status(400).json({ error: 'Clés manquantes' });
  if (req.user.public_key) return res.status(409).json({ error: 'Clés déjà définies' });
  db.prepare('UPDATE users SET public_key = ?, enc_private_key = ? WHERE id = ?').run(publicKey, encPrivateKey, req.user.id);
  res.json({ ok: true });
});

// Profil (signature professionnelle)
router.patch('/profile', authRequired, (req, res) => {
  if (typeof req.body.signature === 'string') {
    db.prepare('UPDATE users SET signature = ? WHERE id = ?').run(req.body.signature.slice(0, 2000), req.user.id);
  }
  if (req.body.away && typeof req.body.away === 'object') {
    const a = req.body.away;
    db.prepare('UPDATE users SET away_enabled = ?, away_message = ?, away_until = ? WHERE id = ?')
      .run(a.enabled ? 1 : 0, String(a.message || '').slice(0, 1000), a.until || null, req.user.id);
  }
  if (['available', 'busy', 'away'].includes(req.body.presence)) {
    db.prepare('UPDATE users SET presence = ? WHERE id = ?').run(req.body.presence, req.user.id);
  }
  if (typeof req.body.jobTitle === 'string') db.prepare('UPDATE users SET job_title = ? WHERE id = ?').run(req.body.jobTitle.slice(0, 100), req.user.id);
  if (typeof req.body.department === 'string') db.prepare('UPDATE users SET department = ? WHERE id = ?').run(req.body.department.slice(0, 100), req.user.id);
  if (typeof req.body.listed === 'boolean') db.prepare('UPDATE users SET listed = ? WHERE id = ?').run(req.body.listed ? 1 : 0, req.user.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(u) });
});

// ── Sessions / appareils connectés ──────────────────────────────────────────
router.get('/sessions', authRequired, (req, res) => {
  const rows = db.prepare('SELECT id, user_agent, ip, created_at, last_seen FROM sessions WHERE user_id = ? ORDER BY last_seen DESC').all(req.user.id);
  res.json({
    sessions: rows.map((s) => ({
      id: s.id, userAgent: s.user_agent, ip: s.ip, createdAt: s.created_at, lastSeen: s.last_seen,
      current: s.id === req.sessionId,
    })),
  });
});

router.delete('/sessions/:id', authRequired, (req, res) => {
  const info = db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Session introuvable' });
  res.json({ ok: true });
});

router.post('/sessions/revoke-others', authRequired, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(req.user.id, req.sessionId || 0);
  res.json({ ok: true });
});

export default router;
