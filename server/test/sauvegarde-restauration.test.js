// Sauvegarde et restauration (audit C-28), de bout en bout dans des dossiers temporaires :
// base en mode WAL encore ouverte (écritures pas encore reportées dans le fichier),
// pièces jointes, sauvegarde altérée refusée, données existantes protégées.
import { describe, it, expect, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sauvegarder } from '../../scripts/sauvegarde.mjs';
import { restaurer, verifierSauvegarde } from '../../scripts/restauration.mjs';

const dossiers = [];
const neuf = (n) => { const d = mkdtempSync(join(tmpdir(), `comet-${n}-`)); dossiers.push(d); return d; };
afterAll(() => { for (const d of dossiers) try { rmSync(d, { recursive: true, force: true }); } catch { /* fichier encore ouvert */ } });
const PORT_LIBRE = 1; // aucun serveur n'écoute sur le port 1

function instance() {
  const racine = neuf('instance');
  const env = { COMET_DATA_DIR: join(racine, 'data'), COMET_ATTACHMENTS_DIR: join(racine, 'pj-chiffrees'), COMET_PJ_DIR: join(racine, 'pj-externes') };
  mkdirSync(env.COMET_DATA_DIR, { recursive: true });
  return { racine, env, base: join(env.COMET_DATA_DIR, 'comet.db') };
}

describe('sauvegarde et restauration', () => {
  it('sauvegarde une base ouverte en WAL et les pièces jointes, puis restaure à l’identique', async () => {
    const src = instance();
    const db = new DatabaseSync(src.base);
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT); CREATE TABLE messages (id INTEGER PRIMARY KEY, sujet TEXT);");
    db.exec("PRAGMA wal_autocheckpoint = 0;"); // les écritures restent dans le journal WAL
    for (let i = 0; i < 50; i++) db.prepare('INSERT INTO users (email) VALUES (?)').run(`u${i}@comet.mail`);
    db.prepare('INSERT INTO messages (sujet) VALUES (?)').run('Chiffré');
    expect(existsSync(`${src.base}-wal`)).toBe(true);
    mkdirSync(src.env.COMET_ATTACHMENTS_DIR, { recursive: true });
    writeFileSync(join(src.env.COMET_ATTACHMENTS_DIR, 'abc.bin'), Buffer.from([1, 2, 3, 250]));
    mkdirSync(join(src.env.COMET_PJ_DIR, '7'), { recursive: true });
    writeFileSync(join(src.env.COMET_PJ_DIR, '7', 'facture.pdf'), 'pdf');

    const sauvegarde = join(neuf('sauvegarde'), 'lot');
    const m = sauvegarder({ destination: sauvegarde, env: src.env });   // base toujours ouverte
    db.close();
    expect(m.fichiers.map((f) => f.chemin).sort()).toEqual(['comet.db', 'pieces-externes/7/facture.pdf', 'pieces-jointes/abc.bin']);
    expect(verifierSauvegarde(sauvegarde).fichiers).toHaveLength(3);

    const dst = instance();
    await restaurer({ source: sauvegarde, port: PORT_LIBRE, env: dst.env });
    const lue = new DatabaseSync(dst.base, { readOnly: true });
    expect(lue.prepare('SELECT COUNT(*) AS n FROM users').get().n).toBe(50);
    expect(lue.prepare('SELECT sujet FROM messages').get().sujet).toBe('Chiffré');
    lue.close();
    expect([...readFileSync(join(dst.env.COMET_ATTACHMENTS_DIR, 'abc.bin'))]).toEqual([1, 2, 3, 250]);
    expect(readFileSync(join(dst.env.COMET_PJ_DIR, '7', 'facture.pdf'), 'utf8')).toBe('pdf');
  });

  it('une sauvegarde altérée d’un seul octet, ou incomplète, est refusée avant toute écriture', async () => {
    const src = instance();
    const db = new DatabaseSync(src.base); db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1);'); db.close();
    mkdirSync(src.env.COMET_ATTACHMENTS_DIR, { recursive: true });
    writeFileSync(join(src.env.COMET_ATTACHMENTS_DIR, 'a.bin'), 'contenu');
    const s = join(neuf('alteree'), 'lot');
    sauvegarder({ destination: s, env: src.env });

    const piece = join(s, 'pieces-jointes', 'a.bin');
    const octets = readFileSync(piece); octets[0] ^= 1; writeFileSync(piece, octets);
    const dst = instance();
    await expect(restaurer({ source: s, port: PORT_LIBRE, env: dst.env })).rejects.toThrow(/altéré/);
    expect(existsSync(dst.base)).toBe(false);                       // rien n'a été écrit

    rmSync(piece);
    await expect(restaurer({ source: s, port: PORT_LIBRE, env: dst.env })).rejects.toThrow(/manquant/);
  });

  it('refuse d’écraser des données existantes sans --remplacer ; les écrase avec', async () => {
    const src = instance();
    const db = new DatabaseSync(src.base); db.exec("CREATE TABLE t (x); INSERT INTO t VALUES ('sauvegardé');"); db.close();
    const s = join(neuf('remplacer'), 'lot');
    sauvegarder({ destination: s, env: src.env });

    const dst = instance();
    const ancienne = new DatabaseSync(dst.base); ancienne.exec("CREATE TABLE t (x); INSERT INTO t VALUES ('en place');"); ancienne.close();
    appendFileSync(`${dst.base}-wal`, 'journal de l’ancienne base');
    await expect(restaurer({ source: s, port: PORT_LIBRE, env: dst.env })).rejects.toThrow(/--remplacer/);
    await restaurer({ source: s, port: PORT_LIBRE, env: dst.env, remplacer: true });
    expect(existsSync(`${dst.base}-wal`)).toBe(false);              // le journal de l'ancienne base est parti
    const lue = new DatabaseSync(dst.base, { readOnly: true });
    expect(lue.prepare('SELECT x FROM t').get().x).toBe('sauvegardé');
    lue.close();
  });

  it('refuse un dossier de sauvegarde déjà rempli, et un manifeste qui sort du dossier', async () => {
    const src = instance();
    const db = new DatabaseSync(src.base); db.exec('CREATE TABLE t (x);'); db.close();
    const plein = neuf('plein'); writeFileSync(join(plein, 'autre.txt'), 'x');
    expect(() => sauvegarder({ destination: plein, env: src.env })).toThrow(/pas vide/);

    const s = join(neuf('chemin'), 'lot');
    sauvegarder({ destination: s, env: src.env });
    const m = JSON.parse(readFileSync(join(s, 'manifeste.json'), 'utf8'));
    m.fichiers.push({ chemin: '../../etc/passwd', taille: 1, sha256: 'x' });
    writeFileSync(join(s, 'manifeste.json'), JSON.stringify(m));
    expect(() => verifierSauvegarde(s)).toThrow(/refusé/);
  });
});
