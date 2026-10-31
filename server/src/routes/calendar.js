import { Router } from 'express';
import { db } from '../db.js';
import { authRequired } from '../auth.js';
import { voit } from '../services/visibilite.js';

const router = Router();
router.use(authRequired);

function emailToId(raw) {
  let e = String(raw || '').trim().toLowerCase();
  if (!e) return null;
  if (!e.includes('@')) e = `${e}@comet.mail`;
  return db.prepare('SELECT id FROM users WHERE email = ?').get(e)?.id || null;
}

function invitesOf(eventId) {
  return db.prepare(
    `SELECT u.id, u.email, u.display_name AS displayName, u.avatar_color AS avatarColor, ei.status
     FROM event_invites ei JOIN users u ON u.id = ei.user_id WHERE ei.event_id = ? ORDER BY u.display_name`
  ).all(eventId);
}

function setInvites(eventId, emails) {
  db.prepare('DELETE FROM event_invites WHERE event_id = ?').run(eventId);
  const ins = db.prepare('INSERT OR IGNORE INTO event_invites (event_id, user_id, status) VALUES (?, ?, ?)');
  for (const raw of emails || []) {
    const id = emailToId(raw);
    if (id) ins.run(eventId, id, 'pending');
  }
}

const roomView = (id) => (id ? db.prepare('SELECT id, name, location, color FROM rooms WHERE id = ?').get(id) || null : null);

// Conflit de salle : un autre événement réserve la même salle sur un créneau qui chevauche.
function roomConflict(roomId, startsAt, endsAt, excludeId = null) {
  if (!roomId) return null;
  let sql = 'SELECT id, title, starts_at AS startsAt, ends_at AS endsAt FROM events WHERE room_id = ? AND starts_at < ? AND ends_at > ?';
  const params = [roomId, endsAt, startsAt];
  if (excludeId) { sql += ' AND id != ?'; params.push(excludeId); }
  return db.prepare(sql).get(...params) || null;
}

const view = (e, meId, occ = null) => {
  const invites = invitesOf(e.id);
  const mine = invites.find((i) => i.id === meId);
  return {
    id: e.id, title: e.title, description: e.description, location: e.location,
    startsAt: occ ? occ.startsAt : e.starts_at,
    endsAt: occ ? occ.endsAt : e.ends_at,
    allDay: !!e.all_day, color: e.color,
    reminderMinutes: e.reminder_minutes || 0,
    isConference: !!e.is_conference,
    roomId: e.room_id || null, room: roomView(e.room_id),
    recurrence: e.recurrence && e.recurrence !== 'none' ? e.recurrence : null,
    recurrenceUntil: e.recurrence_until || null,
    isOccurrence: !!occ,
    seriesStartsAt: e.starts_at, seriesEndsAt: e.ends_at,
    ownerId: e.owner_id, isOwner: e.owner_id === meId,
    invitees: invites,
    myStatus: e.owner_id === meId ? 'owner' : (mine ? mine.status : null),
  };
};

const RECURRENCES = ['daily', 'weekly', 'monthly'];
const pad = (n) => String(n).padStart(2, '0');
const fmtLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const nextOcc = (d, rec) => { const n = new Date(d); if (rec === 'daily') n.setDate(n.getDate() + 1); else if (rec === 'weekly') n.setDate(n.getDate() + 7); else if (rec === 'monthly') n.setMonth(n.getMonth() + 1); return n; };

const exceptionsFor = (eventId) => {
  const map = {};
  for (const r of db.prepare('SELECT * FROM event_exceptions WHERE event_id = ?').all(eventId)) map[r.occ_date] = r;
  return map;
};

