import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';

// Barre de titre custom (look natif Windows) — visible uniquement dans l'app de bureau.
// Boutons fenêtre via le pont Electron ; glyphes Segoe Fluent Icons (natifs Windows).
const wc = () => (typeof window !== 'undefined' ? window.cometDesktop?.windowControls : null);

export default function TitleBar() {
  const [max, setMax] = useState(false);
  useEffect(() => {
    const c = wc(); if (!c) return;
    c.isMaximized?.().then(setMax).catch(() => {});
    return c.onMaximizeChange ? c.onMaximizeChange(setMax) : undefined;
  }, []);
  const c = wc();
  return (
    <div className="titlebar" onDoubleClick={() => c?.maximize()}>
      <div className="tb-brand"><Icon name="comet" filled size={14} /> <span>Comet</span></div>
      <div className="tb-spacer" />
      <div className="tb-btns">
        <button className="tb-btn" title="Réduire" onClick={() => c?.minimize()}><span className="tb-ico">{''}</span></button>
        <button className="tb-btn" title={max ? 'Restaurer' : 'Agrandir'} onClick={() => c?.maximize()}><span className="tb-ico">{max ? '' : ''}</span></button>
        <button className="tb-btn close" title="Fermer" onClick={() => c?.close()}><span className="tb-ico">{''}</span></button>
      </div>
    </div>
  );
}
