// Configuration ICE (STUN / TURN) de l'instance, pour la visio et les pièces jointes en
// pair-à-pair. Aucun serveur tiers par défaut : un serveur STUN voit l'adresse IP de
// chaque participant. L'administrateur renseigne les siens :
//   COMET_STUN       une ou plusieurs adresses stun:, séparées par des virgules
//   COMET_TURN       adresse(s) turn: ou turns: du relais (idéalement son propre coturn)
//   COMET_TURN_USER / COMET_TURN_PASS   identifiants du relais
// Le STUN est donné à tous (la page invité d'une visio en a besoin). Les identifiants du
// relais TURN, eux, ne vont qu'à une session de compte valide ou à un invité dont le jeton
// correspond à un salon ouvert : sinon n'importe qui pourrait faire transiter son trafic
// par le relais de l'instance.
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config.js';
import { userForSession } from '../auth.js';
import { getRoom } from './confrooms.js';

const liste = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

// Vrai si la requête porte un jeton de compte valide ou un jeton invité d'un salon ouvert.
export function demandeAutorisee(req) {
  const entete = req.headers.authorization || '';
  const jeton = entete.startsWith('Bearer ') ? entete.slice(7) : null;
  if (!jeton) return false;
  try {
    const p = jwt.verify(jeton, JWT_SECRET);
    if (p.guest) return !!getRoom(String(p.room || ''));
    return !!userForSession(p);
  } catch { return false; }
}

export function configurationIce({ turn = false, env = process.env } = {}) {
  const iceServers = [];
  for (const urls of liste(env.COMET_STUN)) if (/^stun:/i.test(urls)) iceServers.push({ urls });
  if (turn) {
    const urls = liste(env.COMET_TURN).filter((u) => /^turns?:/i.test(u));
    if (urls.length) iceServers.push({ urls: urls.length === 1 ? urls[0] : urls, username: env.COMET_TURN_USER || '', credential: env.COMET_TURN_PASS || '' });
  }
  return { iceServers };
}
