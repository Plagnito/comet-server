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
// boîte et peut lire TOUT l'historique ; (3) retirer un membre suffit à lui couper l'accès.
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
