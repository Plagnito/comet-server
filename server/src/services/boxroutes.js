// Routage du « compte de reçu » (boîte partagée). À la réception d'un message dans
// une boîte, on ASSIGNE l'élément à un membre selon l'expéditeur (seule métadonnée
// visible du serveur). Le contenu reste chiffré : on ne fait qu'aiguiller la lecture.
import { db } from '../db.js';
import { notifyUser } from '../ws.js';

const matches = (matchFrom, email) => {
  const m = String(matchFrom || '').trim().toLowerCase();
  const e = String(email || '').trim().toLowerCase();
  if (!m) return false;
  if (m === '*') return true;                       // attrape-tout
  if (m.startsWith('@')) return e.endsWith(m);      // domaine
  return e === m;                                    // adresse exacte
};

// boxId = user_id de la boîte (is_box=1) ; mailItemId = l'élément 'inbox' de la boîte.
export function applyBoxRoutes(boxId, mailItemId, senderId) {
  const box = db.prepare('SELECT id FROM users WHERE id = ? AND is_box = 1').get(boxId);
  if (!box) return null;
  const routes = db.prepare('SELECT * FROM box_routes WHERE box_id = ? AND enabled = 1 ORDER BY sort, id').all(boxId);
  if (!routes.length) return null;
  const sender = db.prepare('SELECT email FROM users WHERE id = ?').get(senderId);
  const senderEmail = sender?.email || '';
  for (const r of routes) {
    if (matches(r.match_from, senderEmail)) {
      // l'assigné doit (encore) être membre de la boîte
      const member = db.prepare('SELECT 1 FROM shared_mailbox_members WHERE box_id = ? AND user_id = ?').get(boxId, r.assignee_id);
      if (!member) continue;
      db.prepare('UPDATE mail_items SET assigned_to = ? WHERE id = ?').run(r.assignee_id, mailItemId);
      try { notifyUser(r.assignee_id, { type: 'mail:new' }); } catch { /* hors ligne */ }
      return r.assignee_id;
    }
  }
  return null;
}
