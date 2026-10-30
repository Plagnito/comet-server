// Synchronisation delta d'un client hors ligne (GET /api/mail/sync).
//
// Ce que ces tests protègent : un cache local qui dérive EN SILENCE. Les trois défauts
// visés ne produisent aucune erreur, ni côté serveur ni côté client — ils se traduisent
// juste par une application qui affiche autre chose que la vérité :
//
//   • un message lu sur le web reste non lu dans l'application, pour toujours ;
//   • un message supprimé sur le web reste visible dans l'application, pour toujours ;
//   • deux changements dans la même seconde, dont un seul est vu.
//
// Jetons forgés directement (pas de /login) → indépendant des tests de rate-limit.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { db, compacterJournalMail } from '../src/db.js';
import { signToken } from '../src/auth.js';

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const userByEmail = (e) => db.prepare('SELECT * FROM users WHERE email = ?').get(e);

let lea, marc, leaToken, marcToken;

// Dépose un message dans la boîte de `user` sans passer par l'API : on veut éprouver la
// synchronisation, pas le pipeline d'envoi.
function deposer(user, sujet) {
  // `thread_id` est un TEXT NOT NULL : le code réel y met un UUID pour un nouveau fil.
  const m = db.prepare(`
    INSERT INTO messages (sender_id, thread_id, subject, body, is_sent, sent_at)
    VALUES (?, ?, ?, ?, 1, datetime('now'))
  `).run(user.id, randomUUID(), sujet, 'corps');
  const item = db.prepare(`
    INSERT INTO mail_items (user_id, message_id, folder) VALUES (?, ?, 'inbox')
  `).run(user.id, m.lastInsertRowid);
  return Number(item.lastInsertRowid);
}

const sync = (token, depuis) =>
  request(app).get(`/api/mail/sync${depuis === undefined ? '' : `?since=${depuis}`}`).set(auth(token));

beforeAll(() => {
  lea = userByEmail('lea@comet.mail');
  marc = userByEmail('marc@comet.mail');
  expect(lea && marc).toBeTruthy();
  leaToken = signToken(lea);
  marcToken = signToken(marc);
});

