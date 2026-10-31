// Fédération — ce qui transite : clés des comptes, livraisons, file d'envoi.
//
// Le serveur ne voit JAMAIS le contenu : il transporte le chiffré produit par le client et,
// pour chaque destinataire, la clé de message enveloppée par SA clé publique. Seule la clé
// enveloppée pour les destinataires d'un serveur part chez ce serveur.
import { randomUUID } from 'node:crypto';
import { db, SYSTEM_EMAIL } from '../db.js';
import { notifyUser } from '../ws.js';
import { applyRules } from '../services/rules.js';
import { suivreLivraison } from '../services/remisedirecte.js';
import { deliverMessage } from '../services/mail.js';
import {
  domaineLocal, federationActive, decouper, adresseFederee, DOMAINE_INTERNE, LIMITES, estDomaineDistant,
} from './config.js';
import { ErreurFederation, appelSigne, etablir, rotationsConnues } from './pairs.js';
import { signerAvecIdentite, identite } from './identite.js';
import { texteCle, verifier, empreinte } from './signature.js';
import './schema.js';

// ── Comptes ─────────────────────────────────────────────────────────────────

// Compte LOCAL désigné par une adresse de notre domaine : l'adresse exacte d'abord (un
// compte inscrit sous « x@serveur-a.fr »), sinon « x@comet.mail ».
export function compteLocal(adresse) {
  const p = decouper(adresse);
  if (!p || p.domaine !== domaineLocal()) return null;
  const sql = 'SELECT * FROM users WHERE email = ? AND distant_domaine IS NULL AND is_system = 0 AND is_box = 0';
  return db.prepare(sql).get(p.adresse) || db.prepare(sql).get(`${p.local}@${DOMAINE_INTERNE}`) || null;
}

// Adresse fédérée d'un compte local, ou null s'il n'en a pas (ou si elle désigne un autre
// compte : « x@comet.mail » quand un compte « x@serveur-a.fr » existe déjà).
export function adresseDe(user) {
  if (!user || user.distant_domaine) return null;
  const a = adresseFederee(user.email);
  if (!a) return null;
  const titulaire = compteLocal(a);
  return titulaire && titulaire.id === user.id ? a : null;
}

const COULEURS = ['#4f46e5', '#db2777', '#0d9488', '#ea580c', '#7c3aed', '#2563eb', '#c026d3', '#16a34a'];

// Correspondant distant (ligne `users` sans connexion possible). Mémorise sa clé ; si elle
// change, on garde la nouvelle (signée par son serveur) et on DATE le changement pour que
// le client avertisse — comme un « numéro de sécurité modifié ».
export function correspondant(adresse, { nom = null, cle = null } = {}) {
  const p = decouper(adresse);
  if (!p) throw new ErreurFederation('Adresse invalide.', 'adresse');
  let u = db.prepare('SELECT * FROM users WHERE email = ?').get(p.adresse);
  if (u && !u.distant_domaine) {
    throw new ErreurFederation(`L'adresse ${p.adresse} appartient à un compte de ce serveur.`, 'conflit', 409);
  }
  const nomPropre = nom ? String(nom).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) : null;
  if (!u) {
    const couleur = COULEURS[Math.floor(Math.random() * COULEURS.length)];
    const id = db.prepare(
      "INSERT INTO users (email, display_name, password_hash, avatar_color, public_key, listed, distant_domaine, password_set) VALUES (?, ?, '!', ?, ?, 0, ?, 0)",
    ).run(p.adresse, nomPropre || p.adresse, couleur, cle, p.domaine).lastInsertRowid;
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }
  if (cle && u.public_key && cle !== u.public_key) {
    db.prepare("UPDATE users SET public_key = ?, cle_changee_le = datetime('now') WHERE id = ?").run(cle, u.id);
  } else if (cle && !u.public_key) {
    db.prepare('UPDATE users SET public_key = ? WHERE id = ?').run(cle, u.id);
  }
  if (nomPropre && nomPropre !== u.display_name) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(nomPropre, u.id);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
}

const estDistant = (userId) => !!db.prepare('SELECT distant_domaine FROM users WHERE id = ?').get(userId)?.distant_domaine;
export const idsDistants = (ids) => ids.filter(estDistant);

