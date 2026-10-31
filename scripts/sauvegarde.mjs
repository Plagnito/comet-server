// Sauvegarde cohérente d'un serveur Comet, même pendant qu'il tourne (audit C-28).
//
//   node scripts/sauvegarde.mjs <dossier-de-sauvegarde>
//
// - la base : `VACUUM INTO`, une copie cohérente faite par SQLite lui-même, écritures
//   encore dans le journal WAL comprises (copier le fichier .db à la main peut donner une
//   base incomplète ou corrompue) ;
// - les pièces jointes chiffrées et celles du courrier venu de l'extérieur ;
// - manifeste.json : date, commit, empreinte SHA-256 et taille de chaque fichier.
// Les SECRETS du serveur (server/.env : JWT_SECRET, COMET_MAIL_SECRET…) ne sont PAS dans la
// sauvegarde : gardez-les à part. Sans eux, les mots de passe des comptes mail liés et la
// clé de fédération, scellés en base, deviennent illisibles.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, cpSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { emplacements } from './emplacements-donnees.mjs';

export const VERSION_MANIFESTE = 1;
const empreinte = (chemin) => createHash('sha256').update(readFileSync(chemin)).digest('hex');

function lister(dossier) {
  const out = [];
  const marcher = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) marcher(p); else if (e.isFile()) out.push(p);
    }
  };
  if (existsSync(dossier)) marcher(dossier);
  return out;
}

function commitActuel() {
  if (process.env.COMET_COMMIT) return process.env.COMET_COMMIT;
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

export function sauvegarder({ destination, env = process.env }) {
  if (!destination) throw new Error('Indiquez le dossier de sauvegarde.');
  if (existsSync(destination) && readdirSync(destination).length) throw new Error(`Le dossier ${destination} n’est pas vide : choisissez un dossier neuf.`);
  const lieux = emplacements(env);
  if (!existsSync(lieux.base)) throw new Error(`Base introuvable : ${lieux.base}`);
  mkdirSync(destination, { recursive: true });

  // 1. La base, copie cohérente par SQLite.
  const cibleBase = join(destination, 'comet.db');
  const db = new DatabaseSync(lieux.base);
  try { db.exec(`VACUUM INTO '${cibleBase.replace(/'/g, "''")}'`); } finally { db.close(); }

  // 2. Les pièces jointes (dossiers recopiés tels quels).
  const parties = [['piecesJointes', 'pieces-jointes'], ['piecesExternes', 'pieces-externes']];
  for (const [cle, nom] of parties) {
    if (existsSync(lieux[cle]) && statSync(lieux[cle]).isDirectory()) cpSync(lieux[cle], join(destination, nom), { recursive: true });
  }

  // 3. Le manifeste, avec l'empreinte de chaque fichier.
  const fichiers = lister(destination).map((p) => ({
    chemin: relative(destination, p).split(sep).join('/'), taille: statSync(p).size, sha256: empreinte(p),
  }));
  const manifeste = { version: VERSION_MANIFESTE, creeLe: new Date().toISOString(), commit: commitActuel(), fichiers };
  writeFileSync(join(destination, 'manifeste.json'), `${JSON.stringify(manifeste, null, 2)}\n`);
  return manifeste;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const m = sauvegarder({ destination: process.argv[2] });
    const total = m.fichiers.reduce((s, f) => s + f.taille, 0);
    console.log(`✓ Sauvegarde écrite dans ${process.argv[2]} : ${m.fichiers.length} fichier(s), ${(total / 1048576).toFixed(1)} Mio.`);
    console.log('  Rappel : server/.env (JWT_SECRET, COMET_MAIL_SECRET) n’est pas inclus. Gardez-le à part.');
  } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
}
