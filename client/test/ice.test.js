// Audit C-25 : serveurs ICE de l'instance seulement, entrées filtrées.
import { describe, it, expect } from 'vitest';
import { nettoyerIce } from '../src/ice.js';

describe('nettoyerIce', () => {
  it('garde stun:, turn: et turns:, avec leurs identifiants', () => {
    expect(nettoyerIce({ iceServers: [
      { urls: 'stun:stun.exemple.org:3478' },
      { urls: ['turn:turn.exemple.org:3478', 'turns:turn.exemple.org:5349'], username: 'u', credential: 'p' },
    ] })).toEqual([
      { urls: 'stun:stun.exemple.org:3478' },
      { urls: ['turn:turn.exemple.org:3478', 'turns:turn.exemple.org:5349'], username: 'u', credential: 'p' },
    ]);
  });

  it('écarte les schémas inconnus, les entrées vides et le reste', () => {
    expect(nettoyerIce({ iceServers: [
      { urls: 'http://pirate.example/' }, { urls: 'javascript:alert(1)' }, { urls: '' }, { urls: 42 },
      null, 'stun:texte', { urls: ['ftp://x', 'stun:ok.exemple.org'] }, { urls: 'stun:a', username: 3 },
    ] })).toEqual([{ urls: 'stun:ok.exemple.org' }, { urls: 'stun:a' }]);
  });

  it('réponse absente ou malformée : liste vide, jamais de serveur par défaut', () => {
    for (const r of [undefined, null, {}, { iceServers: 'x' }, []]) expect(nettoyerIce(r)).toEqual([]);
  });

  it('au plus 8 serveurs', () => {
    const beaucoup = Array.from({ length: 20 }, (_, i) => ({ urls: `stun:s${i}.exemple.org` }));
    expect(nettoyerIce({ iceServers: beaucoup })).toHaveLength(8);
  });
});
