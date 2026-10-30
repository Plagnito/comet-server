import { Router } from 'express';
import {
  writeFileSync, existsSync, readFileSync, unlinkSync,
  statSync, createReadStream, createWriteStream, linkSync,
} from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db } from '../db.js';
import { authRequired } from '../auth.js';
import { createWebSeedTorrentFromFile } from '../services/torrent.js';
import { blobPath, torrentPath, validTransferId, UPLOAD_LIMITS, reserveTransfer, completeTransfer, releaseTransfer, storageError } from '../services/attachment-storage.js';

const router = Router();
router.use((req, res, next) => {
  // Refuser les alias sur toutes les routes, sans retirer de caractères.
  const id = req.path.split('/')[1]?.replace(/\.torrent$/, '');
  let decoded;
  try { decoded = decodeURIComponent(id || ''); } catch { return res.status(400).json({ error: 'Identifiant invalide' }); }
  if (decoded && !validTransferId(decoded)) return res.status(400).json({ error: 'Identifiant invalide' });
  next();
});

// Base publique ABSOLUE (mêmes règles que le reste du serveur) : les URL du torrent
// et du web-seed DOIVENT être joignables par un client BitTorrent/HTTP, sans auth.
const baseUrlFor = (req) => (process.env.COMET_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

// Registre des « transferts volumineux » : fichiers > 50 Mo hébergés NON chiffrés sur le
// serveur (le web-seed sert un fichier UTILISABLE). Isolé du flux E2EE : table dédiée,
// nettoyée par rétention (durée) et/ou nombre max de téléchargements directs.
db.exec(`
  CREATE TABLE IF NOT EXISTS large_transfers (
    transfer_id   TEXT PRIMARY KEY,
    filename      TEXT NOT NULL DEFAULT '',
    mimetype      TEXT NOT NULL DEFAULT 'application/octet-stream',
    size          INTEGER NOT NULL DEFAULT 0,
    sender_id     INTEGER,
    info_hash     TEXT,
    expires_at    TEXT,                          -- NULL = pas d'expiration temporelle
    max_downloads INTEGER NOT NULL DEFAULT 0,    -- 0 = illimité
    downloads     INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// « now + N jours » au format de SQLite ('YYYY-MM-DD HH:MM:SS', UTC) → comparable
// lexicographiquement à datetime('now'). NULL si pas de rétention temporelle.
const expiryFor = (days) => (days > 0 ? new Date(Date.now() + days * 86400000).toISOString().slice(0, 19).replace('T', ' ') : null);
const cdFilename = (name) => String(name || 'fichier').replace(/["\r\n]/g, '');

function purgeLarge(transferId) {
  try { db.prepare('DELETE FROM large_transfers WHERE transfer_id = ?').run(transferId); } catch {}
  try { unlinkSync(blobPath(transferId)); } catch {}
  try { unlinkSync(torrentPath(transferId)); } catch {}
  releaseTransfer(transferId);
}

// Comptabilise un téléchargement DIRECT complet (réponse 200) ; applique le plafond.
// Le trafic torrent (requêtes Range) n'est PAS compté (voir streamBlob).
function countDownload(transferId) {
  try {
    const row = db.prepare('UPDATE large_transfers SET downloads = downloads + 1 WHERE transfer_id = ? RETURNING downloads, max_downloads').get(transferId);
    if (!row) return;
    if (row.max_downloads > 0 && row.downloads >= row.max_downloads) purgeLarge(transferId);
  } catch {}
}

// Sert un blob depuis le disque en STREAM, avec support des requêtes Range (206).
// Range = trafic pièce-à-pièce (torrent) → jamais compté. Réponse 200 complète =
// téléchargement direct → nom de fichier + comptage (si `count`).
function streamBlob(req, res, { path, filename, mimetype, count, transferId }) {
  const total = statSync(path).size;
  res.setHeader('Content-Type', mimetype || 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  // Content-Disposition: attachment sur TOUTES les réponses (206 Range COMPRISE) : le mimetype est
  // contrôlé par l'expéditeur ; sans « attachment », un blob text/html servi sur une requête Range
  // s'ouvrirait INLINE dans le navigateur (XSS). Auparavant posé seulement sur la réponse 200.
  if (filename) res.setHeader('Content-Disposition', `attachment; filename="${cdFilename(filename)}"`);

  const range = req.headers.range;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (m) {
    let start = m[1] === '' ? null : Number(m[1]);
    let end = m[2] === '' ? total - 1 : Number(m[2]);
    if (start === null) { start = total - end; end = total - 1; } // suffixe « bytes=-N »
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0 || end >= total) {
      res.setHeader('Content-Range', `bytes */${total}`);
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', end - start + 1);
    return createReadStream(path, { start, end }).pipe(res);
  }

  res.setHeader('Content-Length', total); // Content-Disposition déjà posé plus haut (206 comprise)
  createReadStream(path).pipe(res);
  if (count && transferId) res.on('close', () => { if (res.writableFinished) countDownload(transferId); });
}

// Purge des transferts volumineux expirés (rétention). Appelée périodiquement.
export function sweepLargeTransfers() {
  try {
    const rows = db.prepare("SELECT transfer_id FROM large_transfers WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')").all();
    for (const r of rows) purgeLarge(r.transfer_id);
    return rows.length;
  } catch { return 0; }
}

function emailToId(raw) {
  let e = String(raw || '').trim().toLowerCase();
  if (!e) return null;
  if (!e.includes('@')) e = `${e}@comet.mail`;
  return db.prepare('SELECT id FROM users WHERE email = ?').get(e)?.id || null;
}

// Les deux flux partagent l'admission, les réservations et le même espace disque.
// Même un client chunked sans taille annoncée ne peut contourner la borne réelle.
async function receiveUpload(req, res, transferId, maxBytes, prepare) {
  const finalPath = blobPath(transferId);
  const partPath = `${finalPath}.part`;
  let reserved = false; let partOwned = false; let finalOwned = false; let torrentOwned = false;
  let transaction = false; let committed = false; let size = 0;
  const controller = new AbortController();
  const abort = () => controller.abort(storageError(400, 'Téléversement interrompu'));
  const responseClosed = () => { if (!res.writableFinished) abort(); };
  const timer = setTimeout(() => controller.abort(storageError(408, 'Délai de téléversement dépassé')), UPLOAD_LIMITS.timeout);
  timer.unref();
  req.once('aborted', abort); req.once('error', abort); res.once('close', responseClosed);
  let counter;
  try {
    if (req.readableEnded) throw storageError(400, 'Corps binaire brut requis');
    const announced = req.get('Content-Length');
    const budget = announced === undefined ? maxBytes : Number(announced);
    if (budget > maxBytes) throw storageError(413, 'Fichier trop volumineux');
    reserveTransfer(transferId, req.user.id, budget); reserved = true;
    counter = new Transform({ transform(chunk, encoding, callback) {
      size += chunk.length;
      callback(size > maxBytes || size > budget ? storageError(413, 'Fichier trop volumineux') : null, chunk);
    } });
    const ws = createWriteStream(partPath, { flags: 'wx' });
    ws.once('open', () => { partOwned = true; });
    req.pipe(counter);
    // req reste hors du pipeline : répondre 413 avant de fermer la connexion.
    await pipeline(counter, ws, { signal: controller.signal });
    if (!size) throw storageError(400, 'Fichier vide');
    controller.signal.throwIfAborted();
    const prepared = await prepare(partPath, size);
    controller.signal.throwIfAborted();
    linkSync(partPath, finalPath); finalOwned = true;
    if (prepared.torrent) {
      writeFileSync(torrentPath(transferId), prepared.torrent, { flag: 'wx' }); torrentOwned = true;
    }
    unlinkSync(partPath); partOwned = false;
    db.exec('BEGIN IMMEDIATE'); transaction = true;
    prepared.commit();
    completeTransfer(transferId, size);
    db.exec('COMMIT'); transaction = false; committed = true;
    res.status(201).json(prepared.response);
  } catch (error) {
    if (transaction) db.exec('ROLLBACK');
    if (counter) req.unpipe(counter);
    req.resume();
    if (!committed) {
      if (partOwned) { try { unlinkSync(partPath); } catch {} }
      if (finalOwned) { try { unlinkSync(finalPath); } catch {} }
      if (torrentOwned) { try { unlinkSync(torrentPath(transferId)); } catch {} }
      if (reserved) releaseTransfer(transferId);
    }
    const cause = controller.signal.aborted ? controller.signal.reason : error;
    if (!req.aborted && !res.destroyed && !res.headersSent) {
      // Après un refus, fermer une fois la réponse envoyée au lieu de drainer
      // indéfiniment le corps d'un client qui continue de téléverser.
      res.setHeader('Connection', 'close');
      res.status(cause.status || (cause.code === 'EEXIST' ? 409 : 500)).json({ error: cause.status ? cause.message : 'Dépôt impossible' });
    }
  } finally {
    clearTimeout(timer);
    if (counter) req.unpipe(counter);
    req.off('aborted', abort); req.off('error', abort); res.off('close', responseClosed);
  }
}

// ── Dépôt E2EE (≤ 50 Mo) : le ciphertext (opaque) est envoyé en corps binaire brut ──
// Repli serveur des pièces jointes chiffrées, réservé aux destinataires, usage unique.
router.post('/', authRequired, async (req, res) => {
  const transferId = req.get('X-Transfer-Id');
  const iv = String(req.get('X-IV') || '').trim();
  let filename = 'fichier';
  try { filename = decodeURIComponent(req.get('X-Filename') || '').slice(0, 255) || 'fichier'; } catch {}
  const mimetype = String(req.get('X-Mimetype') || 'application/octet-stream').slice(0, 120);
  const size = Number(req.get('X-Size') || 0);
  const to = String(req.get('X-To') || '').split(',').map((x) => x.trim()).filter(Boolean);
  const recipients = [...new Set(to.map(emailToId).filter(Boolean))];
  if (!validTransferId(transferId) || !iv || !recipients.length
    || !Number.isSafeInteger(size) || size < 0) return res.status(400).json({ error: 'Dépôt invalide' });
  await receiveUpload(req, res, transferId, Math.min(80 * 1024 ** 2, UPLOAD_LIMITS.file), async () => ({
    response: { ok: true, stored: recipients.length },
    commit() {
      const ins = db.prepare('INSERT INTO attachments (transfer_id, recipient_id, filename, mimetype, size, iv) VALUES (?, ?, ?, ?, ?, ?)');
      for (const id of recipients) ins.run(transferId, id, filename, mimetype, size, iv);
    },
  }));
});

// ── Dépôt VOLUMINEUX (> 50 Mo), NON chiffré, en STREAM vers le disque ───────────
// Aucun analyseur de corps (octet-stream) → req est un flux brut borné en octets
// et en durée, sans X-IV. Création exclusive .part, puis publication sans écrasement.
// le .torrent web-seed EN STREAMANT le fichier (jamais tout en RAM). Décidé par le
// produit : les fichiers volumineux ne sont PAS E2EE (web-seed = fichier utilisable).
router.post('/large', authRequired, async (req, res) => {
  const transferId = req.get('X-Transfer-Id');
  if (!validTransferId(transferId)) return res.status(400).json({ error: 'Transfert invalide' });
  let filename = 'fichier';
  try { filename = decodeURIComponent(req.get('X-Filename') || '').slice(0, 255) || 'fichier'; } catch {}
  const mimetype = String(req.get('X-Mimetype') || 'application/octet-stream').slice(0, 120);
  const retentionDays = Math.max(0, Number(req.get('X-Retention-Days') || 7) || 0);
  const maxDownloads = Math.max(0, Number(req.get('X-Max-Downloads') || 0) || 0);

  await receiveUpload(req, res, transferId, UPLOAD_LIMITS.file, async (partPath, size) => {
      const base = baseUrlFor(req);
      const webSeedUrl = `${base}/api/attachments/${encodeURIComponent(transferId)}/webseed`;
      const torrentUrl = `${base}/api/attachments/${encodeURIComponent(transferId)}.torrent`;
      const { torrent: bytes, infoHash } = await createWebSeedTorrentFromFile(partPath, { name: filename, webSeedUrl });
      return {
        torrent: bytes,
        response: { ok: true, torrent: { url: torrentUrl, webSeed: webSeedUrl, infoHash } },
        commit() {
          db.prepare(`INSERT INTO large_transfers (transfer_id, filename, mimetype, size, sender_id, info_hash, expires_at, max_downloads)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(transferId, filename, mimetype, size, req.user.id, infoHash, expiryFor(retentionDays), maxDownloads);
        },
      };
  });
});

