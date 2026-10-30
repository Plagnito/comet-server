// Application de bureau native Comet (Electron).
// Charge le SERVEUR choisi par l'utilisateur (écran « Choisir mon serveur », mémorisé) ;
// à défaut, l'écran de choix s'ouvre. Repli sur un serveur local en dev.
//   COMET_MODE=remote  → force le distant
//   COMET_MODE=local   → force un serveur local
//   COMET_MODE=auto    → distant si joignable, sinon local (défaut)
const { app, BrowserWindow, shell, ipcMain, dialog, session } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// Serveur par défaut quand l'utilisateur n'en a choisi aucun. Vide = écran de choix.
const SERVEUR_DEFAUT = '';
const MODE = process.env.COMET_MODE || 'auto';
const PORT = Number(process.env.PORT) || 4800;
const LOCAL = `http://localhost:${PORT}`;
const SERVER_DIR = path.join(__dirname, '..', 'server');

let serverProc = null;
let win = null;

async function ping(base) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(`${base}/api/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

function spawnServer() {
  serverProc = spawn('node', ['src/server.js'], {
    cwd: SERVER_DIR, env: { ...process.env, PORT: String(PORT) }, shell: true, stdio: 'inherit',
  });
}
async function ensureLocal() {
  if (await ping(LOCAL)) return;
  spawnServer();
  for (let i = 0; i < 80; i++) { await new Promise((r) => setTimeout(r, 250)); if (await ping(LOCAL)) return; }
}

// ── Serveur choisi ───────────────────────────────────────────────────────────
// Priorité : COMET_REMOTE_URL (déploiement, tests) > choix mémorisé > défaut.
// Une adresse se normalise en origine https://hôte[:port] ; http:// n'est admis que
// pour localhost et le réseau local (un mot de passe ne doit pas voyager en clair).
function normaliserServeur(saisie) {
  let s = String(saisie || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/.test(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  return u.origin;
}
const serveurChoisi = () => process.env.COMET_REMOTE_URL || readPrefs().serverUrl || SERVEUR_DEFAUT;
// Fixé au démarrage (app.whenReady) : les préférences ne sont lisibles qu'à partir de là.
let REMOTE = '';
const PAGE_CHOIX = path.join(__dirname, 'choisir-serveur.html');

// Vérifie qu'une adresse répond ET qu'il s'agit bien d'un serveur Comet.
async function testerServeur(origine) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(`${origine}/api/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return { ok: false, raison: `Le serveur a répondu ${r.status}.` };
    const j = await r.json().catch(() => null);
    if (!j || j.app !== 'comet') return { ok: false, raison: "Cette adresse répond, mais ce n'est pas un serveur Comet." };
    return { ok: true };
  } catch {
    return { ok: false, raison: 'Aucune réponse à cette adresse. Vérifiez-la, et que le serveur est démarré.' };
  }
}

ipcMain.handle('serveur:get', () => ({ actuel: REMOTE || '', impose: !!process.env.COMET_REMOTE_URL }));
ipcMain.handle('serveur:tester', async (_e, saisie) => {
  const origine = normaliserServeur(saisie);
  if (!origine) return { ok: false, raison: 'Adresse invalide. Exemple : comet.mon-domaine.fr (https obligatoire hors réseau local).' };
  return { ...(await testerServeur(origine)), origine };
});
ipcMain.handle('serveur:utiliser', async (_e, saisie) => {
  const origine = normaliserServeur(saisie);
  if (!origine) return { ok: false, raison: 'Adresse invalide.' };
  const test = await testerServeur(origine);
  if (!test.ok) return test;
  const prefs = readPrefs(); prefs.serverUrl = origine; writePrefs(prefs);
  REMOTE = origine;
  setupAutoUpdate();
  try { win?.loadURL(origine); } catch {}
  return { ok: true, origine };
});
// Depuis les réglages de l'app : rouvre l'écran de choix (le serveur actuel reste
// mémorisé tant qu'un autre n'a pas été validé).
ipcMain.handle('serveur:changer', () => { try { win?.loadFile(PAGE_CHOIX); } catch {} return true; });

