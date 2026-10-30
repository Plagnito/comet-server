import { db } from '../db.js';

// Une règle matche sur l'expéditeur : email exact, ou domaine « @exemple.com ».
function matches(rule, senderEmail) {
  const m = String(rule.match_from || '').trim().toLowerCase();
  if (!m) return false;
  const s = String(senderEmail || '').toLowerCase();
  return m.startsWith('@') ? s.endsWith(m) : s === m;
}

// Applique la première règle correspondante à un élément de boîte fraîchement livré.
// Ne lève jamais : un échec de règle ne doit pas empêcher la livraison du message.
export function applyRules(userId, senderId, itemId) {
  try {
    const sender = db.prepare('SELECT email FROM users WHERE id = ?').get(senderId);
    if (!sender) return null;
    const rules = db.prepare('SELECT * FROM mail_rules WHERE user_id = ? AND enabled = 1 ORDER BY id').all(userId);
    const rule = rules.find((r) => matches(r, sender.email));
    if (!rule) return null;
    const sets = [], params = [];
    if (rule.action_folder === 'archive' || rule.action_folder === 'trash') { sets.push('folder = ?'); params.push(rule.action_folder); }
    if (rule.action_star) sets.push('is_starred = 1');
    if (rule.action_read) sets.push('is_read = 1');
    if (sets.length) { params.push(itemId); db.prepare(`UPDATE mail_items SET ${sets.join(', ')} WHERE id = ?`).run(...params); }
    return rule;
  } catch (e) {
    console.error('applyRules failed:', e.message);
    return null;
  }
}
