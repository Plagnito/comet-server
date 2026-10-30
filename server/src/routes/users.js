import { Router } from 'express';
import { db } from '../db.js';
import { authRequired, publicUser } from '../auth.js';
import { isOnline } from '../ws.js';

const router = Router();

const norm = (e) => { let v = String(e || '').trim().toLowerCase(); if (v && !v.includes('@')) v = `${v}@comet.mail`; return v; };

// Annuaire interne (hors comptes système) — composition / autocomplétion
router.get('/', authRequired, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const me = req.user.id;
  const org = req.user.org_id || null;
  // Annuaire SCOPÉ PAR ORGANISATION (plus d'« entreprise par défaut ») : on ne voit
  // que ses collègues de la MÊME organisation (listés, opt-in) + soi-même. Sans org,
  // l'annuaire ne contient que soi (Comet personnel : aucun collègue exposé).
  let rows;
  if (q) {
    const like = `%${q}%`;
    rows = db.prepare('SELECT * FROM users WHERE is_system = 0 AND is_box = 0 AND ((listed = 1 AND org_id IS NOT NULL AND org_id = ?) OR id = ?) AND (LOWER(email) LIKE ? OR LOWER(display_name) LIKE ?) ORDER BY display_name LIMIT 20').all(org, me, like, like);
  } else {
    rows = db.prepare('SELECT * FROM users WHERE is_system = 0 AND is_box = 0 AND ((listed = 1 AND org_id IS NOT NULL AND org_id = ?) OR id = ?) ORDER BY display_name LIMIT 50').all(org, me);
  }
  res.json({ users: rows.map(publicUser) });
});

// Les 5 dernières personnes à qui j'ai écrit (métadonnée serveur : la liste des
// destinataires ; le contenu reste chiffré). Pour la suggestion à la composition.
router.get('/recent-recipients', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.email, u.display_name, u.avatar_color, MAX(m.sent_at) AS last
    FROM messages m
    JOIN recipients r ON r.message_id = m.id
    JOIN users u ON u.id = r.user_id
    WHERE m.sender_id = ? AND u.is_system = 0 AND u.is_box = 0 AND u.id != ?
    GROUP BY u.id
    ORDER BY last DESC
    LIMIT 5
  `).all(req.user.id, req.user.id);
  res.json({ recipients: rows.map((u) => ({ email: u.email, displayName: u.display_name, avatarColor: u.avatar_color })) });
});

// Clés publiques par adresse (pour chiffrer un message côté client)
router.get('/keys', authRequired, (req, res) => {
  const emails = String(req.query.emails || '').split(',').map((e) => {
    let v = e.trim().toLowerCase();
    if (v && !v.includes('@')) v = `${v}@comet.mail`;
    return v;
  }).filter(Boolean);

  const keys = {};
  for (const email of emails) {
    let u = db.prepare('SELECT public_key FROM users WHERE email = ?').get(email);
    if (!u) {
      // Adresse alias active → clé publique du propriétaire
      const a = db.prepare('SELECT owner_id FROM aliases WHERE alias_email = ? AND active = 1').get(email);
      if (a) u = db.prepare('SELECT public_key FROM users WHERE id = ?').get(a.owner_id);
    }
    keys[email] = u ? (u.public_key || null) : null; // null = inconnu / inactif / sans clé
  }
  res.json({ keys });
});

// Résolution complète des destinataires (étend listes + alias) → { email, publicKey, online }
router.get('/recipients', authRequired, (req, res) => {
  const inputs = String(req.query.emails || '').split(',').map(norm).filter(Boolean);
  const recipients = new Map(); // email -> { pk, id }
  const unknown = [];
  for (const email of inputs) {
    const g = db.prepare('SELECT id FROM groups WHERE group_email = ?').get(email);
    if (g) {
      const members = db.prepare('SELECT u.id, u.email, u.public_key AS pk FROM group_members gm JOIN users u ON u.id = gm.member_id WHERE gm.group_id = ?').all(g.id);
      for (const m of members) if (m.pk) recipients.set(m.email, { pk: m.pk, id: m.id });
      continue;
    }
    const u = db.prepare('SELECT id, email, public_key AS pk FROM users WHERE email = ?').get(email);
    if (u) { if (u.pk) recipients.set(email, { pk: u.pk, id: u.id }); else unknown.push(email); continue; }
    const a = db.prepare('SELECT owner_id FROM aliases WHERE alias_email = ? AND active = 1').get(email);
    if (a) {
      const o = db.prepare('SELECT id, public_key AS pk FROM users WHERE id = ?').get(a.owner_id);
      if (o && o.pk) { recipients.set(email, { pk: o.pk, id: o.id }); continue; }
    }
    unknown.push(email);
  }
  res.json({
    recipients: [...recipients].map(([email, v]) => ({ email, publicKey: v.pk, online: isOnline(v.id) })),
    unknown,
  });
});

export default router;
