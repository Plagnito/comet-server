import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db, SYSTEM_EMAIL } from '../db.js';
import { authRequired } from '../auth.js';
import { deliverMessage } from '../services/mail.js';
import { notifyUser } from '../ws.js';
import { aiProviderState } from './assistant.js';
import {
  DROITS, creerCle, verifierCle, journaliser, listerCles, revoquerCle, revoquerToutes, journal, cleActive,
} from '../services/cles-connecteur.js';

const router = Router();
const getS = (k, def = '') => db.prepare('SELECT v FROM settings WHERE k = ?').get(k)?.v ?? def;
const setS = (k, v) => db.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
const all = (sql) => db.prepare(sql).all();

// Authentification par clé de connecteur, avec le DROIT que demande la route
// (services/cles-connecteur.js). 401 : clé inconnue, révoquée ou expirée ; 403 : clé
// valide mais sans ce droit. Chaque appel accepté est journalisé.
const connectorAuth = (droit = null) => (req, res, next) => {
  const claire = req.get('X-Connector-Key') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const v = verifierCle(claire);
  if (!v.ok) return res.status(401).json({ error: v.raison });
  if (droit && !v.cle.droits.includes(droit)) {
    return res.status(403).json({ error: `Cette clé n’a pas le droit « ${droit} ».`, code: 'droit-manquant', droit });
  }
  journaliser(v.cle.id, droit || 'config', req.path, req.ip);
  setS('connector_last_seen', new Date().toISOString());
  req.cleConnecteur = v.cle;
  next();
};

// ── Endpoints utilisés par le connecteur (auth par clé) ──────────────────────

// Snapshot complet pour archivage. Messages/chat = ciphertext (serveur aveugle).
router.get('/export', connectorAuth('export'), (req, res) => {
  res.json({
    generatedAt: new Date().toISOString(),
    users: all('SELECT id, email, display_name AS displayName, public_key AS publicKey, is_admin AS isAdmin, created_at AS createdAt FROM users'),
    messages: all('SELECT id, thread_id, sender_id, subject, body, ciphertext, iv, sent_at FROM messages'),
    recipients: all('SELECT message_id, user_id, kind FROM recipients'),
    messageKeys: all('SELECT message_id, user_id, enc_key FROM message_keys'),
    mailItems: all('SELECT user_id, message_id, folder, is_read, is_starred FROM mail_items'),
    events: all('SELECT * FROM events'),
    eventInvites: all('SELECT * FROM event_invites'),
    pipelines: all('SELECT * FROM pipelines'),
    pipelineProjects: all('SELECT * FROM pipeline_projects'),
    channels: all('SELECT id, name, description, created_by, created_at FROM channels'),
    channelMembers: all('SELECT channel_id, user_id, enc_key FROM channel_members'),
    chatMessages: all('SELECT id, channel_id, sender_id, ciphertext, iv, created_at FROM chat_messages'),
    contacts: all('SELECT * FROM contacts'),
    tasks: all('SELECT * FROM tasks'),
    notes: all('SELECT * FROM notes'),
    boardCards: all('SELECT * FROM board_cards'),
    vaultEntries: all('SELECT id, owner_id, ciphertext, iv, created_at FROM vault_entries'),
  });
});

// Création automatique de salons de conférence pour les événements à venir.
router.post('/process', connectorAuth('visio'), (req, res) => {
  const sys = db.prepare('SELECT id FROM users WHERE email = ?').get(SYSTEM_EMAIL);
  const due = db.prepare('SELECT * FROM events WHERE is_conference = 1 AND room_announced = 0').all();
  const now = Date.now();
  const mark = db.prepare('UPDATE events SET room_announced = 1 WHERE id = ?');
  let announced = 0;
  for (const e of due) {
    const start = Date.parse(e.starts_at);
    if (isNaN(start)) { mark.run(e.id); continue; }
    if (now >= start - 15 * 60000 && now <= start + 5 * 60000) {
      const room = `evt-${e.id}`;
      const recipients = new Set([e.owner_id]);
      for (const r of db.prepare("SELECT user_id FROM event_invites WHERE event_id = ? AND status = 'accepted'").all(e.id)) recipients.add(r.user_id);
      try {
        if (sys) deliverMessage({
          senderId: sys.id, to: [...recipients], copyToSender: false,
          subject: `Salle de conférence : ${e.title}`,
          body: `La salle de conférence pour « ${e.title} » est prête.\n\nOuvrez l'onglet Conférence et rejoignez le salon : ${room}\n\n— Connecteur Comet`,
        });
        announced++;
      } catch { /* ignore */ }
      mark.run(e.id);
    } else if (now > start + 5 * 60000) {
      mark.run(e.id); // trop tard, on ne spamme pas
    }
  }
  res.json({ announced });
});

// Toute clé valide lit la configuration, mais seulement ce qui concerne ses droits :
// le connecteur saute alors les tâches qu'il n'a pas le droit de faire.
router.get('/config', connectorAuth(), (req, res) => {
  const droits = req.cleConnecteur.droits;
  res.json({
    droits,
    storage: { enabled: getS('storage_enabled') === '1', path: getS('storage_path') },
    protools: { source: 'aucune' },
    // Assistant IA : indique au connecteur s'il doit traiter les questions.
    ai: { enabled: droits.includes('ia') && getS('ai_enabled') === '1' },
  });
});

