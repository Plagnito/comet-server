import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { encryptMessage, decryptMessage, normalizeEmail } from '../crypto.js';
import Icon from '../components/Icon.jsx';

const EMPTY = { title: '', username: '', password: '', url: '', notes: '' };

function genPassword(len = 18) {
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%&*?';
  const a = crypto.getRandomValues(new Uint32Array(len));
  return Array.from(a, (n) => cs[n % cs.length]).join('');
}

export default function Vault({ query }) {
  const { user, myPublicKey, privateKey } = useAuth();
  const [entries, setEntries] = useState([]);   // [{ id, ...decrypted }]
  const [locked, setLocked] = useState(false);
  const [editing, setEditing] = useState(null);  // null | {id?, ...fields}
  const [reveal, setReveal] = useState({});
  const [copied, setCopied] = useState('');
  const [imported, setImported] = useState(0);
  const myEmail = normalizeEmail(user.email);

  async function load() {
    // Importe les mots de passe capturés par l'extension (copie aveugle côté serveur).
    try { const r = await api.post('/extension/import', {}); if (r.imported > 0) { setImported(r.imported); setTimeout(() => setImported(0), 6000); } } catch {}
    const { entries: rows } = await api.get('/vault');
    if (!privateKey && rows.length) { setLocked(true); setEntries([]); return; }
    const out = [];
    for (const r of rows) {
      try { out.push({ id: r.id, ...(await decryptMessage(r.ciphertext, r.iv, r.encKey, privateKey)) }); }
      catch { /* entrée illisible */ }
    }
    setEntries(out);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [privateKey]);

  async function save(e) {
    e.preventDefault();
    if (!editing.title.trim()) return;
    const { id, ...data } = editing;
    const enc = await encryptMessage(data, { [myEmail]: myPublicKey });
    const payload = { ciphertext: enc.ciphertext, iv: enc.iv, encKey: enc.keys[myEmail] };
    if (id) await api.patch(`/vault/${id}`, payload); else await api.post('/vault', payload);
    setEditing(null); load();
  }
  async function del(id) { await api.del(`/vault/${id}`); setEntries((l) => l.filter((x) => x.id !== id)); }
  function copy(text, tag) { navigator.clipboard?.writeText(text); setCopied(tag); setTimeout(() => setCopied(''), 1200); }

  const q = (query || '').toLowerCase();
  const shown = entries.filter((e) => !q || `${e.title} ${e.username} ${e.url}`.toLowerCase().includes(q));

  return (
    <div className="pane">
      <div className="pane-head">
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="lock" size={18} /> Coffre-fort</h2>
        <span className="meta">{entries.length} entrée(s) · chiffré</span>
        <button className="btn" onClick={() => setEditing({ ...EMPTY })}><Icon name="plus" size={16} /> Nouvelle entrée</button>
      </div>

      {imported > 0 && <div className="vault-import"><Icon name="check" size={15} /> {imported} mot(s) de passe importé(s) depuis l'extension.</div>}
      {locked && <div className="empty">Vos entrées sont chiffrées et la clé n'est pas disponible. Reconnectez-vous pour y accéder.</div>}
      {!locked && entries.length === 0 && <div className="empty">Coffre vide. Stockez vos mots de passe en toute confidentialité.</div>}

      <div className="contact-grid">
        {shown.map((e) => (
          <div key={e.id} className="card contact" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon name="lock" size={16} style={{ color: 'var(--accent)' }} />
              <div className="cn" style={{ flex: 1 }}>{e.title}</div>
              <button className="icon-btn" title="Modifier" onClick={() => setEditing(e)}><Icon name="pen" size={15} /></button>
              <button className="icon-btn" title="Supprimer" onClick={() => del(e.id)}><Icon name="trash" size={15} /></button>
            </div>
            {e.username && <div className="vault-field"><span>{e.username}</span><button className="icon-btn" onClick={() => copy(e.username, 'u' + e.id)}>{copied === 'u' + e.id ? <Icon name="check" size={14} /> : <Icon name="draft" size={14} />}</button></div>}
            {e.password && (
              <div className="vault-field">
                <span style={{ fontFamily: 'ui-monospace, monospace' }}>{reveal[e.id] ? e.password : '••••••••••'}</span>
                <button className="icon-btn" onClick={() => setReveal((r) => ({ ...r, [e.id]: !r[e.id] }))}>{reveal[e.id] ? 'Cacher' : 'Voir'}</button>
                <button className="icon-btn" onClick={() => copy(e.password, 'p' + e.id)}>{copied === 'p' + e.id ? <Icon name="check" size={14} /> : <Icon name="draft" size={14} />}</button>
              </div>
            )}
            {e.url && <a className="ce" href={e.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{e.url}</a>}
            {e.notes && <div className="cc" style={{ whiteSpace: 'pre-wrap' }}>{e.notes}</div>}
          </div>
        ))}
      </div>

      {editing && (
        <div className="modal-back" onMouseDown={(ev) => { if (ev.target === ev.currentTarget) setEditing(null); }}>
          <form className="modal" onSubmit={save}>
            <h3>{editing.id ? 'Modifier l\'entrée' : 'Nouvelle entrée'}</h3>
            <div className="field"><label>Nom / service *</label><input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} autoFocus placeholder="Ex. Gmail, Banque…" /></div>
            <div className="field"><label>Identifiant</label><input value={editing.username} onChange={(e) => setEditing({ ...editing, username: e.target.value })} /></div>
            <div className="field"><label>Mot de passe</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input style={{ flex: 1 }} value={editing.password} onChange={(e) => setEditing({ ...editing, password: e.target.value })} />
                <button type="button" className="btn ghost" onClick={() => setEditing({ ...editing, password: genPassword() })}>Générer</button>
              </div>
            </div>
            <div className="field"><label>URL</label><input value={editing.url} onChange={(e) => setEditing({ ...editing, url: e.target.value })} placeholder="https://…" /></div>
            <div className="field"><label>Notes</label><textarea value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} style={{ minHeight: 56, resize: 'vertical' }} /></div>
            <div className="modal-foot">
              <button type="button" className="btn ghost" onClick={() => setEditing(null)}>Annuler</button>
              <button className="btn">{editing.id ? 'Enregistrer' : 'Ajouter'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