// ── Point d'entrée « cles » (servi aux autres serveurs) ─────────────────────
export function servirCles(adresses) {
  if (!Array.isArray(adresses) || adresses.length === 0 || adresses.length > LIMITES.destinatairesMax) {
    throw new ErreurFederation('Liste d\'adresses invalide.', 'requete');
  }
  const cles = {};
  const date = new Date().toISOString();
  for (const brute of adresses) {
    const p = decouper(brute);
    if (!p || p.domaine !== domaineLocal()) continue;
    const u = compteLocal(p.adresse);
    if (!u || !u.public_key) { cles[p.adresse] = null; continue; }
    const enr = { adresse: p.adresse, cle: u.public_key, date };
    cles[p.adresse] = { ...enr, nom: u.display_name, signature: signerAvecIdentite(texteCle(enr)) };
  }
  return { cles };
}

// ── Résolution des destinataires distants (pour Compose) ────────────────────
/**
 * @returns {Promise<{ trouves: object[], inconnus: string[], erreurs: {adresse, raison}[] }>}
 *   trouves  : destinataires chiffrables, avec de quoi vérifier leur clé côté client ;
 *   inconnus : pas de Comet à ce domaine, ou compte inexistant → envoi externe habituel ;
 *   erreurs  : un Comet existe mais l'échange est impossible (bloqué, clé de serveur
 *              changée, injoignable) — ne JAMAIS retomber en clair dans ce cas.
 */
export async function resoudreDistants(adresses) {
  const res = { trouves: [], inconnus: [], erreurs: [] };
  if (!federationActive()) { res.inconnus.push(...adresses); return res; }
  const parDomaine = new Map();
  for (const a of adresses) {
    const p = decouper(a);
    if (!p || !estDomaineDistant(p.domaine)) { res.inconnus.push(a); continue; }
    if (!parDomaine.has(p.domaine)) parDomaine.set(p.domaine, []);
    parDomaine.get(p.domaine).push(p.adresse);
  }
  await Promise.all([...parDomaine].map(async ([domaine, liste]) => {
    try {
      let serveur = await etablir(domaine);
      const { statut, json } = await appelSigne(domaine, '/v1/cles', { adresses: liste });
      if (statut !== 200 || !json || typeof json.cles !== 'object') throw new ErreurFederation(json?.error || `Réponse ${statut} de ${domaine}.`, 'reponse', 502);
      const atteste = (enr) => verifier(serveur.cle, texteCle(enr), enr.signature);
      // Une signature qui ne colle pas à la clé mémorisée : peut-être une rotation chez lui.
      // On relit son document UNE fois (la rotation n'est acceptée que signée).
      if (liste.some((a) => json.cles[a] && !atteste(json.cles[a]))) serveur = await etablir(domaine, { forcer: true });
      for (const adresse of liste) {
        const enr = json.cles[adresse];
        if (!enr) { res.inconnus.push(adresse); continue; }
        // Le serveur relaie, mais vérifie lui aussi : il ne stocke rien de non attesté.
        if (enr.adresse !== adresse || !atteste(enr)) {
          res.erreurs.push({ adresse, raison: `Clé de ${adresse} mal signée par ${domaine}.` }); continue;
        }
        const u = correspondant(adresse, { nom: enr.nom, cle: enr.cle });
        res.trouves.push({
          email: adresse, publicKey: enr.cle, online: false,
          federe: {
            domaine,
            nom: u.display_name,
            // `rotations` : toutes les rotations de ce serveur que nous avons acceptées, preuves
            // comprises. L'appareil qui a retenu une ancienne clé de ce serveur remonte lui-même
            // le chemin jusqu'à la clé actuelle (autrefois, seule la rotation du jour de la
            // découverte partait, puis plus rien : l'appareil restait bloqué).
            serveur: { cle: serveur.cle, empreinte: empreinte(serveur.cle), rotation: serveur.rotation || null, rotations: rotationsConnues(domaine) },
            enregistrement: { adresse: enr.adresse, cle: enr.cle, date: enr.date, signature: enr.signature },
            cleChangeeLe: u.cle_changee_le || null,
          },
        });
      }
    } catch (e) {
      if (e instanceof ErreurFederation && e.code === 'absent') res.inconnus.push(...liste);
      else for (const adresse of liste) res.erreurs.push({ adresse, raison: e.message });
    }
  }));
  return res;
}

