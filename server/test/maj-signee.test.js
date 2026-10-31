// Mises à jour signées de l'application de bureau (desktop/maj-signee.cjs) et
// script de signature (scripts/signer-mises-a-jour.mjs). Clés générées pour le test.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { signer, verifierMiseAJour, comparerVersions, empreinteFichier, messageSigne } = require('../../desktop/maj-signee.cjs');
const RACINE = path.resolve(__dirname, '..', '..');

const paire = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ type: 'spki', format: 'pem' }), priv: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
};
const NOTRE = paire();
const AUTRE = paire();
const SHA = crypto.createHash('sha512').update('installateur authentique').digest('base64');
const base = { clePubliquePem: NOTRE.pub, version: '1.0.3', versionActuelle: '1.0.2', plateforme: 'win32', sha512: SHA };
const signe = (o = {}) => signer({ clePriveePem: NOTRE.priv, version: '1.0.3', plateforme: 'win32', sha512: SHA, ...o });

describe('vérification d’une mise à jour', () => {
  it('accepte une mise à jour signée par notre clé', () => {
    expect(verifierMiseAJour({ ...base, signature: signe() })).toEqual({ ok: true });
  });

  it('refuse une mise à jour non signée ou sans clé embarquée', () => {
    expect(verifierMiseAJour({ ...base, signature: undefined }).ok).toBe(false);
    expect(verifierMiseAJour({ ...base, signature: '' }).ok).toBe(false);
    expect(verifierMiseAJour({ ...base, signature: signe(), clePubliquePem: '' }).raison).toMatch(/aucune clé/);
  });

  it('refuse un autre fichier, une autre clé, une signature abîmée', () => {
    const autreSha = crypto.createHash('sha512').update('installateur piégé').digest('base64');
    expect(verifierMiseAJour({ ...base, sha512: autreSha, signature: signe() }).raison).toBe('signature invalide');
    expect(verifierMiseAJour({ ...base, signature: signer({ clePriveePem: AUTRE.priv, version: '1.0.3', plateforme: 'win32', sha512: SHA }) }).raison).toBe('signature invalide');
    expect(verifierMiseAJour({ ...base, signature: 'pas-du-base64!!' }).ok).toBe(false);
    const abimee = Buffer.from(signe(), 'base64'); abimee[0] ^= 1;
    expect(verifierMiseAJour({ ...base, signature: abimee.toString('base64') }).ok).toBe(false);
  });

  it('lie la signature à la version et à la plateforme', () => {
    // Un serveur qui annonce 9.9.9 en resservant l'installateur signé pour 1.0.3
    expect(verifierMiseAJour({ ...base, version: '9.9.9', signature: signe() }).raison).toBe('signature invalide');
    // L'installateur Linux authentique servi à Windows
    expect(verifierMiseAJour({ ...base, signature: signe({ plateforme: 'linux' }) }).raison).toBe('signature invalide');
  });

  it('refuse un retour à une version égale ou antérieure, même authentique', () => {
    const ancienne = signer({ clePriveePem: NOTRE.priv, version: '1.0.1', plateforme: 'win32', sha512: SHA });
    expect(verifierMiseAJour({ ...base, version: '1.0.1', signature: ancienne }).raison).toMatch(/non postérieure/);
    expect(verifierMiseAJour({ ...base, versionActuelle: '1.0.3', signature: signe() }).raison).toMatch(/non postérieure/);
  });

  it('compare les versions', () => {
    expect(comparerVersions('1.0.10', '1.0.9')).toBeGreaterThan(0);
    expect(comparerVersions('1.1.0', '1.0.99')).toBeGreaterThan(0);
    expect(comparerVersions('2.0.0', '10.0.0')).toBeLessThan(0);
    expect(comparerVersions('v1.0.3', '1.0.3')).toBe(0);
    expect(comparerVersions('1.0.3', '1.0.3-beta.1')).toBeGreaterThan(0);
    expect(comparerVersions('1.0.3-beta.2', '1.0.3-beta.1')).toBeGreaterThan(0);
  });

  it('le message signé porte un en-tête de domaine', () => {
    expect(messageSigne({ version: '1', plateforme: 'win32', sha512: 'x' }).toString()).toMatch(/^comet-mise-a-jour-v1\n/);
  });
});

describe('script de signature', () => {
  let dossier; let clePriv; let clePub;
  beforeAll(() => {
    dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'comet-signature-'));
    clePriv = path.join(dossier, 'cle.pem'); clePub = path.join(dossier, 'cle.pub.pem');
    fs.writeFileSync(clePriv, NOTRE.priv); fs.writeFileSync(clePub, NOTRE.pub);
  });
  afterAll(() => { try { fs.rmSync(dossier, { recursive: true, force: true }); } catch {} });

  const lancer = (...args) => spawnSync(process.execPath, [path.join(RACINE, 'scripts', 'signer-mises-a-jour.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, COMET_UPDATE_SIGNING_KEY: '' } });

  it('signe latest.yml ; la signature se vérifie sur le fichier', async () => {
    const exe = path.join(dossier, 'Comet-Setup-1.0.3.exe');
    fs.writeFileSync(exe, crypto.randomBytes(4096));
    const sha = await empreinteFichier(exe);
    fs.writeFileSync(path.join(dossier, 'latest.yml'), `version: 1.0.3\nfiles:\n  - url: Comet-Setup-1.0.3.exe\n    sha512: ${sha}\n    size: 4096\npath: Comet-Setup-1.0.3.exe\nsha512: ${sha}\nreleaseDate: '2026-10-31T09:00:00.000Z'\n`);
    const r = lancer(dossier, '--cle', clePriv, '--cle-publique', clePub);
    expect(r.status, r.stderr).toBe(0);
    const yml = fs.readFileSync(path.join(dossier, 'latest.yml'), 'utf8');
    const signature = yml.match(/^cometSignature: (.+)$/m)[1];
    expect(verifierMiseAJour({ ...base, sha512: sha, signature })).toEqual({ ok: true });
    // Resigner remplace la ligne au lieu d'en ajouter une seconde
    expect(lancer(dossier, '--cle', clePriv, '--cle-publique', clePub).status).toBe(0);
    expect(fs.readFileSync(path.join(dossier, 'latest.yml'), 'utf8').match(/cometSignature/g)).toHaveLength(1);
  });

  it('refuse sans clé, avec une clé qui ne correspond pas à l’app, ou une empreinte fausse', () => {
    expect(lancer(dossier, '--cle-publique', clePub).status).toBe(1);
    const autre = path.join(dossier, 'autre.pem'); fs.writeFileSync(autre, AUTRE.priv);
    const r = lancer(dossier, '--cle', autre, '--cle-publique', clePub);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ne correspond pas/);
    fs.writeFileSync(path.join(dossier, 'Comet-Setup-1.0.3.exe'), 'remplacé après coup');
    expect(lancer(dossier, '--cle', clePriv, '--cle-publique', clePub).stderr).toMatch(/empreinte annoncée/);
  });
});