// Étend un événement en ses occurrences chevauchant [fromT, toT] (ms locaux).
function expand(e, meId, fromT, toT) {
  const rec = e.recurrence && e.recurrence !== 'none' ? e.recurrence : null;
  const start = new Date(e.starts_at.replace(' ', 'T'));
  const dur = new Date(e.ends_at.replace(' ', 'T')) - start;
  if (!rec || isNaN(start)) {
    return (start.getTime() + dur >= fromT && start.getTime() <= toT) ? [view(e, meId)] : [];
  }
  const untilT = e.recurrence_until ? Date.parse(e.recurrence_until + 'T23:59') : toT;
  const exceptions = exceptionsFor(e.id);
  const out = [];
  let occ = new Date(start);
  // Saut en masse jusqu'à proximité de `from` (reste O(occurrences dans la plage))
  if (occ.getTime() + dur < fromT) {
    if (rec === 'monthly') {
      const f = new Date(fromT);
      const md = (f.getFullYear() - occ.getFullYear()) * 12 + (f.getMonth() - occ.getMonth()) - 1;
      if (md > 0) occ.setMonth(occ.getMonth() + md);
    } else {
      const stepMs = rec === 'weekly' ? 604800000 : 86400000;
      const jumps = Math.floor((fromT - (occ.getTime() + dur)) / stepMs);
      if (jumps > 0) occ = new Date(occ.getTime() + jumps * stepMs);
    }
  }
  let guard = 0;
  while (occ.getTime() <= toT && occ.getTime() <= untilT && guard < 500) {
    guard++;
    const occEndT = occ.getTime() + dur;
    const occDate = fmtLocal(occ).slice(0, 10);
    const ex = exceptions[occDate];
    if (!ex) {
      if (occEndT >= fromT && occ.getTime() <= toT) out.push({ ...view(e, meId, { startsAt: fmtLocal(occ), endsAt: fmtLocal(new Date(occEndT)) }), occurrenceDate: occDate });
    } else if (!ex.cancelled) {
      // Occurrence modifiée : on applique les overrides + d'éventuels nouveaux horaires
      const oS = ex.starts_at || fmtLocal(occ);
      const oE = ex.ends_at || fmtLocal(new Date(occEndT));
      const sT = Date.parse(oS.replace(' ', 'T')), eT = Date.parse(oE.replace(' ', 'T'));
      if (eT >= fromT && sT <= toT) {
        const merged = { ...e, title: ex.title ?? e.title, description: ex.description ?? e.description, location: ex.location ?? e.location, color: ex.color ?? e.color };
        out.push({ ...view(merged, meId, { startsAt: oS, endsAt: oE }), isException: true, occurrenceDate: occDate });
      }
    } // ex.cancelled → on saute cette occurrence
    occ = nextOcc(occ, rec);
  }
  return out;
}

// ── Liste (événements possédés OU sur lesquels on est invité) ────────────────
router.get('/', async (req, res) => {
  const { from, to } = req.query;
  // Borne haute en SQL ; le filtre bas + l'expansion des récurrences se font en JS
  // (un événement récurrent peut commencer avant la plage et y projeter des occurrences).
  let sql = `SELECT DISTINCT e.* FROM events e
             LEFT JOIN event_invites ei ON ei.event_id = e.id AND ei.user_id = ?
             WHERE (e.owner_id = ? OR ei.user_id = ?)`;
  const params = [req.user.id, req.user.id, req.user.id];
  if (to) { sql += ' AND e.starts_at <= ?'; params.push(to); }
  sql += ' ORDER BY e.starts_at ASC';
  const fromT = from ? Date.parse((from.length <= 10 ? from + 'T00:00' : from).replace(' ', 'T')) : -Infinity;
  const toT = to ? Date.parse((to.length <= 10 ? to + 'T23:59' : to).replace(' ', 'T')) : Infinity;
  const events = [];
  for (const e of db.prepare(sql).all(...params)) events.push(...expand(e, req.user.id, fromT, toT));
  events.sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1));
  res.json({ events });
});

