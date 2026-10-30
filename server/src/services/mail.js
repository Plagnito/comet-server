import { randomUUID } from 'node:crypto';
import { suivreLivraison } from './remisedirecte.js';
import { db } from '../db.js';
import { notifyUser } from '../ws.js';
import { applyRules } from './rules.js';

/**
 * Livre un message à l'intérieur de Comet (messagerie interne).
 * @param {object} p
 * @param {number} p.senderId
 * @param {number[]} p.to    ids utilisateurs (champ À)
 * @param {number[]} [p.cc]  ids utilisateurs (champ Cc)
 * @param {string} p.subject
 * @param {string} p.body
 * @param {number|null} [p.inReplyTo] id du message auquel on répond
 * @param {boolean} [p.copyToSender] créer une copie "Envoyés" pour l'expéditeur (def: true)
 * @param {string|null} [p.fromEmail] adresse d'émission (alias/pro) ; NULL = email principal
 * @param {string|null} [p.extFromName] nom de l'expéditeur EXTERNE (passerelle entrante).
 *   Le courrier venu du dehors n'a pas de compte Comet : `senderId` désigne alors le
 *   compte technique « facteur » et ces deux champs portent la VRAIE identité affichée.
 * @param {string|null} [p.extMessageId] Message-ID d'origine — sert à ne pas livrer deux
 *   fois le même message si la passerelle réessaie (index unique partiel côté base).
 * @returns {object} le message créé
 */
export function deliverMessage({ senderId, to = [], cc = [], subject = '', body = '', bodyHtml = null, inReplyTo = null, copyToSender = true, fromEmail = null, extFromName = null, extMessageId = null }) {
  const recipients = [
    ...to.map((id) => ({ id, kind: 'to' })),
    ...cc.map((id) => ({ id, kind: 'cc' })),
  ];
  if (recipients.length === 0) throw new Error('Aucun destinataire');

  // Fil de discussion : on hérite du thread du message d'origine, sinon nouveau
  let threadId = randomUUID();
  if (inReplyTo) {
    const parent = db.prepare('SELECT thread_id FROM messages WHERE id = ?').get(inReplyTo);
    if (parent) threadId = parent.thread_id;
  }

  const info = db
    .prepare(
      'INSERT INTO messages (thread_id, sender_id, subject, body, body_html, in_reply_to, is_sent, from_email, ext_from_name, ext_message_id) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)'
    )
    .run(threadId, senderId, subject, body, bodyHtml || null, inReplyTo, fromEmail || null, extFromName || null, extMessageId || null);
  const messageId = info.lastInsertRowid;

  const insRecipient = db.prepare('INSERT INTO recipients (message_id, user_id, kind) VALUES (?, ?, ?)');
  const insItem = db.prepare('INSERT INTO mail_items (user_id, message_id, folder, is_read) VALUES (?, ?, ?, ?)');

  // Une copie "boîte de réception" par destinataire unique
  const delivered = new Set();
  for (const r of recipients) {
    insRecipient.run(messageId, r.id, r.kind);
    if (!delivered.has(r.id)) {
      const it = insItem.run(r.id, messageId, 'inbox', 0);
      applyRules(r.id, senderId, it.lastInsertRowid); // filtres automatiques (tri par expéditeur)
      // Remise directe : même traitement que pour le courrier chiffré. Les messages
      // système (bienvenue, absence, rappels) passent aussi par ici et sont donc
      // effacés du serveur comme les autres une fois les appareils servis.
      suivreLivraison(r.id, it.lastInsertRowid);
      delivered.add(r.id);
    }
  }

  // Copie "Envoyés" pour l'expéditeur
  if (copyToSender) insItem.run(senderId, messageId, 'sent', 1);

  // Notification temps réel aux destinataires connectés
  for (const uid of delivered) notifyUser(uid, { type: 'mail:new' });

  return db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
}
