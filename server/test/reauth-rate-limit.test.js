import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { db } from '../src/db.js';
import { signToken } from '../src/auth.js';

let server;
beforeAll(async () => { server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); }); });
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
describe('Limitation de la réauthentification', () => {
  it('bloque les essais de preuve sans modifier la MFA', async () => {
    const user = db.prepare("SELECT * FROM users WHERE email = 'lea@comet.mail'").get(); const token = signToken(user);
    for (let i = 0; i < 5; i++) {
      const response = await request(server).post('/api/auth/2fa/setup').set('Authorization', `Bearer ${token}`).send({ currentPassword: 'wrong' });
      expect(response.status).toBe(403);
    }
    const locked = await request(server).post('/api/auth/2fa/setup').set('Authorization', `Bearer ${token}`).send({ currentPassword: 'wrong' });
    expect(locked.status).toBe(429); expect(locked.body.code).toBe('reauth_locked'); expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect(db.prepare('SELECT pending_totp_secret FROM users WHERE id = ?').get(user.id).pending_totp_secret).toBeNull();
    const other = db.prepare("SELECT * FROM users WHERE email = 'marc@comet.mail'").get();
    expect((await request(server).post('/api/auth/2fa/setup').set('Authorization', `Bearer ${signToken(other)}`).send({ currentPassword: 'comet1234' })).status).toBe(200);
    // La connexion ordinaire reste disponible : seule la famille de preuves est bloquée.
    expect((await request(server).post('/api/auth/login').send({ email: user.email, password: 'comet1234' })).status).toBe(200);
    db.prepare("UPDATE auth_proof_attempts SET locked_until = ?, window_start = ? WHERE user_id = ? AND scope = 'change'")
      .run(Date.now() - 1, Date.now() - 901000, user.id);
    expect((await request(server).post('/api/auth/2fa/setup').set('Authorization', `Bearer ${token}`).send({ currentPassword: 'comet1234' })).status).toBe(200);
  });
});
