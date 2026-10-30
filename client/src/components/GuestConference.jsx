import { useEffect, useRef, useState } from 'react';
import { Conference as ConfManager } from '../conf.js';
import CallStage from './CallStage.jsx';
import Icon from './Icon.jsx';

const roomIdFromPath = () => decodeURIComponent((location.pathname.match(/\/rejoindre\/([^/?#]+)/) || [])[1] || '');

// Page publique : rejoindre une conférence par lien, sans compte (nom temporaire).
export default function GuestConference() {
  const roomId = roomIdFromPath();
  const [phase, setPhase] = useState('loading'); // loading | name | incall | gone
  const [room, setRoom] = useState(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [tiles, setTiles] = useState([]);
  const [muted, setMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [config, setConfig] = useState({ video: '720p', audio: 'high' });
  const confRef = useRef(null);
  const nameRef = useRef('Invité');

  useEffect(() => {
    if (!roomId) { setPhase('gone'); return; }
    fetch(`/api/conf/rooms/${encodeURIComponent(roomId)}`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => { setRoom(d.room); setConfig(d.room.config); setPhase(d.room.linkEnabled ? 'name' : 'gone'); })
      .catch(() => setPhase('gone'));
  }, [roomId]);
  useEffect(() => () => confRef.current?.leave(), []);

  function handleEvent(ev) {
    if (ev.type === 'local') {
      setTiles((t) => [{ id: 'local', name: nameRef.current, stream: ev.stream, local: true }, ...t.filter((x) => x.id !== 'local')]);
      if (typeof ev.screen === 'boolean') setSharing(ev.screen);
    } else if (ev.type === 'peer') {
      setTiles((t) => [...t.filter((x) => x.id !== ev.peerId), { id: ev.peerId, name: ev.name || 'Invité', host: ev.host, stream: ev.stream }]);
    } else if (ev.type === 'peerleave') {
      setTiles((t) => t.filter((x) => x.id !== ev.peerId));
    } else if (ev.type === 'config') {
      setConfig((c) => ({ ...c, ...ev.config }));
    } else if (ev.type === 'kicked') {
      setError('Vous avez été exclu de la conférence.'); leave();
    } else if (ev.type === 'error') {
      setError('Connexion impossible (salon terminé ou lien fermé).'); leave();
    }
  }

  async function join(e) {
    e?.preventDefault();
    const n = name.trim(); if (!n) return;
    setError('');
    try {
      const r = await fetch(`/api/conf/rooms/${encodeURIComponent(roomId)}/guest`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Impossible de rejoindre'); }
      const d = await r.json();
      nameRef.current = d.name || n;
      const c = new ConfManager(d.token, d.name || n, handleEvent);
      confRef.current = c;
      await c.start(roomId, d.room.config);
      setPhase('incall');
    } catch (err) { setError(err?.message?.includes('media') || err?.name === 'NotAllowedError' ? 'Caméra/micro inaccessibles.' : (err?.message || 'Connexion impossible.')); }
  }
  function leave() {
    confRef.current?.leave(); confRef.current = null;
    setTiles([]); setMuted(false); setCamOff(false); setSharing(false); setPhase(roomId ? 'name' : 'gone');
  }

  const toggleMute = () => setMuted(confRef.current?.toggleMute() ?? false);
  const toggleCam = () => setCamOff(confRef.current?.toggleCam() ?? false);
  const toggleScreen = () => { if (sharing) confRef.current?.stopScreen(); else confRef.current?.shareScreen().catch(() => {}); };

  if (phase === 'incall') {
    return (
      <CallStage
        roomName={room?.name} tiles={tiles} muted={muted} camOff={camOff} sharing={sharing}
        isHost={false} config={config} inviteLink={`${location.origin}/rejoindre/${roomId}`}
        onToggleMute={toggleMute} onToggleCam={toggleCam} onToggleScreen={toggleScreen} onLeave={leave}
        onKick={() => {}} onSetQuality={() => {}} onSetAudio={() => {}} onToggleLink={() => {}}
      />
    );
  }

  return (
    <div className="guest-join">
      <div className="conf-card">
        <div className="conf-ico"><Icon name="video" size={30} /></div>
        {phase === 'loading' && <p>Chargement de la conférence…</p>}
        {phase === 'gone' && <><h2>Conférence indisponible</h2><p>Ce lien est invalide, la réunion est terminée ou les invitations ont été désactivées.</p></>}
        {phase === 'name' && (
          <>
            <h2>{room?.name || 'Rejoindre la conférence'}</h2>
            <p>Vous rejoignez en tant qu'invité. Choisissez un nom affiché aux participants — <b>aucun compte requis</b>.</p>
            <form onSubmit={join}>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Votre nom (ex. Camille)" maxLength={40} autoFocus />
              <button className="btn"><Icon name="video" size={16} /> Rejoindre la réunion</button>
            </form>
            {error && <div className="conf-error">{error}</div>}
            <div className="guest-foot">Audio/vidéo pair-à-pair, non enregistrés. Propulsé par <b>Comet</b>.</div>
          </>
        )}
      </div>
    </div>
  );
}
