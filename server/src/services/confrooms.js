// Registre des salons de conférence (en mémoire, éphémère).
// Métadonnées seulement : hôte, config (qualité/audio/lien), bannis, participants.
// Les flux A/V restent strictement pair-à-pair (jamais sur le serveur).
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { JWT_SECRET as SECRET } from '../config.js';

const rooms = new Map(); // id -> room
const EMPTY_TTL = 3 * 60 * 1000; // purge d'un salon vide après 3 min

const VIDEO = { '1080p': 1, '720p': 1, '480p': 1 };
const AUDIO = { high: 1, low: 1 };

export function createRoom({ hostId, hostName, name, hostOrgId }) {
  const id = randomUUID().slice(0, 10);
  const room = {
    id,
    name: String(name || 'Réunion').slice(0, 80),
    hostId,
    hostOrgId: hostOrgId || null,   // organisation de l'hôte → liste « en cours » scopée par org
    hostName: String(hostName || '').slice(0, 60),
    createdAt: Date.now(),
    emptyAt: Date.now(),
    config: { video: '720p', audio: 'high', linkEnabled: true },
    banned: new Set(),        // clés 'u:<userId>' ou 'g:<peerId>'
    participants: new Map(),  // peerId -> { name, guest, userId, host }
  };
  rooms.set(id, room);
  return room;
}

export const getRoom = (id) => rooms.get(id);

export function setConfig(room, patch = {}) {
  if (VIDEO[patch.video]) room.config.video = patch.video;
  if (AUDIO[patch.audio]) room.config.audio = patch.audio;
  if (typeof patch.linkEnabled === 'boolean') room.config.linkEnabled = patch.linkEnabled;
  return room.config;
}

export function addParticipant(room, peerId, info) { room.participants.set(peerId, info); }
export function removeParticipant(room, peerId) {
  room.participants.delete(peerId);
  if (room.participants.size === 0) room.emptyAt = Date.now();
}

export const banKeyForUser = (userId) => 'u:' + userId;
export const banKeyForGuest = (peerId) => 'g:' + peerId;

export function issueGuestToken(room, name) {
  return jwt.sign({ guest: true, room: room.id, name: String(name || 'Invité').slice(0, 40) }, SECRET, { expiresIn: '4h' });
}

// Conférences en cours (≥ 1 participant) — visibles UNIQUEMENT au sein de la même
// organisation. Sans org (orgId falsy) : aucune conférence d'équipe listée.
export function listActive(orgId) {
  if (!orgId) return [];
  return [...rooms.values()]
    .filter((r) => r.participants.size > 0 && r.hostOrgId === orgId)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((r) => ({ id: r.id, name: r.name, hostName: r.hostName, count: r.participants.size, createdAt: r.createdAt, linkEnabled: r.config.linkEnabled }));
}

// Vue publique (page invité) — rien de sensible.
export const roomPublic = (r) => ({
  id: r.id, name: r.name, hostName: r.hostName,
  config: { video: r.config.video, audio: r.config.audio }, linkEnabled: r.config.linkEnabled,
});

const timer = setInterval(() => {
  const now = Date.now();
  for (const [id, r] of rooms) if (r.participants.size === 0 && now - r.emptyAt > EMPTY_TTL) rooms.delete(id);
}, 60 * 1000);
timer.unref?.();
