import { Router } from 'express';
import { db } from '../db.js';
import { authRequired } from '../auth.js';
import { isOnline, onlineUserIds } from '../ws.js';

const router = Router();
router.use(authRequired);
router.use((req, res, next) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Accès réservé aux administrateurs' });
  next();
});

const count = (sql, ...p) => db.prepare(sql).get(...p)?.n ?? 0;

// ── Statistiques globales ───────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  res.json({
    users: count('SELECT COUNT(*) AS n FROM users WHERE is_system = 0'),
    online: onlineUserIds().length,
    messages: count('SELECT COUNT(*) AS n FROM messages'),
    sessions: count('SELECT COUNT(*) AS n FROM sessions'),
    pendingAttachments: count('SELECT COUNT(*) AS n FROM attachments'),
    twoFactor: count('SELECT COUNT(*) AS n FROM users WHERE totp_enabled = 1'),
  });
});

// ── Liste des comptes ───────────────────────────────────────────────────────
router.get('/users', (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.email, u.display_name AS displayName, u.created_at AS createdAt,
           u.is_admin AS isAdmin, u.totp_enabled AS twoFactor, u.is_system AS isSystem,
           u.can_pipelines AS canPipelines,
           (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS sessions,
           (SELECT MAX(s.last_seen) FROM sessions s WHERE s.user_id = u.id) AS lastSeen
    FROM users u ORDER BY u.is_system ASC, u.created_at ASC
  `).all();
  res.json({
    users: rows.map((u) => ({
      id: u.id, email: u.email, displayName: u.displayName, createdAt: u.createdAt,
      isAdmin: !!u.isAdmin, twoFactor: !!u.twoFactor, isSystem: !!u.isSystem,
      canPipelines: !!u.canPipelines,
      sessions: u.sessions, lastSeen: u.lastSeen, online: isOnline(u.id),
    })),
  });
});

// ── Modifier un compte (droits admin) ───────────────────────────────────────
router.patch('/users/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Compte introuvable' });
  if (typeof req.body.isAdmin === 'boolean') {
    if (u.id === req.user.id && !req.body.isAdmin) return res.status(400).json({ error: 'Vous ne pouvez pas retirer vos propres droits' });
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(req.body.isAdmin ? 1 : 0, u.id);
  }
  if (typeof req.body.canPipelines === 'boolean') {
    db.prepare('UPDATE users SET can_pipelines = ? WHERE id = ?').run(req.body.canPipelines ? 1 : 0, u.id);
  }
  res.json({ ok: true });
});

// ── Supprimer un compte ─────────────────────────────────────────────────────
router.delete('/users/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Compte introuvable' });
  if (u.is_system) return res.status(400).json({ error: 'Compte système non supprimable' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'Vous ne pouvez pas vous supprimer vous-même' });

  // Nettoie les références sans ON DELETE CASCADE puis supprime (transaction)
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM messages WHERE sender_id = ?').run(u.id); // cascade recipients/mail_items/message_keys liés
    db.prepare('DELETE FROM mail_items WHERE user_id = ?').run(u.id);
    db.prepare('DELETE FROM recipients WHERE user_id = ?').run(u.id);
    db.prepare('DELETE FROM message_keys WHERE user_id = ?').run(u.id);
    db.prepare('UPDATE tasks SET assignee_id = NULL WHERE assignee_id = ?').run(u.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('[admin] suppression compte échouée:', e);
    return res.status(500).json({ error: 'Suppression impossible', code: 'delete_failed' });
  }
  res.json({ ok: true });
});

export default router;
