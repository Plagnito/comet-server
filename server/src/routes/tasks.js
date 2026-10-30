import { Router } from 'express';
import { db } from '../db.js';
import { authRequired } from '../auth.js';

const router = Router();
router.use(authRequired);

const userBrief = (id) => {
  if (!id) return null;
  const u = db.prepare('SELECT id, display_name AS displayName, avatar_color AS avatarColor FROM users WHERE id = ?').get(id);
  return u || null;
};
function emailToId(raw) {
  let e = String(raw || '').trim().toLowerCase();
  if (!e) return null;
  if (!e.includes('@')) e = `${e}@comet.mail`;
  return db.prepare('SELECT id FROM users WHERE email = ?').get(e)?.id || null;
}

const RECURRENCES = ['daily', 'weekly', 'monthly'];
const view = (t, meId) => ({
  id: t.id, title: t.title, notes: t.notes, dueAt: t.due_at,
  completed: !!t.completed, priority: t.priority, createdAt: t.created_at,
  recurrence: t.recurrence && t.recurrence !== 'none' ? t.recurrence : null,
  parentId: t.parent_id || null,
  owner: userBrief(t.owner_id), assignee: userBrief(t.assignee_id),
  mine: t.owner_id === meId,
});

// Avance une échéance selon la récurrence (conserve le format date seule / date-heure).
function advanceDue(dueAt, rec) {
  const base = dueAt ? new Date((dueAt.length <= 10 ? dueAt + 'T00:00' : dueAt).replace(' ', 'T')) : new Date();
  if (isNaN(base)) return null;
  if (rec === 'daily') base.setDate(base.getDate() + 1);
  else if (rec === 'weekly') base.setDate(base.getDate() + 7);
  else if (rec === 'monthly') base.setMonth(base.getMonth() + 1);
  else return null;
  const p = (n) => String(n).padStart(2, '0');
  const date = `${base.getFullYear()}-${p(base.getMonth() + 1)}-${p(base.getDate())}`;
  return (!dueAt || dueAt.length <= 10) ? date : `${date}T${p(base.getHours())}:${p(base.getMinutes())}`;
}

router.get('/', (req, res) => {
  const rows = db.prepare(
    `SELECT * FROM tasks WHERE owner_id = ? OR assignee_id = ?
     ORDER BY completed ASC, priority DESC, (due_at IS NULL), due_at ASC, id DESC`
  ).all(req.user.id, req.user.id);
  const ids = new Set(rows.map((t) => t.id));
  const children = {};
  for (const t of rows) if (t.parent_id) (children[t.parent_id] ||= []).push(t);
  // Niveau supérieur : sans parent, ou parent hors de la portée de l'utilisateur (orphelin)
  const top = rows.filter((t) => !t.parent_id || !ids.has(t.parent_id));
  res.json({
    tasks: top.map((t) => {
      const subs = (children[t.id] || []).map((s) => view(s, req.user.id));
      return { ...view(t, req.user.id), subtasks: subs, subDone: subs.filter((s) => s.completed).length, subTotal: subs.length };
    }),
  });
});

router.post('/', (req, res) => {
  const { title, notes = '', dueAt = null, priority = 0, assigneeEmail = null } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Titre requis' });
  const assigneeId = assigneeEmail ? emailToId(assigneeEmail) : null;
  // Sous-tâche : le parent doit appartenir à l'utilisateur (ou lui être assigné)
  let parentId = req.body.parentId ? parseInt(req.body.parentId, 10) : null;
  if (parentId && !db.prepare('SELECT 1 FROM tasks WHERE id = ? AND (owner_id = ? OR assignee_id = ?)').get(parentId, req.user.id, req.user.id)) parentId = null;
  const recurrence = !parentId && RECURRENCES.includes(req.body.recurrence) ? req.body.recurrence : null;
  const info = db.prepare('INSERT INTO tasks (owner_id, title, notes, due_at, priority, assignee_id, recurrence, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.user.id, title.trim(), notes, dueAt, priority ? 1 : 0, assigneeId, recurrence, parentId);
  res.status(201).json({ task: view(db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid), req.user.id) });
});

router.patch('/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ? AND (owner_id = ? OR assignee_id = ?)').get(req.params.id, req.user.id, req.user.id);
  if (!t) return res.status(404).json({ error: 'Tâche introuvable' });
  const sets = [], params = [];
  const map = { title: 'title', notes: 'notes', dueAt: 'due_at' };
  for (const [k, col] of Object.entries(map)) if (k in req.body) { sets.push(`${col} = ?`); params.push(req.body[k]); }
  if ('completed' in req.body) { sets.push('completed = ?'); params.push(req.body.completed ? 1 : 0); }
  if ('priority' in req.body) { sets.push('priority = ?'); params.push(req.body.priority ? 1 : 0); }
  if ('assigneeEmail' in req.body) { sets.push('assignee_id = ?'); params.push(req.body.assigneeEmail ? emailToId(req.body.assigneeEmail) : null); }
  const effRec = ('recurrence' in req.body) ? (RECURRENCES.includes(req.body.recurrence) ? req.body.recurrence : null) : t.recurrence;
  if ('recurrence' in req.body) { sets.push('recurrence = ?'); params.push(RECURRENCES.includes(req.body.recurrence) ? req.body.recurrence : null); }
  if (!sets.length) return res.status(400).json({ error: 'Rien à modifier' });
  params.push(t.id);
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  // Tâche récurrente cochée → on engendre la suivante (échéance avancée)
  let spawned = null;
  if (req.body.completed === true && !t.completed && effRec && effRec !== 'none') {
    const info = db.prepare('INSERT INTO tasks (owner_id, title, notes, due_at, priority, assignee_id, recurrence) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(t.owner_id, t.title, t.notes, advanceDue(t.due_at, effRec), t.priority, t.assignee_id, effRec);
    spawned = view(db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid), req.user.id);
  }
  res.json({ task: view(db.prepare('SELECT * FROM tasks WHERE id = ?').get(t.id), req.user.id), spawned });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM tasks WHERE parent_id = ? AND owner_id = ?').run(req.params.id, req.user.id); // sous-tâches
  const info = db.prepare('DELETE FROM tasks WHERE id = ? AND owner_id = ?').run(req.params.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Tâche introuvable (seul le créateur peut supprimer)' });
  res.json({ ok: true });
});

export default router;
