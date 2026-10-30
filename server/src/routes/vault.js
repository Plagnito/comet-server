import { Router } from 'express';
import { db } from '../db.js';
import { authRequired } from '../auth.js';

const router = Router();
router.use(authRequired);

// Le serveur ne stocke et ne renvoie que du chiffré (zero-knowledge).
const view = (e) => ({ id: e.id, ciphertext: e.ciphertext, iv: e.iv, encKey: e.enc_key, updatedAt: e.updated_at });

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM vault_entries WHERE owner_id = ? ORDER BY updated_at DESC').all(req.user.id);
  res.json({ entries: rows.map(view) });
});

router.post('/', (req, res) => {
  const { ciphertext, iv, encKey } = req.body;
  if (!ciphertext || !iv || !encKey) return res.status(400).json({ error: 'Charge chiffrée manquante' });
  const info = db.prepare('INSERT INTO vault_entries (owner_id, ciphertext, iv, enc_key) VALUES (?, ?, ?, ?)')
    .run(req.user.id, ciphertext, iv, encKey);
  res.status(201).json({ entry: view(db.prepare('SELECT * FROM vault_entries WHERE id = ?').get(info.lastInsertRowid)) });
});

router.patch('/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM vault_entries WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
  if (!e) return res.status(404).json({ error: 'Entrée introuvable' });
  const { ciphertext, iv, encKey } = req.body;
  if (!ciphertext || !iv || !encKey) return res.status(400).json({ error: 'Charge chiffrée manquante' });
  db.prepare("UPDATE vault_entries SET ciphertext = ?, iv = ?, enc_key = ?, updated_at = datetime('now') WHERE id = ?")
    .run(ciphertext, iv, encKey, e.id);
  res.json({ entry: view(db.prepare('SELECT * FROM vault_entries WHERE id = ?').get(e.id)) });
});

router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM vault_entries WHERE id = ? AND owner_id = ?').run(req.params.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Entrée introuvable' });
  res.json({ ok: true });
});

export default router;
