import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import Icon from '../components/Icon.jsx';

const DOW = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
const EV_COLORS = ['#4f46e5', '#0d9488', '#ea580c', '#db2777', '#7c3aed'];
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayKey = keyOf(new Date());
const blankForm = (date) => ({ id: null, title: '', date, start: '09:00', end: '10:00', color: EV_COLORS[0], invitees: '', reminder: 0, isConference: false, roomId: '', recurrence: '', recurrenceUntil: '', occurrenceDate: null, scope: 'series', isOwner: true, myStatus: 'owner', inviteeList: [] });
const RECUR_OPTS = [['', 'Ne se répète pas'], ['daily', 'Tous les jours'], ['weekly', 'Toutes les semaines'], ['monthly', 'Tous les mois']];
const REMINDER_OPTS = [[0, 'Aucun'], [5, '5 min avant'], [10, '10 min avant'], [15, '15 min avant'], [30, '30 min avant'], [60, '1 h avant'], [120, '2 h avant'], [1440, '1 jour avant']];
const STATUS_LABEL = { pending: 'En attente', accepted: 'Accepté', declined: 'Refusé' };
const STATUS_COLOR = { pending: 'var(--muted)', accepted: '#16a34a', declined: 'var(--danger)' };

export default function Calendar() {
  const [cursor, setCursor] = useState(() => { const d = new Date(); d.setDate(1); return d; });
  const [events, setEvents] = useState([]);
  const [form, setForm] = useState(null);
  const [fb, setFb] = useState(null); // { email: 'free'|'busy'|'unknown' }
  const [rooms, setRooms] = useState([]);
  const [err, setErr] = useState('');
  useEffect(() => { api.get('/rooms').then((r) => setRooms(r.rooms)).catch(() => {}); }, []);

  const cells = useMemo(() => {
    const y = cursor.getFullYear(), m = cursor.getMonth();
    const startDow = (new Date(y, m, 1).getDay() + 6) % 7;
    return Array.from({ length: 42 }, (_, i) => new Date(y, m, 1 - startDow + i));
  }, [cursor]);

  function load() {
    const from = keyOf(cells[0]); const to = keyOf(cells[41]) + 'T23:59';
    api.get(`/calendar?from=${from}&to=${to}`).then((r) => setEvents(r.events));
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [cursor]);

  const byDay = useMemo(() => {
    const map = {};
    for (const e of events) (map[e.startsAt.slice(0, 10)] ||= []).push(e);
    return map;
  }, [events]);

  const splitEmails = (s) => String(s || '').split(/[,;\s]+/).filter(Boolean);

  const startsAtOf = (f) => `${f.date}T${f.start}`;
  const endsAtOf = (f) => `${f.date}T${f.end}`;
  const isRecurOcc = (f) => f.id && f.recurrence && f.occurrenceDate;

  async function submit(e) {
    e.preventDefault();
    if (!form.title.trim()) return;
    setErr('');
    try {
      if (isRecurOcc(form) && form.scope === 'occurrence') {
        // Modifier UNIQUEMENT cette occurrence (exception)
        await api.post(`/calendar/${form.id}/exception`, {
          date: form.occurrenceDate, title: form.title, color: form.color,
          startsAt: startsAtOf(form), endsAt: endsAtOf(form),
        });
      } else if (form.id) {
        // Série (ou événement simple). Pour une série, on ne réécrit pas l'horaire de base.
        const payload = {
          title: form.title, color: form.color, invitees: splitEmails(form.invitees),
          reminderMinutes: Number(form.reminder) || 0, isConference: !!form.isConference, roomId: form.roomId || null,
          recurrence: form.recurrence || null, recurrenceUntil: form.recurrence && form.recurrenceUntil ? form.recurrenceUntil : null,
        };
        if (!form.recurrence) { payload.startsAt = startsAtOf(form); payload.endsAt = endsAtOf(form); }
        await api.patch(`/calendar/${form.id}`, payload);
      } else {
        await api.post('/calendar', {
          title: form.title, color: form.color, startsAt: startsAtOf(form), endsAt: endsAtOf(form),
          invitees: splitEmails(form.invitees), reminderMinutes: Number(form.reminder) || 0,
          isConference: !!form.isConference, roomId: form.roomId || null,
          recurrence: form.recurrence || null, recurrenceUntil: form.recurrence && form.recurrenceUntil ? form.recurrenceUntil : null,
        });
      }
    } catch (e2) {
      if (e2.status === 409) { const c = e2.data?.conflict; setErr(`Salle déjà réservée${c ? ` (« ${c.title} »)` : ''} sur ce créneau.`); return; }
      setErr(e2.message); return;
    }
    setForm(null); setFb(null); load();
  }
  async function cancelOccurrence() {
    await api.post(`/calendar/${form.id}/exception`, { date: form.occurrenceDate, cancelled: true });
    setForm(null); setFb(null); load();
  }
  async function del() { await api.del(`/calendar/${form.id}`); setForm(null); setFb(null); load(); }
  async function rsvp(status) { const r = await api.patch(`/calendar/${form.id}/rsvp`, { status }); setForm((f) => ({ ...f, myStatus: r.event.myStatus, inviteeList: r.event.invitees })); load(); }

  async function checkFreeBusy() {
    const emails = splitEmails(form.invitees);
    if (!emails.length) { setFb({}); return; }
    const { busy } = await api.get(`/calendar/freebusy?emails=${encodeURIComponent(emails.join(','))}&from=${form.date}&to=${form.date}T23:59`);
    const start = `${form.date}T${form.start}`, end = `${form.date}T${form.end}`;
    const out = {};
    for (const email of emails) {
      const slots = busy[email];
      if (slots == null) { out[email] = 'unknown'; continue; }
      out[email] = slots.some((s) => s.startsAt < end && s.endsAt > start) ? 'busy' : 'free';
    }
    setFb(out);
  }

  function openEvent(e, ev) {
    e.stopPropagation();
    setFb(null); setErr('');
    // On charge l'occurrence cliquée ; le choix « cette occurrence / série » se fait dans le formulaire.
    setForm({
      id: ev.id, title: ev.title, date: ev.startsAt.slice(0, 10),
      start: ev.startsAt.slice(11, 16) || '09:00', end: ev.endsAt.slice(11, 16) || '10:00',
      color: ev.color, invitees: ev.invitees.map((i) => i.email).join(', '),
      reminder: ev.reminderMinutes || 0, isConference: !!ev.isConference, roomId: ev.roomId || '',
      recurrence: ev.recurrence || '', recurrenceUntil: ev.recurrenceUntil || '',
      occurrenceDate: ev.occurrenceDate || null, scope: ev.recurrence ? 'occurrence' : 'series',
      isOwner: ev.isOwner, myStatus: ev.myStatus, inviteeList: ev.invitees,
    });
  }

  const monthLabel = cursor.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  const shift = (n) => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + n, 1));
  const isInvitee = form && !form.isOwner;

  return (
    <div className="pane">
      <div className="cal-head">
        <h2>{monthLabel}</h2>
        <button className="icon-btn" onClick={() => shift(-1)}><Icon name="chevronLeft" size={16} /></button>
        <button className="btn ghost" onClick={() => { const d = new Date(); d.setDate(1); setCursor(d); }}>Aujourd'hui</button>
        <button className="icon-btn" onClick={() => shift(1)}><Icon name="chevronRight" size={16} /></button>
        <button className="btn" onClick={() => { setFb(null); setErr(''); setForm(blankForm(todayKey)); }}><Icon name="plus" size={16} /> Événement</button>
      </div>

      <div className="cal-grid">
        {DOW.map((d) => <div key={d} className="cal-dow">{d}</div>)}
        {cells.map((d) => {
          const k = keyOf(d);
          const out = d.getMonth() !== cursor.getMonth();
          const dayEvents = byDay[k] || [];
          return (
            <div key={k} className={`cal-cell ${out ? 'out' : ''} ${k === todayKey ? 'today' : ''}`} onClick={() => { setFb(null); setErr(''); setForm(blankForm(k)); }}>
              <div className="num">{d.getDate()}</div>
              {dayEvents.slice(0, 4).map((ev) => (
                <div key={ev.id} className="cal-ev" title={`${ev.title}${ev.room ? ` · ${ev.room.name}` : ''}${ev.invitees.length ? ` · ${ev.invitees.length} invité(s)` : ''}`}
                  style={{ background: ev.color, opacity: ev.myStatus === 'declined' ? 0.4 : 1, fontStyle: ev.myStatus === 'pending' ? 'italic' : 'normal' }}
                  onClick={(e) => openEvent(e, ev)}>
                  {ev.startsAt.slice(11, 16)} {ev.title}{ev.recurrence ? ' ↻' : ''}{!ev.isOwner ? ' ◂' : ''}
                </div>
              ))}
              {dayEvents.length > 4 && <div className="cal-more">+{dayEvents.length - 4} autre(s)</div>}
            </div>
          );
        })}
      </div>

      {form && (
        <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) { setForm(null); setFb(null); } }}>
          <form className="modal" onSubmit={submit}>
            <h3>{isInvitee ? form.title : form.id ? "Modifier l'événement" : 'Nouvel événement'}</h3>

            {isInvitee ? (
              <>
                <div className="setting-desc" style={{ fontSize: 13.5 }}>
                  {new Date(`${form.date}T${form.start}`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })} · {form.start}–{form.end}
                </div>
                <div className="setting-desc">Vous êtes invité(e). Votre réponse : <b style={{ color: STATUS_COLOR[form.myStatus] }}>{STATUS_LABEL[form.myStatus] || '—'}</b></div>
                <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
                  <button type="button" className="btn" style={{ background: '#16a34a' }} onClick={() => rsvp('accepted')}>Accepter</button>
                  <button type="button" className="btn" style={{ background: 'var(--danger)' }} onClick={() => rsvp('declined')}>Refuser</button>
                </div>
              </>
            ) : (
              <>
                <div className="field"><label>Titre *</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus /></div>
                {isRecurOcc(form) && (
                  <div className="field">
                    <label>Portée</label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" className={`btn ${form.scope === 'occurrence' ? '' : 'ghost'}`} style={{ flex: 1 }} onClick={() => setForm({ ...form, scope: 'occurrence' })}>Cette occurrence</button>
                      <button type="button" className={`btn ${form.scope === 'series' ? '' : 'ghost'}`} style={{ flex: 1 }} onClick={() => setForm({ ...form, scope: 'series' })}>Toute la série</button>
                    </div>
                    {form.scope === 'series' && <div className="setting-desc" style={{ marginTop: 4 }}>L'horaire de base de la série n'est pas modifié ici.</div>}
                  </div>
                )}
                <div className="field"><label>Date</label><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></div>
                <div className="row2">
                  <div className="field"><label>Début</label><input type="time" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} /></div>
                  <div className="field"><label>Fin</label><input type="time" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} /></div>
                </div>
                <div className="field" style={{ marginTop: 12 }}>
                  <label>Inviter (e-mails séparés par des virgules)</label>
                  <input value={form.invitees} onChange={(e) => setForm({ ...form, invitees: e.target.value })} placeholder="lea@comet.mail, marc@comet.mail" />
                </div>
                {splitEmails(form.invitees).length > 0 && (
                  <button type="button" className="btn ghost" style={{ marginTop: 8 }} onClick={checkFreeBusy}><Icon name="clock" size={15} /> Vérifier les disponibilités</button>
                )}
                <div className="field" style={{ marginTop: 12 }}>
                  <label><Icon name="bell" size={13} /> Rappel</label>
                  <select value={form.reminder} onChange={(e) => setForm({ ...form, reminder: Number(e.target.value) })}>
                    {REMINDER_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
                <label className="check-row" style={{ marginTop: 12 }}>
                  <input type="checkbox" checked={form.isConference} onChange={(e) => setForm({ ...form, isConference: e.target.checked })} />
                  <span><Icon name="video" size={13} /> Salle de conférence (créée automatiquement par le connecteur)</span>
                </label>
                {rooms.length > 0 && (
                  <div className="field" style={{ marginTop: 12 }}>
                    <label><Icon name="building" size={13} /> Salle de réunion</label>
                    <select value={form.roomId} onChange={(e) => setForm({ ...form, roomId: e.target.value })}>
                      <option value="">Aucune</option>
                      {rooms.map((rm) => <option key={rm.id} value={rm.id}>{rm.name}{rm.location ? ` — ${rm.location}` : ''}{rm.capacity ? ` (${rm.capacity}p)` : ''}</option>)}
                    </select>
                  </div>
                )}
                <div className="field" style={{ marginTop: 12 }}>
                  <label><Icon name="calendar" size={13} /> Récurrence</label>
                  <select value={form.recurrence} onChange={(e) => setForm({ ...form, recurrence: e.target.value })}>
                    {RECUR_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
                {form.recurrence && (
                  <div className="field" style={{ marginTop: 8 }}>
                    <label>Répéter jusqu'au (optionnel)</label>
                    <input type="date" value={form.recurrenceUntil} onChange={(e) => setForm({ ...form, recurrenceUntil: e.target.value })} />
                  </div>
                )}
                {form.recurrence && form.id && <div className="setting-desc" style={{ marginTop: 4 }}>Les modifications s'appliquent à toute la série.</div>}
                <div className="field" style={{ marginTop: 12 }}>
                  <label>Couleur</label>
                  <div className="swatch-row">
                    {EV_COLORS.map((c) => <button type="button" key={c} className="swatch-lg" onClick={() => setForm({ ...form, color: c })} style={{ background: c, outline: form.color === c ? '2px solid var(--text)' : 'none', outlineOffset: 2 }} />)}
                  </div>
                </div>
              </>
            )}

            {/* Disponibilités */}
            {fb && Object.keys(fb).length > 0 && (
              <div className="card" style={{ marginTop: 12, padding: '6px 0' }}>
                {Object.entries(fb).map(([email, st]) => (
                  <div key={email} className="alias-row" style={{ padding: '7px 12px' }}>
                    <span style={{ flex: 1, fontSize: 13 }}>{email}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: st === 'busy' ? 'var(--danger)' : st === 'free' ? '#16a34a' : 'var(--muted)' }}>
                      {st === 'busy' ? 'Occupé' : st === 'free' ? 'Libre' : 'Inconnu'}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Liste des invités + statuts */}
            {form.inviteeList && form.inviteeList.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <label className="setting-desc" style={{ fontWeight: 600 }}>Invités</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {form.inviteeList.map((i) => (
                    <span key={i.id} className="chip"><span style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_COLOR[i.status] }} />{i.displayName}</span>
                  ))}
                </div>
              </div>
            )}

            {err && <div className="alert" style={{ marginTop: 12 }}>{err}</div>}
            <div className="modal-foot">
              {form.id && form.isOwner && (isRecurOcc(form) ? (
                <span style={{ marginRight: 'auto', display: 'flex', gap: 6 }}>
                  <button type="button" className="icon-btn" style={{ color: 'var(--danger)' }} onClick={cancelOccurrence}><Icon name="trash" size={15} /> Cette occurrence</button>
                  <button type="button" className="icon-btn" style={{ color: 'var(--danger)' }} onClick={del}>La série</button>
                </span>
              ) : (
                <button type="button" className="icon-btn" style={{ marginRight: 'auto', color: 'var(--danger)' }} onClick={del}><Icon name="trash" size={16} /> Supprimer</button>
              ))}
              <button type="button" className="btn ghost" onClick={() => { setForm(null); setFb(null); }}>Fermer</button>
              {!isInvitee && <button className="btn">{form.id ? 'Enregistrer' : 'Créer'}</button>}
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
