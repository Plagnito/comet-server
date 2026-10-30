import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../src/db.js';
import { signToken } from '../src/auth.js';

const dataDir = mkdtempSync(join(tmpdir(), 'comet-attachment-security-'));
const blobDir = join(dataDir, 'attachments');
const legacyDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'attachments');
mkdirSync(blobDir);
const legacyId = `legacy-${randomUUID()}`;
writeFileSync(join(blobDir, `${legacyId}.bin`), Buffer.alloc(16));
const uploadEnv = {
  COMET_ATTACHMENTS_DIR: blobDir, COMET_UPLOAD_MAX_BYTES: '64',
  COMET_UPLOAD_USER_QUOTA_BYTES: '96', COMET_UPLOAD_TOTAL_QUOTA_BYTES: '160',
  COMET_UPLOAD_TIMEOUT_MS: '1000', COMET_UPLOAD_MAX_ACTIVE_PER_USER: '1',
  COMET_UPLOAD_MAX_ACTIVE_TOTAL: '2', COMET_UPLOAD_MIN_FREE_BYTES: '0',
};
const previousEnv = Object.fromEntries(Object.keys(uploadEnv).map((key) => [key, process.env[key]]));
Object.assign(process.env, uploadEnv);
let server; let alice; let bob;
const ids = new Set([legacyId]);
const users = [];
const pending = new Set();
const id = () => { const value = randomUUID(); ids.add(value); return value; };
const hasLedger = () => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='attachment_storage'").get();
const ledger = (value) => hasLedger() ? db.prepare('SELECT * FROM attachment_storage WHERE transfer_id = ?').get(value) : undefined;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(10); }
  throw new Error('État du transfert non atteint');
}
function user() {
  const email = `upload-${randomUUID()}@comet.mail`;
  const userId = Number(db.prepare("INSERT INTO users (email, display_name, password_hash) VALUES (?, 'Upload test', 'unused')").run(email).lastInsertRowid);
  const value = { id: userId, email }; value.token = signToken(value); users.push(value); return value;
}
function upload(value, who = alice, data = Buffer.from('original'), route = '/large') {
  const req = request(server).post(`/api/attachments${route}`).set('Authorization', `Bearer ${who.token}`)
    .set('Content-Type', 'application/octet-stream').set('X-Transfer-Id', value).set('X-Size', '1');
  if (route === '') req.set('X-IV', 'test-iv').set('X-To', bob.email);
  return req.send(data);
}
function stream(value, who = alice, route = '/large') {
  let req;
  const response = new Promise((resolve, reject) => {
    req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: `/api/attachments${route}`, method: 'POST',
      headers: { authorization: `Bearer ${who.token}`, 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked',
        'x-transfer-id': value, 'x-size': '1', 'x-iv': 'test-iv', 'x-to': bob.email } }, (res) => {
      res.resume(); res.on('end', () => { resolve(res.statusCode); req.destroy(); });
    });
    req.on('error', reject); req.setTimeout(3000, () => req.destroy(new Error('timeout client')));
  });
  // Les tests d'abandon n'attendent pas la réponse, mais conservent son rejet.
  response.catch(() => {});
  pending.add(req); req.once('close', () => pending.delete(req));
  return { req, response };
}

