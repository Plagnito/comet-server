// Assistant IA : le contrat central est qu'on ne PROMET jamais un assistant qui
// n'a pas de moteur. Comet n'embarque aucun fournisseur IA — tout passe par le
// connecteur de l'organisation lancé avec --ai-url. Ces tests vérifient que
// chaque cas d'absence est refusé explicitement, et que le chemin complet
// (question → file → connecteur → réponse) fonctionne quand tout est en place.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { db } from '../src/db.js';

const login = async (email, password = 'comet1234') =>
  (await request(app).post('/api/auth/login').send({ email, password })).body.token;

const setS = (k, v) => db.prepare("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, String(v));
const delS = (k) => db.prepare('DELETE FROM settings WHERE k = ?').run(k);
const now = () => new Date().toISOString();

let admin, member, connKey;

beforeAll(async () => {
  db.prepare("UPDATE users SET is_admin = 1 WHERE email = 'lea@comet.mail'").run();
  admin = await login('lea@comet.mail');
  member = await login('marc@comet.mail');
  connKey = (await request(app).post('/api/connector/key').set('Authorization', `Bearer ${admin}`)).body.key;
  expect(connKey).toBeTruthy();
});

// La base est PARTAGÉE par tous les fichiers de tests (exécution séquentielle) :
// on rend l'organisation telle qu'on l'a trouvée pour ne pas piéger les suivants.
afterAll(() => {
  db.prepare("UPDATE users SET is_admin = 0 WHERE email = 'lea@comet.mail'").run();
  db.prepare('DELETE FROM ai_jobs').run();
  for (const k of ['ai_enabled', 'connector_key_hash', 'connector_last_seen', 'connector_ai_seen', 'connector_ai_ready']) delS(k);
});

// Chaque test repart d'un état connu : assistant activé, connecteur vu à l'instant,
// moteur IA annoncé disponible. Les tests éteignent ensuite ce qu'ils veulent tester.
beforeEach(() => {
  db.prepare('DELETE FROM ai_jobs').run();
  setS('ai_enabled', '1');
  setS('connector_last_seen', now());
  setS('connector_ai_seen', now());
  setS('connector_ai_ready', '1');
});

const ask = (token, prompt = 'Résume la réunion') =>
  request(app).post('/api/assistant/ask').set('Authorization', `Bearer ${token}`).send({ prompt });
const status = (token) => request(app).get('/api/assistant/status').set('Authorization', `Bearer ${token}`);

describe('Assistant IA — état du moteur', () => {
  it('signale « aucun connecteur » quand aucune clé n\'a été générée', async () => {
    const hash = db.prepare("SELECT v FROM settings WHERE k = 'connector_key_hash'").get()?.v;
    delS('connector_key_hash');
    const r = await status(member);
    expect(r.body.state).toBe('no-connector');
    expect(r.body.ready).toBe(false);
    expect(r.body.reason).toMatch(/connecteur/i);
    setS('connector_key_hash', hash); // on rétablit pour les tests suivants
  });

  it('signale un connecteur hors ligne quand il ne s\'est pas manifesté depuis longtemps', async () => {
    setS('connector_last_seen', new Date(Date.now() - 60 * 60000).toISOString());
    const r = await status(member);
    expect(r.body.state).toBe('connector-offline');
    expect(r.body.ready).toBe(false);
  });

  it('signale l\'absence de fournisseur IA quand le connecteur tourne sans --ai-url', async () => {
    setS('connector_ai_ready', '0');
    const r = await status(member);
    expect(r.body.state).toBe('no-provider');
    expect(r.body.ready).toBe(false);
    expect(r.body.reason).toMatch(/--ai-url/);
  });

  it('est prêt quand le connecteur tourne avec un fournisseur IA', async () => {
    const r = await status(member);
    expect(r.body.state).toBe('ok');
    expect(r.body.ready).toBe(true);
    expect(r.body.reason).toBeNull();
  });
});

describe('Assistant IA — refus francs plutôt que fausse attente', () => {
  it('refuse la question quand l\'assistant est désactivé', async () => {
    setS('ai_enabled', '0');
    const r = await ask(member);
    expect(r.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) n FROM ai_jobs').get().n).toBe(0);
  });

  it('refuse la question (503) et n\'empile RIEN quand aucun moteur ne répondra', async () => {
    setS('connector_ai_ready', '0');
    const r = await ask(member);
    expect(r.status).toBe(503);
    expect(r.body.state).toBe('no-provider');
    expect(r.body.error).toMatch(/--ai-url/);
    // Le point capital : pas de travail en file que personne ne dépilera.
    expect(db.prepare('SELECT COUNT(*) n FROM ai_jobs').get().n).toBe(0);
  });

  it('déclare en échec un travail resté sans réponse au-delà du délai de garde', async () => {
    const id = (await ask(member)).body.job.id;
    // On vieillit artificiellement le travail : le connecteur n'a jamais répondu.
    db.prepare("UPDATE ai_jobs SET created_at = datetime('now', '-30 minutes') WHERE id = ?").run(id);
    const r = await request(app).get(`/api/assistant/job/${id}`).set('Authorization', `Bearer ${member}`);
    expect(r.body.job.status).toBe('error');
    expect(r.body.job.error).toMatch(/Aucune réponse du connecteur/i);
  });
});

describe('Assistant IA — chemin complet question → connecteur → réponse', () => {
  it('achemine une question jusqu\'à la réponse du connecteur', async () => {
    const id = (await ask(member, 'Bonjour')).body.job.id;

    const pending = await request(app).get('/api/connector/ai/pending?ready=1').set('X-Connector-Key', connKey);
    expect(pending.body.jobs.map((j) => j.id)).toContain(id);
    expect(pending.body.jobs.find((j) => j.id === id).prompt).toBe('Bonjour');

    const ans = await request(app).post('/api/connector/ai/answer').set('X-Connector-Key', connKey)
      .send({ jobId: id, answer: 'Bonjour, comment puis-je aider ?' });
    expect(ans.status).toBe(200);

    const r = await request(app).get(`/api/assistant/job/${id}`).set('Authorization', `Bearer ${member}`);
    expect(r.body.job.status).toBe('done');
    expect(r.body.job.answer).toBe('Bonjour, comment puis-je aider ?');
  });

  it('ne redistribue pas un travail que le connecteur vient de prendre en charge', async () => {
    const id = (await ask(member)).body.job.id;
    const first = await request(app).get('/api/connector/ai/pending?ready=1').set('X-Connector-Key', connKey);
    expect(first.body.jobs.map((j) => j.id)).toContain(id);
    // Deuxième passage immédiat : le travail est en cours de traitement, on ne doit
    // pas le servir une seconde fois (double appel à l'IA, double réponse).
    const second = await request(app).get('/api/connector/ai/pending?ready=1').set('X-Connector-Key', connKey);
    expect(second.body.jobs.map((j) => j.id)).not.toContain(id);
  });

  it('un connecteur sans fournisseur IA le signale et ne reçoit aucun travail', async () => {
    const id = (await ask(member)).body.job.id;
    const r = await request(app).get('/api/connector/ai/pending?ready=0').set('X-Connector-Key', connKey);
    expect(r.body.jobs).toEqual([]);
    // Et le serveur a retenu l'information, pour la dire à l'utilisateur.
    expect((await status(member)).body.state).toBe('no-provider');
    // Le travail déjà en file reste intact (il expirera franchement).
    expect(db.prepare('SELECT status FROM ai_jobs WHERE id = ?').get(id).status).toBe('pending');
  });

  it('une réponse n\'est lisible que par le propriétaire du travail (pas d\'IDOR)', async () => {
    const id = (await ask(member)).body.job.id;
    const r = await request(app).get(`/api/assistant/job/${id}`).set('Authorization', `Bearer ${admin}`);
    expect(r.status).toBe(404);
  });

  it('réserve l\'activation de l\'assistant aux administrateurs', async () => {
    const r = await request(app).post('/api/assistant/status').set('Authorization', `Bearer ${member}`).send({ enabled: false });
    expect(r.status).toBe(403);
  });
});
