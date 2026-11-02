// Lot F de l'audit : qui voit la présence et les disponibilités de qui, qui entre dans un
// salon de visio, qui relaie de la signalisation. Vrai serveur HTTP + WebSocket ; chaque
// règle est vérifiée dans les deux sens (autorisé / refusé).
import { beforeAll, afterAll, afterEach, describe, it, expect } from 'vitest';
import request from 'supertest';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { app } from '../src/server.js';
import { db } from '../src/db.js';
import { hashPassword, signToken } from '../src/auth.js';
import { attachWebSocket, TAILLE_MAX_MESSAGE, MESSAGES_MAX } from '../src/ws.js';
import { createRoom, setConfig, issueGuestToken } from '../src/services/confrooms.js';
import { voit, ontEchange } from '../src/services/visibilite.js';

let server; let wss;
const sockets = new Set();
let orgSuivante = 900000;

function compte({ org = null } = {}) {
  const email = `equipe-${randomUUID().slice(0, 8)}@comet.mail`;
  const id = Number(db.prepare("INSERT INTO users (email, display_name, password_hash, public_key, enc_private_key, org_id) VALUES (?, 'Équipe', ?, 'pk', 'wrapped', ?)")
    .run(email, hashPassword('Comet-Equipe-Solide-42!'), org).lastInsertRowid);
  const sid = db.prepare('INSERT INTO sessions (user_id) VALUES (?)').run(id).lastInsertRowid;
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return { id, email, token: signToken(row, sid) };
}
const nouvelleOrg = () => ++orgSuivante;
function canal(createur, membres) {
  const c = Number(db.prepare("INSERT INTO channels (name, created_by) VALUES ('Projet', ?)").run(createur.id).lastInsertRowid);
  for (const m of [createur, ...membres]) db.prepare("INSERT INTO channel_members (channel_id, user_id, enc_key) VALUES (?, ?, 'k')").run(c, m.id);
  return c;
}
const ecrire = (c, qui) => db.prepare("INSERT INTO chat_messages (channel_id, sender_id, ciphertext, iv) VALUES (?, ?, 'x', 'y')").run(c, qui.id);
function courrier(de, a) {
  const m = Number(db.prepare("INSERT INTO messages (thread_id, sender_id) VALUES (?, ?)").run(randomUUID(), de.id).lastInsertRowid);
  db.prepare("INSERT INTO recipients (message_id, user_id) VALUES (?, ?)").run(m, a.id);
}

