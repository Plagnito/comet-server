import { db } from '../db.js';
import { notifyUser } from '../ws.js';

// Réveille les messages reportés dont l'heure est arrivée : on efface le report,
// on les remet « non lus » pour qu'ils ressortent, et on prévient l'utilisateur.
export function runSnoozeTick() {
  const due = db.prepare("SELECT id, user_id FROM mail_items WHERE snoozed_until IS NOT NULL AND snoozed_until <= datetime('now')").all();
  const wake = db.prepare('UPDATE mail_items SET snoozed_until = NULL, is_read = 0 WHERE id = ?');
  for (const it of due) { wake.run(it.id); notifyUser(it.user_id, { type: 'mail:new' }); }
  return due.length;
}

export function startSnoozeWaker(intervalMs = 20000) {
  const t = setInterval(() => { try { runSnoozeTick(); } catch (e) { console.error('snooze tick failed:', e.message); } }, intervalMs);
  t.unref?.();
  return t;
}
