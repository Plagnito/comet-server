import { Router } from 'express';
import { db } from '../db.js';
import { authRequired } from '../auth.js';
import { cleActive } from '../services/cles-connecteur.js';

const router = Router();
const getS = (k) => db.prepare('SELECT v FROM settings WHERE k = ?').get(k)?.v ?? null;
const setS = (k, v) => db.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
const enabled = () => getS('ai_enabled') === '1';

// Le connecteur repasse toutes les 60 s par défaut : au-delà de 5 minutes de
// silence, on le considère injoignable plutôt que « simplement en retard ».
const STALE_MIN = 5;
// Un travail sans réponse au-delà de ce délai est déclaré en échec, franchement.
// Sans cela, l'interface affichait « L'assistant réfléchit… » indéfiniment.
export const JOB_TIMEOUT_MIN = 5;

const fresh = (iso, minutes) => {
  const t = Date.parse(iso || '');
  return !isNaN(t) && Date.now() - t < minutes * 60000;
};

// ── Le connecteur est-il RÉELLEMENT en mesure de répondre ? ───────────────────
// Comet n'embarque aucun fournisseur IA : tout passe par le connecteur de
// l'organisation, qui doit tourner ET être lancé avec --ai-url. On sait dire
// laquelle de ces conditions manque — et on le dit, plutôt que d'empiler des
// questions dans une file que personne ne dépilera.
export function aiProviderState() {
  const on = enabled();
  const hasKey = cleActive('ia'); // une clé de connecteur active, avec le droit « ia »
  const lastSeen = getS('connector_last_seen');
  const aiSeen = getS('connector_ai_seen');           // dernier passage du connecteur sur la file IA
  const aiReady = getS('connector_ai_ready') === '1'; // le connecteur a-t-il un fournisseur IA ?
  const base = { enabled: on, hasConnector: hasKey, lastSeen, aiLastSeen: aiSeen };

  if (!on) return { ...base, state: 'off', ready: false, reason: null };
  if (!hasKey) return {
    ...base, state: 'no-connector', ready: false,
    reason: "Aucun connecteur n'est raccordé à ce serveur pour l'assistant. Un administrateur doit générer une clé avec le droit « IA » dans Réglages → Options avancées, puis lancer le connecteur avec l'option --ai-url.",
  };
  if (!fresh(lastSeen, STALE_MIN)) return {
    ...base, state: 'connector-offline', ready: false,
    reason: lastSeen
      ? "Le connecteur de l'organisation ne répond plus : l'assistant ne peut pas être interrogé tant qu'il n'est pas relancé."
      : "Le connecteur n'a jamais contacté ce serveur : l'assistant ne peut pas être interrogé tant qu'il n'est pas lancé.",
  };
  // Le connecteur tourne mais n'a pas de fournisseur IA : cas le plus courant, et
  // le plus trompeur si on le tait (tout a l'air branché, rien ne répond jamais).
  if (aiSeen && !aiReady) return {
    ...base, state: 'no-provider', ready: false,
    reason: "Le connecteur tourne mais AUCUN fournisseur IA n'y est configuré (option --ai-url absente). L'assistant est donc sans moteur : relancez le connecteur avec --ai-url (ex. Ollama : http://localhost:11434/api/generate).",
  };
  // Connecteur vivant qui n'est pas encore passé sur la file IA (activation toute
  // récente) : on laisse sa chance au prochain passage, le délai de garde tranchera.
  if (!aiSeen) return { ...base, state: 'unknown', ready: true, reason: null };
  return { ...base, state: 'ok', ready: true, reason: null };
}

// Déclare en échec les travaux que personne n'a honorés. Appelé à chaque lecture :
// pas de tâche de fond, et l'interface cesse de tourner dans le vide.
function expireStaleJobs() {
  db.prepare(
    `UPDATE ai_jobs SET status = 'error', error = ?, answered_at = datetime('now')
      WHERE status IN ('pending', 'claimed') AND created_at <= datetime('now', '-${JOB_TIMEOUT_MIN} minutes')`
  ).run(`Aucune réponse du connecteur IA après ${JOB_TIMEOUT_MIN} minutes — le connecteur tourne-t-il, et avec un fournisseur IA (--ai-url) ?`);
}

router.use(authRequired);
const adminOnly = (req, res, next) => (req.user.is_admin ? next() : res.status(403).json({ error: 'Réservé aux administrateurs' }));

const jobView = (j) => ({ id: j.id, prompt: j.prompt, answer: j.answer, status: j.status, error: j.error, createdAt: j.created_at, answeredAt: j.answered_at });

// L'IA tourne via le connecteur (chez l'organisation) — désactivée par défaut.
// On renvoie l'état RÉEL du moteur, pas seulement l'interrupteur.
router.get('/status', (req, res) => res.json(aiProviderState()));
router.post('/status', adminOnly, (req, res) => { setS('ai_enabled', req.body && req.body.enabled ? '1' : '0'); res.json(aiProviderState()); });

// Poser une question → met en file un travail traité par le connecteur.
router.post('/ask', (req, res) => {
  if (!enabled()) return res.status(400).json({ error: 'Assistant IA désactivé (l\'admin doit l\'activer).' });
  const st = aiProviderState();
  // On refuse d'accepter une question qu'aucun moteur ne viendra traiter : mieux
  // vaut un refus explicite qu'un travail qui reste « en cours » pour toujours.
  if (!st.ready) return res.status(503).json({ error: st.reason, state: st.state });
  const prompt = String((req.body && req.body.prompt) || '').trim().slice(0, 4000);
  if (!prompt) return res.status(400).json({ error: 'Question vide' });
  const info = db.prepare('INSERT INTO ai_jobs (user_id, prompt) VALUES (?, ?)').run(req.user.id, prompt);
  res.status(201).json({ job: jobView(db.prepare('SELECT * FROM ai_jobs WHERE id = ?').get(info.lastInsertRowid)) });
});

// Polling d'un travail (propriétaire uniquement).
router.get('/job/:id', (req, res) => {
  expireStaleJobs();
  const j = db.prepare('SELECT * FROM ai_jobs WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!j) return res.status(404).json({ error: 'Introuvable' });
  res.json({ job: jobView(j) });
});

router.get('/history', (req, res) => {
  expireStaleJobs();
  const rows = db.prepare('SELECT * FROM ai_jobs WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(req.user.id);
  res.json({ ...aiProviderState(), jobs: rows.map(jobView) });
});

export default router;
