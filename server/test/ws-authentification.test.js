// Audit C-18 : le jeton de session ne passe plus dans l'adresse du WebSocket (il finirait
// dans les journaux du tunnel ou du proxy) ; il part dans le premier message.
import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { app } from '../src/server.js';
import { db } from '../src/db.js';
import { hashPassword, signToken } from '../src/auth.js';
import { attachWebSocket } from '../src/ws.js';
import { createRoom, issueGuestToken } from '../src/services/confrooms.js';

let server; let wss;
const sockets = new Set();
function compte() {
  const email = `wsauth-${randomUUID().slice(0, 8)}@comet.mail`;
  const id = Number(db.prepare("INSERT INTO users (email, display_name, password_hash) VALUES (?, 'WS', ?)").run(email, hashPassword('Comet-Ws-Solide-42!')).lastInsertRowid);
  const sid = db.prepare('INSERT INTO sessions (user_id) VALUES (?)').run(id).lastInsertRowid;
  return { id, token: signToken(db.prepare('SELECT * FROM users WHERE id = ?').get(id), sid) };
}
const ouvrir = (suffixe = '') => { const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws${suffixe}`); sockets.add(ws); return ws; };
const ouvert = (ws) => new Promise((r) => ws.once('open', r));
const fermeture = (ws) => new Promise((r) => ws.once('close', (code, raison) => r({ code, raison: String(raison) })));
const premier = (ws) => new Promise((r) => ws.once('message', (d) => r(JSON.parse(d))));

beforeAll(async () => {
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  wss = attachWebSocket(server);
});
afterEach(() => { for (const ws of sockets) ws.terminate(); sockets.clear(); vi.useRealTimers(); });
afterAll(async () => { await new Promise((r) => wss.close(r)); await new Promise((r) => server.close(r)); });

describe('authentification du WebSocket par message (C-18)', () => {
  it('jeton dans le premier message : la session s’ouvre', async () => {
    const u = compte(); const ws = ouvrir();
    await ouvert(ws);
    ws.send(JSON.stringify({ type: 'auth', token: u.token }));
    expect((await premier(ws)).type).toBe('presence:init');
  });

  it('jeton dans l’adresse : refusé avec 4400 (et non 4001, qui ferait effacer la session)', async () => {
    const u = compte(); const ws = ouvrir(`?token=${encodeURIComponent(u.token)}`);
    expect(await fermeture(ws)).toEqual({ code: 4400, raison: 'auth-par-message' });
  });

  it('premier message qui n’est pas l’authentification, ou jeton faux : 4001', async () => {
    const u = compte();
    const a = ouvrir(); await ouvert(a);
    a.send(JSON.stringify({ type: 'conf:join', room: 'x', token: u.token }));
    expect((await fermeture(a)).code).toBe(4001);
    const b = ouvrir(); await ouvert(b);
    b.send(JSON.stringify({ type: 'auth', token: `${u.token}x` }));
    expect((await fermeture(b)).code).toBe(4001);
    const c = ouvrir(); await ouvert(c);
    c.send('pas du JSON');
    expect((await fermeture(c)).code).toBe(4001);
  });

  it('rien d’envoyé : fermé au bout du délai', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ws = ouvrir(); await ouvert(ws);
    const f = fermeture(ws);
    vi.advanceTimersByTime(10_001);
    vi.useRealTimers();
    expect((await f).code).toBe(4001);
  });

  it('un invité s’authentifie de la même façon puis rejoint son salon', async () => {
    const hote = compte();
    const room = createRoom({ hostId: hote.id, hostName: 'Hôte', name: 'R', hostOrgId: null });
    const ws = ouvrir(); await ouvert(ws);
    ws.send(JSON.stringify({ type: 'auth', token: issueGuestToken(room, 'Invité') }));
    ws.send(JSON.stringify({ type: 'conf:join', name: 'Invité' }));
    expect((await premier(ws)).type).toBe('conf:peers');
  });
});
