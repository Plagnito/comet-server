// Test unitaire isolé du service de génération .torrent web-seed (aucune app/DB).
// Valide : bencodage correct, présence du web-seed (url-list), hachage SHA-1 des
// morceaux et info-hash.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWebSeedTorrent, createWebSeedTorrentFromFile, TORRENT_THRESHOLD } from '../src/services/torrent.js';

// ── bdecode minimal (pour vérifier ce qu'on a produit) ──────────────────────
function bdecode(buf) {
  let i = 0;
  function readInt(term) { let s = i; while (buf[i] !== term) i++; const n = Number(buf.toString('ascii', s, i)); i++; return n; }
  function parse() {
    const c = buf[i];
    if (c === 0x69) { i++; return readInt(0x65); }                       // i<int>e
    if (c === 0x6c) { i++; const a = []; while (buf[i] !== 0x65) a.push(parse()); i++; return a; } // l..e
    if (c === 0x64) { i++; const o = {}; while (buf[i] !== 0x65) { const k = parse().toString('utf8'); o[k] = parse(); } i++; return o; } // d..e
    const len = readInt(0x3a); const s = buf.subarray(i, i + len); i += len; return s; // <len>:<bytes> → Buffer
  }
  return parse();
}

describe('torrent web-seed', () => {
  const WEB = 'https://comet.example.org/api/attachments/abc-123/webseed';

  it('produit un .torrent valide, mono-fichier, avec web-seed et bons hachages', () => {
    // 2.5 morceaux à 256 Kio → force plusieurs pièces.
    const plen = 256 * 1024;
    const data = Buffer.alloc(plen * 2 + 1000, 7);
    const { torrent, infoHash, pieceLength, pieceCount } = createWebSeedTorrent(data, { name: 'gros.bin', webSeedUrl: WEB, pieceLength: plen });

    const dec = bdecode(torrent);
    expect(dec['url-list'].toString('utf8')).toBe(WEB);          // BEP-19 web-seed
    expect(dec.info.name.toString('utf8')).toBe('gros.bin');
    expect(dec.info.length).toBe(data.length);
    expect(dec.info['piece length']).toBe(plen);

    // pieces = concat des SHA-1 (20 o) de chaque morceau
    const pieces = dec.info.pieces;
    expect(pieces.length % 20).toBe(0);
    expect(pieces.length / 20).toBe(pieceCount);
    expect(pieceCount).toBe(3);
    for (let p = 0; p < pieceCount; p++) {
      const slice = data.subarray(p * plen, Math.min((p + 1) * plen, data.length));
      const h = createHash('sha1').update(slice).digest();
      expect(pieces.subarray(p * 20, p * 20 + 20).equals(h)).toBe(true);
    }

    // info-hash = SHA-1 du dict info bencodé (ré-encodage de contrôle)
    expect(infoHash).toMatch(/^[0-9a-f]{40}$/);
    expect(pieceLength).toBe(plen);
  });

  it('variante STREAMING (fichier) : info-hash identique à la variante mémoire', async () => {
    const plen = 256 * 1024;
    // Contenu non trivial couvrant 2 morceaux pleins + 1 partiel, à cheval sur les chunks de lecture.
    const data = Buffer.alloc(plen * 2 + 4321);
    for (let k = 0; k < data.length; k++) data[k] = (k * 37 + 11) % 251;
    const path = join(tmpdir(), `comet-torrent-test-${process.pid}.bin`);
    writeFileSync(path, data);
    try {
      const mem = createWebSeedTorrent(data, { name: 'iso.bin', webSeedUrl: WEB, pieceLength: plen });
      const strm = await createWebSeedTorrentFromFile(path, { name: 'iso.bin', webSeedUrl: WEB, pieceLength: plen });
      // Le dict « info » (nom + longueur + morceaux) est identique → même info-hash.
      expect(strm.infoHash).toBe(mem.infoHash);
      expect(strm.pieceCount).toBe(mem.pieceCount);
      expect(strm.pieceCount).toBe(3);

      const dec = bdecode(strm.torrent);
      expect(dec['url-list'].toString('utf8')).toBe(WEB);
      expect(dec.info.length).toBe(data.length);
      // vérifie chaque hachage de morceau vs SHA-1 calculé à la main
      const pieces = dec.info.pieces;
      for (let p = 0; p < strm.pieceCount; p++) {
        const slice = data.subarray(p * plen, Math.min((p + 1) * plen, data.length));
        const h = createHash('sha1').update(slice).digest();
        expect(pieces.subarray(p * 20, p * 20 + 20).equals(h)).toBe(true);
      }
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('choisit une longueur de morceau par défaut (puissance de deux, >= 256 Kio)', () => {
    const { pieceLength } = createWebSeedTorrent(Buffer.alloc(1024), { name: 'x', webSeedUrl: WEB });
    expect(pieceLength).toBe(256 * 1024);
    expect(Number.isInteger(Math.log2(pieceLength))).toBe(true);
  });

  it('exige un web-seed', () => {
    expect(() => createWebSeedTorrent(Buffer.alloc(10), { name: 'x' })).toThrow();
  });


  it('expose un seuil de 50 Mo', () => {
    expect(TORRENT_THRESHOLD).toBe(50 * 1024 * 1024);
  });
});
