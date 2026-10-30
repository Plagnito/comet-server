// File d'envoi SMTP (outbox) : on vérifie la machine à états (pending → sent,
// retries à back-off → failed, compte supprimé) SANS réseau réel — le sender SMTP
// (mailbridge) et les WebSockets sont mockés.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const sendMailMock = vi.fn();
vi.mock('../src/services/mailbridge.js', () => ({ sendMail: (...a) => sendMailMock(...a) }));
vi.mock('../src/ws.js', () => ({ notifyUser: vi.fn() }));

const { db } = await import('../src/db.js');
const { enqueueMail, runOutboxTick } = await import('../src/services/outbox.js');

// Compte jetable (utilisateur + compte mail) ; ON DELETE CASCADE nettoie le reste.
let userId, accountId;
function seed() {
  const u = db.prepare("INSERT INTO users (email, display_name, password_hash) VALUES (?, ?, ?)").run('outbox@test.local', 'Outbox', 'x');
  userId = Number(u.lastInsertRowid);
  const a = db.prepare(`INSERT INTO mail_accounts (user_id, email, imap_host, smtp_host, username, sealed_pass)
                        VALUES (?, ?, ?, ?, ?, ?)`).run(userId, 'outbox@test.local', 'imap.test', 'smtp.test', 'outbox@test.local', 'sealed');
  accountId = Number(a.lastInsertRowid);
}
seed();

beforeEach(() => { sendMailMock.mockReset(); db.prepare('DELETE FROM mail_outbox WHERE user_id = ?').run(userId); });
afterAll(() => { db.prepare('DELETE FROM users WHERE id = ?').run(userId); }); // cascade → mail_accounts + mail_outbox

describe('outbox', () => {
  it('enqueueMail écrit une ligne « pending » avec la charge JSON', () => {
    const id = enqueueMail(accountId, userId, { to: 'x@y.z', subject: 'hi', text: 'yo' });
    const row = db.prepare('SELECT * FROM mail_outbox WHERE id = ?').get(id);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(JSON.parse(row.payload).subject).toBe('hi');
  });

  it('draine et marque « sent » au succès', async () => {
    sendMailMock.mockResolvedValue({ messageId: '<abc@test>' });
    enqueueMail(accountId, userId, { to: 'x@y.z', text: 'yo' });
    const n = await runOutboxTick();
    expect(n).toBe(1);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const row = db.prepare("SELECT * FROM mail_outbox WHERE user_id = ? AND status = 'sent'").get(userId);
    expect(row).toBeTruthy();
    expect(row.attempts).toBe(1);
  });

  it('retente avec back-off puis échoue après le nombre max de tentatives', async () => {
    sendMailMock.mockRejectedValue(new Error('SMTP down'));
    const id = enqueueMail(accountId, userId, { to: 'x@y.z', text: 'yo' });

    // 1er tick : échec → reste « pending », prochaine tentative planifiée dans le futur.
    await runOutboxTick();
    let row = db.prepare('SELECT * FROM mail_outbox WHERE id = ?').get(id);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.next_attempt).toBeTruthy();

    // On force l'échéance et on épuise les tentatives.
    for (let i = 0; i < 5; i++) {
      db.prepare('UPDATE mail_outbox SET next_attempt = NULL WHERE id = ?').run(id);
      await runOutboxTick();
    }
    row = db.prepare('SELECT * FROM mail_outbox WHERE id = ?').get(id);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBeGreaterThanOrEqual(5);
    expect(row.last_error).toContain('SMTP down');
  });

  it('marque « failed » si le compte a disparu (branche défensive)', async () => {
    // En prod, supprimer le compte casse en cascade ses lignes outbox (FK ON) ; on
    // désactive brièvement la FK pour fabriquer une ligne orpheline et vérifier que
    // le worker la classe « failed » au lieu de boucler.
    db.exec('PRAGMA foreign_keys = OFF');
    const id = enqueueMail(999999, userId, { to: 'x@y.z', text: 'yo' }); // account_id inexistant
    db.exec('PRAGMA foreign_keys = ON');
    await runOutboxTick();
    const row = db.prepare('SELECT * FROM mail_outbox WHERE id = ?').get(id);
    expect(row.status).toBe('failed');
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});
