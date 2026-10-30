import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Icon from '../components/Icon.jsx';

const inFlight = (j) => j.status === 'pending' || j.status === 'claimed';

// Assistant IA — file de travaux traitée par le connecteur (IA chez l'organisation).
// Désactivé tant qu'un admin ne l'a pas activé dans Réglages.
// Comet n'embarque aucun moteur : si le connecteur est absent ou sans fournisseur
// IA, on le DIT ici (bandeau + composeur verrouillé) plutôt que de faire patienter.
export default function Assistant() {
  const [status, setStatus] = useState(null); // { enabled, ready, state, reason }
  const [jobs, setJobs] = useState([]);  // [{ id, prompt, answer, status, error }]
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef(null);
  const pollRef = useRef(null);

  const load = () => api.get('/assistant/history')
    .then((r) => {
      const { jobs: list, ...st } = r;
      setStatus(st);
      const ordered = list.slice().reverse();
      setJobs(ordered);
      // Une question laissée en cours (rechargement de page, onglet rouvert) doit
      // reprendre son suivi : sans cela elle affichait un sablier pour l'éternité.
      const pending = ordered.filter(inFlight).pop();
      if (pending) { setBusy(true); poll(pending.id); }
    })
    .catch(() => setStatus({ enabled: false, ready: false, state: 'off', reason: null }));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [jobs]);
  useEffect(() => () => clearInterval(pollRef.current), []);

  function poll(id) {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const { job } = await api.get(`/assistant/job/${id}`);
        setJobs((list) => list.map((x) => (x.id === id ? job : x)));
        if (!inFlight(job)) { clearInterval(pollRef.current); setBusy(false); }
      } catch { clearInterval(pollRef.current); setBusy(false); }
    }, 1500);
  }

  async function ask(e) {
    e.preventDefault();
    const prompt = text.trim();
    if (!prompt || busy) return;
    setBusy(true); setText('');
    try {
      const { job } = await api.post('/assistant/ask', { prompt });
      setJobs((j) => [...j, job]);
      poll(job.id);
    } catch (err) {
      // Refus du serveur (moteur absent) : on affiche la raison ET on rafraîchit le
      // bandeau d'état, pour que l'écran entier cesse de promettre un assistant.
      setJobs((j) => [...j, { id: 'e' + Date.now(), prompt, status: 'error', error: err.message }]);
      setBusy(false);
      api.get('/assistant/status').then(setStatus).catch(() => {});
    }
  }

  if (status === null) return <div className="pane"><div className="empty">Chargement…</div></div>;
  if (!status.enabled) return (
    <div className="pane"><div className="pane-head"><h2>Assistant IA</h2></div>
      <div className="empty">L'assistant IA est <b>désactivé</b>. Un administrateur peut l'activer dans <b>Réglages → Assistant IA</b> — il tourne <b>via le connecteur</b>, sur l'IA de votre organisation.</div>
    </div>
  );

  // Activé mais sans moteur joignable : l'assistant est inutilisable, on l'annonce.
  const blocked = !status.ready;

  return (
    <div className="pane" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="pane-head"><h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="comet" size={18} /> Assistant IA</h2></div>
      {blocked && (
        <div className="card" style={{ padding: 12, marginBottom: 10, borderLeft: '3px solid var(--danger)' }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Assistant indisponible sur ce serveur</div>
          <div className="setting-desc" style={{ margin: 0 }}>{status.reason}</div>
        </div>
      )}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '4px 2px' }}>
        {jobs.length === 0 && !blocked && (
          <div className="empty">
            Posez une question — l'IA de votre organisation (via le connecteur) y répondra.
            <div className="setting-desc" style={{ marginTop: 10 }}>
              À la différence du courrier et des canaux, cet assistant n'est <b>pas chiffré de bout en bout</b> :
              vos questions et leurs réponses transitent en clair par le serveur de votre organisation, qui les
              conserve. Elles ne quittent pas votre organisation, mais n'y écrivez rien que le serveur ne doive voir.
            </div>
          </div>
        )}
        {jobs.map((j) => (
          <div key={j.id} style={{ marginBottom: 14 }}>
            <div className="chat-msg mine"><div className="bubble"><div className="txt">{j.prompt}</div></div></div>
            <div className="chat-msg"><div className="bubble">
              <div className="txt" style={{ whiteSpace: 'pre-wrap' }}>
                {j.status === 'done' ? j.answer
                  : j.status === 'error' ? <span style={{ color: 'var(--danger)' }}>⚠ {j.error || 'Échec'}</span>
                  : <span className="meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>L'assistant réfléchit… <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /></span>}
              </div>
            </div></div>
          </div>
        ))}
      </div>
      <form onSubmit={ask} className="chat-composer">
        <input value={text} onChange={(e) => setText(e.target.value)} disabled={blocked}
          placeholder={blocked ? 'Assistant sans moteur IA — question impossible' : 'Votre question…'} autoFocus />
        <button className="btn" disabled={busy || blocked}><Icon name="send" size={16} /></button>
      </form>
    </div>
  );
}
