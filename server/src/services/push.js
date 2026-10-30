// =============================================================================
//  NOTIFICATIONS BUREAU (Web Push) — quand Comet n'est PAS ouvert
// -----------------------------------------------------------------------------
//  Comet savait déjà prévenir en direct par WebSocket, mais uniquement tant qu'un
//  onglet restait ouvert. Fermé le navigateur, plus rien n'arrivait — or c'est
//  exactement là qu'une notification sert. Web Push comble ce trou : le navigateur
//  (via son service de push) réveille le service worker même application fermée.
//
//  🔴 RÈGLE ANTI-DOUBLON : on pousse UNIQUEMENT si l'utilisateur n'a aucun socket
//  ouvert. Comet ouvert → WebSocket (et la notification in-app existante) ; Comet
//  fermé → push. Sans cette règle, un utilisateur avec l'onglet en arrière-plan
//  recevrait DEUX notifications pour un seul mail.
//
//  🔐 E2EE : le serveur ne peut PAS lire un mail, et la charge du push ne contient
//  donc ni expéditeur ni objet — juste « nouveau message ». Ce n'est pas une
//  limitation qu'on subit, c'est la garantie du produit : un service de push tiers
//  (Google, Mozilla, Apple) voit passer la charge, il ne doit rien y apprendre.
//
//  Sans clés VAPID configurées, le module reste INERTE et le dit dans son état :
//  aucune promesse creuse, aucune erreur au démarrage.
// =============================================================================

import webpush from 'web-push';
import { db } from '../db.js';

const SUBJECT = process.env.COMET_PUSH_SUBJECT || 'mailto:support@comet.mail';
const PUBLIC_KEY = process.env.COMET_VAPID_PUBLIC || '';
const PRIVATE_KEY = process.env.COMET_VAPID_PRIVATE || '';

let configured = false;
if (PUBLIC_KEY && PRIVATE_KEY) {
  try { webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY); configured = true; }
  catch { configured = false; }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint   TEXT NOT NULL UNIQUE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
`);

export const isConfigured = () => configured;
export const publicKey = () => (configured ? PUBLIC_KEY : null);

// État HONNÊTE, pour l'UI : « activable » n'est pas « activé ».
export function status(userId) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(userId).n;
  return {
    configured,
    publicKey: publicKey(),
    subscriptions: n,
    reason: configured ? null : 'Notifications hors application indisponibles : le serveur n\'a pas de clés VAPID configurées.',
  };
}

// L'abonnement est identifié par son `endpoint` (unique par navigateur+appareil).
// Idempotent : se réabonner depuis le même navigateur ne crée pas de doublon.
export function subscribe(userId, sub) {
  const endpoint = String(sub?.endpoint || '');
  const p256dh = String(sub?.keys?.p256dh || '');
  const auth = String(sub?.keys?.auth || '');
  if (!endpoint || !p256dh || !auth) return { ok: false, error: 'Abonnement incomplet.' };
  db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
              ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
    .run(userId, endpoint, p256dh, auth);
  return { ok: true };
}

export function unsubscribe(userId, endpoint) {
  const r = db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, String(endpoint || ''));
  return { ok: true, removed: r.changes };
}

// Envoi. Un abonnement mort (404/410) est SUPPRIMÉ : garder des endpoints périmés
// ferait grossir la table et échouer chaque envoi pour rien.
export async function pushToUser(userId, payload) {
  if (!configured) return { sent: 0, skipped: 'non configuré' };
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  if (!subs.length) return { sent: 0, skipped: 'aucun abonnement' };
  const body = JSON.stringify(payload || {});
  let sent = 0, dropped = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 3600 });
      sent++;
    } catch (e) {
      const code = e?.statusCode;
      if (code === 404 || code === 410) { db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id); dropped++; }
    }
  }));
  return { sent, dropped };
}

// La charge d'un nouveau mail. Volontairement PAUVRE : rien à apprendre pour le
// service de push qui la relaie (cf. E2EE ci-dessus).
export function newMailPayload(kind) {
  return {
    type: 'mail',
    title: 'Comet — nouveau message',
    body: kind === 'ext' ? 'Un message est arrivé dans une boîte externe.' : 'Vous avez reçu un courrier chiffré.',
    tag: 'comet-mail',
    url: '/',
  };
}
