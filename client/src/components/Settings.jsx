import { useEffect, useRef, useState } from 'react';
import { api, getToken } from '../api.js';
import { useAuth } from '../auth.jsx';
import { keyFingerprint, generateBoxIdentity, wrapKeyFor, normalizeEmail } from '../crypto.js';
import { hasPIN, setPIN, removePIN, getTimeoutMin, setTimeoutMin } from '../lock.js';
import { expediteursDeConfiance, imagesAutoActif, retirerConfiance, setImagesAuto } from './MailHtmlView.jsx';
import Icon from './Icon.jsx';

// Découpe une clé en groupes de 4 (lisibilité). NB : ne PAS nommer « groups » —
// l'état des listes de diffusion `groups` masquerait ce helper dans le composant.
const groupDigits = (s) => (String(s || '').match(/.{1,4}/g) || []).join(' ');

// Sections de l'interface Paramètres (navigation à gauche).
const SETTINGS_SECTIONS = [
  { id: 'securite', label: 'Sécurité', icon: 'shield' },
  { id: 'courrier', label: 'Courrier', icon: 'mail' },
  { id: 'confidentialite', label: 'Confidentialité', icon: 'lock' },
  { id: 'bureau', label: 'Application de bureau', icon: 'comet', desktop: true },
  { id: 'avance', label: 'Avancé', icon: 'sliders' },
];

function deviceLabel(ua = '') {
  const b = /Edg/.test(ua) ? 'Edge' : /Firefox/.test(ua) ? 'Firefox' : /Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Navigateur';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} · ${os}` : b;
}
const fmtWhen = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '');

