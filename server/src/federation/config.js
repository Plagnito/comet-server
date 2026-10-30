// Fédération entre serveurs Comet — réglages.
//
// Lus à chaque appel (et non figés à l'import) : les tests changent l'environnement
// entre deux cas, et un admin peut corriger une variable sans que le code garde
// l'ancienne valeur en mémoire.
//
//   COMET_DOMAINE=serveur-a.fr          active la fédération ; « camille@comet.mail » est
//                                       joignable du dehors sous « camille@serveur-a.fr ».
//                                       Absent ⇒ fédération INACTIVE (rien n'est publié).
//   COMET_FEDERATION=ouverte|liste|fermee
//                                       ouverte (défaut) : tout serveur non bloqué ;
//                                       liste : seulement COMET_FEDERATION_PAIRS ;
//                                       fermee : aucun échange (la clé reste publiée).
//   COMET_FEDERATION_PAIRS=b.fr,c.fr    serveurs admis en mode « liste ».
//   COMET_FEDERATION_BLOQUES=x.fr       serveurs refusés (en plus des blocages de l'admin).
//   COMET_FEDERATION_HOTES=b.test=http://127.0.0.1:4811,c.lan=https://10.0.0.5
//                                       adresse explicite d'un domaine (réseau local, tests).
//                                       http n'y est admis que vers une adresse locale/privée.
//   COMET_FEDERATION_DEBIT=60           livraisons admises par minute et par serveur distant.

export const DOMAINE_INTERNE = 'comet.mail';

const liste = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// Un domaine fédéré : lettres, chiffres, tirets et points, au moins un point. Pas de port,
// pas de chemin, pas d'IP brute — c'est un NOM, que TLS sait authentifier.
export const DOMAINE_VALIDE = /^(?=.{3,253}$)(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function domaineLocal() {
  const d = String(process.env.COMET_DOMAINE || '').trim().toLowerCase();
  return d && DOMAINE_VALIDE.test(d) && d !== DOMAINE_INTERNE ? d : null;
}

export const federationActive = () => !!domaineLocal();

export function mode() {
  const m = String(process.env.COMET_FEDERATION || 'ouverte').trim().toLowerCase();
  return ['ouverte', 'liste', 'fermee'].includes(m) ? m : 'ouverte';
}

export const pairsAdmis = () => new Set(liste(process.env.COMET_FEDERATION_PAIRS));
export const bloquesParConfig = () => new Set(liste(process.env.COMET_FEDERATION_BLOQUES));

// Hôtes déclarés : domaine → URL de base (sans barre finale).
export function hotesDeclares() {
  const map = new Map();
  for (const paire of String(process.env.COMET_FEDERATION_HOTES || '').split(',')) {
    const i = paire.indexOf('=');
    if (i < 1) continue;
    const domaine = paire.slice(0, i).trim().toLowerCase();
    const url = paire.slice(i + 1).trim().replace(/\/+$/, '');
    if (domaine && /^https?:\/\//i.test(url)) map.set(domaine, url);
  }
  return map;
}

export function debitParMinute() {
  const n = Number.parseInt(process.env.COMET_FEDERATION_DEBIT, 10);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

// Limites fixes du protocole.
export const LIMITES = Object.freeze({
  corpsMax: 1024 * 1024,          // une livraison (texte chiffré + clés) : 1 Mio
  reponseMax: 256 * 1024,         // ce qu'on accepte de lire chez un serveur distant
  destinatairesMax: 100,          // adresses par livraison ou par demande de clés
  derive: 5 * 60 * 1000,          // écart d'horloge toléré : ±5 min
  vieNonce: 10 * 60 * 1000,       // un nonce est retenu 10 min (> 2 × la dérive)
  delai: 8000,                    // délai réseau d'un appel sortant
  essaisPendant: 48 * 3600 * 1000, // la file réessaie pendant 48 h
  cacheDecouverte: 10 * 60 * 1000, // un /.well-known lu est réutilisé 10 min
  cacheAbsent: 60 * 60 * 1000,    // « pas de Comet ici » est retenu 1 h
});

// « camille@serveur-a.fr » → { local: 'camille', domaine: 'serveur-a.fr' }
export function decouper(adresse) {
  const a = String(adresse || '').trim().toLowerCase();
  const i = a.lastIndexOf('@');
  if (i < 1 || i === a.length - 1) return null;
  const local = a.slice(0, i);
  const domaine = a.slice(i + 1);
  if (!/^[a-z0-9._+-]{1,64}$/.test(local)) return null;
  return { local, domaine, adresse: `${local}@${domaine}` };
}

// Adresse d'un compte LOCAL vue du dehors. Seuls les comptes en @comet.mail (ou déjà au
// nom du domaine du serveur) en ont une : un compte inscrit sous « x@gmail.com » ne peut
// pas parler au nom de « x@serveur-a.fr » — deux comptes différents tomberaient sur la
// même adresse fédérée.
export function adresseFederee(emailLocal) {
  const dom = domaineLocal();
  const p = decouper(emailLocal);
  if (!dom || !p) return null;
  if (p.domaine !== DOMAINE_INTERNE && p.domaine !== dom) return null;
  return `${p.local}@${dom}`;
}

// Adresse au nom de NOTRE domaine → l'adresse interne du compte (« x@serveur-a.fr » →
// « x@comet.mail »). Toute autre adresse est rendue telle quelle.
export function versAdresseInterne(adresse) {
  const dom = domaineLocal();
  const p = decouper(adresse);
  if (!dom || !p || p.domaine !== dom) return String(adresse || '').trim().toLowerCase();
  return `${p.local}@${DOMAINE_INTERNE}`;
}

// Le domaine relève-t-il potentiellement de la fédération ? (ni interne, ni le nôtre)
export function estDomaineDistant(domaine) {
  const d = String(domaine || '').toLowerCase();
  return federationActive() && d !== DOMAINE_INTERNE && d !== domaineLocal() && DOMAINE_VALIDE.test(d);
}
