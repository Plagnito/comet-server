// Verrou local de l'application par code PIN (haché PBKDF2). Indépendant de la session
// serveur : c'est un écran de protection (épaule / accès physique). Le code n'est jamais
// stocké en clair ; l'état verrouillé persiste au rechargement.
const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const b64 = (buf) => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); };
const ub64 = (str) => { const bin = atob(str); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; };

const PIN_KEY = 'comet.lock';
const TIMEOUT_KEY = 'comet.lock.timeout';
const LOCKED_KEY = 'comet.locked';

export const hasPIN = () => !!localStorage.getItem(PIN_KEY);

async function derive(pin, saltB64) {
  const base = await subtle.importKey('raw', te.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', salt: ub64(saltB64), iterations: 200000, hash: 'SHA-256' }, base, 256);
  return b64(bits);
}

export async function setPIN(pin) {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  localStorage.setItem(PIN_KEY, JSON.stringify({ salt, hash: await derive(pin, salt) }));
}
export function removePIN() { localStorage.removeItem(PIN_KEY); localStorage.removeItem(LOCKED_KEY); }
export async function verifyPIN(pin) {
  const s = JSON.parse(localStorage.getItem(PIN_KEY) || 'null');
  if (!s) return false;
  return (await derive(pin, s.salt)) === s.hash;
}

export const getTimeoutMin = () => Number(localStorage.getItem(TIMEOUT_KEY) ?? 5);
export const setTimeoutMin = (m) => localStorage.setItem(TIMEOUT_KEY, String(m));
export const isLockedPersisted = () => hasPIN() && localStorage.getItem(LOCKED_KEY) === '1';
export const persistLocked = (v) => { if (v) localStorage.setItem(LOCKED_KEY, '1'); else localStorage.removeItem(LOCKED_KEY); };