async function pickUrl() {
  if (MODE === 'local') { await ensureLocal(); return LOCAL; }
  if (!REMOTE) return null;                 // aucun serveur connu → écran de choix
  if (MODE === 'remote') return REMOTE;
  // Installateur packagé = client distant léger (pas de serveur local embarqué)
  if (app.isPackaged) return REMOTE;
  if (await ping(REMOTE)) return REMOTE;   // distant à jour disponible
  await ensureLocal();                      // sinon, local (dev)
  return LOCAL;
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 980, minHeight: 600,
    title: 'Comet', backgroundColor: '#0b1120', autoHideMenuBar: true,
    frame: false, // barre de titre custom (look natif Windows) — voir desktop/preload + client TitleBar
    backgroundMaterial: 'mica', // backdrop Mica natif (Windows 11) ; ignoré ailleurs (repli opaque)
    webPreferences: {
      contextIsolation: true, nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  // Reflète l'état maximisé pour l'icône agrandir/restaurer du bandeau.
  const sendMax = () => { try { win.webContents.send('window:maximized', win.isMaximized()); } catch {} };
  win.on('maximize', sendMax);
  win.on('unmaximize', sendMax);
  if (url) win.loadURL(url); else win.loadFile(PAGE_CHOIX);
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if ((REMOTE && u.startsWith(REMOTE)) || u.startsWith(LOCAL)) return { action: 'allow' };
    shell.openExternal(u);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
}

function stopServer() {
  if (serverProc && !serverProc.killed) { try { serverProc.kill(); } catch {} }
  serverProc = null;
}

// ── Mise à jour automatique du SHELL natif (electron-updater) ───────────────────
// Le contenu web se rafraîchit déjà tout seul (chargement du distant) ; MAIS le
// binaire (main.cjs, dont setWindowOpenHandler) ne changeait qu'à une réinstallation
// manuelle. On utilise le provider « generic » pointant vers le SERVEUR Comet, qui
// relaie les assets de release (drafts inclus) avec son propre token → aucun secret
// GitHub embarqué dans l'app, compatible dépôt PRIVÉ + releases en Draft.
// Téléchargement en tâche de fond, installation au prochain quit (discret), avec
// possibilité pour l'utilisateur de redémarrer tout de suite (événement → UI).
let autoUpdateArme = false;
function setupAutoUpdate() {
  if (!app.isPackaged) return; // pas d'auto-update en dev (app non empaquetée)
  if (!REMOTE) return;         // aucun serveur choisi : rien à interroger pour l'instant
  if (autoUpdateArme) {        // serveur changé : on suit le nouveau, sans réarmer les écouteurs
    try { autoUpdater.setFeedURL({ provider: 'generic', url: `${REMOTE}/api/download/updates` }); autoUpdater.checkForUpdates().catch(() => {}); } catch {}
    return;
  }
  autoUpdateArme = true;
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.disableDifferentialDownload = true; // relais serveur sans requêtes Range → téléchargement complet fiable
    autoUpdater.setFeedURL({ provider: 'generic', url: `${REMOTE}/api/download/updates` });
    autoUpdater.on('update-downloaded', (info) => {
      try { win && win.webContents.send('update:downloaded', { version: info && info.version }); } catch {}
    });
    autoUpdater.on('error', () => { /* best-effort : jamais bloquant */ });
    const check = () => { autoUpdater.checkForUpdates().catch(() => {}); };
    check();                                        // au démarrage
    setInterval(check, 6 * 60 * 60 * 1000);         // puis toutes les 6 h
  } catch { /* ignore : l'app fonctionne sans auto-update */ }
}

// Applique la mise à jour téléchargée maintenant (bouton « Redémarrer » de l'UI).
ipcMain.handle('update:install', () => { try { autoUpdater.quitAndInstall(); } catch {} return true; });

// Démarrage automatique au login. Préférence persistée (réglable depuis l'UI) ;
// repli : COMET_AUTOSTART=0 désactive par défaut, sinon activé.
const PREF_FILE = () => path.join(app.getPath('userData'), 'comet-desktop.json');
function readPrefs() { try { return JSON.parse(fs.readFileSync(PREF_FILE(), 'utf8')); } catch { return {}; } }
function writePrefs(p) { try { fs.writeFileSync(PREF_FILE(), JSON.stringify(p)); } catch {} }

function applyAutoStart(enabled) {
  try {
    const settings = app.isPackaged
      ? { openAtLogin: enabled }
      : { openAtLogin: enabled, path: process.execPath, args: [path.resolve(__dirname, '..')] };
    app.setLoginItemSettings(settings);
  } catch {}
}
function configureAutoStart() {
  const prefs = readPrefs();
  const enabled = typeof prefs.autoStart === 'boolean' ? prefs.autoStart : process.env.COMET_AUTOSTART !== '0';
  applyAutoStart(enabled);
}

// Pont UI ↔ démarrage auto (exposé via preload.cjs)
ipcMain.handle('autostart:get', () => { try { return app.getLoginItemSettings().openAtLogin; } catch { return false; } });
ipcMain.handle('autostart:set', (_e, enabled) => {
  const v = !!enabled;
  const prefs = readPrefs(); prefs.autoStart = v; writePrefs(prefs);
  applyAutoStart(v);
  try { return app.getLoginItemSettings().openAtLogin; } catch { return v; }
});

