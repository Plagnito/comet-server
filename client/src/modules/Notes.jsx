import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Icon from '../components/Icon.jsx';

const COLORS = ['#fff3b0', '#ffd6e0', '#d0f4de', '#cde7ff', '#e8d9ff', '#ffe0c2'];

export default function Notes({ query }) {
  const [notes, setNotes] = useState([]);

  useEffect(() => {
    const qs = query ? `?q=${encodeURIComponent(query)}` : '';
    api.get(`/notes${qs}`).then((r) => setNotes(r.notes));
  }, [query]);

  async function add() {
    const r = await api.post('/notes', { title: '', body: '', color: COLORS[Math.floor(Math.random() * COLORS.length)] });
    setNotes((n) => [r.note, ...n]);
  }
  const patchLocal = (id, f) => setNotes((n) => n.map((x) => (x.id === id ? { ...x, ...f } : x)));
  async function save(id, f) {
    const r = await api.patch(`/notes/${id}`, f);
    setNotes((n) => n.map((x) => (x.id === id ? r.note : x)));
  }
  async function del(id) {
    await api.del(`/notes/${id}`);
    setNotes((n) => n.filter((x) => x.id !== id));
  }

  return (
    <div className="pane">
      <div className="pane-head"><h2>Notes</h2><button className="btn" onClick={add}><Icon name="plus" size={16} /> Nouvelle note</button></div>

      {notes.length === 0 && <div className="empty">{query ? 'Aucune note pour cette recherche.' : 'Aucune note. Créez votre premier pense-bête.'}</div>}

      <div className="notes-grid">
        {notes.map((n) => (
          <div key={n.id} className="note" style={{ background: n.color }}>
            <input className="nt" placeholder="Titre" defaultValue={n.title}
              onChange={(e) => patchLocal(n.id, { title: e.target.value })}
              onBlur={(e) => save(n.id, { title: e.target.value })} />
            <textarea className="nb" placeholder="Écrire…" defaultValue={n.body}
              onChange={(e) => patchLocal(n.id, { body: e.target.value })}
              onBlur={(e) => save(n.id, { body: e.target.value })} />
            <div className="nf">
              <button className="nbtn" title={n.pinned ? 'Désépingler' : 'Épingler'} onClick={() => save(n.id, { pinned: !n.pinned })} style={{ color: n.pinned ? 'var(--accent)' : undefined }}><Icon name="pin" size={15} filled={!!n.pinned} /></button>
              {COLORS.map((c) => (
                <button key={c} className="swatch" onClick={() => save(n.id, { color: c })} style={{ background: c, border: n.color === c ? '2px solid rgba(15,23,42,.55)' : '1px solid rgba(15,23,42,.18)' }} />
              ))}
              <button className="nbtn" title="Supprimer" onClick={() => del(n.id)} style={{ marginLeft: 'auto' }}><Icon name="trash" size={15} /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
