import { db } from '../db.js';

/**
 * Le quota d'une boîte : combien elle pèse, et ce qu'on refuse quand elle est pleine.
 *
 * **Pourquoi refuser plutôt qu'accepter et prévenir.** Accepter au-delà de la limite fait
 * du quota une décoration : le disque du serveur continue de grossir, et personne n'est
 * jamais forcé de faire le ménage. Refuser est plus brutal mais honnête — l'expéditeur
 * reçoit un rebond et SAIT que son message n'est pas arrivé. Le pire des trois choix
 * serait d'accepter en silence puis de supprimer : le destinataire croirait avoir tout
 * reçu, et l'expéditeur croirait avoir été lu.
 *
 * Ce module est le seul endroit où la limite est écrite. La compter à deux endroits, c'est
 * la voir diverger le jour où l'un des deux change.
 */

/** 1 Go par boîte, en octets. Réglable par `COMET_QUOTA_OCTETS` (0 = pas de limite). */
export function limiteOctets() {
  const brut = process.env.COMET_QUOTA_OCTETS;
  if (brut === undefined || brut === null || String(brut).trim() === '') return 1024 * 1024 * 1024;
  const n = Number(brut);
  // Une valeur illisible ne doit pas se traduire par « pas de limite » : ce serait
  // désactiver le quota par une faute de frappe. On retombe sur le défaut.
  if (!Number.isFinite(n) || n < 0) return 1024 * 1024 * 1024;
  return Math.floor(n);
}

/**
 * Ce que pèse la boîte d'un utilisateur, en octets.
 *
 * On compte ce qui EXISTE à cause de lui : le texte de ses messages et le poids réel des
 * pièces jointes conservées. Un message reçu par trois personnes est compté chez les
 * trois — c'est ce que chacun voit dans sa boîte, et c'est la seule lecture qu'un
 * utilisateur puisse comprendre quand on lui dit « votre boîte est pleine ».
 */
export function octetsUtilises(userId) {
  const texte = db.prepare(
    `SELECT COALESCE(SUM(
        LENGTH(COALESCE(m.body, '')) + LENGTH(COALESCE(m.body_html, ''))
        + LENGTH(COALESCE(m.ciphertext, '')) + LENGTH(COALESCE(m.subject, ''))
     ), 0) AS n
     FROM mail_items mi JOIN messages m ON m.id = mi.message_id
     WHERE mi.user_id = ?`,
  ).get(userId);

  const pj = db.prepare(
    `SELECT COALESCE(SUM(a.size), 0) AS n
     FROM mail_attachments a
     WHERE a.etat = 'presente'
       AND a.message_id IN (SELECT message_id FROM mail_items WHERE user_id = ?)`,
  ).get(userId);

  return Number(texte?.n || 0) + Number(pj?.n || 0);
}

/**
 * L'état de la boîte, tel qu'on peut le montrer à son propriétaire.
 * `pourcent` est borné à 100 : afficher « 137 % » n'aide personne.
 */
export function etatQuota(userId) {
  const limite = limiteOctets();
  const utilises = octetsUtilises(userId);
  return {
    utilises,
    limite,
    illimite: limite === 0,
    plein: limite > 0 && utilises >= limite,
    pourcent: limite > 0 ? Math.min(100, Math.round((utilises / limite) * 100)) : 0,
  };
}

/**
 * Y a-t-il la place d'écrire `octets` de plus dans cette boîte ?
 *
 * @returns {{ok: boolean, utilises: number, limite: number, manque?: number}}
 */
export function placeDisponible(userId, octets = 0) {
  const limite = limiteOctets();
  const utilises = octetsUtilises(userId);
  if (limite === 0) return { ok: true, utilises, limite };
  const apres = utilises + Math.max(0, Number(octets) || 0);
  if (apres <= limite) return { ok: true, utilises, limite };
  return { ok: false, utilises, limite, manque: apres - limite };
}

/** Une taille lisible par un humain, pour les messages de refus. */
export function lisible(octets) {
  const n = Math.max(0, Number(octets) || 0);
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} Go`;
  if (n >= 1024 * 1024) return `${Math.round(n / (1024 * 1024))} Mo`;
  if (n >= 1024) return `${Math.round(n / 1024)} Ko`;
  return `${n} octets`;
}
