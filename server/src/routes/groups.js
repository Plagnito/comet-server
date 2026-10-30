import { Router } from 'express';
import { db } from '../db.js';
import { authRequired } from '../auth.js';

const router = Router();
router.use(authRequired);

const norm = (e) => { let v = String(e || '').trim().toLowerCase(); if (v && !v.includes('@')) v = `${v}@comet.mail`; return v; };
const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '').slice(0, 16) || 'liste';

function membersOf(groupId) {
  return db.prepare(
    `SELECT u.id, u.email, u.display_name AS displayName FROM group_members gm JOIN users u ON u.id = gm.member_id WHERE gm.group_id = ? ORDER BY u.display_name`
  ).all(groupId);
}
const view = (g) => ({ id: g.id, name: g.name, email: g.group_email, members: membersOf(g.id) });

function setMembers(groupId, emails) {
  db.prepare('DELETE FROM group_members WHERE group_id = ?').run(groupId);
  const ins = db.prepare('INSERT OR IGNORE INTO group_members (group_id, member_id) VALUES (?, ?)');
  for (const raw of emails || []) {
    const u = db.prepare('SELECT id FROM users WHERE email = ?').get(norm(raw));
    if (u) ins.run(groupId, u.id);
  }
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM groups WHERE owner_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ groups: rows.map(view) });
});

router.post('/', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  let email;
  for (let i = 0; i < 6; i++) {
    const cand = `${slug(name)}-${Math.random().toString(36).slice(2, 5)}@comet.mail`;
    const taken = db.prepare('SELECT 1 FROM groups WHERE group_email = ?').get(cand)
      || db.prepare('SELECT 1 FROM users WHERE email = ?').get(cand)
      || db.prepare('SELECT 1 FROM aliases WHERE alias_email = ?').get(cand);
    if (!taken) { email = cand; break; }
  }
  if (!email) return res.status(500).json({ error: 'Génération impossible' });
  const info = db.prepare('INSERT INTO groups (owner_id, name, group_email) VALUES (?, ?, ?)').run(req.user.id, name, email);
  setMembers(info.lastInsertRowid, req.body.members);
  res.status(201).json({ group: view(db.prepare('SELECT * FROM groups WHERE id = ?').get(info.lastInsertRowid)) });
});

router.patch('/:id', (req, res) => {
  const g = db.prepare('SELECT * FROM groups WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
  if (!g) return res.status(404).json({ error: 'Liste introuvable' });
  if (typeof req.body.name === 'string' && req.body.name.trim()) db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(req.body.name.trim(), g.id);
  if (Array.isArray(req.body.members)) setMembers(g.id, req.body.members);
  res.json({ group: view(db.prepare('SELECT * FROM groups WHERE id = ?').get(g.id)) });
});

router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM groups WHERE id = ? AND owner_id = ?').run(req.params.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Liste introuvable' });
  res.json({ ok: true });
});

export default router;
