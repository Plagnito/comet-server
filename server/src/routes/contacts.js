import { Router } from 'express';
import { db } from '../db.js';
import { authRequired } from '../auth.js';
import { toVcards, parseVcards } from '../services/vcard.js';

const router = Router();
router.use(authRequired);

const view = (c) => ({
  id: c.id,
  name: c.name,
  email: c.email,
  phone: c.phone,
  company: c.company,
  notes: c.notes,
  favorite: !!c.favorite,
  labels: c.labels ? c.labels.split(',').filter(Boolean) : [],
});
const normLabels = (arr) => (Array.isArray(arr) ? [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))].join(',') : '');

router.get('/', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  let sql = 'SELECT * FROM contacts WHERE owner_id = ?';
  const params = [req.user.id];
  if (q) { sql += ' AND (LOWER(name) LIKE ? OR LOWER(email) LIKE ? OR LOWER(company) LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY favorite DESC, name COLLATE NOCASE ASC';
  let contacts = db.prepare(sql).all(...params).map(view);
  const label = String(req.query.label || '').trim();
  if (label) contacts = contacts.filter((c) => c.labels.includes(label));
  res.json({ contacts });
});

// Liste des libellés distincts (pour le filtre)
router.get('/labels', (req, res) => {
  const set = new Set();
  for (const r of db.prepare('SELECT labels FROM contacts WHERE owner_id = ? AND labels IS NOT NULL').all(req.user.id)) {
    for (const l of String(r.labels).split(',')) if (l) set.add(l);
  }
  res.json({ labels: [...set].sort((a, b) => a.localeCompare(b)) });
});

// ── Export vCard (.vcf) de tous les contacts ────────────────────────────────
router.get('/export', (req, res) => {
  const contacts = db.prepare('SELECT * FROM contacts WHERE owner_id = ? ORDER BY name COLLATE NOCASE').all(req.user.id).map(view);
  res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="comet-contacts.vcf"');
  res.send(toVcards(contacts));
});

// ── Import vCard : crée les contacts à partir d'un texte .vcf ────────────────
router.post('/import', (req, res) => {
  const parsed = parseVcards(req.body.vcard || '');
  const ins = db.prepare('INSERT INTO contacts (owner_id, name, email, phone, company, notes, labels) VALUES (?, ?, ?, ?, ?, ?, ?)');
  let imported = 0;
  for (const c of parsed) {
    ins.run(req.user.id, (c.name || c.email).slice(0, 120), c.email.slice(0, 160), c.phone.slice(0, 60), c.company.slice(0, 120), c.notes.slice(0, 2000), normLabels(c.labels));
    imported++;
  }
  res.json({ imported, found: parsed.length });
});

router.post('/', (req, res) => {
  const { name, email = '', phone = '', company = '', notes = '', favorite = false } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
  const info = db
    .prepare('INSERT INTO contacts (owner_id, name, email, phone, company, notes, favorite, labels) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.user.id, name.trim(), email, phone, company, notes, favorite ? 1 : 0, normLabels(req.body.labels));
  res.status(201).json({ contact: view(db.prepare('SELECT * FROM contacts WHERE id = ?').get(info.lastInsertRowid)) });
});

router.patch('/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM contacts WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
  if (!c) return res.status(404).json({ error: 'Contact introuvable' });
  const map = { name: 'name', email: 'email', phone: 'phone', company: 'company', notes: 'notes' };
  const sets = [], params = [];
  for (const [k, col] of Object.entries(map)) if (k in req.body) { sets.push(`${col} = ?`); params.push(req.body[k]); }
  if ('favorite' in req.body) { sets.push('favorite = ?'); params.push(req.body.favorite ? 1 : 0); }
  if ('labels' in req.body) { sets.push('labels = ?'); params.push(normLabels(req.body.labels)); }
  if (!sets.length) return res.status(400).json({ error: 'Rien à modifier' });
  params.push(c.id);
  db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  res.json({ contact: view(db.prepare('SELECT * FROM contacts WHERE id = ?').get(c.id)) });
});

router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM contacts WHERE id = ? AND owner_id = ?').run(req.params.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Contact introuvable' });
  res.json({ ok: true });
});

export default router;
