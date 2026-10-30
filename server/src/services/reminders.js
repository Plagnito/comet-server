import { db, SYSTEM_EMAIL } from '../db.js';
import { deliverMessage } from './mail.js';

function fmtWhen(startsAt, allDay) {
  const d = new Date(startsAt);
  if (isNaN(d)) return startsAt;
  return d.toLocaleString('fr-FR', allDay ? { dateStyle: 'full' } : { dateStyle: 'full', timeStyle: 'short' });
}
function humanDelay(mins) {
  if (mins >= 1440) return `${Math.round(mins / 1440)} jour(s)`;
  if (mins >= 60) return `${Math.round(mins / 60)} h`;
  return `${mins} min`;
}

// Un passage : envoie les rappels dûs, marque-les comme envoyés (idempotent).
export function runReminderTick() {
  const sys = db.prepare('SELECT id FROM users WHERE email = ?').get(SYSTEM_EMAIL);
  if (!sys) return 0;
  const candidates = db.prepare('SELECT * FROM events WHERE reminder_minutes > 0 AND reminder_sent = 0').all();
  const now = Date.now();
  const mark = db.prepare('UPDATE events SET reminder_sent = 1 WHERE id = ?');
  let sent = 0;
  for (const e of candidates) {
    const start = Date.parse(e.starts_at);
    if (isNaN(start)) { mark.run(e.id); continue; }
    const remindAt = start - e.reminder_minutes * 60000;
    if (now < remindAt) continue; // pas encore l'heure du rappel
    // Dû. On n'envoie que dans une fenêtre raisonnable (évite de spammer d'anciens événements
    // si le serveur a été éteint), mais on marque toujours comme traité.
    if (now <= start + 5 * 60000) {
      const recipients = new Set([e.owner_id]);
      for (const r of db.prepare("SELECT user_id FROM event_invites WHERE event_id = ? AND status = 'accepted'").all(e.id)) recipients.add(r.user_id);
      try {
        deliverMessage({
          senderId: sys.id,
          to: [...recipients],
          subject: `Rappel : ${e.title}`,
          body:
            `« ${e.title} » commence dans ${humanDelay(e.reminder_minutes)}.\n\n` +
            `Quand : ${fmtWhen(e.starts_at, e.all_day)}\n` +
            (e.location ? `Où : ${e.location}\n` : '') +
            (e.description ? `\n${e.description}\n` : '') +
            `\n— Rappel automatique Comet`,
          copyToSender: false,
        });
        sent++;
      } catch { /* destinataire invalide : on marque quand même */ }
    }
    mark.run(e.id);
  }
  return sent;
}

export function startReminderScheduler(intervalMs = 30000) {
  const t = setInterval(() => {
    try { runReminderTick(); } catch (e) { console.error('reminder tick failed:', e.message); }
  }, intervalMs);
  t.unref?.();
  return t;
}
