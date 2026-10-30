import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Avatar } from '../components/shell-meta.jsx';
import Icon from '../components/Icon.jsx';
import { unwrapKey, unwrapPrivateKeyAES, decryptMessage, encryptMessage, normalizeEmail } from '../crypto.js';

const fmtDate = (s) => {
  if (!s) return '';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  return d.toLocaleDateString('fr-FR');
};
const snip = (b) => String(b || '').replace(/\s+/g, ' ').trim().slice(0, 120);

const FOLDERS = [
  { key: 'inbox', label: 'Reçus', icon: 'inbox' },
  { key: 'sent', label: 'Envoyés', icon: 'send' },
  { key: 'archive', label: 'Archive', icon: 'archive' },
  { key: 'trash', label: 'Corbeille', icon: 'trash' },
];

// Boîte aux lettres PARTAGÉE (chiffrée). On déverrouille l'identité de la boîte avec la
// clé de boîte (enveloppée pour moi), puis on lit/écrit comme la boîte.
export default function SharedMail({ box, reloadKey, onChanged }) {
  const { user, privateKey } = useAuth();
  const [info, setInfo] = useState(null);     // { address, name, publicKey, members, role }
  const [folder, setFolder] = useState('inbox');
  const [msgs, setMsgs] = useState([]);
  const [detail, setDetail] = useState(null);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [composing, setComposing] = useState(null);
  const [sendErr, setSendErr] = useState('');
  const [error, setError] = useState('');
  const [mineOnly, setMineOnly] = useState(false);     // filtre « assignés à moi »
  const [routesOpen, setRoutesOpen] = useState(false); // gestion des règles de routage
  const [routes, setRoutes] = useState([]);
  const [routeForm, setRouteForm] = useState({ matchFrom: '', assignee: '' });
  const boxPrivRef = useRef(null);            // CryptoKey privée de la boîte (en session)

  // Déverrouille l'identité de la boîte à l'ouverture
  useEffect(() => {
    let alive = true;
    boxPrivRef.current = null; setInfo(null); setError(''); setDetail(null); setSelected(null);
    (async () => {
      try {
        const { box: det } = await api.get(`/shared/${box.id}`);
        const boxKey = await unwrapKey(det.myEncKey, privateKey);
        boxPrivRef.current = await unwrapPrivateKeyAES(det.wrappedPrivateKey, boxKey);
        if (alive) setInfo(det);
      } catch { if (alive) setError("Impossible de déverrouiller cette boîte (clé indisponible)."); }
    })();
    return () => { alive = false; };
  }, [box.id, privateKey]);

  const decrypt = useCallback(async (o) => {
    if (!o.isEncrypted) return { subject: o.subject, body: o.body };
    if (!boxPrivRef.current || !o.encKey) return null;
    try { return await decryptMessage(o.ciphertext, o.iv, o.encKey, boxPrivRef.current); } catch { return null; }
  }, []);

  const load = useCallback(async () => {
    if (!info) return;
    setLoading(true);
    try {
      const qs = `folder=${folder}${mineOnly && folder === 'inbox' ? '&assignee=me' : ''}`;
      const { items } = await api.get(`/shared/${box.id}/messages?${qs}`);
      const rows = await Promise.all(items.map(async (m) => {
        if (!m.isEncrypted) return { ...m, locked: false };
        const dec = await decrypt(m);
        if (!dec) return { ...m, locked: true, subject: 'Message chiffré', snippet: '' };
        return { ...m, locked: false, subject: dec.subject || '(sans objet)', snippet: snip(dec.body) };
      }));
      setMsgs(rows);
    } catch { setMsgs([]); }
    setLoading(false);
  }, [box.id, folder, info, decrypt, mineOnly]);
  useEffect(() => { load(); }, [load, reloadKey]);
  useEffect(() => { setSelected(null); setDetail(null); setMineOnly(false); }, [folder, box.id]);

  const loadRoutes = useCallback(() => { api.get(`/shared/${box.id}/routes`).then((r) => setRoutes(r.routes)).catch(() => {}); }, [box.id]);
  async function addRoute(e) {
    e.preventDefault();
    if (!routeForm.matchFrom.trim() || !routeForm.assignee.trim()) return;
    try { const r = await api.post(`/shared/${box.id}/routes`, routeForm); setRoutes((l) => [...l, r.route]); setRouteForm({ matchFrom: '', assignee: '' }); }
    catch (err) { window.alert(err.message); }
  }
  async function delRoute(id) { await api.del(`/shared/${box.id}/routes/${id}`); setRoutes((l) => l.filter((x) => x.id !== id)); }
  async function assignTo(itemId, assignedTo) {
    const id = assignedTo ? Number(assignedTo) : null;
    await api.patch(`/shared/${box.id}/messages/${itemId}`, { assignedTo: id });
    const assignee = id ? (info?.members || []).find((mm) => mm.id === id) || null : null;
    setDetail((d) => (d ? { ...d, assignee } : d));
    setMsgs((p) => p.map((x) => (x.itemId === itemId ? { ...x, assignee } : x)));
  }

  async function open(m) {
    setSelected(m.itemId);
    const { message: d } = await api.get(`/shared/${box.id}/messages/${m.itemId}`);
    const dec = await decrypt(d);
    setDetail({
      ...d,
      locked: d.isEncrypted && !dec,
      subject: d.isEncrypted ? (dec?.subject || '(sans objet)') : d.subject,
      body: d.isEncrypted ? (dec?.body ?? null) : d.body,
      thread: await Promise.all((d.thread || []).map(async (t) => {
        if (!t.isEncrypted) return t;
        const td = await decrypt(t);
        return { ...t, subject: td?.subject ?? null, body: td?.body ?? null, locked: !td };
      })),
    });
    if (!m.isRead) { setMsgs((p) => p.map((x) => (x.itemId === m.itemId ? { ...x, isRead: true } : x))); onChanged?.(); }
  }

  async function move(itemId, toFolder) {
    await api.patch(`/shared/${box.id}/messages/${itemId}`, { folder: toFolder });
    setMsgs((p) => p.filter((x) => x.itemId !== itemId));
    if (selected === itemId) { setSelected(null); setDetail(null); }
    onChanged?.();
  }

  function startCompose(init = {}) { setSendErr(''); setComposing({ to: '', cc: '', subject: '', body: '', ...init }); }
  function reply() {
    if (!detail) return;
    const base = detail.subject || '';
    startCompose({ to: detail.from?.email || '', subject: base.startsWith('RE:') ? base : `RE: ${base}`, inReplyTo: detail.messageId });
  }

  async function send(e) {
    e.preventDefault(); setSendErr('');
    const to = composing.to.split(/[,;\s]+/).map(normalizeEmail).filter(Boolean);
    const cc = composing.cc.split(/[,;\s]+/).map(normalizeEmail).filter(Boolean);
    if (to.length === 0) { setSendErr('Au moins un destinataire'); return; }
    try {
      const emails = [...new Set([...to, ...cc, info.address])]; // la boîte se chiffre à elle-même (copie Envoyés)
      const { keys: pub } = await api.get(`/users/keys?emails=${encodeURIComponent(emails.join(','))}`);
      pub[info.address] = info.publicKey;
      const valid = Object.fromEntries(Object.entries(pub).filter(([, v]) => v));
      const unknown = to.filter((e2) => !valid[e2]);
      if (unknown.length) { setSendErr('Destinataire(s) inconnu(s) : ' + unknown.join(', ')); return; }
      const enc = await encryptMessage({ subject: composing.subject, body: composing.body }, valid);
      await api.post(`/shared/${box.id}/send`, { ciphertext: enc.ciphertext, iv: enc.iv, keys: enc.keys, to, cc, inReplyTo: composing.inReplyTo || null });
      setComposing(null);
      if (folder === 'sent') load();
    } catch (err) { setSendErr(err.message || 'Envoi impossible'); }
  }

  return (
    <>
      <section className="msglist">
        <div className="msglist-head" style={{ gap: 6, flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={box.address}>{box.name}</span>
          {FOLDERS.map((f) => (
            <button key={f.key} className="icon-btn sm" onClick={() => setFolder(f.key)} style={{ fontWeight: folder === f.key ? 700 : 400 }} title={f.label}>{f.label}</button>
          ))}
          {folder === 'inbox' && <button className="icon-btn sm" onClick={() => setMineOnly((v) => !v)} style={{ fontWeight: mineOnly ? 700 : 400, color: mineOnly ? 'var(--accent)' : undefined }} title="N'afficher que les messages qui me sont assignés">À moi</button>}
          <button className="icon-btn sm" onClick={() => { loadRoutes(); setRoutesOpen(true); }} disabled={!info} title="Règles de routage (compte de reçu)"><Icon name="flow" size={15} /></button>
          <button className="icon-btn sm" onClick={() => startCompose()} disabled={!info} title="Écrire"><Icon name="compose" size={15} /></button>
          {loading && <span className="spinner" style={{ width: 13, height: 13, borderWidth: 2 }} />}
        </div>
        {error && <div className="ext-warn">⚠ {error}</div>}
        {!error && msgs.length === 0 && !loading && <div className="empty">Aucun message ici.</div>}
        {msgs.map((m) => (
          <div key={m.itemId} className={`msg-row ${!m.isRead ? 'unread' : ''} ${selected === m.itemId ? 'active' : ''}`} onClick={() => open(m)}>
            <Avatar name={folder === 'sent' ? m.peopleLabel : (m.from?.displayName || m.peopleLabel)} color={m.from?.avatarColor} size={40} />
            <div className="body">
              <div className="line1"><span className="who">{folder === 'sent' ? m.peopleLabel : m.from?.displayName}</span><span className="date">{fmtDate(m.sentAt)}</span></div>
              <div className="subj">{m.locked ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--muted)' }}><Icon name="lock" size={13} /> Message chiffré</span> : m.subject}</div>
              <div className="snip">{m.locked ? '—' : (m.snippet || 'Aucun aperçu')}</div>
              {m.assignee && <div className="snip" style={{ color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}><Icon name="users" size={11} /> {m.assignee.id === user.id ? 'Assigné à vous' : `Assigné à ${m.assignee.displayName}`}</div>}
            </div>
          </div>
        ))}
      </section>

      <section className="reader">
        {!detail ? (
          <div className="reader-empty"><div><div className="big"><Icon name="users" size={26} /></div>Boîte partagée — sélectionnez un message.</div></div>
        ) : (
          <>
            <div className="reader-head">
              <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="lock" size={16} style={{ color: 'var(--accent)' }} />
                {detail.locked ? 'Message chiffré (verrouillé)' : detail.subject}
              </h2>
              <div className="reader-from">
                <Avatar name={detail.from?.displayName} color={detail.from?.avatarColor} size={42} />
                <div className="meta">
                  <div className="n">{detail.from?.displayName}</div>
                  <div className="e">{detail.from?.email}</div>
                </div>
                <div className="d">{fmtDate(detail.sentAt)}</div>
              </div>
            </div>
            <div className="reader-actions">
              <button className="btn subtle" onClick={reply}><Icon name="reply" size={16} /> Répondre</button>
              {folder !== 'archive' && <button className="btn subtle" onClick={() => move(detail.itemId, 'archive')}><Icon name="archive" size={16} /> Archiver</button>}
              {folder !== 'trash' && <button className="btn subtle" onClick={() => move(detail.itemId, 'trash')} style={{ color: 'var(--danger)' }}><Icon name="trash" size={16} /> Corbeille</button>}
              {folder !== 'sent' && info && (
                <label className="btn subtle" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }} title="Assigner ce message à un membre">
                  <Icon name="users" size={16} />
                  <select value={detail.assignee?.id || ''} onChange={(e) => assignTo(detail.itemId, e.target.value)} style={{ border: 'none', background: 'transparent', font: 'inherit', color: 'inherit', cursor: 'pointer' }}>
                    <option value="">Non assigné</option>
                    {info.members.map((mem) => <option key={mem.id} value={mem.id}>{mem.displayName}{mem.id === user.id ? ' (vous)' : ''}</option>)}
                  </select>
                </label>
              )}
            </div>
            {(detail.thread?.length > 1 ? detail.thread : [{ id: detail.messageId, from: detail.from, sentAt: detail.sentAt, body: detail.body, locked: detail.locked }]).map((t) => (
              <div key={t.id} className="thread-msg" style={{ borderTop: '1px solid var(--border)', padding: '12px 0' }}>
                <div className="reader-from" style={{ marginBottom: 6 }}>
                  <Avatar name={t.from?.displayName} color={t.from?.avatarColor} size={28} />
                  <div className="meta"><div className="n" style={{ fontSize: 13 }}>{t.from?.displayName}</div></div>
                  <div className="d">{fmtDate(t.sentAt)}</div>
                </div>
                <div className="reader-body" style={{ whiteSpace: 'pre-wrap' }}>{t.locked ? '🔒 Chiffré' : (t.body || '(vide)')}</div>
              </div>
            ))}
          </>
        )}
      </section>

      {composing && (
        <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) setComposing(null); }}>
          <form className="modal compose-ext" onSubmit={send}>
            <h3>Écrire depuis <b>{box.address}</b> <span className="verified"><Icon name="lock" size={12} /> Chiffré</span></h3>
            <div className="field"><label>À</label><input value={composing.to} onChange={(e) => setComposing({ ...composing, to: e.target.value })} placeholder="lea@comet.mail, marc@comet.mail" autoFocus /></div>
            <div className="field"><label>Cc</label><input value={composing.cc} onChange={(e) => setComposing({ ...composing, cc: e.target.value })} /></div>
            <div className="field"><label>Objet</label><input value={composing.subject} onChange={(e) => setComposing({ ...composing, subject: e.target.value })} /></div>
            <div className="field"><label>Message</label><textarea rows={8} value={composing.body} onChange={(e) => setComposing({ ...composing, body: e.target.value })} /></div>
            <div className="setting-desc" style={{ margin: 0 }}>Envoyé au nom de la boîte. Seuls les membres et les destinataires internes peuvent le lire.</div>
            {sendErr && <div className="alert">{sendErr}</div>}
            <div className="modal-foot">
              <button type="button" className="btn ghost" onClick={() => setComposing(null)}>Annuler</button>
              <button className="btn"><Icon name="send" size={15} /> Envoyer</button>
            </div>
          </form>
        </div>
      )}

      {routesOpen && (
        <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) setRoutesOpen(false); }}>
          <div className="modal" style={{ maxWidth: 560 }}>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="flow" size={18} /> Compte de reçu · règles de routage</h3>
            <div className="setting-desc">Les messages entrants sont <b>assignés automatiquement</b> à un membre selon l'expéditeur (la seule métadonnée visible — le contenu reste chiffré de bout en bout). La <b>première règle qui correspond</b> gagne ; les membres lisent dans la boîte.</div>
            <div className="card" style={{ marginTop: 10 }}>
              {routes.length === 0 && <div className="empty" style={{ padding: 14 }}>Aucune règle — les messages arrivent non assignés.</div>}
              {routes.map((r) => (
                <div key={r.id} className="alias-row">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}><code>{r.matchFrom}</code> &nbsp;→&nbsp; {r.assignee?.displayName || '—'}</div>
                  </div>
                  <button className="icon-btn" onClick={() => delRoute(r.id)} title="Supprimer la règle"><Icon name="trash" size={15} /></button>
                </div>
              ))}
            </div>
            <form onSubmit={addRoute} style={{ marginTop: 10 }}>
              <div className="row2">
                <div className="field"><label>Expéditeur</label><input value={routeForm.matchFrom} onChange={(e) => setRouteForm({ ...routeForm, matchFrom: e.target.value })} placeholder="client@x.com · @x.com · *" /></div>
                <div className="field"><label>Assigner à</label>
                  <select value={routeForm.assignee} onChange={(e) => setRouteForm({ ...routeForm, assignee: e.target.value })}>
                    <option value="">— membre —</option>
                    {(info?.members || []).map((mem) => <option key={mem.id} value={mem.email}>{mem.displayName}</option>)}
                  </select>
                </div>
              </div>
              <div className="hint" style={{ marginTop: 4 }}><code>*</code> = tous les expéditeurs · <code>@domaine.com</code> = tout un domaine · sinon une adresse exacte.</div>
              <div className="modal-foot">
                <button type="button" className="btn ghost" onClick={() => setRoutesOpen(false)}>Fermer</button>
                <button className="btn"><Icon name="plus" size={15} /> Ajouter la règle</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
