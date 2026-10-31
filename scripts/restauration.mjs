// Restauration d'une sauvegarde faite par scripts/sauvegarde.mjs (audit C-28).
//
//   node scripts/restauration.mjs <dossier-de-sauvegarde> [--remplacer] [--port 4800]
//
// 1. vérifie chaque fichier contre le manifeste (taille et SHA-256) : une sauvegarde
//    altérée ou incomplète est refusée avant de toucher à quoi que ce soit ;
// 2. refuse si le serveur répond encore sur son port (arrêtez-le d'abord) ;
// 3. refuse d'écraser des données existantes, sauf avec --remplacer ;
// 4. remet la base et les pièces jointes aux emplacements que le serveur utilise.
// Remettez aussi server/.env avec les MÊMES secrets qu'au moment de la sauvegarde.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { emplacements } from './emplacements-donnees.mjs';
import { VERSION_MANIFESTE } from './sauvegarde.mjs';

const empreinte = (chemin) => createHash('sha256').update(readFileSync(chemin)).digest('hex');
const nonVide = (d) => existsSync(d) && statSync(d).isDirectory() && readdirSync(d).length > 0;

export function verifierSauvegarde(source) {
  const chemin = join(source, 'manifeste.json');
  if (!existsSync(chemin)) throw new Error(`Pas de manifeste dans ${source} : ce n’est pas une sauvegarde Comet.`);
  const m = JSON.parse(readFileSync(chemin, 'utf8'));
  if (m.version !== VERSION_MANIFESTE || !Array.isArray(m.fichiers)) throw new Error('Manifeste illisible ou d’une version inconnue.');
  if (!m.fichiers.some((f) => f.chemin === 'comet.db')) throw new Error('La sauvegarde ne contient pas de base.');
  for (const f of m.fichiers) {
    if (typeof f.chemin !== 'string' || f.chemin.split('/').includes('..')) throw new Error(`Chemin refusé dans le manifeste : ${f.chemin}`);
    const p = join(source, ...f.chemin.split('/'));
    if (!existsSync(p)) throw new Error(`Fichier manquant : ${f.chemin}`);
    if (statSync(p).size !== f.taille || empreinte(p) !== f.sha256) throw new Error(`Fichier altéré : ${f.chemin} (empreinte différente du manifeste)`);
  }
  return m;
}

async function serveurRepond(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

export async function restaurer({ source, remplacer = false, port = process.env.PORT || 4800, env = process.env }) {
  const manifeste = verifierSauvegarde(source);
  if (await serveurRepond(port)) throw new Error(`Un serveur Comet répond sur le port ${port} : arrêtez-le avant de restaurer.`);
  const lieux = emplacements(env);
  const occupe = (existsSync(lieux.base) && statSync(lieux.base).size > 0) || nonVide(lieux.piecesJointes) || nonVide(lieux.piecesExternes);
  if (occupe && !remplacer) throw new Error('Des données existent déjà à cet emplacement : relancez avec --remplacer pour les écraser.');

  // La base : on retire aussi son journal WAL, qui appartiendrait à l'ancienne base.
  for (const s of ['', '-wal', '-shm']) rmSync(lieux.base + s, { force: true });
  mkdirSync(dirname(lieux.base), { recursive: true });
  copyFileSync(join(source, 'comet.db'), lieux.base);

  for (const [nom, cible] of [['pieces-jointes', lieux.piecesJointes], ['pieces-externes', lieux.piecesExternes]]) {
    const d = join(source, nom);
    if (remplacer) rmSync(cible, { recursive: true, force: true });
    if (existsSync(d)) cpSync(d, cible, { recursive: true });
  }
  return manifeste;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  const iPort = args.indexOf('--port');
  const source = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--port');
  try {
    const m = await restaurer({ source, remplacer: args.includes('--remplacer'), port: iPort >= 0 ? args[iPort + 1] : undefined });
    console.log(`✓ Sauvegarde du ${m.creeLe} restaurée (${m.fichiers.length} fichier(s) vérifiés).`);
    console.log('  Remettez server/.env avec les secrets d’origine, puis démarrez le serveur.');
  } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
}
