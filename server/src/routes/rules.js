import { Router } from 'express';
import { db } from '../db.js';
import { authRequired } from '../auth.js';

const router = Router();
router.use(authRequired);

const view = (r) => ({
  id: r.id, matchFrom: r.match_from, actionFolder: r.action_folder || null,
  actionStar: !!r.action_star, actionRead: !!r.action_read, enabled: !!r.enabled,
});
const owned = (id, userId) => db.prepare('SELECT * FROM mail_rules WHERE id = ? AND user_id = ?').get(id, userId);
const cleanFolder = (f) => (f === 'archive' || f === 'trash' ? f : null);

router.get('/', (req, res) => {
  res.json({ rules: db.prepare('SELECT * FROM mail_rules WHERE user_id = ? ORDER BY id').all(req.user.id).map(view) });
});

router.post('/', (req, res) => {
  const matchFrom = String(req.body.matchFrom || '').trim().toLowerCase().slice(0, 120);
  if (!matchFrom) return res.status(400).json({ error: "Expéditeur (email ou domaine) requis" });
  const info = db.prepare('INSERT INTO mail_rules (user_id, match_from, action_folder, action_star, action_read) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, matchFrom, cleanFolder(req.body.actionFolder), req.body.actionStar ? 1 : 0, req.body.actionRead ? 1 : 0);
  res.status(201).json({ rule: view(db.prepare('SELECT * FROM mail_rules WHERE id = ?').get(info.lastInsertRowid)) });
});

router.patch('/:id', (req, res) => {
  const r = owned(req.params.id, req.user.id);
  if (!r) return res.status(404).json({ error: 'Règle introuvable' });
  const sets = [], params = [];
  if ('matchFrom' in req.body) { sets.push('match_from = ?'); params.push(String(req.body.matchFrom).trim().toLowerCase().slice(0, 120)); }
  if ('actionFolder' in req.body) { sets.push('action_folder = ?'); params.push(cleanFolder(req.body.actionFolder)); }
  if ('actionStar' in req.body) { sets.push('action_star = ?'); params.push(req.body.actionStar ? 1 : 0); }
  if ('actionRead' in req.body) { sets.push('action_read = ?'); params.push(req.body.actionRead ? 1 : 0); }
  if ('enabled' in req.body) { sets.push('enabled = ?'); params.push(req.body.enabled ? 1 : 0); }
  if (sets.length) { params.push(r.id); db.prepare(`UPDATE mail_rules SET ${sets.join(', ')} WHERE id = ?`).run(...params); }
  res.json({ rule: view(db.prepare('SELECT * FROM mail_rules WHERE id = ?').get(r.id)) });
});

router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM mail_rules WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Règle introuvable' });
  res.json({ ok: true });
});

export default router;
