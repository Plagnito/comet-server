// Clés du connecteur d'organisation : chacune a ses DROITS, une expiration possible, un
// journal d'utilisation, et se révoque seule. Autrefois, une clé unique ouvrait tout,
// dont l'export complet de l'instance (avec ce qui y est stocké en clair).
//
// Droits :
//   export      instantané de l'instance pour archivage (GET /api/connector/export)
//   visio       annonce des salons de visio prévus à l'agenda (POST /api/connector/process)
//   ia          file de l'assistant IA (GET /ai/pending, POST /ai/answer)
// La clé en clair (cmtk_…) n'est rendue qu'une fois, à sa création ; seul son hachage
// SHA-256 est gardé.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from '../db.js';

export const DROITS = [
  'export',
  'visio',
  'ia',
];

db.exec(`
  CREATE TABLE IF NOT EXISTS connector_keys (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    label         TEXT NOT NULL,
    key_hash      TEXT NOT NULL UNIQUE,
    scopes        TEXT NOT NULL DEFAULT '[]',
    created_by    INTEGER,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at    TEXT,
    last_used_at  TEXT,
    revoked_at    TEXT
  );
  CREATE TABLE IF NOT EXISTS connector_audit (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id  INTEGER NOT NULL,
    scope   TEXT NOT NULL,
    route   TEXT NOT NULL,
    ip      TEXT,
    at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_connector_audit_at ON connector_audit(at);
`);

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const egal = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const getS = (k) => db.prepare('SELECT v FROM settings WHERE k = ?').get(k)?.v ?? '';
const droitsDe = (ligne) => { try { const d = JSON.parse(ligne.scopes); return Array.isArray(d) ? d.filter((x) => DROITS.includes(x)) : []; } catch { return []; } };
const expiree = (ligne) => !!ligne.expires_at && Date.parse(ligne.expires_at) <= Date.now();

export const vue = (l) => ({
  id: l.id, label: l.label, droits: droitsDe(l), creeeLe: l.created_at, expireLe: l.expires_at || null,
  derniereUtilisation: l.last_used_at || null, revoqueeLe: l.revoked_at || null,
  active: !l.revoked_at && !expiree(l),
});

export function creerCle({ label, droits, expireLe = null, par = null }) {
  const propres = [...new Set((Array.isArray(droits) ? droits : []).filter((d) => DROITS.includes(d)))];
  if (!propres.length) throw Object.assign(new Error('Choisissez au moins un droit pour cette clé.'), { statut: 400 });
  let expiration = null;
  if (expireLe) {
    const t = Date.parse(expireLe);
    if (!Number.isFinite(t) || t <= Date.now()) throw Object.assign(new Error('Date d’expiration invalide ou passée.'), { statut: 400 });
    expiration = new Date(t).toISOString();
  }
  const cle = `cmtk_${randomBytes(24).toString('base64url')}`;
  const id = Number(db.prepare('INSERT INTO connector_keys (label, key_hash, scopes, created_by, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(String(label || 'Connecteur').trim().slice(0, 80) || 'Connecteur', sha(cle), JSON.stringify(propres), par, expiration).lastInsertRowid);
  return { cle, ligne: vue(db.prepare('SELECT * FROM connector_keys WHERE id = ?').get(id)) };
}

// Rend { ok: true, cle } ou { ok: false, raison } (clé inconnue, révoquée, expirée).
export function verifierCle(claire) {
  if (typeof claire !== 'string' || !claire.startsWith('cmtk_') || claire.length > 200) return { ok: false, raison: 'Clé de connecteur invalide' };
  const h = sha(claire);
  const ligne = db.prepare('SELECT * FROM connector_keys WHERE key_hash = ?').get(h);
  if (!ligne || !egal(ligne.key_hash, h)) return { ok: false, raison: 'Clé de connecteur invalide' };
  if (ligne.revoked_at) return { ok: false, raison: 'Clé de connecteur révoquée' };
  if (expiree(ligne)) return { ok: false, raison: 'Clé de connecteur expirée' };
  return { ok: true, cle: { id: ligne.id, label: ligne.label, droits: droitsDe(ligne) } };
}

let ecritures = 0;
export function journaliser(keyId, scope, route, ip) {
  db.prepare("UPDATE connector_keys SET last_used_at = datetime('now') WHERE id = ?").run(keyId);
  db.prepare('INSERT INTO connector_audit (key_id, scope, route, ip) VALUES (?, ?, ?, ?)').run(keyId, scope, String(route).slice(0, 120), ip ? String(ip).slice(0, 64) : null);
  // Le connecteur passe toutes les minutes : on ne garde que 30 jours de journal.
  if (++ecritures % 200 === 0) db.prepare("DELETE FROM connector_audit WHERE at < datetime('now', '-30 days')").run();
}

export const listerCles = () => db.prepare('SELECT * FROM connector_keys ORDER BY revoked_at IS NOT NULL, id DESC').all().map(vue);
export const revoquerCle = (id) => db.prepare("UPDATE connector_keys SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL").run(Number(id)).changes;
export const revoquerToutes = () => db.prepare("UPDATE connector_keys SET revoked_at = datetime('now') WHERE revoked_at IS NULL").run().changes;
export const journal = (limite = 200) => db.prepare(
  `SELECT a.id, a.key_id AS cleId, k.label AS cle, a.scope AS droit, a.route, a.ip, a.at
   FROM connector_audit a LEFT JOIN connector_keys k ON k.id = a.key_id ORDER BY a.id DESC LIMIT ?`,
).all(Math.min(Math.max(Number(limite) || 200, 1), 500));

// Une clé active (non révoquée, non expirée), avec ce droit si on le précise.
export function cleActive(droit = null) {
  return db.prepare('SELECT * FROM connector_keys WHERE revoked_at IS NULL').all()
    .some((l) => !expiree(l) && (!droit || droitsDe(l).includes(droit)));
}

// ── Reprise de l'ancienne clé unique ───────────────────────────────────────────
// Le connecteur déjà installé garde sa clé : elle devient « Clé d'origine », avec TOUS
// les droits qu'elle avait. Une seule fois (marqueur en base) : révoquée ensuite par un
// administrateur, elle ne revient pas au démarrage suivant.
export const MIGRATION_CLES = 'migr_connector_keys';
export function reprendreAncienneCle() {
  if (getS(MIGRATION_CLES)) return 0;
  const ancien = getS('connector_key_hash');
  let reprises = 0;
  if (ancien && !db.prepare('SELECT 1 FROM connector_keys WHERE key_hash = ?').get(ancien)) {
    db.prepare("INSERT INTO connector_keys (label, key_hash, scopes) VALUES ('Clé d''origine', ?, ?)").run(ancien, JSON.stringify(DROITS));
    reprises = 1;
  }
  db.prepare("DELETE FROM settings WHERE k = 'connector_key_hash'").run();
  db.prepare("INSERT INTO settings (k, v) VALUES (?, datetime('now')) ON CONFLICT(k) DO NOTHING").run(MIGRATION_CLES);
  return reprises;
}
reprendreAncienneCle();
