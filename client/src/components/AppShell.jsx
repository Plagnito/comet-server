import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { api, getToken } from '../api.js';
import { connectRealtime } from '../realtime.js';
import { initP2P, onSignal } from '../p2p.js';
import { hasPIN } from '../lock.js';
import { sendMail, flushOutbox, outboxSize, onOutboxChange } from '../outbox.js';
import Icon from './Icon.jsx';
import Compose from './Compose.jsx';
import Settings from './Settings.jsx';
import CommandPalette from './CommandPalette.jsx';
import UndoToast from './UndoToast.jsx';
import ShortcutsHelp, { SHORTCUTS } from './ShortcutsHelp.jsx';
import Mail from '../modules/Mail.jsx';
import Calendar from '../modules/Calendar.jsx';
import Chat from '../modules/Chat.jsx';
import Conference from '../modules/Conference.jsx';
import Contacts from '../modules/Contacts.jsx';
import Tasks from '../modules/Tasks.jsx';
import Board from '../modules/Board.jsx';
import Pipelines from '../modules/Pipelines.jsx';
import Notes from '../modules/Notes.jsx';
import Vault from '../modules/Vault.jsx';
import Assistant from '../modules/Assistant.jsx';
import Admin from '../modules/Admin.jsx';
import { MODULES, MODULE_GROUPS, GESTION_GROUPS, PRESENCE, Avatar } from './shell-meta.jsx';

// Réexport pour compatibilité : d'anciens imports pointent encore vers AppShell.
export { MODULES, PRESENCE, Avatar, initials } from './shell-meta.jsx';

