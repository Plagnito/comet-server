import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { db } from '../db.js';
import { authRequired } from '../auth.js';
import { notifyUser } from '../ws.js';

const router = Router();
router.use(authRequired);

// ── Helpers ──────────────────────────────────────────────────────────────────
const PALETTE = ['#0d9488', '#7c3aed', '#db2777', '#ea580c', '#2563eb', '#16a34a', '#d97706'];
const BOX_FOLDERS = ['inbox', 'sent', 'archive', 'trash'];
const snippet = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 140);

function normAddr(raw) {
  let e = String(raw || '').trim().toLowerCase();
  if (!e) return '';
  if (!e.includes('@')) e = `${e}@comet.mail`;
  return e;
}
function emailToId(raw) {
  const e = normAddr(raw);
  if (!e) return null;
  const u = db.prepare('SELECT id FROM users WHERE email = ?').get(e);
  if (u) return u.id;
  const a = db.prepare('SELECT owner_id FROM aliases WHERE alias_email = ? AND active = 1').get(e);
  return a ? a.owner_id : null;
}
const membership = (boxId, userId) =>
  db.prepare('SELECT * FROM shared_mailbox_members WHERE box_id = ? AND user_id = ?').get(boxId, userId);
const senderView = (id) => {
  const u = db.prepare('SELECT id, email, display_name AS displayName, avatar_color AS avatarColor, is_box AS isBox FROM users WHERE id = ?').get(id);
  return u ? { ...u, isBox: !!u.isBox } : null;
};
function recipientsView(messageId) {
  const rows = db.prepare(
    `SELECT r.kind, u.id, u.email, u.display_name AS displayName, u.avatar_color AS avatarColor
     FROM recipients r JOIN users u ON u.id = r.user_id WHERE r.message_id = ? ORDER BY r.id`
  ).all(messageId);
  return { to: rows.filter((r) => r.kind === 'to'), cc: rows.filter((r) => r.kind === 'cc') };
}

// Versions « batch » pour la liste des messages d'une boîte (anti N+1).
function senderMapFor(ids) {
  const map = new Map();
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return map;
  const ph = uniq.map(() => '?').join(',');
  for (const u of db.prepare(`SELECT id, email, display_name AS displayName, avatar_color AS avatarColor, is_box AS isBox FROM users WHERE id IN (${ph})`).all(...uniq)) {
    map.set(u.id, { id: u.id, email: u.email, displayName: u.displayName, avatarColor: u.avatarColor, isBox: !!u.isBox });
  }
  return map;
}
function recipientsMapFor(messageIds) {
  const map = new Map();
  const uniq = [...new Set(messageIds.filter(Boolean))];
  if (!uniq.length) return map;
  const ph = uniq.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT r.message_id AS mid, r.kind, u.id, u.email, u.display_name AS displayName, u.avatar_color AS avatarColor
     FROM recipients r JOIN users u ON u.id = r.user_id WHERE r.message_id IN (${ph}) ORDER BY r.id`
  ).all(...uniq);
  for (const row of rows) {
    let e = map.get(row.mid);
    if (!e) { e = { to: [], cc: [] }; map.set(row.mid, e); }
    (row.kind === 'cc' ? e.cc : e.to).push({ kind: row.kind, id: row.id, email: row.email, displayName: row.displayName, avatarColor: row.avatarColor });
  }
  return map;
}
const myMsgKey = (messageId, boxId) =>
  db.prepare('SELECT enc_key FROM message_keys WHERE message_id = ? AND user_id = ?').get(messageId, boxId)?.enc_key || null;

function boxView(boxUser, role) {
  const unread = db.prepare("SELECT COUNT(*) AS n FROM mail_items WHERE user_id = ? AND folder = 'inbox' AND is_read = 0").get(boxUser.id).n;
  const members = db.prepare('SELECT COUNT(*) AS n FROM shared_mailbox_members WHERE box_id = ?').get(boxUser.id).n;
  return { id: boxUser.id, address: boxUser.email, name: boxUser.display_name, color: boxUser.avatar_color, role, unread, members };
}

// ── Mes boîtes partagées ─────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const rows = db.prepare(
    `SELECT u.*, m.role AS role FROM shared_mailbox_members m
     JOIN users u ON u.id = m.box_id WHERE m.user_id = ? ORDER BY u.display_name`
  ).all(req.user.id);
  res.json({ boxes: rows.map((u) => boxView(u, u.role)) });
});

// ── Créer une boîte partagée ─────────────────────────────────────────────────
// Le client génère l'identité (clé publique + clé privée chiffrée sous la clé de boîte)
// et fournit la clé de boîte enveloppée pour chaque membre (dont le créateur).
router.post('/', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const address = normAddr(req.body.address);
  const publicKey = String(req.body.publicKey || '');
  const wrappedPrivateKey = String(req.body.wrappedPrivateKey || '');
  const members = req.body.members || {}; // { email: encKey }
  if (!name || !address) return res.status(400).json({ error: 'Nom et adresse requis' });
  if (!publicKey || !wrappedPrivateKey) return res.status(400).json({ error: 'Identité de boîte manquante' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(address)) return res.status(409).json({ error: 'Cette adresse est déjà utilisée' });

  const entries = Object.entries(members).map(([email, encKey]) => ({ id: emailToId(email), encKey })).filter((x) => x.id && x.encKey);
  if (!entries.some((e) => e.id === req.user.id)) return res.status(400).json({ error: 'Le créateur doit être membre' });

  const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  let boxId;
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO users (email, display_name, password_hash, avatar_color, is_box, public_key, enc_private_key)
       VALUES (?, ?, '', ?, 1, ?, ?)`
    ).run(address, name, color, publicKey, wrappedPrivateKey);
    boxId = info.lastInsertRowid;
    const ins = db.prepare('INSERT OR IGNORE INTO shared_mailbox_members (box_id, user_id, enc_key, role) VALUES (?, ?, ?, ?)');
    for (const e of entries) ins.run(boxId, e.id, e.encKey, e.id === req.user.id ? 'owner' : 'member');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const boxUser = db.prepare('SELECT * FROM users WHERE id = ?').get(boxId);
  res.status(201).json({ box: boxView(boxUser, 'owner') });
});

