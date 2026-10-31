// Serveurs ICE (STUN / TURN) pour la visio et les pièces jointes en pair-à-pair.
//
// Ils viennent de l'instance (GET /api/rtc-config, réglée par son administrateur), jamais
// d'un service tiers écrit en dur : un serveur STUN voit l'adresse IP de chaque
// participant. Sans configuration, la liste est vide et la connexion ne s'établit
// qu'entre appareils qui se joignent directement (même réseau). Les identifiants du
// relais TURN ne sont rendus qu'à une session valide, d'où le jeton envoyé.

const SCHEMAS = /^(stun|turn|turns):/i;
const MAX = 8;

// Garde les seules entrées utilisables : `urls` (chaîne ou tableau de chaînes) en
// stun:, turn: ou turns:, et des identifiants en texte s'il y en a.
export function nettoyerIce(reponse) {
  const liste = Array.isArray(reponse?.iceServers) ? reponse.iceServers : [];
  const propres = [];
  for (const s of liste.slice(0, MAX)) {
    if (!s || typeof s !== 'object') continue;
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => typeof u === 'string' && SCHEMAS.test(u.trim())).map((u) => u.trim());
    if (!urls.length) continue;
    const entree = { urls: urls.length === 1 ? urls[0] : urls };
    if (typeof s.username === 'string' && s.username) entree.username = s.username;
    if (typeof s.credential === 'string' && s.credential) entree.credential = s.credential;
    propres.push(entree);
  }
  return propres;
}

export async function chargerIce(jeton) {
  try {
    const r = await fetch('/api/rtc-config', { headers: jeton ? { Authorization: `Bearer ${jeton}` } : {} });
    if (!r.ok) return [];
    return nettoyerIce(await r.json());
  } catch {
    return [];
  }
}
