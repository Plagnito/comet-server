import { db } from '../db.js';
import { notifyUser } from '../ws.js';
import { sendMail } from './mailbridge.js';

// File d'attente d'envoi SMTP (« outbox »). Objectif : découpler la requête HTTP
// de l'envoi réel. La route /send écrit une ligne « pending » et rend la main en
// quelques millisecondes ; ce worker draine la file en arrière-plan via le
// transport SMTP POOLÉ (mailbridge), avec retries à back-off. Bénéfices : la
// requête ne reste plus bloquée pendant toute la latence SMTP (souvent 1-5 s), les
// échecs sont retentés tout seuls (fini le « je renvoie » de l'utilisateur), et une
// rafale d'envois est lissée (batch borné) au lieu de piquer le serveur.

// Back-off entre tentatives (ms), indexé par nombre de tentatives déjà effectuées.
// 5 tentatives au total : immédiat, +30 s, +2 min, +10 min, +30 min → puis « failed ».
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000];
const MAX_ATTEMPTS = 5;
const BATCH = 20; // messages traités par tick (borne la charge d'un burst)

// Met un message en file d'attente d'envoi. Retourne l'id d'outbox.
export function enqueueMail(accountId, userId, payload) {
  const info = db
    .prepare('INSERT INTO mail_outbox (account_id, user_id, payload) VALUES (?, ?, ?)')
    .run(accountId, userId, JSON.stringify(payload || {}));
  return info.lastInsertRowid;
}

function notifyOut(userId, outboxId, ok, error) {
  try { notifyUser(userId, { type: 'mail:sent', outboxId, ok, error: error || null }); } catch { /* WS absent */ }
}

function markFailed(id, err, attempts) {
  if (attempts != null) {
    db.prepare("UPDATE mail_outbox SET status = 'failed', attempts = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?")
      .run(attempts, String(err).slice(0, 300), id);
  } else {
    db.prepare("UPDATE mail_outbox SET status = 'failed', last_error = ?, updated_at = datetime('now') WHERE id = ?")
      .run(String(err).slice(0, 300), id);
  }
}

let running = false; // évite le recouvrement de deux ticks (envois séquentiels)

// Traite un lot de messages en attente arrivés à échéance. Retourne le nb envoyés.
export async function runOutboxTick() {
  if (running) return 0;
  running = true;
  let sent = 0;
  try {
    const now = new Date().toISOString();
    const due = db
      .prepare(`SELECT * FROM mail_outbox WHERE status = 'pending' AND (next_attempt IS NULL OR next_attempt <= ?) ORDER BY id LIMIT ?`)
      .all(now, BATCH);
    for (const row of due) {
      const account = db.prepare('SELECT * FROM mail_accounts WHERE id = ?').get(row.account_id);
      if (!account) { markFailed(row.id, 'Compte supprimé'); notifyOut(row.user_id, row.id, false, 'Compte supprimé'); continue; }
      let payload;
      try { payload = JSON.parse(row.payload); } catch { markFailed(row.id, 'Charge illisible'); continue; }
      try {
        await sendMail(account, payload);
        db.prepare("UPDATE mail_outbox SET status = 'sent', attempts = attempts + 1, last_error = NULL, updated_at = datetime('now') WHERE id = ?").run(row.id);
        sent++;
        notifyOut(row.user_id, row.id, true);
      } catch (e) {
        const attempts = row.attempts + 1;
        const msg = String(e && e.message ? e.message : e).slice(0, 300);
        if (attempts >= MAX_ATTEMPTS) {
          markFailed(row.id, msg, attempts);
          notifyOut(row.user_id, row.id, false, msg);
        } else {
          const delay = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
          const next = new Date(Date.now() + delay).toISOString();
          db.prepare("UPDATE mail_outbox SET attempts = ?, last_error = ?, next_attempt = ?, updated_at = datetime('now') WHERE id = ?").run(attempts, msg, next, row.id);
        }
      }
    }
  } finally { running = false; }
  return sent;
}

// Planificateur : draine la file à intervalle régulier. Le premier tick part vite
// (1,5 s) pour vider ce qui aurait été mis en file juste avant le démarrage.
export function startOutboxSender(intervalMs = 5000) {
  const t = setInterval(() => { runOutboxTick().catch((e) => console.error('outbox tick failed:', e.message)); }, intervalMs);
  t.unref?.();
  setTimeout(() => { runOutboxTick().catch(() => {}); }, 1500);
  return t;
}
