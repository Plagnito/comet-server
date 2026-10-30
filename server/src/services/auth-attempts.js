import { db } from '../db.js';
import { AppError } from '../util/errors.js';

const WINDOW = 15 * 60_000;
const LIMIT = 5;
db.exec(`CREATE TABLE IF NOT EXISTS auth_proof_attempts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  failures INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, scope)
)`);

// Appelé dans la transaction de preuve : commun à tous les processus et toutes
// les IP. Séparer login et changements évite qu'un bearer volé bloque le login.
export function assertProofAllowed(userId, scope) {
  const row = db.prepare('SELECT locked_until FROM auth_proof_attempts WHERE user_id = ? AND scope = ?').get(userId, scope);
  if (row?.locked_until > Date.now()) {
    throw Object.assign(new AppError('Trop d’essais de vérification. Réessayez dans quinze minutes.', { status: 429, code: 'reauth_locked' }),
      { retryAfter: Math.ceil((row.locked_until - Date.now()) / 1000) });
  }
}
export function failedProof(userId, scope) {
  const now = Date.now();
  const previous = db.prepare('SELECT failures, window_start FROM auth_proof_attempts WHERE user_id = ? AND scope = ?').get(userId, scope);
  const current = previous && previous.window_start > now - WINDOW;
  const failures = current ? previous.failures + 1 : 1;
  db.prepare(`INSERT INTO auth_proof_attempts (user_id, scope, failures, window_start, locked_until) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, scope) DO UPDATE SET failures = excluded.failures, window_start = excluded.window_start, locked_until = excluded.locked_until`)
    .run(userId, scope, failures, current ? previous.window_start : now, failures >= LIMIT ? now + WINDOW : 0);
}
export function clearProofFailures(userId, scope) {
  db.prepare('DELETE FROM auth_proof_attempts WHERE user_id = ? AND scope = ?').run(userId, scope);
}
