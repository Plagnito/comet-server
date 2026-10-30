import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const checked = (value) => {
  const token = value.trim();
  if (token.length < 32 || token.length > 256) throw new Error('Code bootstrap invalide : 32 à 256 caractères requis');
  return token;
};

export function resolveBootstrapToken(raw, dataDir) {
  if (raw !== undefined) return checked(raw);
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, '.bootstrap_token');
  try {
    writeFileSync(path, randomBytes(48).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  // Préserver un fichier existant. Une valeur vide/invalide fait échouer le
  // démarrage ; elle n'est jamais remplacée silencieusement.
  return checked(readFileSync(path, 'utf8'));
}

export function matchesBootstrapToken(value, expected) {
  if (typeof value !== 'string') return false;
  const input = Buffer.from(value.trim());
  const reference = Buffer.from(expected);
  return input.length === reference.length && timingSafeEqual(input, reference);
}
