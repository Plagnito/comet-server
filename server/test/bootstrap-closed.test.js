import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';

const previousRegistration = process.env.COMET_INSCRIPTION;
const previousAdmin = process.env.COMET_ADMIN_EMAIL;
afterAll(() => {
  if (previousRegistration === undefined) delete process.env.COMET_INSCRIPTION; else process.env.COMET_INSCRIPTION = previousRegistration;
  if (previousAdmin === undefined) delete process.env.COMET_ADMIN_EMAIL; else process.env.COMET_ADMIN_EMAIL = previousAdmin;
});
describe('Installation avec inscriptions fermées', () => {
  it('protège le setup puis ferme réellement les inscriptions sans promotion par email', async () => {
    process.env.COMET_INSCRIPTION = 'fermee';
    process.env.COMET_ADMIN_EMAIL = 'lea@comet.mail';
    const { db } = await import('../src/db.js');
    const { app } = await import('../src/server.js');
    expect(db.prepare("SELECT is_admin FROM users WHERE email = 'lea@comet.mail'").get().is_admin).toBe(0);
    const body = { email: 'closed-setup@comet.mail', displayName: 'Installation', password: 'Lune-Verte!42xQ-Orbite' };
    expect((await request(app).post('/api/auth/register').send(body)).status).toBe(403);
    const setup = await request(app).post('/api/auth/register').send({ ...body, bootstrapToken: process.env.COMET_BOOTSTRAP_TOKEN });
    expect(setup.status).toBe(201); expect(setup.body.user.isAdmin).toBe(true);
    expect((await request(app).get('/api/auth/options')).body.inscription).toBe(false);
    expect((await request(app).post('/api/auth/register').send({ ...body, email: 'closed-next@comet.mail' })).status).toBe(403);
  }, 30_000); // charge tout le serveur dans le test : un runner chargé dépasse les 5 s par défaut
});
