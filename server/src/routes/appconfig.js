import { Router } from 'express';
import { db } from '../db.js';
import { authRequired } from '../auth.js';

// Configuration des applications (modules) activées pour l'organisation. L'admin
// peut désactiver des modules → ils disparaissent du rail pour tout le monde.
const router = Router();
const getS = (k) => db.prepare('SELECT v FROM settings WHERE k = ?').get(k)?.v ?? null;
const setS = (k, v) => db.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
const disabled = () => { try { const a = JSON.parse(getS('disabled_modules')); return Array.isArray(a) ? a : []; } catch { return []; } };

router.use(authRequired);

// Lu par tous les utilisateurs (pour filtrer leur rail).
router.get('/', (req, res) => res.json({ disabledModules: disabled() }));

// Modifié par l'admin uniquement.
router.put('/', (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Réservé aux administrateurs' });
  const list = Array.isArray(req.body.disabledModules)
    ? [...new Set(req.body.disabledModules.filter((x) => typeof x === 'string').slice(0, 50))]
    : [];
  setS('disabled_modules', JSON.stringify(list));
  res.json({ disabledModules: list });
});

export default router;