// ── Envoi : mise en file ────────────────────────────────────────────────────
const idGlobal = () => `comet:${randomUUID()}@${domaineLocal()}`;

// Contrôles côté expéditeur, AVANT d'écrire quoi que ce soit.
export function controlerEnvoi({ expediteur, ids, encrypted, cles = {}, programme = false, ephemere = false }) {
  const distants = idsDistants(ids);
  if (!distants.length) return [];
  if (!federationActive()) throw new ErreurFederation('La fédération n\'est pas active sur ce serveur.', 'inactive', 400);
  if (!adresseDe(expediteur)) throw new ErreurFederation('Votre compte n\'a pas d\'adresse joignable depuis les autres serveurs.', 'sans_adresse', 400);
  if (!encrypted) throw new ErreurFederation('Le courrier vers un autre serveur Comet est toujours chiffré.', 'non_chiffre', 400);
  if (programme || ephemere) throw new ErreurFederation('Envoi programmé et messages éphémères ne sont pas encore possibles vers un autre serveur.', 'option', 400);
  const parEmail = new Map(Object.entries(cles).map(([e, k]) => [String(e).toLowerCase(), k]));
  for (const id of distants) {
    const u = db.prepare('SELECT email FROM users WHERE id = ?').get(id);
    if (!parEmail.get(u.email)) throw new ErreurFederation(`Clé de message manquante pour ${u.email}.`, 'cle_manquante', 400);
  }
  return distants;
}

export function planifierEnvoi(messageId, expediteur) {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  if (!m) return 0;
  const dest = db.prepare(
    'SELECT r.kind, u.id, u.email, u.distant_domaine AS domaine FROM recipients r JOIN users u ON u.id = r.user_id WHERE r.message_id = ? ORDER BY r.id',
  ).all(messageId);
  const distants = dest.filter((d) => d.domaine);
  if (!distants.length) return 0;

  // Identifiant global : garde le fil d'un serveur à l'autre et rend la relivraison sans effet.
  let ext = m.ext_message_id;
  if (!ext) { ext = idGlobal(); db.prepare('UPDATE messages SET ext_message_id = ? WHERE id = ?').run(ext, messageId); }
  const parent = m.in_reply_to ? db.prepare('SELECT ext_message_id FROM messages WHERE id = ?').get(m.in_reply_to) : null;

  // Les adresses telles que les verront les destinataires : comptes locaux sous leur
  // adresse fédérée, correspondants distants tels quels.
  const vue = (d) => (d.domaine ? d.email : adresseDe(db.prepare('SELECT * FROM users WHERE id = ?').get(d.id)) || null);
  const a = dest.filter((d) => d.kind !== 'cc').map(vue).filter(Boolean);
  const cc = dest.filter((d) => d.kind === 'cc').map(vue).filter(Boolean);

  const parDomaine = new Map();
  for (const d of distants) {
    if (!parDomaine.has(d.domaine)) parDomaine.set(d.domaine, []);
    parDomaine.get(d.domaine).push(d);
  }
  const maintenant = Date.now();
  const ins = db.prepare('INSERT INTO federation_envois (message_id, expediteur_id, domaine, charge, prochain_essai, cree_le) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [domaine, liste] of parDomaine) {
    const cles = {};
    for (const d of liste) {
      const k = db.prepare('SELECT enc_key FROM message_keys WHERE message_id = ? AND user_id = ?').get(messageId, d.id);
      if (k) cles[d.email] = k.enc_key;
    }
    const charge = {
      v: 1,
      id: ext,
      enReponseA: parent?.ext_message_id || null,
      de: { adresse: adresseDe(expediteur), nom: expediteur.display_name, cle: expediteur.public_key },
      a, cc,
      envoyeLe: new Date().toISOString(),
      chiffre: { ciphertext: m.ciphertext, iv: m.iv },
      cles,
    };
    ins.run(messageId, expediteur.id, domaine, JSON.stringify(charge), maintenant, maintenant);
  }
  setImmediate(() => { traiterFile().catch((e) => console.error('[federation] file :', e.message)); });
  return parDomaine.size;
}

