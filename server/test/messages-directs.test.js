// Messages directs : exactement deux participants, l'expéditeur et le destinataire.
//
// Le client fabrique la clé du canal et l'enveloppe pour chaque membre ; le serveur
// ne fait que ranger ces enveloppes. Il doit donc refuser lui-même un troisième
// compte : sinon un « message direct » peut avoir un lecteur que l'autre personne
// ne voit pas, que ce soit à la création ou par un ajout de membre après coup.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { db } from '../src/db.js';
import { purgerIntrusMessagesDirects } from '../src/routes/chat.js';

const login = async (email) =>
  (await request(app).post('/api/auth/login').send({ email, password: 'comet1234' })).body.token;
const idOf = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
const membres = (channelId) => db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ? ORDER BY user_id')
  .all(channelId).map((r) => r.user_id);
const enveloppe = (tag) => Buffer.from(`enveloppe-${tag}`).toString('base64');

let lea, sophie;
beforeAll(async () => {
  lea = await login('lea@comet.mail');
  sophie = await login('sophie@comet.mail');
  expect(lea && sophie).toBeTruthy();
  // Partir d'un état propre : aucun message direct entre ces comptes.
  db.prepare('DELETE FROM channels WHERE is_dm = 1').run();
});

const creerDm = (token, email, members) =>
  request(app).post('/api/chat/dm').set('Authorization', `Bearer ${token}`).send({ email, name: 'DM', members });

describe('Création d’un message direct', () => {
  it('refuse un troisième membre glissé dans les enveloppes', async () => {
    const r = await creerDm(lea, 'marc@comet.mail', {
      'lea@comet.mail': enveloppe('lea'), 'marc@comet.mail': enveloppe('marc'), 'sophie@comet.mail': enveloppe('sophie'),
    });
    expect(r.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM channels WHERE is_dm = 1').get().n).toBe(0);
  });

  it('refuse des enveloppes qui ne visent pas la bonne paire', async () => {
    const r = await creerDm(lea, 'marc@comet.mail', { 'lea@comet.mail': enveloppe('lea'), 'sophie@comet.mail': enveloppe('sophie') });
    expect(r.status).toBe(400);
  });

  it('refuse une enveloppe manquante pour l’expéditeur', async () => {
    const r = await creerDm(lea, 'marc@comet.mail', { 'marc@comet.mail': enveloppe('marc'), 'sophie@comet.mail': enveloppe('sophie') });
    expect(r.status).toBe(400);
  });

  it('accepte la paire exacte, sans tenir compte de la casse des adresses', async () => {
    const r = await creerDm(lea, 'marc@comet.mail', { 'Lea@Comet.mail': enveloppe('lea'), 'marc@comet.mail': enveloppe('marc') });
    expect(r.status).toBe(201);
    expect(membres(r.body.channel.id)).toEqual([idOf('lea@comet.mail'), idOf('marc@comet.mail')].sort((a, b) => a - b));
  });
});

describe('Ajout de membres', () => {
  it('refuse d’ajouter quelqu’un à un message direct existant', async () => {
    const dm = db.prepare('SELECT id FROM channels WHERE is_dm = 1').get();
    const r = await request(app).post(`/api/chat/channels/${dm.id}/members`)
      .set('Authorization', `Bearer ${lea}`).send({ members: { 'sophie@comet.mail': enveloppe('sophie') } });
    expect(r.status).toBe(403);
    expect(membres(dm.id)).not.toContain(idOf('sophie@comet.mail'));
    const lecture = await request(app).get(`/api/chat/channels/${dm.id}/messages`).set('Authorization', `Bearer ${sophie}`);
    expect(lecture.status).toBe(403);
  });

  it('laisse toujours ajouter des membres à un canal ordinaire', async () => {
    const c = await request(app).post('/api/chat/channels').set('Authorization', `Bearer ${lea}`)
      .send({ name: 'Projet', members: { 'lea@comet.mail': enveloppe('lea') } });
    expect(c.status).toBe(201);
    const r = await request(app).post(`/api/chat/channels/${c.body.channel.id}/members`)
      .set('Authorization', `Bearer ${lea}`).send({ members: { 'sophie@comet.mail': enveloppe('sophie') } });
    expect(r.status).toBe(200);
    expect(r.body.added).toBe(1);
  });
});

describe('Messages directs déjà enregistrés', () => {
  it('retire un intrus ajouté avant la correction, sans toucher à la paire', () => {
    const dm = db.prepare('SELECT id FROM channels WHERE is_dm = 1').get();
    db.prepare('INSERT INTO channel_members (channel_id, user_id, enc_key) VALUES (?, ?, ?)').run(dm.id, idOf('sophie@comet.mail'), enveloppe('intrus'));
    expect(purgerIntrusMessagesDirects()).toBe(1);
    expect(membres(dm.id)).toEqual([idOf('lea@comet.mail'), idOf('marc@comet.mail')].sort((a, b) => a - b));
    expect(purgerIntrusMessagesDirects()).toBe(0);
  });
});
