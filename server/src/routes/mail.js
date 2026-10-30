import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { db } from '../db.js';
import { authRequired } from '../auth.js';
import { deliverMessage } from '../services/mail.js';
import { applyRules } from '../services/rules.js';
import { applyBoxRoutes } from '../services/boxroutes.js';
import { suivreLivraison } from '../services/remisedirecte.js';
import { apercu } from '../services/apercu.js';
import { etatQuota } from '../services/quota.js';
import { notifyUser } from '../ws.js';

const router = Router();
router.use(authRequired);

const SYSTEM_FOLDERS = ['inbox', 'sent', 'drafts', 'archive', 'trash', 'scheduled'];
const MOVE_TARGETS = ['inbox', 'archive', 'trash']; // destinations autorisées d'un déplacement manuel
// L'aperçu d'une ligne de liste. Il passe par `apercu()` et NON par le seul `body` :
// un envoi commercial n'a souvent aucune version texte, et la liste affichait alors
// « Aucun aperçu » sur chaque ligne d'un courrier qui, lui, a bien un contenu.
const snippet = (body, bodyHtml) => apercu(body, bodyHtml);

function senderView(id) {
  const u = db.prepare('SELECT id, email, display_name, avatar_color FROM users WHERE id = ?').get(id);
  return u ? { id: u.id, email: u.email, displayName: u.display_name, avatarColor: u.avatar_color } : null;
}

// Remplace l'adresse affichée par celle d'émission choisie (alias / adresse pro),
// en gardant le nom et l'avatar du compte expéditeur. fromEmail NULL = email principal.
//
// Courrier EXTERNE (passerelle entrante) : il n'y a pas de compte Comet derrière
// l'expéditeur — le message est ancré sur le compte technique « facteur ». C'est
// extFromName qui porte alors le nom réel ; sans lui, une boîte pleine de courrier
// du dehors n'afficherait qu'une colonne de « Courrier externe ». On garde l'avatar
// du facteur : la couleur signale d'un coup d'œil ce qui vient de l'extérieur.
function applyFrom(sender, fromEmail, extFromName = null) {
  if (!sender) return sender;
  if (!fromEmail && !extFromName) return sender;
  return {
    ...sender,
    email: fromEmail || sender.email,
    displayName: extFromName || sender.displayName,
    external: !!extFromName,
  };
}

// Valide une adresse « De » : l'email principal du compte (→ NULL, défaut) ou un de
// SES alias actifs (adresse perso/pro). Toute autre valeur est ignorée (anti-usurpation).
function resolveFromEmail(user, raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v || v === String(user.email || '').toLowerCase()) return null;
  const a = db.prepare('SELECT 1 FROM aliases WHERE alias_email = ? AND owner_id = ? AND active = 1').get(v, user.id);
  return a ? v : null;
}

function recipientsView(messageId) {
  const rows = db.prepare(
    `SELECT r.kind, u.id, u.email, u.display_name AS displayName, u.avatar_color AS avatarColor, u.public_key AS publicKey
     FROM recipients r JOIN users u ON u.id = r.user_id WHERE r.message_id = ? ORDER BY r.id`
  ).all(messageId);
  return { to: rows.filter((r) => r.kind === 'to'), cc: rows.filter((r) => r.kind === 'cc') };
}

