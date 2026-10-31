// Recherche de secrets (audit C-28). Les faux secrets sont fabriqués à l'exécution : écrits
// en toutes lettres, ils feraient signaler ce fichier par le script lui-même.
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chercherSecrets, verifierDepot } from '../../scripts/verifier-secrets.mjs';

const r = (n, c = 'A') => c.repeat(n);
const FAUX = {
  'jeton GitHub': `gh${'p'}_${r(36, 'a1')}`.slice(0, 40),
  'jeton GitHub (fine-grained)': `github_${'pat'}_${r(70, 'b')}`,
  'clé privée PEM': `-----BEGIN ${'PRIVATE'} KEY-----`,
  'secret client Google': `GOC${'SPX'}-${r(28, 'c')}`,
  'clé d’accès AWS': `AK${'IA'}${r(16, 'Q')}`,
  'jeton Slack': `xo${'xb'}-${r(20, '1')}`,
  'clé d’API OpenAI ou Anthropic': `s${'k'}-${r(40, 'd')}`,
  'clé de connecteur Comet': `cm${'tk'}_${r(32, 'e')}`,
};

describe('chercherSecrets', () => {
  it('reconnaît chaque type de secret, et masque la valeur', () => {
    for (const [nom, secret] of Object.entries(FAUX)) {
      const t = chercherSecrets(`const x = "${secret}";`, 'src/a.js');
      expect(t.map((x) => x.nom), nom).toContain(nom);
      for (const x of t) expect(x.extrait).not.toContain(secret);
    }
  });

  it('dans un .env suivi : une vraie valeur est signalée, un exemple ou un vide non', () => {
    const env = ['JWT_SECRET=', 'GITHUB_TOKEN=votre-jeton', 'SMTP_PASS=<mot de passe>', 'COMET_MAIL_SECRET=CHANGEZ-MOI-long',
      'API_KEY=changeme', `COMET_TURN_PASS=${r(24, 'z')}`, 'PORT=4800'].join('\n');
    const t = chercherSecrets(env, 'server/.env.example');
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ ligne: 6, nom: 'valeur réelle pour COMET_TURN_PASS' });
    expect(chercherSecrets(`COMET_TURN_PASS=${r(24, 'z')}`, 'src/config.js')).toEqual([]); // hors .env : règle non appliquée
  });

  it('les clés publiques et le texte ordinaire passent', () => {
    expect(chercherSecrets(`-----BEGIN ${'PUBLIC'} KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----`, 'desktop/cle.pem')).toEqual([]);
    expect(chercherSecrets('Le skieur a un ghpage sur sk-8 et AKIA court.', 'docs/a.md')).toEqual([]);
  });
});

describe('verifierDepot', () => {
  const dossiers = [];
  afterAll(() => { for (const d of dossiers) try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } });
  const depot = () => {
    const d = mkdtempSync(join(tmpdir(), 'comet-secrets-')); dossiers.push(d);
    execFileSync('git', ['init', '-q'], { cwd: d });
    return d;
  };

  it('trouve un secret dans un fichier suivi, ignore un fichier non suivi', () => {
    const d = depot();
    mkdirSync(join(d, 'src'));
    writeFileSync(join(d, 'src', 'config.js'), `export const cle = '${FAUX['secret client Google']}';\n`);
    writeFileSync(join(d, 'non-suivi.js'), `const t = '${FAUX['jeton Slack']}';\n`);
    execFileSync('git', ['add', 'src/config.js'], { cwd: d });
    const t = verifierDepot(d);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ fichier: 'src/config.js', ligne: 1, nom: 'secret client Google' });
  });

  it('dépôt propre : rien', () => {
    const d = depot();
    writeFileSync(join(d, 'lisez-moi.md'), 'Rien à signaler.\n');
    execFileSync('git', ['add', '.'], { cwd: d });
    expect(verifierDepot(d)).toEqual([]);
  });
});