beforeAll(async () => {
  const { default: router } = await import('../src/routes/attachments.js');
  const app = express(); app.use(express.json()); app.use('/api/attachments', router);
  server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
});
beforeEach(() => { alice = user(); bob = user(); });
afterEach(async () => {
  for (const req of pending) req.destroy();
  await delay(30);
  for (const value of ids) {
    db.prepare('DELETE FROM attachments WHERE transfer_id = ?').run(value);
    db.prepare('DELETE FROM large_transfers WHERE transfer_id = ?').run(value);
    if (hasLedger()) db.prepare('DELETE FROM attachment_storage WHERE transfer_id = ?').run(value);
    for (const root of [blobDir, legacyDir]) {
      for (const suffix of ['.bin', '.bin.part', '.torrent']) {
        try { unlinkSync(join(root, value + suffix)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }
  ids.clear();
  for (const who of users) db.prepare('DELETE FROM users WHERE id = ?').run(who.id);
  users.length = 0;
});
afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe('Pièces jointes — admission, intégrité et ressources', () => {
  it('comptabilise un blob historique sans inventer son propriétaire', () => {
    expect(ledger(legacyId)).toMatchObject({ sender_id: null, size: 16, complete: 1 });
  });
  it('préserve le repli chiffré, le contrôle destinataire et la consommation unique', async () => {
    const value = id(); expect((await upload(value, alice, Buffer.from('ciphertext'), '')).status).toBe(201);
    expect((await request(server).get(`/api/attachments/${value}`).set('Authorization', `Bearer ${alice.token}`)).status).toBe(404);
    const read = await request(server).get(`/api/attachments/${value}`).set('Authorization', `Bearer ${bob.token}`);
    expect(read.status).toBe(200); expect(read.body.toString()).toBe('ciphertext'); expect(read.headers['x-iv']).toBe('test-iv');
    expect(ledger(value)).toMatchObject({ size: 0, complete: 1 });
    expect((await request(server).get(`/api/attachments/${value}`).set('Authorization', `Bearer ${bob.token}`)).status).toBe(404);
    expect((await upload(value, bob)).status).toBe(409);
  });
  it('préserve le webseed Range et les métadonnées torrent publiques', async () => {
    const value = id(); expect((await upload(value)).status).toBe(201);
    const read = await request(server).get(`/api/attachments/${value}/webseed`).set('Range', 'bytes=1-3');
    expect(read.status).toBe(206); expect(read.body.toString()).toBe('rig');
    expect((await request(server).get(`/api/attachments/${value}.torrent`)).status).toBe(200);
    expect(db.prepare('SELECT downloads FROM large_transfers WHERE transfer_id = ?').get(value).downloads).toBe(0);
    const config = await request(server).post('/api/attachments/config').set('Authorization', `Bearer ${alice.token}`).send({ transferId: value, maxDownloads: 2 });
    expect(config.body.downloadLimitScope).toBe('full-responses-only');
    expect((await request(server).get(`/api/attachments/${value}/webseed`)).status).toBe(200);
    expect((await request(server).get(`/api/attachments/${value}/webseed`)).status).toBe(200);
    expect((await request(server).get(`/api/attachments/${value}/webseed`)).status).toBe(404);
    expect(ledger(value)).toMatchObject({ size: 0, complete: 1 });
  });
  it('refuse un transfert expiré avant le passage du nettoyage périodique', async () => {
    const value = id(); expect((await upload(value)).status).toBe(201);
    db.prepare("UPDATE large_transfers SET expires_at = '2000-01-01 00:00:00' WHERE transfer_id = ?").run(value);
    expect((await request(server).get(`/api/attachments/${value}/webseed`)).status).toBe(404);
    expect((await request(server).get(`/api/attachments/${value}.torrent`)).status).toBe(404);
    expect((await request(server).get(`/api/attachments/${value}`).set('Authorization', `Bearer ${alice.token}`)).status).toBe(404);
  });
  it('refuse une collision entre deux comptes et conserve le blob initial', async () => {
    const value = id(); expect((await upload(value)).status).toBe(201);
    expect((await upload(value, bob, Buffer.from('replacement'))).status).toBe(409);
    const read = await request(server).get(`/api/attachments/${value}/webseed`);
    expect(read.body.toString()).toBe('original');
    expect((await upload(id(), bob, Buffer.from('replacement'))).status).toBe(201);
  });
  it.each([['', '/large'], ['/large', ''], ['', '']])('refuse une collision de namespace %s vers %s', async (first, second) => {
    const value = id(); expect((await upload(value, alice, Buffer.from('original'), first)).status).toBe(201);
    expect((await upload(value, bob, Buffer.from('replacement'), second)).status).toBe(409);
  });
  it.each(['left.right', 'left%2fright', 'a'.repeat(129)])('refuse un identifiant non canonique %s', async (value) => {
    // Nettoyage du seul nom que l'ancienne version aurait produit, pour le test rouge.
    ids.add(value.replace(/[^a-zA-Z0-9_-]/g, ''));
    expect((await upload(value)).status).toBe(400);
  });
  it('refuse les alias encodés sur GET et les IDs non textuels sur config', async () => {
    expect((await request(server).get('/api/attachments/left%2Fright/webseed')).status).toBe(400);
    expect((await request(server).post('/api/attachments/config').set('Authorization', `Bearer ${alice.token}`).send({ transferId: {} })).status).toBe(400);
  });
  it('refuse un corps déjà consommé par un analyseur JSON sans réserver de disque', async () => {
    const value = id();
    const response = await request(server).post('/api/attachments/large').set('Authorization', `Bearer ${alice.token}`)
      .set('X-Transfer-Id', value).send({ data: 'not a binary stream' });
    expect(response.status).toBe(400); expect(ledger(value)).toBeUndefined();
  });
  it.each(['/large', ''])('borne le corps réel sur %s malgré X-Size mensonger', async (route) => {
    expect((await upload(id(), alice, Buffer.alloc(65), route)).status).toBe(413);
  });
  it.each(['/large', ''])('borne le flux chunked sans Content-Length sur %s', async (route) => {
    const value = id(); const transfer = stream(value, alice, route);
    transfer.req.write(Buffer.alloc(40)); transfer.req.end(Buffer.alloc(40));
    expect(await transfer.response).toBe(413); expect(ledger(value)).toBeUndefined();
    expect(readdirSync(blobDir).some((name) => name.startsWith(value))).toBe(false);
  });
  it('applique un quota par compte commun aux deux routes', async () => {
    expect((await upload(id(), alice, Buffer.alloc(64))).status).toBe(201);
    expect((await upload(id(), alice, Buffer.alloc(33), '')).status).toBe(413);
    expect((await upload(id(), alice, Buffer.alloc(32), '')).status).toBe(201);
    expect((await upload(id(), alice, Buffer.alloc(1))).status).toBe(413);
    expect((await upload(id(), bob, Buffer.alloc(1))).status).toBe(201);
  });
  it('applique le quota total entre comptes et routes', async () => {
    expect((await upload(id(), alice, Buffer.alloc(64))).status).toBe(201);
    expect((await upload(id(), bob, Buffer.alloc(64))).status).toBe(201);
    const charlie = user();
    expect((await upload(id(), charlie, Buffer.alloc(33), '')).status).toBe(413);
    expect((await upload(id(), charlie, Buffer.alloc(32), '')).status).toBe(201);
    expect((await upload(id(), charlie, Buffer.alloc(1))).status).toBe(413);
  });
  it('réserve les octets et limite les uploads simultanés, y compris E2EE', async () => {
    const a = id(); const first = stream(a); first.req.write('a'); await until(() => ledger(a));
    expect((await upload(id(), alice, Buffer.from('b'), '')).status).toBe(429);
    expect((await upload(a, bob)).status).toBe(409);
    const b = id(); const second = stream(b, bob, ''); second.req.write('b'); await until(() => ledger(b));
    expect((await upload(id(), user())).status).toBe(429);
    first.req.destroy(); second.req.destroy();
    await until(() => !ledger(a) && !ledger(b));
    expect(readdirSync(blobDir).filter((name) => name.endsWith('.part'))).toEqual([]);
    expect((await upload(id())).status).toBe(201);
  });
  it.each(['/large', ''])('arrête et nettoie un transfert trop lent sur %s', async (route) => {
    const value = id(); const transfer = stream(value, alice, route); transfer.req.write('x');
    expect(await transfer.response).toBe(408); expect(ledger(value)).toBeUndefined();
    expect(readdirSync(blobDir).some((name) => name.startsWith(value))).toBe(false);
  });
});
