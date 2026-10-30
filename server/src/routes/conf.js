import { Router } from 'express';
import { authRequired } from '../auth.js';
import { createRoom, getRoom, setConfig, issueGuestToken, listActive, roomPublic } from '../services/confrooms.js';

const router = Router();

// Conférences en cours dans SON organisation (≥ 1 participant). Sans org : vide.
router.get('/rooms', authRequired, (req, res) => res.json({ rooms: listActive(req.user.org_id) }));

// Créer un salon (l'auteur en est l'hôte). Renvoie le lien d'invitation. L'org de
// l'hôte est attachée → le salon n'apparaît que pour ses collègues.
router.post('/rooms', authRequired, (req, res) => {
  const room = createRoom({ hostId: req.user.id, hostName: req.user.display_name || req.user.email, name: req.body?.name, hostOrgId: req.user.org_id || null });
  res.json({ room: roomPublic(room), isHost: true });
});

// Infos publiques d'un salon (page invité) — non sensible, pas d'auth.
router.get('/rooms/:id', (req, res) => {
  const room = getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'Salon introuvable ou terminé' });
  res.json({ room: roomPublic(room) });
});

// Config hôte : qualité vidéo/audio + activation des liens d'invitation.
router.patch('/rooms/:id', authRequired, (req, res) => {
  const room = getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'Salon introuvable' });
  if (room.hostId !== req.user.id) return res.status(403).json({ error: 'Réservé à l\'hôte' });
  res.json({ config: setConfig(room, req.body || {}) });
});

// Jeton invité (sans compte) — public, soumis à l'activation des liens.
router.post('/rooms/:id/guest', (req, res) => {
  const room = getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'Salon introuvable ou terminé' });
  if (!room.config.linkEnabled) return res.status(403).json({ error: 'Les invitations par lien sont désactivées' });
  const name = String(req.body?.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Indiquez un nom pour rejoindre' });
  res.json({ token: issueGuestToken(room, name), room: roomPublic(room), name });
});

export default router;
