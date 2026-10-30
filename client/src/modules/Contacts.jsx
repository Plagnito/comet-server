import { useEffect, useState } from 'react';
import { api, getToken } from '../api.js';
import { useAuth } from '../auth.jsx';
import { randomChannelKey, wrapKeyFor, normalizeEmail } from '../crypto.js';
import { Avatar } from '../components/shell-meta.jsx';
import Icon from '../components/Icon.jsx';

const PALETTE = ['#4f46e5', '#db2777', '#0d9488', '#ea580c', '#7c3aed', '#2563eb', '#c026d3', '#16a34a'];
const colorFor = (s = '') => PALETTE[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];
const sortC = (a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name);

export default function Contacts({ query, openCompose, onOpenChannel }) {
  const { user } = useAuth();
  const [contacts, setContacts] = useState([]);
  const [dmBusy, setDmBusy] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', phone: '', company: '', labels: '' });
  const [importMsg, setImportMsg] = useState('');
  const [labelFilter, setLabelFilter] = useState('');
  const [allLabels, setAllLabels] = useState([]);

  function load() {
    const params = [];
    if (query) params.push(`q=${encodeURIComponent(query)}`);
    if (labelFilter) params.push(`label=${encodeURIComponent(labelFilter)}`);
    api.get(`/contacts${params.length ? '?' + params.join('&') : ''}`).then((r) => setContacts(r.contacts));
  }
  const loadLabels = () => api.get('/contacts/labels').then((r) => setAllLabels(r.labels)).catch(() => {});
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [query, labelFilter]);
  useEffect(() => { loadLabels(); }, []);

  async function exportVcf() {
    const res = await fetch('/api/contacts/export', { headers: { Authorization: `Bearer ${getToken()}` } });
    const text = await res.text();
    const url = URL.createObjectURL(new Blob([text], { type: 'text/vcard' }));
    const a = document.createElement('a'); a.href = url; a.download = 'comet-contacts.vcf'; a.click(); URL.revokeObjectURL(url);
  }
  async function importVcf(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const r = await api.post('/contacts/import', { vcard: text });
      setImportMsg(`${r.imported} contact(s) importé(s)${r.found > r.imported ? ` sur ${r.found} trouvé(s)` : ''}.`);
      setTimeout(() => setImportMsg(''), 5000); load(); loadLabels();
    } catch (e) { setImportMsg('Import impossible : ' + e.message); }
  }

  async function create(e) {
    e.preventDefault();
    if (!form.name.trim()) return;
    const r = await api.post('/contacts', { ...form, labels: form.labels.split(',').map((s) => s.trim()).filter(Boolean) });
    setContacts((c) => [...c, r.contact].sort(sortC));
    setForm({ name: '', email: '', phone: '', company: '', labels: '' }); setAdding(false); loadLabels();
  }
  async function editLabels(c) {
    const v = window.prompt('Libellés (séparés par des virgules)', c.labels.join(', '));
    if (v === null) return;
    const r = await api.patch(`/contacts/${c.id}`, { labels: v.split(',').map((s) => s.trim()).filter(Boolean) });
    setContacts((l) => l.map((x) => (x.id === c.id ? r.contact : x))); loadLabels();
  }
  async function toggleFav(c) {
    const r = await api.patch(`/contacts/${c.id}`, { favorite: !c.favorite });
    setContacts((l) => l.map((x) => (x.id === c.id ? r.contact : x)).sort(sortC));
  }
  async function del(c) {
    await api.del(`/contacts/${c.id}`);
    setContacts((l) => l.filter((x) => x.id !== c.id));
  }

  // Message direct chiffré : trouve/crée un canal 1-à-1 et l'ouvre dans Équipe.
  async function startDM(c) {
    if (!onOpenChannel || !c.email) return;
    setDmBusy(c.id);
    try {
      const me = normalizeEmail(user.email); const email = normalizeEmail(c.email);
      const { keys } = await api.get(`/users/keys?emails=${encodeURIComponent([me, email].join(','))}`);
      if (!keys[email]) { window.alert('Ce contact n\'a pas de compte Comet (impossible de chiffrer un message direct).'); return; }
      const channelKey = randomChannelKey();
      const members = { [me]: await wrapKeyFor(channelKey, keys[me]), [email]: await wrapKeyFor(channelKey, keys[email]) };
      const r = await api.post('/chat/dm', { email, name: c.name, members });
      onOpenChannel(r.channel.id);
    } catch (e) { window.alert('Message direct impossible : ' + (e?.message || e)); }
    finally { setDmBusy(null); }
  }

  return (
    <div className="pane">
      <div className="pane-head">
        <h2>Contacts</h2>
        <label className="btn ghost" style={{ cursor: 'pointer' }} title="Importer un fichier .vcf">
          <Icon name="logout" size={15} style={{ transform: 'rotate(90deg)' }} /> Importer
          <input type="file" accept=".vcf,text/vcard,text/x-vcard" style={{ display: 'none' }} onChange={(e) => { importVcf(e.target.files[0]); e.target.value = ''; }} />
        </label>
        <button className="btn ghost" onClick={exportVcf} disabled={contacts.length === 0} title="Exporter en .vcf"><Icon name="logout" size={15} style={{ transform: 'rotate(-90deg)' }} /> Exporter</button>
        <button className="btn" onClick={() => setAdding(true)}><Icon name="plus" size={16} /> Nouveau contact</button>
      </div>

      {importMsg && <div className="vault-import"><Icon name="check" size={15} /> {importMsg}</div>}
      {allLabels.length > 0 && (
        <div className="label-filter">
          <button className={`pill ${!labelFilter ? 'active' : ''}`} onClick={() => setLabelFilter('')}>Tous</button>
          {allLabels.map((l) => <button key={l} className={`pill ${labelFilter === l ? 'active' : ''}`} onClick={() => setLabelFilter(l)}>{l}</button>)}
        </div>
      )}
      {contacts.length === 0 && <div className="empty">Aucun contact{query || labelFilter ? ' pour ce filtre' : ''}.</div>}

      <div className="contact-grid">
        {contacts.map((c) => (
          <div key={c.id} className="card contact">
            <Avatar name={c.name} color={colorFor(c.name)} size={46} />
            <div className="info">
              <div className="cn">{c.favorite && <Icon name="star" filled size={14} style={{ color: 'var(--star)' }} />}{c.name}</div>
              {c.email && <div className="ce">{c.email}</div>}
              {c.company && <div className="cc">{c.company}</div>}
              {c.phone && <div className="cc">{c.phone}</div>}
              {c.labels.length > 0 && <div className="contact-labels">{c.labels.map((l) => <span key={l} className="clabel">{l}</span>)}</div>}
              <div className="acts">
                {c.email && <button className="btn subtle" style={{ padding: '6px 11px', fontSize: 12.5 }} onClick={() => openCompose({ to: [c.email] })}><Icon name="send" size={14} /> Écrire</button>}
                {c.email && onOpenChannel && <button className="btn subtle" style={{ padding: '6px 11px', fontSize: 12.5 }} disabled={dmBusy === c.id} onClick={() => startDM(c)}><Icon name="chat" size={14} /> {dmBusy === c.id ? '…' : 'Message'}</button>}
                <button className="icon-btn" title="Libellés" onClick={() => editLabels(c)}><Icon name="flag" size={16} /></button>
                <button className="icon-btn" title="Favori" onClick={() => toggleFav(c)} style={{ color: c.favorite ? 'var(--star)' : undefined }}><Icon name="star" size={16} filled={!!c.favorite} /></button>
                <button className="icon-btn" title="Supprimer" onClick={() => del(c)}><Icon name="trash" size={16} /></button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {adding && (
        <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) setAdding(false); }}>
          <form className="modal" onSubmit={create}>
            <h3>Nouveau contact</h3>
            <div className="field"><label>Nom *</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></div>
            <div className="field"><label>E-mail</label><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="prenom@comet.local" /></div>
            <div className="row2">
              <div className="field"><label>Téléphone</label><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
              <div className="field"><label>Société</label><input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} /></div>
            </div>
            <div className="field"><label>Libellés (séparés par des virgules)</label><input value={form.labels} onChange={(e) => setForm({ ...form, labels: e.target.value })} placeholder="Clients, VIP" /></div>
            <div className="modal-foot">
              <button type="button" className="btn ghost" onClick={() => setAdding(false)}>Annuler</button>
              <button className="btn">Ajouter</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
