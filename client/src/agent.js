// Agent IA de canal — pont CÔTÉ CLIENT. Le client (qui détient la clé du canal)
// déchiffre le contexte, interroge l'IA via la file du connecteur (/assistant),
// reçoit un plan structuré, crée un pipeline de suivi, exécute les actions sûres
// et demande confirmation pour les actions sensibles.
//
// ⚠️ PORTÉE EXACTE DU CHIFFREMENT — à ne pas surestimer. La clé du canal ne quitte
// jamais le navigateur, mais le CONTENU déchiffré part en clair dans le prompt :
// il est écrit tel quel dans `ai_jobs.prompt` côté serveur, puis lu par le
// connecteur. Le serveur n'est donc PAS aveugle sur ce qui passe par @ia, alors
// qu'il l'est sur les messages du canal eux-mêmes. Mentionner @ia = sortir
// volontairement ces messages de l'enveloppe E2EE, vers l'IA de son organisation.
// Rendre l'assistant réellement aveugle demanderait de chiffrer le prompt pour une
// paire de clés propre au connecteur — non fait à ce jour (cf. rapport).
import { api } from './api.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SYSTEM = `Tu es l'assistant IA intégré à Comet (suite de productivité d'équipe). Tu participes à un canal.
À partir de la conversation et de la demande, tu produis un PLAN concret et tu réponds STRICTEMENT en JSON valide, sans aucun texte autour, au format exact :
{
  "reply": "réponse courte au canal, en français",
  "pipeline": { "name": "nom du projet", "steps": ["étape 1", "étape 2"] } ,
  "actions": [
    { "type": "task", "risk": "low", "title": "...", "due": null },
    { "type": "note", "risk": "low", "title": "...", "body": "..." },
    { "type": "email", "risk": "high", "to": "adresse", "subject": "...", "body": "..." }
  ]
}
Règles : "pipeline" peut être null s'il n'y a pas de plan. Les actions "task" et "note" sont de risque "low". Toute action qui envoie/supprime/partage (email, delete, share) est de risque "high". N'invente pas d'adresses e-mail.`;

export async function runAgent({ request, transcript = [], contextSize = 50 }) {
  const convo = transcript.slice(-contextSize).map((m) => `${m.who}: ${m.text}`).join('\n');
  const prompt = `${SYSTEM}\n\n--- Conversation (derniers messages) ---\n${convo}\n\n--- Demande adressée à @ia ---\n${request}\n\nRéponds en JSON.`;
  const { job } = await api.post('/assistant/ask', { prompt });
  for (let i = 0; i < 120; i++) {
    await sleep(1500);
    const r = await api.get(`/assistant/job/${job.id}`);
    if (r.job.status === 'done') return parseAgent(r.job.answer);
    if (r.job.status === 'error') throw new Error(r.job.error || r.job.answer || 'Erreur de l\'IA');
  }
  throw new Error('Délai dépassé — le connecteur IA répond-il ?');
}

// Extraction robuste du JSON (l'IA peut bavarder autour).
export function parseAgent(answer) {
  let txt = String(answer || '').trim();
  const a = txt.indexOf('{'); const b = txt.lastIndexOf('}');
  if (a >= 0 && b > a) txt = txt.slice(a, b + 1);
  let o;
  try { o = JSON.parse(txt); } catch { o = { reply: String(answer || '').slice(0, 600) }; }
  const pipeline = o.pipeline && Array.isArray(o.pipeline.steps) && o.pipeline.steps.length
    ? { name: String(o.pipeline.name || 'Plan').slice(0, 80), steps: o.pipeline.steps.map((s) => String(s).slice(0, 120)).slice(0, 20) }
    : null;
  const actions = Array.isArray(o.actions) ? o.actions.filter((x) => x && x.type).slice(0, 20) : [];
  return { reply: String(o.reply || '').slice(0, 1200), pipeline, actions };
}

// Crée un pipeline de suivi : étapes du plan = projets dans la 1re colonne.
export async function createPlanPipeline(plan) {
  const r = await api.post('/pipelines', { name: plan.name, stages: ['À faire', 'En cours', 'Terminé'] });
  const id = r.pipeline.id;
  for (const step of plan.steps) {
    try { await api.post(`/pipelines/${id}/projects`, { title: step, stageIndex: 0 }); } catch {}
  }
  return r.pipeline;
}

// Exécute les actions sûres (création locale). Renvoie les libellés réalisés.
export async function runLowActions(actions) {
  const done = [];
  for (const act of actions) {
    if (act.risk === 'high') continue;
    try {
      if (act.type === 'task') { await api.post('/tasks', { title: act.title || 'Tâche', dueAt: act.due || null }); done.push(`tâche « ${act.title} »`); }
      else if (act.type === 'note') { await api.post('/notes', { title: act.title || '', body: act.body || '' }); done.push(`note « ${act.title || act.body?.slice(0, 24)} »`); }
    } catch {}
  }
  return done;
}

export const highActions = (actions) => actions.filter((a) => a.risk === 'high');
