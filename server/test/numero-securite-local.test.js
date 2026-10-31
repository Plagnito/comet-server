// Numéro de sécurité entre deux comptes du MÊME serveur (audit C-21) : le lecteur reçoit la
// clé de l'expéditeur et l'adresse principale de son compte, et les deux personnes
// calculent le même numéro — qui change si le serveur substitue une clé.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { app } from '../src/server.js';
import { db } from '../src/db.js';
import { hashPassword, signToken } from '../src/auth.js';
import * as cc from '../../client/src/crypto.js';

async function compte() {
  const kp = await cc.generateKeyPair();
  const pub = await cc.exportPublicKey(kp);
  const email = `num-${randomUUID().slice(0, 8)}@comet.mail`;
  const id = Number(db.prepare("INSERT INTO users (email, display_name, password_hash, public_key, enc_private_key) VALUES (?, 'Num', ?, ?, 'w')").run(email, hashPassword('Comet-Numero-Solide-42!'), pub).lastInsertRowid);
  const sid = db.prepare('INSERT INTO sessions (user_id) VALUES (?)').run(id).lastInsertRowid;
  return { id, email, pub, kp, token: signToken(db.prepare('SELECT * FROM users WHERE id = ?').get(id), sid) };
}
const auth = (u) => ({ Authorization: `Bearer ${u.token}` });

async function ecrire(de, a, extra = {}) {
  const enc = await cc.encryptMessage({ subject: 'S', body: 'B' }, { [de.email]: de.pub, [a.email]: a.pub });
  const r = await request(app).post('/api/mail').set(auth(de)).send({ encrypted: true, to: [a.email], cc: [], ciphertext: enc.ciphertext, iv: enc.iv, keys: enc.keys, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}
async function dernierRecu(u) {
  const l = await request(app).get('/api/mail?folder=inbox').set(auth(u));
  const item = l.body.items[0];
  return (await request(app).get(`/api/mail/${item.itemId}`).set(auth(u))).body.item;
}

describe('numéro de sécurité entre comptes du même serveur', () => {
  it('le lecteur reçoit la clé et l’adresse principale de l’expéditeur ; même numéro des deux côtés', async () => {
    const alice = await compte(); const bob = await compte();
    await ecrire(alice, bob);
    const m = await dernierRecu(bob);
    expect(m.from.cle).toEqual({ adresse: alice.email, publicKey: alice.pub });
    expect(m.from.federe).toBeUndefined();
    const vuParBob = await cc.numeroDeSecurite(bob.email, bob.pub, m.from.cle.adresse, m.from.cle.publicKey);
    const vuParAlice = await cc.numeroDeSecurite(alice.email, alice.pub, bob.email, bob.pub);
    expect(vuParBob).toBe(vuParAlice);
    expect(vuParBob.split(' ')).toHaveLength(12);
    // Une clé substituée par le serveur donne un autre numéro.
    const intrus = await cc.exportPublicKey(await cc.generateKeyPair());
    expect(await cc.numeroDeSecurite(bob.email, bob.pub, alice.email, intrus)).not.toBe(vuParAlice);
  });

  it('message envoyé depuis un alias : le numéro reste calculé sur l’adresse principale', async () => {
    const alice = await compte(); const bob = await compte();
    const alias = `alias-${randomUUID().slice(0, 6)}@comet.mail`;
    db.prepare('INSERT INTO aliases (owner_id, alias_email, active) VALUES (?, ?, 1)').run(alice.id, alias);
    await ecrire(alice, bob, { fromEmail: alias });
    const m = await dernierRecu(bob);
    expect(m.from.email).toBe(alias);                    // ce qui s'affiche
    expect(m.from.cle.adresse).toBe(alice.email);        // ce qui sert au numéro
  });
});
