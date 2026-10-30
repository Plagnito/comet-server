// Ce qu'un courrier venu du dehors a le droit de faire, et ce qu'on peut en lire.
//
// Rendre le HTML d'un e-mail, c'est mettre à l'écran du contenu écrit par n'importe qui,
// arrivé sans invitation. Toute la difficulté tient dans une phrase : **un pixel espion
// est une image transparente de 1×1, et l'écran est rigoureusement identique qu'on l'ait
// chargée ou non**. Aucune relecture, aucun essai à l'œil ne peut établir que rien n'est
// parti — la régression se verrait chez l'expéditeur, qui saurait quand et combien de
// fois le message a été ouvert. C'est pourquoi la décision vit ICI, dans un module PUR
// (aucun DOM, aucun React) : c'est la seule forme qui s'éprouve par des tests.
//
// Portage de `PolitiqueContenuDistant` (Comet Mail Android) et de la visionneuse de
// Comet Entreprise. Le contrat est le même que le consentement réseau du Tableur :
// rien ne part tant que le lecteur n'a pas dit oui, et quand on le lui demande,
// on NOMME les domaines.

// ── Ce qui sort de la machine ────────────────────────────────────────────────

/**
 * Une adresse qui **sort de la machine**.
 *
 * `data:` n'en est pas une : l'image est déjà dans le message, la charger ne prévient
 * personne. La bloquer casserait les logos et signatures incorporés sans rien protéger.
 * `cid:` non plus — c'est une pièce du message lui-même.
 */
export function estDistante(url) {
  const u = String(url || '').trim().toLowerCase();
  return u.startsWith('http://') || u.startsWith('https://');
}

/**
 * Le nom d'hôte d'une adresse, sans passer par `new URL()` — qui lève sur une adresse
 * mal formée, et un courrier du dehors en contient.
 */
