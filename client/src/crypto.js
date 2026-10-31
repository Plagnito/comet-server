// Chiffrement de bout en bout — WebCrypto, 100 % côté navigateur.
// RSA-OAEP par utilisateur (clé publique en clair, clé privée enveloppée par le mot de passe).
// Chaque message : AES-GCM aléatoire, dont la clé est enveloppée pour chaque lecteur via sa clé publique RSA.
const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

const b64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};
const ub64 = (str) => {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

export function normalizeEmail(raw) {
  let e = String(raw || '').trim().toLowerCase();
  if (!e) return '';
  if (!e.includes('@')) e = `${e}@comet.mail`;
  return e;
}

export async function generateKeyPair() {
  return subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
}

export const exportPublicKey = async (kp) => b64(await subtle.exportKey('spki', kp.publicKey));

async function deriveWrapKey(password, salt) {
  const base = await subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// Enveloppe la clé privée avec une clé dérivée du mot de passe → stockée côté serveur sous forme illisible.
export async function wrapPrivateKey(kp, password) {
  const pkcs8 = await subtle.exportKey('pkcs8', kp.privateKey);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wk = await deriveWrapKey(password, salt);
  const data = await subtle.encrypt({ name: 'AES-GCM', iv }, wk, pkcs8);
  return JSON.stringify({ salt: b64(salt), iv: b64(iv), data: b64(data) });
}

export async function unwrapPrivateKey(encJson, password) {
  const { salt, iv, data } = JSON.parse(encJson);
  const wk = await deriveWrapKey(password, ub64(salt));
  const pkcs8 = await subtle.decrypt({ name: 'AES-GCM', iv: ub64(iv) }, wk, ub64(data));
  return subtle.importKey('pkcs8', pkcs8, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['decrypt']);
}

const importPublicKey = (b) => subtle.importKey('spki', ub64(b), { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['encrypt']);

// Cache de la clé privée déverrouillée (JWK) pour la session, sur l'appareil.
export const exportPrivateJwk = async (priv) => JSON.stringify(await subtle.exportKey('jwk', priv));
export const importPrivateJwk = (jwk) => subtle.importKey('jwk', JSON.parse(jwk), { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['decrypt']);

/**
 * Chiffre { subject, body } et enveloppe la clé AES pour chaque lecteur.
 * @param {object} obj  { subject, body }
 * @param {Object<string,string>} pubKeysByEmail  email → clé publique base64
 * @returns {{ ciphertext, iv, keys: Object<string,string> }}
 */
export async function encryptMessage(obj, pubKeysByEmail) {
  const aes = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, aes, te.encode(JSON.stringify(obj)));
  const raw = await subtle.exportKey('raw', aes);
  const keys = {};
  for (const [email, pub] of Object.entries(pubKeysByEmail)) {
    if (!pub) continue;
    keys[email] = b64(await subtle.encrypt({ name: 'RSA-OAEP' }, await importPublicKey(pub), raw));
  }
  return { ciphertext: b64(ct), iv: b64(iv), keys };
}

// ── Clé de canal (chat d'équipe) ─────────────────────────────────────────────
// Une clé AES symétrique par canal, distribuée à chaque membre (enveloppée par sa clé
// publique RSA). Les messages sont chiffrés avec la clé de canal (rapide, symétrique).
export const randomChannelKey = () => b64(crypto.getRandomValues(new Uint8Array(32)));

export async function wrapKeyFor(keyB64, publicKeyB64) {
  const pub = await importPublicKey(publicKeyB64);
  return b64(await subtle.encrypt({ name: 'RSA-OAEP' }, pub, ub64(keyB64)));
}
export async function unwrapKey(wrappedB64, privateKey) {
  return b64(await subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, ub64(wrappedB64)));
}
export async function encryptWithKeyB64(obj, keyB64) {
  const key = await subtle.importKey('raw', ub64(keyB64), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj)));
  return { ciphertext: b64(ct), iv: b64(iv) };
}
export async function decryptWithKeyB64(ciphertext, ivB64, keyB64) {
  const key = await subtle.importKey('raw', ub64(keyB64), 'AES-GCM', false, ['decrypt']);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: ub64(ivB64) }, key, ub64(ciphertext));
  return JSON.parse(td.decode(pt));
}

