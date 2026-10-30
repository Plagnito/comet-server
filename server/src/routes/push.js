// Abonnement aux NOTIFICATIONS BUREAU (Web Push). Voir services/push.js pour le
// pourquoi : le WebSocket ne couvre que l'application ouverte ; le push couvre le
// reste, c'est-à-dire le moment où une notification sert vraiment.
import { Router } from 'express';
import { authRequired } from '../auth.js';
import { status, subscribe, unsubscribe, isConfigured, publicKey } from '../services/push.js';

const router = Router();
router.use(authRequired);

// La clé publique VAPID + l'état réel. Si le serveur n'a pas de clés, on le DIT
// (`configured:false` + motif) plutôt que de laisser le client tenter un abonnement
// voué à l'échec et afficher un interrupteur qui ne fait rien.
router.get('/config', (req, res) => {
  res.json({ ok: true, ...status(req.user.id) });
});

router.post('/subscribe', (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: 'Notifications hors application non configurées sur ce serveur.' });
  const r = subscribe(req.user.id, (req.body || {}).subscription || req.body);
  if (!r.ok) return res.status(400).json(r);
  res.json({ ok: true, publicKey: publicKey() });
});

router.post('/unsubscribe', (req, res) => {
  res.json(unsubscribe(req.user.id, (req.body || {}).endpoint));
});

export default router;
