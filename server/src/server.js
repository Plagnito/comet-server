import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

import './config.js'; // valide JWT_SECRET au démarrage (refuse de démarrer si faible en prod)
import { errorHandler } from './util/errors.js';
import { purgeExpired, compacterJournalMail } from './db.js'; // initialise la base + le seed
import { startUpdater, localCommit } from './services/updater.js';
import { startReminderScheduler } from './services/reminders.js';
import { attachWebSocket } from './ws.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import mailRoutes from './routes/mail.js';
import calendarRoutes from './routes/calendar.js';
import pushRoutes from './routes/push.js';
import contactRoutes from './routes/contacts.js';
import taskRoutes from './routes/tasks.js';
import noteRoutes from './routes/notes.js';
import aliasRoutes from './routes/aliases.js';
import boardRoutes from './routes/board.js';
import templateRoutes from './routes/templates.js';
import groupRoutes from './routes/groups.js';
import vaultRoutes from './routes/vault.js';
import attachmentRoutes, { sweepLargeTransfers } from './routes/attachments.js';
import adminRoutes from './routes/admin.js';
import chatRoutes from './routes/chat.js';
import pipelineRoutes from './routes/pipelines.js';
import connectorRoutes from './routes/connector.js';
import extensionRoutes from './routes/extension.js';
import downloadRoutes from './routes/download.js';
import accountRoutes from './routes/accounts.js';
import roomRoutes from './routes/rooms.js';
import ruleRoutes from './routes/rules.js';
import sharedRoutes from './routes/shared.js';
import assistantRoutes from './routes/assistant.js';
import appConfigRoutes from './routes/appconfig.js';
import confRoutes from './routes/conf.js';
import appareilRoutes from './routes/appareils.js';
import { startMailSync } from './services/mailbridge.js';
import { startOutboxSender } from './services/outbox.js';
import { startScheduledSender } from './services/scheduled.js';
import { startSnoozeWaker } from './services/snooze.js';
import { demarrerPurge } from './services/remisedirecte.js';

// Résilience : on journalise les erreurs non gérées sans abattre le serveur
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4800;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
// 1 = on fait confiance à UN seul proxy (le tunnel Cloudflare / reverse-proxy).
// `true` ferait confiance à toute la chaîne et laisserait un client falsifier
// X-Forwarded-For (contournement du rate-limiting basé sur l'IP).
app.set('trust proxy', 1);

// ── En-têtes de sécurité (helmet) ───────────────────────────────────────────
// CSP désactivée ici : le front compilé (Vite) et les pages de callback OAuth
// contiennent des scripts/styles inline ; une CSP stricte les casserait.
// COOP « same-origin-allow-popups » : préserve window.opener pour les popups OAuth
// (la page de callback fait window.opener.postMessage).
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
}));

// ── CORS restreint à une liste blanche d'origines ───────────────────────────
// Le front est servi en same-origin (donc non concerné) et l'app de bureau charge
// la même origine ; l'extension passe par host_permissions (hors CORS). On
// n'autorise donc que les origines légitimes connues + le dev local.
const stripSlash = (s) => String(s || '').replace(/\/+$/, '');
const allowedOrigins = new Set(
  [
    process.env.COMET_BASE_URL,
    ...String(process.env.COMET_ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim()),
    'http://localhost:4800',
    'http://127.0.0.1:4800',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ]
    .filter(Boolean)
    .map(stripSlash),
);
// MÊME ORIGINE, toujours admise : le navigateur envoie un en-tête Origin y compris pour
// les scripts et feuilles de style de la page que CE serveur vient de servir (modules
// ES, attribut crossorigin) et pour ses POST. Sans cette règle, un serveur dont l'adresse
// n'est pas dans la liste (COMET_BASE_URL oublié, autre port, autre nom) rend une page
// BLANCHE. Comparer à l'en-tête Host est sûr : une page d'un autre site qui nous écrit
// porte SON origine, pas la nôtre, et un navigateur ne la laisse pas falsifier.
const hoteDemande = (req) => String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim().toLowerCase();
const memeOrigine = (origin, req) => {
  try { return new URL(origin).host.toLowerCase() === hoteDemande(req); } catch { return false; }
};
app.use(
  cors((req, cb) => {
    const origin = req.headers.origin;
    // Pas d'en-tête Origin = same-origin, app native, outils CLI, serveur-à-serveur.
    if (!origin || memeOrigine(origin, req) || allowedOrigins.has(stripSlash(origin))) {
      return cb(null, { origin: true, credentials: true });
    }
    return cb(new Error('Origine non autorisée par CORS'));
  }),
);

app.use(express.json({ limit: '2mb' }));

// ── Limitation de débit (anti-DoS / anti-brute-force) ───────────────────────
// Limiteur global d'API : généreux pour ne pas gêner le polling légitime, mais
// plafonne les flots abusifs depuis une même IP.
const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, réessayez dans un instant.' },
});
app.use('/api/', apiLimiter);

