import { Router } from 'express';
import { db } from '../db.js';
import { authRequired } from '../auth.js';
import { notifyUser } from '../ws.js';

const router = Router();
router.use(authRequired);

function emailToId(raw) {
  let e = String(raw || '').trim().toLowerCase();
  if (!e) return null;
  if (!e.includes('@')) e = `${e}@comet.mail`;
  return db.prepare('SELECT id FROM users WHERE email = ?').get(e)?.id || null;
}
const senderView = (id) => {
  const u = db.prepare('SELECT id, email, display_name AS displayName, avatar_color AS avatarColor FROM users WHERE id = ?').get(id);
  return u || null;
};
const isMember = (channelId, userId) => !!db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, userId);
const memberIds = (channelId) => db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(channelId).map((r) => r.user_id);

// ── Canal « Général » de l'organisation ─────────────────────────────────────
// Un canal par org, nommé « Général », auquel appartiennent les membres de l'org.
// E2EE : la clé AES du canal est produite PAR UN CLIENT et enveloppée (RSA) pour
// chaque membre — le serveur ne la voit jamais en clair et ne peut donc PAS créer
// ce canal tout seul. Il se contente : (1) de dire s'il existe, (2) de lister les
// membres de l'org qui n'ont pas encore leur copie de la clé, (3) d'enregistrer la
// création de façon idempotente (un seul « Général » par org).
const GENERAL_NAME = 'Général';
const generalOf = (orgId) => db.prepare("SELECT id, name, description FROM channels WHERE org_id = ? AND kind = 'general'").get(orgId);
// Membres de l'org capables de RECEVOIR la clé : il leur faut une clé publique.
const orgKeyable = (orgId) => db.prepare(
  "SELECT id, email, display_name AS displayName, public_key AS publicKey FROM users WHERE org_id = ? AND is_system = 0 AND is_box = 0 AND public_key IS NOT NULL AND public_key != '' ORDER BY display_name"
).all(orgId);
// Ceux d'entre eux qui ne sont pas encore membres du canal (rattrapage : arrivés
// après la création, ou sans clés E2EE à ce moment-là).
const orgMissing = (orgId, channelId) => db.prepare(
  `SELECT u.id, u.email, u.display_name AS displayName, u.public_key AS publicKey FROM users u
   WHERE u.org_id = ? AND u.is_system = 0 AND u.is_box = 0 AND u.public_key IS NOT NULL AND u.public_key != ''
     AND NOT EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = ? AND cm.user_id = u.id)
   ORDER BY u.display_name`
).all(orgId, channelId);

// État du « Général » de mon org : à créer, à rejoindre, ou déjà mien.
router.get('/general', (req, res) => {
  const org = req.user.org_id || null;
  if (!org) return res.json({ org: null, channel: null, members: [], missing: [] });
  const c = generalOf(org);
  // Pas encore créé → le client qui appelle le crée (il a les clés publiques listées).
  if (!c) return res.json({ org, channel: null, members: orgKeyable(org), missing: [] });
  const mine = db.prepare('SELECT enc_key FROM channel_members WHERE channel_id = ? AND user_id = ?').get(c.id, req.user.id);
  res.json({
    org,
    channel: { ...c, encKey: mine ? mine.enc_key : null },
    member: !!mine,
    members: [],
    // Renvoyé à TOUS : seul un membre qui détient déjà la clé pourra l'envelopper
    // pour eux (POST /channels/:id/members) — le serveur, lui, en est incapable.
    missing: orgMissing(org, c.id),
  });
});

// Création du « Général » — le client fournit la clé de canal enveloppée par membre.
// Idempotent : si le canal existe déjà (course entre deux clients incluse, tranchée
// par l'index unique partiel idx_channels_general), on renvoie l'existant sans rien
// écraser. Aucune clé n'est jamais remplacée.
router.post('/general', (req, res) => {
  const org = req.user.org_id || null;
  if (!org) return res.status(403).json({ error: 'Rejoignez une organisation pour accéder à cette fonctionnalité.', code: 'no_org' });
  const existing = generalOf(org);
  if (existing) return res.json({ channel: existing, existed: true });

  const members = req.body.members || {}; // { email: encKey }
  // On ne rattache QUE des membres de la même org : « Général » est le canal de
  // l'équipe, pas une porte d'entrée pour un tiers.
  const allowed = new Set(orgKeyable(org).map((u) => u.id));
  const entries = Object.entries(members)
    .map(([email, encKey]) => ({ id: emailToId(email), encKey }))
    .filter((x) => x.id && x.encKey && allowed.has(x.id));
  if (!entries.some((e) => e.id === req.user.id)) return res.status(400).json({ error: 'Votre propre copie de la clé est requise' });

  let channelId;
  try {
    const info = db.prepare("INSERT INTO channels (name, description, created_by, org_id, kind) VALUES (?, ?, ?, ?, 'general')")
      .run(GENERAL_NAME, 'Canal de toute l\'équipe', req.user.id, org);
    channelId = info.lastInsertRowid;
  } catch {
    // Un autre client vient de le créer (index unique) → on adopte le sien.
    const now = generalOf(org);
    if (now) return res.json({ channel: now, existed: true });
    return res.status(500).json({ error: 'Création du canal Général impossible' });
  }
  const ins = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id, enc_key) VALUES (?, ?, ?)');
  for (const e of entries) ins.run(channelId, e.id, e.encKey);
  res.status(201).json({ channel: db.prepare('SELECT id, name, description FROM channels WHERE id = ?').get(channelId), existed: false });
});

