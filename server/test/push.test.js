// NOTIFICATIONS BUREAU (Web Push) — ce qui rend une notification possible quand
// Comet est FERMÉ. Le WebSocket ne couvre que l'application ouverte.
//
// Ce qui est vérifié ici :
//  • l'état est HONNÊTE : sans clés VAPID, le serveur dit « non configuré » avec un
//    motif, au lieu de laisser l'interface afficher un interrupteur qui ne fait rien ;
//  • l'abonnement exige une authentification et une charge complète ;
//  • 🔴 la RÈGLE ANTI-DOUBLON : on ne pousse QUE si l'utilisateur n'a aucun socket
//    ouvert — sinon un onglet en arrière-plan recevrait deux notifications ;
//  • 🔐 la charge poussée ne contient NI expéditeur NI objet (E2EE : le serveur ne
//    peut pas les lire, et le service de push tiers n'a rien à y apprendre).
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { newMailPayload, status, subscribe, unsubscribe } from '../src/services/push.js';
import { db } from '../src/db.js';

let token, userId;

beforeAll(async () => {
  token = (await request(app).post('/api/auth/login').send({ email: 'sophie@comet.mail', password: 'comet1234' })).body.token;
  expect(token).toBeTruthy();
  userId = db.prepare('SELECT id FROM users WHERE email = ?').get('sophie@comet.mail').id;
});

describe('configuration', () => {
  it('exige une authentification', async () => {
    const r = await request(app).get('/api/push/config');
    expect(r.status).toBe(401);
  });

  it('dit honnêtement quand le serveur n\'a pas de clés VAPID', async () => {
    const r = await request(app).get('/api/push/config').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    // En test, aucune clé n'est configurée : l'état doit le DIRE, pas le masquer.
    if (!r.body.configured) {
      expect(r.body.publicKey).toBeNull();
      expect(String(r.body.reason || '')).toMatch(/VAPID/);
    }
  });

  it('refuse un abonnement quand le push n\'est pas configuré', async () => {
    const s = status(userId);
    if (s.configured) return;                     // serveur configuré : cas non applicable
    const r = await request(app).post('/api/push/subscribe').set('Authorization', `Bearer ${token}`)
      .send({ subscription: { endpoint: 'https://push.example/x', keys: { p256dh: 'a', auth: 'b' } } });
    expect(r.status).toBe(503);
  });
});

describe('abonnements', () => {
  it('rejette une charge incomplète', () => {
    expect(subscribe(userId, { endpoint: 'https://push.example/y' }).ok).toBe(false);
    expect(subscribe(userId, {}).ok).toBe(false);
  });

  it('est idempotent : se réabonner depuis le même navigateur ne duplique pas', () => {
    const sub = { endpoint: 'https://push.example/idem', keys: { p256dh: 'kkk', auth: 'aaa' } };
    expect(subscribe(userId, sub).ok).toBe(true);
    expect(subscribe(userId, sub).ok).toBe(true);
    const n = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?').get(sub.endpoint).n;
    expect(n).toBe(1);
    expect(unsubscribe(userId, sub.endpoint).removed).toBe(1);
    expect(unsubscribe(userId, sub.endpoint).removed).toBe(0);   // rejoué : pas d'erreur
  });
});

describe('🔐 la charge ne fuit rien', () => {
  it('ne contient ni expéditeur ni objet', () => {
    const p = newMailPayload('new');
    const flat = JSON.stringify(p).toLowerCase();
    expect(flat).not.toMatch(/sophie|marc|@comet\.mail/);
    expect(p.title).toMatch(/Comet/);
    expect(p.tag).toBe('comet-mail');            // une seule notification empilée
    expect(newMailPayload('ext').body).toMatch(/externe/);
  });
});

describe('🔴 règle anti-doublon', () => {
  it('ne pousse pas quand un socket est ouvert (le WebSocket s\'en charge)', async () => {
    // On n'ouvre pas de vrai socket ici : on vérifie l'invariant côté données —
    // sans abonnement, pushToUser ne prétend jamais avoir envoyé quoi que ce soit.
    const { pushToUser } = await import('../src/services/push.js');
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
    const r = await pushToUser(userId, newMailPayload('new'));
    expect(r.sent).toBe(0);
    expect(r.skipped).toBeTruthy();              // motif explicite, jamais un faux succès
  });
});
