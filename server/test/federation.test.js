// Fédération entre serveurs Comet — DEUX vrais serveurs jetables (deux processus, deux
// ports, deux bases temporaires), plus un faux serveur « C » tenu par le test lui-même
// pour forger ce qu'un serveur honnête n'enverrait jamais : signature falsifiée, rejeu,
// usurpation, date périmée, changement de clé.
//
// Le chiffrement est celui du CLIENT (client/src/crypto.js), exécuté ici en Node : le test
// prouve donc qu'un message chiffré par Camille sur A est lisible par Dominique sur B, et
// que ni A ni B n'en ont vu le contenu.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import http from 'node:http';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { rmSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import request from 'supertest';

import * as cc from '../../client/src/crypto.js';
import { app } from '../src/server.js';
import { chaineCanonique, digestDe, nouveauNonce, signer, texteRotation, empreinte } from '../src/federation/signature.js';
import { appeler, estAdressePrivee } from '../src/federation/reseau.js';

const ICI = dirname(fileURLToPath(import.meta.url));
const SERVEUR = join(ICI, '..', 'src', 'server.js');
const MDP = 'Fédération-très-solide-2026!';

const portLibre = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.unref();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
async function jusqua(fn, { delai = 10_000, pas = 100 } = {}) {
  const fin = Date.now() + delai;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > fin) throw new Error('délai dépassé');
    await attendre(pas);
  }
}

// ── Faux serveur C (le test signe en son nom) ───────────────────────────────
function paireEd() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), priv: privateKey };
}
const C = { domaine: 'serveur-c.test', cle: paireEd(), rotation: null, port: 0, srv: null };

function demarrerC() {
  return new Promise((resolve) => {
    C.srv = http.createServer((req, res) => {
      if (req.url === '/.well-known/comet') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ comet: 1, domaine: C.domaine, cle: C.cle.pub, api: `http://127.0.0.1:${C.port}/api/federation/v1`, rotation: C.rotation }));
      }
      res.statusCode = 404; res.end('{}');
    });
    C.srv.listen(C.port, '127.0.0.1', resolve);
  });
}

// ── Les deux vrais serveurs ─────────────────────────────────────────────────
const S = {
  a: { domaine: 'serveur-a.test', secret: 'secret-serveur-A-pour-les-tests-0123456789' },
  b: { domaine: 'serveur-b.test', secret: 'secret-serveur-B-pour-les-tests-9876543210' },
};
const dossier = mkdtempSync(join(tmpdir(), 'comet-federation-'));