// ── Disponibilités (free/busy) des collègues sur une plage ───────────────────
// Disponibilités : créneaux occupés (heures seulement, jamais les titres) des seuls comptes
// dont on voit la présence — même organisation, ou personne ayant écrit dans un canal
// commun (services/visibilite.js). Pour tout autre adresse, la réponse est « inconnu »
// (null), exactement comme pour une adresse qui n'existe pas : on n'apprend même pas si
// elle a un compte.
export const FREEBUSY_MAX = 50;
router.get('/freebusy', (req, res) => {
  const emails = [...new Set(String(req.query.emails || '').split(',').map((e) => e.trim()).filter(Boolean))];
  if (emails.length > FREEBUSY_MAX) return res.status(400).json({ error: `Au plus ${FREEBUSY_MAX} adresses à la fois` });
  const { from, to } = req.query;
  const busy = {};
  for (const email of emails) {
    const id = emailToId(email);
    if (!id || !voit(req.user.id, id)) { busy[email] = null; continue; } // inconnu, ou non visible
    let sql = `SELECT e.starts_at AS startsAt, e.ends_at AS endsAt FROM events e
               LEFT JOIN event_invites ei ON ei.event_id = e.id AND ei.user_id = ?
               WHERE (e.owner_id = ? OR (ei.user_id = ? AND ei.status = 'accepted'))`;
    const p = [id, id, id];
    if (from) { sql += ' AND e.ends_at >= ?'; p.push(from); }
    if (to) { sql += ' AND e.starts_at <= ?'; p.push(to); }
    busy[email] = db.prepare(sql).all(...p);
  }
  res.json({ busy });
});

router.post('/', (req, res) => {
  const { title, description = '', location = '', startsAt, endsAt, allDay = false, color = '#4f46e5', invitees = [], reminderMinutes = 0, isConference = false, roomId = null } = req.body;
  if (!title || !startsAt || !endsAt) return res.status(400).json({ error: 'Titre, début et fin requis' });
  const reminder = Math.max(0, parseInt(reminderMinutes, 10) || 0);
  const room = roomId ? parseInt(roomId, 10) : null;
  const recurrence = RECURRENCES.includes(req.body.recurrence) ? req.body.recurrence : null;
  const recurrenceUntil = recurrence && req.body.recurrenceUntil ? String(req.body.recurrenceUntil).slice(0, 10) : null;
  const clash = roomConflict(room, startsAt, endsAt);
  if (clash) return res.status(409).json({ error: 'Salle déjà réservée sur ce créneau', conflict: { title: clash.title, startsAt: clash.startsAt, endsAt: clash.endsAt } });
  const info = db.prepare('INSERT INTO events (owner_id, title, description, location, starts_at, ends_at, all_day, color, reminder_minutes, is_conference, room_id, recurrence, recurrence_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.user.id, title, description, location, startsAt, endsAt, allDay ? 1 : 0, color, reminder, isConference ? 1 : 0, room, recurrence, recurrenceUntil);
  setInvites(info.lastInsertRowid, invitees);
  res.status(201).json({ event: view(db.prepare('SELECT * FROM events WHERE id = ?').get(info.lastInsertRowid), req.user.id) });
});

router.patch('/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM events WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
  if (!e) return res.status(404).json({ error: 'Événement introuvable (réservé au créateur)' });
  // Vérifie le conflit de salle avec les valeurs effectives (corps ou existant)
  if ('roomId' in req.body || 'startsAt' in req.body || 'endsAt' in req.body) {
    const room = ('roomId' in req.body) ? (req.body.roomId ? parseInt(req.body.roomId, 10) : null) : e.room_id;
    const start = req.body.startsAt || e.starts_at;
    const end = req.body.endsAt || e.ends_at;
    const clash = roomConflict(room, start, end, e.id);
    if (clash) return res.status(409).json({ error: 'Salle déjà réservée sur ce créneau', conflict: { title: clash.title, startsAt: clash.startsAt, endsAt: clash.endsAt } });
  }
  const map = { title: 'title', description: 'description', location: 'location', startsAt: 'starts_at', endsAt: 'ends_at', color: 'color' };
  const sets = [], params = [];
  for (const [k, col] of Object.entries(map)) if (k in req.body) { sets.push(`${col} = ?`); params.push(req.body[k]); }
  if ('allDay' in req.body) { sets.push('all_day = ?'); params.push(req.body.allDay ? 1 : 0); }
  if ('roomId' in req.body) { sets.push('room_id = ?'); params.push(req.body.roomId ? parseInt(req.body.roomId, 10) : null); }
  if ('reminderMinutes' in req.body) { sets.push('reminder_minutes = ?'); params.push(Math.max(0, parseInt(req.body.reminderMinutes, 10) || 0)); }
  if ('isConference' in req.body) { sets.push('is_conference = ?'); params.push(req.body.isConference ? 1 : 0); }
  if ('recurrence' in req.body) {
    const rec = RECURRENCES.includes(req.body.recurrence) ? req.body.recurrence : null;
    sets.push('recurrence = ?'); params.push(rec);
    sets.push('recurrence_until = ?'); params.push(rec && req.body.recurrenceUntil ? String(req.body.recurrenceUntil).slice(0, 10) : null);
  } else if ('recurrenceUntil' in req.body) {
    sets.push('recurrence_until = ?'); params.push(req.body.recurrenceUntil ? String(req.body.recurrenceUntil).slice(0, 10) : null);
  }
  // Reprogrammer le rappel si l'heure de début ou le rappel change
  if ('startsAt' in req.body || 'reminderMinutes' in req.body) sets.push('reminder_sent = 0');
  // Re-annoncer la salle si l'heure ou le drapeau conférence change
  if ('startsAt' in req.body || 'isConference' in req.body) sets.push('room_announced = 0');
  if (sets.length) { params.push(e.id); db.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).run(...params); }
  if (Array.isArray(req.body.invitees)) setInvites(e.id, req.body.invitees);
  res.json({ event: view(db.prepare('SELECT * FROM events WHERE id = ?').get(e.id), req.user.id) });
});