// ── Détail (clés pour déverrouiller la boîte côté client) ────────────────────
router.get('/:id', (req, res) => {
  const m = membership(req.params.id, req.user.id);
  if (!m) return res.status(403).json({ error: 'Non membre de cette boîte' });
  const box = db.prepare('SELECT * FROM users WHERE id = ? AND is_box = 1').get(req.params.id);
  if (!box) return res.status(404).json({ error: 'Boîte introuvable' });
  const members = db.prepare(
    `SELECT u.id, u.email, u.display_name AS displayName, u.avatar_color AS avatarColor, sm.role
     FROM shared_mailbox_members sm JOIN users u ON u.id = sm.user_id WHERE sm.box_id = ? ORDER BY sm.role, u.display_name`
  ).all(box.id);
  res.json({
    box: {
      id: box.id, address: box.email, name: box.display_name, color: box.avatar_color,
      publicKey: box.public_key, wrappedPrivateKey: box.enc_private_key, myEncKey: m.enc_key, role: m.role, members,
    },
  });
});

// ── Liste des messages d'un dossier de la boîte ──────────────────────────────
router.get('/:id/messages', (req, res) => {
  const m = membership(req.params.id, req.user.id);
  if (!m) return res.status(403).json({ error: 'Non membre' });
  const boxId = Number(req.params.id);
  const folder = BOX_FOLDERS.includes(req.query.folder) ? req.query.folder : 'inbox';
  const showRecipients = folder === 'sent';
  const mine = req.query.assignee === 'me'; // filtre « assignés à moi »
  const rows = db.prepare(
    `SELECT mi.id AS itemId, mi.is_read AS isRead, mi.is_starred AS isStarred, mi.assigned_to AS assignedTo,
            msg.id AS messageId, msg.thread_id AS threadId, msg.sender_id AS senderId, msg.sent_at AS sentAt,
            msg.is_encrypted AS isEncrypted, msg.subject, msg.body, msg.ciphertext, msg.iv, mk.enc_key AS encKey
     FROM mail_items mi
     JOIN messages msg ON msg.id = mi.message_id
     LEFT JOIN message_keys mk ON mk.message_id = msg.id AND mk.user_id = ?
     WHERE mi.user_id = ? AND mi.folder = ?
       ${mine ? 'AND mi.assigned_to = ?' : ''}
       AND (msg.expires_at IS NULL OR msg.expires_at > datetime('now'))
     ORDER BY msg.sent_at DESC, msg.id DESC LIMIT 200`
  ).all(...(mine ? [boxId, boxId, folder, req.user.id] : [boxId, boxId, folder]));
  // Pré-charge expéditeurs/assignés et destinataires en 1 requête chacun (anti N+1).
  const senders = senderMapFor([...rows.map((r) => r.senderId), ...rows.map((r) => r.assignedTo)]);
  const recipsByMsg = showRecipients ? recipientsMapFor(rows.map((r) => r.messageId)) : null;
  const items = rows.map((r) => {
    const peers = recipsByMsg ? (recipsByMsg.get(r.messageId) || { to: [], cc: [] }) : null;
    const peopleLabel = showRecipients
      ? ([...peers.to, ...peers.cc].map((p) => p.displayName).join(', ') || 'Aucun destinataire')
      : (senders.get(r.senderId)?.displayName || 'Inconnu');
    return {
      itemId: r.itemId, messageId: r.messageId, threadId: r.threadId, folder,
      isRead: !!r.isRead, isStarred: !!r.isStarred,
      isEncrypted: !!r.isEncrypted, ciphertext: r.ciphertext, iv: r.iv, encKey: r.encKey,
      subject: r.isEncrypted ? null : (r.subject || '(sans objet)'),
      snippet: r.isEncrypted ? null : snippet(r.body),
      sentAt: r.sentAt, from: senders.get(r.senderId) || null, peopleLabel,
      assignee: r.assignedTo ? (senders.get(r.assignedTo) || null) : null,
    };
  });
  res.json({ folder, items });
});

