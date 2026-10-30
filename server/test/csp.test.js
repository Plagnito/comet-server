import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { securityHeaders } from '../src/security-headers.js';
import { serveClient } from '../src/services/client-files.js';
import accounts from '../src/routes/accounts.js';

let server; const root = mkdtempSync(join(tmpdir(), 'comet-csp-'));
const nonce = (response) => /'nonce-([^']+)'/.exec(response.headers['content-security-policy'])?.[1];
beforeAll(async () => {
  mkdirSync(join(root, 'assets')); writeFileSync(join(root, 'assets', 'main.js'), '/* fixture */');
  writeFileSync(join(root, 'index.html'), '<!doctype html><script>window.fixture=1</script><script type="module" src="/assets/main.js"></script><div>fixture</div>');
  const app = express(); app.set('trust proxy', false); app.use(securityHeaders()); app.use('/api/accounts', accounts); serveClient(app, root);
  server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
describe('CSP et HTML légitimes', () => {
  it.each(['/', '/index.html', '/courrier'])('autorise tous les scripts de l’index par un nonce sur %s', async (path) => {
    const response = await request(server).get(path); expect(response.status).toBe(200);
    const value = nonce(response); expect(value).toBeTruthy();
    expect(response.text.match(/<script nonce="/g)).toHaveLength(2);
    expect(response.text.match(new RegExp(`nonce="${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g'))).toHaveLength(2);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toContain("script-src-attr 'none'");
    expect(response.headers['content-security-policy']).toContain("'strict-dynamic'");
  });
  it('renouvelle le nonce à chaque réponse réseau et garde le WebSocket same-origin', async () => {
    const a = await request(server).get('/'); const b = await request(server).get('/'); expect(nonce(a)).not.toBe(nonce(b));
    expect(a.headers['content-security-policy']).toMatch(/connect-src 'self' ws:\/\/127\.0\.0\.1:/);
    expect(a.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
  });
  it('garde les fichiers JS externes et ne transforme pas une API absente en HTML', async () => {
    expect((await request(server).get('/assets/main.js')).text).toBe('/* fixture */');
    expect((await request(server).get('/api/missing')).status).toBe(404);
  });
  it('nonce le callback OAuth et échappe le contenu externe sans appel fournisseur', async () => {
    const response = await request(server).get('/api/accounts/oauth/gmail/callback').query({ error: 'access_denied', error_description: '<script>forbidden()</script>' });
    expect(response.status).toBe(400); expect(response.text).toContain(`nonce="${nonce(response)}"`);
    expect(response.text).toContain('&lt;script&gt;'); expect(response.text).not.toContain('<script>forbidden');
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
  });
});
