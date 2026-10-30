// Fédération — les autres serveurs : découverte, mémorisation de leur clé (TOFU),
// rotation, politique d'admission, et vérification des requêtes qu'ils nous signent.
import { createPublicKey } from 'node:crypto';
import { db } from '../db.js';
import {
  domaineLocal, mode, pairsAdmis, bloquesParConfig, hotesDeclares, debitParMinute, LIMITES, DOMAINE_VALIDE,
} from './config.js';
import { appeler, lireJson, ErreurReseau } from './reseau.js';
import {
  chaineCanonique, verifier, digestCorrespond, digestDe, nouveauNonce, texteRotation, empreinte,
} from './signature.js';
import { identite, signerAvecIdentite } from './identite.js';
import './schema.js';

export class ErreurFederation extends Error {
  constructor(message, code, statut = 400) { super(message); this.code = code; this.statut = statut; }
}

// ── Où joindre un domaine ───────────────────────────────────────────────────
function baseDe(domaine) {
  const declare = hotesDeclares().get(domaine);
  if (declare) return { base: declare, autoriserPrive: true };
  return { base: `https://${domaine}`, autoriserPrive: false };
}

const estCleEd25519 = (b64) => {
  try { return createPublicKey({ key: Buffer.from(String(b64), 'base64'), format: 'der', type: 'spki' }).asymmetricKeyType === 'ed25519'; }
  catch { return false; }
};

// ── Découverte (/.well-known/comet) ─────────────────────────────────────────
const cacheDoc = new Map(); // domaine → { doc|null, raison, quand }
export const oublierCaches = () => { cacheDoc.clear(); debit.clear(); };

export async function decouvrir(domaine, { forcer = false } = {}) {
  domaine = String(domaine || '').toLowerCase();
  if (!DOMAINE_VALIDE.test(domaine)) throw new ErreurFederation('Domaine invalide.', 'domaine');
  const c = cacheDoc.get(domaine);
  if (c && !forcer) {
    const vie = c.doc ? LIMITES.cacheDecouverte : LIMITES.cacheAbsent;
    if (Date.now() - c.quand < vie) {
      if (c.doc) return c.doc;
      throw new ErreurFederation(c.raison, 'absent', 404);
    }
  }
  const { base, autoriserPrive } = baseDe(domaine);
  let rep;
  try {
    rep = await appeler(`${base}/.well-known/comet`, { entetes: { accept: 'application/json' }, autoriserPrive });
  } catch (e) {
    // Injoignable ≠ absent : on ne retient PAS l'échec (une panne passagère ne doit pas
    // faire basculer une adresse vers l'envoi en clair pendant une heure).
    throw new ErreurFederation(`Serveur ${domaine} injoignable : ${e.message}`, e instanceof ErreurReseau && e.code === 'adresse' ? 'adresse' : 'injoignable', 502);
  }
  const doc = rep.statut === 200 ? lireJson(rep) : null;
  if (!doc || doc.comet !== 1) {
    cacheDoc.set(domaine, { doc: null, raison: `Aucun serveur Comet à ${domaine}.`, quand: Date.now() });
    throw new ErreurFederation(`Aucun serveur Comet à ${domaine}.`, 'absent', 404);
  }
  // Le document doit parler de CE domaine, avec une clé Ed25519, et livrer sur le MÊME
  // hôte que celui qu'on vient d'interroger : sinon un document publié ailleurs (ou par
  // un relais) pourrait détourner le courrier vers un tiers.
  let api;
  try { api = new URL(String(doc.api || '')); } catch { api = null; }
  const origine = new URL(base).origin;
  if (String(doc.domaine || '').toLowerCase() !== domaine) throw new ErreurFederation(`Le serveur ${domaine} se présente sous un autre nom.`, 'document', 502);
  if (!estCleEd25519(doc.cle)) throw new ErreurFederation(`Clé de ${domaine} invalide.`, 'document', 502);
  if (!api || api.origin !== origine) throw new ErreurFederation(`Adresse de livraison de ${domaine} hors de son hôte.`, 'document', 502);
  const propre = { domaine, cle: doc.cle, api: api.href.replace(/\/+$/, ''), rotation: doc.rotation || null, autoriserPrive };
  cacheDoc.set(domaine, { doc: propre, quand: Date.now() });
  return propre;
}

