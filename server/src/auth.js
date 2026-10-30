import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { db } from './db.js';
import { JWT_SECRET, JWT_EXPIRE } from './config.js';

const SECRET = JWT_SECRET;
const EXPIRE = JWT_EXPIRE;

export const hashPassword = (pw) => bcrypt.hashSync(pw, 10);
export const verifyPassword = (pw, hash) => bcrypt.compareSync(pw, hash);

export function signToken(user, sid) {
  return jwt.sign({ id: user.id, email: user.email, sid }, SECRET, { expiresIn: EXPIRE });
}

// Jeton temporaire émis après le mot de passe quand la 2FA est requise (5 min)
export function signTmpToken(user) {
  return jwt.sign({ id: user.id, twofa: 'pending' }, SECRET, { expiresIn: '5m' });
}
export function verifyTmpToken(token) {
  try {
    const p = jwt.verify(token, SECRET);
    return p.twofa === 'pending' ? p : null;
  } catch {
    return null;
  }
}

// Vue publique d'un utilisateur (jamais le hash ni la clé privée)
export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    avatarColor: u.avatar_color,
    isSystem: !!u.is_system,
    publicKey: u.public_key || null,
    twoFactorEnabled: !!u.totp_enabled,
    signature: u.signature || '',
    away: { enabled: !!u.away_enabled, message: u.away_message || '', until: u.away_until || null },
    presence: u.presence || 'available',
    jobTitle: u.job_title || '',
    department: u.department || '',
    isAdmin: !!u.is_admin,
    canPipelines: !!u.can_pipelines,
    listed: !!u.listed,
    // Organisation : null = sans org (Comet personnel).
    orgId: u.org_id || null,
    orgName: u.org_name || null,
    orgRole: u.org_role || null,
    // false = compte créé sans mot de passe choisi (à définir pour le E2EE).
    passwordSet: u.password_set !== 0,
    // true = adresse e-mail encore provisoire (compte SSO sans adresse Comet choisie).
    needsCometEmail: !!u.email_provisional,
  };
}

// Garde « fonctionnalité d'organisation » : refuse l'accès si l'utilisateur n'a
// rejoint aucune organisation (Comet personnel uniquement). À appliquer APRÈS
// authRequired sur les routes réservées aux membres d'une org (espaces de projet,
// rapports, conférences d'équipe…). Plus d'« entreprise par défaut ».
export function orgRequired(req, res, next) {
  if (!req.user || !req.user.org_id) {
    return res.status(403).json({ error: 'Rejoignez une organisation pour accéder à cette fonctionnalité.', code: 'no_org' });
  }
  next();
}

export function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentification requise' });
  try {
    const payload = jwt.verify(token, SECRET);
    if (payload.twofa === 'pending') return res.status(401).json({ error: 'Vérification 2FA requise' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
    if (!user) return res.status(401).json({ error: 'Session invalide' });
    // Session révocable : si le jeton porte un sid, la session doit exister
    if (payload.sid) {
      const sess = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(payload.sid, user.id);
      if (!sess) return res.status(401).json({ error: 'Session révoquée' });
      db.prepare("UPDATE sessions SET last_seen = datetime('now') WHERE id = ?").run(payload.sid);
      req.sessionId = payload.sid;
    }
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Session expirée ou invalide' });
  }
}