// Répertoire de téléchargement par défaut : si défini, on n'affiche plus la
// boîte de dialogue à chaque fichier (les téléchargements y sont enregistrés).
const downloadDir = () => readPrefs().downloadDir || '';
ipcMain.handle('dl:get', () => downloadDir());
ipcMain.handle('dl:choose', async () => {
  const r = await dialog.showOpenDialog({ title: 'Dossier de téléchargement', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return downloadDir();
  const prefs = readPrefs(); prefs.downloadDir = r.filePaths[0]; writePrefs(prefs);
  return prefs.downloadDir;
});
ipcMain.handle('dl:clear', () => { const p = readPrefs(); delete p.downloadDir; writePrefs(p); return ''; });

// Contrôles de la fenêtre (barre de titre custom, look natif Windows).
ipcMain.on('window:minimize', () => { try { win?.minimize(); } catch {} });
ipcMain.on('window:maximize', () => { try { if (win?.isMaximized()) win.unmaximize(); else win?.maximize(); } catch {} });
ipcMain.on('window:close', () => { try { win?.close(); } catch {} });
ipcMain.handle('window:isMaximized', () => { try { return !!win?.isMaximized(); } catch { return false; } });

// ── Torrent (transfert des fichiers > 50 Mo, app de bureau uniquement) ──────────
// Moteur WebTorrent dans le process principal. Le magnet est glissé dans les
// métadonnées CHIFFRÉES de la pièce jointe → le serveur reste aveugle. Le
// destinataire doit avoir le client Comet pour télécharger.
let wt = null;
const seeded = new Map(); // infoHash -> { torrent, timer }
async function getWT() {
  if (!wt) { const mod = await import('webtorrent'); const WebTorrent = mod.default || mod; wt = new WebTorrent(); }
  return wt;
}
function torrentPrefs() {
  const p = readPrefs();
  return { enabled: p.torrentEnabled !== false, retentionDays: p.torrentRetentionDays ?? 7, maxDownloads: p.torrentMaxDownloads ?? 0 };
}
function applyTorrentLimits(t, retentionMs, maxDownloads, size) {
  const rec = seeded.get(t.infoHash) || {};
  if (rec.timer) clearTimeout(rec.timer);
  rec.torrent = t;
  rec.timer = retentionMs > 0 ? setTimeout(() => { try { t.destroy(); } catch {} seeded.delete(t.infoHash); }, retentionMs) : null;
  if (rec.timer && rec.timer.unref) rec.timer.unref();
  if (maxDownloads > 0 && size > 0 && !rec.uploadHooked) {
    rec.uploadHooked = true;
    t.on('upload', () => { if (t.uploaded >= maxDownloads * size) { try { t.destroy(); } catch {} seeded.delete(t.infoHash); } });
  }
  seeded.set(t.infoHash, rec);
}
ipcMain.handle('torrent:get', () => torrentPrefs());
ipcMain.handle('torrent:set', (_e, o = {}) => {
  const p = readPrefs();
  if (typeof o.enabled === 'boolean') p.torrentEnabled = o.enabled;
  if (o.retentionDays != null) p.torrentRetentionDays = Number(o.retentionDays);
  if (o.maxDownloads != null) p.torrentMaxDownloads = Number(o.maxDownloads);
  writePrefs(p); return torrentPrefs();
});
ipcMain.handle('torrent:seed', async (_e, { name, data }) => {
  const client = await getWT();
  const buf = Buffer.from(data);
  return await new Promise((resolve, reject) => {
    try {
      client.seed(buf, { name }, (t) => {
        const def = torrentPrefs();
        applyTorrentLimits(t, def.retentionDays * 86400000, def.maxDownloads, buf.length);
        resolve({ magnet: t.magnetURI, infoHash: t.infoHash, size: buf.length });
      });
    } catch (e) { reject(String(e?.message || e)); }
  });
});
ipcMain.handle('torrent:config', (_e, { infoHash, retentionMs, maxDownloads, size }) => {
  const rec = seeded.get(infoHash);
  if (!rec || !rec.torrent) return false;
  applyTorrentLimits(rec.torrent, retentionMs, maxDownloads, size || rec.torrent.length);
  return true;
});
ipcMain.handle('torrent:download', async (_e, magnet) => {
  const client = await getWT();
  const dest = downloadDir() || app.getPath('downloads');
  return await new Promise((resolve, reject) => {
    let t;
    try { t = client.add(magnet, { path: dest }); } catch (e) { return reject(String(e?.message || e)); }
    t.on('error', (e) => reject(String(e?.message || e)));
    t.on('done', () => { const f = t.files[0]; resolve({ ok: true, path: path.join(t.path, f.path), name: f.name }); });
  });
});

app.whenReady().then(async () => {
  configureAutoStart();
  // Téléchargements : si un dossier par défaut est configuré, pas de dialogue.
  try {
    session.defaultSession.on('will-download', (_e, item) => {
      const dir = downloadDir();
      if (dir) { try { item.setSavePath(path.join(dir, item.getFilename())); } catch {} }
    });
  } catch {}
  REMOTE = serveurChoisi();
  const url = await pickUrl();
  createWindow(url);
  setupAutoUpdate();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(url); });
});
app.on('window-all-closed', () => { stopServer(); if (process.platform !== 'darwin') app.quit(); });
app.on('quit', stopServer);