// ── Assistant IA (file de travaux) ───────────────────────────────────────────
// Le connecteur récupère les questions en attente, appelle l'IA locale de l'org,
// puis renvoie les réponses. Les travaux « claimed » bloqués > 3 min repassent en file.
router.get('/ai/pending', connectorAuth('ia'), (req, res) => {
  // Le connecteur annonce s'il a bien un fournisseur IA (--ai-url). Un connecteur
  // d'une version antérieure n'envoie pas ce paramètre : il n'atteignait cet
  // endpoint QUE lorsqu'il avait une URL d'IA, on le considère donc prêt.
  const ready = req.query.ready === undefined ? true : req.query.ready === '1';
  setS('connector_ai_ready', ready ? '1' : '0');
  setS('connector_ai_seen', new Date().toISOString());
  if (getS('ai_enabled') !== '1' || !ready) return res.json({ jobs: [] });
  // Remise en file des travaux pris en charge mais jamais honorés (connecteur tombé
  // en cours de route). On se base sur l'heure de PRISE en charge : sur l'heure de
  // création, un travail lent était redistribué alors qu'il était encore en cours.
  const jobs = db.prepare(
    `SELECT id, prompt FROM ai_jobs
      WHERE status = 'pending'
         OR (status = 'claimed' AND COALESCE(claimed_at, created_at) <= datetime('now', '-3 minutes'))
      ORDER BY id LIMIT 5`
  ).all();
  const claim = db.prepare("UPDATE ai_jobs SET status = 'claimed', claimed_at = datetime('now') WHERE id = ?");
  for (const j of jobs) claim.run(j.id);
  res.json({ jobs });
});

router.post('/ai/answer', connectorAuth('ia'), (req, res) => {
  const { jobId, answer, error } = req.body || {};
  const j = db.prepare('SELECT * FROM ai_jobs WHERE id = ?').get(jobId);
  if (!j) return res.status(404).json({ error: 'Travail introuvable' });
  if (error) db.prepare("UPDATE ai_jobs SET status = 'error', error = ?, answered_at = datetime('now') WHERE id = ?").run(String(error).slice(0, 500), j.id);
  else db.prepare("UPDATE ai_jobs SET status = 'done', answer = ?, answered_at = datetime('now') WHERE id = ?").run(String(answer || '').slice(0, 20000), j.id);
  try { notifyUser(j.user_id, { type: 'ai:answer', jobId: j.id }); } catch { /* hors ligne */ }
  res.json({ ok: true });
});


// ── Gestion (réservée aux administrateurs) ───────────────────────────────────
router.use(authRequired);
router.use((req, res, next) => { if (!req.user.is_admin) return res.status(403).json({ error: 'Réservé aux administrateurs' }); next(); });

router.get('/status', (req, res) => {
  res.json({
    hasKey: cleActive(),
    lastSeen: getS('connector_last_seen') || null,
    storage: { enabled: getS('storage_enabled') === '1', path: getS('storage_path') },
    ai: aiProviderState(), // état réel du moteur IA, affiché tel quel dans les réglages
    droits: DROITS,
  });
});

// Clés : liste (jamais le hachage), création (la clé en clair n'est rendue qu'ici, une
// fois), révocation, journal des derniers appels.
router.get('/keys', (req, res) => res.json({ cles: listerCles(), droits: DROITS }));
router.post('/keys', (req, res) => {
  try {
    const { label, droits, expireLe } = req.body || {};
    const { cle, ligne } = creerCle({ label, droits, expireLe, par: req.user.id });
    res.status(201).json({ key: cle, cle: ligne });
  } catch (e) { res.status(e.statut || 500).json({ error: e.message }); }
});
router.delete('/keys/:id', (req, res) => {
  if (!revoquerCle(req.params.id)) return res.status(404).json({ error: 'Clé introuvable ou déjà révoquée' });
  res.json({ ok: true });
});
router.get('/audit', (req, res) => res.json({ journal: journal(req.query.limite) }));

// Anciennes routes, gardées compatibles : une clé à TOUS les droits, et la révocation
// de toutes les clés.
router.post('/key', (req, res) => {
  const { cle } = creerCle({ label: 'Connecteur', droits: DROITS, par: req.user.id });
  res.json({ key: cle }); // affiché une seule fois
});

router.delete('/key', (req, res) => {
  revoquerToutes();
  db.prepare("DELETE FROM settings WHERE k = 'connector_last_seen'").run();
  res.json({ ok: true });
});

router.put('/config', (req, res) => {
  if ('enabled' in req.body) setS('storage_enabled', req.body.enabled ? '1' : '0');
  if ('path' in req.body) setS('storage_path', String(req.body.path || '').slice(0, 300));
  res.json({ storage: { enabled: getS('storage_enabled') === '1', path: getS('storage_path') } });
});

router.get('/download', (req, res) => {
  const file = join(dirname(fileURLToPath(import.meta.url)), '../../../connector/comet-connector.mjs');
  try {
    const content = readFileSync(file, 'utf8');
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="comet-connector.mjs"');
    res.send(content);
  } catch {
    res.status(404).json({ error: 'Connecteur introuvable' });
  }
});

export default router;
