// Adresses IP qu'un serveur ne doit pas joindre à la demande d'un utilisateur :
// boucle locale, réseaux privés, lien local, plages réservées. Sert à la fédération
// et aux comptes mail extérieurs (serveurs IMAP/SMTP saisis par l'utilisateur).
//
// Une même adresse IPv4 s'écrit de plusieurs façons en IPv6 (::ffff:127.0.0.1,
// ::ffff:7f00:1, 64:ff9b::7f00:1…) : on développe l'adresse en huit groupes avant de
// la classer, au lieu de comparer des chaînes.
import net from 'node:net';

const v4EnEntier = (ip) => ip.split('.').reduce((n, o) => ((n << 8) + Number(o)) >>> 0, 0);
const dansPlage = (ip, base, bits) => ((v4EnEntier(ip) ^ v4EnEntier(base)) >>> (32 - bits)) === 0;

const PLAGES_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 3], // multidiffusion, réservé, diffusion générale (224.0.0.0 à 255.255.255.255)
];
const v4Privee = (ip) => PLAGES_V4.some(([base, bits]) => dansPlage(ip, base, bits));

// « 2001:db8::1 » → [0x2001, 0xdb8, 0, 0, 0, 0, 0, 1] ; null si l'écriture est invalide.
function groupesV6(ip) {
  let a = ip.toLowerCase().split('%')[0];
  const queueV4 = a.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (queueV4) {
    if (net.isIP(queueV4[2]) !== 4) return null;
    const n = v4EnEntier(queueV4[2]);
    a = `${queueV4[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const morceaux = a.split('::');
  if (morceaux.length > 2) return null;
  const tete = morceaux[0] ? morceaux[0].split(':') : [];
  const queue = morceaux.length === 2 ? (morceaux[1] ? morceaux[1].split(':') : []) : null;
  const groupes = queue === null ? tete : [...tete, ...Array(Math.max(0, 8 - tete.length - queue.length)).fill('0'), ...queue];
  if (groupes.length !== 8 || groupes.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groupes.map((g) => parseInt(g, 16));
}
const v4Depuis = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

function v6Privee(ip) {
  const g = groupesV6(ip);
  if (!g) return true; // illisible : on ne s'y connecte pas
  const zeros = (n) => g.slice(0, n).every((x) => x === 0);
  if (zeros(8)) return true; // ::
  if (zeros(7) && g[7] === 1) return true; // ::1
  if (zeros(5) && g[5] === 0xffff) return v4Privee(v4Depuis(g[6], g[7])); // ::ffff:a.b.c.d
  if (zeros(6)) return v4Privee(v4Depuis(g[6], g[7])); // ::a.b.c.d (ancienne forme)
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (g[2] === 1) return true; // 64:ff9b:1::/48, usage local
    if (g.slice(2, 6).every((x) => x === 0)) return v4Privee(v4Depuis(g[6], g[7])); // NAT64
  }
  if (g[0] === 0x2002) return v4Privee(v4Depuis(g[1], g[2])); // 6to4
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true; // Teredo, documentation
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7, adresses locales uniques
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true; // lien local, site local
  if ((g[0] & 0xff00) === 0xff00) return true; // multidiffusion
  return false;
}

export function estAdressePrivee(ip) {
  const famille = net.isIP(String(ip || ''));
  if (famille === 4) return v4Privee(ip);
  if (famille === 6) return v6Privee(ip);
  return false;
}