// ── Exception sur une occurrence (annuler ou modifier une seule répétition) ──
router.post('/:id/exception', (req, res) => {
  const e = db.prepare('SELECT * FROM events WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
  if (!e) return res.status(404).json({ error: 'Événement introuvable (réservé au créateur)' });
  if (!e.recurrence || e.recurrence === 'none') return res.status(400).json({ error: 'Événement non récurrent' });
  const date = String(req.body.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Date d'occurrence invalide" });
  // Conflit de salle pour une occurrence rééchelonnée (si on déplace l'occurrence avec salle)
  if (!req.body.cancelled && req.body.startsAt && req.body.endsAt && e.room_id) {
    const clash = roomConflict(e.room_id, req.body.startsAt, req.body.endsAt, e.id);
    if (clash) return res.status(409).json({ error: 'Salle déjà réservée sur ce créneau', conflict: { title: clash.title, startsAt: clash.startsAt, endsAt: clash.endsAt } });
  }
  db.prepare(`INSERT INTO event_exceptions (event_id, occ_date, cancelled, title, description, location, starts_at, ends_at, color)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(event_id, occ_date) DO UPDATE SET
                cancelled = excluded.cancelled, title = excluded.title, description = excluded.description,
                location = excluded.location, starts_at = excluded.starts_at, ends_at = excluded.ends_at, color = excluded.color`)
    .run(e.id, date, req.body.cancelled ? 1 : 0,
      req.body.title ?? null, req.body.description ?? null, req.body.location ?? null,
      req.body.startsAt ?? null, req.body.endsAt ?? null, req.body.color ?? null);
  res.json({ ok: true });
});

// ── RSVP (un invité accepte / refuse) ────────────────────────────────────────
router.patch('/:id/rsvp', (req, res) => {
  const status = ['accepted', 'declined', 'pending'].includes(req.body.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: 'Statut invalide' });
  const inv = db.prepare('SELECT * FROM event_invites WHERE event_id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!inv) return res.status(404).json({ error: 'Vous n\'êtes pas invité à cet événement' });
  db.prepare('UPDATE event_invites SET status = ? WHERE id = ?').run(status, inv.id);
  res.json({ event: view(db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id), req.user.id) });
});

router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM events WHERE id = ? AND owner_id = ?').run(req.params.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Événement introuvable' });
  res.json({ ok: true });
});

export default router;