// ── Rétention : régler durée de conservation / nb max de téléchargements ────────
// Réutilise les valeurs du panneau « torrent » du compositeur (retentionDays / maxDownloads).
router.post('/config', authRequired, (req, res) => {
  const transferId = req.body?.transferId;
  if (!validTransferId(transferId)) return res.status(400).json({ error: 'Transfert invalide' });
  const row = db.prepare('SELECT sender_id FROM large_transfers WHERE transfer_id = ?').get(transferId);
  if (!row) return res.status(404).json({ error: 'Transfert inconnu' });
  if (row.sender_id !== req.user.id) return res.status(403).json({ error: 'Non autorisé' });
  const retentionDays = Math.max(0, Number(req.body?.retentionDays ?? 7) || 0);
  const maxDownloads = Math.max(0, Number(req.body?.maxDownloads ?? 0) || 0);
  const expiresAt = expiryFor(retentionDays);
  db.prepare('UPDATE large_transfers SET expires_at = ?, max_downloads = ? WHERE transfer_id = ?').run(expiresAt, maxDownloads, transferId);
  res.json({ ok: true, expiresAt, maxDownloads, downloadLimitScope: 'full-responses-only' });
});

// ── Web-seed & .torrent : PUBLICS (aucune auth) ─────────────────────────────
// Un client BitTorrent télécharge le .torrent puis les données via HTTP sans pouvoir
// s'authentifier ; le transferId (UUID, ~122 bits) sert de capacité. Actives UNIQUEMENT
// pour un blob volumineux qui a un .torrent, et ne purgent jamais par accès (le web-seed
// doit rester disponible pendant la fenêtre de rétention). La route authentifiée
// GET /:transferId (repli chiffré du destinataire, usage unique) reste inchangée.

