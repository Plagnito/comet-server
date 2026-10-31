// Fédération — appels sortants vers un autre serveur, sous garde.
//
// Une adresse saisie par un utilisateur décide d'une requête que NOTRE serveur émet :
// sans garde, « x@intranet.local » ferait interroger le réseau interne (SSRF). D'où :
//
//   • https seulement, sauf vers une adresse locale/privée (réseau local, tests) ;
//   • une adresse locale/privée n'est jamais atteinte par découverte DNS — seulement
//     par un hôte DÉCLARÉ par l'admin (COMET_FEDERATION_HOTES) ;
//   • l'adresse IP vérifiée est celle à laquelle on se connecte (lookup imposé : pas de
//     second tirage DNS entre le contrôle et la connexion) ;
//   • aucune redirection suivie, réponse bornée en taille et en temps.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { LIMITES } from './config.js';
import { estAdressePrivee } from '../util/adresses.js';

export class ErreurReseau extends Error {
  constructor(message, code = 'reseau') { super(message); this.code = code; }
}

// Classement commun à la fédération et aux comptes mail (toutes les écritures IPv6
// d'une adresse IPv4 comprises : ::ffff:7f00:1 est bien la boucle locale).
export { estAdressePrivee };

// Décide si l'adresse IP est admissible pour ce protocole.
function admissible(ip, protocole, autoriserPrive) {
  const prive = estAdressePrivee(ip);
  if (prive && !autoriserPrive) return 'adresse privée ou locale refusée (déclarez l\'hôte dans COMET_FEDERATION_HOTES)';
  if (protocole === 'http:' && !prive) return 'http refusé hors réseau local';
  return null;
}

/**
 * @param {string} url
 * @param {{ methode?: string, entetes?: object, corps?: Buffer|string, autoriserPrive?: boolean }} o
 * @returns {Promise<{ statut: number, entetes: object, corps: Buffer }>}
 */
export function appeler(url, { methode = 'GET', entetes = {}, corps = null, autoriserPrive = false } = {}) {
  let u;
  try { u = new URL(url); } catch { return Promise.reject(new ErreurReseau('adresse invalide', 'adresse')); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return Promise.reject(new ErreurReseau('protocole refusé', 'protocole'));
  if (u.username || u.password) return Promise.reject(new ErreurReseau('identifiants dans l\'URL refusés', 'adresse'));

  const hote = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hote)) {
    const refus = admissible(hote, u.protocol, autoriserPrive);
    if (refus) return Promise.reject(new ErreurReseau(refus, 'adresse'));
  }

  // Résolution contrôlée : on garde la première adresse admissible, et c'est elle qu'on
  // passe à la connexion.
  const lookup = (nom, opts, cb) => {
    dns.lookup(nom, { all: true }, (err, adresses) => {
      if (err) return cb(err);
      let raison = 'aucune adresse';
      for (const a of adresses) {
        const refus = admissible(a.address, u.protocol, autoriserPrive);
        if (!refus) return opts && opts.all ? cb(null, [a]) : cb(null, a.address, a.family);
        raison = refus;
      }
      cb(new ErreurReseau(raison, 'adresse'));
    });
  };

  const mod = u.protocol === 'https:' ? https : http;
  const charge = corps == null ? null : Buffer.isBuffer(corps) ? corps : Buffer.from(String(corps));
  return new Promise((resolve, reject) => {
    const req = mod.request(u, {
      method: methode,
      headers: { ...entetes, ...(charge ? { 'content-length': charge.length } : {}) },
      lookup,
      agent: false,            // pas de connexion persistante entre serveurs : rien ne traîne
      timeout: LIMITES.delai,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        return reject(new ErreurReseau('redirection refusée', 'redirection'));
      }
      const morceaux = []; let taille = 0;
      res.on('data', (m) => {
        taille += m.length;
        if (taille > LIMITES.reponseMax) { req.destroy(new ErreurReseau('réponse trop volumineuse', 'taille')); return; }
        morceaux.push(m);
      });
      res.on('end', () => resolve({ statut: res.statusCode, entetes: res.headers, corps: Buffer.concat(morceaux) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new ErreurReseau('délai dépassé', 'delai')));
    req.on('error', (e) => reject(e instanceof ErreurReseau ? e : new ErreurReseau(e.message || String(e))));
    if (charge) req.write(charge);
    req.end();
  });
}

export function lireJson(reponse) {
  try { return JSON.parse(reponse.corps.toString('utf8')); } catch { return null; }
}