export function hote(url) {
  const s = String(url || '');
  const i = s.indexOf('://');
  if (i < 0) return null;
  const autorite = s.slice(i + 3).split(/[/?#]/)[0];
  // Un identifiant peut précéder l'hôte (`user:mdp@hote`) : sans ce retrait, on
  // nommerait le mot de passe de l'adresse dans le bandeau.
  const brut = autorite.slice(autorite.lastIndexOf('@') + 1);
  // Un port ne fait pas partie du nom, et « [::1] » ne doit pas être coupé sur ses
  // propres deux-points.
  const net = brut.startsWith('[') ? brut.slice(0, brut.indexOf(']') + 1) : brut.split(':')[0];
  return net.trim().toLowerCase() || null;
}

/** L'origine (schéma + hôte + port) telle que la politique de sécurité l'écrit. */
function origine(url) {
  const s = String(url || '').trim();
  const i = s.indexOf('://');
  if (i < 0) return null;
  const schema = s.slice(0, i).toLowerCase();
  const autorite = s.slice(i + 3).split(/[/?#]/)[0];
  const net = autorite.slice(autorite.lastIndexOf('@') + 1).trim().toLowerCase();
  // Une origine ne doit contenir ni guillemet ni espace : ce sont les séparateurs de la
  // politique de sécurité, et un caractère égaré y ouvrirait une seconde directive.
  if (!net || /[\s;'"]/.test(net)) return null;
  return schema + '://' + net;
}

// Les attributs qui déclenchent une requête TOUT SEULS, à l'affichage. `href` n'en est
// pas un : un lien ne prévient personne tant qu'on ne le suit pas.
const ATTRS_RESSOURCE = /\s(?:src|background|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const SRCSET = /\ssrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/gi;

/**
 * Tout ce que ce message irait chercher au-dehors s'il était affiché tel quel.
 *
 * ⚠️ **Ce relevé ne bloque rien** — il ne sert qu'à NOMMER les domaines, et à dresser la
 * liste blanche que le lecteur autorise. Le blocage, lui, est tenu par le navigateur
 * (politique de sécurité du contenu). C'est ce qui rend un oubli inoffensif dans les deux
 * sens : une adresse que ce relevé rate n'est pas nommée, et elle ne se charge pas non
 * plus — même après un « oui », puisque l'autorisation ne porte que sur les origines
 * listées ici.
 *
 * @returns {{hotes: string[], origines: string[]}} triés, sans doublon.
 */
export function ressourcesDistantes(html) {
  const s = String(html || '');
  const hotes = new Set();
  const origines = new Set();
  const retenir = (url) => {
    if (!estDistante(url)) return;
    const h = hote(url);
    const o = origine(url);
    if (h) hotes.add(h);
    if (o) origines.add(o);
  };

  for (const m of s.matchAll(ATTRS_RESSOURCE)) retenir(m[1] ?? m[2] ?? m[3]);
  for (const m of s.matchAll(SRCSET)) {
    // « url 1x, url2 2x » : le descripteur suit l'adresse, séparé par une espace.
    for (const c of String(m[1] ?? m[2] ?? '').split(',')) retenir(c.trim().split(/\s+/)[0]);
  }
  for (const m of s.matchAll(CSS_URL)) retenir((m[1] ?? m[2] ?? m[3] ?? '').trim());

  return { hotes: [...hotes].sort(), origines: [...origines].sort() };
}

/**
 * La phrase du bandeau. Elle NOMME les domaines : « ce message veut charger des images »
 * ne dit pas à QUI l'on va parler, et c'est justement ce que le lecteur doit savoir avant
 * d'accepter. Au-delà de trois, on compte le reste plutôt que de remplir l'écran d'une
 * liste que personne ne lit.
 */
export function phraseImagesBloquees(hotes) {
  const l = Array.isArray(hotes) ? hotes : [];
  if (l.length === 0) return '';
  const noms = l.slice(0, 3);
  const reste = l.length - noms.length;
  let liste = noms.join(', ');
  if (reste > 0) liste += ' et ' + reste + ' autre' + (reste > 1 ? 's' : '');
  return 'Images bloquées : les afficher préviendra ' + liste + ' que vous avez ouvert ce message.';
}

// ── Le document que l'on affiche ─────────────────────────────────────────────

/**
 * Les permissions du cadre d'affichage.
 *
 * ⚠️ **`allow-scripts` NE DOIT JAMAIS y figurer** — et un test le vérifie. Associé à
 * `allow-same-origin`, il rendrait au message le droit de s'exécuter DANS notre origine :
 * les deux ensemble annulent le bac à sable entier. `allow-same-origin` est ici pour une
 * seule raison, mesurer la hauteur du document depuis la page hôte (sans quoi le courrier
 * se lirait par un hublot à défilement, faute de pouvoir exécuter le moindre script) ;
 * seul, il n'accorde aucun pouvoir à un document qui ne peut rien exécuter.
 *
 * `allow-popups-to-escape-sandbox` : un lien s'ouvre dans un onglet ORDINAIRE, avec sa
 * barre d'adresse. Une visionneuse qui navigue elle-même est un navigateur sans barre
 * d'adresse — de quoi faire saisir un mot de passe sur une page dont personne ne peut
 * lire l'URL.
 */
export const BAC_A_SABLE = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';

/**
 * La politique de sécurité du contenu — le verrou qui, lui, est tenu par le navigateur.
 *
 * @param origines les origines que le lecteur a explicitement autorisées. Vide = rien ne
 *   sort. Après un « oui », l'autorisation ne vaut QUE pour les origines nommées dans le
 *   bandeau : ce qui n'a pas été montré au lecteur ne se charge pas davantage.
 */
export function politiqueSecurite(origines = []) {
  const externes = origines.length ? ' ' + origines.join(' ') : '';
  return [
    "default-src 'none'",
    "script-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    // Les styles en ligne font la mise en page de tout courrier ; ils n'émettent aucune
    // requête par eux-mêmes, et ce qu'ils appellent retombe sous les directives ci-dessous.
    "style-src 'unsafe-inline'",
    'img-src data:' + externes,
    'media-src data:' + externes,
    'font-src data:' + externes,
  ].join('; ');
}

// Ce que l'on retire du message avant de l'afficher. Ce n'est PAS la barrière — le bac à
// sable et la politique de sécurité le sont — mais deux de ces retraits comptent vraiment :
// `<meta http-equiv="refresh">` ferait naviguer le cadre vers une adresse distante (ni le
// bac à sable ni la politique n'interdisent à un document de se déplacer lui-même), et
// `<base>` réécrirait la résolution de toutes les adresses relatives.
const A_RETIRER = [
  /<script\b[\s\S]*?<\/script\s*>/gi,
  /<script\b[^>]*>/gi,
  /<(?:meta|base|link)\b[^>]*>/gi,
  /<\/?(?:html|head|body)\b[^>]*>/gi,
];

/** Le message, débarrassé de ce qui ne doit pas atteindre le cadre d'affichage. */
export function nettoyer(html) {
  let t = String(html || '');
  for (const re of A_RETIRER) t = t.replace(re, '');
  return t;
}

/**
 * Le document complet à donner au cadre d'affichage : la politique de sécurité, les
 * couleurs du thème, et une largeur qui tient dans le volet de lecture.
 */
export function documentCourriel(html, { origines = [], couleurs = {} } = {}) {
  const fond = couleurs.fond || '#ffffff';
  const texte = couleurs.texte || '#334155';
  const lien = couleurs.lien || '#4f46e5';
  return '<!doctype html><html><head><meta charset="utf-8">\n'
    + '<meta http-equiv="Content-Security-Policy" content="' + politiqueSecurite(origines) + '">\n'
    + '<base target="_blank">\n'
    + '<style>\n'
    + '  html,body{margin:0;padding:14px 4px;background:' + fond + ';color:' + texte + ';\n'
    + "    font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.6;\n"
    + '    word-break:break-word;overflow-wrap:anywhere}\n'
    + '  a{color:' + lien + '}\n'
    // Un courrier bâti sur un tableau de 600 px déborde du volet de lecture : images et
    // tableaux se réduisent au lieu d'imposer un défilement horizontal au message entier.
    + '  img,table,td{max-width:100%!important;height:auto}\n'
    + '  table{table-layout:auto!important}\n'
    // Une image bloquée ne laisse pas de cadre cassé : rien du tout est plus clair.
    + '  img:not([src^="data:"]){min-width:0}\n'
    + '</style></head><body>' + nettoyer(html) + '</body></html>';
}

// ── Lire un courrier qui n'a que du HTML ─────────────────────────────────────

const BLOCS_MUETS = /<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi;
const SAUTS = /<\/(?:p|div|tr|li|h[1-6]|blockquote)>|<br\s*\/?>|<hr\s*\/?>/gi;
const BALISES = /<[^>]*>/g;

const ENTITES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â',
  ccedil: 'ç', ugrave: 'ù', ucirc: 'û', icirc: 'î', iuml: 'ï', ocirc: 'ô',
  oelig: 'œ', euro: '€', laquo: '«', raquo: '»', hellip: '…', rsquo: '’',
  lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—',
  copy: '©', reg: '®', trade: '™', deg: '°', middot: '·', bull: '•',
};

function decoderEntites(s) {
  if (!s.includes('&')) return s;
  // Le numérique d'abord : une entité peut coder un caractère qui ressemble à une balise,
  // et le décoder AVANT le retrait des balises le ferait disparaître.
  let t = s.replace(/&#(x?)([0-9a-fA-F]+);/gi, (tout, hex, brut) => {
    const point = parseInt(brut, hex ? 16 : 10);
    if (!Number.isFinite(point) || point < 1 || point > 0x10ffff) return tout;
    try { return String.fromCodePoint(point); } catch { return tout; }
  });
  t = t.replace(/&([a-z]+);/gi, (tout, nom) => ENTITES[nom.toLowerCase()] ?? tout);
  return t;
}

/**
 * Tire un texte lisible d'un courrier écrit en HTML.
 *
 * Sert à deux choses, et à rien d'autre : l'aperçu d'une liste, et le repli quand un
 * message n'a AUCUNE version texte — le cas ordinaire d'un envoi commercial, où tout vit
 * dans le HTML. **Ce n'est pas un rendu** : aucune balise n'est interprétée, aucune
 * adresse distante n'est jointe.
 */
export function texteDepuisHtml(html) {
  let t = String(html || '');
  t = t.replace(BLOCS_MUETS, ' ');
  t = t.replace(SAUTS, '\n');
  t = t.replace(BALISES, '');
  t = decoderEntites(t);
  // Les espaces insécables des gabarits d'e-mail servent à la mise en page : gardés tels
  // quels, ils laissent des lignes « vides » qui ne le sont pas, et le texte paraît troué.
  t = t.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n');
  // L'indentation du source HTML n'a aucun sens une fois en texte : gardée, elle décale
  // les lignes d'une citation de réponse et fait passer un message ordinaire pour du code.
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

/** `true` si le document ne porte aucun texte — un gabarit tout en images, par exemple. */
export function htmlEstVide(html) {
  return !html || texteDepuisHtml(html).trim() === '';
}

// ── Les expéditeurs à qui l'on fait confiance ────────────────────────────────

/**
 * L'adresse nue d'un expéditeur, telle qu'on la compare.
 *
 * Un en-tête « De » arrive sous des formes variées (`Nom <a@b.fr>`, majuscules,
 * espaces). Sans normalisation, `Lettre@Gazette.fr` et `lettre@gazette.fr` seraient deux
 * expéditeurs différents : le lecteur autoriserait le premier et se verrait redemander
 * l'autorisation au message suivant, sans comprendre pourquoi.
 */
export function normaliserExpediteur(brut) {
  let s = String(brut || '').trim();
  const chevron = s.lastIndexOf('<');
  if (chevron >= 0 && s.indexOf('>', chevron) > chevron) {
    s = s.slice(chevron + 1, s.indexOf('>', chevron));
  }
  s = s.trim().toLowerCase();
  // Une adresse sans arobase n'en est pas une : la retenir laisserait entrer une entrée
  // qui ne correspondrait jamais à rien, ou pire, correspondrait à tout.
  return /^[^\s@]+@[^\s@]+$/.test(s) ? s : null;
}

/**
 * `true` si le lecteur a demandé à voir TOUJOURS les images de cet expéditeur.
 *
 * ⚠️ La comparaison est **exacte**, jamais par suffixe : `gazette.fr` autorisé ne doit
 * PAS autoriser `lettre@fausse-gazette.fr`. Et rappel : une adresse d'expéditeur n'est
 * pas authentifiée — la confiance porte sur ce qui est ÉCRIT dans le message, ce que la
 * page des réglages dit franchement.
 *
 * ⚠️ Faire confiance à un expéditeur n'ouvre pas le réseau : ça donne d'avance le « oui »
 * du bandeau, et ce oui reste borné aux origines trouvées DANS ce message-là.
 */
export function estExpediteurDeConfiance(liste, expediteur) {
  const e = normaliserExpediteur(expediteur);
  if (!e || !Array.isArray(liste)) return false;
  return liste.some((x) => normaliserExpediteur(x) === e);
}

/** Ajoute un expéditeur à la liste, sans doublon, en gardant l'ordre d'ajout. */
export function avecExpediteur(liste, expediteur) {
  const e = normaliserExpediteur(expediteur);
  const base = (Array.isArray(liste) ? liste : []).map(normaliserExpediteur).filter(Boolean);
  if (!e || base.includes(e)) return base;
  return [...base, e];
}

/** Retire un expéditeur de la liste. */
export function sansExpediteur(liste, expediteur) {
  const e = normaliserExpediteur(expediteur);
  return (Array.isArray(liste) ? liste : []).map(normaliserExpediteur).filter((x) => x && x !== e);
}
