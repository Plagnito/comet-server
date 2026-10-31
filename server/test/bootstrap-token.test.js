import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolveBootstrapToken, matchesBootstrapToken } from '../src/util/bootstrap.js';

const roots = [];
const directory = () => { const value = mkdtempSync(join(tmpdir(), 'comet-bootstrap-token-')); roots.push(value); return value; };
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
describe('Code local d’installation', () => {
  it('crée un code aléatoire persistant et réutilise le fichier existant', () => {
    const root = directory(); const first = resolveBootstrapToken(undefined, root);
    expect(first).toMatch(/^[0-9a-f]{96}$/);
    expect(resolveBootstrapToken(undefined, root)).toBe(first);
    expect(readFileSync(join(root, '.bootstrap_token'), 'utf8')).toBe(first);
    expect(matchesBootstrapToken(first, first)).toBe(true);
    expect(matchesBootstrapToken('wrong', first)).toBe(false);
  });
  it('préserve un fichier invalide et échoue au lieu de le remplacer', () => {
    const root = directory(); const path = join(root, '.bootstrap_token'); writeFileSync(path, 'invalid');
    expect(() => resolveBootstrapToken(undefined, root)).toThrow(/bootstrap invalide/);
    expect(readFileSync(path, 'utf8')).toBe('invalid');
  });
  it('accepte une valeur explicite forte sans réécrire le fichier', () => {
    const root = directory(); writeFileSync(join(root, '.bootstrap_token'), 'preserve');
    const configured = 'explicit-bootstrap-secret-0123456789abcdef';
    expect(resolveBootstrapToken(configured, root)).toBe(configured);
    expect(readFileSync(join(root, '.bootstrap_token'), 'utf8')).toBe('preserve');
    expect(() => resolveBootstrapToken('short', root)).toThrow();
  });
  it.each(['1', 'true', '0.0.0.0/0'])('refuse une confiance proxy ambiguë ou universelle %s', (value) => {
    const source = `await import(${JSON.stringify(pathToFileURL(resolve('src/config.js')).href)});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, COMET_TRUST_PROXY: value }, encoding: 'utf8', timeout: 5000,
    });
    expect(result.status).toBe(1); expect(result.stderr).toContain('COMET_TRUST_PROXY');
  });
});
