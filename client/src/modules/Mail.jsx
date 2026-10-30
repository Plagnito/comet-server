import { useCallback, useEffect, useState } from 'react';
import { api, getToken } from '../api.js';
import { useAuth } from '../auth.jsx';
import { decryptMessage } from '../crypto.js';
import { requestFile, decryptAttachment } from '../p2p.js';
import { Avatar } from '../components/shell-meta.jsx';
import Icon from '../components/Icon.jsx';
import MailHtmlView from '../components/MailHtmlView.jsx';
import VerificationFederee from '../components/VerificationFederee.jsx';
import ExtMail from './ExtMail.jsx';
import SharedMail from './SharedMail.jsx';

const fmtSize = (n) => (n < 1024 ? `${n} o`
  : n < 1048576 ? `${(n / 1024).toFixed(0)} Ko`
  : n < 1073741824 ? `${(n / 1048576).toFixed(1)} Mo`
  : `${(n / 1073741824).toFixed(2)} Go`);

// Une pièce jointe venue du dehors n'est pas toujours là. Les états ne sont pas des
// erreurs à cacher : une pièce manquante doit se VOIR, sinon le lecteur cherche un
// fichier dont l'expéditeur lui a parlé et qui n'arrivera jamais.
const ETAT_PIECE = {
  attendue: 'en cours de réception…',
  refusee: 'non conservée (boîte pleine)',
  absente: 'indisponible',
};

const FOLDERS = [
  { key: 'inbox', icon: 'inbox', label: 'Boîte de réception' },
  { key: 'snoozed', icon: 'clock', label: 'Reportés' },
  { key: 'sent', icon: 'send', label: 'Envoyés' },
  { key: 'scheduled', icon: 'clock', label: 'Programmés' },
  { key: 'drafts', icon: 'draft', label: 'Brouillons' },
  { key: 'archive', icon: 'archive', label: 'Archives' },
  { key: 'trash', icon: 'trash', label: 'Corbeille' },
];

// Cache de déchiffrement (messageId → {subject, body}) pour éviter de re-déchiffrer.
const decCache = new Map();
const snip = (b) => String(b || '').replace(/\s+/g, ' ').trim().slice(0, 140);

const fmtSched = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T') + 'Z');
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  return d.toLocaleDateString('fr-FR');
}