// ── Identité de boîte partagée ───────────────────────────────────────────────
// Une boîte partagée a sa propre paire RSA (elle reçoit du courrier comme un compte).
// Sa clé privée est chiffrée (AES-GCM) sous une « clé de boîte » symétrique, elle-même
// distribuée à chaque membre enveloppée par SA clé publique RSA (cf. wrapKeyFor/unwrapKey).
// Ainsi : (1) le serveur ne voit que du chiffré ; (2) un nouveau membre reçoit la clé de
// boîte et peut lire TOUT l'historique ; (3) retirer un membre fait tourner les clés
// (preparerRotationBoite) : couper son accès au serveur ne suffirait pas, il connaît la clé.
export async function generateBoxIdentity() {
  const kp = await generateKeyPair();
  const publicKey = await exportPublicKey(kp);
  const boxKey = randomChannelKey(); // AES-256 (base64)
  const wrappedPrivateKey = await wrapPrivateKeyAES(kp.privateKey, boxKey);
  return { publicKey, boxKey, wrappedPrivateKey };
}

export async function wrapPrivateKeyAES(privateKey, keyB64) {
  const pkcs8 = await subtle.exportKey('pkcs8', privateKey);
  const key = await subtle.importKey('raw', ub64(keyB64), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await subtle.encrypt({ name: 'AES-GCM', iv }, key, pkcs8);
  return JSON.stringify({ iv: b64(iv), data: b64(data) });
}
export async function unwrapPrivateKeyAES(json, keyB64) {
  const { iv, data } = JSON.parse(json);
  const key = await subtle.importKey('raw', ub64(keyB64), 'AES-GCM', false, ['decrypt']);
  const pkcs8 = await subtle.decrypt({ name: 'AES-GCM', iv: ub64(iv) }, key, ub64(data));
  return subtle.importKey('pkcs8', pkcs8, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['decrypt']);
}

// Rotation des clés d'une boîte partagée, au retrait d'un membre. Tout se prépare ici,
// sur l'appareil du propriétaire : nouvelle paire de clés et nouvelle clé de boîte ; la
// clé privée actuelle et les plus anciennes, rechiffrées sous la nouvelle clé de boîte
// (la plus récente d'abord) pour garder l'historique lisible ; et la nouvelle clé de boîte
// enveloppée pour chaque membre RESTANT ({ idMembre: cléPubliqueB64 }). L'ex-membre garde
// ce qu'il a déjà lu, mais ne peut rien ouvrir de ce qui arrive après.
export async function preparerRotationBoite({ boxPrivateKey, oldPrivateKeys = [], clesMembres }) {
  const { publicKey, boxKey, wrappedPrivateKey } = await generateBoxIdentity();
  const anciennes = [];
  for (const cle of [boxPrivateKey, ...oldPrivateKeys]) anciennes.push(await wrapPrivateKeyAES(cle, boxKey));
  const members = {};
  for (const [id, pub] of Object.entries(clesMembres)) members[id] = await wrapKeyFor(boxKey, pub);
  return { publicKey, wrappedPrivateKey, oldPrivateKeys: anciennes, members };
}

// Déchiffre avec la première clé qui convient : la clé actuelle d'une boîte, puis ses
// anciennes clés (un message reçu avant une rotation reste chiffré pour l'ancienne).
export async function decryptMessageAvecCles(ciphertext, iv, encKey, cles) {
  for (const cle of cles) {
    if (!cle) continue;
    try { return await decryptMessage(ciphertext, iv, encKey, cle); } catch { /* clé suivante */ }
  }
  throw new Error('Aucune clé de cette boîte ne déchiffre ce message');
}

// Empreinte de sécurité d'une clé publique (à comparer entre correspondants pour
// détecter une substitution de clé / MITM). Déterministe, sous forme de « safety number ».
export async function keyFingerprint(publicKeyB64) {
  if (!publicKeyB64) return '—';
  const hash = new Uint8Array(await subtle.digest('SHA-256', ub64(publicKeyB64)));
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(String(((hash[i] << 8) | hash[i + 1]) % 10000).padStart(4, '0'));
  return groups.join(' ');
}

export async function decryptMessage(ciphertext, iv, encKey, privateKey) {
  const raw = await subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, ub64(encKey));
  const aes = await subtle.importKey('raw', raw, 'AES-GCM', true, ['decrypt']);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: ub64(iv) }, aes, ub64(ciphertext));
  return JSON.parse(td.decode(pt));
}