// ── Détail d'un message + fil ────────────────────────────────────────────────
router.get('/:id/messages/:itemId', (req, res) => {
  const m = membership(req.params.id, req.user.id);
  if (!m) return res.status(403).json({ error: 'Non membre' });
  const boxId = Number(req.params.id);
  const item = db.prepare('SELECT * FROM mail_items WHERE id = ? AND user_id = ?').get(req.params.itemId, boxId);
  if (!item) return res.status(404).json({ error: 'Message introuvable' });
  if (!item.is_read) db.prepare('UPDATE mail_items SET is_read = 1 WHERE id = ?').run(item.id); // lu partagé
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(item.message_id);
  const peers = recipientsView(msg.id);
  const thread = db.prepare(
    `SELECT DISTINCT msg.id, msg.sent_at AS sentAt, msg.sender_id AS senderId,
            msg.is_encrypted AS isEncrypted, msg.subject, msg.body, msg.ciphertext, msg.iv
     FROM messages msg JOIN mail_items mi ON mi.message_id = msg.id AND mi.user_id = ?
     WHERE msg.thread_id = ? ORDER BY msg.sent_at ASC, msg.id ASC`
  ).all(boxId, msg.thread_id).map((t) => ({
    id: t.id, sentAt: t.sentAt, from: senderView(t.senderId),
    isEncrypted: !!t.isEncrypted, ciphertext: t.ciphertext, iv: t.iv, encKey: myMsgKey(t.id, boxId),
    subject: t.isEncrypted ? null : t.subject, body: t.isEncrypted ? null : t.body,
  }));
  res.json({
    message: {
      itemId: item.id, messageId: msg.id, threadId: msg.thread_id, folder: item.folder,
      isEncrypted: !!msg.is_encrypted, ciphertext: msg.ciphertext, iv: msg.iv, encKey: myMsgKey(msg.id, boxId),
      subject: msg.is_encrypted ? null : (msg.subject || '(sans objet)'), body: msg.is_encrypted ? null : msg.body,
      sentAt: msg.sent_at, from: senderView(msg.sender_id), to: peers.to, cc: peers.cc, thread,
      assignee: item.assigned_to ? senderView(item.assigned_to) : null,
    },
  });
});