// ── File d'envoi ────────────────────────────────────────────────────────────
function nonRemis(expediteurId, adresses, raison) {
  const sys = db.prepare('SELECT id FROM users WHERE email = ?').get(SYSTEM_EMAIL);
  if (!sys || !adresses.length) return;
  try {
    deliverMessage({
      senderId: sys.id, to: [expediteurId], copyToSender: false,
      subject: `Non remis : ${adresses.join(', ')}`,
      body: `Votre message chiffré n'a pas pu être remis à ${adresses.join(', ')}.\n\nRaison : ${raison}`,
    });
  } catch (e) { console.error('[federation] avis de non-remise :', e.message); }
}

const delaiApres = (tentatives) => Math.min(30_000 * 2 ** tentatives, 3600_000);
let enCours = null;

// Traite les envois dus. Réentrant sans risque : un seul passage à la fois.
export function traiterFile() {
  if (enCours) return enCours;
  enCours = (async () => {
    const dus = db.prepare("SELECT * FROM federation_envois WHERE etat = 'attente' AND prochain_essai <= ? ORDER BY id LIMIT 50").all(Date.now());
    for (const e of dus) await essayer(e);
  })().finally(() => { enCours = null; });
  return enCours;
}

async function essayer(e) {
  const charge = JSON.parse(e.charge);
  const destinataires = Object.keys(charge.cles);
  const finir = (etat, erreur) => db.prepare('UPDATE federation_envois SET etat = ?, derniere_erreur = ?, tentatives = tentatives + 1 WHERE id = ?').run(etat, erreur, e.id);
  try {
    const { statut, json } = await appelSigne(e.domaine, '/v1/livraison', charge);
    if (statut === 200 && json) {
      finir('livre', null);
      const refuses = Array.isArray(json.refuses) ? json.refuses : [];
      if (refuses.length) nonRemis(e.expediteur_id, refuses.map((r) => r.adresse), refuses.map((r) => `${r.adresse} : ${r.raison}`).join(' ; '));
      return;
    }
    // Refus définitif (requête jugée invalide, serveur qui nous bloque, trop gros).
    if ([400, 403, 413].includes(statut)) {
      finir('echec', json?.error || `refus ${statut}`);
      nonRemis(e.expediteur_id, destinataires, json?.error || `refusé par ${e.domaine} (${statut})`);
      return;
    }
    throw new Error(json?.error || `réponse ${statut}`);
  } catch (err) {
    const tentatives = e.tentatives + 1;
    if (Date.now() - e.cree_le > LIMITES.essaisPendant || (err instanceof ErreurFederation && err.code === 'bloque')) {
      finir('echec', err.message);
      nonRemis(e.expediteur_id, destinataires, err.message);
      return;
    }
    db.prepare('UPDATE federation_envois SET tentatives = ?, prochain_essai = ?, derniere_erreur = ? WHERE id = ?')
      .run(tentatives, Date.now() + delaiApres(tentatives), String(err.message || err).slice(0, 500), e.id);
  }
}

let minuterie = null;
export function demarrerFile(intervalleMs = 15_000) {
  if (minuterie || !federationActive()) return;
  minuterie = setInterval(() => { traiterFile().catch((e) => console.error('[federation] file :', e.message)); }, intervalleMs);
  minuterie.unref?.();
}

// ── Réception ───────────────────────────────────────────────────────────────
const chaine = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

