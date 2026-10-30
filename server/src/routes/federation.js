// Fédération entre serveurs Comet — routes.
//
//   GET  /.well-known/comet            identité publique de ce serveur (sans session)
//   POST /api/federation/v1/cles       clés des comptes      (signé par un serveur Comet)
//   POST /api/federation/v1/livraison  dépôt d'un message    (signé par un serveur Comet)
//   GET  /api/federation/etat          mon adresse fédérée, l'empreinte du serveur (session)
//   …/serveurs                         serveurs connus, blocage, changement de clé (admin)
//
// Les deux points d'entrée signés sont montés AVANT express.json : la signature porte sur
// le corps BRUT, octet pour octet — un JSON re-sérialisé ne se vérifierait plus.
import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { db } from '../db.js';
import { authRequired } from '../auth.js';
import { federationActive, mode, LIMITES, DOMAINE_VALIDE } from '../federation/config.js';
import { ErreurFederation, verifierRequete, documentPublic, pair, oublierCaches } from '../federation/pairs.js';
import { servirCles, recevoirLivraison, etatPour } from '../federation/service.js';
import { tournerIdentite } from '../federation/identite.js';
import { empreinte } from '../federation/signature.js';
import { domaineLocal } from '../federation/config.js';

const repondreErreur = (res, e) => {
  if (e instanceof ErreurFederation) return res.status(e.statut).json({ error: e.message, code: e.code });
  if (e && e.type === 'entity.too.large') return res.status(413).json({ error: 'Livraison trop volumineuse.', code: 'taille' });
  console.error('[federation]', e);
  return res.status(500).json({ error: 'Erreur interne de fédération.', code: 'interne' });
};

