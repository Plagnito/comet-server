import { Router } from 'express';
import { db } from '../db.js';
import { authRequired } from '../auth.js';

const router = Router();
router.use(authRequired);

const view = (n) => ({
  id: n.id,
  title: n.title,
  body: n.body,
  color: n.color,
  pinned: !!n.pinned,
  updatedAt: n.updated_at,
  createdAt: n.created_at,
});

router.get('/', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  let sql = 'SELECT * FROM notes WHERE owner_id = ?';
  const params = [req.user.id];
  if (q) { sql += ' AND (LOWER(title) LIKE ? OR LOWER(body) LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY pinned DESC, updated_at DESC';
  res.json({ notes: db.prepare(sql).all(...params).map(view) });
});

router.post('/', (req, res) => {
  const { title = '', body = '', color = '#fff3b0', pinned = false } = req.body;
  const info = db
    .prepare('INSERT INTO notes (owner_id, title, body, color, pinned) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, title, body, color, pinned ? 1 : 0);
  res.status(201).json({ note: view(db.prepare('SELECT * FROM notes WHERE id = ?').get(info.lastInsertRowid)) });
});

router.patch('/:id', (req, res) => {
  const n = db.prepare('SELECT * FROM notes WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
  if (!n) return res.status(404).json({ error: 'Note introuvable' });
  const map = { title: 'title', body: 'body', color: 'color' };
  const sets = [], params = [];
  for (const [k, col] of Object.entries(map)) if (k in req.body) { sets.push(`${col} = ?`); params.push(req.body[k]); }
  if ('pinned' in req.body) { sets.push('pinned = ?'); params.push(req.body.pinned ? 1 : 0); }
  if (!sets.length) return res.status(400).json({ error: 'Rien à modifier' });
  sets.push("updated_at = datetime('now')");
  params.push(n.id);
  db.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  res.json({ note: view(db.prepare('SELECT * FROM notes WHERE id = ?').get(n.id)) });
});

router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM notes WHERE id = ? AND owner_id = ?').run(req.params.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Note introuvable' });
  res.json({ ok: true });
});

export default router;
