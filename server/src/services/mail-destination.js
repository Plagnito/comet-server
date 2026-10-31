// Serveurs IMAP/SMTP saisis par un utilisateur : c'est NOTRE serveur qui s'y connecte.
// Sans garde, un compte pourrait lui faire joindre la box, une autre machine du réseau
// ou un service qui n'écoute que sur la machine elle-même, et sonder n'importe quel port.
//
//   • ports limités aux ports mail usuels ;
//   • adresse locale ou privée refusée, sauf si l'admin l'autorise ;
//   • on renvoie l'adresse IP vérifiée, à laquelle se fait la connexion (pas de second
//     tirage DNS entre le contrôle et la connexion) ; le nom d'origine reste celui que
//     le certificat TLS doit porter.
import dns from 'node:dns';
import net from 'node:net';
import { estAdressePrivee } from '../util/adresses.js';

export const PORTS_MAIL = { imap: [993, 143], smtp: [465, 587, 25, 2525] };

export class DestinationRefusee extends Error {
  constructor(message) { super(message); this.name = 'DestinationRefusee'; this.status = 400; }
}

const reseauLocalAutorise = () => String(process.env.COMET_MAIL_RESEAU_LOCAL || '').toLowerCase() === 'autorise';
const portsLibres = () => String(process.env.COMET_MAIL_PORTS_LIBRES || '').toLowerCase() === 'oui';

/**
 * @param {string} hote nom ou adresse IP saisi par l'utilisateur
 * @param {number} port
 * @param {'imap'|'smtp'} protocole
 * @returns {Promise<{ host: string, servername?: string }>}
 */
export async function destinationMail(hote, port, protocole) {
  const nom = String(hote || '').trim().replace(/^\[|\]$/g, '');
  const p = Number(port);
  if (!nom) throw new DestinationRefusee('Serveur mail manquant');
  if (!portsLibres() && !PORTS_MAIL[protocole].includes(p)) {
    throw new DestinationRefusee(`Port ${protocole.toUpperCase()} ${p} refusé (ports admis : ${PORTS_MAIL[protocole].join(', ')})`);
  }

  let adresses;
  if (net.isIP(nom)) adresses = [nom];
  else {
    try { adresses = (await dns.promises.lookup(nom, { all: true, verbatim: true })).map((a) => a.address); }
    catch { throw new DestinationRefusee(`Serveur mail introuvable : ${nom}`); }
  }
  if (!adresses.length) throw new DestinationRefusee(`Serveur mail introuvable : ${nom}`);
  // Une seule adresse privée suffit à refuser : sinon le choix de l'adresse décide.
  if (!reseauLocalAutorise() && adresses.some(estAdressePrivee)) {
    throw new DestinationRefusee(`${nom} désigne une adresse locale ou privée : connexion refusée. `
      + "Pour un serveur mail du réseau local, l'administrateur peut poser COMET_MAIL_RESEAU_LOCAL=autorise.");
  }
  return net.isIP(nom) ? { host: nom } : { host: adresses[0], servername: nom };
}
