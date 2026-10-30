// Tests d'intégration significatifs (non exhaustifs) : authentification, contrôle
// d'accès / IDOR (régression gestion.js), et limitation de débit.
// Un seul fichier → une seule instance d'app + une base partagée, exécution
// séquentielle. Les tests de rate-limit sont placés EN DERNIER (ils saturent les
// limiteurs et bloqueraient les connexions suivantes).
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { db } from '../src/db.js';

const login = async (email, password = 'comet1234') => {
  const r = await request(app).post('/api/auth/login').send({ email, password });
  return r;
};

let leaToken, marcToken;

beforeAll(async () => {
  leaToken = (await login('lea@comet.mail')).body.token;
  marcToken = (await login('marc@comet.mail')).body.token;
  expect(leaToken).toBeTruthy();
  expect(marcToken).toBeTruthy();
});

describe('Authentification', () => {
  it('connecte un compte de démo avec le bon mot de passe', async () => {
    const r = await login('lea@comet.mail');
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(r.body.user.email).toBe('lea@comet.mail');
  });

  it('refuse un mot de passe incorrect (401)', async () => {
    const r = await login('lea@comet.mail', 'mauvais-mot-de-passe');
    expect(r.status).toBe(401);
    expect(r.body.token).toBeUndefined();
  });

  it('refuse /me sans jeton (401)', async () => {
    const r = await request(app).get('/api/auth/me');
    expect(r.status).toBe(401);
  });

  it('accepte /me avec un jeton valide', async () => {
    const r = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${leaToken}`);
    expect(r.status).toBe(200);
    expect(r.body.user.email).toBe('lea@comet.mail');
  });

  it('rejette un corps de connexion invalide (Zod → 400 validation_error)', async () => {
    const r = await request(app).post('/api/auth/login').send({});
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('validation_error');
  });

});


describe('Pipelines — création ouverte à tous + périmètre organisation', () => {
  let sophieToken; let plId;

  beforeAll(async () => {
    // lea (manager) et marc (membre SANS permission can_pipelines) sont dans l'org
    // 9001 — posé ICI aussi, pour que ce bloc ne dépende pas d'un autre. sophie est
    // rattachée à une AUTRE org (9002) pour exercer l'isolation inter-org : elle ne
    // doit ni voir ni toucher ce pipeline.
    db.prepare("UPDATE users SET org_id = 9001, org_name = 'Org Test', org_role = 'manager' WHERE email = 'lea@comet.mail'").run();
    db.prepare("UPDATE users SET org_id = 9001, org_name = 'Org Test', org_role = 'member'  WHERE email = 'marc@comet.mail'").run();
    db.prepare("UPDATE users SET org_id = 9002, org_name = 'Autre Org', org_role = 'manager' WHERE email = 'sophie@comet.mail'").run();
    sophieToken = (await login('sophie@comet.mail')).body.token;
    expect(sophieToken).toBeTruthy();
  });

  it('laisse un membre simple (sans permission) créer un pipeline (201)', async () => {
    const r = await request(app).post('/api/pipelines')
      .set('Authorization', `Bearer ${marcToken}`).send({ name: 'Pipeline de Marc' });
    expect(r.status).toBe(201);
    expect(r.body.pipeline.name).toBe('Pipeline de Marc');
    plId = r.body.pipeline.id;
  });

  it('rend le pipeline visible aux autres membres de la même org', async () => {
    const r = await request(app).get('/api/pipelines').set('Authorization', `Bearer ${leaToken}`);
    expect(r.status).toBe(200);
    expect(r.body.pipelines.some((p) => p.id === plId)).toBe(true);
  });

  it('cache le pipeline aux membres d’une autre organisation', async () => {
    const r = await request(app).get('/api/pipelines').set('Authorization', `Bearer ${sophieToken}`);
    expect(r.status).toBe(200);
    expect(r.body.pipelines.some((p) => p.id === plId)).toBe(false);
  });

  it('interdit à une autre org de modifier le pipeline (404 anti-IDOR)', async () => {
    const r = await request(app).patch(`/api/pipelines/${plId}`)
      .set('Authorization', `Bearer ${sophieToken}`).send({ name: 'Détourné' });
    expect(r.status).toBe(404);
  });

  it('interdit à une autre org d’ajouter un projet au pipeline (404)', async () => {
    const r = await request(app).post(`/api/pipelines/${plId}/projects`)
      .set('Authorization', `Bearer ${sophieToken}`).send({ title: 'Intrus' });
    expect(r.status).toBe(404);
  });

  it('laisse le créateur (non manager) ajouter un projet à son pipeline (201)', async () => {
    const r = await request(app).post(`/api/pipelines/${plId}/projects`)
      .set('Authorization', `Bearer ${marcToken}`).send({ title: 'Première tâche' });
    expect(r.status).toBe(201);
  });
});

// ⚠️ EN DERNIER : ces tests saturent volontairement les limiteurs.
describe('Limitation de débit', () => {
  it('limite l’échange de code d’appairage d’extension (429 au-delà du seuil)', async () => {
    let got429 = false;
    for (let i = 0; i < 20; i++) {
      const r = await request(app).post('/api/extension/redeem').send({ code: 'codeinvalide' });
      if (r.status === 429) { got429 = true; break; }
    }
    expect(got429).toBe(true);
  });

  it('limite les tentatives de connexion échouées (429 au-delà du seuil)', async () => {
    let got429 = false;
    for (let i = 0; i < 30; i++) {
      const r = await login('inconnu@comet.mail', 'faux');
      if (r.status === 429) { got429 = true; break; }
    }
    expect(got429).toBe(true);
  });
});