// Le fichier .torrent lui-même.
router.get(/^\/([A-Za-z0-9_-]+)\.torrent$/, (req, res) => {
  const id = req.params[0];
  const row = db.prepare("SELECT 1 FROM large_transfers WHERE transfer_id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))").get(id);
  if (!row) return res.status(404).json({ error: 'Torrent indisponible' });
  const tp = torrentPath(id);
  if (!existsSync(tp)) return res.status(404).json({ error: 'Torrent indisponible' });
  res.setHeader('Content-Type', 'application/x-bittorrent');
  res.setHeader('Content-Disposition', `attachment; filename="${id}.torrent"`);
  res.send(readFileSync(tp));
});

// Le web-seed BEP-19 : sert les octets du fichier (avec support des requêtes Range).
router.get('/:transferId/webseed', (req, res) => {
  const id = req.params.transferId;
  const meta = db.prepare("SELECT filename, mimetype FROM large_transfers WHERE transfer_id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))").get(id);
  if (!meta) return res.status(404).json({ error: 'Indisponible' });
  if (!existsSync(torrentPath(id))) return res.status(404).json({ error: 'Indisponible' });
  const bp = blobPath(id);
  if (!existsSync(bp)) return res.status(404).json({ error: 'Blob manquant' });
  streamBlob(req, res, { path: bp, filename: meta?.filename, mimetype: meta?.mimetype, count: true, transferId: id });
});

