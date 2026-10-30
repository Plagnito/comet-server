import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Avatar } from '../components/shell-meta.jsx';
import Icon from '../components/Icon.jsx';
import MailHtmlView from '../components/MailHtmlView.jsx';
import { texteDepuisHtml } from '../mailhtml.js';

const fmtDate = (s) => {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  return d.toLocaleDateString('fr-FR');
};

// Boîte d'un compte EXTERNE (IMAP/SMTP). Voie séparée du courrier chiffré interne.
export default function ExtMail({ account, reloadKey, onChanged }) {
  const [extFolder, setExtFolder] = useState('inbox');
  const [msgs, setMsgs] = useState([]);
  const [detail, setDetail] = useState(null);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncErr, setSyncErr] = useState('');
  const [composing, setComposing] = useState(null); // { to, subject, text } | null
  const [sendErr, setSendErr] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    api.get(`/accounts/${account.id}/messages?folder=${extFolder}`)
      .then((r) => setMsgs(r.messages)).catch(() => setMsgs([]))
      .finally(() => setLoading(false));
  }, [account.id, extFolder]);
  useEffect(() => { load(); }, [load, reloadKey]);
  useEffect(() => { setSelected(null); setDetail(null); }, [account.id, extFolder]);

  async function sync() {
    setSyncing(true); setSyncErr('');
    try { await api.post(`/accounts/${account.id}/sync`, {}); load(); onChanged?.(); }
    catch (e) { setSyncErr(e.message || 'Synchronisation impossible'); }
    setSyncing(false);
  }
  async function open(m) {
    setSelected(m.id);
    const { message } = await api.get(`/accounts/${account.id}/messages/${m.id}`);
    setDetail(message);
    if (!m.isRead) { setMsgs((p) => p.map((x) => (x.id === m.id ? { ...x, isRead: true } : x))); onChanged?.(); }
  }
  function replyTo() {
    if (!detail) return;
    const base = detail.subject || '';
    // Citer le HTML quand il n'y a pas de version texte : sinon répondre à un courrier
    // écrit en HTML cite le vide, et le destinataire ne sait pas de quoi on parle.
    const cite = detail.bodyText || texteDepuisHtml(detail.bodyHtml);
    setComposing({ to: detail.fromAddr, subject: base.startsWith('RE:') ? base : `RE: ${base}`, text: `\n\n— Le ${fmtDate(detail.date)}, ${detail.fromAddr} a écrit :\n${cite.split('\n').map((l) => '> ' + l).join('\n')}`, inReplyTo: detail.messageId });
  }
  async function send(e) {
    e.preventDefault();
    setSendErr('');
    if (!composing.to.trim()) { setSendErr('Destinataire requis'); return; }
    try {
      await api.post(`/accounts/${account.id}/send`, { to: composing.to, subject: composing.subject, text: composing.text, inReplyTo: composing.inReplyTo });
      setComposing(null); if (extFolder === 'sent') load();
    } catch (err) { setSendErr(err.message); }
  }

  return (
    <>
      <section className="msglist">
        <div className="msglist-head" style={{ gap: 8 }}>
          <span style={{ flex: 1 }}>{account.email}</span>
          <button className="icon-btn sm" onClick={() => setExtFolder('inbox')} style={{ fontWeight: extFolder === 'inbox' ? 700 : 400 }}>Reçus</button>
          <button className="icon-btn sm" onClick={() => setExtFolder('sent')} style={{ fontWeight: extFolder === 'sent' ? 700 : 400 }}>Envoyés</button>
          <button className="icon-btn sm" onClick={sync} title="Synchroniser">{syncing ? <span className="spinner" style={{ width: 13, height: 13, borderWidth: 2 }} /> : <Icon name="inbox" size={15} />}</button>
          <button className="icon-btn sm" onClick={() => { setSendErr(''); setComposing({ to: '', subject: '', text: '' }); }} title="Écrire"><Icon name="compose" size={15} /></button>
        </div>
        {(syncErr || account.lastError) && (
          <div className="ext-warn" title={syncErr || account.lastError}>
            ⚠ Synchro en échec : {(syncErr || account.lastError).slice(0, 120)}
          </div>
        )}
        {msgs.length === 0 && !loading && (
          <div className="empty">
            {extFolder === 'inbox'
              ? (syncErr || account.lastError
                  ? 'Impossible de récupérer le courrier — vérifiez le compte (voir l’erreur ci-dessus).'
                  : 'Aucun message — cliquez sur l’icône de synchronisation.')
              : 'Aucun message.'}
          </div>
        )}
        {msgs.map((m) => (
          <div key={m.id} className={`msg-row ${!m.isRead ? 'unread' : ''} ${selected === m.id ? 'active' : ''}`} onClick={() => open(m)}>
            <Avatar name={m.fromName || m.fromAddr || m.toAddr} color="#0d9488" size={40} />
            <div className="body">
              <div className="line1"><span className="who">{extFolder === 'sent' ? m.toAddr : (m.fromName || m.fromAddr)}</span><span className="date">{fmtDate(m.date)}</span></div>
              <div className="subj">{m.subject || '(sans objet)'}</div>
              <div className="snip">{m.snippet || 'Aucun aperçu'}</div>
            </div>
          </div>
        ))}
      </section>

      <section className="reader">
        {!detail ? (
          <div className="reader-empty"><div><div className="big"><Icon name="mail" size={26} /></div>Compte externe — sélectionnez un message.</div></div>
        ) : (
          <>
            <div className="reader-head">
              <h2>{detail.subject || '(sans objet)'}</h2>
              <div className="reader-from">
                <Avatar name={detail.fromName || detail.fromAddr} color="#0d9488" size={42} />
                <div className="meta">
                  <div className="n" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    {detail.fromName || detail.fromAddr}
                    <span className="verified" style={{ color: '#b45309', background: 'color-mix(in srgb, #f59e0b 14%, transparent)' }} title="Compte externe : non chiffré de bout en bout"><Icon name="mail" size={12} /> Externe</span>
                  </div>
                  <div className="e">{detail.fromAddr}{detail.toAddr ? ` → ${detail.toAddr}` : ''}</div>
                </div>
                <div className="d">{fmtDate(detail.date)}</div>
              </div>
            </div>
            <div className="reader-actions">
              <button className="btn subtle" onClick={replyTo}><Icon name="reply" size={16} /> Répondre</button>
            </div>
            {detail.bodyHtml ? (
              // Une boîte IMAP reçoit surtout du courrier écrit en HTML, souvent SANS
              // version texte. L'afficher tel qu'il a été écrit, dans un cadre d'où rien
              // ne sort tant que le lecteur n'a pas dit oui — mêmes règles que la boîte
              // Comet et que l'application Android.
              <MailHtmlView html={detail.bodyHtml} cle={detail.id} expediteur={detail.fromAddr} />
            ) : (
              <div className="reader-body" style={{ whiteSpace: 'pre-wrap' }}>{detail.bodyText || '(message sans texte)'}</div>
            )}
          </>
        )}
      </section>

      {composing && (
        <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) setComposing(null); }}>
          <form className="modal compose-ext" onSubmit={send}>
            <h3>Nouveau message · {account.email} <span className="verified" style={{ color: '#b45309', background: 'color-mix(in srgb, #f59e0b 14%, transparent)' }}>Externe</span></h3>
            <div className="field"><label>À</label><input value={composing.to} onChange={(e) => setComposing({ ...composing, to: e.target.value })} placeholder="destinataire@exemple.com" autoFocus /></div>
            <div className="field"><label>Objet</label><input value={composing.subject} onChange={(e) => setComposing({ ...composing, subject: e.target.value })} /></div>
            <div className="field"><label>Message</label><textarea rows={9} value={composing.text} onChange={(e) => setComposing({ ...composing, text: e.target.value })} /></div>
            {sendErr && <div className="alert">{sendErr}</div>}
            <div className="modal-foot">
              <button type="button" className="btn ghost" onClick={() => setComposing(null)}>Annuler</button>
              <button className="btn"><Icon name="send" size={15} /> Envoyer</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
