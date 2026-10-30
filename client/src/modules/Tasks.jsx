import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Icon from '../components/Icon.jsx';

const fmtDue = (s) => (s ? new Date(s).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : null);
const RECUR_OPTS = [['', 'Ne se répète pas'], ['daily', 'Chaque jour'], ['weekly', 'Chaque semaine'], ['monthly', 'Chaque mois']];
const RECUR_LABEL = { daily: 'quotidienne', weekly: 'hebdomadaire', monthly: 'mensuelle' };

export default function Tasks() {
  const [tasks, setTasks] = useState([]);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [assignee, setAssignee] = useState('');
  const [recur, setRecur] = useState('');
  const [subFor, setSubFor] = useState(null); // id du parent pour lequel on ajoute une sous-tâche
  const [subTitle, setSubTitle] = useState('');

  function load() { api.get('/tasks').then((r) => setTasks(r.tasks)); }
  useEffect(() => { load(); }, []);

  async function add(e) {
    e.preventDefault();
    if (!title.trim()) return;
    await api.post('/tasks', { title, dueAt: due || null, assigneeEmail: assignee || null, recurrence: recur || null });
    setTitle(''); setDue(''); setAssignee(''); setRecur(''); load();
  }
  async function addSub(parentId, e) {
    e.preventDefault();
    if (!subTitle.trim()) return;
    await api.post('/tasks', { title: subTitle, parentId }); setSubTitle(''); setSubFor(null); load();
  }
  async function toggle(t) { await api.patch(`/tasks/${t.id}`, { completed: !t.completed }); load(); }
  async function togglePriority(t) { await api.patch(`/tasks/${t.id}`, { priority: t.priority ? 0 : 1 }); load(); }
  async function del(t) { await api.del(`/tasks/${t.id}`); load(); }

  const active = tasks.filter((t) => !t.completed).length;

  const row = (t, isSub) => (
    <div key={t.id} className={`task ${t.completed ? 'done' : ''}`} style={isSub ? { marginLeft: 34, borderLeft: '2px solid var(--border)', paddingLeft: 10 } : undefined}>
      <div className={`check ${t.completed ? 'on' : ''}`} onClick={() => toggle(t)}>{t.completed && <Icon name="check" size={13} strokeWidth={3} />}</div>
      <div className="t">
        <div className="ti">
          {t.priority ? <Icon name="flag" size={14} style={{ color: 'var(--danger)' }} /> : null}{t.title}
          {t.recurrence ? <Icon name="calendar" size={12} style={{ color: 'var(--accent)', marginLeft: 5 }} /> : null}
        </div>
        <div className="due">
          {t.recurrence && <>Récurrence {RECUR_LABEL[t.recurrence]}{(t.subTotal > 0 || t.dueAt || t.assignee || !t.mine) && ' · '}</>}
          {t.subTotal > 0 && <>{t.subDone}/{t.subTotal} sous-tâche(s){(t.dueAt || t.assignee || !t.mine) && ' · '}</>}
          {t.dueAt && <>Échéance : {fmtDue(t.dueAt)}</>}
          {t.dueAt && (t.assignee || !t.mine) && ' · '}
          {t.mine && t.assignee && <>Assignée à <b>{t.assignee.displayName}</b></>}
          {!t.mine && <>De <b>{t.owner?.displayName}</b></>}
        </div>
      </div>
      <button className="icon-btn" title="Priorité" onClick={() => togglePriority(t)} style={{ color: t.priority ? 'var(--danger)' : undefined }}><Icon name="flag" size={16} filled={!!t.priority} /></button>
      {t.mine && <button className="icon-btn" title="Supprimer" onClick={() => del(t)}><Icon name="trash" size={16} /></button>}
    </div>
  );

  return (
    <div className="pane">
      <div className="pane-head"><h2>Tâches</h2><span className="meta">{active} en cours</span></div>

      <form className="add-row" onSubmit={add} style={{ flexWrap: 'wrap' }}>
        <input placeholder="Ajouter une tâche…" value={title} onChange={(e) => setTitle(e.target.value)} style={{ minWidth: 200 }} />
        <input placeholder="Assigner à (e-mail)" value={assignee} onChange={(e) => setAssignee(e.target.value)} style={{ flex: '0 0 200px' }} />
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} style={{ flex: '0 0 150px' }} />
        <select value={recur} onChange={(e) => setRecur(e.target.value)} style={{ flex: '0 0 160px' }} title="Récurrence">
          {RECUR_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <button className="btn"><Icon name="plus" size={16} /> Ajouter</button>
      </form>

      <div className="card">
        {tasks.length === 0 && <div className="empty">Aucune tâche pour le moment.</div>}
        {tasks.map((t) => (
          <div key={t.id}>
            {row(t, false)}
            {t.subtasks?.map((s) => row(s, true))}
            {t.mine && (subFor === t.id ? (
              <form onSubmit={(e) => addSub(t.id, e)} style={{ display: 'flex', gap: 6, margin: '4px 0 8px 34px' }}>
                <input autoFocus value={subTitle} onChange={(e) => setSubTitle(e.target.value)} placeholder="Nouvelle sous-tâche…" style={{ flex: 1 }} />
                <button className="btn">Ajouter</button>
                <button type="button" className="btn ghost" onClick={() => setSubFor(null)}>×</button>
              </form>
            ) : (
              <button type="button" className="subadd-btn" onClick={() => { setSubFor(t.id); setSubTitle(''); }} style={{ marginLeft: 34 }}>+ sous-tâche</button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
