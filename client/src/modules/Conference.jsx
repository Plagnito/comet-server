import { useEffect, useRef, useState, useCallback } from 'react';
import { api, getToken } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Conference as ConfManager } from '../conf.js';
import Icon from '../components/Icon.jsx';
import CallStage from '../components/CallStage.jsx';

const errMsg = (code) => ({
  'room-not-found': 'Salon introuvable ou terminé.',
  'link-disabled': 'Les invitations par lien sont désactivées.',
  banned: 'Vous avez été exclu de ce salon.',
}[code] || 'Connexion à la conférence impossible.');

export default function Conference() {
  const { user } = useAuth();
  const [phase, setPhase] = useState('lobby');
  const [room, setRoom] = useState(null); // { id, name }
  const [tiles, setTiles] = useState([]);
  const [muted, setMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [config, setConfig] = useState({ video: '720p', audio: 'high', linkEnabled: true });
  const [error, setError] = useState('');
  const [ongoing, setOngoing] = useState([]);
  const [newName, setNewName] = useState('');
  const confRef = useRef(null);

  const loadOngoing = useCallback(() => { api.get('/conf/rooms').then((r) => setOngoing(r.rooms)).catch(() => {}); }, []);
  useEffect(() => { loadOngoing(); const t = setInterval(loadOngoing, 7000); return () => clearInterval(t); }, [loadOngoing]);
  useEffect(() => () => confRef.current?.leave(), []);

  function handleEvent(ev) {
    if (ev.type === 'local') {
      setTiles((t) => [{ id: 'local', name: user.displayName, stream: ev.stream, local: true }, ...t.filter((x) => x.id !== 'local')]);
      if (typeof ev.screen === 'boolean') setSharing(ev.screen);
    } else if (ev.type === 'peer') {
      setTiles((t) => [...t.filter((x) => x.id !== ev.peerId), { id: ev.peerId, name: ev.name || 'Invité', host: ev.host, stream: ev.stream }]);
    } else if (ev.type === 'peerleave') {
      setTiles((t) => t.filter((x) => x.id !== ev.peerId));
    } else if (ev.type === 'joined') {
      setIsHost(ev.isHost); setConfig((c) => ({ ...c, ...ev.config }));
    } else if (ev.type === 'config') {
      setConfig((c) => ({ ...c, ...ev.config }));
    } else if (ev.type === 'kicked') {
      setError('Vous avez été exclu de la conférence.'); doLeave();
    } else if (ev.type === 'error') {
      setError(errMsg(ev.code)); doLeave();
    }
  }

  function doLeave() {
    confRef.current?.leave(); confRef.current = null;
    setTiles([]); setMuted(false); setCamOff(false); setSharing(false); setIsHost(false); setPhase('lobby'); loadOngoing();
  }

  async function startManager(roomId, roomName, cfg) {
    setError('');
    try {
      const c = new ConfManager(getToken(), user.displayName, handleEvent);
      confRef.current = c;
      await c.start(roomId, cfg);
      setRoom({ id: roomId, name: roomName }); setPhase('incall');
    } catch (err) { confRef.current = null; setError('Caméra/micro inaccessibles : ' + (err?.message || err)); }
  }
  async function createRoom(e) {
    e?.preventDefault();
    const r = await api.post('/conf/rooms', { name: newName.trim() || 'Réunion' });
    setConfig({ ...r.room.config, linkEnabled: r.room.linkEnabled }); setNewName('');
    await startManager(r.room.id, r.room.name, r.room.config);
  }
  async function joinRoom(roomId, roomName) {
    let cfg;
    try { const r = await api.get(`/conf/rooms/${roomId}`); cfg = r.room.config; roomName = roomName || r.room.name; } catch {}
    await startManager(roomId, roomName || 'Réunion', cfg);
  }

  const toggleMute = () => setMuted(confRef.current?.toggleMute() ?? false);
  const toggleCam = () => setCamOff(confRef.current?.toggleCam() ?? false);
  const toggleScreen = () => { if (sharing) confRef.current?.stopScreen(); else confRef.current?.shareScreen().catch(() => {}); };
  const kick = (peerId) => confRef.current?.kick(peerId);
  const setQuality = (v) => { confRef.current?.setRoomConfig({ video: v }); setConfig((c) => ({ ...c, video: v })); };
  const setAudio = (v) => { confRef.current?.setRoomConfig({ audio: v }); setConfig((c) => ({ ...c, audio: v })); };
  const toggleLink = (v) => { confRef.current?.setRoomConfig({ linkEnabled: v }); setConfig((c) => ({ ...c, linkEnabled: v })); };

  if (phase === 'incall') {
    return (
      <CallStage
        roomName={room?.name} tiles={tiles} muted={muted} camOff={camOff} sharing={sharing}
        isHost={isHost} config={config} inviteLink={`${location.origin}/rejoindre/${room?.id}`}
        onToggleMute={toggleMute} onToggleCam={toggleCam} onToggleScreen={toggleScreen} onLeave={doLeave}
        onKick={kick} onSetQuality={setQuality} onSetAudio={setAudio} onToggleLink={toggleLink}
      />
    );
  }

  return (
    <div className="conf-lobby">
      <div className="conf-card">
        <div className="conf-ico"><Icon name="video" size={30} /></div>
        <h2>Conférence sécurisée</h2>
        <p>Audio et vidéo <b>pair-à-pair</b> (jusqu'à 1080p). Les flux circulent directement entre participants : ils ne transitent jamais par le serveur et ne sont pas enregistrés.</p>
        <form onSubmit={createRoom}>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Nom de la réunion (ex. Comité produit)" autoFocus />
          <button className="btn"><Icon name="video" size={16} /> Démarrer une réunion</button>
        </form>
        {error && <div className="conf-error">{error}</div>}
      </div>

      <div className="conf-ongoing">
        <div className="conf-ongoing-head"><Icon name="video" size={16} /> Conférences en cours <button className="icon-btn sm" title="Rafraîchir" onClick={loadOngoing}><Icon name="clock" size={14} /></button></div>
        {ongoing.length === 0 && <div className="empty" style={{ padding: 24 }}>Aucune conférence en cours dans l'organisation.</div>}
        {ongoing.map((r) => (
          <div key={r.id} className="conf-room-row">
            <div className="crr-info">
              <div className="crr-name">{r.name}</div>
              <div className="crr-meta">Hôte : {r.hostName || '—'} · {r.count} participant(s){!r.linkEnabled ? ' · 🔒 lien fermé' : ''}</div>
            </div>
            <button className="btn" onClick={() => joinRoom(r.id, r.name)}><Icon name="video" size={15} /> Rejoindre</button>
          </div>
        ))}
      </div>
    </div>
  );
}