// ── Liste des canaux de l'utilisateur ───────────────────────────────────────
router.get('/channels', (req, res) => {
  // « Général » est épinglé en tête : c'est le canal d'accueil de l'équipe.
  const rows = db.prepare(`
    SELECT c.id, c.name, c.description, c.is_dm AS isDm, c.kind, cm.enc_key AS encKey,
           (SELECT COUNT(*) FROM channel_members x WHERE x.channel_id = c.id) AS members,
           (SELECT MAX(m.created_at) FROM chat_messages m WHERE m.channel_id = c.id) AS lastAt
    FROM channels c JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = ?
    ORDER BY (c.kind = 'general') DESC, (lastAt IS NULL), lastAt DESC, c.id DESC
  `).all(req.user.id);
  // Pour un DM, on affiche l'interlocuteur (et non le nom figé du canal).
  for (const r of rows) {
    r.isDm = !!r.isDm;
    if (r.isDm) {
      const other = db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id != ? LIMIT 1').get(r.id, req.user.id);
      const u = other ? senderView(other.user_id) : null;
      if (u) { r.dmWith = u; r.name = u.displayName; }
    }
  }
  res.json({ channels: rows });
});

// ── Message direct (DM) : trouve ou crée un canal 1-à-1 chiffré ──────────────
router.post('/dm', (req, res) => {
  const otherId = emailToId(req.body.email);
  if (!otherId || otherId === req.user.id) return res.status(400).json({ error: 'Destinataire invalide' });
  const pair = [req.user.id, otherId].sort((a, b) => a - b).join('-');
  const existing = db.prepare('SELECT id FROM channels WHERE is_dm = 1 AND dm_pair = ?').get(pair);
  if (existing) return res.json({ channel: db.prepare('SELECT id, name, description FROM channels WHERE id = ?').get(existing.id), existed: true });

  const members = req.body.members || {}; // { email: encKey } pour les 2 membres
  const entries = Object.entries(members).map(([email, encKey]) => ({ id: emailToId(email), encKey })).filter((x) => x.id && x.encKey);
  // Exactement deux enveloppes, l'une pour l'expéditeur, l'autre pour le destinataire.
  // Le serveur ne lit pas la clé du canal : c'est à lui de refuser un troisième
  // lecteur, que l'autre personne ne verrait jamais.
  const paire = new Set([req.user.id, otherId]);
  const ids = new Set(entries.map((e) => e.id));
  if (Object.keys(members).length !== 2 || entries.length !== 2 || ids.size !== 2 || ![...ids].every((id) => paire.has(id))) {
    return res.status(400).json({ error: 'Un message direct réunit exactement deux personnes : vous et votre destinataire' });
  }

  const info = db.prepare('INSERT INTO channels (name, description, created_by, is_dm, dm_pair) VALUES (?, ?, ?, 1, ?)')
    .run(String(req.body.name || 'Message direct').slice(0, 80), '', req.user.id, pair);
  const channelId = info.lastInsertRowid;
  const ins = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id, enc_key) VALUES (?, ?, ?)');
  for (const e of entries) ins.run(channelId, e.id, e.encKey);
  res.status(201).json({ channel: db.prepare('SELECT id, name, description FROM channels WHERE id = ?').get(channelId), existed: false });
});

// ── Créer un canal (le client fournit la clé de canal enveloppée par membre) ──
router.post('/channels', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const members = req.body.members || {}; // { email: encKey }  (doit inclure le créateur)
  const entries = Object.entries(members).map(([email, encKey]) => ({ id: emailToId(email), encKey })).filter((x) => x.id && x.encKey);
  if (entries.length === 0) return res.status(400).json({ error: 'Aucun membre valide' });

  const info = db.prepare('INSERT INTO channels (name, description, created_by) VALUES (?, ?, ?)')
    .run(name, String(req.body.description || '').slice(0, 200), req.user.id);
  const channelId = info.lastInsertRowid;
  const ins = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id, enc_key) VALUES (?, ?, ?)');
  for (const e of entries) ins.run(channelId, e.id, e.encKey);

  res.status(201).json({ channel: db.prepare('SELECT id, name, description FROM channels WHERE id = ?').get(channelId) });
});

