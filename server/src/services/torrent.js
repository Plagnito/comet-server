// Génération de fichiers .torrent avec WEB-SEED (BEP-19).
//
// But : pour une pièce jointe volumineuse déjà stockée par Comet, produire un
// .torrent mono-fichier dont le champ « url-list » (web-seed GetRight/BEP-19) pointe
// vers l'URL HTTP publique servie par Comet. Le destinataire peut alors récupérer le
// fichier avec un client BitTorrent MÊME sans aucun pair (repli HTTP via le web-seed),
// et bénéficier du P2P (DHT/pairs) quand il y en a.
//
// Zéro dépendance : bencodage + hachage SHA-1 des morceaux faits maison (node:crypto).
// Aucun tracker n'est enregistré (hors périmètre) : web-seed + DHT suffisent.

import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';

// Seuil « pièce jointe volumineuse » → au-delà, on génère un torrent web-seed.
export const TORRENT_THRESHOLD = 50 * 1024 * 1024; // 50 Mo

// ── Bencodage minimal → Buffer (gère correctement le binaire, ex. « pieces ») ──
function bencode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (typeof value === 'string') {
    const b = Buffer.from(value, 'utf8');
    return Buffer.concat([Buffer.from(`${b.length}:`), b]);
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('bencode: entier attendu');
    return Buffer.from(`i${value}e`);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')]);
  }
  if (value && typeof value === 'object') {
    // Les clés d'un dictionnaire bencodé DOIVENT être triées par ordre d'octets.
    // Toutes nos clés sont en ASCII minuscule → le tri lexicographique JS convient.
    const keys = Object.keys(value).sort();
    const parts = [Buffer.from('d')];
    for (const k of keys) { parts.push(bencode(k), bencode(value[k])); }
    parts.push(Buffer.from('e'));
    return Buffer.concat(parts);
  }
  throw new Error('bencode: type non supporté');
}

// Longueur de morceau raisonnable : vise ~1500 morceaux, borné [256 Kio, 4 Mio],
// puissance de deux (convention BitTorrent).
function pickPieceLength(size) {
  let p = 256 * 1024;
  while (size / p > 1500 && p < 4 * 1024 * 1024) p *= 2;
  return p;
}

// Construit un .torrent mono-fichier avec web-seed.
//   data        : Buffer du fichier (ici le blob chiffré tel que servi par le web-seed)
//   name        : nom de fichier affiché
//   webSeedUrl  : URL HTTP(S) publique ABSOLUE servant EXACTEMENT ces octets (BEP-19)
// Renvoie { torrent:Buffer, infoHash:hex, pieceLength, pieceCount }.
export function createWebSeedTorrent(data, { name, webSeedUrl, pieceLength } = {}) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (!webSeedUrl) throw new Error('createWebSeedTorrent: webSeedUrl requis');
  const length = buf.length;
  const plen = pieceLength || pickPieceLength(length);

  const hashes = [];
  for (let o = 0; o < length; o += plen) {
    hashes.push(createHash('sha1').update(buf.subarray(o, Math.min(o + plen, length))).digest());
  }
  const pieces = hashes.length ? Buffer.concat(hashes) : Buffer.alloc(0);

  // Clés du dict « info » : length, name, piece length, pieces (triées par bencode()).
  const info = {
    length,
    name: String(name || 'fichier'),
    'piece length': plen,
    pieces,
  };
  const infoHash = createHash('sha1').update(bencode(info)).digest('hex');

  // Torrent « trackerless » : pas d'« announce » (web-seed + DHT). « url-list » = web-seed.
  const torrent = {
    'created by': 'Comet',
    'creation date': Math.floor(Date.now() / 1000),
    info,
    'url-list': String(webSeedUrl),
  };

  return { torrent: bencode(torrent), infoHash, pieceLength: plen, pieceCount: hashes.length };
}

// Assemble le .torrent final à partir des hachages de morceaux déjà calculés.
function assemble({ length, name, pieceLength, hashes, webSeedUrl }) {
  const pieces = hashes.length ? Buffer.concat(hashes) : Buffer.alloc(0);
  const info = { length, name: String(name || 'fichier'), 'piece length': pieceLength, pieces };
  const infoHash = createHash('sha1').update(bencode(info)).digest('hex');
  const torrent = {
    'created by': 'Comet',
    'creation date': Math.floor(Date.now() / 1000),
    info,
    'url-list': String(webSeedUrl),
  };
  return { torrent: bencode(torrent), infoHash, pieceLength, pieceCount: hashes.length };
}

// Variante STREAMING pour les gros fichiers (multi-Go) : lit le fichier morceau par
// morceau depuis le disque et hache chaque morceau au vol → mémoire bornée (~1 morceau),
// JAMAIS le fichier entier en RAM. Renvoie une Promise<{ torrent, infoHash, ... }>.
export function createWebSeedTorrentFromFile(path, { name, webSeedUrl, pieceLength } = {}) {
  if (!webSeedUrl) throw new Error('createWebSeedTorrentFromFile: webSeedUrl requis');
  const length = statSync(path).size;
  const plen = pieceLength || pickPieceLength(length);

  return new Promise((resolve, reject) => {
    const hashes = [];
    let hash = createHash('sha1');
    let filled = 0; // octets déjà accumulés dans le morceau courant
    const rs = createReadStream(path, { highWaterMark: 1 << 20 }); // lit par 1 Mio
    rs.on('data', (chunk) => {
      let off = 0;
      while (off < chunk.length) {
        const take = Math.min(plen - filled, chunk.length - off);
        hash.update(chunk.subarray(off, off + take));
        filled += take; off += take;
        if (filled === plen) { hashes.push(hash.digest()); hash = createHash('sha1'); filled = 0; }
      }
    });
    rs.on('end', () => {
      if (filled > 0) hashes.push(hash.digest()); // dernier morceau (partiel)
      resolve(assemble({ length, name, pieceLength: plen, hashes, webSeedUrl }));
    });
    rs.on('error', reject);
  });
}

