import { Router } from 'express';
import { db } from '../db.js';
import { authRequired } from '../auth.js';

const router = Router();
router.use(authRequired);

const view = (a) => ({ id: a.id, email: a.alias_email, label: a.label, active: !!a.active, createdAt: a.created_at });

const randomLocal = () => Math.random().toString(36).slice(2, 9);

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM aliases WHERE owner_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ aliases: rows.map(view) });
});

router.post('/', (req, res) => {
  const label = String(req.body.label || '').trim().slice(0, 60);
  let email;
  for (let i = 0; i < 6; i++) {
    const candidate = `${randomLocal()}@comet.mail`;
    if (!db.prepare('SELECT 1 FROM aliases WHERE alias_email = ?').get(candidate) &&
        !db.prepare('SELECT 1 FROM users WHERE email = ?').get(candidate)) { email = candidate; break; }
  }
  if (!email) return res.status(500).json({ error: 'Génération impossible, réessayez' });
  const info = db.prepare('INSERT INTO aliases (owner_id, alias_email, label) VALUES (?, ?, ?)').run(req.user.id, email, label);
  res.status(201).json({ alias: view(db.prepare('SELECT * FROM aliases WHERE id = ?').get(info.lastInsertRowid)) });
});

router.patch('/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM aliases WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
  if (!a) return res.status(404).json({ error: 'Alias introuvable' });
  if (typeof req.body.active === 'boolean') db.prepare('UPDATE aliases SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, a.id);
  res.json({ alias: view(db.prepare('SELECT * FROM aliases WHERE id = ?').get(a.id)) });
});

router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM aliases WHERE id = ? AND owner_id = ?').run(req.params.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Alias introuvable' });
  res.json({ ok: true });
});

export default router;
