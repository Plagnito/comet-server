import { Router } from 'express';
import { db } from '../db.js';
import { authRequired } from '../auth.js';
import {
  enregistrerAppareil, appareilsDe, oublierAppareil,
  accuserReception, enAttentePour, purgerCeQuiPeutLEtre,
  JOURS_AVANT_ABANDON,
} from '../services/remisedirecte.js';

// Les appareils d'un compte, et la remise directe qui s'appuie dessus.
// Le pourquoi et les limites exactes sont dans services/remisedirecte.js.
const router = Router();
router.use(authRequired);

router.get('/', (req, res) => {
  res.json({
    appareils: appareilsDe(req.user.id),
    remiseDirecte: !!db.prepare('SELECT remise_directe FROM users WHERE id = ?').get(req.user.id)?.remise_directe,
    joursAvantAbandon: JOURS_AVANT_ABANDON,
  });
});

/**
 * Un appareil se présente. Idempotent : la même clé rafraîchit la ligne existante
 * plutôt que d'en créer une seconde — sinon chaque lancement de l'application
 * ajouterait un appareil fantôme, et chaque fantôme retiendrait les purges.
 */
router.post('/', (req, res) => {
  const { cle, nom, plateforme } = req.body || {};
  const a = enregistrerAppareil(req.user.id, cle, nom, plateforme);
  if (!a) return res.status(400).json({ error: 'Identifiant d\'appareil manquant.' });
  res.json({ appareil: a });
});

router.delete('/:id', (req, res) => {
  if (!oublierAppareil(req.user.id, Number(req.params.id))) {
    return res.status(404).json({ error: 'Appareil introuvable' });
  }
  res.json({ ok: true });
});

/**
 * Active ou coupe la remise directe.
 *
 * L'activation ne touche PAS au courrier déjà reçu : elle ne vaut que pour ce qui
 * arrivera ensuite. Effacer rétroactivement ce que l'utilisateur n'a peut-être pas
 * encore lu sur un second appareil serait une mauvaise surprise irréversible.
 */
router.post('/remise-directe', (req, res) => {
  const actif = req.body?.actif === true;
  db.prepare('UPDATE users SET remise_directe = ? WHERE id = ?').run(actif ? 1 : 0, req.user.id);
  // En coupant l'option, les messages en attente n'ont plus de raison d'être suivis —
  // mais ils restent sur le serveur, ce qui est précisément ce que l'utilisateur demande.
  if (!actif) db.prepare('DELETE FROM remises WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true, remiseDirecte: actif });
});

/** Ce que cet appareil doit encore récupérer avant que le serveur ne l'oublie. */
router.get('/en-attente', (req, res) => {
  const cle = String(req.query.cle || '');
  if (!cle) return res.status(400).json({ error: 'Identifiant d\'appareil manquant.' });
  res.json({ items: enAttentePour(req.user.id, cle) });
});

/**
 * « Je les ai, tu peux oublier. »
 *
 * C'est le seul endroit qui déclenche l'effacement dans le cas courant. Un appareil ne
 * doit accuser réception qu'APRÈS avoir écrit le message sur son propre stockage :
 * accuser puis échouer à enregistrer, c'est perdre le message pour de bon.
 */
router.post('/recu', (req, res) => {
  const cle = String(req.body?.cle || '');
  const items = Array.isArray(req.body?.items) ? req.body.items.map(Number).filter(Number.isInteger) : [];
  if (!cle) return res.status(400).json({ error: 'Identifiant d\'appareil manquant.' });

  const r = accuserReception(req.user.id, cle, items);
  if (!r.ok) return res.status(404).json({ error: 'Appareil non enregistré.', code: r.erreur });
  res.json(r);
});

/** Balayage manuel — utile pour les tests et pour un bouton d'entretien. */
router.post('/purger', (req, res) => {
  res.json({ ok: true, purges: purgerCeQuiPeutLEtre(req.user.id) });
});

export default router;