// ── Détail d'un canal (membres + ma clé enveloppée) ─────────────────────────
router.get('/channels/:id', (req, res) => {
  if (!isMember(req.params.id, req.user.id)) return res.status(403).json({ error: 'Non membre' });
  const c = db.prepare('SELECT id, name, description, created_by FROM channels WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Canal introuvable' });
  const myKey = db.prepare('SELECT enc_key FROM channel_members WHERE channel_id = ? AND user_id = ?').get(c.id, req.user.id)?.enc_key;
  const members = memberIds(c.id).map(senderView);
  res.json({ channel: { ...c, encKey: myKey, members } });
});

// ── Messages d'un canal ─────────────────────────────────────────────────────
router.get('/channels/:id/messages', (req, res) => {
  if (!isMember(req.params.id, req.user.id)) return res.status(403).json({ error: 'Non membre' });
  const rows = db.prepare('SELECT id, sender_id AS senderId, ciphertext, iv, created_at AS createdAt FROM chat_messages WHERE channel_id = ? ORDER BY id ASC LIMIT 500').all(req.params.id);
  res.json({ messages: rows.map((m) => ({ id: m.id, ciphertext: m.ciphertext, iv: m.iv, createdAt: m.createdAt, from: senderView(m.senderId) })) });
});

router.post('/channels/:id/messages', (req, res) => {
  if (!isMember(req.params.id, req.user.id)) return res.status(403).json({ error: 'Non membre' });
  const { ciphertext, iv } = req.body;
  if (!ciphertext || !iv) return res.status(400).json({ error: 'Charge chiffrée manquante' });
  const info = db.prepare('INSERT INTO chat_messages (channel_id, sender_id, ciphertext, iv) VALUES (?, ?, ?, ?)').run(req.params.id, req.user.id, ciphertext, iv);
  // Temps réel : prévient les autres membres
  for (const uid of memberIds(req.params.id)) if (uid !== req.user.id) notifyUser(uid, { type: 'chat:new', channelId: Number(req.params.id) });
  res.status(201).json({ id: info.lastInsertRowid });
});

// ── Ajouter des membres (l'ajouteur fournit la clé enveloppée pour eux) ──────
router.post('/channels/:id/members', (req, res) => {
  if (!isMember(req.params.id, req.user.id)) return res.status(403).json({ error: 'Non membre' });
  const chan = db.prepare('SELECT id, org_id, kind, is_dm FROM channels WHERE id = ?').get(req.params.id);
  if (!chan) return res.status(404).json({ error: 'Canal introuvable' });
  if (chan.is_dm) return res.status(403).json({ error: 'Un message direct ne peut pas accueillir d’autres membres' });
  // « Général » : réservé aux membres de l'organisation (c'est le canal de l'équipe).
  // INSERT OR IGNORE → un membre déjà présent garde SA clé : le rattrapage effectué
  // par plusieurs collègues en même temps reste sans effet de bord.
  const allowed = chan.kind === 'general' && chan.org_id
    ? new Set(db.prepare('SELECT id FROM users WHERE org_id = ?').all(chan.org_id).map((u) => u.id))
    : null;
  const members = req.body.members || {};
  const ins = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id, enc_key) VALUES (?, ?, ?)');
  let added = 0;
  for (const [email, encKey] of Object.entries(members)) {
    const id = emailToId(email);
    if (!id || !encKey || (allowed && !allowed.has(id))) continue;
    added += ins.run(req.params.id, id, encKey).changes;
  }
  res.json({ added });
});

// Un message direct enregistré avant cette règle a pu recevoir un troisième membre.
// On retire tout membre qui n'appartient pas à la paire du canal (dm_pair « a-b »).
export function purgerIntrusMessagesDirects() {
  const retirer = db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?');
  let retires = 0;
  for (const dm of db.prepare('SELECT id, dm_pair FROM channels WHERE is_dm = 1 AND dm_pair IS NOT NULL').all()) {
    const paire = new Set(String(dm.dm_pair).split('-').map(Number).filter(Number.isInteger));
    if (paire.size !== 2) continue;
    for (const uid of memberIds(dm.id)) if (!paire.has(uid)) retires += retirer.run(dm.id, uid).changes;
  }
  if (retires) console.warn(`[chat] ${retires} membre(s) retiré(s) de messages directs qui n'étaient pas les leurs.`);
  return retires;
}
purgerIntrusMessagesDirects();

export default router;
