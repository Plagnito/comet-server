// Qui voit la présence (en ligne / hors ligne) et les disponibilités d'un autre compte.
//
// Règle : on voit les gens avec qui l'on travaille, et seulement s'ils y ont pris part.
//   • même organisation (attribuée par l'organisation, pas par l'un des deux comptes) ;
//   • ou la personne a CRÉÉ ou ÉCRIT dans un canal d'équipe ou un message direct dont on
//     est membre. Être ajouté à un canal ne suffit pas : n'importe qui peut créer un canal
//     et y ajouter n'importe qui, ce qui lui donnerait la présence de tout l'annuaire.
//
// Sans organisation et sans échange, on ne voit que soi (comme l'annuaire). Les comptes
// système et les boîtes partagées n'ont pas de présence.
import { db } from '../db.js';

// La personne `t` a participé au canal `c` (créé, ou au moins un message envoyé).
const PARTICIPE = (c, t) => `(${c}.created_by = ${t} OR EXISTS (SELECT 1 FROM chat_messages m WHERE m.channel_id = ${c}.id AND m.sender_id = ${t}))`;

const memeOrg = (a, b) => `(${a}.org_id IS NOT NULL AND ${a}.org_id = ${b}.org_id)`;

// Comptes dont `observateur` voit la présence.
const VISIBLES = db.prepare(`
  SELECT u.id FROM users u, users o
  WHERE o.id = ? AND u.id <> o.id AND u.is_system = 0 AND u.is_box = 0
    AND (${memeOrg('u', 'o')} OR EXISTS (
      SELECT 1 FROM channel_members cm JOIN channels c ON c.id = cm.channel_id
      WHERE cm.user_id = o.id AND ${PARTICIPE('c', 'u.id')}))`);

// Comptes qui voient la présence de `cible` (l'inverse : à qui annoncer son arrivée).
const AUDIENCE = db.prepare(`
  SELECT v.id FROM users v, users t
  WHERE t.id = ? AND v.id <> t.id AND v.is_system = 0 AND v.is_box = 0
    AND (${memeOrg('v', 't')} OR EXISTS (
      SELECT 1 FROM channel_members cm JOIN channels c ON c.id = cm.channel_id
      WHERE cm.user_id = v.id AND ${PARTICIPE('c', 't.id')}))`);

const UN = db.prepare(`
  SELECT 1 FROM users u, users o
  WHERE o.id = ? AND u.id = ? AND u.is_system = 0 AND u.is_box = 0
    AND (${memeOrg('u', 'o')} OR EXISTS (
      SELECT 1 FROM channel_members cm JOIN channels c ON c.id = cm.channel_id
      WHERE cm.user_id = o.id AND ${PARTICIPE('c', 'u.id')}))`);

export const visiblesPar = (observateur) => new Set(VISIBLES.all(Number(observateur)).map((r) => r.id));
export const audienceDe = (cible) => new Set(AUDIENCE.all(Number(cible)).map((r) => r.id));
export function voit(observateur, cible) {
  const o = Number(observateur); const c = Number(cible);
  if (!o || !c) return false;
  return o === c || !!UN.get(o, c);
}

// Deux comptes ont échangé du courrier (l'un a écrit à l'autre). Sert au relais de
// signalisation des pièces jointes en pair-à-pair, qui ne concerne qu'un expéditeur
// et ses destinataires.
const ECHANGE = db.prepare(`
  SELECT 1 FROM messages m JOIN recipients r ON r.message_id = m.id
  WHERE (m.sender_id = ? AND r.user_id = ?) OR (m.sender_id = ? AND r.user_id = ?) LIMIT 1`);
export function ontEchange(a, b) {
  const x = Number(a); const y = Number(b);
  if (!x || !y || x === y) return false;
  return !!ECHANGE.get(x, y, y, x);
}

// Organisation d'un compte (null sans organisation).
const ORG = db.prepare('SELECT org_id FROM users WHERE id = ?');
export const orgDe = (id) => ORG.get(Number(id))?.org_id ?? null;