// ── Politique ───────────────────────────────────────────────────────────────
export const pair = (domaine) => db.prepare('SELECT * FROM federation_pairs WHERE domaine = ?').get(String(domaine).toLowerCase());

export function refusPolitique(domaine) {
  const m = mode();
  if (m === 'fermee') return 'La fédération est fermée sur ce serveur.';
  if (bloquesParConfig().has(domaine)) return `Le serveur ${domaine} est bloqué.`;
  if (m === 'liste' && !pairsAdmis().has(domaine)) return `Le serveur ${domaine} n'est pas sur la liste des serveurs admis.`;
  const p = pair(domaine);
  if (p && p.etat === 'bloque') return `Le serveur ${domaine} est bloqué.`;
  return null;
}

function verifierRotation(domaine, ancienne, doc) {
  const r = doc.rotation;
  return !!(r && r.ancienne === ancienne && typeof r.date === 'string'
    && verifier(ancienne, texteRotation({ domaine, nouvelle: doc.cle, date: r.date }), r.signature));
}

/**
 * Clé et adresse d'API d'un serveur distant, avec TOFU et rotation.
 * @returns {Promise<{ domaine, cle, api, autoriserPrive }>}
 */
export async function etablir(domaine, { forcer = false } = {}) {
  domaine = String(domaine || '').toLowerCase();
  if (domaine === domaineLocal()) throw new ErreurFederation('C\'est ce serveur.', 'soi');
  const refus = refusPolitique(domaine);
  if (refus) throw new ErreurFederation(refus, 'bloque', 403);

  const connu = pair(domaine);
  if (connu && connu.etat === 'actif' && !forcer) {
    const { autoriserPrive } = baseDe(domaine);
    return { domaine, cle: connu.cle, api: connu.api, autoriserPrive };
  }
  const doc = await decouvrir(domaine, { forcer });

  if (!connu) { // premier contact : on mémorise (TOFU)
    db.prepare('INSERT INTO federation_pairs (domaine, cle, api) VALUES (?, ?, ?)').run(domaine, doc.cle, doc.api);
    return doc;
  }
  if (doc.cle === connu.cle) {
    db.prepare("UPDATE federation_pairs SET api = ?, etat = 'actif', cle_proposee = NULL, vu_dernier = datetime('now') WHERE domaine = ?").run(doc.api, domaine);
    return doc;
  }
  if (connu.etat === 'actif' && verifierRotation(domaine, connu.cle, doc)) {
    db.prepare("UPDATE federation_pairs SET cle = ?, api = ?, cle_proposee = NULL, note = ?, vu_dernier = datetime('now') WHERE domaine = ?")
      .run(doc.cle, doc.api, `Rotation signée acceptée le ${new Date().toISOString()}`, domaine);
    return doc;
  }
  // Clé changée sans preuve : on gèle, l'admin tranche.
  db.prepare("UPDATE federation_pairs SET etat = 'cle_changee', cle_proposee = ?, vu_dernier = datetime('now') WHERE domaine = ?").run(doc.cle, domaine);
  console.warn(`[federation] ⚠ la clé de ${domaine} a changé sans rotation signée (ancienne ${empreinte(connu.cle)}, nouvelle ${empreinte(doc.cle)}) — échanges suspendus jusqu'à décision de l'admin.`);
  throw new ErreurFederation(`La clé du serveur ${domaine} a changé sans preuve : échanges suspendus jusqu'à vérification par l'administrateur.`, 'cle_changee', 403);
}

// ── Appel signé vers un autre serveur ───────────────────────────────────────
export async function appelSigne(domaine, chemin, objet) {
  const local = domaineLocal();
  const cible = await etablir(domaine);
  const corps = Buffer.from(JSON.stringify(objet));
  const date = new Date().toISOString();
  const nonce = nouveauNonce();
  const digest = digestDe(corps);
  const signature = signerAvecIdentite(chaineCanonique({ methode: 'POST', hote: domaine, chemin, emetteur: local, date, nonce, digest }));
  const rep = await appeler(`${cible.api}${chemin.replace(/^\/v1/, '')}`, {
    methode: 'POST',
    autoriserPrive: cible.autoriserPrive,
    corps,
    entetes: {
      'content-type': 'application/json',
      accept: 'application/json',
      'comet-emetteur': local,
      'comet-date': date,
      'comet-nonce': nonce,
      'content-digest': digest,
      'comet-signature': signature,
    },
  });
  return { statut: rep.statut, json: lireJson(rep) };
}

