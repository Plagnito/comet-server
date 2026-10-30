import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Icon from './Icon.jsx';

const NAV = [
  { key: 'mail', label: 'Courrier', icon: 'mail' },
  { key: 'calendar', label: 'Calendrier', icon: 'calendar' },
  { key: 'contacts', label: 'Contacts', icon: 'users' },
  { key: 'tasks', label: 'Tâches', icon: 'tasks' },
  { key: 'board', label: 'Tableau', icon: 'board' },
  { key: 'notes', label: 'Notes', icon: 'notes' },
  { key: 'vault', label: 'Coffre-fort', icon: 'lock' },
];

export default function CommandPalette({ onClose, onNavigate, onCompose }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Construit la liste d'items (navigation + résultats de recherche)
  useEffect(() => {
    const query = q.trim();
    const nav = NAV
      .filter((n) => !query || n.label.toLowerCase().includes(query.toLowerCase()))
      .map((n) => ({ icon: n.icon, label: n.label, sub: 'Aller à', run: () => onNavigate(n.key, '') }));

    if (!query) { setResults(nav); setActive(0); return; }

    let cancelled = false;
    const t = setTimeout(async () => {
      const enc = encodeURIComponent(query);
      const [contacts, users, tasks, notes, events] = await Promise.all([
        api.get(`/contacts?q=${enc}`).then((r) => r.contacts).catch(() => []),
        api.get(`/users?q=${enc}`).then((r) => r.users).catch(() => []),
        api.get('/tasks').then((r) => r.tasks).catch(() => []),
        api.get('/notes').then((r) => r.notes).catch(() => []),
        api.get('/calendar').then((r) => r.events).catch(() => []),
      ]);
      if (cancelled) return;
      const lc = query.toLowerCase();
      const items = [...nav];
      for (const c of contacts.slice(0, 4)) items.push({ icon: 'users', label: c.name, sub: 'Contact', run: () => onNavigate('contacts', query) });
      for (const u of users.slice(0, 4)) items.push({ icon: 'building', label: u.displayName, sub: u.email, run: () => onCompose({ to: [u.email] }) });
      for (const t of tasks.filter((x) => x.title.toLowerCase().includes(lc)).slice(0, 4)) items.push({ icon: 'tasks', label: t.title, sub: 'Tâche', run: () => onNavigate('tasks', '') });
      for (const n of notes.filter((x) => `${x.title} ${x.body}`.toLowerCase().includes(lc)).slice(0, 4)) items.push({ icon: 'notes', label: n.title || '(note sans titre)', sub: 'Note', run: () => onNavigate('notes', '') });
      for (const e of events.filter((x) => x.title.toLowerCase().includes(lc)).slice(0, 4)) items.push({ icon: 'calendar', label: e.title, sub: 'Événement', run: () => onNavigate('calendar', '') });
      setResults(items); setActive(0);
    }, 160);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, onNavigate, onCompose]);

  function onKeyDown(e) {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); results[active]?.run(); }
  }

  return (
    <div className="palette-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette">
        <div className="palette-input">
          <Icon name="search" size={18} />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown}
            placeholder="Rechercher ou aller à… (contacts, tâches, notes, événements)" />
          <kbd>Échap</kbd>
        </div>
        <div className="palette-list">
          {results.length === 0 && <div className="empty" style={{ padding: 24 }}>Aucun résultat.</div>}
          {results.map((r, i) => (
            <button key={i} className={`palette-item ${i === active ? 'active' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => r.run()}>
              <Icon name={r.icon} size={16} />
              <span className="pi-label">{r.label}</span>
              <span className="pi-sub">{r.sub}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
