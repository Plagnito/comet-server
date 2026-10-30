import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readdirSync, statSync, statfsSync, existsSync } from 'node:fs';
import { db } from '../db.js';

// Conserver le répertoire historique, même si la DB utilise COMET_DATA_DIR.
// Un déplacement du stockage exige un réglage explicite et une migration des fichiers.
export const BLOB_DIR = process.env.COMET_ATTACHMENTS_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'attachments');
mkdirSync(BLOB_DIR, { recursive: true });

function setting(name, fallback, minimum = 1) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name}: entier >= ${minimum} requis`);
  return value;
}

export const UPLOAD_LIMITS = {
  file: setting('COMET_UPLOAD_MAX_BYTES', 1024 ** 3),
  user: setting('COMET_UPLOAD_USER_QUOTA_BYTES', 5 * 1024 ** 3),
  total: setting('COMET_UPLOAD_TOTAL_QUOTA_BYTES', 20 * 1024 ** 3),
  timeout: setting('COMET_UPLOAD_TIMEOUT_MS', 10 * 60_000),
  activeUser: setting('COMET_UPLOAD_MAX_ACTIVE_PER_USER', 2),
  activeTotal: setting('COMET_UPLOAD_MAX_ACTIVE_TOTAL', 8),
  free: setting('COMET_UPLOAD_MIN_FREE_BYTES', 256 * 1024 ** 2, 0),
};

export const validTransferId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
export function storageError(status, message) { return Object.assign(new Error(message), { status }); }
export function blobPath(id) {
  if (!validTransferId(id)) throw storageError(400, 'Identifiant de transfert invalide');
  return join(BLOB_DIR, `${id}.bin`);
}
export function torrentPath(id) {
  blobPath(id);
  return join(BLOB_DIR, `${id}.torrent`);
}

// Réservations persistantes communes aux deux routes. BEGIN IMMEDIATE protège
// aussi les admissions concurrentes de plusieurs processus sur la même base.
db.exec(`CREATE TABLE IF NOT EXISTS attachment_storage (
  transfer_id TEXT PRIMARY KEY,
  sender_id INTEGER,
  size INTEGER NOT NULL CHECK(size >= 0),
  complete INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

// Les blobs historiques (dont le propriétaire E2EE est inconnu) et les anciens
// .part orphelins comptent dans le quota global. Ne jamais inventer un auteur.
for (const entry of readdirSync(BLOB_DIR, { withFileTypes: true })) {
  if (!entry.isFile() || !/\.(bin|part)$/.test(entry.name)) continue;
  const match = /^([A-Za-z0-9_-]{1,128})\.bin$/.exec(entry.name);
  const part = /^([A-Za-z0-9_-]{1,128})\.bin\.part$/.exec(entry.name);
  if (part && db.prepare('SELECT 1 FROM attachment_storage WHERE transfer_id = ? AND complete = 0').get(part[1])) continue;
  const id = match?.[1] || `orphan:${entry.name}`;
  const largeExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='large_transfers'").get();
  const owner = match && largeExists ? db.prepare('SELECT sender_id FROM large_transfers WHERE transfer_id = ?').get(id)?.sender_id : null;
  db.prepare('INSERT OR IGNORE INTO attachment_storage (transfer_id, sender_id, size, complete) VALUES (?, ?, ?, 1)')
    .run(id, owner ?? null, statSync(join(BLOB_DIR, entry.name)).size);
}

export function reserveTransfer(id, senderId, size) {
  blobPath(id); // validation avant toute requête ou opération disque
  if (!Number.isSafeInteger(size) || size <= 0) throw storageError(400, 'Taille invalide');
  if (size > UPLOAD_LIMITS.file) throw storageError(413, 'Fichier trop volumineux');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('SELECT 1 FROM attachment_storage WHERE transfer_id = ?').get(id)
      || db.prepare('SELECT 1 FROM attachments WHERE transfer_id = ?').get(id)
      || db.prepare('SELECT 1 FROM large_transfers WHERE transfer_id = ?').get(id)
      || existsSync(blobPath(id)) || existsSync(`${blobPath(id)}.part`) || existsSync(torrentPath(id))) {
      throw storageError(409, 'Identifiant de transfert déjà utilisé');
    }
    const usage = db.prepare(`SELECT COALESCE(SUM(size), 0) AS total,
      COALESCE(SUM(CASE WHEN sender_id = ? THEN size ELSE 0 END), 0) AS owner,
      COALESCE(SUM(CASE WHEN complete = 0 THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN complete = 0 AND sender_id = ? THEN 1 ELSE 0 END), 0) AS owner_active,
      COALESCE(SUM(CASE WHEN complete = 0 THEN size ELSE 0 END), 0) AS reserved
      FROM attachment_storage`).get(senderId, senderId);
    if (usage.active >= UPLOAD_LIMITS.activeTotal || usage.owner_active >= UPLOAD_LIMITS.activeUser) {
      throw storageError(429, 'Trop de téléversements simultanés');
    }
    if (size > UPLOAD_LIMITS.user - usage.owner || size > UPLOAD_LIMITS.total - usage.total) {
      throw storageError(413, 'Quota de stockage dépassé');
    }
    const disk = statfsSync(BLOB_DIR);
    if (disk.bavail * disk.bsize - usage.reserved - size < UPLOAD_LIMITS.free) {
      throw storageError(507, 'Espace disque disponible insuffisant');
    }
    db.prepare('INSERT INTO attachment_storage (transfer_id, sender_id, size) VALUES (?, ?, ?)').run(id, senderId, size);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function completeTransfer(id, size) {
  db.prepare('UPDATE attachment_storage SET size = ?, complete = 1 WHERE transfer_id = ?').run(size, id);
}
export function releaseTransfer(id) {
  // Un échec d'effacement ne doit jamais rendre le quota à nouveau disponible.
  if (existsSync(blobPath(id)) || existsSync(`${blobPath(id)}.part`) || existsSync(torrentPath(id))) return;
  // Un ID publié reste consommé, même après purge : les anciens liens de
  // capacité ne doivent pas pouvoir désigner le nouveau fichier d'un tiers.
  db.prepare('DELETE FROM attachment_storage WHERE transfer_id = ? AND complete = 0').run(id);
  db.prepare('UPDATE attachment_storage SET size = 0 WHERE transfer_id = ? AND complete = 1').run(id);
}