// ── Vérification d'une requête entrante ─────────────────────────────────────
const debit = new Map(); // émetteur → horodatages (ms) de la dernière minute

function prendreJeton(emetteur) {
  const maintenant = Date.now();
  const t = (debit.get(emetteur) || []).filter((x) => maintenant - x < 60_000);
  if (t.length >= debitParMinute()) { debit.set(emetteur, t); return false; }
  t.push(maintenant); debit.set(emetteur, t);
  return true;
}

let dernierePurge = 0;
function retenirNonce(emetteur, nonce) {
  const maintenant = Date.now();
  if (maintenant - dernierePurge > 60_000) { db.prepare('DELETE FROM federation_nonces WHERE expire < ?').run(maintenant); dernierePurge = maintenant; }
  const r = db.prepare('INSERT OR IGNORE INTO federation_nonces (emetteur, nonce, expire) VALUES (?, ?, ?)').run(emetteur, nonce, maintenant + LIMITES.vieNonce);
  return r.changes === 1;
}

/**
 * Contrôle une requête signée ; renvoie le domaine émetteur authentifié.
 * Ordre : du moins coûteux au plus coûteux, et rien n'est écrit tant que la signature
 * n'est pas prouvée (un inconnu ne doit pas pouvoir remplir la table des nonces).
 */
export async function verifierRequete({ methode, chemin, entetes, corps }) {
  const h = (n) => String(entetes[n] || '');
  const emetteur = h('comet-emetteur').toLowerCase();
  const date = h('comet-date');
  const nonce = h('comet-nonce');
  const digest = h('content-digest');
  const signature = h('comet-signature');
  const local = domaineLocal();

  if (!emetteur || !date || !nonce || !digest || !signature) throw new ErreurFederation('Requête non signée.', 'non_signee', 401);
  if (!DOMAINE_VALIDE.test(emetteur) || emetteur === local) throw new ErreurFederation('Émetteur invalide.', 'emetteur', 401);
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw new ErreurFederation('Nonce invalide.', 'nonce', 401);
  const t = Date.parse(date);
  if (!Number.isFinite(t) || Math.abs(Date.now() - t) > LIMITES.derive) throw new ErreurFederation('Date hors de la fenêtre admise (horloge ou rejeu).', 'date', 401);
  const refus = refusPolitique(emetteur);
  if (refus) throw new ErreurFederation(refus, 'bloque', 403);
  if (!digestCorrespond(corps, digest)) throw new ErreurFederation('Le corps ne correspond pas à son empreinte.', 'digest', 401);

  const texte = chaineCanonique({ methode, hote: local, chemin, emetteur, date, nonce, digest });
  let cle = await etablir(emetteur);
  if (!verifier(cle.cle, texte, signature)) {
    // Peut-être une rotation chez lui : on relit son document une fois, puis on tranche.
    cle = await etablir(emetteur, { forcer: true });
    if (!verifier(cle.cle, texte, signature)) throw new ErreurFederation('Signature invalide.', 'signature', 401);
  }
  if (!retenirNonce(emetteur, nonce)) throw new ErreurFederation('Requête déjà reçue (rejeu).', 'rejeu', 409);
  if (!prendreJeton(emetteur)) throw new ErreurFederation('Trop de requêtes de ce serveur.', 'debit', 429);
  db.prepare("UPDATE federation_pairs SET vu_dernier = datetime('now') WHERE domaine = ?").run(emetteur);
  return emetteur;
}

// Document publié à /.well-known/comet.
export function documentPublic(baseUrl) {
  const id = identite();
  return {
    comet: 1,
    domaine: domaineLocal(),
    cle: id.clePublique,
    empreinte: empreinte(id.clePublique),
    api: `${baseUrl}/api/federation/v1`,
    rotation: id.rotation,
  };
}
