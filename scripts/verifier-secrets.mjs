// Cherche des secrets probables dans les fichiers suivis par git (audit C-28).
//
//   node scripts/verifier-secrets.mjs        → code 1 et la liste des trouvailles s'il y en a
//
// Node pur, sans dépendance ni service extérieur. Les valeurs sont masquées dans le
// rapport : il ne doit pas devenir lui-même une fuite. Une exception se déclare dans
// EXCEPTIONS, avec sa raison ; elle doit rester courte.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MOTIFS = [
  { nom: 'jeton GitHub', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { nom: 'jeton GitHub (fine-grained)', re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { nom: 'clé privée PEM', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/ },
  { nom: 'secret client Google', re: /\bGOCSPX-[A-Za-z0-9_-]{20,}/ },
  { nom: 'clé d’accès AWS', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { nom: 'jeton Slack', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { nom: 'clé d’API OpenAI ou Anthropic', re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}/ },
  { nom: 'clé de connecteur Comet', re: /\bcmtk_[A-Za-z0-9_-]{30,}/ },
];

// Dans un fichier .env* suivi, une variable sensible doit être vide ou un exemple visible.
const VARIABLE_SENSIBLE = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASS|PASSWORD|KEY|CREDENTIAL)[A-Z0-9_]*)\s*=\s*(.*)$/;
const EXEMPLE = /^(?:["']?)(?:|changeme|change[-_ ]?me|changez[-_ ]?moi.*|x+|\.\.\.|<.*>|votre.*|your.*|exemple.*|example.*|placeholder.*|a-remplacer.*|à-remplacer.*)(?:["']?)\s*(?:#.*)?$/i;

// Exceptions déclarées : chemin → raison.
export const EXCEPTIONS = new Map([
  ['scripts/verifier-secrets.mjs', 'le script décrit les motifs qu’il cherche'],
]);

const masquer = (s) => (s.length <= 8 ? '****' : `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} caractères)`);

// Rend la liste des trouvailles d'un texte : [{ ligne, nom, extrait }].
export function chercherSecrets(texte, chemin = '') {
  const trouvailles = [];
  const env = /(^|\/)\.env(\.|$)/.test(chemin);
  texte.split(/\r?\n/).forEach((ligne, i) => {
    for (const { nom, re } of MOTIFS) {
      const m = ligne.match(re);
      if (m) trouvailles.push({ ligne: i + 1, nom, extrait: masquer(m[0]) });
    }
    if (env) {
      const m = ligne.match(VARIABLE_SENSIBLE);
      if (m && !EXEMPLE.test(m[2].trim())) trouvailles.push({ ligne: i + 1, nom: `valeur réelle pour ${m[1]}`, extrait: masquer(m[2].trim()) });
    }
  });
  return trouvailles;
}

export function verifierDepot(racine) {
  const fichiers = execFileSync('git', ['ls-files', '-z'], { cwd: racine, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  const resultats = [];
  for (const f of fichiers) {
    if (EXCEPTIONS.has(f)) continue;
    const chemin = join(racine, f);
    let st; try { st = statSync(chemin); } catch { continue; } // supprimé de l'arbre, pas encore de l'index
    if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
    const brut = readFileSync(chemin);
    if (brut.subarray(0, 8000).includes(0)) continue; // binaire
    for (const t of chercherSecrets(brut.toString('utf8'), f)) resultats.push({ fichier: f, ...t });
  }
  return resultats;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const racine = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const r = verifierDepot(racine);
  if (!r.length) { console.log('✓ Aucun secret probable dans les fichiers suivis.'); process.exit(0); }
  console.error(`✗ ${r.length} secret(s) probable(s) :`);
  for (const t of r) console.error(`  ${t.fichier}:${t.ligne}  ${t.nom}  ${t.extrait}`);
  console.error('Retirez-les du dépôt (et changez-les : ils sont dans l’historique), ou déclarez une exception justifiée dans scripts/verifier-secrets.mjs.');
  process.exit(1);
}
