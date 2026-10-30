import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
  getRoom, addParticipant, removeParticipant, setConfig,
  banKeyForUser, banKeyForGuest,
} from './services/confrooms.js';
import { JWT_SECRET as SECRET } from './config.js';
import { db } from './db.js';

const clients = new Map(); // userId -> Set<ws>

// ── Salons de conférence (signaling P2P en mémoire, éphémère) ────────────────
// room -> Map(peerId -> ws). Le serveur ne relaie que SDP/ICE ; les flux audio/
// vidéo passent en pair-à-pair (mesh) et ne touchent jamais le serveur.
const confSockets = new Map(); // roomId -> Map(peerId -> ws)
const randomPeerId = () => randomUUID().slice(0, 8);
export const confRoomCount = () => confSockets.size;

function confBroadcast(roomId, obj, exceptPeerId) {
  const r = confSockets.get(roomId);
  if (!r) return;
  const data = JSON.stringify(obj);
  for (const [pid, sock] of r) { if (pid !== exceptPeerId && sock.readyState === sock.OPEN) sock.send(data); }
}

function confJoin(ws, roomId, name) {
  if (!roomId) return;
  const room = getRoom(roomId);
  if (!room) { ws.send(JSON.stringify({ type: 'conf:error', code: 'room-not-found' })); return; }
  if (ws.isGuest && !room.config.linkEnabled) { ws.send(JSON.stringify({ type: 'conf:error', code: 'link-disabled' })); return; }
  if (!ws.isGuest && room.banned.has(banKeyForUser(ws.userId))) { ws.send(JSON.stringify({ type: 'conf:error', code: 'banned' })); return; }

  ws.peerId = ws.peerId || randomPeerId();
  ws.confName = String(name || ws.guestName || 'Invité').slice(0, 60);
  const isHost = !ws.isGuest && ws.userId === room.hostId;

  if (!confSockets.has(roomId)) confSockets.set(roomId, new Map());
  const sockets = confSockets.get(roomId);
  const peers = [...sockets.entries()]
    .filter(([pid]) => pid !== ws.peerId)
    .map(([pid, s]) => ({ peerId: pid, name: s.confName, host: !s.isGuest && s.userId === room.hostId }));
  sockets.set(ws.peerId, ws);
  addParticipant(room, ws.peerId, { name: ws.confName, guest: !!ws.isGuest, userId: ws.userId || null, host: isHost });
  (ws.confJoined || (ws.confJoined = new Set())).add(roomId);

  ws.send(JSON.stringify({ type: 'conf:peers', room: roomId, you: ws.peerId, isHost, config: room.config, peers }));
  confBroadcast(roomId, { type: 'conf:peer-join', room: roomId, peerId: ws.peerId, name: ws.confName, host: isHost }, ws.peerId);
}

function confLeave(ws, roomId) {
  const sockets = confSockets.get(roomId);
  if (!sockets || !ws.peerId) return;
  sockets.delete(ws.peerId);
  ws.confJoined?.delete(roomId);
  const room = getRoom(roomId);
  if (room) removeParticipant(room, ws.peerId);
  confBroadcast(roomId, { type: 'conf:peer-leave', room: roomId, peerId: ws.peerId });
  if (sockets.size === 0) confSockets.delete(roomId);
}

function confSignal(ws, roomId, to, data) {
  const target = confSockets.get(roomId)?.get(to);
  if (target && target.readyState === target.OPEN) target.send(JSON.stringify({ type: 'conf:signal', room: roomId, from: ws.peerId, data }));
}

// Exclure un participant (hôte uniquement).
function confKick(ws, roomId, targetPeerId) {
  const room = getRoom(roomId);
  if (!room || ws.isGuest || ws.userId !== room.hostId) return;
  const target = confSockets.get(roomId)?.get(targetPeerId);
  if (!target || target === ws) return;
  room.banned.add(target.isGuest ? banKeyForGuest(targetPeerId) : banKeyForUser(target.userId));
  try { target.send(JSON.stringify({ type: 'conf:kicked', room: roomId })); } catch {}
  confLeave(target, roomId);
}

// Modifier la config du salon (hôte uniquement) → diffusée à tous.
function confConfig(ws, roomId, patch) {
  const room = getRoom(roomId);
  if (!room || ws.isGuest || ws.userId !== room.hostId) return;
  const config = setConfig(room, patch || {});
  confBroadcast(roomId, { type: 'conf:config', room: roomId, config });
}

function add(userId, ws) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(ws);
}
function remove(userId, ws) {
  const set = clients.get(userId);
  if (!set) return false;
  set.delete(ws);
  if (set.size === 0) { clients.delete(userId); return true; }
  return false;
}

