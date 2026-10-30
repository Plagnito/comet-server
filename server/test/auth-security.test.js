import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { db } from '../src/db.js';
import { hashPassword, signToken } from '../src/auth.js';
import { JWT_SECRET } from '../src/config.js';
import authRoutes from '../src/routes/auth.js';
import { errorHandler } from '../src/util/errors.js';
import { deliverMessage } from '../src/services/mail.js';
import { attachWebSocket, notifyUser } from '../src/ws.js';
import { currentTotp } from './helpers/totp.js';

const PASSWORD = 'Comet-Identite-Solide-42!';
const NEW_PASSWORD = 'Nouvelle-Identite-Comet-73!';
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const RECOVERY = 'ABCDE-12345';
const replacement = { newPassword: NEW_PASSWORD, publicKey: 'new-public', encPrivateKey: 'new-wrapped', confirm: true };
let server; let wss; let alice; let bob;
const sockets = new Set();
const row = (who) => db.prepare('SELECT * FROM users WHERE id = ?').get(who.id);
function user() {
  const email = `security-${randomUUID()}@comet.mail`;
  const id = Number(db.prepare("INSERT INTO users (email, display_name, password_hash, public_key, enc_private_key) VALUES (?, 'Security fixture', ?, 'original-public', 'original-wrapped')").run(email, hashPassword(PASSWORD)).lastInsertRowid);
  const sid = db.prepare('INSERT INTO sessions (user_id) VALUES (?)').run(id).lastInsertRowid;
  const value = row({ id }); value.token = signToken(value, sid); return value;
}
function mfa(who) {
  db.prepare('UPDATE users SET totp_enabled = 1, totp_secret = ?, recovery_codes = ? WHERE id = ?')
    .run(SECRET, JSON.stringify([hashPassword(RECOVERY)]), who.id);
}
const post = (path, who = alice, body = {}) => request(server).post(`/api/auth/${path}`).set('Authorization', `Bearer ${who.token}`).send(body);
const me = (token) => request(server).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
const connect = (token) => new WebSocket(`ws://127.0.0.1:${server.address().port}/ws?token=${encodeURIComponent(token)}`);
function waitFor(ws, event, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.off(event, listener); reject(new Error(`timeout ${event}`)); }, 3000);
    const listener = (...args) => { if (predicate(...args)) { clearTimeout(timeout); ws.off(event, listener); resolve(args); } };
    ws.on(event, listener);
  });
}
async function live(token) {
  const ws = connect(token); sockets.add(ws);
  await waitFor(ws, 'message', (data) => JSON.parse(data).type === 'presence:init'); return ws;
}
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/api/auth', authRoutes); app.use(errorHandler);
  server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  wss = attachWebSocket(server);
});
beforeEach(() => { alice = user(); bob = user(); });
afterEach(async () => { for (const ws of sockets) ws.terminate(); sockets.clear(); await new Promise((resolve) => setTimeout(resolve, 10)); });
afterAll(async () => { await new Promise((resolve) => wss.close(resolve)); await new Promise((resolve) => server.close(resolve)); });

