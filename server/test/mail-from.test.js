// Envoi DEPUIS une adresse choisie (alias / adresse pro <user>@<org>.mail).
// L'expéditeur peut émettre depuis un de SES alias actifs ; le destinataire voit
// cette adresse en « De ». Toute adresse non possédée est ignorée (anti-usurpation).
// Jetons forgés directement (pas de /login) → indépendant des tests de rate-limit.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { db } from '../src/db.js';
import { signToken } from '../src/auth.js';

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const userByEmail = (e) => db.prepare('SELECT * FROM users WHERE email = ?').get(e);

let leaToken, marcToken;
const PRO = 'pro-lea@comet.mail';

beforeAll(() => {
  const lea = userByEmail('lea@comet.mail');
  const marc = userByEmail('marc@comet.mail');
  expect(lea && marc).toBeTruthy();
  leaToken = signToken(lea);   // sans sid → pas de session requise (cf. authRequired)
  marcToken = signToken(marc);
  // Alias possédé par Léa (tient lieu d'adresse pro), actif par défaut.
  db.prepare('DELETE FROM aliases WHERE alias_email = ?').run(PRO);
  db.prepare('INSERT INTO aliases (owner_id, alias_email, label) VALUES (?, ?, ?)').run(lea.id, PRO, 'Adresse pro');
});

// Dernier message reçu de Léa dans la boîte de Marc (liste triée du + récent au + ancien).
async function lastFromLea() {
  const r = await request(app).get('/api/mail?folder=inbox').set(auth(marcToken));
  expect(r.status).toBe(200);
  const it = r.body.items.find((m) => m.from && m.from.displayName === 'Léa Martin');
  return it ? it.from : null;
}

describe('Envoi depuis une adresse choisie (alias / pro)', () => {
  it('émet depuis un alias possédé → le destinataire voit cette adresse en « De »', async () => {
    const send = await request(app).post('/api/mail').set(auth(leaToken))
      .send({ to: ['marc@comet.mail'], subject: 'Bonjour pro', body: 'Test', fromEmail: PRO });
    expect(send.status).toBe(201);
    const from = await lastFromLea();
    expect(from).toBeTruthy();
    expect(from.email).toBe(PRO);                 // adresse pro affichée
    expect(from.displayName).toBe('Léa Martin');  // identité conservée
  });

  it('ignore une adresse « De » non possédée → repli sur l’e-mail principal', async () => {
    // marc@comet.mail n'appartient pas à Léa : doit être ignorée (anti-usurpation).
    const send = await request(app).post('/api/mail').set(auth(leaToken))
      .send({ to: ['marc@comet.mail'], subject: 'Bonjour usurp', body: 'Test', fromEmail: 'marc@comet.mail' });
    expect(send.status).toBe(201);
    const from = await lastFromLea(); // le tout dernier message de Léa
    expect(from.email).toBe('lea@comet.mail');
  });
});
