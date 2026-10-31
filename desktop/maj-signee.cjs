// Mises à jour signées de l'application de bureau.
//
// Le serveur Comet relaie les fichiers de mise à jour, mais il n'est pas une preuve :
// un serveur compromis (ou un serveur choisi par erreur) pourrait servir un autre
// installateur avec un latest.yml cohérent. La construction signe donc chaque
// installateur avec une clé Ed25519 qu'elle seule détient ; l'application embarque
// la clé publique (desktop/cle-mises-a-jour.pem) et refuse tout fichier dont la
// signature ne correspond pas, quel que soit le serveur.
//
// Ce qui est signé : la version, la plateforme et l'empreinte SHA-512 du fichier.
// La version liée à la signature empêche de resservir un ancien installateur
// authentique (retour à une version vulnérable).
//
// Utilisé par desktop/main.cjs (vérification) et scripts/signer-mises-a-jour.mjs
// (signature à la construction). Testé dans server/test/maj-signee.test.js.
const crypto = require('node:crypto');
const fs = require('node:fs');

const ENTETE = 'comet-mise-a-jour-v1';

// Plateforme portée par chaque fichier de canal d'electron-builder.
const PLATEFORME_DU_CANAL = { 'latest.yml': 'win32', 'latest-linux.yml': 'linux', 'latest-mac.yml': 'darwin' };

function messageSigne({ version, plateforme, sha512 }) {
  return Buffer.from(`${ENTETE}\n${version}\n${plateforme}\n${sha512}`, 'utf8');
}

// Compare deux versions « x.y.z[-pré] ». Rend <0, 0 ou >0.
function comparerVersions(a, b) {
  const decouper = (v) => {
    const [base, pre = ''] = String(v || '').trim().replace(/^v/i, '').split('-', 2);
    return { nums: base.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = decouper(a); const y = decouper(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length, 3); i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return d;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;   // 1.0.3 > 1.0.3-beta
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function signer({ clePriveePem, version, plateforme, sha512 }) {
  return crypto.sign(null, messageSigne({ version, plateforme, sha512 }), crypto.createPrivateKey(clePriveePem)).toString('base64');
}

// Décide si un fichier téléchargé peut être installé. Rend { ok, raison }.
//   sha512 : empreinte calculée SUR LE FICHIER téléchargé (jamais celle annoncée)
//   version : version annoncée par le serveur ; versionActuelle : celle de l'app
function verifierMiseAJour({ clePubliquePem, signature, version, versionActuelle, plateforme, sha512 }) {
  if (!clePubliquePem) return { ok: false, raison: 'aucune clé de vérification dans cette application' };
  if (!signature || typeof signature !== 'string') return { ok: false, raison: 'mise à jour non signée' };
  if (!version || !sha512) return { ok: false, raison: 'version ou empreinte manquante' };
  if (comparerVersions(version, versionActuelle) <= 0) return { ok: false, raison: `version ${version} non postérieure à ${versionActuelle}` };
  let valide = false;
  try {
    valide = crypto.verify(null, messageSigne({ version, plateforme, sha512 }), crypto.createPublicKey(clePubliquePem), Buffer.from(signature, 'base64'));
  } catch { valide = false; }
  return valide ? { ok: true } : { ok: false, raison: 'signature invalide' };
}

// Empreinte SHA-512 d'un fichier, en base64 (le format de latest.yml), par flux.
function empreinteFichier(chemin) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512');
    fs.createReadStream(chemin).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('base64')));
  });
}

module.exports = { ENTETE, PLATEFORME_DU_CANAL, messageSigne, comparerVersions, signer, verifierMiseAJour, empreinteFichier };
