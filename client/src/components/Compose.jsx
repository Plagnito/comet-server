import { useEffect, useRef, useState } from 'react';
import { api, getToken } from '../api.js';
import { useAuth } from '../auth.jsx';
import { encryptMessage, normalizeEmail } from '../crypto.js';
import { offerFile, newTransferId, newFileKey, encryptAttachment } from '../p2p.js';
import { sendMail } from '../outbox.js';
import { stripImageMetadata } from '../images.js';
import { verifierDestinatairesFederes } from '../federation.js';
import Icon from './Icon.jsx';

const MAX_FILE = 50 * 1024 * 1024; // 50 Mo
const fmtSize = (n) => (n < 1024 ? `${n} o` : n < 1048576 ? `${(n / 1024).toFixed(0)} Ko` : `${(n / 1048576).toFixed(1)} Mo`);

const splitAddr = (s) => String(s || '').split(/[,;]+/).map((x) => x.trim()).filter(Boolean);
// Une adresse « externe » = une vraie adresse e-mail hors du domaine interne comet.mail.
// Ces destinataires ne sont pas chiffrables E2EE → ils partent via un compte mail connecté (SMTP).
const isExternalAddr = (e) => e.includes('@') && e.split('@')[1] !== 'comet.mail';

export default function Compose({ init = {}, onClose, onSent, onDeferredSend }) {
  const { user, myPublicKey } = useAuth();
  const [to, setTo] = useState((init.to || []).join(', '));
  const [cc, setCc] = useState((init.cc || []).join(', '));
  const [showCc, setShowCc] = useState(!!(init.cc && init.cc.length));
  const [subject, setSubject] = useState(init.subject || '');
  const [body, setBody] = useState(init.body || (!init.draftId && user.signature ? `\n\n-- \n${user.signature}` : ''));
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [draftId, setDraftId] = useState(init.draftId || null);
  const [eph, setEph] = useState('off'); // off | burn | <seconds>
  const [schedule, setSchedule] = useState('off'); // off | 1h | tomorrow | custom
  const [schedAt, setSchedAt] = useState('');
  const [templates, setTemplates] = useState([]);
  // « Écrire un message » se réduit à À / Objet / corps / Envoyer ; les options avancées
  // (modèle, éphémère, envoi programmé) sont repliées derrière un bouton pour le geste courant.
  const [showOpts, setShowOpts] = useState(false);
  const [recent, setRecent] = useState([]);
  const [sugOpen, setSugOpen] = useState(false);
  const [extAccounts, setExtAccounts] = useState([]); // comptes mail connectés (envoi externe)
  const [relaisSortant, setRelaisSortant] = useState({ configured: false, addresses: [] });
  const outboundAttempt = useRef(null);
  const [extPicker, setExtPicker] = useState(null);   // { accounts, count, sample } | null
  const [aliases, setAliases] = useState([]);         // alias actifs = adresses « De » possibles (perso/pro)
  const [from, setFrom] = useState('');               // adresse d'émission ('' = email principal)
  const isDesktop = !!(typeof window !== 'undefined' && window.cometDesktop && window.cometDesktop.isDesktop);
  const [torrentOpt, setTorrentOpt] = useState({ enabled: false, retentionDays: 7, maxDownloads: 0 });
  const [torrentConfig, setTorrentConfig] = useState(null); // panneau post-envoi (rétention)
  useEffect(() => { if (isDesktop && window.cometDesktop.torrent) window.cometDesktop.torrent.get().then(setTorrentOpt).catch(() => {}); }, []);

  function scheduledAtValue() {
    if (schedule === 'off') return null;
    if (schedule === 'custom') return schedAt ? new Date(schedAt).toISOString() : null;
    if (schedule === '1h') return new Date(Date.now() + 3600000).toISOString();
    if (schedule === 'tomorrow') { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return d.toISOString(); }
    return null;
  }
  const [files, setFiles] = useState([]); // [{ file, transferId, key }]

  async function addFiles(list) {
    const next = [];
    for (const orig of list) {
      if (orig.size > MAX_FILE) {
        // > 50 Mo → transfert volumineux : hébergé sur le serveur (web-seed / un client BitTorrent),
        // NON chiffré (décision produit). L'avertissement est affiché dans le compositeur.
        next.push({ file: orig, transferId: newTransferId(), large: true });
        continue;
      }
      const file = await stripImageMetadata(orig); // retire EXIF/géoloc des images
      next.push({ file, transferId: newTransferId(), key: newFileKey(), stripped: file !== orig });
    }
    setFiles((f) => [...f, ...next]);
  }
  const removeFile = (id) => setFiles((f) => f.filter((x) => x.transferId !== id));

  useEffect(() => { api.get('/templates').then((r) => setTemplates(r.templates)).catch(() => {}); }, []);
  useEffect(() => { api.get('/users/recent-recipients').then((r) => setRecent(r.recipients || [])).catch(() => {}); }, []);
  useEffect(() => { api.get('/accounts').then((r) => setExtAccounts((r.accounts || []).filter((a) => a.enabled))).catch(() => {}); }, []);
  useEffect(() => { api.get('/aliases').then((r) => setAliases((r.aliases || []).filter((a) => a.active))).catch(() => {}); }, []);
  const [fedEtat, setFedEtat] = useState({ active: false }); // fédération entre serveurs Comet
  useEffect(() => { api.get('/federation/etat').then(setFedEtat).catch(() => {}); }, []);

  function addRecipient(email) {
    const list = splitAddr(to);
    if (!list.map(normalizeEmail).includes(normalizeEmail(email))) setTo([...list, email].join(', '));
  }

  async function finishTorrent() {
    const days = Number(torrentConfig.retentionDays);
    const maxd = Number(torrentConfig.maxDownloads) || 0;
    // Applique la rétention côté serveur pour chaque fichier volumineux web-seedé.
    for (const it of torrentConfig.list) {
      try { await api.post('/attachments/config', { transferId: it.transferId, retentionDays: days, maxDownloads: maxd }); } catch {}
    }
    setTorrentConfig(null); onSent();
  }

  function applyTemplate(id) {
    const t = templates.find((x) => String(x.id) === String(id));
    if (!t) return;
    if (t.subject) setSubject(t.subject);
    setBody(t.body + (user.signature ? `\n\n-- \n${user.signature}` : ''));
  }

  const myEmail = normalizeEmail(user.email);

  function ephemeralPayload() {
    if (eph === 'off') return undefined;
    if (eph === 'burn') return { burnAfterRead: true };
    return { ttlSeconds: Number(eph) };
  }

  async function send(forcedExtId = null) {
    // Avertissement explicite : les fichiers > 50 Mo partent NON chiffrés (une seule fois,
    // pas lors du rappel après choix du compte externe).
    if (forcedExtId === null && files.some((f) => f.large)
      && !window.confirm("Attention : les fichiers de plus de 50 Mo sont envoyés NON CHIFFRÉS. Ils sont hébergés sur le serveur et récupérables via un client BitTorrent ou un lien de téléchargement direct. Continuer ?")) {
      return;
    }
    setMsg(''); setBusy(true);
    try {
      const allTo = splitAddr(to).map(normalizeEmail).join(',');
      const allCc = splitAddr(cc).map(normalizeEmail).join(',');
      if (!allTo && !allCc) { setMsg('Ajoutez au moins un destinataire.'); setBusy(false); return; }

      // Résolution (étend les listes de diffusion + alias) → { email, publicKey }
      const toRes = await api.get(`/users/recipients?emails=${encodeURIComponent(allTo)}`);
      const ccRes = await api.get(`/users/recipients?emails=${encodeURIComponent(allCc)}`);
      const toEmails = toRes.recipients.map((r) => r.email);
      const ccEmails = ccRes.recipients.map((r) => r.email);
      const hasInternal = toEmails.length + ccEmails.length > 0;

      // ── Autres serveurs Comet (fédération) ───────────────────────────────
      // Un serveur Comet existe pour ces adresses mais l'échange est impossible (bloqué,
      // injoignable, clé douteuse) : on s'arrête. Surtout pas de repli en clair.
      const fedErrors = [...(toRes.federationErrors || []), ...(ccRes.federationErrors || [])];
      if (fedErrors.length) { setMsg(fedErrors.map((e) => `${e.adresse} : ${e.raison}`).join(' · ')); setBusy(false); return; }
      const federes = [...toRes.recipients, ...ccRes.recipients].filter((r) => r.federe);
      if (federes.length) {
        if (files.length || schedule !== 'off' || eph !== 'off') {
          setMsg('Vers un autre serveur Comet : texte chiffré uniquement pour l’instant (ni pièce jointe, ni programmation, ni autodestruction).');
          setBusy(false); return;
        }
        // Attestation de chaque clé par le serveur du destinataire, vérifiée sur l'appareil.
        const verif = await verifierDestinatairesFederes(federes);
        if (verif.erreurs.length) { setMsg(verif.erreurs.join(' · ')); setBusy(false); return; }
        if (verif.avertissements.length && !window.confirm(`${verif.avertissements.join('\n\n')}\n\nEnvoyer quand même ?`)) { setBusy(false); return; }
      }

      // Destinataires non Comet → routés via un compte mail connecté (SMTP).
      const externalTo = toRes.unknown.filter(isExternalAddr);
      const externalCc = ccRes.unknown.filter(isExternalAddr);
      const externalAddrs = [...externalTo, ...externalCc];
      // Restent les @comet.mail inconnus (fautes de frappe) : ni chiffrables ni externes → ignorés.
      const badInternal = [...toRes.unknown, ...ccRes.unknown].filter((e) => !isExternalAddr(e));
      const relaisFrom = relaisSortant.addresses.includes(from) ? from : relaisSortant.addresses[0];
      const useRelais = !forcedExtId && relaisSortant.configured && (relaisSortant.addresses.includes(from) || extAccounts.length === 0);
      if (externalAddrs.length && (files.length || schedule !== 'off' || eph !== 'off')) {
        setMsg('Le courrier externe accepte actuellement le texte uniquement, sans programmation ni autodestruction. Retirez ces options avant l’envoi.');
        setBusy(false); return;
      }
      if (externalAddrs.length && !externalTo.length) {
        setMsg('Ajoutez au moins une adresse externe dans le champ À.'); setBusy(false); return;
      }

      if (!hasInternal && externalAddrs.length === 0) {
        setMsg('Aucun destinataire valide (adresse inconnue, liste vide ou jamais connecté).'); setBusy(false); return;
      }

      // Choix du compte d'envoi pour les destinataires externes.
      let extAccountId = forcedExtId;
      let extUnavailable = []; // externes non envoyés faute de compte connecté
      if (externalAddrs.length > 0 && !extAccountId && !useRelais) {
        if (extAccounts.length === 0) {
          // Aucun compte connecté : bloquant s'il n'y a QUE des externes, sinon on
          // envoie aux internes et on signale les externes laissés de côté.
          if (!hasInternal) {
            setMsg(`Pour écrire à ${externalAddrs[0]}, connectez d'abord un compte mail (Gmail, Outlook…) dans Paramètres.`);
            setBusy(false); return;
          }
          extUnavailable = externalAddrs;
        } else if (extAccounts.length === 1) {
          extAccountId = extAccounts[0].id;
        } else {
          setExtPicker({ accounts: extAccounts, count: externalAddrs.length, sample: externalAddrs[0] }); setBusy(false); return;
        }
      }

      // ── Envoi externe (SMTP via le compte connecté) ──────────────────────
      // D'abord, car l'envoi interne peut ouvrir un panneau interactif (torrent) qui interromprait le flux.
      let extNote = '';
      if (externalAddrs.length > 0 && useRelais) {
        const payload = { from: relaisFrom, to: externalTo, cc: externalCc, subject, text: body };
        const fingerprint = JSON.stringify(payload);
        if (outboundAttempt.current?.fingerprint !== fingerprint) outboundAttempt.current = { fingerprint, requestId: crypto.randomUUID() };
        await api.post('/outbound/send', { ...payload, requestId: outboundAttempt.current.requestId });
        extNote = `Pris en charge par le fournisseur d’envoi depuis ${relaisFrom} pour ${externalAddrs.length} destinataire(s) externe(s)`;
      }
      if (externalAddrs.length > 0 && extAccountId) {
        const acct = extAccounts.find((a) => a.id === extAccountId);
        try {
          await api.post(`/accounts/${extAccountId}/send`, {
            to: externalTo.join(', '), cc: externalCc.join(', ') || undefined,
            subject, text: body, inReplyTo: init.inReplyTo || undefined,
          });
        } catch (e) { setMsg('Envoi externe impossible : ' + (e.message || e)); setBusy(false); return; }
        extNote = `Mis en file pour ${externalAddrs.length} destinataire(s) externe(s) via ${acct ? acct.email : 'votre compte'}`
          + (files.length ? ' (sans les pièces jointes, réservées au courrier interne chiffré)' : '');
      }

      // ── Envoi interne chiffré (E2EE) ─────────────────────────────────────
      let scheduled = false;
      if (hasInternal) {
        const pubKeysByEmail = { [myEmail]: myPublicKey };
        for (const r of [...toRes.recipients, ...ccRes.recipients]) pubKeysByEmail[r.email] = r.publicKey;

        // Destinataires hors ligne → repli serveur (le blob chiffré y est stocké jusqu'à leur connexion)
        const offlineEmails = [...toRes.recipients, ...ccRes.recipients].filter((r) => !r.online).map((r) => r.email);

        // Pièces jointes : chiffrées une fois → P2P (offre mémoire) + repli serveur si besoin
        const attachments = [];
        const largeList = []; // fichiers volumineux web-seedés (config rétention post-envoi)
        for (const f of files) {
          // Chaque tentative utilise une nouvelle capacité : un dépôt publié
          // ne peut être écrasé, même si l'envoi du message a ensuite échoué.
          const transferId = newTransferId();
          // Fichier > 50 Mo → transfert VOLUMINEUX : téléversé BRUT (non chiffré) en STREAM
          // vers le serveur, qui génère un .torrent web-seed. Le destinataire le récupère via
          // un client BitTorrent (sans pair requis) ou en téléchargement direct. Pas de P2P WebTorrent.
          if (f.large) {
            let up;
            try {
              const resp = await fetch('/api/attachments/large', {
                method: 'POST',
                headers: {
                  Authorization: 'Bearer ' + getToken(),
                  'Content-Type': 'application/octet-stream',
                  'X-Transfer-Id': transferId,
                  'X-Filename': encodeURIComponent(f.file.name),
                  'X-Mimetype': f.file.type || 'application/octet-stream',
                  'X-Size': String(f.file.size),
                  'X-Retention-Days': String(torrentOpt.retentionDays ?? 7),
                  'X-Max-Downloads': String(torrentOpt.maxDownloads || 0),
                },
                body: f.file, // le File est streamé depuis le disque (pas de chargement en RAM)
              });
              up = await resp.json().catch(() => null);
              if (!resp.ok) throw new Error(up?.error || `HTTP ${resp.status}`);
            } catch (e) {
              throw new Error(`Échec de l'envoi de « ${f.file.name} » (fichier volumineux) : ${e.message || e}`);
            }
            if (!up?.torrent?.url) throw new Error(`Le serveur n'a pas pu préparer le torrent de « ${f.file.name} ».`);
            attachments.push({
              transferId, filename: f.file.name, size: f.file.size,
              mimetype: f.file.type || 'application/octet-stream', encrypted: false,
              webseed: { torrentUrl: up.torrent.url, downloadUrl: up.torrent.webSeed },
            });
            largeList.push({ infoHash: up.torrent.infoHash, transferId, filename: f.file.name, size: f.file.size });
            continue;
          }
          const buf = await f.file.arrayBuffer();
          const { ct, ivB64 } = await encryptAttachment(buf, f.key);
          offerFile(transferId, ct, ivB64);
          if (offlineEmails.length) {
            const fallback = await fetch('/api/attachments', {
              method: 'POST',
              headers: {
                Authorization: 'Bearer ' + getToken(),
                'Content-Type': 'application/octet-stream',
                'X-Transfer-Id': transferId, 'X-IV': ivB64,
                'X-Filename': encodeURIComponent(f.file.name),
                'X-Mimetype': f.file.type || 'application/octet-stream',
                'X-Size': String(f.file.size), 'X-To': offlineEmails.join(','),
              },
              body: ct,
            });
            if (!fallback.ok) {
              const error = await fallback.json().catch(() => null);
              throw new Error(error?.error || `Échec du dépôt de « ${f.file.name} » (HTTP ${fallback.status}).`);
            }
          }
          attachments.push({ transferId, filename: f.file.name, size: f.file.size, mimetype: f.file.type || 'application/octet-stream', key: f.key });
        }

        const enc = await encryptMessage({ subject, body, attachments }, pubKeysByEmail);
        const payload = {
          encrypted: true, to: toEmails, cc: ccEmails,
          ciphertext: enc.ciphertext, iv: enc.iv, keys: enc.keys,
          inReplyTo: init.inReplyTo || null, draftId, ephemeral: ephemeralPayload(),
          scheduledAt: scheduledAtValue(), fromEmail: from || undefined,
        };
        scheduled = !!payload.scheduledAt;

        // Envoi immédiat propre (aucun externe, aucun ignoré, aucun fichier volumineux) → fenêtre d'annulation.
        if (!scheduled && onDeferredSend && externalAddrs.length === 0 && badInternal.length === 0 && largeList.length === 0) {
          const undoData = { to: splitAddr(to), cc: splitAddr(cc), subject, body, inReplyTo: init.inReplyTo || null, draftId };
          onDeferredSend(payload, undoData);
          return;
        }

        const sent = await sendMail(payload);
        if (sent.queued) { setMsg('Hors ligne — message interne mis en file d\'attente (nouvel essai chaque minute).'); setTimeout(onSent, 1800); return; }
        // Fichier(s) volumineux web-seedés → régler conservation + nb max de téléchargements.
        if (largeList.length) {
          setTorrentConfig({ list: largeList, retentionDays: torrentOpt.retentionDays ?? 7, maxDownloads: torrentOpt.maxDownloads || '' });
          setBusy(false); return;
        }
      }

      // ── Bilan ────────────────────────────────────────────────────────────
      const notes = [];
      if (hasInternal) notes.push(`${scheduled ? 'Programmé' : 'Envoyé'} (chiffré)`);
      if (extNote) notes.push(extNote);
      if (extUnavailable.length) notes.push(`Non envoyé à ${extUnavailable.join(', ')} (aucun compte mail connecté — voir Paramètres)`);
      if (badInternal.length) notes.push(`Ignoré : ${badInternal.join(', ')}`);
      if (extNote || extUnavailable.length || badInternal.length) { setMsg(notes.join(' · ')); setTimeout(onSent, 2400); }
      else onSent();
    } catch (e) {
      setMsg(e.message); setBusy(false);
    }
  }

  async function saveDraft() {
    setBusy(true);
    try {
      const allTo = splitAddr(to).map(normalizeEmail);
      const allCc = splitAddr(cc).map(normalizeEmail);
      const enc = await encryptMessage({ subject, body }, { [myEmail]: myPublicKey });
      const r = await api.post('/mail/draft', { id: draftId, to: allTo, cc: allCc, ciphertext: enc.ciphertext, iv: enc.iv, encKey: enc.keys[myEmail] });
      setDraftId(r.draftId);
      setMsg('Brouillon chiffré enregistré.');
    } catch (e) { setMsg(e.message); }
    setBusy(false);
  }

  if (extPicker) {
    return (
      <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) { setExtPicker(null); setBusy(false); } }}>
        <div className="compose" style={{ maxWidth: 440 }}>
          <div className="compose-bar">Compte d'envoi externe<button onClick={() => { setExtPicker(null); setBusy(false); }} title="Fermer"><Icon name="close" size={18} /></button></div>
          <div style={{ padding: '6px 16px 16px' }}>
            <p className="setting-desc" style={{ marginTop: 0 }}>
              Ce message part vers <b>{extPicker.count} destinataire(s) externe(s)</b> (ex. {extPicker.sample}).
              Choisissez le compte à utiliser pour l'envoi :
            </p>
            <div className="card">
              {extPicker.accounts.map((a) => (
                <button key={a.id} type="button" className="alias-row" style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer' }}
                  onClick={() => { setExtPicker(null); send(a.id); }}>
                  <Icon name="mail" size={16} style={{ color: 'var(--accent)' }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>{a.label || a.email}</div>
                    <div className="setting-desc" style={{ margin: 0 }}>{a.email}{a.oauth ? ` · ${a.provider === 'gmail' ? 'Google' : 'Microsoft'}` : ''}</div>
                  </div>
                  <Icon name="send" size={15} />
                </button>
              ))}
            </div>
            <div className="modal-foot" style={{ marginTop: 12 }}>
              <button type="button" className="btn ghost" onClick={() => { setExtPicker(null); setBusy(false); }}>Annuler</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (torrentConfig) {
    return (
      <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) { setTorrentConfig(null); onSent(); } }}>
        <div className="compose" style={{ maxWidth: 460 }}>
          <div className="compose-bar">Fichier volumineux envoyé · torrent<button onClick={() => { setTorrentConfig(null); onSent(); }} title="Fermer"><Icon name="close" size={18} /></button></div>
          <div style={{ padding: '6px 16px 16px' }}>
            <p className="setting-desc" style={{ marginTop: 0 }}>Vos fichiers (&gt; 50 Mo) sont hébergés sur le serveur (<b>non chiffrés</b>) et partagés en <b>torrent web-seed</b> : le destinataire les récupère via <b>un client BitTorrent</b> (sans pair requis) ou en téléchargement direct. Le plafond concerne les téléchargements directs effectués en une seule fois. Il ne limite ni les téléchargements torrent ni les reprises partielles. La durée de conservation borne la disponibilité sur ce serveur.</p>
            {torrentConfig.list.map((it) => <div key={it.infoHash} className="att-chip" style={{ marginBottom: 6 }}><Icon name="paperclip" size={13} /> {it.filename}</div>)}
            <div className="field" style={{ marginTop: 10 }}><label>Conservation</label>
              <select value={torrentConfig.retentionDays} onChange={(e) => setTorrentConfig({ ...torrentConfig, retentionDays: e.target.value })}>
                <option value="1">1 jour</option><option value="7">7 jours</option><option value="30">30 jours</option><option value="0">Tant que l'application tourne</option>
              </select>
            </div>
            <div className="field" style={{ marginTop: 8 }}><label>Téléchargements complets max, hors torrent/reprises</label>
              <input type="number" min="0" placeholder="illimité" value={torrentConfig.maxDownloads} onChange={(e) => setTorrentConfig({ ...torrentConfig, maxDownloads: e.target.value })} />
            </div>
            <div className="modal-foot" style={{ marginTop: 14 }}><button className="btn" onClick={finishTorrent}>Terminer</button></div>
          </div>
        </div>
      </div>
    );
  }

  // Adresses externes saisies (hors comet.mail) → message d'aiguillage sous le champ À.
  const typedExternal = [...splitAddr(to), ...splitAddr(cc)].map(normalizeEmail).filter(isExternalAddr);

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="compose">
        <div className="compose-bar">
          Nouveau message{typedExternal.length ? ' · courrier externe' : ' · chiffré'}
          <button onClick={onClose} title="Fermer"><Icon name="close" size={18} /></button>
        </div>

        {(aliases.length > 0 || relaisSortant.addresses.length > 0) && (
          <div className="row">
            <label>De</label>
            <select value={from} onChange={(e) => setFrom(e.target.value)} style={{ flex: 1 }} title="Adresse d'envoi affichée au destinataire">
              <option value="">{user.email} · principale</option>
              {aliases.map((a) => <option key={a.id} value={a.email}>{a.email}{a.label ? ` · ${a.label}` : ''}</option>)}
            </select>
          </div>
        )}

        <div className="row">
          <label>À</label>
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="lea@comet.mail, marc@comet.mail" autoFocus
            onFocus={() => setSugOpen(true)} onBlur={() => setTimeout(() => setSugOpen(false), 150)} />
          {!showCc && <button className="btn ghost" style={{ padding: '4px 9px' }} onClick={() => setShowCc(true)}>Cc</button>}
        </div>
        {sugOpen && recent.filter((r) => !splitAddr(to).map(normalizeEmail).includes(normalizeEmail(r.email))).length > 0 && (
          <div className="sug-recent">
            <span className="sug-label">Récents</span>
            {recent.filter((r) => !splitAddr(to).map(normalizeEmail).includes(normalizeEmail(r.email))).map((r) => (
              <button type="button" key={r.email} className="sug-chip" title={r.email}
                onMouseDown={(e) => { e.preventDefault(); addRecipient(r.email); }}>
                <span className="sug-dot" style={{ background: r.avatarColor || 'var(--accent)' }} />{r.displayName || r.email}
              </button>
            ))}
          </div>
        )}
        {showCc && (
          <div className="row"><label>Cc</label><input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="copie@comet.mail" /></div>
        )}
        {typedExternal.length > 0 && (
          <div className="hint" style={{ margin: '2px 14px 4px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="mail" size={13} style={{ flexShrink: 0, color: extAccounts.length ? 'var(--accent)' : 'var(--danger)' }} />
            {fedEtat.active && <span>Sur un autre serveur Comet, le message part chiffré de bout en bout ; sinon : </span>}
            {relaisSortant.configured && (relaisSortant.addresses.includes(from) || extAccounts.length === 0)
              ? <span>Envoi depuis <b>{relaisSortant.addresses.includes(from) ? from : relaisSortant.addresses[0]}</b> via le relais d'envoi (non chiffré de bout en bout).</span>
              : extAccounts.length === 0
              ? <span>Adresse externe détectée — connectez un compte mail (Gmail, Outlook…) dans <b>Paramètres</b> pour l'envoyer.</span>
              : extAccounts.length === 1
                ? <span>Les destinataires hors Comet partiront via <b>{extAccounts[0].email}</b> (non chiffré de bout en bout).</span>
                : <span>Vous choisirez le compte d'envoi pour les destinataires hors Comet.</span>}
          </div>
        )}
        <div className="row"><label>Objet</label><input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Objet du message" /></div>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Écrivez votre message…" />

        {files.length > 0 && (
          <div className="att-row">
            {files.map((f) => (
              <span key={f.transferId} className="att-chip" title={f.large ? 'Fichier volumineux (> 50 Mo) — hébergé sur le serveur, NON chiffré' : 'Transfert pair-à-pair, chiffré'}>
                <Icon name="paperclip" size={13} /> {f.file.name} <span className="att-size">{fmtSize(f.file.size)}</span>
                {f.stripped && <span className="att-size" style={{ color: '#16a34a' }} title="Métadonnées EXIF/géoloc retirées">· nettoyé</span>}
                {f.large && <span className="att-size" style={{ color: 'var(--danger)' }} title="Fichier volumineux (> 50 Mo) — envoyé NON chiffré via le serveur (un client BitTorrent)">· non chiffré</span>}
                <button onClick={() => removeFile(f.transferId)} title="Retirer"><Icon name="close" size={12} /></button>
              </span>
            ))}
          </div>
        )}
        {files.some((f) => f.large) && (
          <div className="hint" style={{ margin: '2px 14px 6px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="paperclip" size={13} style={{ flexShrink: 0, color: 'var(--danger)' }} />
            <span><b>Fichier de plus de 50 Mo</b> : envoyé <b>non chiffré</b> (hébergé sur le serveur, partagé via un client BitTorrent ou lien direct).</span>
          </div>
        )}

        <div className="compose-foot">
          <button className="btn" disabled={busy} onClick={() => send()}><Icon name={schedule === 'off' ? 'send' : 'clock'} size={16} /> {schedule === 'off' ? 'Envoyer' : 'Programmer'}</button>
          <button className="btn ghost" disabled={busy} onClick={saveDraft}>Brouillon</button>
          <label className="icon-btn" title="Joindre un fichier" style={{ cursor: 'pointer' }}>
            <Icon name="paperclip" size={16} />
            <input type="file" multiple style={{ display: 'none' }} onChange={(e) => { addFiles([...e.target.files]); e.target.value = ''; }} />
          </label>
          <button type="button" className={`icon-btn ${showOpts ? 'active' : ''}`} title="Plus d'options : modèle, message éphémère, envoi programmé" aria-expanded={showOpts} onClick={() => setShowOpts((v) => !v)}>
            <Icon name="sliders" size={16} />
          </button>
          {showOpts && (<>
            {templates.length > 0 && (
              <label className="eph-select" title="Insérer un modèle">
                <Icon name="draft" size={15} />
                <select value="" onChange={(e) => applyTemplate(e.target.value)}>
                  <option value="">Modèle…</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
            )}
            <label className="eph-select" title="Message éphémère">
              <Icon name="clock" size={15} />
              <select value={eph} onChange={(e) => setEph(e.target.value)}>
                <option value="off">Permanent</option>
                <option value="burn">Détruit après lecture</option>
                <option value="3600">Expire dans 1 h</option>
                <option value="86400">Expire dans 24 h</option>
                <option value="604800">Expire dans 7 jours</option>
              </select>
            </label>
            <label className="eph-select" title="Envoi programmé">
              <Icon name="send" size={15} />
              <select value={schedule} onChange={(e) => setSchedule(e.target.value)}>
                <option value="off">Maintenant</option>
                <option value="1h">Dans 1 heure</option>
                <option value="tomorrow">Demain 8 h</option>
                <option value="custom">Date précise…</option>
              </select>
            </label>
            {schedule === 'custom' && <input type="datetime-local" className="sched-input" value={schedAt} onChange={(e) => setSchedAt(e.target.value)} />}
          </>)}
          <span className="msg">{msg}</span>
        </div>
      </div>
    </div>
  );
}
