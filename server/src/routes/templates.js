import { Router } from 'express';
import { db } from '../db.js';
import { authRequired } from '../auth.js';

const router = Router();
router.use(authRequired);

const view = (t) => ({ id: t.id, name: t.name, subject: t.subject, body: t.body });

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM templates WHERE owner_id = ? ORDER BY name COLLATE NOCASE').all(req.user.id);
  res.json({ templates: rows.map(view) });
});

router.post('/', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const info = db.prepare('INSERT INTO templates (owner_id, name, subject, body) VALUES (?, ?, ?, ?)')
    .run(req.user.id, name, String(req.body.subject || ''), String(req.body.body || ''));
  res.status(201).json({ template: view(db.prepare('SELECT * FROM templates WHERE id = ?').get(info.lastInsertRowid)) });
});

router.patch('/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM templates WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
  if (!t) return res.status(404).json({ error: 'Modèle introuvable' });
  const map = { name: 'name', subject: 'subject', body: 'body' };
  const sets = [], params = [];
  for (const [k, col] of Object.entries(map)) if (k in req.body) { sets.push(`${col} = ?`); params.push(String(req.body[k])); }
  if (!sets.length) return res.status(400).json({ error: 'Rien à modifier' });
  params.push(t.id);
  db.prepare(`UPDATE templates SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  res.json({ template: view(db.prepare('SELECT * FROM templates WHERE id = ?').get(t.id)) });
});

router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM templates WHERE id = ? AND owner_id = ?').run(req.params.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Modèle introuvable' });
  res.json({ ok: true });
});

export default router;