describe('synchronisation delta du courrier', () => {
  it('la première synchronisation rend un instantané complet et un curseur', async () => {
    // Ne rien supposer du contenu de départ : les comptes de démonstration n'ont pas
    // forcément de courrier. On dépose, puis on demande l'instantané.
    const itemId = deposer(lea, 'Déjà en base avant la première synchronisation');

    const r = await sync(leaToken);
    expect(r.status).toBe(200);
    expect(r.body.complet).toBe(true);
    expect(typeof r.body.curseur).toBe('number');
    // Les déclencheurs ne valent que pour l'avenir : sans cet instantané, un client neuf
    // ne verrait AUCUN des messages déjà en base au moment de la migration.
    expect(r.body.items.map((i) => i.itemId)).toContain(itemId);
  });

  it('un nouveau message apparaît dans le delta suivant', async () => {
    const depart = (await sync(leaToken)).body.curseur;
    // Le journal a déjà servi (test précédent), donc le curseur est non nul et le
    // prochain appel est bien un delta, pas un second instantané.
    expect(depart).toBeGreaterThan(0);

    const itemId = deposer(lea, 'Message de synchronisation');

    const r = await sync(leaToken, depart);
    expect(r.status).toBe(200);
    expect(r.body.complet).toBe(false);
    expect(r.body.items.map((i) => i.itemId)).toContain(itemId);
  });

  it('un changement d\'ÉTAT est vu — le défaut que « id > curseur » ne verrait pas', async () => {
    const itemId = deposer(lea, 'À marquer comme lu');
    const depart = (await sync(leaToken)).body.curseur;

    // Aucune ligne créée : seulement une colonne modifiée. C'est exactement le cas
    // qu'une synchronisation fondée sur l'identifiant auto-incrémenté rate.
    db.prepare('UPDATE mail_items SET is_read = 1 WHERE id = ?').run(itemId);

    const r = await sync(leaToken, depart);
    const vu = r.body.items.find((i) => i.itemId === itemId);
    expect(vu, 'le passage à « lu » doit remonter dans le delta').toBeTruthy();
    expect(vu.isRead).toBe(true);
  });

  it('un déplacement de dossier est vu', async () => {
    const itemId = deposer(lea, 'À archiver');
    const depart = (await sync(leaToken)).body.curseur;

    db.prepare("UPDATE mail_items SET folder = 'archive' WHERE id = ?").run(itemId);

    const r = await sync(leaToken, depart);
    expect(r.body.items.find((i) => i.itemId === itemId)?.folder).toBe('archive');
  });

  it('une SUPPRESSION est annoncée — sinon le cache garde un message disparu', async () => {
    const itemId = deposer(lea, 'À supprimer');
    const depart = (await sync(leaToken)).body.curseur;

    db.prepare('DELETE FROM mail_items WHERE id = ?').run(itemId);

    const r = await sync(leaToken, depart);
    expect(r.body.supprimes).toContain(itemId);
    expect(r.body.items.map((i) => i.itemId)).not.toContain(itemId);
  });

  it('deux modifications dans la même seconde sont toutes deux vues', async () => {
    const a = deposer(lea, 'Rapide A');
    const b = deposer(lea, 'Rapide B');
    const depart = (await sync(leaToken)).body.curseur;

    // Sans horloge entre les deux : un curseur temporel (résolution à la seconde) en
    // perdrait une. La séquence auto-incrémentée, non.
    db.prepare('UPDATE mail_items SET is_starred = 1 WHERE id = ?').run(a);
    db.prepare('UPDATE mail_items SET is_starred = 1 WHERE id = ?').run(b);

    const r = await sync(leaToken, depart);
    const vus = r.body.items.map((i) => i.itemId);
    expect(vus).toContain(a);
    expect(vus).toContain(b);
  });

  it('une suppression qui suit des modifications l\'emporte', async () => {
    const itemId = deposer(lea, 'Modifié puis supprimé');
    const depart = (await sync(leaToken)).body.curseur;

    db.prepare('UPDATE mail_items SET is_read = 1 WHERE id = ?').run(itemId);
    db.prepare('UPDATE mail_items SET is_starred = 1 WHERE id = ?').run(itemId);
    db.prepare('DELETE FROM mail_items WHERE id = ?').run(itemId);

    const r = await sync(leaToken, depart);
    expect(r.body.supprimes).toContain(itemId);
    expect(r.body.items.map((i) => i.itemId)).not.toContain(itemId);
  });

  it('rien à signaler quand rien n\'a changé', async () => {
    const depart = (await sync(leaToken)).body.curseur;
    const r = await sync(leaToken, depart);
    expect(r.body.items).toHaveLength(0);
    expect(r.body.supprimes).toHaveLength(0);
    expect(r.body.encore).toBe(false);
  });

  it('le delta d\'un compte ne fuit pas dans celui d\'un autre', async () => {
    const departMarc = (await sync(marcToken)).body.curseur;
    const itemLea = deposer(lea, 'Strictement privé');

    const r = await sync(marcToken, departMarc);
    expect(r.body.items.map((i) => i.itemId)).not.toContain(itemLea);
    expect(r.body.supprimes).not.toContain(itemLea);
  });

  it('la compaction ne fait perdre aucun changement à un client en retard', async () => {
    const itemId = deposer(lea, 'Avant compaction');
    const depart = (await sync(leaToken)).body.curseur;

    db.prepare('UPDATE mail_items SET is_read = 1 WHERE id = ?').run(itemId);
    db.prepare('UPDATE mail_items SET is_starred = 1 WHERE id = ?').run(itemId);

    const { avant, apres } = compacterJournalMail();
    expect(apres).toBeLessThanOrEqual(avant);

    // Le client au curseur `depart` doit toujours voir l'élément : la compaction ne
    // retire que les états intermédiaires, jamais le dernier connu.
    const r = await sync(leaToken, depart);
    const vu = r.body.items.find((i) => i.itemId === itemId);
    expect(vu, 'la compaction ne doit pas escamoter le dernier état').toBeTruthy();
    expect(vu.isStarred).toBe(true);
  });

  it('le curseur ne recule jamais', async () => {
    const a = (await sync(leaToken)).body.curseur;
    deposer(lea, 'Encore un');
    const b = (await sync(leaToken, a)).body.curseur;
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it('« sync » n\'est pas confondu avec un identifiant de message', async () => {
    // Si la route était déclarée après `/:id`, Express répondrait 404 (ou 400) ici.
    const r = await sync(leaToken);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('curseur');
  });

  it('exige une authentification', async () => {
    const r = await request(app).get('/api/mail/sync');
    expect(r.status).toBe(401);
  });
});
