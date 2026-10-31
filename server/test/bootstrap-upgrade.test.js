import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { db } from '../src/db.js';

describe('Migration du bootstrap', () => {
  it('conserve un admin existant sans rouvrir son installation', async () => {
    db.prepare("UPDATE users SET is_admin = 1 WHERE email = 'lea@comet.mail'").run();
    const { app } = await import('../src/server.js');
    expect((await request(app).get('/api/auth/options')).body.bootstrapRequired).toBe(false);
    expect(db.prepare("SELECT is_admin FROM users WHERE email = 'lea@comet.mail'").get().is_admin).toBe(1);
    expect(db.prepare("SELECT v FROM settings WHERE k = 'bootstrap_complete'").get().v).toBe('1');
  }, 30_000); // charge tout le serveur dans le test : un runner chargé dépasse les 5 s par défaut
});
