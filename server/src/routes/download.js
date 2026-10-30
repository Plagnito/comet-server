import { Router } from 'express';
import { statSync } from 'node:fs';
import { listDownloads, resolveOs, resolveAssetByName, fetchAssetBytes, cachedPath, streamFile, streamThrough } from '../services/releases.js';

const router = Router();

// Liste publique des installateurs disponibles (alimente la page d'accueil)
router.get('/releases', async (req, res) => {
  try { res.json(await listDownloads()); }
  catch { res.json({ version: null, assets: [] }); }
});

// Téléchargement d'un installateur — le serveur (le Pi) le récupère depuis GitHub
// et le sert depuis son cache local. « Récupéré par le Pi, redistribué par le site. »
router.get('/desktop/:os', async (req, res) => {
  try {
    const asset = await resolveOs(req.params.os);
    if (!asset) return res.status(404).json({ error: 'Aucun installateur disponible pour cette plateforme' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${asset.name}"`);
    res.setHeader('Content-Length', asset.size);

    const cached = cachedPath(asset);
    if (cached) { streamFile(cached).pipe(res); return; }   // déjà en cache → service direct
    await streamThrough(asset, res);                        // sinon → relais + mise en cache
  } catch {
    if (!res.headersSent) res.status(502).json({ error: 'Téléchargement temporairement indisponible' });
  }
});

// ── Feed de mise à jour automatique (electron-updater, provider « generic ») ────
// L'app de bureau interroge <base>/api/download/updates/latest.yml, puis récupère
// l'installateur par son nom. Le serveur (le Pi) relaie les assets de la release
// (drafts inclus) avec SON token → aucun secret côté client, marche sur dépôt PRIVÉ.
const UPDATE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(exe|dmg|AppImage|deb|zip|blockmap|yml)$/; // borne les noms (anti-traversée)
const CHANNEL_YML = /^(latest|latest-mac|latest-linux)\.yml$/;                                 // fichiers de canal

router.get('/updates/:file', async (req, res) => {
  const file = String(req.params.file || '');
  if (!UPDATE_FILE.test(file) || file.includes('/') || file.includes('\\')) return res.status(404).end();
  try {
    const asset = await resolveAssetByName(file);
    if (!asset) return res.status(404).end();
    // Les fichiers de canal (latest*.yml) ont un nom CONSTANT d'une version à l'autre :
    // jamais de cache disque (servirait une version périmée), toujours relayés FRAIS.
    if (CHANNEL_YML.test(file)) {
      const bytes = await fetchAssetBytes(asset);
      res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(bytes);
    }
    // Installateur / blockmap : nom versionné (unique) → cache disque réutilisable.
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', asset.size);
    const cached = cachedPath(asset);
    if (cached) { streamFile(cached).pipe(res); return; }
    await streamThrough(asset, res);
  } catch {
    if (!res.headersSent) res.status(502).end();
  }
});

export default router;
