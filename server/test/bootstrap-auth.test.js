import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { db } from '../src/db.js';

const code = 'test-bootstrap-local-0123456789abcdef';
const password = 'Lune-Verte!42xQ-Orbite';
let app; let server;
const emails = [];
const register = (token) => {
  const email = `bootstrap-${randomUUID()}@comet.mail`; emails.push(email);
  return request(server).post('/api/auth/register').send({ email, displayName: 'Installation locale', password, bootstrapToken: token });
};
beforeAll(async () => {
  process.env.COMET_BOOTSTRAP_TOKEN = code;
  ({ app } = await import('../src/server.js'));
  server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
});
beforeEach(() => {
  db.prepare("DELETE FROM settings WHERE k = 'bootstrap_complete'").run();
  db.prepare('UPDATE users SET is_admin = 0').run();
  app.set('trust proxy', false);
});
afterEach(() => {
  // La base entière est jetable. Le mail de bienvenue référence ces comptes :
  // conserver les lignes jusqu'à la fin de la fixture plutôt que casser ses FK.
  emails.length = 0;
  app.set('trust proxy', false);
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

describe('Installation administrateur', () => {
  it('refuse le premier administrateur sans code local', async () => {
    expect((await register()).status).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get().n).toBe(0);
  });
  it('refuse un code erroné sans créer de compte', async () => {
    expect((await register('incorrect')).status).toBe(403);
    expect(db.prepare('SELECT 1 FROM users WHERE email = ?').get(emails[0])).toBeUndefined();
  });
  it('autorise le setup puis garde les inscriptions suivantes ordinaires', async () => {
    expect((await request(server).get('/api/auth/options')).body.bootstrapRequired).toBe(true);
    const first = await register(code); expect(first.status).toBe(201); expect(first.body.user.isAdmin).toBe(true);
    expect((await request(server).get('/api/auth/options')).body.bootstrapRequired).toBe(false);
    const next = await register(); expect(next.status).toBe(201); expect(next.body.user.isAdmin).toBe(false);
    expect((await register(code)).body.user.isAdmin).toBe(false);
  });
  it('ne crée qu’un premier admin pour des inscriptions concurrentes', async () => {
    const results = await Promise.all([register(code), register(code), register(code)]);
    expect(results.every((result) => result.status === 201)).toBe(true);
    expect(results.filter((result) => result.body.user.isAdmin)).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get().n).toBe(1);
  });
  it('ne rouvre pas le bootstrap après disparition du dernier admin', async () => {
    expect((await register(code)).body.user.isAdmin).toBe(true);
    db.prepare('UPDATE users SET is_admin = 0').run();
    const next = await register(code); expect(next.status).toBe(201); expect(next.body.user.isAdmin).toBe(false);
    expect((await request(server).get('/api/auth/options')).body.bootstrapRequired).toBe(false);
  });
  it('ne révèle pas le code dans les options publiques', async () => {
    const response = await request(server).get('/api/auth/options');
    expect(response.text).not.toContain(code);
    expect(response.body.bootstrapToken).toBeUndefined();
  });
});

describe('Frontière de confiance proxy', () => {
  const login = () => request(server).post('/api/auth/login').set('X-Forwarded-For', '198.51.100.8')
    .send({ email: 'lea@comet.mail', password: 'comet1234' });
  const sessionIp = (response) => {
    const payload = JSON.parse(Buffer.from(response.body.token.split('.')[1], 'base64url'));
    return db.prepare('SELECT ip FROM sessions WHERE id = ?').get(payload.sid).ip;
  };
  it('ignore IP et Host relayés depuis un pair non approuvé', async () => {
    app.set('trust proxy', ['10.0.0.2/32']);
    const response = await login(); expect(response.status).toBe(200); expect(sessionIp(response)).toBe('127.0.0.1');
    const cors = await request(server).get('/api/health').set('Host', 'backend.test')
      .set('X-Forwarded-Host', 'public.test').set('Origin', 'https://public.test');
    expect(cors.status).toBe(403);
  });
  it('accepte les informations du proxy loopback explicitement approuvé', async () => {
    app.set('trust proxy', ['loopback']);
    const response = await login(); expect(response.status).toBe(200); expect(sessionIp(response)).toBe('198.51.100.8');
    const cors = await request(server).get('/api/health').set('Host', 'backend.test')
      .set('X-Forwarded-Host', 'public.test').set('Origin', 'https://public.test');
    expect(cors.status).toBe(200);
  });
});
