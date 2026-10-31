// Audit C-25 : /api/rtc-config donne le STUN de l'instance à tous, mais les identifiants
// du relais TURN seulement aux sessions valides (compte connecté, invité d'un salon ouvert).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { app } from '../src/server.js';
import { db } from '../src/db.js';
import { hashPassword, signToken } from '../src/auth.js';
import { JWT_SECRET } from '../src/config.js';
import { createRoom, issueGuestToken } from '../src/services/confrooms.js';
import { configurationIce } from '../src/services/ice.js';

const AVANT = { ...process.env };
beforeAll(() => Object.assign(process.env, {
  COMET_STUN: 'stun:stun.exemple.org:3478, stun:autre.exemple.org', COMET_TURN: 'turn:turn.exemple.org:3478',
  COMET_TURN_USER: 'relais', COMET_TURN_PASS: 'secret-du-relais',
}));
afterAll(() => { for (const k of ['COMET_STUN', 'COMET_TURN', 'COMET_TURN_USER', 'COMET_TURN_PASS']) { if (k in AVANT) process.env[k] = AVANT[k]; else delete process.env[k]; } });

function compte() {
  const email = `rtc-${randomUUID().slice(0, 8)}@comet.mail`;
  const id = Number(db.prepare("INSERT INTO users (email, display_name, password_hash) VALUES (?, 'R', ?)").run(email, hashPassword('Comet-Rtc-Solide-42!')).lastInsertRowid);
  const sid = db.prepare('INSERT INTO sessions (user_id) VALUES (?)').run(id).lastInsertRowid;
  return { id, token: signToken(db.prepare('SELECT * FROM users WHERE id = ?').get(id), sid) };
}
const demander = (jeton) => { const r = request(app).get('/api/rtc-config'); return jeton ? r.set('Authorization', `Bearer ${jeton}`) : r; };
const aTurn = (body) => body.iceServers.some((s) => String(s.urls).startsWith('turn'));

describe('/api/rtc-config', () => {
  it('anonyme : les STUN de l’instance, pas le relais TURN', async () => {
    const r = await demander();
    expect(r.status).toBe(200);
    expect(r.body.iceServers).toEqual([{ urls: 'stun:stun.exemple.org:3478' }, { urls: 'stun:autre.exemple.org' }]);
    expect(JSON.stringify(r.body)).not.toContain('secret-du-relais');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('compte connecté : le relais TURN avec ses identifiants', async () => {
    const r = await demander(compte().token);
    expect(r.body.iceServers).toContainEqual({ urls: 'turn:turn.exemple.org:3478', username: 'relais', credential: 'secret-du-relais' });
  });

  it('invité d’un salon ouvert : le relais ; salon disparu ou jeton faux : non', async () => {
    const hote = compte();
    const room = createRoom({ hostId: hote.id, hostName: 'H', name: 'R', hostOrgId: null });
    expect(aTurn((await demander(issueGuestToken(room, 'Invité'))).body)).toBe(true);
    const fantome = jwt.sign({ guest: true, room: 'salon-inexistant', name: 'X' }, JWT_SECRET, { expiresIn: '1h' });
    expect(aTurn((await demander(fantome)).body)).toBe(false);
    const forge = jwt.sign({ guest: true, room: room.id, name: 'X' }, 'mauvais-secret-0123456789abcdef', { expiresIn: '1h' });
    expect(aTurn((await demander(forge)).body)).toBe(false);
    const expire = jwt.sign({ guest: true, room: room.id, name: 'X', exp: Math.floor(Date.now() / 1000) - 10 }, JWT_SECRET);
    expect(aTurn((await demander(expire)).body)).toBe(false);
  });

  it('sans réglage : liste vide, aucun serveur tiers', () => {
    expect(configurationIce({ turn: true, env: {} })).toEqual({ iceServers: [] });
    expect(configurationIce({ turn: true, env: { COMET_STUN: 'http://x', COMET_TURN: 'stun:pas-un-turn' } })).toEqual({ iceServers: [] });
  });
});
