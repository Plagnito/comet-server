// CORS : la MÊME origine est toujours admise, une origine étrangère toujours refusée.
// Régression vécue : sans COMET_BASE_URL, le navigateur se voyait refuser les scripts
// de la page que le serveur venait de lui servir (il envoie Origin même en same-origin)
// → page blanche sur tout serveur auto-hébergé.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';

describe('CORS — même origine', () => {
  it('admet une requête dont l’Origin désigne le serveur lui-même', async () => {
    const r = await request(app).get('/api/health')
      .set('Host', 'comet.exemple.fr').set('Origin', 'https://comet.exemple.fr');
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe('https://comet.exemple.fr');
  });

  it('ignore un Host relayé depuis un pair non approuvé', async () => {
    const r = await request(app).get('/api/health')
      .set('Host', 'localhost:4800').set('X-Forwarded-Host', 'comet.exemple.fr')
      .set('Origin', 'https://comet.exemple.fr');
    expect(r.status).toBe(403);
  });

  it('refuse une origine étrangère', async () => {
    const r = await request(app).get('/api/health')
      .set('Host', 'comet.exemple.fr').set('Origin', 'https://site-malveillant.example');
    expect(r.status).toBe(403);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuse un sous-domaine qui ressemble au serveur', async () => {
    const r = await request(app).get('/api/health')
      .set('Host', 'comet.exemple.fr').set('Origin', 'https://comet.exemple.fr.piege.example');
    expect(r.status).toBe(403);
  });
});
