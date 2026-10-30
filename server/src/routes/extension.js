import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db } from '../db.js';
import { authRequired } from '../auth.js';
import { zipStore } from '../services/zip.js';

const router = Router();
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');

// Expiration par inactivité : un jeton d'extension inutilisé depuis 90 jours est
// révoqué (rotation forcée — l'utilisateur ré-appaire). Limite la fenêtre d'abus
// d'un jeton oublié/volé.
const EXT_TOKEN_IDLE_MS = 90 * 24 * 60 * 60 * 1000;

// Authentification par jeton d'extension (opaque, haché en base)
function extAuth(req, res, next) {
  const tok = req.get('X-Ext-Token') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const h = tok ? sha(tok) : null;
  const row = h ? db.prepare('SELECT user_id, last_seen, created_at FROM extension_tokens WHERE token_hash = ?').get(h) : null;
  if (!row) return res.status(401).json({ error: "Jeton d'extension invalide", code: 'ext_token_invalid' });
  const ref = Date.parse(row.last_seen || row.created_at || '') || 0;
  if (ref && Date.now() - ref > EXT_TOKEN_IDLE_MS) {
    db.prepare('DELETE FROM extension_tokens WHERE token_hash = ?').run(h);
    return res.status(401).json({ error: "Jeton d'extension expiré, ré-appairez l'extension", code: 'ext_token_expired' });
  }
  db.prepare("UPDATE extension_tokens SET last_seen = datetime('now') WHERE token_hash = ?").run(h);
  req.extUserId = row.user_id;
  next();
}

// ── Appairage : l'extension échange un code contre un jeton + la clé publique ─
router.post('/redeem', (req, res) => {
  const code = String(req.body.code || '').trim().toLowerCase();
  const row = code ? db.prepare('SELECT * FROM extension_pairings WHERE code_hash = ?').get(sha(code)) : null;
  if (!row) return res.status(404).json({ error: 'Code invalide' });
  if (Date.parse(row.expires_at) < Date.now()) {
    db.prepare('DELETE FROM extension_pairings WHERE code_hash = ?').run(sha(code));
    return res.status(400).json({ error: 'Code expiré' });
  }
  const u = db.prepare('SELECT email, public_key FROM users WHERE id = ?').get(row.user_id);
  const token = `xt_${randomBytes(24).toString('base64url')}`;
  db.prepare('INSERT INTO extension_tokens (token_hash, user_id) VALUES (?, ?)').run(sha(token), row.user_id);
  db.prepare('DELETE FROM extension_pairings WHERE code_hash = ?').run(sha(code));
  res.json({ token, email: u.email, publicKey: u.public_key });
});

// ── Réception d'une capture (chiffrée vers la clé publique de l'utilisateur) ──
router.post('/push', extAuth, (req, res) => {
  const { ciphertext, iv, encKey, host } = req.body;
  if (!ciphertext || !iv || !encKey) return res.status(400).json({ error: 'Charge chiffrée manquante' });
  db.prepare('INSERT INTO vault_pending (user_id, ciphertext, iv, enc_key, host) VALUES (?, ?, ?, ?, ?)')
    .run(req.extUserId, ciphertext, iv, encKey, String(host || '').slice(0, 200));
  res.status(201).json({ ok: true });
});

// ── Routes de session (utilisateur connecté dans l'app) ──────────────────────
router.use(authRequired);

router.post('/pair-code', (req, res) => {
  const code = randomBytes(16).toString('hex'); // 128 bits (32 car. hex), à copier-coller
  db.prepare('DELETE FROM extension_pairings WHERE user_id = ?').run(req.user.id);
  db.prepare('INSERT INTO extension_pairings (code_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha(code), req.user.id, new Date(Date.now() + 10 * 60000).toISOString());
  res.json({ code, expiresInMin: 10 });
});

router.get('/pending/count', (req, res) => {
  res.json({ count: db.prepare('SELECT COUNT(*) AS n FROM vault_pending WHERE user_id = ?').get(req.user.id).n });
});

// Import « aveugle » : copie les entrées en attente vers le coffre sans déchiffrer
router.post('/import', (req, res) => {
  const rows = db.prepare('SELECT * FROM vault_pending WHERE user_id = ?').all(req.user.id);
  const ins = db.prepare('INSERT INTO vault_entries (owner_id, ciphertext, iv, enc_key) VALUES (?, ?, ?, ?)');
  const del = db.prepare('DELETE FROM vault_pending WHERE id = ?');
  let imported = 0;
  for (const r of rows) { ins.run(req.user.id, r.ciphertext, r.iv, r.enc_key); del.run(r.id); imported++; }
  res.json({ imported });
});

// Téléchargement de l'extension empaquetée (.zip)
router.get('/download', (req, res) => {
  try {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../extension');
    const files = readdirSync(dir).filter((n) => /\.(json|js|html|css|png)$/.test(n)).map((n) => ({ name: n, data: readFileSync(join(dir, n)) }));
    const zip = zipStore(files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="comet-extension.zip"');
    res.send(zip);
  } catch {
    res.status(404).json({ error: 'Extension introuvable' });
  }
});

export default router;
