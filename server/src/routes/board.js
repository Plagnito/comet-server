import { Router } from 'express';
import { db } from '../db.js';
import { authRequired } from '../auth.js';

const router = Router();
router.use(authRequired);

const STATUSES = ['todo', 'doing', 'done'];
const view = (c) => ({ id: c.id, title: c.title, status: c.status, sort: c.sort, createdAt: c.created_at });

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM board_cards WHERE owner_id = ? ORDER BY sort ASC, id ASC').all(req.user.id);
  res.json({ cards: rows.map(view) });
});

router.post('/', (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Titre requis' });
  const status = STATUSES.includes(req.body.status) ? req.body.status : 'todo';
  const max = db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM board_cards WHERE owner_id = ?').get(req.user.id).m;
  const info = db.prepare('INSERT INTO board_cards (owner_id, title, status, sort) VALUES (?, ?, ?, ?)').run(req.user.id, title, status, max + 1);
  res.status(201).json({ card: view(db.prepare('SELECT * FROM board_cards WHERE id = ?').get(info.lastInsertRowid)) });
});

router.patch('/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM board_cards WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
  if (!c) return res.status(404).json({ error: 'Carte introuvable' });
  const sets = [], params = [];
  if (typeof req.body.title === 'string' && req.body.title.trim()) { sets.push('title = ?'); params.push(req.body.title.trim()); }
  if (STATUSES.includes(req.body.status)) { sets.push('status = ?'); params.push(req.body.status); }
  if (typeof req.body.sort === 'number') { sets.push('sort = ?'); params.push(req.body.sort); }
  if (!sets.length) return res.status(400).json({ error: 'Rien à modifier' });
  params.push(c.id);
  db.prepare(`UPDATE board_cards SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  res.json({ card: view(db.prepare('SELECT * FROM board_cards WHERE id = ?').get(c.id)) });
});

router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM board_cards WHERE id = ? AND owner_id = ?').run(req.params.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Carte introuvable' });
  res.json({ ok: true });
});

export default router;
