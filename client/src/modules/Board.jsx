import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Icon from '../components/Icon.jsx';

const COLUMNS = [
  { key: 'todo', label: 'À faire', color: '#64748b' },
  { key: 'doing', label: 'En cours', color: '#4f46e5' },
  { key: 'done', label: 'Terminé', color: '#16a34a' },
];
const ORDER = COLUMNS.map((c) => c.key);

export default function Board() {
  const [cards, setCards] = useState([]);
  const [draft, setDraft] = useState({ todo: '', doing: '', done: '' });

  useEffect(() => { api.get('/board').then((r) => setCards(r.cards)); }, []);

  async function add(status) {
    const title = (draft[status] || '').trim();
    if (!title) return;
    const r = await api.post('/board', { title, status });
    setCards((c) => [...c, r.card]);
    setDraft((d) => ({ ...d, [status]: '' }));
  }
  async function move(card, dir) {
    const i = ORDER.indexOf(card.status) + dir;
    if (i < 0 || i >= ORDER.length) return;
    const r = await api.patch(`/board/${card.id}`, { status: ORDER[i] });
    setCards((list) => list.map((x) => (x.id === card.id ? r.card : x)));
  }
  async function del(card) {
    await api.del(`/board/${card.id}`);
    setCards((list) => list.filter((x) => x.id !== card.id));
  }

  return (
    <div className="pane">
      <div className="pane-head"><h2>Tableau</h2><span className="meta">{cards.length} carte(s)</span></div>
      <div className="board">
        {COLUMNS.map((col, ci) => {
          const colCards = cards.filter((c) => c.status === col.key);
          return (
            <div key={col.key} className="board-col">
              <div className="board-col-head">
                <span className="dot" style={{ background: col.color }} />
                {col.label}
                <span className="board-count">{colCards.length}</span>
              </div>
              <div className="board-cards">
                {colCards.map((c) => (
                  <div key={c.id} className="board-card">
                    <div className="bc-title">{c.title}</div>
                    <div className="bc-actions">
                      {ci > 0 && <button className="bc-btn" title="Reculer" onClick={() => move(c, -1)}><Icon name="chevronLeft" size={14} /></button>}
                      {ci < COLUMNS.length - 1 && <button className="bc-btn" title="Avancer" onClick={() => move(c, 1)}><Icon name="chevronRight" size={14} /></button>}
                      <button className="bc-btn" title="Supprimer" onClick={() => del(c)} style={{ marginLeft: 'auto' }}><Icon name="trash" size={14} /></button>
                    </div>
                  </div>
                ))}
              </div>
              <input
                className="board-add"
                placeholder="+ Ajouter une carte"
                value={draft[col.key]}
                onChange={(e) => setDraft((d) => ({ ...d, [col.key]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter') add(col.key); }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