export default function AppShell() {
  const { user, logout, refreshUser } = useAuth();
  async function setPresence(p) { await api.patch('/auth/profile', { presence: p }); await refreshUser(); }
  const [module, setModule] = useState('mail');
  const [mode, setMode] = useState('normal'); // le mode Gestion suppose une organisation
  const [query, setQuery] = useState('');

  function switchMode(next) {
    if (next === mode) return;
    setMode(next); try { localStorage.setItem('comet.mode', next); } catch {}
    setModule(next === 'gestion' ? 'dashboard' : 'mail'); setQuery('');
  }
  const [counts, setCounts] = useState({});
  const [reloadKey, setReloadKey] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [compose, setCompose] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [onlineIds, setOnlineIds] = useState(() => new Set());
  const [chatPing, setChatPing] = useState(null);
  const [disabledModules, setDisabledModules] = useState(() => new Set());
  // Rail déployé par défaut (sauf si l'utilisateur l'a déjà réduit).
  const [railOpen, setRailOpen] = useState(() => { try { const v = localStorage.getItem('comet.rail'); return v === null ? true : v === 'open'; } catch { return true; } });
  // Rail plus léger au 1er lancement : les groupes secondaires (Outils, Administration)
  // démarrent repliés — rien n'est caché (un clic les déplie), et les utilisateurs qui
  // ont déjà une préférence enregistrée ne sont pas touchés (on ne force que si absent).
  const [collapsedCats, setCollapsedCats] = useState(() => { try { const v = localStorage.getItem('comet.railCats'); return v === null ? new Set(['tools', 'admin']) : new Set(JSON.parse(v)); } catch { return new Set(['tools', 'admin']); } });
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [notifOn, setNotifOn] = useState(() => { try { return localStorage.getItem('comet.notif') === 'on'; } catch { return false; } });
  const [pendingSend, setPendingSend] = useState(null); // { payload, undoData }
  const [openChannelId, setOpenChannelId] = useState(null); // DM/canal à ouvrir dans Équipe
  const openChannel = (cid) => { setOpenChannelId(cid); setModule('chat'); };
  const [outboxCount, setOutboxCount] = useState(() => outboxSize());

  // File d'attente d'envoi : réessai toutes les minutes + au retour en ligne.
  useEffect(() => {
    const off = onOutboxChange(setOutboxCount);
    const retry = () => flushOutbox().then(setOutboxCount).catch(() => {});
    retry();
    const t = setInterval(retry, 60_000);
    window.addEventListener('online', retry);
    return () => { off(); clearInterval(t); window.removeEventListener('online', retry); };
  }, []);
  const notifRef = useRef(notifOn);
  const pendingRef = useRef(null);
  const rtRef = useRef(null);
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute('data-theme') || 'light');

  function toggleRail() {
    setRailOpen((v) => { const next = !v; try { localStorage.setItem('comet.rail', next ? 'open' : 'closed'); } catch {} return next; });
  }
  function toggleCat(id) {
    setCollapsedCats((prev) => {
      const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id);
      try { localStorage.setItem('comet.railCats', JSON.stringify([...n])); } catch {}
      return n;
    });
  }

  // Notifications bureau (Web Notifications) — activées sur geste utilisateur.
  useEffect(() => { notifRef.current = notifOn; }, [notifOn]);
  // Abonnement WEB PUSH : c'est lui qui fait arriver la notification même quand
  // Comet est FERMÉ (le service worker est réveillé par le navigateur). Sans lui,
  // l'interrupteur ne servirait que pour un onglet ouvert en arrière-plan.
  // Best-effort de bout en bout : un serveur sans clés VAPID, un navigateur sans
  // PushManager ou un refus de l'abonnement ne doivent PAS casser l'interrupteur —
  // les notifications in-app continuent alors de fonctionner.
  async function subscribePush() {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
      const cfg = await api.get('/push/config').catch(() => null);
      if (!cfg || !cfg.configured || !cfg.publicKey) return;   // serveur sans clés : on n'insiste pas
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      const sub = existing || await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(cfg.publicKey),
      });
      await api.post('/push/subscribe', { subscription: sub.toJSON ? sub.toJSON() : sub });
    } catch { /* le push est un bonus : son échec ne casse rien */ }
  }
  async function unsubscribePush() {
    try {
      if (!('serviceWorker' in navigator)) return;
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return;
      await api.post('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    } catch { /* rien à défaire */ }
  }
  // La clé VAPID voyage en base64url ; PushManager attend des octets.
  function urlBase64ToUint8Array(base64) {
    const pad = '='.repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function toggleNotif() {
    if (notifOn) {
      setNotifOn(false);
      try { localStorage.setItem('comet.notif', 'off'); } catch {}
      unsubscribePush();               // couper l'interrupteur coupe AUSSI le push
      return;
    }
    if (!('Notification' in window)) return;
    let perm = Notification.permission;
    if (perm !== 'granted') { try { perm = await Notification.requestPermission(); } catch {} }
    if (perm === 'granted') {
      setNotifOn(true);
      try { localStorage.setItem('comet.notif', 'on'); } catch {}
      subscribePush();                 // …et l'allumer l'active pour l'app fermée
    }
  }
  // Au démarrage, si l'utilisateur avait déjà accepté, on RÉ-AFFIRME l'abonnement :
  // un navigateur peut faire tourner ses clés, et un abonnement périmé est muet.
  useEffect(() => {
    if (notifOn && typeof Notification !== 'undefined' && Notification.permission === 'granted') subscribePush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Annuler l'envoi : on diffère réellement le POST de quelques secondes.
  function flushPending() {
    const p = pendingRef.current;
    if (!p) return;
    pendingRef.current = null; setPendingSend(null);
    sendMail(p.payload).then(() => { setReloadKey((k) => k + 1); loadCounts(); }).catch(() => {});
  }
  function deferSend(payload, undoData) {
    flushPending(); // un envoi différé en cours part immédiatement
    setCompose(null);
    pendingRef.current = { payload, undoData };
    setPendingSend({ payload, undoData });
  }
  function undoSend() {
    const p = pendingRef.current;
    pendingRef.current = null; setPendingSend(null);
    if (p) setCompose(p.undoData); // rétablit le brouillon
  }
  function maybeNotify(kind) {
    if (!notifRef.current) return;
    // `document.hidden` seul ne suffit pas : l'onglet peut être ACTIF alors que la
    // fenêtre du navigateur est derrière une autre application — l'utilisateur ne
    // voit alors rien arriver. On notifie dès que Comet n'a pas le focus.
    const away = document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus());
    if (!away) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const body = kind === 'ext' ? 'Un message est arrivé dans une boîte externe.' : 'Vous avez reçu un courrier chiffré.';
      const n = new Notification('Comet — nouveau message', { body, icon: '/icon-192.png', tag: 'comet-mail' });
      n.onclick = () => { window.focus(); n.close(); };
    } catch {}
  }

  const loadCounts = useCallback(() => {
    api.get('/mail/counts').then((r) => setCounts(r.counts)).catch(() => {});
  }, []);
  useEffect(() => { loadCounts(); }, [loadCounts]);

  // Applications désactivées par l'admin (org-wide) → masquées du rail.
  const loadAppConfig = useCallback(() => {
    api.get('/app-config').then((r) => setDisabledModules(new Set(r.disabledModules || []))).catch(() => {});
  }, []);
  useEffect(() => { loadAppConfig(); }, [loadAppConfig]);
  // Si le module courant vient d'être désactivé, on revient au Courrier.
  useEffect(() => { if (module !== 'mail' && disabledModules.has(module)) setModule('mail'); }, [disabledModules, module]);

  // Palette de commandes : Ctrl/Cmd+K
  useEffect(() => {
    const h = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); setPaletteOpen(true); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // Raccourcis clavier : c (composer), / (recherche), ? (aide), g+lettre (navigation).
  useEffect(() => {
    let gPending = false, gTimer = null;
    const isField = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    const go = (key) => { if (key === 'mail' || !disabledModules.has(key)) { setModule(key); setQuery(''); } };
    const h = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isField(e.target) || document.querySelector('.overlay')) return; // saisie ou modal ouvert
      const k = e.key;
      if (gPending) {
        gPending = false; clearTimeout(gTimer);
        const map = { m: 'mail', e: 'chat', v: 'conf', a: 'calendar', t: 'tasks', b: 'board', p: 'pipelines', n: 'notes', c: 'contacts' };
        if (map[k]) { e.preventDefault(); go(map[k]); }
        return;
      }
      if (k === 'g') { gPending = true; gTimer = setTimeout(() => { gPending = false; }, 900); return; }
      if (k === 'c') { e.preventDefault(); setCompose({}); return; }
      if (k === '/') { e.preventDefault(); const el = document.querySelector('.search input'); el ? el.focus() : setPaletteOpen(true); return; }
      if (k === '?') { e.preventDefault(); setShortcutsOpen(true); return; }
    };
    window.addEventListener('keydown', h);
    return () => { window.removeEventListener('keydown', h); clearTimeout(gTimer); };
  }, [disabledModules]);

  function navigate(moduleKey, q = '') { setModule(moduleKey); setQuery(q); setPaletteOpen(false); }

  // Temps réel : mail en direct + présence + canal P2P
  useEffect(() => {
    const token = getToken();
    if (!token) return;
    const rt = connectRealtime(token, {
      'mail:new': () => { loadCounts(); setReloadKey((k) => k + 1); maybeNotify(); },
      'presence:init': (m) => setOnlineIds(new Set(m.online)),
      'presence': (m) => setOnlineIds((prev) => { const n = new Set(prev); if (m.online) n.add(m.userId); else n.delete(m.userId); return n; }),
      'rtc:signal': (m) => onSignal(m.from, m.data),
      'chat:new': (m) => setChatPing({ tick: Date.now(), channelId: m.channelId }),
      // Un mail EXTERNE (passerelle IMAP) est un mail comme un autre : il notifiait
      // l'interface sans jamais prévenir l'utilisateur. Corrigé.
      'mail:ext': () => { setReloadKey((k) => k + 1); maybeNotify('ext'); },
      // Résultat d'un envoi externe mis en file (outbox SMTP). Succès → rafraîchit
      // « Envoyés » ; échec (après plusieurs tentatives) → prévient l'utilisateur,
      // car l'envoi n'est plus synchrone à la requête de composition.
      'mail:sent': (m) => {
        setReloadKey((k) => k + 1);
        if (m && m.ok === false) {
          const body = "Un e-mail externe n'a pas pu être envoyé : " + (m.error || 'erreur SMTP') + '. Plusieurs tentatives ont échoué.';
          if ('Notification' in window && Notification.permission === 'granted') {
            try { new Notification('Comet — envoi échoué', { body, icon: '/icon-192.png', tag: 'comet-send-fail' }); } catch {}
          } else { try { window.alert(body); } catch {} }
        }
      },
    });
    rtRef.current = rt;
    initP2P((to, data) => rt.send({ type: 'rtc:signal', to, data }));
    return () => rt.close();
  }, [loadCounts]);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('comet.theme', next); } catch {}
  }

  const openCompose = (init = {}) => setCompose(init);
  const onSent = () => { setCompose(null); setReloadKey((k) => k + 1); loadCounts(); };

  const inboxUnread = counts.inbox?.unread || 0;
  const current = MODULES.find((m) => m.key === module);
  const showSearch = ['mail', 'contacts', 'directory', 'vault', 'notes'].includes(module);
  const moduleProps = { query, reloadKey, counts, openCompose, onChanged: loadCounts, onlineIds, chatPing, onOpenChannel: openChannel, onNavigate: navigate };

  return (
    <div className="app">
      <nav className={`rail ${railOpen ? 'open' : ''}`}>
        <div className="rail-top">
          <div className="rail-logo"><Icon name="comet" filled size={20} /></div>
          {railOpen && <span className="rail-title">Comet</span>}
          <button className="rail-toggle" title={railOpen ? 'Réduire le menu' : 'Déployer le menu'} aria-label={railOpen ? 'Réduire le menu' : 'Déployer le menu'} onClick={toggleRail}>
            <Icon name={railOpen ? 'chevronLeft' : 'chevronRight'} size={18} />
          </button>
        </div>

        <div className="rail-nav">
          {(mode === 'gestion' ? GESTION_GROUPS : MODULE_GROUPS).map((g, gi) => {
            const items = g.keys
              .map((k) => MODULES.find((m) => m.key === k))
              .filter(Boolean)
              .filter((m) => !m.adminOnly || user.isAdmin)
              .filter((m) => m.key === 'mail' || !disabledModules.has(m.key));
            if (!items.length) return null;
            const catCollapsed = railOpen && collapsedCats.has(g.id);
            return (
              <div className={`rail-group ${catCollapsed ? 'cat-collapsed' : ''}`} key={g.id}>
                {railOpen ? (
                  <button className="rail-cat" onClick={() => toggleCat(g.id)} aria-expanded={!catCollapsed} title={catCollapsed ? 'Déplier' : 'Replier'}>
                    <span>{g.label}</span>
                    <span className="rail-cat-chev"><Icon name="chevronRight" size={12} /></span>
                  </button>
                ) : (gi > 0 && <div className="rail-sep" />)}
                {!catCollapsed && items.map((m) => (
                  <button
                    key={m.key}
                    className={`rail-btn ${module === m.key ? 'active' : ''}`}
                    onClick={() => { setModule(m.key); setQuery(''); }}
                  >
                    <span className="rail-ico">
                      <Icon name={m.icon} size={21} />
                      {m.key === 'mail' && inboxUnread > 0 && <span className="pip">{inboxUnread > 99 ? '99+' : inboxUnread}</span>}
                    </span>
                    {railOpen ? <span className="rail-label">{m.label}</span> : <span className="rail-tip">{m.label}</span>}
                    {railOpen && m.adminOnly && <span className="tag" style={{ marginLeft: 'auto' }}>admin</span>}
                  </button>
                ))}
              </div>
            );
          })}
        </div>

        <div className="rail-spacer" />
        <button className="rail-avatar" title={user.displayName} onClick={() => setMenuOpen((v) => !v)}>
          <Avatar name={user.displayName} color={user.avatarColor} size={38} />
          {railOpen && (
            <span className="rail-me">
              <span className="rail-me-name">{user.displayName}</span>
              <span className="rail-me-mail">{user.email}</span>
            </span>
          )}
        </button>
      </nav>

      <div className="workspace">
        <header className="topbar">
          <div className="title">{current.label}</div>
          <button className="palette-launch" onClick={() => setPaletteOpen(true)} title="Recherche & commandes (Ctrl+K)">
            <Icon name="search" size={15} /> Rechercher <kbd>Ctrl K</kbd>
          </button>
          {showSearch && (
            <div className="search">
              <span className="ico"><Icon name="search" size={16} /></span>
              <input
                placeholder={module === 'mail' ? 'Rechercher dans le courrier…' : module === 'notes' ? 'Rechercher dans les notes…' : 'Rechercher un contact…'}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          )}
          <div className="topbar-spacer" />
          <div className="topbar-spacer" />
          <div className="usermenu">
            <button className="who compact" onClick={() => setMenuOpen((v) => !v)}>
              <Avatar name={user.displayName} color={user.avatarColor} size={28} presence={user.presence} />
              <div style={{ textAlign: 'left', minWidth: 0 }}>
                <div className="name">{user.displayName}</div>
                <div className="mail">{user.email}</div>
              </div>
            </button>
            {menuOpen && (
              <div className="dropdown" onMouseLeave={() => setMenuOpen(false)}>
                <div className="presence-row">
                  {Object.entries(PRESENCE).map(([key, p]) => (
                    <button key={key} className={`presence-opt ${user.presence === key ? 'active' : ''}`} onClick={() => setPresence(key)} title={p.label}>
                      <span className="presence-dot-inline" style={{ background: p.color }} />{p.label}
                    </button>
                  ))}
                </div>
                <div className="sep" />
                <button onClick={toggleTheme}>
                  <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
                  {theme === 'dark' ? 'Mode clair' : 'Mode sombre'}
                </button>
                <button onClick={() => { setSettingsOpen(true); setMenuOpen(false); }}>
                  <Icon name="sliders" size={17} /> Paramètres {user.twoFactorEnabled && <span style={{ marginLeft: 'auto', fontSize: 11, color: '#16a34a', fontWeight: 700 }}>2FA</span>}
                </button>
                <button onClick={toggleNotif}>
                  <Icon name="bell" size={17} /> Notifications bureau
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: notifOn ? '#16a34a' : 'var(--muted)', fontWeight: 700 }}>{notifOn ? 'ON' : 'OFF'}</span>
                </button>
                <button onClick={() => { setShortcutsOpen(true); setMenuOpen(false); }}>
                  <Icon name="board" size={17} /> Raccourcis clavier <kbd style={{ marginLeft: 'auto' }}>?</kbd>
                </button>
                {hasPIN() && <button onClick={() => { setMenuOpen(false); window.dispatchEvent(new Event('comet:lock')); }}><Icon name="lock" size={17} /> Verrouiller</button>}
                <div className="sep" />
                <button onClick={logout}><Icon name="logout" size={17} /> Se déconnecter</button>
              </div>
            )}
          </div>
        </header>

        <main className="module">
          {module === 'mail' && <Mail {...moduleProps} />}
          {module === 'chat' && <Chat {...moduleProps} openChannelId={openChannelId} onChannelOpened={() => setOpenChannelId(null)} />}
          {module === 'conf' && <Conference {...moduleProps} />}
          {module === 'calendar' && <Calendar {...moduleProps} />}
          {module === 'contacts' && <Contacts {...moduleProps} />}
          {module === 'tasks' && <Tasks {...moduleProps} />}
          {module === 'board' && <Board {...moduleProps} />}
          {module === 'pipelines' && <Pipelines {...moduleProps} />}
          {module === 'notes' && <Notes {...moduleProps} />}
          {module === 'assistant' && <Assistant {...moduleProps} />}
          {module === 'vault' && <Vault {...moduleProps} />}
          {module === 'admin' && user.isAdmin && <Admin {...moduleProps} />}
        </main>
      </div>

      {compose && <Compose init={compose} onClose={() => setCompose(null)} onSent={onSent} onDeferredSend={deferSend} />}
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} onAccountsChanged={() => setReloadKey((k) => k + 1)} />}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} onNavigate={navigate} onCompose={(init) => { setPaletteOpen(false); openCompose(init); }} />}
      {shortcutsOpen && <ShortcutsHelp onClose={() => setShortcutsOpen(false)} />}
      {pendingSend && <UndoToast key={pendingSend.payload.iv} seconds={6} onUndo={undoSend} onDone={flushPending} />}
      {outboxCount > 0 && (
        <button className="outbox-pill" title="Réessayer l'envoi maintenant" onClick={() => flushOutbox().then(setOutboxCount)}>
          <Icon name="clock" size={14} /> {outboxCount} message{outboxCount > 1 ? 's' : ''} en file d'attente
        </button>
      )}
    </div>
  );
}
