/**
 * L'aperçu d'une liste, pour un courrier qui n'a **que** du HTML.
 *
 * Un envoi commercial n'a très souvent aucune version texte : `messages.body` est alors
 * vide, et la liste affiche « Aucun aperçu » sur chaque ligne alors que le message, lui,
 * a bien un contenu. Rien ne signale la perte — c'est indiscernable d'un message
 * réellement vide.
 *
 * ⚠️ **Ce n'est pas un nettoyeur de HTML, et ça ne doit pas en devenir un.** On n'en tire
 * qu'un texte tronqué à 140 caractères, jamais interprété, jamais rendu. L'affichage du
 * HTML se fait côté client, dans un cadre isolé qui coupe les scripts et les ressources
 * distantes (`client/src/mailhtml.js`, `texteDepuisHtml` en est la version complète).
 */
const BLOCS_MUETS = /<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi;

// Jumelle de la table de `client/src/mailhtml.js`. Elle est recopiée plutôt
// qu'importée : un fichier du serveur qui va chercher une source du client tiendrait
// tant que le dépôt entier est déployé, et tomberait sans un mot le jour où le serveur
// serait empaqueté seul. Un aperçu français sans ses accents (« caf&eacute; ») se voit
// dans la liste, lui, donc la table ne peut pas se réduire aux cinq entités de base.
const ENTITES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â',
  ccedil: 'ç', ugrave: 'ù', ucirc: 'û', icirc: 'î', iuml: 'ï', ocirc: 'ô',
  oelig: 'œ', euro: '€', laquo: '«', raquo: '»', hellip: '…', rsquo: '’',
  lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—',
  copy: '©', reg: '®', trade: '™', deg: '°', middot: '·', bull: '•',
};

export function texteDeHtml(html) {
  let t = String(html || '');
  t = t.replace(BLOCS_MUETS, ' ').replace(/<[^>]*>/g, ' ');
  t = t.replace(/&#(x?)([0-9a-fA-F]+);/gi, (tout, hex, brut) => {
    const point = parseInt(brut, hex ? 16 : 10);
    if (!Number.isFinite(point) || point < 1 || point > 0x10ffff) return tout;
    try { return String.fromCodePoint(point); } catch { return tout; }
  });
  t = t.replace(/&([a-z]+);/gi, (tout, nom) => ENTITES[nom.toLowerCase()] ?? tout);
  return t.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * L'aperçu d'un message en clair : son texte, ou à défaut ce que dit son HTML.
 *
 * ⚠️ Reste un EXTRAIT (140 caractères), jamais le corps. Un extrait est indiscernable
 * d'un message court : tout client qui le lit doit réclamer `GET /api/mail/:id` à
 * l'ouverture, et ne jamais laisser une synchronisation ultérieure réécrire un corps
 * déjà complet.
 */
export function apercu(body, bodyHtml) {
  const texte = String(body || '').replace(/\s+/g, ' ').trim();
  return (texte || texteDeHtml(bodyHtml)).slice(0, 140);
}