// ── Envoyer « depuis » la boîte ──────────────────────────────────────────────
// Le client chiffre pour chaque destinataire ET pour la boîte (clé publique de boîte)
// afin que la copie « Envoyés » reste lisible par tous les membres.
router.post('/:id/send', (req, res) => {
  const m = membership(req.params.id, req.user.id);
  if (!m) return res.status(403).json({ error: 'Non membre' });
  const boxId = Number(req.params.id);
  const { ciphertext, iv, keys = {}, inReplyTo = null } = req.body;
  if (!ciphertext || !iv) return res.status(400).json({ error: 'Charge chiffrée manquante' });
  const toIds = [...new Set((req.body.to || []).map(emailToId).filter(Boolean))];
  const ccIds = [...new Set((req.body.cc || []).map(emailToId).filter((id) => id && !toIds.includes(id)))];
  if (toIds.length + ccIds.length === 0) return res.status(400).json({ error: 'Aucun destinataire valide' });

  let threadId = randomUUID();
  if (inReplyTo) { const p = db.prepare('SELECT thread_id FROM messages WHERE id = ?').get(inReplyTo); if (p) threadId = p.thread_id; }

  let messageId;
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      "INSERT INTO messages (thread_id, sender_id, subject, body, in_reply_to, is_sent, is_encrypted, ciphertext, iv) VALUES (?, ?, '', '', ?, 1, 1, ?, ?)"
    ).run(threadId, boxId, inReplyTo || null, ciphertext, iv);
    messageId = info.lastInsertRowid;
    const insR = db.prepare('INSERT INTO recipients (message_id, user_id, kind) VALUES (?, ?, ?)');
    for (const id of toIds) insR.run(messageId, id, 'to');
    for (const id of ccIds) insR.run(messageId, id, 'cc');
    const insItem = db.prepare('INSERT INTO mail_items (user_id, message_id, folder, is_read) VALUES (?, ?, ?, ?)');
    for (const id of [...toIds, ...ccIds]) insItem.run(id, messageId, 'inbox', 0);
    insItem.run(boxId, messageId, 'sent', 1); // copie « Envoyés » de la boîte
    const insK = db.prepare('INSERT OR IGNORE INTO message_keys (message_id, user_id, enc_key) VALUES (?, ?, ?)');
    for (const [email, encKey] of Object.entries(keys)) { const uid = emailToId(email); if (uid && encKey) insK.run(messageId, uid, encKey); }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  for (const id of [...toIds, ...ccIds]) notifyUser(id, { type: 'mail:new' });
  res.status(201).json({ message: { id: messageId } });
});