export default function Settings({ onClose, onAccountsChanged }) {
  const { user, refreshUser, myPublicKey } = useAuth();
  const [pin1, setPin1] = useState('');
  const [pin2, setPin2] = useState('');
  const [pinSet, setPinSet] = useState(hasPIN());
  const [lockMin, setLockMin] = useState(getTimeoutMin());
  const [pinErr, setPinErr] = useState('');
  // Images distantes des courriers : réglage local à cet appareil (il n'a aucun sens côté
  // serveur — c'est le navigateur qui émet, ou non, la requête).
  const [imgAuto, setImgAuto] = useState(imagesAutoActif);
  function toggleImgAuto(v) { setImagesAuto(v); setImgAuto(v); }
  const [trusted, setTrusted] = useState(expediteursDeConfiance);
  const [fp, setFp] = useState('');

  useEffect(() => { keyFingerprint(myPublicKey).then(setFp); }, [myPublicKey]);

  async function enablePIN() {
    setPinErr('');
    if (pin1.length < 4) return setPinErr('4 chiffres minimum.');
    if (pin1 !== pin2) return setPinErr('Les codes ne correspondent pas.');
    await setPIN(pin1); setTimeoutMin(lockMin); setPinSet(true); setPin1(''); setPin2('');
  }
  function disablePIN() { removePIN(); setPinSet(false); }
  function changeLockMin(m) { setLockMin(m); setTimeoutMin(m); }
  const [step, setStep] = useState('idle'); // idle | setup | recovery | disable
  const [secret, setSecret] = useState('');
  const [otpauth, setOtpauth] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [recovery, setRecovery] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // QR code du 2FA : rendu (CDN qrcode-generator) à l'ouverture de l'écran de config,
  // pour scanner au lieu de recopier la clé. data-cfasync=false évite Rocket Loader.
  const qrRef = useRef(null);
  useEffect(() => {
    if (step !== 'setup' || !otpauth) return;
    let cancelled = false;
    function draw() {
      if (cancelled || !qrRef.current || typeof window.qrcode === 'undefined') return;
      try {
        const qr = window.qrcode(0, 'M'); qr.addData(otpauth); qr.make();
        qrRef.current.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2 });
        const sv = qrRef.current.querySelector('svg');
        if (sv) { sv.style.width = '180px'; sv.style.height = '180px'; sv.style.display = 'block'; }
      } catch { /* QR indisponible : la clé reste affichée */ }
    }
    if (typeof window.qrcode === 'undefined') {
      let s = document.getElementById('qrcode-cdn');
      if (!s) { s = document.createElement('script'); s.id = 'qrcode-cdn'; s.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js'; s.setAttribute('data-cfasync', 'false'); document.head.appendChild(s); }
      s.addEventListener('load', draw, { once: true });
    } else { draw(); }
    return () => { cancelled = true; };
  }, [step, otpauth]);

  const [aliases, setAliases] = useState([]);
  const [aliasLabel, setAliasLabel] = useState('');
  // Adresse de contact externe : `undefined` = pas encore su, `null` = injoignable.
  // Les trois cas sont DISTINCTS à l'écran — « je ne sais pas » ne doit pas se lire
  // comme « vous n'en avez pas ».
  const [extAdr, setExtAdr] = useState(undefined);
  const [copied, setCopied] = useState('');
  const [sessions, setSessions] = useState([]);
  const [sig, setSig] = useState(user.signature || '');
  const [sigSaved, setSigSaved] = useState(false);
  const [away, setAway] = useState(user.away || { enabled: false, message: '', until: null });
  const [listed, setListed] = useState(user.listed !== false);
  const isDesktop = !!(typeof window !== 'undefined' && window.cometDesktop && window.cometDesktop.isDesktop);
  const [autoStart, setAutoStart] = useState(false);
  const [sec, setSec] = useState('securite');
  const [dlDir, setDlDir] = useState('');
  const [torrent, setTorrent] = useState({ enabled: false, retentionDays: 7, maxDownloads: 0 });
  const [tpls, setTpls] = useState([]);
  const [tplForm, setTplForm] = useState({ name: '', subject: '', body: '' });
  const [groups, setGroups] = useState([]);
  const [grpForm, setGrpForm] = useState({ name: '', members: '' });
  const [conn, setConn] = useState(null);       // état du connecteur (admin)
  const [connKey, setConnKey] = useState('');   // clé affichée une seule fois
  const [storagePath, setStoragePath] = useState('');

  useEffect(() => {
    if (!user.isAdmin) return;
    api.get('/connector/status').then((s) => { setConn(s); setStoragePath(s.storage?.path || ''); }).catch(() => {});
  }, [user.isAdmin]);

  useEffect(() => { if (isDesktop) window.cometDesktop.getAutoStart().then((v) => setAutoStart(!!v)).catch(() => {}); }, [isDesktop]);
  async function toggleAutoStart(v) { setAutoStart(v); try { const r = await window.cometDesktop.setAutoStart(v); setAutoStart(!!r); } catch { setAutoStart(!v); } }
  useEffect(() => { if (isDesktop && window.cometDesktop.downloads) window.cometDesktop.downloads.get().then((d) => setDlDir(d || '')).catch(() => {}); }, [isDesktop]);
  async function chooseDlDir() { try { setDlDir((await window.cometDesktop.downloads.choose()) || ''); } catch {} }
  async function clearDlDir() { try { await window.cometDesktop.downloads.clear(); setDlDir(''); } catch {} }
  useEffect(() => { if (isDesktop && window.cometDesktop.torrent) window.cometDesktop.torrent.get().then(setTorrent).catch(() => {}); }, [isDesktop]);
  async function saveTorrent(patch) { setTorrent((t) => ({ ...t, ...patch })); try { const r = await window.cometDesktop.torrent.set(patch); setTorrent(r); } catch {} }

  async function genConnKey() { const r = await api.post('/connector/key', {}); setConnKey(r.key); api.get('/connector/status').then(setConn).catch(() => {}); }
  async function revokeConnKey() { await api.del('/connector/key'); setConnKey(''); api.get('/connector/status').then(setConn).catch(() => {}); }
  async function saveStorage(enabled) { const r = await api.put('/connector/config', { enabled, path: storagePath }); setConn((c) => ({ ...c, storage: r.storage })); }
  async function downloadConnector() {
    const res = await fetch('/api/connector/download', { headers: { Authorization: `Bearer ${getToken()}` } });
    const text = await res.text();
    const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    const a = document.createElement('a'); a.href = url; a.download = 'comet-connector.mjs'; a.click(); URL.revokeObjectURL(url);
  }

  const [pairCode, setPairCode] = useState('');
  async function genPairCode() { const r = await api.post('/extension/pair-code', {}); setPairCode(r.code); }

  // ── Comptes mail externes (IMAP/SMTP) ──
  const MAIL_PRESETS = {
    gmail: { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 },
    outlook: { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587 },
    yahoo: { imapHost: 'imap.mail.yahoo.com', imapPort: 993, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465 },
    autre: { imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465 },
  };
  const [mailAccounts, setMailAccounts] = useState([]);
  const [acctForm, setAcctForm] = useState({ provider: 'gmail', email: '', password: '', label: '', ...MAIL_PRESETS.gmail });
  const [acctBusy, setAcctBusy] = useState(false);
  const [acctErr, setAcctErr] = useState('');
  useEffect(() => { api.get('/accounts').then((r) => setMailAccounts(r.accounts)).catch(() => {}); }, []);
  const reloadAccounts = () => api.get('/accounts').then((r) => { setMailAccounts(r.accounts); onAccountsChanged?.(); }).catch(() => {});
  function setProvider(p) { setAcctForm((f) => ({ ...f, provider: p, ...MAIL_PRESETS[p] })); }

  // OAuth (Gmail/Outlook) : popup de consentement + retour par postMessage
  const [oauthReady, setOauthReady] = useState([]);
  useEffect(() => { api.get('/accounts/oauth/providers').then((r) => setOauthReady(r.configured || [])).catch(() => {}); }, []);
  useEffect(() => {
    const h = (e) => { if (e.data && e.data.comet === 'oauth-done') reloadAccounts(); };
    window.addEventListener('message', h);
    return () => window.removeEventListener('message', h);
  }, []);
  async function startOAuth(provider) {
    try {
      const { url } = await api.get(`/accounts/oauth/${provider}/start`);
      window.open(url, 'comet-oauth', 'width=520,height=680');
    } catch (err) { setAcctErr(err.message); }
  }


  // ── Assistant IA (via le connecteur, désactivé par défaut) ──
  // On garde l'état COMPLET (moteur joignable ou non) : activer l'interrupteur ne
  // suffit pas à faire exister un assistant, l'admin doit le voir tout de suite.
  const [ai, setAi] = useState({ enabled: false, ready: false, state: 'off', reason: null });
  const aiEnabled = !!ai.enabled;
  useEffect(() => { api.get('/assistant/status').then(setAi).catch(() => {}); }, []);
  async function toggleAi(v) { try { setAi(await api.post('/assistant/status', { enabled: v })); } catch (err) { window.alert(err.message); } }
  async function addAccount(e) {
    e.preventDefault(); setAcctErr(''); setAcctBusy(true);
    try { const r = await api.post('/accounts', acctForm); setMailAccounts((a) => [...a, r.account]); onAccountsChanged?.(); setAcctForm({ provider: 'gmail', email: '', password: '', label: '', ...MAIL_PRESETS.gmail }); }
    catch (err) { setAcctErr(err.message); }
    setAcctBusy(false);
  }
  async function delAccount(a) { if (!window.confirm(`Déconnecter ${a.email} ?`)) return; await api.del(`/accounts/${a.id}`); setMailAccounts((l) => l.filter((x) => x.id !== a.id)); onAccountsChanged?.(); }
  async function syncAccount(a) { try { await api.post(`/accounts/${a.id}/sync`, {}); reloadAccounts(); } catch {} }

  // ── Boîtes aux lettres partagées (E2EE) ──
  const [boxes, setBoxes] = useState([]);
  const [boxForm, setBoxForm] = useState({ name: '', address: '', members: '' });
  const [boxBusy, setBoxBusy] = useState(false);
  const [boxErr, setBoxErr] = useState('');
  useEffect(() => { api.get('/shared').then((r) => setBoxes(r.boxes)).catch(() => {}); }, []);
  async function createBox(e) {
    e.preventDefault(); setBoxErr('');
    if (!boxForm.name.trim() || !boxForm.address.trim()) { setBoxErr('Nom et adresse requis'); return; }
    setBoxBusy(true);
    try {
      // Membres = créateur + adresses saisies. On chiffre la clé de boîte pour chacun.
      const emails = [...new Set([normalizeEmail(user.email), ...boxForm.members.split(/[,;\s]+/).map(normalizeEmail).filter(Boolean)])];
      const { keys } = await api.get(`/users/keys?emails=${encodeURIComponent(emails.join(','))}`);
      const { publicKey, boxKey, wrappedPrivateKey } = await generateBoxIdentity();
      const members = {};
      for (const em of emails) if (keys[em]) members[em] = await wrapKeyFor(boxKey, keys[em]);
      if (!members[normalizeEmail(user.email)]) { setBoxErr('Votre clé de chiffrement est indisponible'); setBoxBusy(false); return; }
      const r = await api.post('/shared', { name: boxForm.name.trim(), address: boxForm.address.trim(), publicKey, wrappedPrivateKey, members });
      setBoxes((b) => [...b, r.box]); setBoxForm({ name: '', address: '', members: '' });
    } catch (err) { setBoxErr(err.message || 'Création impossible'); }
    setBoxBusy(false);
  }
  async function delBox(b) { if (!window.confirm(`Supprimer définitivement la boîte ${b.address} et tout son contenu ?`)) return; try { await api.del(`/shared/${b.id}`); setBoxes((l) => l.filter((x) => x.id !== b.id)); } catch (err) { window.alert(err.message); } }

  // ── Règles de courrier (filtres par expéditeur) ──
  const [rules, setRules] = useState([]);
  const [ruleForm, setRuleForm] = useState({ matchFrom: '', actionFolder: '', actionStar: false, actionRead: false });
  useEffect(() => { api.get('/rules').then((r) => setRules(r.rules)).catch(() => {}); }, []);
  async function addRule(e) { e.preventDefault(); if (!ruleForm.matchFrom.trim()) return; const r = await api.post('/rules', ruleForm); setRules((l) => [...l, r.rule]); setRuleForm({ matchFrom: '', actionFolder: '', actionStar: false, actionRead: false }); }
  async function delRule(rl) { await api.del(`/rules/${rl.id}`); setRules((l) => l.filter((x) => x.id !== rl.id)); }
  async function toggleRule(rl) { const r = await api.patch(`/rules/${rl.id}`, { enabled: !rl.enabled }); setRules((l) => l.map((x) => (x.id === rl.id ? r.rule : x))); }
  const ruleActions = (rl) => [rl.actionFolder === 'archive' && 'Archiver', rl.actionFolder === 'trash' && 'Corbeille', rl.actionStar && 'Étoiler', rl.actionRead && 'Marquer lu'].filter(Boolean).join(' · ') || 'Aucune action';
  async function downloadExtension() {
    const res = await fetch('/api/extension/download', { headers: { Authorization: `Bearer ${getToken()}` } });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'comet-extension.zip'; a.click(); URL.revokeObjectURL(url);
  }

  const enabled = user.twoFactorEnabled;

  async function saveSig() {
    await api.patch('/auth/profile', { signature: sig });
    await refreshUser();
    setSigSaved(true); setTimeout(() => setSigSaved(false), 1500);
  }

  const loadSessions = () => api.get('/auth/sessions').then((r) => setSessions(r.sessions)).catch(() => {});
  useEffect(() => {
    api.get('/aliases').then((r) => setAliases(r.aliases)).catch(() => {});
    api.get('/templates').then((r) => setTpls(r.templates)).catch(() => {});
    api.get('/groups').then((r) => setGroups(r.groups)).catch(() => {});
    loadSessions();
  }, []);

  async function revokeSession(s) { await api.del(`/auth/sessions/${s.id}`); loadSessions(); }
  async function revokeOthers() { await api.post('/auth/sessions/revoke-others'); loadSessions(); }
  async function saveAway() { const r = await api.patch('/auth/profile', { away }); setAway(r.user.away); await refreshUser(); }
  async function toggleListed(v) { setListed(v); try { const r = await api.patch('/auth/profile', { listed: v }); setListed(r.user.listed); await refreshUser(); } catch { setListed(!v); } }
  async function addTpl() {
    if (!tplForm.name.trim()) return;
    const r = await api.post('/templates', tplForm);
    setTpls((t) => [...t, r.template]); setTplForm({ name: '', subject: '', body: '' });
  }
  async function delTpl(t) { await api.del(`/templates/${t.id}`); setTpls((l) => l.filter((x) => x.id !== t.id)); }
  async function addGroup() {
    if (!grpForm.name.trim()) return;
    const members = grpForm.members.split(/[,;\s]+/).filter(Boolean);
    const r = await api.post('/groups', { name: grpForm.name, members });
    setGroups((g) => [r.group, ...g]); setGrpForm({ name: '', members: '' });
  }
  async function delGroup(g) { await api.del(`/groups/${g.id}`); setGroups((l) => l.filter((x) => x.id !== g.id)); }

  async function startSetup() {
    setError(''); setBusy(true);
    try { const r = await api.post('/auth/2fa/setup'); setSecret(r.secret); setOtpauth(r.otpauth); setStep('setup'); }
    catch (e) { setError(e.message); }
    setBusy(false);
  }
  async function confirmEnable() {
    setError(''); setBusy(true);
    try { const r = await api.post('/auth/2fa/enable', { code }); setRecovery(r.recoveryCodes); setStep('recovery'); setCode(''); await refreshUser(); }
    catch (e) { setError(e.message); }
    setBusy(false);
  }
  async function disable() {
    setError(''); setBusy(true);
    try { await api.post('/auth/2fa/disable', { code, password }); await refreshUser(); setStep('idle'); setCode(''); setPassword(''); }
    catch (e) { setError(e.message); }
    setBusy(false);
  }

  async function genAlias() {
    const r = await api.post('/aliases', { label: aliasLabel });
    setAliases((a) => [r.alias, ...a]); setAliasLabel('');
  }
  async function toggleAlias(a) {
    const r = await api.patch(`/aliases/${a.id}`, { active: !a.active });
    setAliases((list) => list.map((x) => (x.id === a.id ? r.alias : x)));
  }
  async function delAlias(a) {
    await api.del(`/aliases/${a.id}`);
    setAliases((list) => list.filter((x) => x.id !== a.id));
  }
  function copy(text) { navigator.clipboard?.writeText(text); setCopied(text); setTimeout(() => setCopied(''), 1200); }

  // Sous-flux 2FA (prend tout le modal)
  if (step !== 'idle') {
    return (
      <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="modal" style={{ maxWidth: 520 }}>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="shield" size={18} /> Double authentification</h3>
          {error && <div className="alert" style={{ marginTop: 14 }}>{error}</div>}

          {step === 'setup' && (<>
            <p className="setting-desc">1. Scannez ce QR code avec votre application d'authentification, ou ajoutez la clé manuellement (ou le lien <code>otpauth://</code>) :</p>
            <div ref={qrRef} style={{ background: '#fff', borderRadius: 12, padding: 10, display: 'inline-block', marginBottom: 12 }} />
            <div className="secret-box">{groupDigits(secret)}</div>
            <textarea className="otpauth" readOnly value={otpauth} onFocus={(e) => e.target.select()} />
            <p className="setting-desc">2. Saisissez le code à 6 chiffres généré :</p>
            <input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" inputMode="numeric" autoFocus />
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setStep('idle')}>Annuler</button>
              <button className="btn" disabled={busy || code.length < 6} onClick={confirmEnable}>Confirmer l'activation</button>
            </div>
          </>)}

          {step === 'recovery' && (<>
            <p className="setting-desc">2FA activée. <b>Conservez ces codes de récupération</b> (usage unique) :</p>
            <div className="recovery-grid">{recovery.map((c) => <code key={c}>{c}</code>)}</div>
            <div className="modal-foot"><button className="btn" onClick={() => setStep('idle')}>J'ai noté mes codes</button></div>
          </>)}

          {step === 'disable' && (<>
            <p className="setting-desc">Confirmez avec un code 2FA ou votre mot de passe :</p>
            <input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code à 6 chiffres" style={{ marginBottom: 10 }} inputMode="numeric" />
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Mot de passe" />
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => { setStep('idle'); setError(''); }}>Annuler</button>
              <button className="btn" style={{ background: 'var(--danger)' }} disabled={busy} onClick={disable}>Désactiver la 2FA</button>
            </div>
          </>)}
        </div>
      </div>
    );
  }

  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="settings-modal">
        <aside className="settings-nav">
          <div className="settings-nav-title">Paramètres</div>
          {SETTINGS_SECTIONS.filter((s) => !s.desktop || isDesktop).map((s) => (
            <button key={s.id} className={`settings-nav-item ${sec === s.id ? 'active' : ''}`} onClick={() => setSec(s.id)}>
              <Icon name={s.icon} size={16} /> {s.label}
            </button>
          ))}
          <div className="settings-nav-spacer" />
          <button className="settings-nav-item" onClick={onClose}><Icon name="close" size={16} /> Fermer</button>
        </aside>
        <div className="settings-body" data-sec={sec}>


        {/* 2FA */}
        <div className="setting-row ss-section ss-securite">
          <div>
            <div className="setting-title">Double authentification (2FA)</div>
            <div className="setting-desc">Un code temporel en plus du mot de passe à la connexion.</div>
          </div>
          <span className={`badge ${enabled ? 'on' : ''}`}>{enabled ? 'Activée' : 'Désactivée'}</span>
          {enabled
            ? <button className="btn ghost" style={{ marginLeft: 10 }} onClick={() => setStep('disable')}>Désactiver</button>
            : <button className="btn" style={{ marginLeft: 10 }} disabled={busy} onClick={startSetup}>Activer</button>}
        </div>

        {/* Verrou de l'application */}
        <div className="ss-section ss-securite" style={{ marginTop: 20 }}>
          <div className="setting-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="lock" size={16} /> Verrou de l'application</div>
          <div className="setting-desc">Protège l'accès par un code PIN (verrouillage après inactivité ou à la demande).</div>
          {pinErr && <div className="alert" style={{ marginTop: 8 }}>{pinErr}</div>}
          {!pinSet ? (
            <>
              <div className="row2" style={{ marginTop: 8 }}>
                <div className="field"><label>Code PIN</label><input type="password" inputMode="numeric" value={pin1} onChange={(e) => setPin1(e.target.value)} placeholder="••••" /></div>
                <div className="field"><label>Confirmer</label><input type="password" inputMode="numeric" value={pin2} onChange={(e) => setPin2(e.target.value)} placeholder="••••" /></div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                <label className="setting-desc" style={{ margin: 0 }}>Verrouiller après <select value={lockMin} onChange={(e) => setLockMin(Number(e.target.value))} style={{ marginLeft: 6 }}><option value={0}>jamais</option><option value={1}>1 min</option><option value={5}>5 min</option><option value={15}>15 min</option></select></label>
                <button className="btn" style={{ marginLeft: 'auto' }} onClick={enablePIN}>Activer le verrou</button>
              </div>
            </>
          ) : (
            <div className="setting-row">
              <div><div className="setting-title">Verrou actif</div><div className="setting-desc">Verrouillage {lockMin > 0 ? `après ${lockMin} min d'inactivité` : 'manuel uniquement'}.</div></div>
              <select value={lockMin} onChange={(e) => changeLockMin(Number(e.target.value))}><option value={0}>jamais</option><option value={1}>1 min</option><option value={5}>5 min</option><option value={15}>15 min</option></select>
              <button className="btn ghost" style={{ marginLeft: 8 }} onClick={disablePIN}>Retirer</button>
            </div>
          )}
        </div>

        {/* Empreinte de sécurité */}
        <div className="ss-section ss-securite" style={{ marginTop: 20 }}>
          <div className="setting-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="badge" size={16} /> Empreinte de sécurité</div>
          <div className="setting-desc">Comparez ce nombre avec vos correspondants (par un autre canal) pour vérifier qu'aucune clé n'a été substituée (anti-MITM).</div>
          <div className="secret-box" style={{ fontSize: 15, letterSpacing: 1 }}>{fp}</div>
        </div>

        {/* Tableau de bord confidentialité */}
        <div className="ss-section ss-confidentialite" style={{ marginTop: 20 }}>
          <div className="setting-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="shield" size={16} /> Confidentialité — ce que le serveur voit</div>
          <div className="privacy-grid">
            <div className="priv ok"><Icon name="check" size={15} /> Contenu des mails : <b>chiffré de bout en bout</b> (serveur aveugle)</div>
            <div className="priv ok"><Icon name="check" size={15} /> Pièces jointes (en ligne) : <b>P2P</b> — jamais sur le serveur</div>
            <div className="priv ok"><Icon name="check" size={15} /> Coffre-fort & brouillons : <b>chiffrés</b></div>
            <div className="priv ok"><Icon name="check" size={15} /> Clé privée : <b>jamais transmise en clair</b></div>
            <div className="priv warn"><Icon name="clock" size={15} /> Métadonnées (expéditeur, destinataires, date) : <b>visibles du serveur</b></div>
            <div className="priv warn"><Icon name="clock" size={15} /> Pièces jointes (hors ligne) : <b>stockées chiffrées</b> jusqu'à récupération</div>
          </div>
        </div>

        {/* Signature professionnelle */}
        <div className="ss-section ss-courrier" style={{ marginTop: 20 }}>
          <div className="setting-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="pen" size={16} /> Signature</div>
          <div className="setting-desc">Ajoutée automatiquement au bas de vos nouveaux messages.</div>
          <textarea className="input" style={{ resize: 'vertical', minHeight: 72, marginTop: 8 }} value={sig} onChange={(e) => setSig(e.target.value)} placeholder={'Nom Prénom\nPoste — Société\n+33 …'} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
            <button className="btn" onClick={saveSig}>Enregistrer la signature</button>
            {sigSaved && <span className="setting-desc" style={{ margin: 0, color: '#16a34a' }}>Enregistré ✓</span>}
          </div>
        </div>

        {/* Réponse automatique d'absence */}
        <div className="ss-section ss-courrier" style={{ marginTop: 20 }}>
          <div className="setting-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="clock" size={16} /> Réponse automatique d'absence</div>
          <div className="setting-desc">Renvoyée automatiquement à quiconque vous écrit pendant votre absence.</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0', fontSize: 13.5 }}>
            <input type="checkbox" checked={away.enabled} onChange={(e) => setAway({ ...away, enabled: e.target.checked })} /> Activer la réponse d'absence
          </label>
          <textarea className="input" style={{ resize: 'vertical', minHeight: 60 }} value={away.message} onChange={(e) => setAway({ ...away, message: e.target.value })} placeholder="Je suis absent(e) et répondrai à mon retour." />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
            <label className="setting-desc" style={{ margin: 0 }}>Jusqu'au <input type="date" value={away.until || ''} onChange={(e) => setAway({ ...away, until: e.target.value || null })} style={{ marginLeft: 6 }} /></label>
            <button className="btn" style={{ marginLeft: 'auto' }} onClick={saveAway}>Enregistrer</button>
          </div>
        </div>

        {/* Application de bureau : serveur utilisé */}
        {isDesktop && window.cometDesktop.serveur && (
          <div className="ss-section ss-bureau" style={{ marginTop: 20 }}>
            <div className="setting-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="globe" size={16} /> Serveur</div>
            <div className="setting-desc">Cette application est connectée à <b>{location.origin}</b>. Vous pouvez la relier à un autre serveur Comet ; vos réglages de bureau sont conservés.</div>
            <button className="btn ghost" style={{ marginTop: 10 }} onClick={() => window.cometDesktop.serveur.changer()}>Changer de serveur</button>
          </div>
        )}

        {/* Application de bureau : démarrage auto */}
        {isDesktop && (
          <div className="ss-section ss-bureau" style={{ marginTop: 20 }}>
            <div className="setting-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="comet" size={16} /> Démarrage</div>
            <div className="setting-desc">Lancer Comet automatiquement à l'ouverture de session (utile pour rester joignable en visio/P2P).</div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0', fontSize: 13.5 }}>
              <input type="checkbox" checked={autoStart} onChange={(e) => toggleAutoStart(e.target.checked)} /> Démarrer Comet au démarrage du PC
            </label>
          </div>
        )}

        {/* Application de bureau : répertoire de téléchargement */}
        {isDesktop && (
          <div className="ss-section ss-bureau" style={{ marginTop: 20 }}>
            <div className="setting-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="inbox" size={16} /> Téléchargements</div>
            <div className="setting-desc">Choisissez un dossier pour <b>ne plus avoir à indiquer l'emplacement</b> à chaque fichier téléchargé. Sinon, l'emplacement est demandé à chaque fois.</div>
            {dlDir ? (
              <div className="card" style={{ marginTop: 10 }}>
                <div className="alias-row">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>Dossier par défaut</div>
                    <div className="setting-desc" style={{ margin: 0, wordBreak: 'break-all' }}>{dlDir}</div>
                  </div>
                  <button className="icon-btn" onClick={chooseDlDir} title="Changer">Changer</button>
                  <button className="icon-btn" onClick={clearDlDir} title="Demander à chaque fois">Réinitialiser</button>
                </div>
              </div>
            ) : (
              <button className="btn" style={{ marginTop: 10 }} onClick={chooseDlDir}><Icon name="inbox" size={15} /> Choisir un dossier de téléchargement</button>
            )}
          </div>
        )}

        {/* Application de bureau : transfert par torrent (> 50 Mo) */}
        {isDesktop && (
          <div className="ss-section ss-bureau" style={{ marginTop: 20 }}>
            <div className="setting-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="flow" size={16} /> Transfert des gros fichiers (torrent)</div>
            <div className="setting-desc">Les fichiers de <b>plus de 50 Mo</b> sont partagés en <b>pair-à-pair (torrent chiffré)</b> depuis ce poste — jamais sur le serveur. À l'envoi, vous réglez la durée de conservation et un nombre maximal de téléchargements. <b>Le destinataire doit aussi avoir le client Comet.</b></div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0', fontSize: 13.5 }}>
              <input type="checkbox" checked={torrent.enabled} onChange={(e) => saveTorrent({ enabled: e.target.checked })} /> Activer le transfert par torrent
            </label>
            {torrent.enabled && (
              <div className="row2">
                <div className="field"><label>Conservation par défaut</label>
                  <select value={torrent.retentionDays} onChange={(e) => saveTorrent({ retentionDays: Number(e.target.value) })}>
                    <option value={1}>1 jour</option><option value={7}>7 jours</option><option value={30}>30 jours</option><option value={0}>Tant que l'app tourne</option>
                  </select>
                </div>
                <div className="field"><label>Téléchargements max (0 = illimité)</label>
                  <input type="number" min="0" value={torrent.maxDownloads} onChange={(e) => saveTorrent({ maxDownloads: Number(e.target.value) || 0 })} />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Confidentialité — Images des messages */}
        <div className="ss-section ss-confidentialite" style={{ marginTop: 20 }}>
          <div className="setting-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="shield" size={16} /> Images des messages</div>
          <div className="setting-desc">
            Un courrier commercial contient souvent une image invisible d'un pixel. La charger ne change rien
            à ce que vous voyez, mais elle signale à son expéditeur que le message a été <b>ouvert</b>, quand,
            et combien de fois. Tant qu'elle est bloquée, personne n'apprend que vous avez lu.
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0', fontSize: 13.5 }}>
            <input type="checkbox" checked={imgAuto} onChange={(e) => toggleImgAuto(e.target.checked)} /> Charger les images automatiquement
          </label>
          <div className="setting-desc" style={{ margin: 0 }}>
            Désactivé (recommandé), chaque message vous demande la permission et <b>nomme les sites</b> qui
            seront contactés. Le choix vaut pour ce message-là seulement — sauf pour les expéditeurs
            ci-dessous. Ce réglage ne concerne que cet appareil.
          </div>

          <div className="setting-title" style={{ marginTop: 16 }}>Expéditeurs toujours affichés</div>
          <div className="setting-desc">
            Ceux pour qui vous avez choisi <i>« Toujours afficher les images de cet expéditeur »</i> en lisant
            un message. Leurs images se chargent sans vous redemander — mais seulement depuis les sites que
            leurs messages désignent. À savoir&nbsp;: <b>l'adresse d'un expéditeur n'est pas authentifiée</b>,
            n'importe qui peut l'écrire dans un message.
          </div>
          {trusted.length === 0 ? (
            <div className="setting-desc" style={{ margin: '8px 0 0', fontStyle: 'italic' }}>Aucun pour le moment.</div>
          ) : (
            <div className="list" style={{ marginTop: 8 }}>
              {trusted.map((e) => (
                <div key={e} className="setting-row" style={{ padding: '6px 0' }}>
                  <div style={{ flex: 1, minWidth: 0, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis' }}>{e}</div>
                  <button className="btn ghost" onClick={() => setTrusted(retirerConfiance(e))}>Retirer</button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Confidentialité — Annuaire */}
        <div className="ss-section ss-confidentialite" style={{ marginTop: 20 }}>
          <div className="setting-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="building" size={16} /> Annuaire d'entreprise</div>
          <div className="setting-desc">Par défaut, les nouveaux comptes n'apparaissent pas dans l'annuaire ni dans la recherche de collègues. On peut toujours vous écrire si l'on connaît votre adresse exacte.</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0', fontSize: 13.5 }}>
            <input type="checkbox" checked={listed} onChange={(e) => toggleListed(e.target.checked)} /> Apparaître dans l'annuaire d'entreprise
          </label>
        </div>

        {/* Modèles d'e-mails */}
        <div className="ss-section ss-courrier" style={{ marginTop: 20 }}>
          <div className="setting-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="draft" size={16} /> Modèles d'e-mails</div>
          <div className="setting-desc">Textes réutilisables, insérables en un clic à la composition.</div>
          <div className="card" style={{ marginTop: 10 }}>
            {tpls.length === 0 && <div className="empty" style={{ padding: 18 }}>Aucun modèle.</div>}
            {tpls.map((t) => (
              <div key={t.id} className="alias-row">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t.name}</div>
                  <div className="setting-desc" style={{ margin: 0 }}>{t.subject || '(sans objet)'}</div>
                </div>
                <button className="icon-btn" title="Supprimer" onClick={() => delTpl(t)}><Icon name="trash" size={15} /></button>
              </div>
            ))}
          </div>
          <input className="input" style={{ marginTop: 8 }} placeholder="Nom du modèle" value={tplForm.name} onChange={(e) => setTplForm({ ...tplForm, name: e.target.value })} />
          <input className="input" style={{ marginTop: 6 }} placeholder="Objet" value={tplForm.subject} onChange={(e) => setTplForm({ ...tplForm, subject: e.target.value })} />
          <textarea className="input" style={{ marginTop: 6, resize: 'vertical', minHeight: 56 }} placeholder="Corps du message" value={tplForm.body} onChange={(e) => setTplForm({ ...tplForm, body: e.target.value })} />
          <button className="btn" style={{ marginTop: 8 }} onClick={addTpl}><Icon name="plus" size={16} /> Ajouter le modèle</button>
        </div>

        {/* Règles de courrier */}
        <div className="ss-section ss-courrier" style={{ marginTop: 20 }}>
          <div className="setting-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="flag" size={16} /> Règles de courrier</div>
          <div className="setting-desc">Tri automatique des messages entrants <b>selon l'expéditeur</b> — la seule donnée que le serveur voit (votre contenu reste chiffré de bout en bout).</div>
          <div className="card" style={{ marginTop: 10 }}>
            {rules.length === 0 && <div className="empty" style={{ padding: 16 }}>Aucune règle.</div>}
            {rules.map((rl) => (
              <div key={rl.id} className="alias-row" style={{ opacity: rl.enabled ? 1 : 0.5 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>De <span className="alias-email">{rl.matchFrom}</span></div>
                  <div className="setting-desc" style={{ margin: 0 }}>{ruleActions(rl)}</div>
                </div>
                <button className="icon-btn" onClick={() => toggleRule(rl)}>{rl.enabled ? 'Active' : 'Inactive'}</button>
                <button className="icon-btn" title="Supprimer" onClick={() => delRule(rl)}><Icon name="trash" size={15} /></button>
              </div>
            ))}
          </div>
          <form onSubmit={addRule} style={{ marginTop: 10 }}>
            <input className="input" placeholder="Expéditeur : marc@comet.mail ou @newsletter.com" value={ruleForm.matchFrom} onChange={(e) => setRuleForm({ ...ruleForm, matchFrom: e.target.value })} />
            <div className="setting-desc" style={{ margin: '8px 0', display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>Déplacer
                <select value={ruleForm.actionFolder} onChange={(e) => setRuleForm({ ...ruleForm, actionFolder: e.target.value })}>
                  <option value="">Ne pas déplacer</option>
                  <option value="archive">Archiver</option>
                  <option value="trash">Corbeille</option>
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={ruleForm.actionStar} onChange={(e) => setRuleForm({ ...ruleForm, actionStar: e.target.checked })} /> Étoiler</label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={ruleForm.actionRead} onChange={(e) => setRuleForm({ ...ruleForm, actionRead: e.target.checked })} /> Marquer lu</label>
            </div>
            <button className="btn"><Icon name="plus" size={16} /> Ajouter la règle</button>
          </form>
        </div>

        {/* Listes de diffusion */}
        <div className="ss-section ss-courrier" style={{ marginTop: 20 }}>
          <div className="setting-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="users" size={16} /> Listes de diffusion</div>
          <div className="setting-desc">Une adresse de groupe qui distribue (chiffré) à tous ses membres.</div>
          <div className="card" style={{ marginTop: 10 }}>
            {groups.length === 0 && <div className="empty" style={{ padding: 18 }}>Aucune liste.</div>}
            {groups.map((g) => (
              <div key={g.id} className="alias-row">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{g.name}</div>
                  <div className="alias-email">{g.email}</div>
                  <div className="setting-desc" style={{ margin: 0 }}>{g.members.map((m) => m.displayName).join(', ') || 'Aucun membre'}</div>
                </div>
                <button className="icon-btn" title="Copier l'adresse" onClick={() => copy(g.email)}>{copied === g.email ? <Icon name="check" size={15} /> : <Icon name="draft" size={15} />}</button>
                <button className="icon-btn" title="Supprimer" onClick={() => delGroup(g)}><Icon name="trash" size={15} /></button>
              </div>
            ))}
          </div>
          <input className="input" style={{ marginTop: 8 }} placeholder="Nom de la liste (ex. Équipe Marketing)" value={grpForm.name} onChange={(e) => setGrpForm({ ...grpForm, name: e.target.value })} />
          <input className="input" style={{ marginTop: 6 }} placeholder="Membres : lea@comet.mail, marc@comet.mail…" value={grpForm.members} onChange={(e) => setGrpForm({ ...grpForm, members: e.target.value })} />
          <button className="btn" style={{ marginTop: 8 }} onClick={addGroup}><Icon name="plus" size={16} /> Créer la liste</button>
        </div>


        {/* Alias jetables */}
        <div className="ss-section ss-courrier" style={{ marginTop: 20 }}>
          <div className="setting-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="mail" size={16} /> Alias jetables</div>
          <div className="setting-desc">Adresses générées qui pointent vers votre boîte. Donnez-les à la place de votre vraie adresse : désactivez-les pour couper le spam.</div>
          <div className="add-row" style={{ margin: '10px 0' }}>
            <input placeholder="Étiquette (ex. Newsletter, Boutique…)" value={aliasLabel} onChange={(e) => setAliasLabel(e.target.value)} />
            <button className="btn" onClick={genAlias}><Icon name="plus" size={16} /> Générer</button>
          </div>
          <div className="card">
            {aliases.length === 0 && <div className="empty" style={{ padding: 22 }}>Aucun alias pour l'instant.</div>}
            {aliases.map((a) => (
              <div key={a.id} className="alias-row" style={{ opacity: a.active ? 1 : 0.5 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="alias-email">{a.email}</div>
                  {a.label && <div className="setting-desc" style={{ margin: 0 }}>{a.label}</div>}
                </div>
                <button className="icon-btn" title="Copier" onClick={() => copy(a.email)}>{copied === a.email ? <Icon name="check" size={15} /> : <Icon name="draft" size={15} />}</button>
                <button className="icon-btn" title={a.active ? 'Désactiver' : 'Réactiver'} onClick={() => toggleAlias(a)}>{a.active ? 'Actif' : 'Inactif'}</button>
                <button className="icon-btn" title="Supprimer" onClick={() => delAlias(a)}><Icon name="trash" size={15} /></button>
              </div>
            ))}
          </div>
        </div>

        {/* Appareils connectés */}
        <div className="ss-section ss-securite" style={{ marginTop: 20 }}>
          <div className="setting-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="logout" size={16} /> Appareils connectés</div>
          <div className="setting-desc">Sessions ouvertes sur votre compte. Révoquez celles que vous ne reconnaissez pas.</div>
          <div className="card" style={{ marginTop: 10 }}>
            {sessions.length === 0 && <div className="empty" style={{ padding: 22 }}>Aucune session active.</div>}
            {sessions.map((s) => (
              <div key={s.id} className="alias-row">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{deviceLabel(s.userAgent)} {s.current && <span style={{ color: '#16a34a', fontSize: 11, fontWeight: 700 }}>· cet appareil</span>}</div>
                  <div className="setting-desc" style={{ margin: 0 }}>{s.ip || 'IP inconnue'} · vu le {fmtWhen(s.lastSeen)}</div>
                </div>
                {!s.current && <button className="icon-btn" onClick={() => revokeSession(s)}>Révoquer</button>}
              </div>
            ))}
          </div>
          {sessions.length > 1 && <button className="btn ghost" style={{ marginTop: 10 }} onClick={revokeOthers}>Déconnecter les autres appareils</button>}
        </div>

        {/* Options avancées */}
        <div className="ss-section ss-avance">
          <div className="setting-title" style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 15 }}><Icon name="sliders" size={17} /> Options avancées</div>

          {/* Extension navigateur — capture des mots de passe (tous les utilisateurs) */}
          <div style={{ marginTop: 14 }}>
            <div className="setting-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="lock" size={16} /> Extension navigateur</div>
            <div className="setting-desc">Enregistre automatiquement les mots de passe saisis dans votre navigateur, <b>chiffrés vers votre clé publique</b>, puis importés dans le coffre-fort à l'ouverture. Le serveur ne les lit jamais.</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
              <button className="btn" onClick={downloadExtension}><Icon name="logout" size={15} style={{ transform: 'rotate(90deg)' }} /> Télécharger l'extension</button>
              <button className="btn ghost" onClick={genPairCode}>Générer un code d'appairage</button>
            </div>
            {pairCode && (
              <div className="card" style={{ marginTop: 10, padding: 12 }}>
                <div className="setting-desc" style={{ margin: '0 0 6px' }}>Dans l'extension, saisissez ce code et l'adresse <code>{location.origin}</code> (valable 10 min) :</div>
                <div className="secret-box" style={{ fontSize: 18, letterSpacing: 3, textAlign: 'center' }}>{pairCode}</div>
              </div>
            )}
            <div className="setting-desc" style={{ marginTop: 8 }}>Installation : décompressez le .zip, puis dans le navigateur → Extensions → mode développeur → « Charger l'extension non empaquetée ».</div>
          </div>

          {/* Comptes mail externes (IMAP/SMTP) */}
          <div style={{ marginTop: 18 }}>
            <div className="setting-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="mail" size={16} /> Comptes mail externes</div>
            <div className="setting-desc">Connectez Gmail, Outlook ou toute boîte IMAP/SMTP pour <b>envoyer et recevoir</b> depuis Comet. Ces messages ne sont <b>pas chiffrés de bout en bout</b> ; vos identifiants sont chiffrés au repos. Le courrier Comet ↔ Comet reste E2EE.</div>

            {/* Connexion en un clic (OAuth) — sans mot de passe d'application */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
              <button type="button" className="btn ghost" disabled={!oauthReady.includes('gmail')} onClick={() => startOAuth('gmail')} title={oauthReady.includes('gmail') ? 'Autoriser via Google' : 'OAuth Google non configuré sur le serveur'}>
                <Icon name="mail" size={15} /> Connecter avec Google
              </button>
              <button type="button" className="btn ghost" disabled={!oauthReady.includes('outlook')} onClick={() => startOAuth('outlook')} title={oauthReady.includes('outlook') ? 'Autoriser via Microsoft' : 'OAuth Microsoft non configuré sur le serveur'}>
                <Icon name="mail" size={15} /> Connecter avec Microsoft
              </button>
            </div>
            <div className="hint" style={{ marginTop: 4 }}>
              {oauthReady.length ? 'Recommandé : connexion sécurisée sans mot de passe d’application.' : 'OAuth non configuré sur ce serveur — utilisez un mot de passe d’application ci-dessous.'}
            </div>

            <div className="card" style={{ marginTop: 10 }}>
              {mailAccounts.length === 0 && <div className="empty" style={{ padding: 16 }}>Aucun compte connecté.</div>}
              {mailAccounts.map((a) => (
                <div key={a.id} className="alias-row">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 6 }}>{a.label || a.email}{a.oauth && <span className="pill" style={{ padding: '1px 7px', fontSize: 11 }}>{a.provider === 'gmail' ? 'Google' : 'Microsoft'}</span>}</div>
                    <div className="setting-desc" style={{ margin: 0 }}>{a.email}{a.lastError ? ' · ⚠ ' + a.lastError.slice(0, 40) : a.lastSync ? ' · synchronisé' : ' · jamais synchronisé'}</div>
                  </div>
                  <button className="icon-btn" onClick={() => syncAccount(a)} title="Synchroniser"><Icon name="inbox" size={15} /></button>
                  <button className="icon-btn" onClick={() => delAccount(a)} title="Déconnecter"><Icon name="trash" size={15} /></button>
                </div>
              ))}
            </div>
            <form onSubmit={addAccount} style={{ marginTop: 10 }}>
              <div className="setting-desc" style={{ marginBottom: 6 }}>Fournisseur :
                {['gmail', 'outlook', 'yahoo', 'autre'].map((p) => <button type="button" key={p} className={`pill ${acctForm.provider === p ? 'active' : ''}`} style={{ marginLeft: 6, padding: '3px 10px' }} onClick={() => setProvider(p)}>{p}</button>)}
              </div>
              <input className="input" placeholder="Adresse e-mail" value={acctForm.email} onChange={(e) => setAcctForm({ ...acctForm, email: e.target.value })} />
              <input className="input" type="password" style={{ marginTop: 6 }} placeholder="Mot de passe d'application" value={acctForm.password} onChange={(e) => setAcctForm({ ...acctForm, password: e.target.value })} />
              {acctForm.provider === 'autre' && (
                <div className="row2" style={{ marginTop: 6 }}>
                  <div className="field"><label>Serveur IMAP</label><input value={acctForm.imapHost} onChange={(e) => setAcctForm({ ...acctForm, imapHost: e.target.value })} placeholder="imap.exemple.com" /></div>
                  <div className="field"><label>Serveur SMTP</label><input value={acctForm.smtpHost} onChange={(e) => setAcctForm({ ...acctForm, smtpHost: e.target.value })} placeholder="smtp.exemple.com" /></div>
                </div>
              )}
              {acctForm.provider === 'gmail' && <div className="hint" style={{ marginTop: 4 }}>Gmail exige un « mot de passe d'application » (compte avec 2FA activée).</div>}
              {acctErr && <div className="alert" style={{ marginTop: 8 }}>{acctErr}</div>}
              <button className="btn" style={{ marginTop: 8 }} disabled={acctBusy}>{acctBusy ? 'Connexion…' : 'Connecter le compte'}</button>
            </form>
          </div>


          {/* Assistant IA (via connecteur, admin) */}
          {user.isAdmin && (
            <div style={{ marginTop: 18 }}>
              <div className="setting-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="comet" size={16} /> Assistant IA</div>
              <div className="setting-desc">Active un <b>assistant IA</b> dans Comet (onglet <b>Assistant IA</b>). Il tourne <b>via le connecteur</b>, sur l'IA de votre organisation (ex. Ollama local) — <b>aucune donnée envoyée à un tiers</b>. Désactivé par défaut.</div>
              <label className="check-row" style={{ marginTop: 8 }}>
                <input type="checkbox" checked={aiEnabled} onChange={(e) => toggleAi(e.target.checked)} />
                <span>Activer l'assistant IA (le connecteur doit tourner avec <code>--ai-url</code>)</span>
              </label>
              {aiEnabled && (
                ai.ready
                  ? <div className="setting-desc" style={{ marginTop: 8 }}>✔ Moteur IA joignable via le connecteur — l'onglet <b>Assistant IA</b> est opérationnel.</div>
                  : <div className="card" style={{ marginTop: 10, padding: 12, borderLeft: '3px solid var(--danger)' }}>
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>Activé, mais sans moteur</div>
                      <div className="setting-desc" style={{ margin: 0 }}>{ai.reason}</div>
                    </div>
              )}
            </div>
          )}

          {/* Boîtes aux lettres partagées (E2EE) */}
          <div style={{ marginTop: 18 }}>
            <div className="setting-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="users" size={16} /> Boîtes aux lettres partagées</div>
            <div className="setting-desc">Une adresse d'équipe (ex. <b>support@comet.mail</b>) que <b>plusieurs membres</b> consultent et depuis laquelle ils répondent. <b>Chiffrée de bout en bout</b> : chaque membre reçoit la clé de la boîte, le serveur ne lit rien. Elle apparaît dans <b>Courrier</b>.</div>
            <div className="card" style={{ marginTop: 10 }}>
              {boxes.length === 0 && <div className="empty" style={{ padding: 16 }}>Aucune boîte partagée.</div>}
              {boxes.map((b) => (
                <div key={b.id} className="alias-row">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>{b.name} {b.role === 'owner' && <span className="pill" style={{ padding: '1px 7px', fontSize: 11 }}>propriétaire</span>}</div>
                    <div className="setting-desc" style={{ margin: 0 }}>{b.address} · {b.members} membre(s)</div>
                  </div>
                  {b.role === 'owner' && <button className="icon-btn" onClick={() => delBox(b)} title="Supprimer la boîte"><Icon name="trash" size={15} /></button>}
                </div>
              ))}
            </div>
            <form onSubmit={createBox} style={{ marginTop: 10 }}>
              <div className="row2">
                <div className="field"><label>Nom</label><input value={boxForm.name} onChange={(e) => setBoxForm({ ...boxForm, name: e.target.value })} placeholder="Support client" /></div>
                <div className="field"><label>Adresse</label><input value={boxForm.address} onChange={(e) => setBoxForm({ ...boxForm, address: e.target.value })} placeholder="support@comet.mail" /></div>
              </div>
              <div className="field" style={{ marginTop: 6 }}><label>Membres (e-mails internes)</label><input value={boxForm.members} onChange={(e) => setBoxForm({ ...boxForm, members: e.target.value })} placeholder="lea@comet.mail, marc@comet.mail" /></div>
              <div className="hint" style={{ marginTop: 4 }}>Vous êtes ajouté automatiquement comme propriétaire. Seuls des comptes Comet (avec clé) peuvent être membres.</div>
              {boxErr && <div className="alert" style={{ marginTop: 8 }}>{boxErr}</div>}
              <button className="btn" style={{ marginTop: 8 }} disabled={boxBusy}>{boxBusy ? 'Création…' : 'Créer la boîte partagée'}</button>
            </form>
          </div>

          {user.isAdmin && (
            <div style={{ marginTop: 18 }}>
              <div className="setting-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="flow" size={16} /> Connecteur d'organisation</div>
              <div className="setting-desc">Un agent à installer sur un serveur de l'organisation. Il <b>archive toutes les données</b> (sauvegarde chiffrée), <b>crée automatiquement les salons de conférence</b> prévus à l'agenda et <b>prépare le stockage partagé</b>. Optionnel — l'application fonctionne sans.</div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                <button className="btn" onClick={downloadConnector}><Icon name="logout" size={15} style={{ transform: 'rotate(90deg)' }} /> Télécharger le connecteur</button>
                {!conn?.hasKey
                  ? <button className="btn ghost" onClick={genConnKey}>Générer une clé de connexion</button>
                  : <button className="btn ghost" onClick={revokeConnKey}>Révoquer la clé</button>}
              </div>

              {connKey && (
                <div className="card" style={{ marginTop: 10, padding: 12 }}>
                  <div className="setting-desc" style={{ margin: '0 0 6px' }}><b>Clé générée — copiez-la maintenant</b> (elle ne sera plus affichée) :</div>
                  <div className="secret-box" style={{ fontSize: 13, wordBreak: 'break-all' }}>{connKey}</div>
                  <div className="setting-desc" style={{ marginTop: 8, marginBottom: 0 }}>Lancez ensuite :<br /><code>node comet-connector.mjs --server {location.origin} --key {connKey.slice(0, 12)}…</code></div>
                </div>
              )}
              {conn?.hasKey && !connKey && (
                <div className="setting-desc" style={{ marginTop: 8 }}>Clé active. Dernière activité du connecteur : <b>{conn.lastSeen ? fmtWhen(conn.lastSeen) : 'jamais connecté'}</b>.</div>
              )}

              <div style={{ marginTop: 14 }}>
                <div className="setting-title" style={{ fontSize: 13.5 }}>Espace de stockage partagé</div>
                <div className="setting-desc">Dossier que le connecteur prépare et maintient pour l'organisation.</div>
                <div className="add-row" style={{ margin: '8px 0' }}>
                  <input placeholder="Chemin (ex. /srv/comet/partage)" value={storagePath} onChange={(e) => setStoragePath(e.target.value)} />
                  <button className="btn" onClick={() => saveStorage(true)}>Enregistrer</button>
                </div>
                <label className="check-row">
                  <input type="checkbox" checked={!!conn?.storage?.enabled} onChange={(e) => saveStorage(e.target.checked)} />
                  <span>Activer le stockage partagé</span>
                </label>
              </div>
            </div>
          )}
        </div>

        {error && <div className="alert" style={{ marginTop: 14 }}>{error}</div>}
        </div>{/* .settings-body */}
      </div>{/* .settings-modal */}
    </div>
  );
}