// ── Récupération par le destinataire ────────────────────────────────────────
router.get('/:transferId', authRequired, (req, res) => {
  // Transfert VOLUMINEUX (non chiffré) : sert le fichier UTILISABLE en stream, SANS
  // X-IV et SANS purge (disponible pendant la fenêtre de rétention).
  const large = db.prepare("SELECT filename, mimetype FROM large_transfers WHERE transfer_id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))").get(req.params.transferId);
  if (large) {
    const bp = blobPath(req.params.transferId);
    if (!existsSync(bp)) return res.status(404).json({ error: 'Fichier indisponible' });
    return streamBlob(req, res, { path: bp, filename: large.filename, mimetype: large.mimetype, count: true, transferId: req.params.transferId });
  }

  // ── Chemin E2EE (≤ 50 Mo) INCHANGÉ : purge après lecture par le destinataire ──
  const row = db.prepare('SELECT * FROM attachments WHERE transfer_id = ? AND recipient_id = ?').get(req.params.transferId, req.user.id);
  if (!row) return res.status(404).json({ error: 'Pièce jointe indisponible' });
  const path = blobPath(req.params.transferId);
  if (!existsSync(path)) { db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id); return res.status(404).json({ error: 'Blob manquant' }); }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-IV', row.iv);
  res.setHeader('X-Filename', encodeURIComponent(row.filename));
  res.setHeader('X-Mimetype', row.mimetype);
  res.send(readFileSync(path));

  // Purge : on consomme l'entrée ; si plus aucun destinataire en attente, on efface le blob
  db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
  const remaining = db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE transfer_id = ?').get(req.params.transferId).n;
  if (remaining === 0) { try { unlinkSync(path); } catch {} releaseTransfer(req.params.transferId); }
});

export default router;