export function recevoirLivraison(emetteur, c) {
  if (!c || c.v !== 1 || typeof c !== 'object') throw new ErreurFederation('Livraison illisible.', 'requete');
  if (!chaine(c.id, 200) || !c.id.startsWith('comet:') || !c.id.endsWith(`@${emetteur}`)) throw new ErreurFederation('Identifiant de message invalide.', 'requete');
  const de = c.de || {};
  const pDe = decouper(de.adresse);
  // Un serveur ne parle QUE pour ses propres comptes.
  if (!pDe || pDe.domaine !== emetteur) throw new ErreurFederation(`L'expéditeur doit être une adresse de ${emetteur}.`, 'usurpation', 403);
  if (!chaine(de.cle, 2000)) throw new ErreurFederation('Clé de l\'expéditeur manquante.', 'requete');
  const a = Array.isArray(c.a) ? c.a : [];
  const cc = Array.isArray(c.cc) ? c.cc : [];
  if (a.length + cc.length === 0 || a.length + cc.length > LIMITES.destinatairesMax) throw new ErreurFederation('Destinataires invalides.', 'requete');
  if (![...a, ...cc].every((x) => chaine(x, 320))) throw new ErreurFederation('Destinataires invalides.', 'requete');
  const ch = c.chiffre || {};
  if (!chaine(ch.ciphertext, LIMITES.corpsMax) || !chaine(ch.iv, 64)) throw new ErreurFederation('Contenu chiffré manquant.', 'requete');
  const cles = c.cles && typeof c.cles === 'object' ? c.cles : {};

  const local = domaineLocal();
  const acceptes = []; const refuses = [];
  const vus = new Set();
  for (const [liste, kind] of [[a, 'to'], [cc, 'cc']]) {
    for (const brute of liste) {
      const p = decouper(brute);
      if (!p || p.domaine !== local || vus.has(p.adresse)) continue;
      vus.add(p.adresse);
      const u = compteLocal(p.adresse);
      const k = cles[p.adresse];
      if (!u) refuses.push({ adresse: p.adresse, raison: 'compte inconnu' });
      else if (!chaine(k, 2000)) refuses.push({ adresse: p.adresse, raison: 'clé de message manquante' });
      else acceptes.push({ adresse: p.adresse, user: u, kind, cle: k });
    }
  }

  // Relivraison (réponse perdue, nouvel essai) : sans effet, même réponse.
  const deja = db.prepare('SELECT id FROM messages WHERE ext_message_id = ?').get(c.id);
  if (deja) return { acceptes: acceptes.map((x) => x.adresse), refuses, deja: true };
  if (!acceptes.length) return { acceptes: [], refuses };

  const exp = correspondant(pDe.adresse, { nom: de.nom, cle: de.cle });
  let threadId = randomUUID(); let parentId = null;
  if (chaine(c.enReponseA, 200)) {
    const parent = db.prepare('SELECT id, thread_id FROM messages WHERE ext_message_id = ?').get(c.enReponseA);
    if (parent) { threadId = parent.thread_id; parentId = parent.id; }
  }

  db.exec('BEGIN');
  let items = [];
  try {
    const mid = db.prepare(
      "INSERT INTO messages (thread_id, sender_id, subject, body, in_reply_to, is_sent, is_encrypted, ciphertext, iv, ext_message_id, fed_entete) VALUES (?, ?, '', '', ?, 1, 1, ?, ?, ?, ?)",
    ).run(threadId, exp.id, parentId, ch.ciphertext, ch.iv, c.id, JSON.stringify({ a, cc })).lastInsertRowid;
    const insR = db.prepare('INSERT INTO recipients (message_id, user_id, kind) VALUES (?, ?, ?)');
    const insK = db.prepare('INSERT OR IGNORE INTO message_keys (message_id, user_id, enc_key) VALUES (?, ?, ?)');
    const insI = db.prepare("INSERT INTO mail_items (user_id, message_id, folder, is_read) VALUES (?, ?, 'inbox', 0)");
    const servis = new Set();
    for (const x of acceptes) {
      insR.run(mid, x.user.id, x.kind);
      insK.run(mid, x.user.id, x.cle);
      if (!servis.has(x.user.id)) { items.push([x.user.id, insI.run(x.user.id, mid).lastInsertRowid]); servis.add(x.user.id); }
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }

  for (const [uid, itemId] of items) {
    applyRules(uid, exp.id, itemId);
    suivreLivraison(uid, itemId);
    notifyUser(uid, { type: 'mail:new' });
  }
  return { acceptes: acceptes.map((x) => x.adresse), refuses };
}

// ── État (pour l'interface) ─────────────────────────────────────────────────
export function etatPour(user) {
  if (!federationActive()) return { active: false };
  let id = null; let erreur = null;
  try { id = identite(); } catch (e) { erreur = e.message; }
  return {
    active: !erreur,
    domaine: domaineLocal(),
    adresse: adresseDe(user),
    empreinteServeur: id ? empreinte(id.clePublique) : null,
    erreur,
  };
}
