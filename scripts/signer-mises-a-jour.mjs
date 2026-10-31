// Signe les mises à jour de l'application de bureau (voir desktop/maj-signee.cjs).
//
//   node scripts/signer-mises-a-jour.mjs <dossier> [--cle <fichier.pem>] [--cle-publique <fichier.pem>]
//
// <dossier> contient ce qu'electron-builder a produit (latest.yml, latest-linux.yml,
// latest-mac.yml et les installateurs qu'ils désignent). Pour chaque fichier de canal,
// le script calcule l'empreinte de l'installateur, la signe et ajoute la ligne
// « cometSignature: … » au fichier de canal. Il revérifie ensuite chaque signature
// avec la clé publique embarquée dans l'application : une clé secrète qui ne
// correspond pas à l'application arrête tout (sinon les apps refuseraient la mise à jour).
//
// Clé secrète : variable COMET_UPDATE_SIGNING_KEY (contenu PEM), ou --cle <fichier>.
// Sans clé, le script échoue : une construction non signée ne doit pas être publiée.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ici = path.dirname(fileURLToPath(import.meta.url));
const { PLATEFORME_DU_CANAL, signer, verifierMiseAJour, empreinteFichier } = require('../desktop/maj-signee.cjs');

const args = process.argv.slice(2);
const option = (nom) => { const i = args.indexOf(nom); return i >= 0 ? args[i + 1] : null; };
const dossier = args.find((a, i) => !a.startsWith('--') && !['--cle', '--cle-publique'].includes(args[i - 1]));
const arreter = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

if (!dossier || !fs.existsSync(dossier)) arreter('dossier de construction introuvable. Usage : node scripts/signer-mises-a-jour.mjs <dossier>');
const clePrivee = option('--cle') ? fs.readFileSync(option('--cle'), 'utf8') : (process.env.COMET_UPDATE_SIGNING_KEY || '');
if (!clePrivee.includes('PRIVATE KEY')) arreter('aucune clé de signature (COMET_UPDATE_SIGNING_KEY ou --cle).');
const clePublique = fs.readFileSync(option('--cle-publique') || path.join(ici, '..', 'desktop', 'cle-mises-a-jour.pem'), 'utf8');

// Lit une valeur de premier niveau d'un fichier de canal (« clé: valeur », sans retrait).
const lire = (texte, cle) => {
  const m = texte.match(new RegExp(`^${cle}:\\s*['"]?([^'"\\r\\n]+?)['"]?\\s*$`, 'm'));
  return m ? m[1] : null;
};

let signes = 0;
for (const [canal, plateforme] of Object.entries(PLATEFORME_DU_CANAL)) {
  const cheminCanal = path.join(dossier, canal);
  if (!fs.existsSync(cheminCanal)) continue;
  const texte = fs.readFileSync(cheminCanal, 'utf8');
  const version = lire(texte, 'version');
  const fichier = lire(texte, 'path');
  if (!version || !fichier) arreter(`${canal} : version ou path absent.`);
  const cheminFichier = path.join(dossier, path.basename(fichier));
  if (!fs.existsSync(cheminFichier)) arreter(`${canal} : ${fichier} introuvable dans ${dossier}.`);
  const sha512 = await empreinteFichier(cheminFichier);
  const annonce = lire(texte, 'sha512');
  if (annonce && annonce !== sha512) arreter(`${canal} : l'empreinte annoncée ne correspond pas à ${fichier}.`);
  const signature = signer({ clePriveePem: clePrivee, version, plateforme, sha512 });
  const verdict = verifierMiseAJour({ clePubliquePem: clePublique, signature, version, versionActuelle: '0.0.0', plateforme, sha512 });
  if (!verdict.ok) arreter(`${canal} : la clé secrète ne correspond pas à la clé publique de l'application (${verdict.raison}).`);
  const sansAncienne = texte.replace(/^cometSignature:.*\r?\n?/m, '').replace(/\s*$/, '\n');
  fs.writeFileSync(cheminCanal, `${sansAncienne}cometSignature: ${signature}\n`);
  console.log(`✓ ${canal} → ${fichier} (${plateforme}, ${version}) signé`);
  signes++;
}
if (!signes) arreter(`aucun fichier de canal (latest*.yml) dans ${dossier}.`);