// ── /.well-known/comet ──────────────────────────────────────────────────────
export function wellKnown(req, res) {
  if (!federationActive()) return res.status(404).json({ error: 'Fédération inactive sur ce serveur.' });
  try {
    const base = `${req.protocol}://${req.get('host')}`;
    res.set('Cache-Control', 'public, max-age=300');
    res.set('Access-Control-Allow-Origin', '*');
    res.json(documentPublic(base));
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
}

// ── Entre serveurs ──────────────────────────────────────────────────────────
export const entreServeurs = Router();

// Premier rempart, avant toute vérification cryptographique : par adresse IP.
entreServeurs.use(rateLimit({
  windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Trop de requêtes.', code: 'debit' },
}));
entreServeurs.use((req, res, next) => {
  if (!federationActive() || mode() === 'fermee') return res.status(404).json({ error: 'Fédération inactive sur ce serveur.', code: 'inactive' });
  next();
});
entreServeurs.use(express.raw({ type: () => true, limit: LIMITES.corpsMax }));

const signe = (chemin, traiter) => async (req, res) => {
  try {
    const corps = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const emetteur = await verifierRequete({ methode: req.method, chemin, entetes: req.headers, corps });
    let objet;
    try { objet = JSON.parse(corps.toString('utf8')); } catch { throw new ErreurFederation('JSON invalide.', 'requete'); }
    res.json(await traiter(emetteur, objet));
  } catch (e) { repondreErreur(res, e); }
};

entreServeurs.post('/cles', signe('/v1/cles', (emetteur, o) => servirCles(o.adresses)));
entreServeurs.post('/livraison', signe('/v1/livraison', (emetteur, o) => recevoirLivraison(emetteur, o)));
entreServeurs.use((err, req, res, next) => repondreErreur(res, err)); // eslint-disable-line no-unused-vars

// ── Pour l'interface ────────────────────────────────────────────────────────
const router = Router();
router.use(authRequired);

router.get('/etat', (req, res) => res.json(etatPour(req.user)));

const admin = (req, res, next) => (req.user.is_admin ? next() : res.status(403).json({ error: 'Accès réservé aux administrateurs' }));

router.get('/serveurs', admin, (req, res) => {
  const lignes = db.prepare('SELECT * FROM federation_pairs ORDER BY vu_dernier DESC').all();
  const envois = db.prepare("SELECT domaine, etat, COUNT(*) AS n FROM federation_envois GROUP BY domaine, etat").all();
  res.json({
    mode: mode(),
    serveurs: lignes.map((p) => ({
      domaine: p.domaine, etat: p.etat, empreinte: empreinte(p.cle),
      empreinteProposee: p.cle_proposee ? empreinte(p.cle_proposee) : null,
      note: p.note, vuPremier: p.vu_premier, vuDernier: p.vu_dernier,
      envois: Object.fromEntries(envois.filter((e) => e.domaine === p.domaine).map((e) => [e.etat, e.n])),
    })),
  });
});

const domaineParam = (req) => {
  const d = String(req.params.domaine || '').toLowerCase();
  if (!DOMAINE_VALIDE.test(d)) throw new ErreurFederation('Domaine invalide.', 'domaine');
  return d;
};

// Bloquer un serveur — y compris un serveur encore jamais vu (ligne créée d'avance).
router.post('/serveurs/:domaine/bloquer', admin, (req, res) => {
  try {
    const d = domaineParam(req);
    if (pair(d)) db.prepare("UPDATE federation_pairs SET etat = 'bloque' WHERE domaine = ?").run(d);
    else db.prepare("INSERT INTO federation_pairs (domaine, cle, api, etat) VALUES (?, '', '', 'bloque')").run(d);
    oublierCaches();
    res.json({ ok: true });
  } catch (e) { repondreErreur(res, e); }
});

router.post('/serveurs/:domaine/debloquer', admin, (req, res) => {
  try {
    const d = domaineParam(req);
    const p = pair(d);
    if (!p) return res.status(404).json({ error: 'Serveur inconnu.' });
    // Bloqué avant tout contact : on oublie la ligne, le prochain contact refera le TOFU.
    if (!p.cle) db.prepare('DELETE FROM federation_pairs WHERE domaine = ?').run(d);
    else db.prepare("UPDATE federation_pairs SET etat = 'actif' WHERE domaine = ? AND etat = 'bloque'").run(d);
    oublierCaches();
    res.json({ ok: true });
  } catch (e) { repondreErreur(res, e); }
});

// Accepter la nouvelle clé d'un serveur — après avoir comparé son empreinte avec son
// administrateur. L'empreinte attendue est exigée : on accepte CETTE clé, pas « la
// dernière vue », qui aurait pu changer entre l'affichage et le clic.
router.post('/serveurs/:domaine/accepter-cle', admin, (req, res) => {
  try {
    const d = domaineParam(req);
    const p = pair(d);
    if (!p || p.etat !== 'cle_changee' || !p.cle_proposee) return res.status(409).json({ error: 'Aucun changement de clé en attente.' });
    if (String(req.body?.empreinte || '').replace(/\s+/g, '').toUpperCase() !== empreinte(p.cle_proposee).replace(/\s+/g, '')) {
      return res.status(409).json({ error: 'L\'empreinte ne correspond pas à la clé en attente.' });
    }
    db.prepare("UPDATE federation_pairs SET cle = cle_proposee, cle_proposee = NULL, etat = 'actif', note = ? WHERE domaine = ?")
      .run(`Nouvelle clé acceptée par ${req.user.email} le ${new Date().toISOString()}`, d);
    oublierCaches();
    res.json({ ok: true });
  } catch (e) { repondreErreur(res, e); }
});

// Rotation de la clé de CE serveur (signée par l'ancienne).
router.post('/identite/rotation', admin, (req, res) => {
  try {
    if (!domaineLocal()) return res.status(400).json({ error: 'Fédération inactive.' });
    const id = tournerIdentite(domaineLocal());
    res.json({ ok: true, empreinte: empreinte(id.clePublique) });
  } catch (e) { repondreErreur(res, e); }
});

export default router;
