import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let persistent; let session; let api;
const storage = (map) => ({ getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: (key) => map.delete(key) });
beforeEach(async () => {
  vi.resetModules(); persistent = new Map([['comet.token', 'legacy-token'], ['comet.privkey', 'legacy-key'], ['comet.theme', 'dark']]);
  session = new Map([['comet.token', 'legacy-token'], ['comet.privkey', 'legacy-key']]);
  vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('localStorage', storage(persistent)); vi.stubGlobal('sessionStorage', storage(session));
  api = await import('../src/api.js');
});
afterEach(() => { vi.unstubAllGlobals(); });
describe('Identifiants uniquement en mémoire', () => {
  it('retire les anciens identifiants sans effacer les préférences', () => {
    expect([...persistent.entries()]).toEqual([['comet.theme', 'dark']]); expect(session.size).toBe(0); expect(api.getToken()).toBeNull();
  });
  it('garde le bearer compatible avec l’API sans l’écrire sur disque', async () => {
    api.setToken('memory-fixture'); const fetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 })); vi.stubGlobal('fetch', fetch);
    await api.api.get('/auth/me'); expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer memory-fixture');
    expect(persistent.has('comet.token')).toBe(false); expect(session.has('comet.token')).toBe(false);
  });
  it('perd le jeton au rechargement du module', async () => {
    api.setToken('memory-fixture'); vi.resetModules(); const reloaded = await import('../src/api.js'); expect(reloaded.getToken()).toBeNull();
  });
  it('efface la session sur 401 protégé et émet un événement sans secret', async () => {
    api.setToken('memory-fixture'); const expired = vi.fn(); window.addEventListener('comet:auth-expired', expired);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"revoked"}', { status: 401 })));
    await expect(api.api.get('/auth/me')).rejects.toThrow('revoked'); expect(api.getToken()).toBeNull(); expect(expired).toHaveBeenCalledOnce();
    expect(expired.mock.calls[0][0].detail).toBeUndefined();
  });
  it('ne laisse pas une ancienne réponse 401 effacer un jeton renouvelé', async () => {
    api.setToken('old-fixture'); let complete;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise((resolve) => { complete = resolve; })));
    const oldRequest = api.api.get('/old'); api.setToken('new-fixture');
    complete(new Response('{"error":"old session"}', { status: 401 }));
    await expect(oldRequest).rejects.toThrow('old session'); expect(api.getToken()).toBe('new-fixture');
  });
  it('attend le renouvellement en cours avant de décider une expiration', async () => {
    api.setToken('old-fixture'); let complete;
    const expired = vi.fn(); window.addEventListener('comet:auth-expired', expired);
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url) => url.endsWith('/auth/2fa/setup')
      ? new Promise((resolve) => { complete = resolve; }) : Promise.resolve(new Response('{"error":"old session"}', { status: 401 }))));
    const renewal = api.api.post('/auth/2fa/setup', {});
    await expect(api.api.get('/old')).rejects.toThrow('old session'); expect(expired).not.toHaveBeenCalled();
    complete(new Response('{"token":"new-fixture"}', { status: 200 })); await renewal;
    expect(api.getToken()).toBe('new-fixture'); expect(expired).not.toHaveBeenCalled();
  });
});
