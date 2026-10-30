// Récupère la dernière GitHub Release du dépôt et met ses installateurs en cache
// local, pour que le serveur (le Pi) les redistribue via le site.
import { mkdirSync, existsSync, statSync, createReadStream, createWriteStream, renameSync, unlinkSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = process.env.COMET_REPO || process.env.GITHUB_REPO || 'Plagnito/comet-server';
const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../data/downloads');
const TTL = 10 * 60 * 1000;

// Reconnaissance de l'OS d'après le nom de fichier de l'asset.
const OS_MATCH = { win: /\.exe$/i, mac: /\.dmg$/i, linux: /\.AppImage$/i };

// Pure : transforme une release GitHub en liste de téléchargements par OS.
export function mapRelease(rel) {
  if (!rel || !Array.isArray(rel.assets)) return { version: null, assets: [], htmlUrl: rel?.html_url || null };
  const assets = [];
  for (const [os, re] of Object.entries(OS_MATCH)) {
    const a = rel.assets.find((x) => re.test(x.name));
    if (a) assets.push({ os, name: a.name, size: a.size });
  }
  return { version: rel.tag_name || rel.name || null, assets, htmlUrl: rel.html_url || null };
}

function ghHeaders() {
  const h = { 'User-Agent': 'comet-server', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

const hasInstaller = (rel) => rel && Array.isArray(rel.assets) && rel.assets.some((a) => Object.values(OS_MATCH).some((re) => re.test(a.name)));

let cache = { at: 0, rel: null };
async function latestRelease() {
  if (cache.rel && Date.now() - cache.at < TTL) return cache.rel;
  // On liste les releases (l'endpoint /latest IGNORE les drafts ET prereleases ;
  // or electron-builder publie en DRAFT par défaut). Avec le token du Pi, la liste
  // inclut les drafts → on prend la plus récente contenant un installateur reconnu.
  let rel = null;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=10`, { headers: ghHeaders() });
    if (r.ok) {
      const list = await r.json();
      if (Array.isArray(list)) rel = list.find(hasInstaller) || list.find((x) => Array.isArray(x.assets)) || null;
    }
  } catch { rel = null; }
  cache = { at: Date.now(), rel };
  return rel;
}

export async function listDownloads() {
  return mapRelease(await latestRelease());
}

// Résout l'asset GitHub correspondant à un OS.
// On garde l'URL d'API de l'asset (a.url), PAS browser_download_url : sur un dépôt
// PRIVÉ, seul l'endpoint d'API (avec Accept: application/octet-stream + token) permet
// de télécharger le binaire ; browser_download_url exige une session navigateur.
export async function resolveOs(os) {
  const rel = await latestRelease();
  const re = OS_MATCH[os];
  if (!rel || !re || !Array.isArray(rel.assets)) return null;
  const a = rel.assets.find((x) => re.test(x.name));
  return a ? { name: a.name, size: a.size, url: a.url } : null;
}

// Résout un asset de la dernière release par son NOM EXACT (latest.yml,
// Comet-Setup-x.y.z.exe, .blockmap…). Sert le flux de mise à jour automatique
// (electron-updater, provider « generic »), qui demande des fichiers par nom.
export async function resolveAssetByName(name) {
  const rel = await latestRelease();
  if (!rel || !Array.isArray(rel.assets)) return null;
  const a = rel.assets.find((x) => x.name === name);
  return a ? { name: a.name, size: a.size, url: a.url } : null;
}

// Récupère le CONTENU d'un petit asset texte (ex. latest.yml) en mémoire, SANS le
// mettre en cache disque : son nom est CONSTANT d'une version à l'autre → un cache
// par nom servirait une version périmée. Renvoie un Buffer. Réservé aux petits fichiers.
export async function fetchAssetBytes(asset) {
  const r = await fetch(asset.url, { headers: { 'User-Agent': 'comet-server', Accept: 'application/octet-stream', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) }, redirect: 'follow' });
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// Chemin du cache local s'il est complet (taille == taille attendue), sinon null.
export function cachedPath(asset) {
  const file = join(CACHE_DIR, asset.name);
  return existsSync(file) && statSync(file).size === asset.size ? file : null;
}

export const streamFile = (file) => createReadStream(file);

// Relaie le flux GitHub vers le client TOUT EN le mettant en cache (le 1ᵉʳ
// téléchargement sert immédiatement ; les suivants viennent du cache du Pi).
export async function streamThrough(asset, res) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, asset.name);
  const tmp = `${file}.part`;
  // Accept: application/octet-stream → l'API renvoie un 302 vers le binaire signé (suivi
  // automatiquement). Fonctionne pour les dépôts privés ET publics avec le token du Pi.
  const r = await fetch(asset.url, { headers: { 'User-Agent': 'comet-server', Accept: 'application/octet-stream', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) }, redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`upstream ${r.status}`);

  const web = Readable.fromWeb(r.body);
  const out = createWriteStream(tmp);
  let failed = false;
  const cleanup = () => { try { unlinkSync(tmp); } catch {} };
  web.on('error', () => { failed = true; out.destroy(); cleanup(); });
  out.on('error', () => { failed = true; cleanup(); });
  out.on('finish', () => { if (!failed) { try { renameSync(tmp, file); } catch { cleanup(); } } else cleanup(); });

  web.pipe(out);   // vers le cache du Pi
  web.pipe(res);   // vers le client
}