export const isOnline = (userId) => clients.has(userId);
export const onlineUserIds = () => [...clients.keys()];

// Types d'événements qui méritent une NOTIFICATION BUREAU quand Comet est fermé.
const PUSHABLE = new Set(['mail:new', 'mail:ext']);

export function notifyUser(userId, obj) {
  const set = clients.get(userId);
  const live = set && [...set].some((ws) => ws.readyState === ws.OPEN);
  if (live) {
    const data = JSON.stringify(obj);
    for (const ws of set) { if (ws.readyState === ws.OPEN) ws.send(data); }
    return;
  }
  // 🔴 AUCUN socket ouvert : l'utilisateur n'a pas Comet devant lui. C'est le seul
  // cas où l'on pousse une notification bureau — sinon un onglet en arrière-plan en
  // recevrait DEUX (celle de la page + celle du push) pour un unique message.
  if (!obj || !PUSHABLE.has(obj.type)) return;
  import('./services/push.js')
    .then((push) => push.pushToUser(userId, push.newMailPayload(obj.type === 'mail:ext' ? 'ext' : 'new')))
    .catch(() => { /* push indisponible : le mail arrive quand même, il sera vu à l'ouverture */ });
}

function broadcast(obj, exceptUserId) {
  const data = JSON.stringify(obj);
  for (const [uid, set] of clients) {
    if (uid === exceptUserId) continue;
    for (const ws of set) { if (ws.readyState === ws.OPEN) ws.send(data); }
  }
}

export function attachWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    let userId;
    try {
      const token = new URL(req.url, 'http://x').searchParams.get('token');
      const payload = jwt.verify(token, SECRET);
      if (payload.guest) {
        // Jeton invité : conférence uniquement (pas de présence ni de courrier).
        ws.isGuest = true;
        ws.guestRoom = String(payload.room || '');
        ws.guestName = String(payload.name || 'Invité');
      } else {
        if (payload.twofa === 'pending' || !payload.id) throw new Error('invalid');
        // Session révocable : un jeton dont la session a été révoquée ne doit plus ouvrir le WS.
        // Avant, jwt.verify suffisait → une session « révoquée » gardait le temps réel jusqu'à
        // l'expiration du JWT (~30 j). Même garde que authRequired (auth.js).
        if (payload.sid && !db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(payload.sid, payload.id)) throw new Error('revoked');
        userId = payload.id;
        ws.userId = userId;
      }
    } catch {
      ws.close(4001, 'auth'); return;
    }

    // Invité : socket conférence seulement, pas de présence ni d'état applicatif.
    if (ws.isGuest) {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('message', (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === 'conf:join') confJoin(ws, ws.guestRoom, msg.name); // un invité ne rejoint que SON salon
        else if (msg.type === 'conf:leave') confLeave(ws, ws.guestRoom);
        else if (msg.type === 'conf:signal' && msg.to) confSignal(ws, ws.guestRoom, String(msg.to), msg.data);
      });
      ws.on('close', () => { if (ws.confJoined) for (const room of [...ws.confJoined]) confLeave(ws, room); });
      return;
    }

    const wasOffline = !isOnline(userId);
    add(userId, ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.send(JSON.stringify({ type: 'presence:init', online: onlineUserIds() }));
    if (wasOffline) broadcast({ type: 'presence', userId, online: true }, userId);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'rtc:signal' && msg.to) {
        notifyUser(Number(msg.to), { type: 'rtc:signal', from: userId, data: msg.data });
      } else if (msg.type === 'conf:join') {
        confJoin(ws, String(msg.room || ''), msg.name);
      } else if (msg.type === 'conf:leave') {
        confLeave(ws, String(msg.room || ''));
      } else if (msg.type === 'conf:signal' && msg.to) {
        confSignal(ws, String(msg.room || ''), String(msg.to), msg.data);
      } else if (msg.type === 'conf:kick' && msg.to) {
        confKick(ws, String(msg.room || ''), String(msg.to));
      } else if (msg.type === 'conf:config') {
        confConfig(ws, String(msg.room || ''), msg.config);
      }
    });

    ws.on('close', () => {
      if (ws.confJoined) for (const room of [...ws.confJoined]) confLeave(ws, room);
      const wentOffline = remove(userId, ws);
      if (wentOffline) broadcast({ type: 'presence', userId, online: false }, userId);
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.isAlive === false) { client.terminate(); continue; }
      client.isAlive = false;
      try { client.ping(); } catch {}
    }
  }, 30_000);
  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}