function lancer(s, hotes) {
  const env = { ...process.env };
  delete env.COMET_SEED_DEMO;
  Object.assign(env, {
    NODE_ENV: 'test',
    PORT: String(s.port),
    HOST: '127.0.0.1',
    JWT_SECRET: s.secret,
    COMET_DB_PATH: s.db,
    COMET_INSCRIPTION: 'ouverte',
    COMET_DOMAINE: s.domaine,
    COMET_FEDERATION: 'ouverte',
    COMET_FEDERATION_HOTES: hotes,
    COMET_FEDERATION_DEBIT: '40',
  });
  s.proc = spawn(process.execPath, [SERVEUR], { cwd: join(ICI, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  s.journal = '';
  s.proc.stdout.on('data', (d) => { s.journal += d; });
  s.proc.stderr.on('data', (d) => { s.journal += d; });
  s.url = `http://127.0.0.1:${s.port}`;
  return jusqua(async () => { try { return (await fetch(`${s.url}/api/health`)).ok; } catch { return false; } }, { delai: 30_000 });
}

async function api(s, methode, chemin, jeton, corps) {
  const r = await fetch(`${s.url}/api${chemin}`, {
    method: methode,
    headers: { 'content-type': 'application/json', ...(jeton ? { authorization: `Bearer ${jeton}` } : {}) },
    body: corps === undefined ? undefined : JSON.stringify(corps),
  });
  const texte = await r.text();
  let json = null; try { json = JSON.parse(texte); } catch { /* */ }
  return { statut: r.status, json, texte };
}

// Un compte créé exactement comme le fait l'interface : paire RSA générée côté client,
// clé privée enveloppée par le mot de passe.
async function inscrire(s, local, nom) {
  const kp = await cc.generateKeyPair();
  const publicKey = await cc.exportPublicKey(kp);
  const encPrivateKey = await cc.wrapPrivateKey(kp, MDP);
  const r = await api(s, 'POST', '/auth/register', null, { email: `${local}@comet.mail`, displayName: nom, password: MDP, publicKey, encPrivateKey });
  expect(r.statut, r.texte).toBe(201);
  return { jeton: r.json.token, email: `${local}@comet.mail`, publicKey, privee: kp.privateKey };
}

// Envoi chiffré, comme Compose : résolution, vérification de l'attestation, chiffrement.
async function envoyer(s, moi, a, sujet, corps, inReplyTo = null) {
  const res = await api(s, 'GET', `/users/recipients?emails=${encodeURIComponent(a)}`, moi.jeton);
  expect(res.statut, res.texte).toBe(200);
  expect(res.json.federationErrors, JSON.stringify(res.json)).toEqual([]);
  const dest = res.json.recipients.find((r) => r.email === a);
  expect(dest, JSON.stringify(res.json)).toBeTruthy();
  expect(dest.federe).toBeTruthy();
  expect(await cc.verifierEnregistrementCle(dest.federe.enregistrement, dest.federe.serveur.cle)).toBe(true);
  const enc = await cc.encryptMessage({ subject: sujet, body: corps, attachments: [] }, { [moi.email]: moi.publicKey, [a]: dest.publicKey });
  const r = await api(s, 'POST', '/mail', moi.jeton, { encrypted: true, to: [a], cc: [], ciphertext: enc.ciphertext, iv: enc.iv, keys: enc.keys, inReplyTo });
  expect(r.statut, r.texte).toBe(201);
  return { ...r.json, dest };
}

async function boite(s, moi) {
  const r = await api(s, 'GET', '/mail?folder=inbox', moi.jeton);
  return r.json.items;
}

// ── Requêtes forgées au nom de C ────────────────────────────────────────────
function signee(objet, { cle = C.cle, emetteur = C.domaine, hote = S.b.domaine, chemin = '/v1/livraison', date = new Date().toISOString(), nonce = nouveauNonce(), corpsBrut = null } = {}) {
  const corps = corpsBrut ?? Buffer.from(JSON.stringify(objet));
  const digest = digestDe(corps);
  const signature = signer(cle.priv, chaineCanonique({ methode: 'POST', hote, chemin, emetteur, date, nonce, digest }));
  return {
    corps,
    entetes: { 'content-type': 'application/json', 'comet-emetteur': emetteur, 'comet-date': date, 'comet-nonce': nonce, 'content-digest': digest, 'comet-signature': signature },
  };
}
const poster = (s, chemin, req) => fetch(`${s.url}/api/federation/v1${chemin}`, { method: 'POST', headers: req.entetes, body: req.corps })
  .then(async (r) => ({ statut: r.status, json: await r.json().catch(() => null) }));

const livraisonDeC = (pour = 'dominique@serveur-b.test', de = 'eve@serveur-c.test') => ({
  v: 1, id: `comet:${randomUUID()}@${C.domaine}`, enReponseA: null,
  de: { adresse: de, nom: 'Ève', cle: 'Y2xlLWZpY3RpdmUtZGUtdGVzdA==' },
  a: [pour], cc: [], envoyeLe: new Date().toISOString(),
  chiffre: { ciphertext: 'Y2hpZmZyZQ==', iv: 'aXYtZGUtdGVzdA==' },
  cles: { [pour]: 'Y2xlLWVudmVsb3BwZWU=' },
});

let camille, dominique;

beforeAll(async () => {
  [S.a.port, S.b.port, C.port] = await Promise.all([portLibre(), portLibre(), portLibre()]);
  S.a.db = join(dossier, 'a.db');
  S.b.db = join(dossier, 'b.db');
  await demarrerC();
  await Promise.all([
    lancer(S.a, `${S.b.domaine}=http://127.0.0.1:${S.b.port}`),
    lancer(S.b, `${S.a.domaine}=http://127.0.0.1:${S.a.port},${C.domaine}=http://127.0.0.1:${C.port}`),
  ]);
  camille = await inscrire(S.a, 'camille', 'Camille');
  dominique = await inscrire(S.b, 'dominique', 'Dominique');
}, 60_000);

afterAll(async () => {
  for (const s of [S.a, S.b]) {
    if (s.proc && s.proc.exitCode === null) {
      const fini = new Promise((r) => s.proc.once('exit', r));
      s.proc.kill();
      await Promise.race([fini, attendre(5000)]);
    }
  }
  await new Promise((r) => (C.srv ? C.srv.close(r) : r()));
  try { rmSync(dossier, { recursive: true, force: true }); } catch { /* fichiers encore ouverts : le dossier temporaire sera nettoyé par le système */ }
});

describe('fédération — désactivée par défaut', () => {
  it('sans COMET_DOMAINE, rien n\'est publié ni accepté', async () => {
    expect((await request(app).get('/.well-known/comet')).status).toBe(404);
    expect((await request(app).post('/api/federation/v1/livraison').send({})).status).toBe(404);
  });
});

describe('fédération — deux serveurs', () => {
  it('chaque serveur publie son identité', async () => {
    const r = await fetch(`${S.a.url}/.well-known/comet`).then((x) => x.json());
    expect(r.comet).toBe(1);
    expect(r.domaine).toBe(S.a.domaine);
    expect(r.api).toBe(`${S.a.url}/api/federation/v1`);
    expect(r.empreinte).toBe(empreinte(r.cle));
    const etat = await api(S.a, 'GET', '/federation/etat', camille.jeton);
    expect(etat.json).toMatchObject({ active: true, domaine: S.a.domaine, adresse: 'camille@serveur-a.test', empreinteServeur: r.empreinte });
  });

  it('Camille (A) écrit à Dominique (B) : chiffré, lisible par Dominique seulement', async () => {
    await envoyer(S.a, camille, 'dominique@serveur-b.test', 'Bonjour de A', 'Message secret de Camille');
    const deCamille = (l) => l.find((x) => x.from?.email === 'camille@serveur-a.test');
    const m = await jusqua(async () => deCamille(await boite(S.b, dominique)));
    expect(m.isEncrypted).toBe(true);
    expect(m.subject).toBeNull();                       // le serveur B n'a pas le texte
    expect(m.from.email).toBe('camille@serveur-a.test');
    expect(m.from.federe.domaine).toBe(S.a.domaine);
    const clair = await cc.decryptMessage(m.ciphertext, m.iv, m.encKey, dominique.privee);
    expect(clair).toMatchObject({ subject: 'Bonjour de A', body: 'Message secret de Camille' });

    // Ni A ni B n'ont le texte en base.
    for (const s of [S.a, S.b]) {
      const base = new DatabaseSync(s.db, { readOnly: true });
      const fuite = base.prepare("SELECT COUNT(*) AS n FROM messages WHERE subject LIKE '%Bonjour de A%' OR body LIKE '%secret de Camille%' OR ciphertext LIKE '%secret%'").get().n;
      base.close();
      expect(fuite).toBe(0);
    }
  });

  it('Dominique (B) répond à Camille (A) : même fil des deux côtés', async () => {
    const recu = (await boite(S.b, dominique)).find((x) => x.from?.email === 'camille@serveur-a.test');
    await envoyer(S.b, dominique, 'camille@serveur-a.test', 'RE: Bonjour de A', 'Réponse de Dominique', recu.messageId);
    const items = await jusqua(async () => { const l = await boite(S.a, camille); return l.find((x) => x.from.email === 'dominique@serveur-b.test') && l; });
    const rep = items.find((x) => x.from.email === 'dominique@serveur-b.test');
    const clair = await cc.decryptMessage(rep.ciphertext, rep.iv, rep.encKey, camille.privee);
    expect(clair.body).toBe('Réponse de Dominique');
    const detail = await api(S.a, 'GET', `/mail/${rep.itemId}`, camille.jeton);
    // Le fil vu par Camille contient son message d'origine ET la réponse venue de B.
    expect(detail.json.item.thread.length).toBe(2);
    const base = new DatabaseSync(S.a.db, { readOnly: true });
    const fils = base.prepare('SELECT COUNT(DISTINCT thread_id) AS n FROM messages WHERE is_encrypted = 1').get().n;
    base.close();
    expect(fils).toBe(1);
  });

  it('les deux correspondants calculent le même numéro de sécurité', async () => {
    const vuParCamille = await cc.numeroDeSecurite('camille@serveur-a.test', camille.publicKey, 'dominique@serveur-b.test', dominique.publicKey);
    const vuParDominique = await cc.numeroDeSecurite('dominique@serveur-b.test', dominique.publicKey, 'camille@serveur-a.test', camille.publicKey);
    expect(vuParCamille).toMatch(/^(\d{5} ){11}\d{5}$/);
    expect(vuParCamille).toBe(vuParDominique);
  });

  it('un compte distant ne peut pas se connecter', async () => {
    const r = await api(S.b, 'POST', '/auth/login', null, { email: 'camille@serveur-a.test', password: '!' });
    expect(r.statut).toBe(401);
  });

  it('une adresse inexistante chez B reste « inconnue » (rien n\'est mis en file)', async () => {
    const r = await api(S.a, 'GET', `/users/recipients?emails=${encodeURIComponent('personne@serveur-b.test')}`, camille.jeton);
    expect(r.json.unknown).toContain('personne@serveur-b.test');
    expect(r.json.recipients).toEqual([]);
  });

  it('le courrier vers un autre serveur est forcément chiffré', async () => {
    const r = await api(S.a, 'POST', '/mail', camille.jeton, { to: ['dominique@serveur-b.test'], subject: 'en clair', body: 'non' });
    expect(r.statut).toBe(400);
    expect(r.json.code).toBe('non_chiffre');
  });
});

describe('fédération — requêtes forgées (faux serveur C)', () => {
  it('une livraison correctement signée par C est acceptée (premier contact : TOFU)', async () => {
    const r = await poster(S.b, '/livraison', signee(livraisonDeC()));
    expect(r.statut, JSON.stringify(r.json)).toBe(200);
    expect(r.json.acceptes).toEqual(['dominique@serveur-b.test']);
  });

  it('demander les clés sans signature est refusé (pas d\'énumération des comptes)', async () => {
    const r = await fetch(`${S.b.url}/api/federation/v1/cles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ adresses: ['dominique@serveur-b.test'] }) });
    expect(r.status).toBe(401);
    expect((await r.json()).code).toBe('non_signee');
  });

  it('signature falsifiée → 401', async () => {
    const req = signee(livraisonDeC(), { cle: paireEd() }); // signée par une AUTRE clé
    const r = await poster(S.b, '/livraison', req);
    expect(r.statut).toBe(401);
    expect(r.json.code).toBe('signature');
  });

  it('corps modifié après signature → 401', async () => {
    const req = signee(livraisonDeC());
    const altere = JSON.parse(req.corps.toString()); altere.a = ['autre@serveur-b.test'];
    const r = await poster(S.b, '/livraison', { ...req, corps: Buffer.from(JSON.stringify(altere)) });
    expect(r.statut).toBe(401);
    expect(r.json.code).toBe('digest');
  });

  it('rejeu de la même requête → refusé', async () => {
    const req = signee(livraisonDeC());
    expect((await poster(S.b, '/livraison', req)).statut).toBe(200);
    const deux = await poster(S.b, '/livraison', req);
    expect(deux.statut).toBe(409);
    expect(deux.json.code).toBe('rejeu');
  });

  it('date périmée → 401', async () => {
    const req = signee(livraisonDeC(), { date: new Date(Date.now() - 11 * 60_000).toISOString() });
    const r = await poster(S.b, '/livraison', req);
    expect(r.statut).toBe(401);
    expect(r.json.code).toBe('date');
  });

  it('requête signée pour un AUTRE serveur, rejouée chez B → 401', async () => {
    const req = signee(livraisonDeC(), { hote: S.a.domaine });
    const r = await poster(S.b, '/livraison', req);
    expect(r.statut).toBe(401);
    expect(r.json.code).toBe('signature');
  });

  it('C ne peut pas parler au nom d\'un compte de A (usurpation) → 403', async () => {
    const r = await poster(S.b, '/livraison', signee(livraisonDeC('dominique@serveur-b.test', 'camille@serveur-a.test')));
    expect(r.statut).toBe(403);
    expect(r.json.code).toBe('usurpation');
  });

  it('taille maximale : un corps de plus de 1 Mio est refusé', async () => {
    const gros = livraisonDeC(); gros.chiffre.ciphertext = 'A'.repeat(1100 * 1024);
    expect((await poster(S.b, '/livraison', signee(gros))).statut).toBe(413);
  });

  it('serveur bloqué par l\'admin → 403, puis débloqué → accepté', async () => {
    // Dominique est le premier compte de B : administrateur.
    expect((await api(S.b, 'POST', `/federation/serveurs/${C.domaine}/bloquer`, dominique.jeton)).statut).toBe(200);
    expect((await poster(S.b, '/livraison', signee(livraisonDeC()))).statut).toBe(403);
    expect((await api(S.b, 'POST', `/federation/serveurs/${C.domaine}/debloquer`, dominique.jeton)).statut).toBe(200);
    expect((await poster(S.b, '/livraison', signee(livraisonDeC()))).statut).toBe(200);
  });

  it('clé de C changée SANS rotation signée → gelé jusqu\'à l\'admin', async () => {
    const ancienne = C.cle;
    C.cle = paireEd(); C.rotation = null;
    const r = await poster(S.b, '/livraison', signee(livraisonDeC()));
    expect(r.statut).toBe(403);
    expect(r.json.code).toBe('cle_changee');
    // Même l'ancienne clé ne passe plus : le serveur est gelé.
    expect((await poster(S.b, '/livraison', signee(livraisonDeC(), { cle: ancienne }))).statut).toBe(403);

    const liste = await api(S.b, 'GET', '/federation/serveurs', dominique.jeton);
    const c = liste.json.serveurs.find((x) => x.domaine === C.domaine);
    expect(c.etat).toBe('cle_changee');
    expect(c.empreinteProposee).toBe(empreinte(C.cle.pub));
    // Mauvaise empreinte recopiée : refus.
    expect((await api(S.b, 'POST', `/federation/serveurs/${C.domaine}/accepter-cle`, dominique.jeton, { empreinte: empreinte(ancienne.pub) })).statut).toBe(409);
    expect((await api(S.b, 'POST', `/federation/serveurs/${C.domaine}/accepter-cle`, dominique.jeton, { empreinte: c.empreinteProposee })).statut).toBe(200);
    expect((await poster(S.b, '/livraison', signee(livraisonDeC()))).statut).toBe(200);
  });

  it('rotation signée par l\'ancienne clé → acceptée sans intervention', async () => {
    const ancienne = C.cle;
    const nouvelle = paireEd();
    const date = new Date().toISOString();
    C.rotation = { ancienne: ancienne.pub, date, signature: signer(ancienne.priv, texteRotation({ domaine: C.domaine, nouvelle: nouvelle.pub, date })) };
    C.cle = nouvelle;
    expect((await poster(S.b, '/livraison', signee(livraisonDeC()))).statut).toBe(200);
    // Une rotation signée par une clé quelconque ne vaut rien.
    const intrus = paireEd(); const autre = paireEd();
    C.rotation = { ancienne: intrus.pub, date, signature: signer(intrus.priv, texteRotation({ domaine: C.domaine, nouvelle: autre.pub, date })) };
    C.cle = autre;
    expect((await poster(S.b, '/livraison', signee(livraisonDeC()))).statut).toBe(403);
  });

  it('limite de débit par serveur distant → 429', async () => {
    // B admet 40 livraisons/min par serveur (COMET_FEDERATION_DEBIT). C, gelé au test
    // précédent, est rétabli par l'admin avec sa clé actuelle.
    const liste = await api(S.b, 'GET', '/federation/serveurs', dominique.jeton);
    const c = liste.json.serveurs.find((x) => x.domaine === C.domaine);
    await api(S.b, 'POST', `/federation/serveurs/${C.domaine}/accepter-cle`, dominique.jeton, { empreinte: c.empreinteProposee });
    let statut = 0;
    for (let i = 0; i < 45 && statut !== 429; i++) statut = (await poster(S.b, '/livraison', signee(livraisonDeC()))).statut;
    expect(statut).toBe(429);
  });
});

describe('fédération — garde-fous réseau', () => {
  it('reconnaît les adresses privées et locales', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.10', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) expect(estAdressePrivee(ip), ip).toBe(true);
    for (const ip of ['93.184.216.34', '1.1.1.1', '2606:4700::1111']) expect(estAdressePrivee(ip), ip).toBe(false);
  });

  it('http refusé hors réseau local', async () => {
    await expect(appeler('http://93.184.216.34/.well-known/comet', { autoriserPrive: true })).rejects.toThrow(/http refusé/);
  });

  it('adresse privée refusée par découverte (anti-SSRF), sauf hôte déclaré', async () => {
    await expect(appeler('https://127.0.0.1/.well-known/comet')).rejects.toThrow(/privée ou locale/);
    await expect(appeler('http://10.0.0.1/.well-known/comet')).rejects.toThrow(/privée ou locale/);
  });

  it('une redirection n\'est jamais suivie', async () => {
    const srv = http.createServer((req, res) => { res.statusCode = 302; res.setHeader('location', 'http://169.254.169.254/'); res.end(); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      await expect(appeler(`http://127.0.0.1:${srv.address().port}/.well-known/comet`, { autoriserPrive: true })).rejects.toThrow(/redirection/);
    } finally { await new Promise((r) => srv.close(r)); }
  });
});
