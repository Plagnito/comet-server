// Audit C-23 : clés de connecteur à droits séparés, expiration, révocation, journal, et
// reprise de l'ancienne clé unique sans casser le connecteur déjà installé.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { app } from '../src/server.js';
import { db } from '../src/db.js';
import { DROITS, reprendreAncienneCle, MIGRATION_CLES } from '../src/services/cles-connecteur.js';

const login = async (email) => (await request(app).post('/api/auth/login').send({ email, password: 'comet1234' })).body.token;
let admin; let membre;
beforeAll(async () => {
  db.prepare("UPDATE users SET is_admin = 1 WHERE email = 'lea@comet.mail'").run();
  admin = await login('lea@comet.mail');
  membre = await login('marc@comet.mail');
});
afterAll(() => {
  db.prepare("UPDATE users SET is_admin = 0 WHERE email = 'lea@comet.mail'").run();
  db.prepare('DELETE FROM connector_keys').run();
  db.prepare('DELETE FROM connector_audit').run();
});

// Une route représentative par droit.
const ROUTES = {
  export: ['get', '/api/connector/export'],
  visio: ['post', '/api/connector/process'],
  ia: ['get', '/api/connector/ai/pending?ready=0'],
};
const creer = async (droits, extra = {}) => {
  const r = await request(app).post('/api/connector/keys').set('Authorization', `Bearer ${admin}`).send({ label: 'Essai', droits, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};
const appeler = (cle, [methode, chemin]) => request(app)[methode](chemin).set('X-Connector-Key', cle).send({});
const lignesJournal = (cleId) => db.prepare('SELECT COUNT(*) AS n FROM connector_audit WHERE key_id = ?').get(cleId).n;

describe('clés de connecteur à droits limités', () => {
  it('chaque route exige son droit : 403 sans lui, 200 avec, une ligne de journal par appel accepté', async () => {
    expect(Object.keys(ROUTES).sort()).toEqual([...DROITS].sort());
    for (const droit of DROITS) {
      const autres = DROITS.filter((d) => d !== droit);
      const sans = await creer(autres.length ? autres : ['export']);
      if (autres.length) {
        const r = await appeler(sans.key, ROUTES[droit]);
        expect(r.status, droit).toBe(403);
        expect(r.body).toMatchObject({ code: 'droit-manquant', droit });
      }
      const avec = await creer([droit]);
      const avant = lignesJournal(avec.cle.id);
      expect((await appeler(avec.key, ROUTES[droit])).status, droit).toBe(200);
      expect(lignesJournal(avec.cle.id)).toBe(avant + 1);
    }
  });

  it('clé révoquée, expirée ou inconnue : 401', async () => {
    const { key, cle } = await creer(['export']);
    expect((await appeler(key, ROUTES.export)).status).toBe(200);
    expect((await request(app).delete(`/api/connector/keys/${cle.id}`).set('Authorization', `Bearer ${admin}`)).status).toBe(200);
    expect((await appeler(key, ROUTES.export)).status).toBe(401);

    const b = await creer(['export'], { expireLe: new Date(Date.now() + 60_000).toISOString() });
    expect((await appeler(b.key, ROUTES.export)).status).toBe(200);
    db.prepare("UPDATE connector_keys SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(b.cle.id);
    const expiree = await appeler(b.key, ROUTES.export);
    expect(expiree.status).toBe(401);
    expect(expiree.body.error).toMatch(/expirée/);

    expect((await appeler('cmtk_inconnue', ROUTES.export)).status).toBe(401);
    expect((await appeler('', ROUTES.export)).status).toBe(401);
  });

  it('la configuration ne parle que des droits de la clé', async () => {
    db.prepare("INSERT INTO settings (k, v) VALUES ('ai_enabled', '1') ON CONFLICT(k) DO UPDATE SET v = '1'").run();
    const seulementExport = await creer(['export']);
    const c1 = (await request(app).get('/api/connector/config').set('X-Connector-Key', seulementExport.key)).body;
    expect(c1.droits).toEqual(['export']);
    expect(c1.ai.enabled).toBe(false);
    const ia = await creer(['ia']);
    expect((await request(app).get('/api/connector/config').set('X-Connector-Key', ia.key)).body.ai.enabled).toBe(true);
    db.prepare("DELETE FROM settings WHERE k = 'ai_enabled'").run();
  });

  it('la clé en clair n’est rendue qu’à la création ; la liste ne montre ni clé ni hachage', async () => {
    const { key } = await creer(['visio']);
    const liste = await request(app).get('/api/connector/keys').set('Authorization', `Bearer ${admin}`);
    expect(liste.status).toBe(200);
    const texte = JSON.stringify(liste.body);
    expect(texte).not.toContain(key);
    expect(texte).not.toContain(createHash('sha256').update(key).digest('hex'));
    expect(texte).not.toMatch(/key_hash|cmtk_/);
  });

  it('création refusée sans droit, avec une expiration passée, ou par un non-administrateur', async () => {
    const post = (jeton, corps) => request(app).post('/api/connector/keys').set('Authorization', `Bearer ${jeton}`).send(corps);
    expect((await post(admin, { label: 'x', droits: [] })).status).toBe(400);
    expect((await post(admin, { label: 'x', droits: ['inexistant'] })).status).toBe(400);
    expect((await post(admin, { label: 'x', droits: ['export'], expireLe: '2001-01-01' })).status).toBe(400);
    expect((await post(membre, { label: 'x', droits: ['export'] })).status).toBe(403);
  });

  it('journal des appels pour l’administrateur', async () => {
    const { key, cle } = await creer(['visio']);
    await appeler(key, ROUTES.visio);
    const j = await request(app).get('/api/connector/audit').set('Authorization', `Bearer ${admin}`);
    expect(j.body.journal.find((l) => l.cleId === cle.id)).toMatchObject({ droit: 'visio', route: '/process', cle: 'Essai' });
  });
});

describe('reprise de l’ancienne clé unique', () => {
  it('l’ancien secret marche encore, avec tous les droits ; une seule fois', async () => {
    const ancienne = 'cmtk_ancienne-cle'; // courte exprès : le détecteur de secrets l'ignore
    db.prepare("DELETE FROM settings WHERE k = ?").run(MIGRATION_CLES);
    db.prepare("INSERT INTO settings (k, v) VALUES ('connector_key_hash', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(createHash('sha256').update(ancienne).digest('hex'));
    expect(reprendreAncienneCle()).toBe(1);
    expect(db.prepare("SELECT v FROM settings WHERE k = 'connector_key_hash'").get()).toBeUndefined();
    for (const droit of DROITS) expect((await appeler(ancienne, ROUTES[droit])).status, droit).toBe(200);
    expect(reprendreAncienneCle()).toBe(0);                       // marqueur posé : rien de plus
    const id = db.prepare("SELECT id FROM connector_keys WHERE label = 'Clé d''origine'").get().id;
    await request(app).delete(`/api/connector/keys/${id}`).set('Authorization', `Bearer ${admin}`);
    expect(reprendreAncienneCle()).toBe(0);                       // révoquée : elle ne revient pas
    expect((await appeler(ancienne, ROUTES.export)).status).toBe(401);
  });

  it('les anciennes routes restent compatibles (clé à tous les droits, révocation de toutes)', async () => {
    const { key } = (await request(app).post('/api/connector/key').set('Authorization', `Bearer ${admin}`)).body;
    for (const droit of DROITS) expect((await appeler(key, ROUTES[droit])).status, droit).toBe(200);
    expect((await request(app).delete('/api/connector/key').set('Authorization', `Bearer ${admin}`)).status).toBe(200);
    expect((await appeler(key, ROUTES.export)).status).toBe(401);
  });
});