// ── Fédération entre serveurs Comet ──────────────────────────────────────────
// La clé d'un correspondant d'un AUTRE serveur arrive avec une attestation signée (Ed25519)
// par SON serveur. On la vérifie ici, sur l'appareil : notre propre serveur la relaie mais
// ne peut pas la remplacer sans forger cette signature.
const texteCle = ({ adresse, cle, date }) => ['comet-cle-v1', String(adresse).toLowerCase(), cle, date].join('\n');
const texteRotation = ({ domaine, nouvelle, date }) => ['comet-rotation-v1', String(domaine).toLowerCase(), nouvelle, date].join('\n');

async function verifierEd25519(cleB64, texte, signatureB64) {
  try {
    const cle = await subtle.importKey('spki', ub64(cleB64), { name: 'Ed25519' }, false, ['verify']);
    return await subtle.verify({ name: 'Ed25519' }, cle, ub64(signatureB64), te.encode(texte));
  } catch {
    return false;
  }
}

export const verifierEnregistrementCle = (enr, cleServeurB64) =>
  verifierEd25519(cleServeurB64, texteCle(enr), enr.signature);

export const verifierRotationServeur = (domaine, ancienne, nouvelle, rotation) =>
  !!rotation && rotation.ancienne === ancienne && typeof rotation.date === 'string'
    ? verifierEd25519(ancienne, texteRotation({ domaine, nouvelle, date: rotation.date }), rotation.signature)
    : Promise.resolve(false);

// Chaîne de rotations d'un serveur : de la clé que cet appareil a retenue (`depuis`) à la
// clé présentée (`jusqua`), chaque étape { ancienne, nouvelle, date, signature } signée par
// son ancienne clé. Rend le nombre d'étapes du chemin, ou -1 s'il n'y en a pas. Même règle,
// à l'identique, que server/src/federation/signature.js (suivreRotations).
export const ROTATIONS_MAX = 50;
export async function suivreRotationsServeur(domaine, depuis, jusqua, etapes) {
  if (!depuis || !jusqua) return -1;
  if (depuis === jusqua) return 0;
  const valides = (Array.isArray(etapes) ? etapes : []).slice(0, ROTATIONS_MAX * 4).filter((e) => e
    && typeof e.ancienne === 'string' && typeof e.nouvelle === 'string' && typeof e.date === 'string'
    && typeof e.signature === 'string' && e.ancienne !== e.nouvelle);
  const vues = new Set();
  const chercher = async (cle, profondeur) => {
    if (cle === jusqua) return 0;
    if (profondeur >= ROTATIONS_MAX || vues.has(cle)) return -1;
    vues.add(cle);
    for (const e of valides) {
      if (e.ancienne !== cle) continue;
      if (!(await verifierEd25519(e.ancienne, texteRotation({ domaine, nouvelle: e.nouvelle, date: e.date }), e.signature))) continue;
      const suite = await chercher(e.nouvelle, profondeur + 1);
      if (suite >= 0) return suite + 1;
    }
    return -1;
  };
  return chercher(depuis, 0);
}

// Numéro de sécurité de deux correspondants (60 chiffres, 12 groupes de 5). Chacun apporte
// 30 chiffres tirés de SA clé et de SON adresse (SHA-512 itéré, à la manière de Signal) ;
// les deux moitiés sont rangées dans un ordre fixe, si bien que les deux personnes voient
// EXACTEMENT le même numéro et peuvent le comparer de vive voix.
async function moitie(adresse, cleB64) {
  const ver = new Uint8Array([0, 0]);
  const cle = ub64(cleB64);
  const id = te.encode(String(adresse).toLowerCase());
  let h = new Uint8Array([...ver, ...cle, ...id]);
  for (let i = 0; i < 5200; i++) h = new Uint8Array(await subtle.digest('SHA-512', new Uint8Array([...h, ...cle])));
  let s = '';
  for (let i = 0; i < 30; i += 5) {
    const n = ((h[i] * 2 ** 32) + ((h[i + 1] << 24) >>> 0) + (h[i + 2] << 16) + (h[i + 3] << 8) + h[i + 4]) % 100000;
    s += String(n).padStart(5, '0');
  }
  return s;
}

export async function numeroDeSecurite(adresseA, cleA, adresseB, cleB) {
  if (!cleA || !cleB) return null;
  const [a, b] = await Promise.all([moitie(adresseA, cleA), moitie(adresseB, cleB)]);
  return (a < b ? a + b : b + a).match(/.{5}/g).join(' ');
}
