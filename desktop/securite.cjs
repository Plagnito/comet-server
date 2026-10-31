// Règles de sécurité de l'application de bureau, en fonctions pures (testées dans
// server/test/bureau-securite.test.js). Aucune ne dépend d'Electron.
//
// Principe : une adresse se compare par son ORIGINE exacte (schéma + hôte + port),
// jamais par un début de chaîne. « https://comet.exemple.fr.pirate.net » commence
// par « https://comet.exemple.fr » ; son origine, elle, est différente.

// Origine d'une adresse, ou null si elle ne s'analyse pas ou n'en a pas
// (file:, data:, about: rendent l'origine opaque « null »).
function origineDe(adresse) {
  try {
    const o = new URL(String(adresse)).origin;
    return o && o !== 'null' ? o : null;
  } catch { return null; }
}

// Vrai si l'adresse a exactement l'une des origines données (les vides sont ignorées).
function origineParmi(adresse, origines) {
  const o = origineDe(adresse);
  if (!o) return false;
  return origines.some((x) => x && origineDe(x) === o);
}

// Vrai si l'adresse a l'origine de `base` ET un chemin qui commence par `prefixe`
// (le préfixe se termine par « / » : « /api/x/ » n'accepte pas « /api/xyz »).
function sousChemin(adresse, base, prefixe) {
  let u;
  try { u = new URL(String(adresse)); } catch { return false; }
  const o = origineDe(base);
  return !!o && u.origin === o && u.pathname.startsWith(prefixe);
}

// Schémas qu'on accepte de confier au système (navigateur, logiciel de courrier).
// Tout le reste (file:, smb:, ms-*, javascript:, protocoles d'applications…) est
// refusé : un lien dans un courrier ne doit pas lancer un programme local.
const SCHEMAS_EXTERNES = new Set(['https:', 'http:', 'mailto:']);
function lienExterneAutorise(adresse) {
  let u;
  try { u = new URL(String(adresse)); } catch { return false; }
  if (!SCHEMAS_EXTERNES.has(u.protocol)) return false;
  if (u.protocol !== 'mailto:' && (u.username || u.password)) return false; // https://banque.fr@pirate.net
  return true;
}

// Même fichier local (la page « Choisir mon serveur »), à la casse des lettres de
// lecteur près sous Windows. `fichier` est une adresse file:// complète.
function memeFichier(adresse, fichier) {
  let a; let b;
  try { a = new URL(String(adresse)); b = new URL(String(fichier)); } catch { return false; }
  if (a.protocol !== 'file:' || b.protocol !== 'file:') return false;
  const norme = (u) => decodeURIComponent(u.pathname).replace(/\\/g, '/').toLowerCase();
  return a.host === b.host && norme(a) === norme(b);
}

// Décide si l'expéditeur d'un message IPC a le droit de l'envoyer.
//   adresse : event.senderFrame.url
//   origines : les origines de confiance (le serveur Comet chargé)
//   pageChoix : adresse file:// de la page de choix du serveur
//   canal : nom du canal ; la page de choix n'a droit qu'à `canauxChoix`
function expediteurAutorise({ adresse, origines, pageChoix, canal, canauxChoix }) {
  if (origineParmi(adresse, origines)) return true;
  if (pageChoix && memeFichier(adresse, pageChoix)) return canauxChoix.includes(canal);
  return false;
}

module.exports = { origineDe, origineParmi, sousChemin, lienExterneAutorise, memeFichier, expediteurAutorise, SCHEMAS_EXTERNES };
