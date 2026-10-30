import { db } from '../db.js';
import { notifyUser } from '../ws.js';

// Délivre les messages programmés dont l'heure est arrivée. Le serveur n'a gardé que
// du chiffré : il crée simplement les copies « boîte de réception » des destinataires
// et bascule la copie de l'expéditeur de « programmé » vers « envoyés ».
export function runScheduledTick() {
  const due = db.prepare('SELECT id, sender_id, scheduled_at FROM messages WHERE scheduled_at IS NOT NULL').all();
  const now = Date.now();
  const insItem = db.prepare('INSERT OR IGNORE INTO mail_items (user_id, message_id, folder, is_read) VALUES (?, ?, ?, ?)');
  const clear = db.prepare('UPDATE messages SET scheduled_at = NULL WHERE id = ?');
  const promote = db.prepare("UPDATE mail_items SET folder = 'sent' WHERE message_id = ? AND user_id = ? AND folder = 'scheduled'");
  let delivered = 0;
  for (const m of due) {
    const ts = Date.parse(m.scheduled_at);
    if (isNaN(ts)) { clear.run(m.id); continue; }
    if (ts > now) continue; // pas encore l'heure
    const recipients = [...new Set(db.prepare('SELECT user_id FROM recipients WHERE message_id = ?').all(m.id).map((r) => r.user_id))];
    for (const uid of recipients) { insItem.run(uid, m.id, 'inbox', 0); notifyUser(uid, { type: 'mail:new' }); }
    promote.run(m.id, m.sender_id);
    clear.run(m.id);
    notifyUser(m.sender_id, { type: 'mail:new' }); // rafraîchit l'expéditeur (programmé → envoyés)
    delivered++;
  }
  return delivered;
}

export function startScheduledSender(intervalMs = 20000) {
  const t = setInterval(() => { try { runScheduledTick(); } catch (e) { console.error('scheduled tick failed:', e.message); } }, intervalMs);
  t.unref?.();
  return t;
}
