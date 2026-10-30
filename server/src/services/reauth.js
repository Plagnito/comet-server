import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import { db } from '../db.js';
import { verifyPassword, userForSession } from '../auth.js';
import { JWT_SECRET } from '../config.js';
import { verifyTotp } from './totp.js';
import { AppError } from '../util/errors.js';
import { assertProofAllowed, failedProof, clearProofFailures } from './auth-attempts.js';

const denied = () => new AppError('Vérifiez votre mot de passe actuel et votre facteur de sécurité.', { status: 403, code: 'reauth_required' });
const pendingHash = (user) => createHash('sha256').update(user.pending_totp_secret || '').digest('hex');

export function consumeRecoveryCode(user, input) {
  const code = typeof input === 'string' ? input.trim().toUpperCase() : '';
  if (!/^[0-9A-F]{5}-[0-9A-F]{5}$/.test(code)) return false;
  let codes;
  try { codes = JSON.parse(user.recovery_codes || '[]'); } catch { return false; }
  if (!Array.isArray(codes)) return false;
  const index = codes.findIndex((hash) => typeof hash === 'string' && verifyPassword(code, hash));
  if (index < 0) return false;
  codes.splice(index, 1);
  return db.prepare('UPDATE users SET recovery_codes = ? WHERE id = ? AND recovery_codes = ?')
    .run(JSON.stringify(codes), user.id, user.recovery_codes).changes === 1;
}

export function enrollmentToken(user) {
  return jwt.sign({ id: user.id, av: user.auth_version, purpose: 'mfa-setup', pending: pendingHash(user) }, JWT_SECRET, { expiresIn: '10m' });
}
function validEnrollment(token, user) {
  try {
    const claim = jwt.verify(token, JWT_SECRET);
    return claim.purpose === 'mfa-setup' && claim.id === user.id && claim.av === user.auth_version
      && user.pending_totp_secret && user.pending_totp_until > Date.now() && claim.pending === pendingHash(user);
  } catch { return false; }
}

// Vérification, consommation d'un éventuel code, mutation et révocation forment
// une transaction. Une preuve ne peut pas valider un ancien état concurrent.
export function securityChange(req, mutation, { proof = 'password-factor', validate } = {}) {
  const body = req.body || {};
  db.exec('BEGIN IMMEDIATE');
  try {
    const user = userForSession(req.authPayload);
    if (!user) throw new AppError('Session révoquée', { status: 401, code: 'session_revoked' });
    assertProofAllowed(user.id, 'change');
    validate?.(user);
    if (proof === 'enrollment') {
      if (!validEnrollment(body.setupToken, user) || !verifyTotp(user.pending_totp_secret, body.code)) throw denied();
    } else {
      const password = body.currentPassword;
      const passwordOk = user.password_set && typeof password === 'string' && password.length <= 200 && verifyPassword(password, user.password_hash);
      const factorNeeded = user.totp_enabled && proof !== 'initial-keys';
      const factorOnly = proof === 'recovery-reset' && user.totp_enabled;
      if (!factorOnly && !passwordOk) throw denied();
      if (factorNeeded && !(user.totp_secret && verifyTotp(user.totp_secret, body.currentCode))
        && !consumeRecoveryCode(user, body.currentCode)) throw denied();
    }
    const data = mutation(user);
    clearProofFailures(user.id, 'change');
    db.prepare('UPDATE users SET auth_version = auth_version + 1 WHERE id = ?').run(user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    db.exec('COMMIT');
    return { data, user: db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) };
  } catch (error) {
    if (error.code === 'reauth_required') {
      failedProof(req.user.id, 'change'); db.exec('COMMIT');
    } else db.exec('ROLLBACK');
    throw error;
  }
}