// ── Drapeaux / déplacement (lu, étoile, archive, corbeille) — état partagé ────
router.patch('/:id/messages/:itemId', (req, res) => {
  const m = membership(req.params.id, req.user.id);
  if (!m) return res.status(403).json({ error: 'Non membre' });
  const item = db.prepare('SELECT * FROM mail_items WHERE id = ? AND user_id = ?').get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'Message introuvable' });
  const sets = [], params = [];
  if (typeof req.body.isRead === 'boolean') { sets.push('is_read = ?'); params.push(req.body.isRead ? 1 : 0); }
  if (typeof req.body.isStarred === 'boolean') { sets.push('is_starred = ?'); params.push(req.body.isStarred ? 1 : 0); }
  if (typeof req.body.folder === 'string' && ['inbox', 'archive', 'trash'].includes(req.body.folder)) { sets.push('folder = ?'); params.push(req.body.folder); }
  if ('assignedTo' in req.body) { // (ré)assignation manuelle à un membre (ou null = désassigner)
    const a = req.body.assignedTo;
    if (a === null || a === '') { sets.push('assigned_to = NULL'); }
    else {
      if (!membership(req.params.id, a)) return res.status(400).json({ error: 'Le destinataire doit être membre de la boîte' });
      sets.push('assigned_to = ?'); params.push(a);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'Rien à modifier' });
  params.push(item.id);
  db.prepare(`UPDATE mail_items SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

// ── Ajouter des membres (n'importe quel membre re-distribue la clé de boîte) ──
router.post('/:id/members', (req, res) => {
  const m = membership(req.params.id, req.user.id);
  if (!m) return res.status(403).json({ error: 'Non membre' });
  const ins = db.prepare("INSERT OR IGNORE INTO shared_mailbox_members (box_id, user_id, enc_key, role) VALUES (?, ?, ?, 'member')");
  let added = 0;
  for (const [email, encKey] of Object.entries(req.body.members || {})) { const id = emailToId(email); if (id && encKey) { ins.run(req.params.id, id, encKey); added++; } }
  res.json({ added });
});

// ── Retirer un membre (propriétaire) ─────────────────────────────────────────
router.delete('/:id/members/:userId', (req, res) => {
  const m = membership(req.params.id, req.user.id);
  if (!m || m.role !== 'owner') return res.status(403).json({ error: 'Réservé au propriétaire' });
  if (Number(req.params.userId) === req.user.id) return res.status(400).json({ error: 'Le propriétaire ne peut se retirer' });
  db.prepare('DELETE FROM shared_mailbox_members WHERE box_id = ? AND user_id = ?').run(req.params.id, req.params.userId);
  res.json({ ok: true });
});

// ── Règles de routage (« compte de reçu ») ───────────────────────────────────
// Le serveur ne voit que l'expéditeur → il assigne le message au membre désigné.
function normMatch(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === '*') return '*';
  if (s.startsWith('@')) return s;
  return normAddr(s);
}
const routeView = (r) => ({ id: r.id, matchFrom: r.match_from, sort: r.sort, enabled: !!r.enabled, assignee: senderView(r.assignee_id) });

router.get('/:id/routes', (req, res) => {
  if (!membership(req.params.id, req.user.id)) return res.status(403).json({ error: 'Non membre' });
  const routes = db.prepare('SELECT * FROM box_routes WHERE box_id = ? ORDER BY sort, id').all(req.params.id);
  res.json({ routes: routes.map(routeView) });
});

router.post('/:id/routes', (req, res) => {
  if (!membership(req.params.id, req.user.id)) return res.status(403).json({ error: 'Non membre' });
  const matchFrom = normMatch(req.body.matchFrom);
  if (!matchFrom) return res.status(400).json({ error: 'Filtre expéditeur requis (adresse, @domaine ou *)' });
  const assigneeId = emailToId(req.body.assignee);
  if (!assigneeId || !membership(req.params.id, assigneeId)) return res.status(400).json({ error: 'Assigné introuvable ou non membre de la boîte' });
  const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM box_routes WHERE box_id = ?').get(req.params.id).n;
  const info = db.prepare('INSERT INTO box_routes (box_id, match_from, assignee_id, sort) VALUES (?, ?, ?, ?)').run(req.params.id, matchFrom, assigneeId, sort);
  res.status(201).json({ route: routeView(db.prepare('SELECT * FROM box_routes WHERE id = ?').get(info.lastInsertRowid)) });
});

router.patch('/:id/routes/:routeId', (req, res) => {
  if (!membership(req.params.id, req.user.id)) return res.status(403).json({ error: 'Non membre' });
  const route = db.prepare('SELECT * FROM box_routes WHERE id = ? AND box_id = ?').get(req.params.routeId, req.params.id);
  if (!route) return res.status(404).json({ error: 'Règle introuvable' });
  if (typeof req.body.enabled === 'boolean') db.prepare('UPDATE box_routes SET enabled = ? WHERE id = ?').run(req.body.enabled ? 1 : 0, route.id);
  res.json({ route: routeView(db.prepare('SELECT * FROM box_routes WHERE id = ?').get(route.id)) });
});

router.delete('/:id/routes/:routeId', (req, res) => {
  if (!membership(req.params.id, req.user.id)) return res.status(403).json({ error: 'Non membre' });
  db.prepare('DELETE FROM box_routes WHERE id = ? AND box_id = ?').run(req.params.routeId, req.params.id);
  res.json({ ok: true });
});

// ── Supprimer la boîte (propriétaire) ────────────────────────────────────────
router.delete('/:id', (req, res) => {
  const m = membership(req.params.id, req.user.id);
  if (!m || m.role !== 'owner') return res.status(403).json({ error: 'Réservé au propriétaire' });
  const boxId = Number(req.params.id);
  db.exec('BEGIN');
  try {
    // Les messages envoyés PAR la boîte ne sont pas en cascade : on les retire d'abord.
    const sent = db.prepare('SELECT id FROM messages WHERE sender_id = ?').all(boxId).map((r) => r.id);
    const delMsg = db.prepare('DELETE FROM messages WHERE id = ?');
    for (const id of sent) delMsg.run(id); // cascade → recipients / mail_items / message_keys
    db.prepare('DELETE FROM mail_items WHERE user_id = ?').run(boxId);
    db.prepare('DELETE FROM message_keys WHERE user_id = ?').run(boxId);
    db.prepare('DELETE FROM recipients WHERE user_id = ?').run(boxId);
    db.prepare('DELETE FROM users WHERE id = ? AND is_box = 1').run(boxId); // cascade → shared_mailbox_members
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true });
});

export default router;