// Versions « batch » pour les listes : un seul SELECT au lieu d'un par ligne (anti N+1).
function senderMapFor(ids) {
  const map = new Map();
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return map;
  const ph = uniq.map(() => '?').join(',');
  for (const u of db.prepare(`SELECT id, email, display_name, avatar_color FROM users WHERE id IN (${ph})`).all(...uniq)) {
    map.set(u.id, { id: u.id, email: u.email, displayName: u.display_name, avatarColor: u.avatar_color });
  }
  return map;
}
function recipientsMapFor(messageIds) {
  const map = new Map();
  const uniq = [...new Set(messageIds.filter(Boolean))];
  if (!uniq.length) return map;
  const ph = uniq.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT r.message_id AS mid, r.kind, u.id, u.email, u.display_name AS displayName, u.avatar_color AS avatarColor, u.public_key AS publicKey
     FROM recipients r JOIN users u ON u.id = r.user_id WHERE r.message_id IN (${ph}) ORDER BY r.id`
  ).all(...uniq);
  for (const row of rows) {
    let e = map.get(row.mid);
    if (!e) { e = { to: [], cc: [] }; map.set(row.mid, e); }
    const entry = { kind: row.kind, id: row.id, email: row.email, displayName: row.displayName, avatarColor: row.avatarColor, publicKey: row.publicKey };
    (row.kind === 'cc' ? e.cc : e.to).push(entry);
  }
  return map;
}

function emailToId(raw) {
  let email = String(raw || '').trim().toLowerCase();
  if (!email) return null;
  if (!email.includes('@')) email = `${email}@comet.mail`;
  const u = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (u) return u.id;
  // Adresses alias actives → compte propriétaire
  const a = db.prepare('SELECT owner_id FROM aliases WHERE alias_email = ? AND active = 1').get(email);
  return a ? a.owner_id : null;
}
function resolveRecipients(emails = []) {
  const ids = [], unknown = [];
  for (const raw of emails) {
    const id = emailToId(raw);
    if (id) ids.push(id);
    else if (String(raw).trim()) unknown.push(String(raw).trim().toLowerCase());
  }
  return { ids: [...new Set(ids)], unknown };
}

const myKey = (messageId, userId) =>
  db.prepare('SELECT enc_key FROM message_keys WHERE message_id = ? AND user_id = ?').get(messageId, userId)?.enc_key || null;

// ── Compteurs ───────────────────────────────────────────────────────────────
router.get('/counts', (req, res) => {
  // Les messages reportés (snooze actif) sont exclus de la boîte de réception
  const rows = db.prepare(
    `SELECT folder, COUNT(*) AS total, SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread
     FROM mail_items WHERE user_id = ?
       AND (snoozed_until IS NULL OR snoozed_until <= datetime('now'))
     GROUP BY folder`
  ).all(req.user.id);
  const counts = {};
  for (const f of SYSTEM_FOLDERS) counts[f] = { total: 0, unread: 0 };
  for (const r of rows) counts[r.folder] = { total: r.total, unread: r.unread || 0 };
  const snoozed = db.prepare("SELECT COUNT(*) AS n FROM mail_items WHERE user_id = ? AND snoozed_until IS NOT NULL AND snoozed_until > datetime('now')").get(req.user.id).n;
  counts.snoozed = { total: snoozed, unread: 0 };
  res.json({ counts });
});

// ── Liste ─────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const reqFolder = req.query.folder;
  const folder = (SYSTEM_FOLDERS.includes(reqFolder) || reqFolder === 'snoozed') ? reqFolder : 'inbox';
  const q = String(req.query.q || '').trim().toLowerCase();
  const showRecipients = folder === 'sent' || folder === 'drafts' || folder === 'scheduled';

  // Le report (snooze) masque l'élément de la boîte ; la vue « Reportés » ne montre que ceux-là.
  let folderClause = 'mi.folder = ?'; const fParams = [folder];
  if (folder === 'snoozed') { folderClause = "mi.folder = 'inbox' AND mi.snoozed_until IS NOT NULL AND mi.snoozed_until > datetime('now')"; fParams.length = 0; }
  else if (folder === 'inbox') { folderClause = "mi.folder = 'inbox' AND (mi.snoozed_until IS NULL OR mi.snoozed_until <= datetime('now'))"; fParams.length = 0; }

  let sql = `
    SELECT mi.id AS itemId, mi.folder, mi.is_read AS isRead, mi.is_starred AS isStarred, mi.snoozed_until AS snoozedUntil,
           m.id AS messageId, m.thread_id AS threadId, m.subject, m.body, m.body_html AS bodyHtml,
           m.sent_at AS sentAt, m.scheduled_at AS scheduledAt,
           m.sender_id AS senderId, m.from_email AS fromEmail, m.ext_from_name AS extFromName,
           m.is_sent AS isSent, m.is_encrypted AS isEncrypted,
           m.ciphertext, m.iv, m.expires_at AS expiresAt, m.burn_after_read AS burnAfterRead, mk.enc_key AS encKey
    FROM mail_items mi
    JOIN messages m ON m.id = mi.message_id
    LEFT JOIN message_keys mk ON mk.message_id = m.id AND mk.user_id = ?
    WHERE mi.user_id = ? AND ${folderClause}
      AND (m.expires_at IS NULL OR m.expires_at > datetime('now'))`;
  const params = [req.user.id, req.user.id, ...fParams];
  if (q) { sql += ' AND (LOWER(m.subject) LIKE ? OR LOWER(m.body) LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY m.sent_at DESC, m.id DESC LIMIT 200';

  const rows = db.prepare(sql).all(...params);
  // Pré-charge expéditeurs et destinataires en 1 requête chacun (au lieu de N par ligne).
  const senders = senderMapFor(rows.map((r) => r.senderId));
  const recipsByMsg = showRecipients ? recipientsMapFor(rows.map((r) => r.messageId)) : null;
  const items = rows.map((r) => {
    const peers = recipsByMsg ? (recipsByMsg.get(r.messageId) || { to: [], cc: [] }) : null;
    const peopleLabel = showRecipients
      ? ([...peers.to, ...peers.cc].map((p) => p.displayName).join(', ') || 'Aucun destinataire')
      : (r.extFromName || senders.get(r.senderId)?.displayName || 'Inconnu');
    return {
      itemId: r.itemId, messageId: r.messageId, threadId: r.threadId, folder: r.folder,
      isRead: !!r.isRead, isStarred: !!r.isStarred, isDraft: !r.isSent,
      isEncrypted: !!r.isEncrypted, ciphertext: r.ciphertext, iv: r.iv, encKey: r.encKey,
      isEphemeral: !!(r.expiresAt || r.burnAfterRead), burnAfterRead: !!r.burnAfterRead, expiresAt: r.expiresAt || null,
      subject: r.isEncrypted ? null : (r.subject || '(sans objet)'),
      snippet: r.isEncrypted ? null : snippet(r.body, r.bodyHtml),
      sentAt: r.sentAt, scheduledAt: r.scheduledAt || null, snoozedUntil: r.snoozedUntil || null, from: applyFrom(senders.get(r.senderId) || null, r.fromEmail, r.extFromName), peopleLabel,
    };
  });
  res.json({ folder, items });
});

// ── Synchronisation d'un client hors ligne ───────────────────────────────
//
// ⚠️ DOIT rester déclarée AVANT `/:id`, sinon Express prend « sync » pour un
// identifiant et cette route n'est jamais atteinte.
//
//   GET /api/mail/sync            → instantané complet + curseur de départ
//   GET /api/mail/sync?since=<n>  → seulement ce qui a changé depuis le curseur
//
// Les changements sont lus dans `mail_changes`, alimenté par déclencheurs (voir db.js).
// Un `updated_at` ne suffirait pas : il ne dit rien des suppressions, et sa résolution
// à la seconde perd deux modifications rapprochées.
router.get('/sync', (req, res) => {
  const depuis = Number.parseInt(req.query.since, 10) || 0;
  const limite = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 500, 1), 2000);

  // Lire le curseur AVANT les données. Dans l'autre ordre, un changement survenu entre
  // les deux lectures serait considéré comme déjà livré et perdu pour toujours. Ici, il
  // sera renvoyé au prochain appel : un doublon est rattrapable, une perte non.
  const seqMax = db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM mail_changes').get().s;

  // Première synchronisation : les déclencheurs ne valent que pour l'avenir, le journal
  // ne connaît donc pas les messages déjà en base. On envoie l'état courant en entier.
  if (depuis <= 0) {
    const items = chargerItems(req.user.id, null, limite);
    return res.json({
      curseur: seqMax,
      complet: true,
      items,
      supprimes: [],
      encore: items.length >= limite,
    });
  }

  const changements = db.prepare(`
    SELECT seq, item_id AS itemId, kind
      FROM mail_changes
     WHERE user_id = ? AND seq > ?
     ORDER BY seq
     LIMIT ?
  `).all(req.user.id, depuis, limite);

  if (changements.length === 0) {
    return res.json({ curseur: seqMax, complet: false, items: [], supprimes: [], encore: false });
  }

  // Un même élément peut avoir bougé plusieurs fois : seul son dernier état compte.
  // Une suppression qui suit des modifications l'emporte, puisqu'elle a le seq le plus haut.
  const dernier = new Map();
  for (const c of changements) dernier.set(c.itemId, c.kind);

  const aCharger = [...dernier].filter(([, k]) => k === 'upsert').map(([id]) => id);
  const items = aCharger.length ? chargerItems(req.user.id, aCharger, limite) : [];

  // Un élément annoncé « upsert » mais introuvable a été supprimé entre-temps : le dire
  // au client, sinon il garderait un message que le serveur n'a plus.
  const trouves = new Set(items.map((i) => i.itemId));
  const supprimes = [...dernier]
    .filter(([id, k]) => k === 'delete' || (k === 'upsert' && !trouves.has(id)))
    .map(([id]) => id);

  const dernierSeq = changements[changements.length - 1].seq;
  res.json({
    curseur: dernierSeq,
    complet: false,
    items,
    supprimes,
    // Le client rappelle tant que ce drapeau est vrai : un rattrapage après une longue
    // absence tient rarement en un seul lot.
    encore: dernierSeq < seqMax,
  });
});

// Charge des éléments de boîte, tous dossiers confondus. `ids` à null = tout le compte.
// Même forme d'objet que la liste, pour que le client n'ait qu'un seul modèle à écrire.
function chargerItems(userId, ids, limite) {
  const filtre = ids ? ` AND mi.id IN (${ids.map(() => '?').join(',')})` : '';
  const rows = db.prepare(`
    SELECT mi.id AS itemId, mi.folder, mi.is_read AS isRead, mi.is_starred AS isStarred,
           mi.snoozed_until AS snoozedUntil, mi.assigned_to AS assignedTo,
           m.id AS messageId, m.thread_id AS threadId, m.subject, m.body, m.body_html AS bodyHtml,
           m.sent_at AS sentAt,
           m.scheduled_at AS scheduledAt, m.sender_id AS senderId, m.from_email AS fromEmail,
           m.ext_from_name AS extFromName,
           m.is_sent AS isSent, m.is_encrypted AS isEncrypted, m.ciphertext, m.iv,
           m.expires_at AS expiresAt, m.burn_after_read AS burnAfterRead, mk.enc_key AS encKey
      FROM mail_items mi
      JOIN messages m ON m.id = mi.message_id
      LEFT JOIN message_keys mk ON mk.message_id = m.id AND mk.user_id = ?
     WHERE mi.user_id = ?${filtre}
     ORDER BY mi.id
     LIMIT ?
  `).all(userId, userId, ...(ids || []), limite);

  const senders = senderMapFor(rows.map((r) => r.senderId));
  return rows.map((r) => ({
    itemId: r.itemId, messageId: r.messageId, threadId: r.threadId, folder: r.folder,
    isRead: !!r.isRead, isStarred: !!r.isStarred, isDraft: !r.isSent,
    assignedTo: r.assignedTo || null,
    isEncrypted: !!r.isEncrypted, ciphertext: r.ciphertext, iv: r.iv, encKey: r.encKey,
    isEphemeral: !!(r.expiresAt || r.burnAfterRead), burnAfterRead: !!r.burnAfterRead,
    expiresAt: r.expiresAt || null,
    subject: r.isEncrypted ? null : (r.subject || '(sans objet)'),
    snippet: r.isEncrypted ? null : snippet(r.body, r.bodyHtml),
    sentAt: r.sentAt, scheduledAt: r.scheduledAt || null, snoozedUntil: r.snoozedUntil || null,
    from: applyFrom(senders.get(r.senderId) || null, r.fromEmail, r.extFromName),
  }));
}

// ── Détail ───────────────────────────────────────────────────────────────
/**
 * Ce que pèse la boîte, et sa limite — pour le dire AVANT qu'un message soit refusé.
 *
 * ⚠️ DÉCLARÉE AVANT `/:id`, et ce n'est pas cosmétique : Express prend la première route
 * qui correspond, donc plus bas, `/quota` serait lu comme un identifiant de message et
 * rendrait un 404 « Message introuvable » parfaitement incompréhensible.
 */
router.get('/quota', (req, res) => res.json(etatQuota(req.user.id)));

router.get('/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM mail_items WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Message introuvable' });
  if (!item.is_read) db.prepare('UPDATE mail_items SET is_read = 1 WHERE id = ?').run(item.id);

  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(item.message_id);
  if (m.expires_at && db.prepare("SELECT 1 AS e FROM messages WHERE id = ? AND expires_at <= datetime('now')").get(m.id)) {
    db.prepare('DELETE FROM messages WHERE id = ?').run(m.id);
    return res.status(404).json({ error: 'Message expiré' });
  }
  const peers = recipientsView(m.id);

  const thread = db.prepare(
    `SELECT DISTINCT m.id, m.subject, m.body, m.sent_at AS sentAt, m.sender_id AS senderId, m.from_email AS fromEmail,
            m.ext_from_name AS extFromName, m.is_encrypted AS isEncrypted, m.ciphertext, m.iv
     FROM messages m JOIN mail_items mi ON mi.message_id = m.id AND mi.user_id = ?
     WHERE m.thread_id = ? ORDER BY m.sent_at ASC, m.id ASC`
  ).all(req.user.id, m.thread_id).map((t) => ({
    id: t.id, sentAt: t.sentAt, from: applyFrom(senderView(t.senderId), t.fromEmail, t.extFromName),
    isEncrypted: !!t.isEncrypted, ciphertext: t.ciphertext, iv: t.iv, encKey: myKey(t.id, req.user.id),
    subject: t.isEncrypted ? null : t.subject, body: t.isEncrypted ? null : t.body,
  }));

  const out = {
    item: {
      itemId: item.id, messageId: m.id, threadId: m.thread_id, folder: item.folder,
      isRead: true, isStarred: !!item.is_starred, isDraft: !m.is_sent,
      isEncrypted: !!m.is_encrypted, ciphertext: m.ciphertext, iv: m.iv, encKey: myKey(m.id, req.user.id),
      isEphemeral: !!(m.expires_at || m.burn_after_read), burnAfterRead: !!m.burn_after_read, expiresAt: m.expires_at || null,
      subject: m.is_encrypted ? null : (m.subject || '(sans objet)'),
      body: m.is_encrypted ? null : m.body,
      // HTML d'origine du courrier externe, quand il y en a un. Jamais pour un message
      // chiffré : son contenu n'existe pas en clair côté serveur, par construction.
      // ⚠️ Contenu VENU DU DEHORS, ni nettoyé ni interprété (cf. db.js) : à afficher
      // isolé, sans script et sans ressource distante tant que le lecteur n'a rien demandé.
      bodyHtml: m.is_encrypted ? null : (m.body_html || null),
      // Les pièces jointes du courrier venu du dehors. Celles qui ne sont pas encore
      // (ou plus) disponibles sont listées quand même, avec leur état : un fichier qui
      // manque doit se VOIR, sinon le lecteur cherche une pièce qui n'arrivera jamais.
      attachments: [],
      sentAt: m.sent_at, from: applyFrom(senderView(m.sender_id), m.from_email, m.ext_from_name), to: peers.to, cc: peers.cc, thread,
    },
  };
  // Destruction après lecture : on supprime la copie reçue une fois consultée
  if (m.burn_after_read && item.folder === 'inbox') db.prepare('DELETE FROM mail_items WHERE id = ?').run(item.id);
  res.json(out);
});


// ── Envoi ───────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const { subject = '', body = '', inReplyTo = null, draftId = null, encrypted = false } = req.body;
  const fromEmail = resolveFromEmail(req.user, req.body.fromEmail); // adresse d'émission (alias/pro) ou NULL
  const toRes = resolveRecipients(req.body.to || []);
  const ccRes = resolveRecipients(req.body.cc || []);
  if (toRes.ids.length + ccRes.ids.length === 0) {
    return res.status(400).json({ error: 'Aucun destinataire valide', unknown: [...toRes.unknown, ...ccRes.unknown] });
  }

  let messageId;
  if (encrypted) {
    const { ciphertext, iv, keys = {} } = req.body;
    if (!ciphertext || !iv) return res.status(400).json({ error: 'Charge chiffrée manquante' });

    let threadId = randomUUID();
    if (inReplyTo) {
      const parent = db.prepare('SELECT thread_id FROM messages WHERE id = ?').get(inReplyTo);
      if (parent) threadId = parent.thread_id;
    }
    // Options éphémères
    const eph = req.body.ephemeral || {};
    const burn = eph.burnAfterRead ? 1 : 0;
    let expiresAt = null;
    const ttl = Math.floor(Number(eph.ttlSeconds) || 0);
    if (ttl > 0) expiresAt = db.prepare("SELECT datetime('now', ?) AS t").get(`+${ttl} seconds`).t;

    // Envoi programmé : on garde le chiffré et on ne délivre qu'à l'heure dite
    const schedTs = req.body.scheduledAt ? Date.parse(req.body.scheduledAt) : NaN;
    const isScheduled = !isNaN(schedTs) && schedTs > Date.now() + 5000;
    const scheduledAt = isScheduled ? new Date(schedTs).toISOString() : null;

    const info = db.prepare(
      'INSERT INTO messages (thread_id, sender_id, subject, body, in_reply_to, is_sent, is_encrypted, ciphertext, iv, expires_at, burn_after_read, scheduled_at, from_email) VALUES (?, ?, \'\', \'\', ?, 1, 1, ?, ?, ?, ?, ?, ?)'
    ).run(threadId, req.user.id, inReplyTo || null, ciphertext, iv, expiresAt, burn, scheduledAt, fromEmail);
    messageId = info.lastInsertRowid;

    const insR = db.prepare('INSERT INTO recipients (message_id, user_id, kind) VALUES (?, ?, ?)');
    for (const id of toRes.ids) insR.run(messageId, id, 'to');
    for (const id of ccRes.ids) insR.run(messageId, id, 'cc');

    const insItem = db.prepare('INSERT INTO mail_items (user_id, message_id, folder, is_read) VALUES (?, ?, ?, ?)');
    const inboxRecipients = [...new Set([...toRes.ids, ...ccRes.ids])];
    if (isScheduled) {
      insItem.run(req.user.id, messageId, 'scheduled', 1); // copie de l'expéditeur en attente
    } else {
      for (const id of inboxRecipients) {
        const it = insItem.run(id, messageId, 'inbox', 0);
        applyRules(id, req.user.id, it.lastInsertRowid);
        applyBoxRoutes(id, it.lastInsertRowid, req.user.id);
        // Remise directe : ouvre le suivi des accusés de réception. Ne fait rien si le
        // destinataire n'a pas activé l'option, ni s'il n'a aucun appareil enregistré —
        // sans appareil, le message serait effacé avant que quiconque ait pu le lire.
        suivreLivraison(id, it.lastInsertRowid);
      }
      insItem.run(req.user.id, messageId, 'sent', 1);
      for (const id of inboxRecipients) notifyUser(id, { type: 'mail:new' }); // temps réel
    }

    // Clé de message chiffrée pour chaque lecteur (le client fournit la table email→encKey)
    const insK = db.prepare('INSERT OR IGNORE INTO message_keys (message_id, user_id, enc_key) VALUES (?, ?, ?)');
    for (const [email, encKey] of Object.entries(keys)) {
      const uid = emailToId(email);
      if (uid && encKey) insK.run(messageId, uid, encKey);
    }

    // Réponses automatiques d'absence (à l'envoi réel uniquement, pas pour un message programmé)
    const today = new Date().toISOString().slice(0, 10);
    if (!isScheduled) for (const rid of new Set([...toRes.ids, ...ccRes.ids])) {
      if (rid === req.user.id) continue;
      const a = db.prepare('SELECT away_enabled, away_message, away_until FROM users WHERE id = ?').get(rid);
      if (a && a.away_enabled && (!a.away_until || a.away_until >= today)) {
        try {
          deliverMessage({ senderId: rid, to: [req.user.id], subject: 'Réponse automatique : absence', body: a.away_message || 'Je suis actuellement absent(e).', copyToSender: false });
        } catch (e) { console.error('auto-reply failed:', e.message); }
      }
    }
  } else {
    const message = deliverMessage({ senderId: req.user.id, to: toRes.ids, cc: ccRes.ids, subject: String(subject).trim(), body: String(body), inReplyTo: inReplyTo || null, fromEmail });
    messageId = message.id;
  }

  if (draftId) {
    const draftItem = db.prepare('SELECT * FROM mail_items WHERE id = ? AND user_id = ?').get(draftId, req.user.id);
    if (draftItem && draftItem.folder === 'drafts') db.prepare('DELETE FROM messages WHERE id = ? AND is_sent = 0').run(draftItem.message_id);
  }

  res.status(201).json({ message: { id: messageId }, unknown: [...toRes.unknown, ...ccRes.unknown] });
});

// ── Brouillon (chiffré pour soi-même) ───────────────────────────────────────
router.post('/draft', (req, res) => {
  const { id = null, ciphertext = null, iv = null, encKey = null } = req.body;
  const toRes = resolveRecipients(req.body.to || []);
  const ccRes = resolveRecipients(req.body.cc || []);

  let messageId;
  if (id) {
    const item = db.prepare('SELECT * FROM mail_items WHERE id = ? AND user_id = ? AND folder = ?').get(id, req.user.id, 'drafts');
    if (!item) return res.status(404).json({ error: 'Brouillon introuvable' });
    messageId = item.message_id;
    db.prepare("UPDATE messages SET ciphertext = ?, iv = ?, is_encrypted = 1, sent_at = datetime('now') WHERE id = ?").run(ciphertext, iv, messageId);
    db.prepare('DELETE FROM recipients WHERE message_id = ?').run(messageId);
    db.prepare('DELETE FROM message_keys WHERE message_id = ?').run(messageId);
  } else {
    const info = db.prepare(
      'INSERT INTO messages (thread_id, sender_id, subject, body, is_sent, is_encrypted, ciphertext, iv) VALUES (?, ?, \'\', \'\', 0, 1, ?, ?)'
    ).run(randomUUID(), req.user.id, ciphertext, iv);
    messageId = info.lastInsertRowid;
    db.prepare('INSERT INTO mail_items (user_id, message_id, folder, is_read) VALUES (?, ?, ?, 1)').run(req.user.id, messageId, 'drafts');
  }

  const insR = db.prepare('INSERT INTO recipients (message_id, user_id, kind) VALUES (?, ?, ?)');
  for (const uid of toRes.ids) insR.run(messageId, uid, 'to');
  for (const uid of ccRes.ids) insR.run(messageId, uid, 'cc');
  if (encKey) db.prepare('INSERT OR IGNORE INTO message_keys (message_id, user_id, enc_key) VALUES (?, ?, ?)').run(messageId, req.user.id, encKey);

  const item = db.prepare('SELECT id FROM mail_items WHERE message_id = ? AND user_id = ? AND folder = ?').get(messageId, req.user.id, 'drafts');
  res.json({ draftId: item.id, messageId });
});

// ── Drapeaux / déplacement ───────────────────────────────────────────────
router.patch('/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM mail_items WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Message introuvable' });
  const sets = [], params = [];
  if (typeof req.body.isRead === 'boolean') { sets.push('is_read = ?'); params.push(req.body.isRead ? 1 : 0); }
  if (typeof req.body.isStarred === 'boolean') { sets.push('is_starred = ?'); params.push(req.body.isStarred ? 1 : 0); }
  if (typeof req.body.folder === 'string' && MOVE_TARGETS.includes(req.body.folder)) { sets.push('folder = ?'); params.push(req.body.folder); }
  if (!sets.length) return res.status(400).json({ error: 'Rien à modifier' });
  params.push(item.id);
  db.prepare(`UPDATE mail_items SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

// ── Suppression ───────────────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM mail_items WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Message introuvable' });
  if (item.folder === 'scheduled') { // annulation : le message n'est jamais parti
    db.prepare('DELETE FROM messages WHERE id = ?').run(item.message_id);
    return res.json({ ok: true, cancelled: true });
  }
  if (item.folder === 'trash' || item.folder === 'drafts') {
    db.prepare('DELETE FROM mail_items WHERE id = ?').run(item.id);
    if (item.folder === 'drafts') db.prepare('DELETE FROM messages WHERE id = ? AND is_sent = 0').run(item.message_id);
    return res.json({ ok: true, deleted: true });
  }
  db.prepare('UPDATE mail_items SET folder = ? WHERE id = ?').run('trash', item.id);
  res.json({ ok: true, trashed: true });
});

// ── Report (snooze) : masque le message jusqu'à une date, puis le ramène ────
router.post('/:id/snooze', (req, res) => {
  const item = db.prepare('SELECT * FROM mail_items WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Message introuvable' });
  const until = req.body.until;
  if (until === null || until === '' || until === undefined) {
    db.prepare('UPDATE mail_items SET snoozed_until = NULL WHERE id = ?').run(item.id);
    return res.json({ ok: true, snoozedUntil: null });
  }
  const ts = Date.parse(until);
  if (isNaN(ts) || ts <= Date.now() + 1000) return res.status(400).json({ error: 'Date de report invalide (doit être future)' });
  // Format UTC « YYYY-MM-DD HH:MM:SS », comparable à datetime('now')
  const stored = new Date(ts).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare('UPDATE mail_items SET snoozed_until = ? WHERE id = ?').run(stored, item.id);
  res.json({ ok: true, snoozedUntil: stored });
});

export default router;
