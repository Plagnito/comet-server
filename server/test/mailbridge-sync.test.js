// Synchro IMAP (récupération + stockage) : on exerce fetchNewMessages avec un client
// IMAP FACTICE et de vrais messages RFC822 (mailparser réel), donc SANS réseau. On
// vérifie les invariants du nouveau comportement : le HTML n'est PAS stocké, le texte
// reste dérivé (y compris pour un e-mail HTML-only), le dédoublonnage par UID, et la
// progression de last_uid. Le mode IDLE (socket persistant) n'est pas testable ici,
// mais il partage exactement cette primitive de fetch/parse/stockage.
import { describe, it, expect, afterAll } from 'vitest';
import { db } from '../src/db.js';
import { fetchNewMessages } from '../src/services/mailbridge.js';

// Client IMAP minimal : expose mailbox.uidNext et un fetch() itérable async.
function fakeClient(uidNext, msgs) {
  return { mailbox: { uidNext }, async *fetch() { for (const m of msgs) yield m; } };
}
const rfc822 = (s) => Buffer.from(s.replace(/\n/g, '\r\n'));

const PLAIN = rfc822(`From: Alice <alice@example.com>
To: bob@example.org
Subject: Bonjour
Date: Wed, 09 Jul 2026 10:00:00 +0000
Message-ID: <plain-1@example.com>

Ceci est le corps en texte brut.
`);
const HTML_ONLY = rfc822(`From: Boutique <shop@example.com>
To: bob@example.org
Subject: Promo
Content-Type: text/html; charset=utf-8
Message-ID: <html-1@example.com>

<p>Salut <b>le monde</b> !</p>
`);
const PLAIN2 = rfc822(`From: Carol <carol@example.com>
To: bob@example.org
Subject: Suite
Message-ID: <plain-2@example.com>

Deuxième message.
`);

let userId, accountId;
{
  const u = db.prepare("INSERT INTO users (email, display_name, password_hash) VALUES (?, ?, ?)").run('sync@test.local', 'Sync', 'x');
  userId = Number(u.lastInsertRowid);
  const a = db.prepare(`INSERT INTO mail_accounts (user_id, email, imap_host, smtp_host, username, sealed_pass)
                        VALUES (?, ?, ?, ?, ?, ?)`).run(userId, 'sync@test.local', 'imap.test', 'smtp.test', 'sync@test.local', 'sealed');
  accountId = Number(a.lastInsertRowid);
}
const acct = () => db.prepare('SELECT * FROM mail_accounts WHERE id = ?').get(accountId);
const rows = () => db.prepare('SELECT * FROM ext_messages WHERE account_id = ? ORDER BY uid').all(accountId);

afterAll(() => { db.prepare('DELETE FROM users WHERE id = ?').run(userId); }); // cascade → mail_accounts + ext_messages

describe('fetchNewMessages (synchro IMAP)', () => {
  it('récupère les nouveaux messages, ne stocke jamais de HTML, dérive le texte', async () => {
    const client = fakeClient(12, [{ uid: 10, source: PLAIN }, { uid: 11, source: HTML_ONLY }]);
    const n = await fetchNewMessages(acct(), client);
    expect(n).toBe(2);
    const r = rows();
    expect(r).toHaveLength(2);
    // HTML jamais stocké (le lecteur n'affiche que le texte)
    expect(r.every((x) => x.body_html === '')).toBe(true);
    // texte présent pour le message texte ET dérivé pour le HTML-only (html→texte)
    expect(r.find((x) => x.uid === 10).body_text).toContain('texte brut');
    expect(r.find((x) => x.uid === 11).body_text).toContain('monde');
    // enveloppe correctement extraite + last_uid avancé
    expect(r.find((x) => x.uid === 10).from_addr).toBe('alice@example.com');
    expect(acct().last_uid).toBe(11);
  });

  it('dédoublonne par UID et n\'insère que le nouveau message', async () => {
    // uidNext plus haut, on re-présente le 11 (déjà vu) + un 12 inédit
    const client = fakeClient(13, [{ uid: 11, source: HTML_ONLY }, { uid: 12, source: PLAIN2 }]);
    await fetchNewMessages(acct(), client);
    const r = rows();
    expect(r).toHaveLength(3);                       // 2 + 1 seul nouveau
    expect(r.filter((x) => x.uid === 11)).toHaveLength(1); // pas de doublon
    expect(acct().last_uid).toBe(12);
  });

  it('ne fait rien quand aucun UID n\'est plus récent (rien à faire)', async () => {
    const before = rows().length;
    const client = fakeClient(13, [{ uid: 99, source: PLAIN }]); // uidNext = last_uid+1 → early return
    const n = await fetchNewMessages(acct(), client);
    expect(n).toBe(0);
    expect(rows()).toHaveLength(before);
  });
});