export default function Mail({ query, reloadKey, counts, openCompose, onChanged, onNavigate }) {
  const { privateKey } = useAuth();
  const [folder, setFolder] = useState('inbox');
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [dl, setDl] = useState({}); // transferId -> { status, pct, msg }
  const [accounts, setAccounts] = useState([]);     // comptes externes (IMAP/SMTP)
  const [extAccount, setExtAccount] = useState(null); // compte externe actif (ou null = interne)
  const [boxes, setBoxes] = useState([]);           // boîtes partagées (E2EE)
  const [sharedBox, setSharedBox] = useState(null); // boîte partagée active
  const [snoozeOpen, setSnoozeOpen] = useState(false);

  function snoozePresets() {
    const now = new Date();
    const out = [];
    const tonight = new Date(now); tonight.setHours(18, 0, 0, 0);
    if (tonight > now) out.push(['Ce soir, 18 h', tonight]);
    const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(8, 0, 0, 0);
    const nextMon = new Date(now); nextMon.setDate(nextMon.getDate() + (((8 - nextMon.getDay()) % 7) || 7)); nextMon.setHours(8, 0, 0, 0);
    out.push(['Demain, 8 h', tomorrow], ['Lundi prochain, 8 h', nextMon]);
    return out.map(([l, d]) => [l, d.toISOString()]);
  }
  async function doSnooze(itemId, until) {
    await api.post(`/mail/${itemId}/snooze`, { until });
    setSnoozeOpen(false); afterRemove(itemId); onChanged();
  }

  // Le poids de la boîte. Un quota qui ne se voit qu'au moment où il refuse un message
  // n'est pas un quota, c'est une surprise : on le montre là où le courrier se lit.
  const [quota, setQuota] = useState(null);
  const loadQuota = useCallback(() => { api.get('/mail/quota').then(setQuota).catch(() => setQuota(null)); }, []);
  const loadAccounts = useCallback(() => { api.get('/accounts').then((r) => setAccounts(r.accounts)).catch(() => {}); }, []);
  const loadBoxes = useCallback(() => { api.get('/shared').then((r) => setBoxes(r.boxes)).catch(() => {}); }, []);
  useEffect(() => { loadAccounts(); loadBoxes(); loadQuota(); }, [loadAccounts, loadBoxes, loadQuota, reloadKey]);
  const refreshAll = () => { onChanged(); loadAccounts(); loadBoxes(); loadQuota(); };

  async function downloadAttachment(att) {
    setDl((d) => ({ ...d, [att.transferId]: { status: 'loading', pct: 0 } }));
    try {
      let bytes;
      try {
        bytes = await requestFile(att.transferId, detail.from.id, att.key, {
          onProgress: (r, t) => setDl((d) => ({ ...d, [att.transferId]: { status: 'loading', pct: t ? Math.round((r / t) * 100) : 0 } })),
        });
      } catch (p2pErr) {
        // Repli serveur : l'expéditeur est injoignable (le fichier y a été déposé chiffré)
        const res = await fetch(`/api/attachments/${att.transferId}`, { headers: { Authorization: 'Bearer ' + getToken() } });
        if (!res.ok) throw p2pErr;
        const ct = await res.arrayBuffer();
        bytes = await decryptAttachment(ct, res.headers.get('X-IV'), att.key);
      }
      const url = URL.createObjectURL(new Blob([bytes], { type: att.mimetype }));
      const a = document.createElement('a'); a.href = url; a.download = att.filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDl((d) => ({ ...d, [att.transferId]: { status: 'done' } }));
    } catch (e) {
      setDl((d) => ({ ...d, [att.transferId]: { status: 'error', msg: e.message } }));
    }
  }

  /**
   * Pièce jointe d'un courrier venu du DEHORS : elle vit sur le serveur (le message n'est
   * pas chiffré, il n'y a ni pair ni clé), et la route exige la session — d'où un `fetch`
   * porteur du jeton plutôt qu'un simple lien, qui partirait sans en-tête et rendrait 401.
   */
  async function downloadPiece(p) {
    const key = `pj${p.index}`;
    setDl((d) => ({ ...d, [key]: { status: 'loading', pct: 0 } }));
    try {
      const res = await fetch(`/api/mail/${detail.itemId}/attachment/${p.index}`, { headers: { Authorization: 'Bearer ' + getToken() } });
      if (!res.ok) throw new Error(res.status === 404 ? 'Pièce indisponible' : `Erreur ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a'); a.href = url; a.download = p.filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDl((d) => ({ ...d, [key]: { status: 'done' } }));
    } catch (e) {
      setDl((d) => ({ ...d, [key]: { status: 'error', msg: e.message } }));
    }
  }

  // Fichier volumineux (> 50 Mo) envoyé par torrent : nécessite le client de bureau.
  async function downloadTorrent(att) {
    if (!(window.cometDesktop && window.cometDesktop.torrent)) {
      setDl((d) => ({ ...d, [att.transferId]: { status: 'error', msg: 'Client Comet (app de bureau) requis pour ce fichier' } }));
      return;
    }
    setDl((d) => ({ ...d, [att.transferId]: { status: 'loading', pct: 0 } }));
    try {
      await window.cometDesktop.torrent.download(att.magnet);
      setDl((d) => ({ ...d, [att.transferId]: { status: 'done' } }));
    } catch (e) {
      setDl((d) => ({ ...d, [att.transferId]: { status: 'error', msg: String(e?.message || e) } }));
    }
  }

  // Renvoie { subject, body } déchiffré (ou null si verrouillé / impossible)
  const decrypt = useCallback(async (o) => {
    if (!o.isEncrypted) return { subject: o.subject, body: o.body };
    if (decCache.has(o.messageId ?? o.id)) return decCache.get(o.messageId ?? o.id);
    if (!privateKey || !o.encKey) return null;
    try {
      const dec = await decryptMessage(o.ciphertext, o.iv, o.encKey, privateKey);
      decCache.set(o.messageId ?? o.id, dec);
      return dec;
    } catch { return null; }
  }, [privateKey]);

  const load = useCallback(() => {
    setLoading(true);
    const qs = query ? `&q=${encodeURIComponent(query)}` : '';
    api.get(`/mail?folder=${folder}${qs}`)
      .then(async (r) => {
        const rows = await Promise.all(r.items.map(async (m) => {
          if (!m.isEncrypted) return { ...m, locked: false };
          const dec = await decrypt(m);
          if (!dec) return { ...m, locked: true, subject: 'Message chiffré', snippet: '' };
          return { ...m, locked: false, subject: dec.subject || '(sans objet)', snippet: snip(dec.body) };
        }));
        setItems(rows);
      })
      .finally(() => setLoading(false));
  }, [folder, query, decrypt]);

  useEffect(() => { load(); }, [load, reloadKey]);
  useEffect(() => { setSelected(null); setDetail(null); setSnoozeOpen(false); }, [folder]);

  async function openItem(item) {
    if (folder === 'drafts') {
      const { item: d } = await api.get(`/mail/${item.itemId}`);
      const dec = (await decrypt(d)) || { subject: '', body: '' };
      openCompose({ to: d.to.map((x) => x.email), cc: d.cc.map((x) => x.email), subject: dec.subject || '', body: dec.body || '', draftId: item.itemId });
      return;
    }
    setSelected(item.itemId); setSnoozeOpen(false);
    const { item: d } = await api.get(`/mail/${item.itemId}`);
    const dec = await decrypt(d);
    const view = {
      ...d,
      locked: d.isEncrypted && !dec,
      subject: d.isEncrypted ? (dec?.subject || '(sans objet)') : d.subject,
      body: d.isEncrypted ? (dec?.body ?? null) : d.body,
      // Le HTML d'origine d'un courrier venu du dehors. Un envoi commercial n'a souvent
      // AUCUNE version texte : sans lui, le message s'affiche VIDE alors que l'objet et
      // l'expéditeur, eux, s'affichent — rien ne signale la perte.
      bodyHtml: d.isEncrypted ? null : (d.bodyHtml || null),
      attachments: (d.isEncrypted ? dec?.attachments : null) || [],
      // Pièces jointes du courrier entrant (sur le serveur). Distinctes des pièces d'un
      // message chiffré, qui voyagent en pair-à-pair et vivent DANS le déchiffré.
      pieces: d.attachments || [],
      thread: await Promise.all(d.thread.map(async (t) => {
        if (!t.isEncrypted) return t;
        const td = await decrypt(t);
        return { ...t, body: td?.body ?? null, subject: td?.subject ?? null, locked: !td };
      })),
    };
    setDetail(view);
    if (!item.isRead) {
      setItems((prev) => prev.map((i) => (i.itemId === item.itemId ? { ...i, isRead: true } : i)));
      onChanged();
    }
  }

  function toggleStar(e, item) {
    e.stopPropagation();
    const v = !item.isStarred;
    setItems((prev) => prev.map((i) => (i.itemId === item.itemId ? { ...i, isStarred: v } : i)));
    api.patch(`/mail/${item.itemId}`, { isStarred: v }).catch(() => {});
  }

  function afterRemove(itemId) {
    setItems((prev) => prev.filter((i) => i.itemId !== itemId));
    if (selected === itemId) { setSelected(null); setDetail(null); }
    onChanged();
  }
  async function move(itemId, toFolder) { await api.patch(`/mail/${itemId}`, { folder: toFolder }); afterRemove(itemId); }
  async function remove(itemId) { await api.del(`/mail/${itemId}`); afterRemove(itemId); }
  async function markUnread(itemId) {
    await api.patch(`/mail/${itemId}`, { isRead: false });
    setItems((prev) => prev.map((i) => (i.itemId === itemId ? { ...i, isRead: false } : i)));
    setSelected(null); setDetail(null); onChanged();
  }

  function reply() {
    if (!detail) return;
    const base = detail.subject || '';
    openCompose({ to: [detail.from.email], subject: base.startsWith('RE:') ? base : `RE: ${base}`, inReplyTo: detail.messageId });
  }

  const folderLabel = FOLDERS.find((f) => f.key === folder)?.label;

  return (
    <div className="mail">
      <aside className="folders">
        <button className="btn block compose-btn" onClick={() => openCompose({})}><Icon name="compose" size={17} /> Nouveau message</button>
        <div className="folders-label">Dossiers</div>
        {FOLDERS.map((f) => {
          const c = counts[f.key] || { total: 0, unread: 0 };
          const badge = f.key === 'inbox' ? c.unread : (f.key === 'drafts' || f.key === 'scheduled' || f.key === 'snoozed') ? c.total : 0;
          return (
            <button key={f.key} className={`folder ${folder === f.key && !extAccount && !sharedBox ? 'active' : ''}`} onClick={() => { setFolder(f.key); setExtAccount(null); setSharedBox(null); }}>
              <Icon name={f.icon} size={18} />
              <span className="lbl">{f.label}</span>
              {badge > 0 && <span className="count">{badge}</span>}
            </button>
          );
        })}
        {boxes.length > 0 && <div className="folders-label" style={{ marginTop: 14 }}>Boîtes partagées</div>}
        {boxes.map((b) => (
          <button key={b.id} className={`folder ${sharedBox?.id === b.id ? 'active' : ''}`} onClick={() => { setSharedBox(b); setExtAccount(null); setSelected(null); setDetail(null); }} title={b.address}>
            <Icon name="users" size={18} />
            <span className="lbl" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</span>
            {b.unread > 0 && <span className="count">{b.unread}</span>}
          </button>
        ))}
        {accounts.length > 0 && <div className="folders-label" style={{ marginTop: 14 }}>Comptes externes</div>}
        {accounts.map((a) => (
          <button key={a.id} className={`folder ${extAccount?.id === a.id ? 'active' : ''}`} onClick={() => { setExtAccount(a); setSharedBox(null); setSelected(null); setDetail(null); }} title={a.email}>
            <Icon name="mail" size={18} />
            <span className="lbl" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.label || a.email}</span>
            {a.unread > 0 && <span className="count">{a.unread}</span>}
          </button>
        ))}

        {quota && (
          <div className="quota" title={quota.illimite ? 'Aucune limite' : `${fmtSize(quota.utilises)} sur ${fmtSize(quota.limite)}`}>
            <div className="quota-tete">
              <Icon name="archive" size={14} />
              <span>Stockage</span>
              {!quota.illimite && <span className="quota-pct">{quota.pourcent}&nbsp;%</span>}
            </div>
            {quota.illimite ? (
              <div className="quota-txt">{fmtSize(quota.utilises)} — sans limite</div>
            ) : (
              <>
                {/* La barre dit la VÉRITÉ, quitte à paraître vide : un trait affiché pour
                    « faire joli » ferait croire à une occupation qui n'existe pas. Le
                    chiffre en toutes lettres, lui, reste informatif à 0 %. */}
                <div className={`quota-barre ${quota.plein ? 'plein' : quota.pourcent >= 80 ? 'haut' : ''}`}>
                  <span style={{ width: `${quota.pourcent}%` }} />
                </div>
                <div className="quota-txt">
                  {fmtSize(quota.utilises)} sur {fmtSize(quota.limite)}
                  {quota.plein && <b> — boîte pleine, les nouveaux messages sont refusés.</b>}
                </div>
              </>
            )}
          </div>
        )}
      </aside>

      {sharedBox ? (
        <SharedMail box={sharedBox} reloadKey={reloadKey} onChanged={refreshAll} />
      ) : extAccount ? (
        <ExtMail account={extAccount} reloadKey={reloadKey} onChanged={refreshAll} />
      ) : (
       <>
      <section className="msglist">
        <div className="msglist-head">{folderLabel}{loading && <span className="spinner" style={{ width: 13, height: 13, borderWidth: 2 }} />}</div>
        {items.length === 0 && !loading && (
          folder === 'inbox' && !query ? (
            <div className="empty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, textAlign: 'center', padding: '38px 20px' }}>
              <div style={{ width: 56, height: 56, borderRadius: 16, display: 'grid', placeItems: 'center', background: 'var(--accent)', color: '#fff' }}><Icon name="mail" size={26} /></div>
              <div>
                <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)' }}>Bienvenue dans Comet</div>
                <div style={{ fontSize: 13, marginTop: 4, maxWidth: 320 }}>Votre messagerie et l'espace de votre équipe, chiffrés de bout en bout. Pour démarrer&nbsp;:</div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
                <button className="btn" onClick={() => openCompose({})}><Icon name="compose" size={15} /> Écrire un message</button>
                {onNavigate && <button className="btn ghost" onClick={() => onNavigate('chat')}><Icon name="chat" size={15} /> Ouvrir le canal Général</button>}
              </div>
            </div>
          ) : (
            <div className="empty">{query ? 'Aucun message ne correspond à votre recherche.' : 'Aucun message ici.'}</div>
          )
        )}
        {items.map((m) => (
          <div key={m.itemId} className={`msg-row ${!m.isRead ? 'unread' : ''} ${selected === m.itemId ? 'active' : ''}`} onClick={() => openItem(m)}>
            <Avatar name={m.peopleLabel} color={m.from?.avatarColor} size={40} />
            <div className="body">
              <div className="line1">
                <span className="who">{m.peopleLabel}</span>
                {m.isEphemeral && <Icon name="clock" size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />}
                <span className="date">{fmtDate(m.sentAt)}</span>
              </div>
              <div className="subj">
                {m.isDraft && <span className="draft-tag">[Brouillon] </span>}
                {folder === 'scheduled' && m.scheduledAt && <span className="draft-tag" style={{ color: 'var(--accent)' }}><Icon name="clock" size={11} /> {fmtSched(m.scheduledAt)} </span>}
                {folder === 'snoozed' && m.snoozedUntil && <span className="draft-tag" style={{ color: 'var(--accent)' }}><Icon name="clock" size={11} /> {fmtDate(m.snoozedUntil)} </span>}
                {m.locked ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--muted)' }}><Icon name="lock" size={13} /> Message chiffré</span> : m.subject}
              </div>
              <div className="snip">{m.locked ? 'Connectez-vous pour déchiffrer' : (m.snippet || 'Aucun aperçu')}</div>
            </div>
            <button className={`star ${m.isStarred ? 'on' : ''}`} onClick={(e) => toggleStar(e, m)} title="Épingler"><Icon name="star" filled={m.isStarred} size={16} /></button>
          </div>
        ))}
      </section>

      <section className="reader">
        {!detail ? (
          <div className="reader-empty"><div><div className="big"><Icon name="mail" size={26} /></div>Sélectionnez un message à lire.</div></div>
        ) : (
          <>
            <div className="reader-head">
              <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {detail.isEncrypted && <Icon name="lock" size={16} style={{ color: 'var(--accent)' }} />}
                {detail.locked ? 'Message chiffré (verrouillé)' : detail.subject}
              </h2>
              <div className="reader-from">
                <Avatar name={detail.from?.displayName} color={detail.from?.avatarColor} size={42} />
                <div className="meta">
                  <div className="n" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    {detail.from?.displayName}
                    {detail.isEncrypted && <span className="verified" title="Chiffré de bout en bout (RSA-OAEP + AES-GCM). Envoyé par un compte interne sur session authentifiée — le message n'est PAS signé cryptographiquement (pas d'authentification d'expéditeur)."><Icon name="badge" size={13} /> Chiffré</span>}
                  </div>
                  <div className="e">{detail.from?.email}</div>
                </div>
                <div className="d">{fmtDate(detail.sentAt)}</div>
              </div>
              <VerificationFederee personne={detail.from} />
              {(detail.to.length > 0 || detail.cc.length > 0) && (
                <div style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {detail.to.map((p) => <span key={'t' + p.id} className="chip"><Avatar name={p.displayName} color={p.avatarColor} size={18} />{p.displayName}</span>)}
                  {detail.cc.map((p) => <span key={'c' + p.id} className="chip"><span className="lead">Cc</span><Avatar name={p.displayName} color={p.avatarColor} size={18} />{p.displayName}</span>)}
                </div>
              )}
              {/* Destinataires d'autres serveurs Comet (dossier Envoyés) : même numéro de sécurité. */}
              {[...detail.to, ...detail.cc].filter((p) => p.federe && p.id !== detail.from?.id).map((p) => (
                <div key={'f' + p.id} style={{ marginTop: 6, fontSize: 12 }}>{p.email} <VerificationFederee personne={p} /></div>
              ))}
            </div>

            <div className="reader-actions">
              {folder === 'scheduled' ? (
                <button className="btn subtle" onClick={() => remove(detail.itemId)} style={{ color: 'var(--danger)' }}><Icon name="close" size={16} /> Annuler l'envoi</button>
              ) : (
                <>
                  <button className="btn subtle" onClick={reply}><Icon name="reply" size={16} /> Répondre</button>
                  {folder === 'snoozed'
                    ? <button className="icon-btn" onClick={() => doSnooze(detail.itemId, null)}><Icon name="inbox" size={16} /> Remettre en boîte</button>
                    : <button className="icon-btn" onClick={() => setSnoozeOpen((v) => !v)}><Icon name="clock" size={16} /> Reporter</button>}
                  {folder !== 'archive' && <button className="icon-btn" onClick={() => move(detail.itemId, 'archive')}><Icon name="archive" size={16} /> Archiver</button>}
                  <button className="icon-btn" onClick={() => remove(detail.itemId)}><Icon name="trash" size={16} /> Supprimer</button>
                  <button className="icon-btn" onClick={() => markUnread(detail.itemId)}><Icon name="mail" size={16} /> Marquer non lu</button>
                </>
              )}
            </div>
            {snoozeOpen && folder !== 'snoozed' && (
              <div className="snooze-row">
                <span className="setting-desc" style={{ margin: 0 }}>Reporter à :</span>
                {snoozePresets().map(([label, iso]) => <button key={label} className="btn ghost" onClick={() => doSnooze(detail.itemId, iso)}>{label}</button>)}
              </div>
            )}

            {detail.attachments.length > 0 && (
              <div className="att-list">
                {detail.attachments.map((att) => {
                  const st = dl[att.transferId];
                  // Fichier volumineux non chiffré (web-seed serveur) : téléchargement direct
                  // via le navigateur (streamé, sans charger le fichier en mémoire) + un client BitTorrent.
                  const large = att.webseed?.downloadUrl;
                  return (
                    <div key={att.transferId} className="att-item">
                      <Icon name="paperclip" size={16} style={{ color: 'var(--accent)' }} />
                      <div className="att-meta">
                        <div className="att-name">{att.filename}</div>
                        <div className="att-sub">{fmtSize(att.size)} · {large ? 'fichier volumineux (non chiffré)' : att.torrent ? 'torrent chiffré (client requis)' : 'pair-à-pair, chiffré'}</div>
                      </div>
                      {large ? (
                        <>
                          <a className="btn subtle" href={att.webseed.downloadUrl} download={att.filename} title="Téléchargement direct (HTTP)"><Icon name="draft" size={14} /> Télécharger</a>
                        </>
                      ) : st?.status === 'loading' ? <span className="att-status">{att.torrent ? '…' : `${st.pct}%`}</span>
                        : st?.status === 'error' ? <span className="att-status err" title={st.msg}>Échec — {st.msg}</span>
                        : st?.status === 'done' ? <span className="att-status ok"><Icon name="check" size={14} /> Reçu</span>
                        : <button className="btn subtle" onClick={() => att.torrent ? downloadTorrent(att) : downloadAttachment(att)}><Icon name="draft" size={14} /> Télécharger</button>}
                    </div>
                  );
                })}
              </div>
            )}

            {detail.pieces.length > 0 && (
              <div className="att-list">
                {detail.pieces.map((p) => {
                  const st = dl[`pj${p.index}`];
                  return (
                    <div key={`pj${p.index}`} className={`att-item ${p.disponible ? '' : 'att-absente'}`}>
                      <Icon name="paperclip" size={16} style={{ color: p.disponible ? 'var(--accent)' : 'var(--muted)' }} />
                      <div className="att-meta">
                        <div className="att-name">{p.filename}</div>
                        <div className="att-sub">{fmtSize(p.size)}{p.disponible ? '' : ` · ${ETAT_PIECE[p.etat] || 'indisponible'}`}</div>
                      </div>
                      {!p.disponible ? null
                        : st?.status === 'loading' ? <span className="att-status">…</span>
                        : st?.status === 'error' ? <span className="att-status err" title={st.msg}>Échec — {st.msg}</span>
                        : st?.status === 'done' ? <span className="att-status ok"><Icon name="check" size={14} /> Reçu</span>
                        : <button className="btn subtle" onClick={() => downloadPiece(p)}><Icon name="draft" size={14} /> Télécharger</button>}
                    </div>
                  );
                })}
              </div>
            )}

            {detail.isEphemeral && (
              <div className="eph-banner">
                <Icon name="clock" size={14} />
                {detail.burnAfterRead
                  ? 'Message éphémère — détruit après cette lecture.'
                  : `Message éphémère — expire le ${new Date(detail.expiresAt.replace(' ', 'T') + 'Z').toLocaleString('fr-FR')}.`}
              </div>
            )}

            {detail.locked ? (
              <div className="reader-body" style={{ color: 'var(--muted)' }}>Ce message est chiffré et votre clé n'est pas disponible sur cet appareil. Reconnectez-vous pour le déchiffrer.</div>
            ) : detail.bodyHtml ? (
              // Un courrier du dehors porte sa vraie forme en HTML — et parfois RIEN
              // d'autre. On l'affiche tel qu'il a été écrit, dans un cadre d'où rien ne
              // sort tant que le lecteur n'a pas dit oui.
              <MailHtmlView html={detail.bodyHtml} cle={detail.itemId} expediteur={detail.from?.email} />
            ) : detail.thread.length > 1 ? (
              detail.thread.map((t) => (
                <div key={t.id} className="thread-item">
                  <div className="meta"><b>{t.from?.displayName}</b> · {fmtDate(t.sentAt)}</div>
                  <div className="thread-body">{t.locked ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--muted)' }}><Icon name="lock" size={13} /> Verrouillé</span> : t.body}</div>
                </div>
              ))
            ) : detail.body ? (
              <div className="reader-body">{detail.body}</div>
            ) : (
              // Dire « vide » plutôt que de laisser une page blanche : sans cette
              // phrase, un message dont le corps n'est pas descendu est indiscernable
              // d'un message que l'expéditeur a réellement laissé vide.
              <div className="reader-body" style={{ color: 'var(--muted)' }}>(message sans texte)</div>
            )}
          </>
        )}
      </section>
       </>
      )}
    </div>
  );
}