function ouvrir(token) {
  // Comme le client : connexion sans jeton dans l'adresse, jeton dans le premier message.
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`); sockets.add(ws);
  ws.once('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
  ws.recus = [];
  ws.on('message', (d) => { try { ws.recus.push(JSON.parse(d)); } catch { /* */ } });
  return ws;
}
function attendre(ws, predicat, ms = 3000) {
  return new Promise((resolve, reject) => {
    const deja = ws.recus.find(predicat); if (deja) return resolve(deja);
    const t = setTimeout(() => { ws.off('message', ecoute); reject(new Error('rien reçu')); }, ms);
    const ecoute = (d) => { let m; try { m = JSON.parse(d); } catch { return; } if (predicat(m)) { clearTimeout(t); ws.off('message', ecoute); resolve(m); } };
    ws.on('message', ecoute);
  });
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function connecte(qui) { const ws = ouvrir(qui.token); const init = await attendre(ws, (m) => m.type === 'presence:init'); return { ws, init }; }
const envoyer = (ws, obj) => ws.send(JSON.stringify(obj));

beforeAll(async () => {
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  wss = attachWebSocket(server);
});
afterEach(async () => { for (const ws of sockets) ws.terminate(); sockets.clear(); await pause(30); });
afterAll(async () => { await new Promise((r) => wss.close(r)); await new Promise((r) => server.close(r)); });

describe('règle de visibilité', () => {
  it('même organisation : on se voit ; organisations différentes ou sans organisation : non', () => {
    const o = nouvelleOrg(); const a = compte({ org: o }); const b = compte({ org: o });
    const c = compte({ org: nouvelleOrg() }); const d = compte(); const e = compte();
    expect(voit(a.id, b.id)).toBe(true);
    expect(voit(a.id, c.id)).toBe(false);
    expect(voit(d.id, e.id)).toBe(false); // deux comptes sans organisation ne se voient pas
    expect(voit(d.id, d.id)).toBe(true);
  });

  it('un canal ne donne la présence d’un membre que s’il y a participé', () => {
    const intrus = compte(); const cible = compte();
    const c = canal(intrus, [cible]);            // l'intrus crée un canal et y ajoute la cible
    expect(voit(intrus.id, cible.id)).toBe(false); // être ajouté ne suffit pas
    expect(voit(cible.id, intrus.id)).toBe(true);  // l'intrus, lui, a participé (créateur)
    ecrire(c, cible);                              // la cible écrit : elle participe
    expect(voit(intrus.id, cible.id)).toBe(true);
  });

  it('ontEchange : seulement après un courrier entre les deux', () => {
    const a = compte(); const b = compte();
    expect(ontEchange(a.id, b.id)).toBe(false);
    courrier(b, a);
    expect(ontEchange(a.id, b.id)).toBe(true);
    expect(ontEchange(b.id, a.id)).toBe(true);
  });
});

describe('présence (C-13)', () => {
  it('presence:init et les annonces ne vont qu’aux comptes autorisés', async () => {
    const o = nouvelleOrg(); const alice = compte({ org: o }); const collegue = compte({ org: o }); const etranger = compte({ org: nouvelleOrg() });
    const { ws: wsCollegue } = await connecte(collegue);
    const { ws: wsEtranger } = await connecte(etranger);
    const { init } = await connecte(alice);
    expect(init.online).toContain(collegue.id);
    expect(init.online).not.toContain(etranger.id);
    await attendre(wsCollegue, (m) => m.type === 'presence' && m.userId === alice.id && m.online === true);
    await pause(150);
    expect(wsEtranger.recus.some((m) => m.type === 'presence' && m.userId === alice.id)).toBe(false);
  });

  it('le drapeau « en ligne » des destinataires suit la même règle', async () => {
    const alice = compte(); const bob = compte();
    await connecte(bob);
    const r1 = await request(server).get(`/api/users/recipients?emails=${encodeURIComponent(bob.email)}`).set('Authorization', `Bearer ${alice.token}`);
    expect(r1.status).toBe(200);
    expect(r1.body.recipients.find((x) => x.email === bob.email).online).toBe(false); // inconnu pour alice
    courrier(alice, bob);
    const r2 = await request(server).get(`/api/users/recipients?emails=${encodeURIComponent(bob.email)}`).set('Authorization', `Bearer ${alice.token}`);
    expect(r2.body.recipients.find((x) => x.email === bob.email).online).toBe(true);
  });
});

describe('disponibilités (C-14)', () => {
  it('créneaux d’un collègue visibles ; ceux d’un inconnu rendus comme une adresse inexistante', async () => {
    const o = nouvelleOrg(); const alice = compte({ org: o }); const collegue = compte({ org: o }); const etranger = compte();
    for (const u of [collegue, etranger]) db.prepare("INSERT INTO events (owner_id, title, starts_at, ends_at) VALUES (?, 'Secret', '2026-11-02T09:00', '2026-11-02T10:00')").run(u.id);
    const fantome = `personne-${randomUUID().slice(0, 6)}@comet.mail`;
    const r = await request(server).get(`/api/calendar/freebusy?emails=${encodeURIComponent([collegue.email, etranger.email, fantome].join(','))}`).set('Authorization', `Bearer ${alice.token}`);
    expect(r.status).toBe(200);
    expect(r.body.busy[collegue.email]).toEqual([{ startsAt: '2026-11-02T09:00', endsAt: '2026-11-02T10:00' }]);
    expect(r.body.busy[etranger.email]).toBeNull();
    expect(r.body.busy[fantome]).toBeNull();
    expect(JSON.stringify(r.body)).not.toContain('Secret');
  });

  it('borne le nombre d’adresses par requête', async () => {
    const alice = compte();
    const trop = Array.from({ length: 51 }, (_, i) => `x${i}@comet.mail`).join(',');
    const r = await request(server).get(`/api/calendar/freebusy?emails=${encodeURIComponent(trop)}`).set('Authorization', `Bearer ${alice.token}`);
    expect(r.status).toBe(400);
  });
});

describe('visio : entrée (C-11) et signalisation (C-12)', () => {
  async function rejoindre(qui, room) {
    const { ws } = await connecte(qui);
    envoyer(ws, { type: 'conf:join', room, name: 'X' });
    const rep = await attendre(ws, (m) => m.type === 'conf:peers' || m.type === 'conf:error');
    return { ws, rep };
  }

  it('liens coupés : seuls l’hôte et son organisation entrent', async () => {
    const o = nouvelleOrg(); const hote = compte({ org: o }); const collegue = compte({ org: o }); const etranger = compte({ org: nouvelleOrg() }); const sansOrg = compte();
    const room = createRoom({ hostId: hote.id, hostName: 'Hôte', name: 'R', hostOrgId: o });
    setConfig(room, { linkEnabled: false });
    expect((await rejoindre(hote, room.id)).rep.type).toBe('conf:peers');
    expect((await rejoindre(collegue, room.id)).rep.type).toBe('conf:peers');
    expect((await rejoindre(etranger, room.id)).rep).toMatchObject({ type: 'conf:error', code: 'link-disabled' });
    expect((await rejoindre(sansOrg, room.id)).rep).toMatchObject({ type: 'conf:error', code: 'link-disabled' });
  });

  it('liens actifs : qui a le lien entre, même d’une autre organisation', async () => {
    const hote = compte({ org: nouvelleOrg() }); const etranger = compte({ org: nouvelleOrg() });
    const room = createRoom({ hostId: hote.id, hostName: 'Hôte', name: 'R', hostOrgId: null });
    expect((await rejoindre(etranger, room.id)).rep.type).toBe('conf:peers');
  });

  it('un compte hors du salon ne relaie rien ; un participant, si', async () => {
    const o = nouvelleOrg(); const hote = compte({ org: o }); const intrus = compte({ org: o });
    const room = createRoom({ hostId: hote.id, hostName: 'Hôte', name: 'R', hostOrgId: o });
    const { ws: wsHote, rep } = await rejoindre(hote, room.id);
    const cible = rep.you;
    const { ws: wsIntrus } = await connecte(intrus);       // connecté, mais pas dans le salon
    envoyer(wsIntrus, { type: 'conf:signal', room: room.id, to: cible, data: { sdp: 'faux' } });
    await pause(150);
    expect(wsHote.recus.some((m) => m.type === 'conf:signal')).toBe(false);
    const { ws: wsMembre } = await rejoindre(compte({ org: o }), room.id);
    envoyer(wsMembre, { type: 'conf:signal', room: room.id, to: cible, data: { sdp: 'vrai' } });
    expect((await attendre(wsHote, (m) => m.type === 'conf:signal')).data).toEqual({ sdp: 'vrai' });
  });

  it('borne le débit par socket et la taille d’un message', async () => {
    const o = nouvelleOrg(); const hote = compte({ org: o }); const membre = compte({ org: o });
    const room = createRoom({ hostId: hote.id, hostName: 'Hôte', name: 'R', hostOrgId: o });
    const { ws: wsHote, rep } = await rejoindre(hote, room.id);
    const { ws: wsMembre } = await rejoindre(membre, room.id);   // 1 message (conf:join) déjà compté
    for (let i = 0; i < MESSAGES_MAX + 50; i++) envoyer(wsMembre, { type: 'conf:signal', room: room.id, to: rep.you, data: i });
    await pause(400);
    const recus = wsHote.recus.filter((m) => m.type === 'conf:signal').length;
    expect(recus).toBe(MESSAGES_MAX - 1);
    const ferme = new Promise((r) => wsMembre.once('close', (code) => r(code)));
    wsMembre.send('x'.repeat(TAILLE_MAX_MESSAGE + 1));
    expect(await ferme).toBe(1009); // « message trop gros »
  });
});

describe('boîte partagée : retrait d’un membre avec rotation des clés (C-20)', () => {
  function boite(proprio, autres) {
    const email = `boite-${randomUUID().slice(0, 8)}@comet.mail`;
    const id = Number(db.prepare("INSERT INTO users (email, display_name, password_hash, is_box, public_key, enc_private_key) VALUES (?, 'Boîte', '', 1, 'pub-v1', 'prive-v1')").run(email).lastInsertRowid);
    db.prepare("INSERT INTO shared_mailbox_members (box_id, user_id, enc_key, role) VALUES (?, ?, 'k1-proprio', 'owner')").run(id, proprio.id);
    for (const a of autres) db.prepare("INSERT INTO shared_mailbox_members (box_id, user_id, enc_key, role) VALUES (?, ?, ?, 'member')").run(id, a.id, `k1-${a.id}`);
    return id;
  }
  const retrait = (qui, boxId, cible, corps) => request(server).post(`/api/shared/${boxId}/members/${cible.id}/retrait`).set('Authorization', `Bearer ${qui.token}`).send(corps);
  const rotation = (restants, extra = {}) => ({
    keyVersion: 1, publicKey: 'pub-v2', wrappedPrivateKey: 'prive-v2', oldPrivateKeys: ['prive-v1-sous-k2'],
    members: Object.fromEntries(restants.map((u) => [u.id, `k2-${u.id}`])), ...extra,
  });

  it('refuse un retrait sans rotation, ou par un simple membre', async () => {
    const proprio = compte(); const membre = compte(); const ex = compte();
    const id = boite(proprio, [membre, ex]);
    const ancien = await request(server).delete(`/api/shared/${id}/members/${ex.id}`).set('Authorization', `Bearer ${proprio.token}`);
    expect(ancien.status).toBe(410);
    expect((await retrait(membre, id, ex, rotation([proprio, membre]))).status).toBe(403);
    expect(db.prepare('SELECT 1 FROM shared_mailbox_members WHERE box_id = ? AND user_id = ?').get(id, ex.id)).toBeTruthy();
  });

  it('refuse une rotation incomplète, qui inclut l’ex-membre, périmée ou sans historique', async () => {
    const proprio = compte(); const membre = compte(); const ex = compte(); const etranger = compte();
    const id = boite(proprio, [membre, ex]);
    expect((await retrait(proprio, id, ex, rotation([proprio]))).status).toBe(400);                        // membre oublié
    expect((await retrait(proprio, id, ex, rotation([proprio, membre, ex]))).status).toBe(400);            // ex-membre inclus
    expect((await retrait(proprio, id, ex, rotation([proprio, membre, etranger]))).status).toBe(400);      // étranger glissé
    expect((await retrait(proprio, id, ex, rotation([proprio, membre], { keyVersion: 0 }))).status).toBe(409);
    expect((await retrait(proprio, id, ex, rotation([proprio, membre], { oldPrivateKeys: [] }))).status).toBe(400);
    expect((await retrait(proprio, id, ex, rotation([proprio, membre], { publicKey: 'pub-v1' }))).status).toBe(400);
    const rien = db.prepare('SELECT public_key, box_key_version FROM users WHERE id = ?').get(id);
    expect(rien).toEqual({ public_key: 'pub-v1', box_key_version: 1 });
  });

  it('retrait valide : nouvelles clés pour les restants, l’ex-membre n’a plus accès', async () => {
    const proprio = compte(); const membre = compte(); const ex = compte();
    const id = boite(proprio, [membre, ex]);
    db.prepare("INSERT INTO box_routes (box_id, match_from, assignee_id) VALUES (?, '*', ?)").run(id, ex.id);
    const r = await retrait(proprio, id, ex, rotation([proprio, membre]));
    expect(r.status).toBe(200);
    expect(r.body.keyVersion).toBe(2);
    const b = db.prepare('SELECT public_key, enc_private_key, box_old_keys, box_key_version FROM users WHERE id = ?').get(id);
    expect(b).toEqual({ public_key: 'pub-v2', enc_private_key: 'prive-v2', box_old_keys: JSON.stringify(['prive-v1-sous-k2']), box_key_version: 2 });
    expect(db.prepare('SELECT enc_key FROM shared_mailbox_members WHERE box_id = ? AND user_id = ?').get(id, membre.id).enc_key).toBe(`k2-${membre.id}`);
    expect(db.prepare('SELECT 1 FROM box_routes WHERE box_id = ? AND assignee_id = ?').get(id, ex.id)).toBeUndefined();
    expect((await request(server).get(`/api/shared/${id}`).set('Authorization', `Bearer ${ex.token}`)).status).toBe(403);
    const vu = await request(server).get(`/api/shared/${id}`).set('Authorization', `Bearer ${membre.token}`);
    expect(vu.body.box).toMatchObject({ keyVersion: 2, oldPrivateKeys: ['prive-v1-sous-k2'], wrappedPrivateKey: 'prive-v2', myEncKey: `k2-${membre.id}` });
    // Un ajout de membre préparé avec l'ancienne version est refusé.
    const nouveau = compte();
    const perime = await request(server).post(`/api/shared/${id}/members`).set('Authorization', `Bearer ${membre.token}`).send({ keyVersion: 1, members: { [nouveau.email]: 'k1' } });
    expect(perime.status).toBe(409);
    const ok = await request(server).post(`/api/shared/${id}/members`).set('Authorization', `Bearer ${membre.token}`).send({ keyVersion: 2, members: { [nouveau.email]: 'k2' } });
    expect(ok.body.added).toBe(1);
  });
});

describe('relais des pièces jointes en pair-à-pair', () => {
  it('pas de relais vers un inconnu ; relais après un courrier échangé', async () => {
    const alice = compte(); const bob = compte();
    const { ws: wsBob } = await connecte(bob);
    const { ws: wsAlice } = await connecte(alice);
    envoyer(wsAlice, { type: 'rtc:signal', to: bob.id, data: 'offre-1' });
    await pause(150);
    expect(wsBob.recus.some((m) => m.type === 'rtc:signal')).toBe(false);
    courrier(alice, bob);
    const { ws: wsAlice2 } = await connecte(alice);       // nouveau socket : verdict recalculé
    envoyer(wsAlice2, { type: 'rtc:signal', to: bob.id, data: 'offre-2' });
    expect((await attendre(wsBob, (m) => m.type === 'rtc:signal')).data).toBe('offre-2');
  });
});


describe('F-D6D44F : isolation des messages WebSocket invalides', () => {
  function attendreFermeture(ws) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket invalide non fermé')), 3000);
      ws.once('close', (code) => { clearTimeout(timer); resolve(code); });
    });
  }

  it.each([
    ['JSON null', 'null'],
    ['tableau JSON', '[]'],
    ['type non textuel', JSON.stringify({ type: { valueOf: null } })],
    ['configuration de salon non objet', JSON.stringify({ type: 'conf:config', room: 'salon-fictif', config: null })],
    ['destination RTC non primitive', JSON.stringify({ type: 'rtc:signal', to: { toString: null, valueOf: null }, data: 'x' })],
    ['identifiant de salon non primitif', JSON.stringify({ type: 'conf:join', room: { toString: null, valueOf: null }, name: 'x' })],
    ['nom de participant non primitif', JSON.stringify({ type: 'conf:join', room: 'salon-fictif', name: { toString: null, valueOf: null } })],
  ])('rejette %s sans interrompre les autres comptes', async (_label, payload) => {
    const sain = compte({ org: nouvelleOrg() });
    const fautif = compte({ org: nouvelleOrg() });
    const { ws: wsSain } = await connecte(sain);
    const { ws: wsFautif } = await connecte(fautif);
    const fermeture = attendreFermeture(wsFautif);
    wsFautif.send(payload);
    expect(await fermeture).toBe(1008);
    const room = createRoom({ hostId: sain.id, hostName: 'Sain', name: 'Témoin', hostOrgId: null });
    envoyer(wsSain, { type: 'conf:join', room: room.id, name: 'Sain' });
    expect((await attendre(wsSain, (m) => m.type === 'conf:peers' && m.room === room.id)).you).toBeTruthy();
  });

  it.each([
    ['destination non primitive', JSON.stringify({ type: 'conf:signal', to: { toString: null, valueOf: null }, data: 'x' })],
    ['JSON null', 'null'],
  ])('rejette un message invité invalide (%s) et conserve le salon et ses participants sains', async (_label, payload) => {
    const hote = compte({ org: nouvelleOrg() });
    const room = createRoom({ hostId: hote.id, hostName: 'Hôte', name: 'Témoin invité', hostOrgId: null });
    const { ws: wsHote } = await connecte(hote);
    envoyer(wsHote, { type: 'conf:join', room: room.id, name: 'Hôte' });
    await attendre(wsHote, (m) => m.type === 'conf:peers' && m.room === room.id);

    const invite = ouvrir(issueGuestToken(room, 'Invité'));
    await new Promise((resolve, reject) => { invite.once('open', resolve); invite.once('error', reject); });
    envoyer(invite, { type: 'conf:join', name: 'Invité' });
    await attendre(invite, (m) => m.type === 'conf:peers' && m.room === room.id);
    const fermeture = attendreFermeture(invite);
    invite.send(payload);
    expect(await fermeture).toBe(1008);

    const autre = ouvrir(issueGuestToken(room, 'Témoin'));
    await new Promise((resolve, reject) => { autre.once('open', resolve); autre.once('error', reject); });
    envoyer(autre, { type: 'conf:join', name: 'Témoin' });
    expect((await attendre(autre, (m) => m.type === 'conf:peers' && m.room === room.id)).you).toBeTruthy();
    expect(wsHote.readyState).toBe(WebSocket.OPEN);
  });
});
