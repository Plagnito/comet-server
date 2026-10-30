import { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';

function Tile({ name, stream, local, host, muted, camOff }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current && stream) ref.current.srcObject = stream; }, [stream]);
  return (
    <div className="vtile">
      <video ref={ref} autoPlay playsInline muted={local} style={camOff ? { visibility: 'hidden' } : undefined} />
      {camOff && <div className="vtile-off"><Icon name="videoOff" size={28} /></div>}
      <div className="vtile-name">{muted && <Icon name="micOff" size={13} />}{host && <span className="vtile-host" title="Hôte">★</span>}{name}{local ? ' (vous)' : ''}</div>
    </div>
  );
}

const VQ = [['1080p', '1080p'], ['720p', '720p'], ['480p', '480p']];

// Vue d'appel partagée (membre connecté ET invité).
export default function CallStage({
  roomName, tiles, muted, camOff, sharing, isHost, config, inviteLink,
  onToggleMute, onToggleCam, onToggleScreen, onLeave, onKick, onSetQuality, onSetAudio, onToggleLink,
}) {
  const [panel, setPanel] = useState(false);
  const [copied, setCopied] = useState(false);
  const count = tiles.length;

  function copyLink() {
    try { navigator.clipboard.writeText(inviteLink); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  }

  return (
    <div className="conf">
      <div className="conf-bar">
        <b>{roomName}</b>
        <span className="meta">{count} participant(s) · pair-à-pair, non enregistré</span>
        {isHost && <button className="icon-btn" title="Réglages de l'hôte" onClick={() => setPanel((v) => !v)} style={{ marginLeft: 'auto' }}><Icon name="sliders" size={16} /></button>}
      </div>

      <div className="conf-body">
        <div className={`conf-grid g${Math.min(count, 6)}`}>
          {tiles.map((t) => (
            <div key={t.id} className="vtile-wrap">
              <Tile {...t} host={t.local ? isHost : t.host} muted={t.local ? muted : false} camOff={t.local ? camOff : false} />
              {isHost && !t.local && (
                <button className="vtile-kick" title="Exclure ce participant" onClick={() => onKick(t.id)}><Icon name="close" size={13} /></button>
              )}
            </div>
          ))}
        </div>

        {isHost && panel && (
          <aside className="conf-panel">
            <div className="cp-title"><Icon name="sliders" size={15} /> Réglages de l'hôte</div>
            <label className="cp-row"><span>Qualité vidéo</span>
              <select value={config.video} onChange={(e) => onSetQuality(e.target.value)}>
                {VQ.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label className="cp-row"><span>Qualité audio</span>
              <select value={config.audio} onChange={(e) => onSetAudio(e.target.value)}>
                <option value="high">Haute</option><option value="low">Économique</option>
              </select>
            </label>
            <label className="cp-row"><span>Invitations par lien</span>
              <input type="checkbox" checked={config.linkEnabled !== false} onChange={(e) => onToggleLink(e.target.checked)} />
            </label>
            {config.linkEnabled !== false && (
              <div className="cp-invite">
                <div className="cp-invite-label">Lien d'invitation</div>
                <div className="cp-invite-row">
                  <input readOnly value={inviteLink} onFocus={(e) => e.target.select()} />
                  <button className="btn" onClick={copyLink}>{copied ? 'Copié ✓' : 'Copier'}</button>
                </div>
                <div className="cp-hint">Les invités rejoignent sans compte, avec un nom temporaire.</div>
              </div>
            )}
            <div className="cp-title" style={{ marginTop: 14 }}><Icon name="users" size={15} /> Participants</div>
            <div className="cp-people">
              {tiles.map((t) => (
                <div key={t.id} className="cp-person">
                  <span>{(t.local ? isHost : t.host) && '★ '}{t.name}{t.local ? ' (vous)' : ''}</span>
                  {!t.local && <button className="icon-btn sm" title="Exclure" onClick={() => onKick(t.id)}><Icon name="close" size={13} /></button>}
                </div>
              ))}
            </div>
          </aside>
        )}
      </div>

      <div className="conf-controls">
        <button className={`cc ${muted ? 'danger' : ''}`} onClick={onToggleMute} title={muted ? 'Activer le micro' : 'Couper le micro'}><Icon name={muted ? 'micOff' : 'mic'} size={20} /></button>
        <button className={`cc ${camOff ? 'danger' : ''}`} onClick={onToggleCam} title={camOff ? 'Activer la caméra' : 'Couper la caméra'}><Icon name={camOff ? 'videoOff' : 'video'} size={20} /></button>
        <button className={`cc ${sharing ? 'on' : ''}`} onClick={onToggleScreen} title={sharing ? 'Arrêter le partage' : 'Partager l\'écran'}><Icon name="board" size={20} /></button>
        <button className="cc leave" onClick={onLeave} title="Quitter la conférence"><Icon name="phoneOff" size={20} /></button>
      </div>
    </div>
  );
}
