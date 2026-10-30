// Réinitialisation DESTRUCTIVE du mot de passe Comet (E2EE) : régénère la clé de
// chiffrement (fournie par le client) + PURGE la boîte devenue illisible. On vérifie
// la garde de confirmation, la politique de mot de passe, la purge des vues de
// l'utilisateur, la préservation des mails des AUTRES, et la bascule du mot de passe.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { db } from '../src/db.js';
import { deliverMessage } from '../src/services/mail.js';

// Clés E2EE factices (le serveur ne stocke que des blobs opaques ; il ne valide que
// leur présence — la structure crypto est vérifiée côté client).
const FAKE_PUB = 'ZmFrZS1wdWJsaWMta2V5';
const FAKE_ENC = JSON.stringify({ salt: 'c2FsdA==', iv: 'aXY=', data: 'ZGF0YQ==' });
const NEW_PW = 'Comet-Nebuleuse-42-Xyz!';

let token, sophieId, marcId;

beforeAll(async () => {
  token = (await request(app).post('/api/auth/login').send({ email: 'sophie@comet.mail', password: 'comet1234' })).body.token;
  expect(token).toBeTruthy();
  sophieId = db.prepare('SELECT id FROM users WHERE email = ?').get('sophie@comet.mail').id;
  marcId = db.prepare('SELECT id FROM users WHERE email = ?').get('marc@comet.mail').id;
  // Un mail arrive à sophie (elle a donc une boîte non vide à purger) ; marc en garde
  // sa copie « Envoyés » (mail d'un AUTRE utilisateur → ne doit PAS être purgé).
  deliverMessage({ senderId: marcId, to: [sophieId], subject: 'Bonjour', body: 'Coucou' });
});

describe('POST /auth/reset-password', () => {
  it('exige une confirmation explicite (confirm !== true → 400)', async () => {
    const r = await request(app).post('/api/auth/reset-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ newPassword: NEW_PW, publicKey: FAKE_PUB, encPrivateKey: FAKE_ENC });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('confirm_required');
  });

  it('refuse un mot de passe faible (zxcvbn → 400)', async () => {
    const r = await request(app).post('/api/auth/reset-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ newPassword: 'motdepasse', publicKey: FAKE_PUB, encPrivateKey: FAKE_ENC, confirm: true });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('weak_password');
  });

  it('refuse sans jeton (401)', async () => {
    const r = await request(app).post('/api/auth/reset-password')
      .send({ newPassword: NEW_PW, publicKey: FAKE_PUB, encPrivateKey: FAKE_ENC, confirm: true });
    expect(r.status).toBe(401);
  });

  it('réinitialise : purge la boîte, régénère la clé, bascule le mot de passe', async () => {
    const before = db.prepare('SELECT COUNT(*) c FROM mail_items WHERE user_id = ?').get(sophieId).c;
    expect(before).toBeGreaterThan(0);

    const r = await request(app).post('/api/auth/reset-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ newPassword: NEW_PW, publicKey: FAKE_PUB, encPrivateKey: FAKE_ENC, confirm: true });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.purged).toBeGreaterThan(0);

    // Boîte de sophie vidée ; nouvelle clé publique posée.
    expect(db.prepare('SELECT COUNT(*) c FROM mail_items WHERE user_id = ?').get(sophieId).c).toBe(0);
    expect(db.prepare('SELECT public_key FROM users WHERE id = ?').get(sophieId).public_key).toBe(FAKE_PUB);

    // Le mail de marc (autre utilisateur) survit : sa copie « Envoyés » reste.
    expect(db.prepare('SELECT COUNT(*) c FROM mail_items WHERE user_id = ?').get(marcId).c).toBeGreaterThan(0);
  });

  it("l'ancien mot de passe ne marche plus ; le nouveau oui", async () => {
    const old = await request(app).post('/api/auth/login').send({ email: 'sophie@comet.mail', password: 'comet1234' });
    expect(old.status).toBe(401);
    const neo = await request(app).post('/api/auth/login').send({ email: 'sophie@comet.mail', password: NEW_PW });
    expect(neo.status).toBe(200);
    expect(neo.body.token).toBeTruthy();
  });
});
