import express, { Router } from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync,
  statSync, createReadStream, createWriteStream, renameSync,
} from 'node:fs';
import { db } from '../db.js';
import { authRequired } from '../auth.js';
import { createWebSeedTorrentFromFile } from '../services/torrent.js';

const router = Router();
const __dirname = dirname(fileURLToPath(import.meta.url));
const BLOB_DIR = join(__dirname, '..', '..', 'data', 'attachments');
mkdirSync(BLOB_DIR, { recursive: true });
const safeId = (transferId) => String(transferId).replace(/[^a-zA-Z0-9_-]/g, '');
const blobPath = (transferId) => join(BLOB_DIR, `${safeId(transferId)}.bin`);
const torrentPath = (transferId) => join(BLOB_DIR, `${safeId(transferId)}.torrent`);

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
}

// Comptabilise un téléchargement DIRECT complet (réponse 200) ; applique le plafond.
// Le trafic torrent (requêtes Range) n'est PAS compté (voir streamBlob).
function countDownload(transferId) {
  try {
    const row = db.prepare('SELECT downloads, max_downloads FROM large_transfers WHERE transfer_id = ?').get(transferId);
    if (!row) return;
    const n = row.downloads + 1;
    db.prepare('UPDATE large_transfers SET downloads = ? WHERE transfer_id = ?').run(n, transferId);
    if (row.max_downloads > 0 && n >= row.max_downloads) purgeLarge(transferId);
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

// ── Dépôt E2EE (≤ 50 Mo) : le ciphertext (opaque) est envoyé en corps binaire brut ──
// Chemin INCHANGÉ (repli serveur des pièces jointes chiffrées, usage unique).
router.post('/', authRequired, express.raw({ type: '*/*', limit: '80mb' }), (req, res) => {
  const transferId = String(req.get('X-Transfer-Id') || '').trim();
  const iv = String(req.get('X-IV') || '').trim();
  let filename = 'fichier';
  try { filename = decodeURIComponent(req.get('X-Filename') || '').slice(0, 255) || 'fichier'; } catch {}
  const mimetype = String(req.get('X-Mimetype') || 'application/octet-stream').slice(0, 120);
  const size = Number(req.get('X-Size') || 0);
  const to = String(req.get('X-To') || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!transferId || !iv || !req.body?.length || to.length === 0) return res.status(400).json({ error: 'Dépôt invalide' });

  if (!existsSync(blobPath(transferId))) writeFileSync(blobPath(transferId), req.body);
  const ins = db.prepare('INSERT OR IGNORE INTO attachments (transfer_id, recipient_id, filename, mimetype, size, iv) VALUES (?, ?, ?, ?, ?, ?)');
  let stored = 0;
  for (const email of to) { const id = emailToId(email); if (id) { ins.run(transferId, id, filename, mimetype, size, iv); stored++; } }
  res.status(201).json({ ok: true, stored });
});

// ── Dépôt VOLUMINEUX (> 50 Mo), NON chiffré, en STREAM vers le disque ───────────
// Aucun analyseur de corps (octet-stream) → req est un flux brut : pas de limite de
// taille, aucun X-IV. On écrit dans un fichier .part puis on renomme, puis on génère
// le .torrent web-seed EN STREAMANT le fichier (jamais tout en RAM). Décidé par le
// produit : les fichiers volumineux ne sont PAS E2EE (web-seed = fichier utilisable).
router.post('/large', authRequired, (req, res) => {
  const transferId = String(req.get('X-Transfer-Id') || '').trim();
  if (!transferId) return res.status(400).json({ error: 'Transfert invalide' });
  let filename = 'fichier';
  try { filename = decodeURIComponent(req.get('X-Filename') || '').slice(0, 255) || 'fichier'; } catch {}
  const mimetype = String(req.get('X-Mimetype') || 'application/octet-stream').slice(0, 120);
  const retentionDays = Math.max(0, Number(req.get('X-Retention-Days') || 7) || 0);
  const maxDownloads = Math.max(0, Number(req.get('X-Max-Downloads') || 0) || 0);

  const finalPath = blobPath(transferId);
  const partPath = `${finalPath}.part`;
  const ws = createWriteStream(partPath);
  let aborted = false;
  const cleanupPart = () => { try { unlinkSync(partPath); } catch {} };

  const fail = (code, msg) => { aborted = true; try { ws.destroy(); } catch {} cleanupPart(); if (!res.headersSent) res.status(code).json({ error: msg }); };
  req.on('aborted', () => { aborted = true; try { ws.destroy(); } catch {} cleanupPart(); });
  req.on('error', () => fail(400, 'Téléversement interrompu'));
  ws.on('error', () => fail(500, 'Écriture impossible (espace disque ?)'));

  ws.on('finish', async () => {
    if (aborted) return;
    try {
      renameSync(partPath, finalPath);
      const base = baseUrlFor(req);
      const webSeedUrl = `${base}/api/attachments/${encodeURIComponent(transferId)}/webseed`;
      const torrentUrl = `${base}/api/attachments/${encodeURIComponent(transferId)}.torrent`;
      const { torrent: bytes, infoHash } = await createWebSeedTorrentFromFile(finalPath, { name: filename, webSeedUrl });
      writeFileSync(torrentPath(transferId), bytes);

      const actualSize = statSync(finalPath).size;
      db.prepare('DELETE FROM large_transfers WHERE transfer_id = ?').run(transferId);
      db.prepare(`INSERT INTO large_transfers (transfer_id, filename, mimetype, size, sender_id, info_hash, expires_at, max_downloads)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(transferId, filename, mimetype, actualSize, req.user.id, infoHash, expiryFor(retentionDays), maxDownloads);

      res.status(201).json({ ok: true, torrent: { url: torrentUrl, webSeed: webSeedUrl, infoHash } });
    } catch (e) {
      try { unlinkSync(finalPath); } catch {}
      try { unlinkSync(torrentPath(transferId)); } catch {}
      console.warn('[attachments] préparation torrent volumineux échouée:', e?.message || e);
      if (!res.headersSent) res.status(500).json({ error: 'Préparation du torrent impossible' });
    }
  });

  req.pipe(ws);
});

// ── Rétention : régler durée de conservation / nb max de téléchargements ────────
// Réutilise les valeurs du panneau « torrent » du compositeur (retentionDays / maxDownloads).
router.post('/config', authRequired, (req, res) => {
  const transferId = String(req.body?.transferId || '').trim();
  const row = db.prepare('SELECT sender_id FROM large_transfers WHERE transfer_id = ?').get(transferId);
  if (!row) return res.status(404).json({ error: 'Transfert inconnu' });
  if (row.sender_id !== req.user.id) return res.status(403).json({ error: 'Non autorisé' });
  const retentionDays = Math.max(0, Number(req.body?.retentionDays ?? 7) || 0);
  const maxDownloads = Math.max(0, Number(req.body?.maxDownloads ?? 0) || 0);
  const expiresAt = expiryFor(retentionDays);
  db.prepare('UPDATE large_transfers SET expires_at = ?, max_downloads = ? WHERE transfer_id = ?').run(expiresAt, maxDownloads, transferId);
  res.json({ ok: true, expiresAt, maxDownloads });
});

// ── Web-seed & .torrent : PUBLICS (aucune auth) ─────────────────────────────
// Un client BitTorrent télécharge le .torrent puis les données via HTTP sans pouvoir
// s'authentifier ; le transferId (UUID, ~122 bits) sert de capacité. Actives UNIQUEMENT
// pour un blob volumineux qui a un .torrent, et ne purgent jamais par accès (le web-seed
// doit rester disponible pendant la fenêtre de rétention). La route authentifiée
// GET /:transferId (repli chiffré du destinataire, usage unique) reste inchangée.

// Le fichier .torrent lui-même.
router.get(/^\/([A-Za-z0-9_-]+)\.torrent$/, (req, res) => {
  const id = safeId(req.params[0]);
  const tp = torrentPath(id);
  if (!existsSync(tp)) return res.status(404).json({ error: 'Torrent indisponible' });
  res.setHeader('Content-Type', 'application/x-bittorrent');
  res.setHeader('Content-Disposition', `attachment; filename="${id}.torrent"`);
  res.send(readFileSync(tp));
});

// Le web-seed BEP-19 : sert les octets du fichier (avec support des requêtes Range).
router.get('/:transferId/webseed', (req, res) => {
  const id = safeId(req.params.transferId);
  if (!existsSync(torrentPath(id))) return res.status(404).json({ error: 'Indisponible' });
  const bp = blobPath(id);
  if (!existsSync(bp)) return res.status(404).json({ error: 'Blob manquant' });
  const meta = db.prepare('SELECT filename, mimetype FROM large_transfers WHERE transfer_id = ?').get(id);
  streamBlob(req, res, { path: bp, filename: meta?.filename, mimetype: meta?.mimetype, count: true, transferId: id });
});

// ── Récupération par le destinataire ────────────────────────────────────────
router.get('/:transferId', authRequired, (req, res) => {
  // Transfert VOLUMINEUX (non chiffré) : sert le fichier UTILISABLE en stream, SANS
  // X-IV et SANS purge (disponible pendant la fenêtre de rétention).
  const large = db.prepare('SELECT filename, mimetype FROM large_transfers WHERE transfer_id = ?').get(req.params.transferId);
  if (large) {
    const bp = blobPath(req.params.transferId);
    if (!existsSync(bp)) return res.status(404).json({ error: 'Fichier indisponible' });
    return streamBlob(req, res, { path: bp, filename: large.filename, mimetype: large.mimetype, count: true, transferId: safeId(req.params.transferId) });
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
  if (remaining === 0) { try { unlinkSync(path); } catch {} }
});

export default router;
