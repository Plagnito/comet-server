// Inscription libre (COMET_INSCRIPTION=ouverte) : le chemin par lequel un serveur
// auto-hébergé reçoit ses premiers comptes. Le réglage est lu à l'import de config.js,
// d'où l'import DYNAMIQUE de l'app après avoir posé la variable.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

let app;
beforeAll(async () => {
  process.env.COMET_INSCRIPTION = 'ouverte';
  ({ app } = await import('../src/server.js'));
});

describe('Inscription ouverte', () => {
  const email = `nouveau-${Date.now()}@comet.mail`;
  const password = 'Lune-Verte!42xQ-Orbite';

  it('annonce l’inscription à la page de connexion, sans session', async () => {
    const r = await request(app).get('/api/auth/options');
    expect(r.status).toBe(200);
    expect(r.body.inscription).toBe(true);
  });

  it('crée le compte et ouvre une session', async () => {
    const r = await request(app).post('/api/auth/register')
      .send({ email, displayName: 'Nouveau Venu', password, publicKey: 'cle-publique', encPrivateKey: '{"salt":"s","iv":"i","data":"d"}' });
    expect(r.status).toBe(201);
    expect(r.body.token).toBeTruthy();
    expect(r.body.user.email).toBe(email);
    expect(r.body.encPrivateKey).toBe('{"salt":"s","iv":"i","data":"d"}');
    // Serveur sans administrateur : le premier compte le devient.
    expect(r.body.user.isAdmin).toBe(true);
  });

  it('ne rend pas administrateurs les comptes suivants', async () => {
    const r = await request(app).post('/api/auth/register')
      .send({ email: `second-${Date.now()}@comet.mail`, displayName: 'Second Venu', password });
    expect(r.status).toBe(201);
    expect(r.body.user.isAdmin).toBe(false);
  });

  it('permet ensuite de se connecter avec ce mot de passe', async () => {
    const r = await request(app).post('/api/auth/login').send({ email, password });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
  });

  it('refuse une adresse déjà prise', async () => {
    const r = await request(app).post('/api/auth/register')
      .send({ email, displayName: 'Doublon', password });
    expect(r.status).toBe(409);
  });

  it('refuse un mot de passe faible', async () => {
    const r = await request(app).post('/api/auth/register')
      .send({ email: `faible-${Date.now()}@comet.mail`, displayName: 'Faible', password: 'azerty' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('weak_password');
  });
});