describe('MFA et réinitialisation — preuves fraîches', () => {
  it('borne les essais MFA par compte même avec de nouveaux jetons temporaires', async () => {
    mfa(alice); mfa(bob);
    for (let i = 0; i < 5; i++) {
      const login = await request(server).post('/api/auth/login').send({ email: alice.email, password: PASSWORD });
      const wrong = await request(server).post('/api/auth/2fa/verify').send({ tmpToken: login.body.tmpToken, code: 'not-a-code' });
      expect(wrong.status).toBe(401);
    }
    const login = await request(server).post('/api/auth/login').send({ email: alice.email, password: PASSWORD });
    const locked = await request(server).post('/api/auth/2fa/verify').send({ tmpToken: login.body.tmpToken, code: currentTotp(SECRET) });
    expect(locked.status).toBe(429); expect(locked.body.code).toBe('reauth_locked');
    const other = await request(server).post('/api/auth/login').send({ email: bob.email, password: PASSWORD });
    expect((await request(server).post('/api/auth/2fa/verify').send({ tmpToken: other.body.tmpToken, code: currentTotp(SECRET) })).status).toBe(200);
    expect(row(alice).totp_secret).toBe(SECRET);
  });
  it('refuse de réinitialiser la MFA avec un bearer seul', async () => {
    mfa(alice);
    expect((await post('2fa/setup')).status).toBe(403);
    expect(row(alice)).toMatchObject({ totp_enabled: 1, totp_secret: SECRET });
    expect((await me(alice.token)).status).toBe(200);
  });
  it('refuse un mauvais mot de passe ou le seul mot de passe quand MFA active', async () => {
    mfa(alice);
    expect((await post('2fa/setup', alice, { currentPassword: 'wrong', currentCode: currentTotp(SECRET) })).status).toBe(403);
    expect((await post('2fa/setup', alice, { currentPassword: PASSWORD })).status).toBe(403);
    expect(row(alice).totp_secret).toBe(SECRET);
  });
  it('garde le facteur actif pendant la préparation et exige la preuve du nouveau', async () => {
    mfa(alice);
    const setup = await post('2fa/setup', alice, { currentPassword: PASSWORD, currentCode: currentTotp(SECRET) });
    expect(setup.status).toBe(200); expect(setup.body.setupToken).toBeTruthy();
    expect(row(alice)).toMatchObject({ totp_enabled: 1, totp_secret: SECRET, pending_totp_secret: setup.body.secret });
    const login = await request(server).post('/api/auth/login').send({ email: alice.email, password: PASSWORD });
    expect((await request(server).post('/api/auth/2fa/verify').send({ tmpToken: login.body.tmpToken, code: currentTotp(SECRET) })).status).toBe(200);
    expect((await me(alice.token)).status).toBe(401);
    alice.token = setup.body.token;
    expect((await post('2fa/enable', alice, { code: currentTotp(setup.body.secret) })).status).toBe(403);
    expect((await post('2fa/enable', alice, { code: 'bad-code', setupToken: setup.body.setupToken })).status).toBe(403);
    const enabled = await post('2fa/enable', alice, { code: currentTotp(setup.body.secret), setupToken: setup.body.setupToken });
    expect(enabled.status).toBe(200); expect(enabled.body.recoveryCodes).toHaveLength(8);
    expect(row(alice)).toMatchObject({ totp_enabled: 1, totp_secret: setup.body.secret, pending_totp_secret: null });
    expect(row(alice).recovery_codes).not.toContain(enabled.body.recoveryCodes[0]);
    alice.token = enabled.body.token;
    expect((await post('2fa/enable', alice, { code: currentTotp(setup.body.secret), setupToken: setup.body.setupToken })).status).toBe(403);
  });
  it('expire une autorisation d’enrôlement et ne l’accepte pas comme session API/WS', async () => {
    const setup = await post('2fa/setup', alice, { currentPassword: PASSWORD }); expect(setup.status).toBe(200);
    expect((await me(setup.body.setupToken)).status).toBe(401);
    const ws = connect(setup.body.setupToken); sockets.add(ws); expect((await waitFor(ws, 'close'))[0]).toBe(4001);
    alice.token = setup.body.token;
    db.prepare('UPDATE users SET pending_totp_until = ? WHERE id = ?').run(Date.now() - 1, alice.id);
    expect((await post('2fa/enable', alice, { setupToken: setup.body.setupToken, code: currentTotp(setup.body.secret) })).status).toBe(403);
    expect(row(alice).totp_enabled).toBe(0);
  });
  it('ne désactive pas une MFA avec un seul facteur', async () => {
    mfa(alice);
    expect((await post('2fa/disable', alice, { currentPassword: PASSWORD })).status).toBe(403);
    expect((await post('2fa/disable', alice, { currentCode: currentTotp(SECRET) })).status).toBe(403);
    expect((await post('2fa/disable', alice, { currentPassword: PASSWORD, currentCode: currentTotp(SECRET) })).status).toBe(200);
    expect(row(alice)).toMatchObject({ totp_enabled: 0, totp_secret: null, recovery_codes: null });
  });
  it('laisse mot de passe, clé et boîtes intacts sur reset avec bearer seul', async () => {
    deliverMessage({ senderId: bob.id, to: [alice.id], subject: 'Fixture', body: 'Private fixture' });
    const before = db.prepare('SELECT password_hash, public_key, enc_private_key FROM users WHERE id = ?').get(alice.id);
    const count = () => db.prepare('SELECT COUNT(*) AS n FROM mail_items WHERE user_id = ?').get(alice.id).n;
    const originalCount = count(); expect(originalCount).toBeGreaterThan(0);
    expect((await post('reset-password', alice, replacement)).status).toBe(403);
    expect(db.prepare('SELECT password_hash, public_key, enc_private_key FROM users WHERE id = ?').get(alice.id)).toEqual(before);
    expect(count()).toBe(originalCount);
  });
  it('réinitialise avec preuve, préserve autrui et révoque aussi un JWT historique sans sid', async () => {
    deliverMessage({ senderId: bob.id, to: [alice.id], subject: 'Fixture', body: 'Private fixture' });
    const legacy = jwt.sign({ id: alice.id, email: alice.email }, JWT_SECRET, { expiresIn: '1h' });
    const result = await post('reset-password', alice, { ...replacement, currentPassword: PASSWORD });
    expect(result.status).toBe(200); expect(result.body.purged).toBeGreaterThan(0);
    expect((await me(alice.token)).status).toBe(401); expect((await me(legacy)).status).toBe(401);
    expect((await me(result.body.token)).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM mail_items WHERE user_id = ?').get(bob.id).n).toBeGreaterThan(0);
    expect(row(alice).public_key).toBe('new-public');
    expect((await request(server).post('/api/auth/login').send({ email: alice.email, password: NEW_PASSWORD })).status).toBe(200);
  });
  it('permet la récupération par facteur préexistant et consomme son code une fois', async () => {
    mfa(alice);
    expect((await post('reset-password', alice, { ...replacement, currentPassword: PASSWORD })).status).toBe(403);
    const result = await post('reset-password', alice, { ...replacement, currentCode: RECOVERY });
    expect(result.status).toBe(200); expect(row(alice).recovery_codes).toBe('[]');
    alice.token = result.body.token;
    expect((await post('2fa/setup', alice, { currentPassword: NEW_PASSWORD, currentCode: RECOVERY })).status).toBe(403);
    const login = await request(server).post('/api/auth/login').send({ email: alice.email, password: NEW_PASSWORD });
    expect((await request(server).post('/api/auth/2fa/verify').send({ tmpToken: login.body.tmpToken, code: RECOVERY })).status).toBe(401);
  });
  it('protège le premier provisionnement des clés et ne remplace jamais une clé existante', async () => {
    db.prepare('UPDATE users SET public_key = NULL, enc_private_key = NULL WHERE id = ?').run(alice.id);
    const keys = { publicKey: 'initial-public', encPrivateKey: 'initial-wrapped' };
    expect((await post('keys', alice, keys)).status).toBe(403);
    const initialized = await post('keys', alice, { ...keys, currentPassword: PASSWORD });
    expect(initialized.status).toBe(200); alice.token = initialized.body.token;
    expect((await post('keys', alice, { ...keys, publicKey: 'replacement', currentPassword: PASSWORD })).status).toBe(409);
    expect(row(alice).public_key).toBe('initial-public');
  });
  it('ne laisse pas set-password contourner la preuve et le re-scellement', async () => {
    expect((await post('set-password', alice, { newPassword: 'x'.repeat(201), encPrivateKey: 'rewrapped', currentPassword: PASSWORD })).status).toBe(400);
    expect((await post('set-password', alice, { newPassword: NEW_PASSWORD })).status).toBe(400);
    expect((await post('set-password', alice, { newPassword: NEW_PASSWORD, encPrivateKey: 'rewrapped' })).status).toBe(403);
    const changed = await post('set-password', alice, { newPassword: NEW_PASSWORD, encPrivateKey: 'rewrapped', currentPassword: PASSWORD });
    expect(changed.status).toBe(200); expect(row(alice).enc_private_key).toBe('rewrapped');
    expect((await me(alice.token)).status).toBe(401);
  });
  it('ne livre plus de données à un socket révoqué et préserve un autre compte', async () => {
    const old = await live(alice.token); const other = await live(bob.token);
    const seen = []; old.on('message', (data) => seen.push(JSON.parse(data)));
    const result = await post('reset-password', alice, { ...replacement, currentPassword: PASSWORD }); expect(result.status).toBe(200);
    const closed = waitFor(old, 'close'); notifyUser(alice.id, { type: 'mail:new', forbidden: true });
    expect((await closed)[0]).toBe(4001); expect(seen.some((value) => value.forbidden)).toBe(false);
    const control = waitFor(other, 'message', (data) => JSON.parse(data).type === 'control'); notifyUser(bob.id, { type: 'control' }); await control;
    await live(result.body.token);
  });
  it('refuse les jetons MFA pending sur API/WS et conserve les invités', async () => {
    mfa(alice);
    const login = await request(server).post('/api/auth/login').send({ email: alice.email, password: PASSWORD });
    expect((await me(login.body.tmpToken)).status).toBe(401);
    const denied = connect(login.body.tmpToken); sockets.add(denied); expect((await waitFor(denied, 'close'))[0]).toBe(4001);
    const guest = connect(jwt.sign({ guest: true, room: 'fixture-room', name: 'Fixture' }, JWT_SECRET, { expiresIn: '1m' })); sockets.add(guest);
    await waitFor(guest, 'open'); await new Promise((resolve) => setTimeout(resolve, 20)); expect(guest.readyState).toBe(WebSocket.OPEN);
  });
  it('révoque la session courante au logout', async () => {
    expect((await post('logout')).status).toBe(200); expect((await me(alice.token)).status).toBe(401);
    expect((await me(bob.token)).status).toBe(200);
  });
  it('termine un enrôlement autorisé par récupération sans réutiliser le code consommé', async () => {
    mfa(alice);
    const setup = await post('2fa/setup', alice, { currentPassword: PASSWORD, currentCode: RECOVERY });
    expect(setup.status).toBe(200); expect(row(alice).recovery_codes).toBe('[]'); alice.token = setup.body.token;
    const enabled = await post('2fa/enable', alice, { setupToken: setup.body.setupToken, code: currentTotp(setup.body.secret) });
    expect(enabled.status).toBe(200); expect(enabled.body.recoveryCodes).toHaveLength(8);
  });
  it('refuse aussi un message entrant sur une session WS révoquée', async () => {
    const old = await live(alice.token); const other = await live(bob.token); const received = [];
    other.on('message', (data) => received.push(JSON.parse(data)));
    expect((await post('reset-password', alice, { ...replacement, currentPassword: PASSWORD })).status).toBe(200);
    const closed = waitFor(old, 'close'); old.send(JSON.stringify({ type: 'rtc:signal', to: bob.id, data: 'forbidden' }));
    expect((await closed)[0]).toBe(4001); expect(received.some((message) => message.type === 'rtc:signal')).toBe(false);
  });
});
