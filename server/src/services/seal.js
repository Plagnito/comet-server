// Scellement symétrique côté serveur : chiffre les secrets (mots de passe de comptes
// externes) au repos. La clé dérive d'un secret serveur (COMET_MAIL_SECRET ou JWT_SECRET).
// Ce n'est PAS du zéro-knowledge — le serveur doit pouvoir s'authentifier en IMAP/SMTP —
// mais un vol de la base seule ne suffit pas (il faut aussi le secret d'environnement).
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { MAIL_SECRET } from '../config.js';

const KEY = createHash('sha256').update(MAIL_SECRET).digest();

export function seal(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function unseal(sealed) {
  const buf = Buffer.from(String(sealed), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const d = createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
