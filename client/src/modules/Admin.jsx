import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Avatar, MODULES } from '../components/shell-meta.jsx';
import Icon from '../components/Icon.jsx';

// Modules désactivables par l'organisation (le Courrier et les modules admin restent).
const TOGGLEABLE = MODULES.filter((m) => !m.adminOnly && m.key !== 'mail');

const STATS = [
  { k: 'users', label: 'Comptes', icon: 'users' },
  { k: 'online', label: 'En ligne', icon: 'bell' },
  { k: 'messages', label: 'Messages', icon: 'mail' },
  { k: 'twoFactor', label: '2FA actives', icon: 'shield' },
  { k: 'sessions', label: 'Sessions', icon: 'logout' },
  { k: 'pendingAttachments', label: 'PJ en attente', icon: 'paperclip' },
];

export default function Admin() {
  const { user } = useAuth();
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [roomForm, setRoomForm] = useState({ name: '', location: '', capacity: '' });
  const [disabled, setDisabled] = useState([]); // modules désactivés

  function load() {
    api.get('/admin/stats').then(setStats).catch(() => {});
    api.get('/admin/users').then((r) => setUsers(r.users)).catch(() => {});
    api.get('/rooms').then((r) => setRooms(r.rooms)).catch(() => {});
    api.get('/app-config').then((r) => setDisabled(r.disabledModules || [])).catch(() => {});
  }
  useEffect(() => { load(); }, []);

  async function toggleModule(key) {
    const next = disabled.includes(key) ? disabled.filter((k) => k !== key) : [...disabled, key];
    setDisabled(next); // optimiste
    try { const r = await api.put('/app-config', { disabledModules: next }); setDisabled(r.disabledModules); }
    catch { load(); }
  }

  async function addRoom(e) {
    e.preventDefault();
    if (!roomForm.name.trim()) return;
    const r = await api.post('/rooms', { name: roomForm.name, location: roomForm.location, capacity: roomForm.capacity });
    setRooms((l) => [...l, r.room]); setRoomForm({ name: '', location: '', capacity: '' });
  }
  async function delRoom(rm) { if (!window.confirm(`Supprimer la salle « ${rm.name} » ?`)) return; await api.del(`/rooms/${rm.id}`); setRooms((l) => l.filter((x) => x.id !== rm.id)); }

  async function toggleAdmin(u) { await api.patch(`/admin/users/${u.id}`, { isAdmin: !u.isAdmin }); load(); }
  async function togglePipelines(u) { await api.patch(`/admin/users/${u.id}`, { canPipelines: !u.canPipelines }); load(); }
  async function del(u) {
    if (!window.confirm(`Supprimer définitivement ${u.email} ?`)) return;
    await api.del(`/admin/users/${u.id}`); load();
  }

  return (
    <div className="pane">
      <div className="pane-head"><h2>Administration</h2><span className="meta">{users.filter((u) => !u.isSystem).length} compte(s)</span></div>

      <div className="stat-grid">
        {STATS.map((s) => (
          <div key={s.k} className="stat-card">
            <Icon name={s.icon} size={18} style={{ color: 'var(--accent)' }} />
            <div className="stat-n">{stats ? stats[s.k] : '—'}</div>
            <div className="stat-l">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="setting-title" style={{ marginTop: 24, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="board" size={16} /> Applications</div>
      <div className="setting-desc" style={{ marginBottom: 10 }}>Activez ou désactivez les modules pour toute l'organisation. Un module désactivé disparaît du rail de tous les membres (le Courrier reste toujours actif).</div>
      <div className="card">
        {TOGGLEABLE.map((m) => {
          const off = disabled.includes(m.key);
          return (
            <div key={m.key} className="admin-row">
              <Icon name={m.icon} size={18} style={{ color: off ? 'var(--muted)' : 'var(--accent)' }} />
              <div className="ar-info">
                <div className="ar-name">{m.label} {m.adminOnly && <span className="tag">admin</span>}</div>
                <div className="ar-mail">{off ? 'Désactivé — masqué pour tous' : 'Activé'}</div>
              </div>
              <button className={`icon-btn ${off ? '' : 'on'}`} onClick={() => toggleModule(m.key)} style={off ? undefined : { color: '#16a34a' }}>
                {off ? 'Activer' : 'Désactiver'}
              </button>
            </div>
          );
        })}
      </div>

      <div className="setting-title" style={{ marginTop: 24, marginBottom: 10 }}>Comptes</div>
      <div className="card">
        {users.map((u) => (
          <div key={u.id} className="admin-row">
            <Avatar name={u.displayName} color="#4f46e5" size={36} presence={u.online ? 'available' : undefined} />
            <div className="ar-info">
              <div className="ar-name">{u.displayName} {u.isAdmin && <span className="tag">admin</span>} {u.canPipelines && <span className="tag" style={{ color: '#0d9488', background: 'color-mix(in srgb, #0d9488 12%, transparent)' }}>pipelines</span>} {u.isSystem && <span className="tag sys">système</span>}</div>
              <div className="ar-mail">{u.email} · {u.sessions} session(s){u.twoFactor ? ' · 2FA' : ''}</div>
            </div>
            {!u.isSystem && (
              <>
                <button className="icon-btn" onClick={() => togglePipelines(u)} title="Gérer tous les pipelines de l'organisation (la création est ouverte à tous)">{u.canPipelines ? 'Pipelines ✓' : 'Pipelines'}</button>
                <button className="icon-btn" onClick={() => toggleAdmin(u)} disabled={u.id === user.id}>{u.isAdmin ? 'Rétrograder' : 'Promouvoir'}</button>
                <button className="icon-btn" title="Supprimer le compte" onClick={() => del(u)} disabled={u.id === user.id}><Icon name="trash" size={16} /></button>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="setting-title" style={{ marginTop: 24, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="building" size={16} /> Salles de réunion</div>
      <div className="card">
        {rooms.length === 0 && <div className="empty" style={{ padding: 16 }}>Aucune salle. Ajoutez-en pour permettre les réservations dans le calendrier.</div>}
        {rooms.map((rm) => (
          <div key={rm.id} className="admin-row">
            <span style={{ width: 12, height: 12, borderRadius: 3, background: rm.color, flexShrink: 0 }} />
            <div className="ar-info">
              <div className="ar-name">{rm.name}</div>
              <div className="ar-mail">{rm.location || 'Sans emplacement'}{rm.capacity ? ` · ${rm.capacity} place(s)` : ''}</div>
            </div>
            <button className="icon-btn" title="Supprimer la salle" onClick={() => delRoom(rm)}><Icon name="trash" size={16} /></button>
          </div>
        ))}
      </div>
      <form onSubmit={addRoom} className="add-row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
        <input placeholder="Nom de la salle" value={roomForm.name} onChange={(e) => setRoomForm({ ...roomForm, name: e.target.value })} style={{ flex: 2 }} />
        <input placeholder="Emplacement" value={roomForm.location} onChange={(e) => setRoomForm({ ...roomForm, location: e.target.value })} style={{ flex: 2 }} />
        <input placeholder="Capacité" type="number" value={roomForm.capacity} onChange={(e) => setRoomForm({ ...roomForm, capacity: e.target.value })} style={{ width: 90 }} />
        <button className="btn"><Icon name="plus" size={16} /> Ajouter</button>
      </form>
    </div>
  );
}
