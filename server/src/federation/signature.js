// Fédération — signatures Ed25519 des requêtes entre serveurs, et des enregistrements.
//
// Pas de dépendance : node:crypto sait Ed25519. Les clés circulent en SPKI DER base64,
// le même format que WebCrypto importe côté client (`importKey('spki', …, 'Ed25519')`).
//
// Requête signée (inspirée de RFC 9421, sans en reprendre la grammaire) :
//
//   Comet-Emetteur:  serveur-a.fr
//   Comet-Date:      2026-10-30T18:00:00.000Z
//   Comet-Nonce:     22 caractères base64url (128 bits)
//   Content-Digest:  sha-256=:<base64>:
//   Comet-Signature: <base64 Ed25519>
//
// sur la chaîne canonique (une valeur par ligne) :
//
//   comet-federation-v1 / MÉTHODE / hôte destinataire / chemin / émetteur / date / nonce / digest
//
// Signer l'hôte DESTINATAIRE est ce qui empêche un serveur qui reçoit une requête légitime
// de la rejouer telle quelle chez un troisième.
import { createHash, createPublicKey, createPrivateKey, sign, verify, randomBytes, timingSafeEqual } from 'node:crypto';

export const VERSION = 'comet-federation-v1';

export const digestDe = (corps) => `sha-256=:${createHash('sha256').update(corps).digest('base64')}:`;
export const nouveauNonce = () => randomBytes(16).toString('base64url');

export function chaineCanonique({ methode, hote, chemin, emetteur, date, nonce, digest }) {
  return [VERSION, String(methode).toUpperCase(), String(hote).toLowerCase(), chemin, String(emetteur).toLowerCase(), date, nonce, digest].join('\n');
}

const pub = (b64) => createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
export const priv = (der) => createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });

export function signer(clePrivee, texte) {
  return sign(null, Buffer.from(texte, 'utf8'), clePrivee).toString('base64');
}

export function verifier(clePubliqueB64, texte, signatureB64) {
  try {
    const sig = Buffer.from(String(signatureB64 || ''), 'base64');
    if (sig.length !== 64) return false;
    const k = pub(clePubliqueB64);
    if (k.asymmetricKeyType !== 'ed25519') return false;
    return verify(null, Buffer.from(texte, 'utf8'), k, sig);
  } catch {
    return false;
  }
}

export function digestCorrespond(corps, digestAnnonce) {
  const a = Buffer.from(digestDe(corps));
  const b = Buffer.from(String(digestAnnonce || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

// Empreinte lisible d'une clé de serveur : SHA-256 de la clé, 8 groupes de 4 hexa.
export function empreinte(clePubliqueB64) {
  const h = createHash('sha256').update(Buffer.from(String(clePubliqueB64), 'base64')).digest('hex').toUpperCase();
  return h.slice(0, 32).match(/.{4}/g).join(' ');
}

// ── Enregistrements signés (hors requête) ────────────────────────────────────
// Clé publique d'un compte, telle que son serveur l'atteste. Le client la vérifie avec la
// clé du serveur : son propre serveur, qui la lui relaie, ne peut pas la remplacer.
export const texteCle = ({ adresse, cle, date }) => ['comet-cle-v1', String(adresse).toLowerCase(), cle, date].join('\n');
// Rotation : la NOUVELLE clé du domaine, signée par l'ANCIENNE.
export const texteRotation = ({ domaine, nouvelle, date }) => ['comet-rotation-v1', String(domaine).toLowerCase(), nouvelle, date].join('\n');

// Chaîne de rotations : relie une clé connue (`depuis`) à la clé présentée (`jusqua`) par
// des étapes { ancienne, nouvelle, date, signature }, chacune signée par son ANCIENNE clé.
// Rend les étapes du chemin trouvé, ou null. Un parcours en profondeur suffit : si une
// ancienne clé a signé deux successeurs, seul celui qui mène à la clé présentée compte.
// Même règle, à l'identique, côté appareil (client/src/crypto.js : suivreRotationsServeur).
export const ROTATIONS_MAX = 50;
export function suivreRotations({ domaine, depuis, jusqua, etapes, verifierSignature = verifier }) {
  if (!depuis || !jusqua) return null;
  if (depuis === jusqua) return [];
  const valides = (Array.isArray(etapes) ? etapes : []).slice(0, ROTATIONS_MAX * 4).filter((e) => e
    && typeof e.ancienne === 'string' && typeof e.nouvelle === 'string' && typeof e.date === 'string'
    && typeof e.signature === 'string' && e.ancienne !== e.nouvelle);
  const vues = new Set();
  const chercher = (cle, profondeur) => {
    if (cle === jusqua) return [];
    if (profondeur >= ROTATIONS_MAX || vues.has(cle)) return null;
    vues.add(cle);
    for (const e of valides) {
      if (e.ancienne !== cle) continue;
      if (!verifierSignature(e.ancienne, texteRotation({ domaine, nouvelle: e.nouvelle, date: e.date }), e.signature)) continue;
      const suite = chercher(e.nouvelle, profondeur + 1);
      if (suite) return [e, ...suite];
    }
    return null;
  };
  return chercher(depuis, 0);
}
