import { Router } from 'express';
import { db } from '../db.js';
import { authRequired } from '../auth.js';

const router = Router();
router.use(authRequired);

const adminOnly = (req, res, next) => { if (!req.user.is_admin) return res.status(403).json({ error: 'Réservé aux administrateurs' }); next(); };
const view = (r) => ({ id: r.id, name: r.name, location: r.location, capacity: r.capacity, color: r.color });

// Liste (tout le monde peut voir les salles pour réserver)
router.get('/', (req, res) => {
  res.json({ rooms: db.prepare('SELECT * FROM rooms ORDER BY name').all().map(view), canManage: !!req.user.is_admin });
});

// Réservations d'une salle sur une plage (pour afficher les disponibilités)
router.get('/:id/bookings', (req, res) => {
  const { from, to } = req.query;
  let sql = 'SELECT id, owner_id AS ownerId, title, starts_at AS startsAt, ends_at AS endsAt FROM events WHERE room_id = ?';
  const params = [req.params.id];
  if (from) { sql += ' AND ends_at >= ?'; params.push(from); }
  if (to) { sql += ' AND starts_at <= ?'; params.push(to); }
  const rows = db.prepare(sql + ' ORDER BY starts_at').all(...params);
  // Confidentialité : on ne révèle le titre qu'au propriétaire du créneau
  res.json({ bookings: rows.map((b) => ({ startsAt: b.startsAt, endsAt: b.endsAt, mine: b.ownerId === req.user.id, title: b.ownerId === req.user.id ? b.title : 'Occupé' })) });
});

router.post('/', adminOnly, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const info = db.prepare('INSERT INTO rooms (name, location, capacity, color) VALUES (?, ?, ?, ?)')
    .run(name, String(req.body.location || '').slice(0, 120), Math.max(0, parseInt(req.body.capacity, 10) || 0), req.body.color || '#0d9488');
  res.status(201).json({ room: view(db.prepare('SELECT * FROM rooms WHERE id = ?').get(info.lastInsertRowid)) });
});

router.patch('/:id', adminOnly, (req, res) => {
  const r = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Salle introuvable' });
  const map = { name: 'name', location: 'location', color: 'color' };
  const sets = [], params = [];
  for (const [k, col] of Object.entries(map)) if (k in req.body) { sets.push(`${col} = ?`); params.push(String(req.body[k])); }
  if ('capacity' in req.body) { sets.push('capacity = ?'); params.push(Math.max(0, parseInt(req.body.capacity, 10) || 0)); }
  if (sets.length) { params.push(r.id); db.prepare(`UPDATE rooms SET ${sets.join(', ')} WHERE id = ?`).run(...params); }
  res.json({ room: view(db.prepare('SELECT * FROM rooms WHERE id = ?').get(r.id)) });
});

router.delete('/:id', adminOnly, (req, res) => {
  const info = db.prepare('DELETE FROM rooms WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Salle introuvable' });
  res.json({ ok: true });
});

export default router;