// Limiteur strict sur l'authentification (login / inscription / 2FA) : anti
// brute-force. skipSuccessfulRequests : seules les tentatives échouées comptent.
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Trop de tentatives. Réessayez plus tard.' },
});
app.use(['/api/auth/login', '/api/auth/register', '/api/auth/2fa/verify'], authLimiter);

// Limiteur dédié sur l'échange de code d'appairage d'extension : empêche tout
// brute-force du code (en plus de son entropie 128 bits et de son expiration).
const redeemLimiter = rateLimit({
  windowMs: 10 * 60_000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de tentatives d'appairage. Réessayez plus tard.", code: 'too_many_requests' },
});
app.use('/api/extension/redeem', redeemLimiter);

app.get('/api/health', (req, res) => res.json({ ok: true, app: 'comet', time: new Date().toISOString() }));

// Version déployée (commit git) — pour la mise à jour auto côté client
const COMMIT = localCommit() || 'dev';
app.get('/api/version', (req, res) => res.json({ commit: COMMIT }));

// Config ICE pour le P2P (WebRTC). Privacy-first : aucun serveur tiers par défaut.
// Renseignez COMET_STUN / COMET_TURN (idéalement votre propre coturn) pour le P2P hors-LAN.
app.get('/api/rtc-config', (req, res) => {
  const iceServers = [];
  if (process.env.COMET_STUN) iceServers.push({ urls: process.env.COMET_STUN });
  if (process.env.COMET_TURN) {
    iceServers.push({ urls: process.env.COMET_TURN, username: process.env.COMET_TURN_USER || '', credential: process.env.COMET_TURN_PASS || '' });
  }
  res.json({ iceServers });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/mail', mailRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/notes', noteRoutes);
app.use('/api/aliases', aliasRoutes);
app.use('/api/board', boardRoutes);
app.use('/api/vault', vaultRoutes);
app.use('/api/attachments', attachmentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/pipelines', pipelineRoutes);
app.use('/api/connector', connectorRoutes);
app.use('/api/extension', extensionRoutes);
app.use('/api/download', downloadRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/rules', ruleRoutes);
app.use('/api/shared', sharedRoutes);
app.use('/api/assistant', assistantRoutes);
app.use('/api/app-config', appConfigRoutes);
app.use('/api/conf', confRoutes);
app.use('/api/appareils', appareilRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/groups', groupRoutes);

// Sert le front compilé en production (client/dist)
const clientDist = join(__dirname, '..', '..', 'client', 'dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(join(clientDist, 'index.html'));
  });
}

app.use(errorHandler);

export { app };

// Démarre les tâches de fond + l'écoute UNIQUEMENT en exécution directe
// (`node src/server.js`). À l'import (tests via supertest), on n'ouvre ni port
// ni planificateurs : seul l'objet `app` est exposé.
const isMain = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1] || '').href; }
  catch { return false; }
})();

if (isMain) {
  // Purge périodique (messages éphémères, codes/jetons d'extension)
  purgeExpired();
  setInterval(purgeExpired, 60_000);

  // Rétention des transferts volumineux (web-seed) : purge les fichiers expirés
  sweepLargeTransfers();
  setInterval(sweepLargeTransfers, 5 * 60_000);

  // Journal de synchronisation du courrier : ne garder que le dernier changement par
  // élément. Sans cette compaction, `mail_changes` grossit à chaque lecture, chaque
  // étoile et chaque déplacement — indéfiniment, et sans que rien ne le signale.
  // Sûr pour les clients en retard : seuls les états intermédiaires disparaissent,
  // jamais le dernier connu (voir compacterJournalMail et test/mail-sync.test.js).
  compacterJournalMail();
  setInterval(compacterJournalMail, 6 * 60 * 60_000);

  // Mise à jour automatique depuis GitHub (no-op sans AUTO_UPDATE=1 + GITHUB_TOKEN)
  startUpdater();
  // Rappels d'événements (vérifie toutes les 30 s ; fonctionne sans l'outil/connecteur)
  startReminderScheduler();
  // Remise directe : balayage horaire. Il ne sert qu'aux ABANDONS (appareil jamais
  // revenu) — le cas courant est traité immédiatement, à l'accusé de réception.
  demarrerPurge();
  // Synchronisation des comptes mail externes (IMAP) en arrière-plan
  startMailSync();
  // Drain de la file d'envoi SMTP (outbox) : envoi en arrière-plan, transport poolé
  startOutboxSender();
  // Envoi des messages programmés à l'heure dite
  startScheduledSender();
  // Réveil des messages reportés (snooze)
  startSnoozeWaker();

  const server = app.listen(PORT, HOST, () => {
    console.log(`✦ Comet → http://${HOST}:${PORT}`);
  });
  attachWebSocket(server); // temps réel + signaling P2P sur /ws
}
