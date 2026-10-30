import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { randomChannelKey, wrapKeyFor, unwrapKey, encryptWithKeyB64, decryptWithKeyB64, normalizeEmail } from '../crypto.js';
import { Avatar } from '../components/shell-meta.jsx';
import Icon from '../components/Icon.jsx';
import { runAgent, createPlanPipeline, runLowActions, highActions } from '../agent.js';

const fmtTime = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const AGENT_TAG = '§IA§'; // marqueur des messages de l'assistant (dans le corps chiffre)

export default function Chat({ chatPing, openCompose, openChannelId, onChannelOpened }) {
  const { user, privateKey } = useAuth();
  const [channels, setChannels] = useState([]);
  const [active, setActive] = useState(null);
  const [keyB64, setKeyB64] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', members: '' });
  // « activé » ne suffit pas : sans moteur joignable, on n'annonce pas @ia.
  const [ai, setAi] = useState({ enabled: false, ready: false, reason: null });
  const aiEnabled = !!ai.ready;
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentCtx, setAgentCtx] = useState(() => { try { return Number(localStorage.getItem('comet.agentContext')) || 50; } catch { return 50; } });
  const pendingRef = useRef({}); // channelId -> [actions à hautes permissions en attente]
  const scrollRef = useRef(null);

  const [generalPending, setGeneralPending] = useState(false);

  const loadChannels = () => api.get('/chat/channels').then((r) => setChannels(r.channels)).catch(() => {});
  useEffect(() => { loadChannels(); }, []);

  // ── Canal « Général » de l'organisation ─────────────────────────────────────
  // C'est ICI qu'il naît, et nulle part ailleurs : la clé AES du canal est générée
  // dans le navigateur puis enveloppée (RSA) pour chaque membre de l'équipe. Le
  // serveur ne pourrait pas le créer lui-même sans détenir la clé en clair — ce qui
  // casserait le chiffrement de bout en bout. Au premier accès d'un membre :
  //  • « Général » n'existe pas encore → je le crée et je distribue la clé ;
  //  • il existe et j'ai la clé → je l'enveloppe pour les collègues arrivés depuis ;
  //  • il existe et je n'ai pas la clé → j'attends qu'un collègue me la passe.
  // Idempotent de bout en bout : le serveur n'accepte qu'un « Général » par org, et
  // une clé déjà distribuée n'est jamais remplacée.
  async function ensureGeneral() {
    if (!user?.orgId || !privateKey) return;
    try {
      const r = await api.get('/chat/general');
      if (!r.channel) {
        const me = normalizeEmail(user.email);
        if (!(r.members || []).some((m) => normalizeEmail(m.email) === me)) return; // sans MA clé publique, je ne pourrais pas me relire
        const channelKey = randomChannelKey();
        const members = {};
        for (const m of r.members) members[normalizeEmail(m.email)] = await wrapKeyFor(channelKey, m.publicKey);
        await api.post('/chat/general', { members });
        setGeneralPending(false);
        await loadChannels();
        return;
      }
      if (!r.channel.encKey) { setGeneralPending(true); return; } // un collègue me passera la clé
      setGeneralPending(false);
      if ((r.missing || []).length) {
        const channelKey = await unwrapKey(r.channel.encKey, privateKey);
        const members = {};
        for (const m of r.missing) members[normalizeEmail(m.email)] = await wrapKeyFor(channelKey, m.publicKey);
        if (Object.keys(members).length) { await api.post(`/chat/channels/${r.channel.id}/members`, { members }); await loadChannels(); }
      }
    } catch { /* silencieux : le reste du chat fonctionne sans « Général » */ }
  }
  useEffect(() => { ensureGeneral(); /* eslint-disable-next-line */ }, [user?.orgId, privateKey]);
  useEffect(() => { api.get('/assistant/status').then(setAi).catch(() => {}); }, []);
  function changeCtx(v) { const n = Math.max(5, Math.min(200, Number(v) || 50)); setAgentCtx(n); try { localStorage.setItem('comet.agentContext', String(n)); } catch {} }

  async function loadMessages(id, k) {
    const { messages: rows } = await api.get(`/chat/channels/${id}/messages`);
    const out = [];
    for (const m of rows) { try { const d = await decryptWithKeyB64(m.ciphertext, m.iv, k); out.push({ ...m, text: d.text }); } catch { out.push({ ...m, text: '🔒' }); } }
    setMessages(out);
  }
  async function openChannel(c) {
    setActive(c); setMessages([]); setKeyB64(null);
    try {
      const det = await api.get(`/chat/channels/${c.id}`);
      const k = await unwrapKey(det.channel.encKey, privateKey);
      setKeyB64(k);
      await loadMessages(c.id, k);
    } catch {}
  }

  useEffect(() => {
    if (!chatPing) return;
    loadChannels();
    if (active && keyB64 && chatPing.channelId === active.id) loadMessages(active.id, keyB64);
    // eslint-disable-next-line
  }, [chatPing]);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [messages]);

  // Ouverture d'un canal demandée depuis l'extérieur (ex. « Message » d'un contact → DM).
  useEffect(() => {
    if (!openChannelId) return;
    (async () => {
      let chan = channels.find((c) => c.id === openChannelId);
      if (!chan) { try { const r = await api.get('/chat/channels'); setChannels(r.channels); chan = r.channels.find((c) => c.id === openChannelId); } catch {} }
      if (chan) await openChannel(chan);
      onChannelOpened && onChannelOpened();
    })();
    // eslint-disable-next-line
  }, [openChannelId]);

  async function send(e) {
    e.preventDefault();
    const raw = text.trim();
    if (!raw || !keyB64) return;
    const enc = await encryptWithKeyB64({ text: raw }, keyB64);
    setText('');
    await api.post(`/chat/channels/${active.id}/messages`, enc);
    await loadMessages(active.id, keyB64);
    if (aiEnabled && /(^|\s)@ia\b/i.test(raw)) handleAgent(raw);
  }

  // Poste un message « Assistant IA » dans le canal (chiffré avec la clé du canal).
  async function postBot(body, k, channelId) {
    if (!k || !channelId || !body) return;
    const enc = await encryptWithKeyB64({ text: AGENT_TAG + body }, k);
    await api.post(`/chat/channels/${channelId}/messages`, enc);
  }

  async function handleAgent(raw) {
    const request = raw.replace(/(^|\s)@ia\b/i, ' ').trim();
    const chanId = active.id; const k = keyB64;
    // Confirmation d'actions sensibles en attente
    if (/^(oui|ok|confirme|confirmer|vas[- ]?y|d'accord)\b/i.test(request) && (pendingRef.current[chanId] || []).length) {
      return confirmHigh(chanId, k);
    }
    setAgentBusy(true);
    try {
      const transcript = messages.filter((m) => !m.text?.startsWith(AGENT_TAG)).map((m) => ({ who: m.from?.displayName || 'Membre', text: m.text }));
      const res = await runAgent({ request, transcript, contextSize: agentCtx });
      const lines = [];
      if (res.reply) lines.push(res.reply);
      if (res.pipeline) {
        try { const p = await createPlanPipeline(res.pipeline); lines.push(`Plan suivi dans le pipeline « ${p.name} » (${res.pipeline.steps.length} étape(s)).`); }
        catch { lines.push(`Plan proposé : ${res.pipeline.steps.map((s, i) => `${i + 1}. ${s}`).join('  ')}`); }
      }
      const lowDone = await runLowActions(res.actions);
      if (lowDone.length) lines.push(`Créé : ${lowDone.join(', ')}.`);
      const highs = highActions(res.actions);
      if (highs.length) {
        pendingRef.current[chanId] = highs;
        lines.push(`Actions à valider (hautes permissions) : ${highs.map((h) => h.type === 'email' ? `e-mail à ${h.to}` : h.type).join(', ')}. Répondez « @ia oui » pour confirmer.`);
      } else { delete pendingRef.current[chanId]; }
      await postBot(lines.join('\n') || 'Je n\'ai rien à proposer.', k, chanId);
    } catch (err) {
      await postBot(`Je n'ai pas pu traiter la demande : ${err.message}`, k, chanId);
    } finally {
      setAgentBusy(false);
      if (active?.id === chanId && keyB64) await loadMessages(chanId, keyB64);
    }
  }

  // Exécute les actions à hautes permissions après confirmation (e-mail = brouillon revu par l'humain).
  async function confirmHigh(chanId, k) {
    const acts = pendingRef.current[chanId] || []; delete pendingRef.current[chanId];
    const lines = [];
    for (const a of acts) {
      if (a.type === 'email' && openCompose) { openCompose({ to: a.to ? [a.to] : [], subject: a.subject || '', body: a.body || '' }); lines.push(`Brouillon d'e-mail ouvert pour ${a.to || 'le destinataire'} — à vous de l'envoyer.`); }
      else lines.push(`Action « ${a.type} » : non prise en charge automatiquement.`);
    }
    await postBot(lines.join('\n') || 'Rien à confirmer.', k, chanId);
    if (active?.id === chanId && keyB64) await loadMessages(chanId, keyB64);
  }

  async function createChannel(e) {
    e.preventDefault();
    if (!form.name.trim()) return;
    const emails = [...new Set([normalizeEmail(user.email), ...form.members.split(/[,;\s]+/).map(normalizeEmail).filter(Boolean)])];
    const { keys } = await api.get(`/users/keys?emails=${encodeURIComponent(emails.join(','))}`);
    const channelKey = randomChannelKey();
    const members = {};
    for (const em of emails) if (keys[em]) members[em] = await wrapKeyFor(channelKey, keys[em]);
    if (Object.keys(members).length === 0) return;
    const r = await api.post('/chat/channels', { name: form.name, description: '', members });
    setCreating(false); setForm({ name: '', members: '' });
    await loadChannels(); openChannel(r.channel);
  }

  return (
    <div className="chat">
      <aside className="chat-channels">
        <button className="btn block" onClick={() => setCreating(true)} style={{ marginBottom: 16 }}><Icon name="plus" size={16} /> Nouveau canal</button>
        <div className="folders-label">Canaux</div>
        {channels.length === 0 && <div className="empty" style={{ padding: 18 }}>Aucun canal.</div>}
        {channels.map((c) => (
          <button key={c.id} className={`folder ${active?.id === c.id ? 'active' : ''}`} onClick={() => openChannel(c)}>
            <Icon name={c.kind === 'general' ? 'users' : 'chat'} size={16} /><span className="lbl">{c.name}</span><span className="count">{c.members}</span>
          </button>
        ))}
        {generalPending && (
          <div className="setting-desc" style={{ padding: '10px 12px' }}>
            « Général » existe dans votre équipe : un collègue déjà connecté vous transmettra sa clé (chiffrée pour vous) à sa prochaine ouverture du chat.
          </div>
        )}
      </aside>

      <section className="chat-main">
        {!active ? (
          <div className="reader-empty"><div><div className="big"><Icon name="chat" size={26} /></div>Choisissez un canal ou créez-en un.</div></div>
        ) : (
          <>
            <div className="chat-head"><Icon name="chat" size={17} /> <b>{active.name}</b><span className="meta" style={{ marginLeft: 8 }}>{active.members} membre(s) · chiffré</span>
              {aiEnabled && (
                <span className="meta agent-ctx" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}
                  title={"Mentionner @ia envoie les derniers messages du canal, DÉCHIFFRÉS, à l'IA de votre organisation via le serveur — qui les conserve en clair le temps du traitement. La clé du canal, elle, ne quitte jamais ce navigateur."}>
                  <Icon name="comet" size={13} /> @ia · contexte
                  <input type="number" min="5" max="200" value={agentCtx} onChange={(e) => changeCtx(e.target.value)} /> msg
                </span>
              )}
              {ai.enabled && !ai.ready && (
                <span className="meta" style={{ marginLeft: 'auto', color: 'var(--danger)' }} title={ai.reason}>@ia sans moteur IA</span>
              )}
            </div>
            <div className="chat-msgs" ref={scrollRef}>
              {messages.map((m) => {
                const isBot = m.text?.startsWith(AGENT_TAG);
                const body = isBot ? m.text.slice(AGENT_TAG.length) : m.text;
                const mine = !isBot && m.from?.id === user.id;
                return (
                  <div key={m.id} className={`chat-msg ${mine ? 'mine' : ''} ${isBot ? 'bot' : ''}`}>
                    {isBot ? <div className="bot-ava"><Icon name="comet" filled size={16} /></div> : (!mine && <Avatar name={m.from?.displayName} color={m.from?.avatarColor} size={30} />)}
                    <div className="bubble">
                      <div className="who">{isBot ? <span>Assistant IA</span> : (!mine && <span>{m.from?.displayName}</span>)}<span className="t">{fmtTime(m.createdAt)}</span></div>
                      <div className="txt">{body}</div>
                    </div>
                  </div>
                );
              })}
              {agentBusy && (
                <div className="chat-msg bot">
                  <div className="bot-ava"><Icon name="comet" filled size={16} /></div>
                  <div className="bubble"><div className="txt" style={{ opacity: .65 }}>Assistant IA réfléchit…</div></div>
                </div>
              )}
            </div>
            <form className="chat-composer" onSubmit={send}>
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder={aiEnabled ? "Écrire un message… (mentionnez @ia pour l'assistant)" : 'Écrire un message…'} autoFocus />
              <button className="btn"><Icon name="send" size={16} /></button>
            </form>
          </>
        )}
      </section>

      {creating && (
        <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) setCreating(false); }}>
          <form className="modal" onSubmit={createChannel}>
            <h3>Nouveau canal</h3>
            <div className="field"><label>Nom du canal *</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="ex. Marketing" autoFocus /></div>
            <div className="field"><label>Membres (e-mails)</label><input value={form.members} onChange={(e) => setForm({ ...form, members: e.target.value })} placeholder="lea@comet.mail, marc@comet.mail" /></div>
            <div className="setting-desc">Vous êtes ajouté automatiquement. La clé du canal est chiffrée pour chaque membre.</div>
            <div className="modal-foot">
              <button type="button" className="btn ghost" onClick={() => setCreating(false)}>Annuler</button>
              <button className="btn">Créer</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
