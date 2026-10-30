import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

describe('Erreurs fatales', () => {
  it.each([
    ['uncaughtException', "setImmediate(() => { throw new Error('fatal-fixture'); });"],
    ['unhandledRejection', "Promise.reject(new Error('fatal-fixture'));"],
  ])('arrête un processus jetable sur %s', (label, trigger) => {
    const directory = mkdtempSync(join(tmpdir(), 'comet-fatal-'));
    try {
      const source = `await import(${JSON.stringify(pathToFileURL(resolve('src/server.js')).href)}); ${trigger} setTimeout(() => console.log('SURVIVED_FATAL'), 100);`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        env: { ...process.env, COMET_DB_PATH: join(directory, 'test.db'), COMET_SEED_DEMO: '0' },
        encoding: 'utf8', timeout: 10_000,
      });
      expect(result.status).toBe(1); expect(result.stderr).toContain(`[${label}]`);
      expect(result.stdout).not.toContain('SURVIVED_FATAL');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
