// Mise à jour automatique du serveur depuis GitHub (repo privé via token).
// Active uniquement si AUTO_UPDATE=1 et GITHUB_TOKEN présent (donc inactif en dev).
// Compatible nvm : npm est résolu À CÔTÉ du node en cours (process.execPath), et le PATH
// des sous-processus inclut ce dossier — donc fonctionne sous systemd sans nvm chargé.
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, delimiter } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // comet/
const TOKEN = process.env.GITHUB_TOKEN || '';
const REPO = process.env.GITHUB_REPO || 'Plagnito/comet-server';
const BRANCH = process.env.UPDATE_BRANCH || 'main';
const INTERVAL_MIN = Number(process.env.UPDATE_INTERVAL_MIN) || 15;

const NODE_DIR = dirname(process.execPath);
const NPM = join(NODE_DIR, process.platform === 'win32' ? 'npm.cmd' : 'npm');
const ENV = { ...process.env, PATH: `${NODE_DIR}${delimiter}${process.env.PATH || ''}` };
const sh = (cmd, cwd) => execSync(cmd, { cwd, env: ENV, stdio: 'pipe' });

export function localCommit() {
  // stderr ignoré : hors dépôt git (image Docker, archive), l'absence de commit est
  // un cas normal, pas une erreur à afficher à chaque démarrage.
  try { return execSync('git rev-parse HEAD', { cwd: repoRoot, env: ENV, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
}

async function remoteCommit() {
  const r = await fetch(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'comet-updater', Accept: 'application/vnd.github+json' },
  });
  if (!r.ok) throw new Error(`GitHub API ${r.status}`);
  return (await r.json()).sha;
}

function applyUpdate() {
  const url = `https://x-access-token:${TOKEN}@github.com/${REPO}.git`;
  // Auto-réparant : on s'aligne EXACTEMENT sur origin via
  // fetch + reset --hard, au lieu de `git pull`. Sinon le moindre fichier suivi modifié
  // localement — typiquement package-lock.json réécrit par `npm install` au cycle
  // précédent — fait échouer `pull` (« local changes would be overwritten ») et fige
  // le déploiement indéfiniment. node_modules/ et client/dist/ (gitignored) survivent.
  sh(`git fetch "${url}" ${BRANCH}`, repoRoot);
  sh('git reset --hard FETCH_HEAD', repoRoot);
  sh(`"${NPM}" install --omit=dev`, join(repoRoot, 'server'));
  sh(`"${NPM}" install`, join(repoRoot, 'client'));
  // Build via node directement (évite « vite: Permission denied » si le bit +x manque)
  sh(`"${process.execPath}" node_modules/vite/bin/vite.js build`, join(repoRoot, 'client'));
}

async function checkOnce() {
  const local = localCommit();
  if (!local) return;
  const remote = await remoteCommit();
  if (remote && remote !== local) {
    console.log(`[updater] nouvelle version ${remote.slice(0, 7)} (local ${local.slice(0, 7)}) — application…`);
    try {
      applyUpdate();
      console.log('[updater] mise à jour appliquée — redémarrage du service.');
      process.exit(0); // systemd (Restart=always) relance avec le nouveau code + le nouveau build
    } catch (e) {
      // On journalise stderr (git/npm/vite) en plus du message générique « Command
      // failed », pour que la cause d'un blocage soit visible dans les logs du service.
      const detail = (e.stderr && e.stderr.toString().trim()) || (e.stdout && e.stdout.toString().trim()) || '';
      console.error('[updater] échec de la mise à jour (on reste sur la version actuelle) :', e.message);
      if (detail) console.error('[updater] détail :', detail.slice(-2000));
    }
  }
}

export function startUpdater() {
  if (process.env.AUTO_UPDATE !== '1' || !TOKEN) return;
  console.log(`[updater] auto-update activé — vérification toutes les ${INTERVAL_MIN} min (${REPO}@${BRANCH}).`);
  checkOnce().catch((e) => console.error('[updater]', e.message));
  setInterval(() => checkOnce().catch((e) => console.error('[updater]', e.message)), INTERVAL_MIN * 60_000);
}
