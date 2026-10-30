import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';

// Barre « Message envoyé · Annuler » : compte à rebours avant l'envoi réel.
// onDone() est appelé à la fin du délai (l'envoi est alors confirmé) ;
// onUndo() si l'utilisateur annule (le brouillon est rétabli par le parent).
export default function UndoToast({ seconds = 6, onUndo, onDone }) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    const tick = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    const done = setTimeout(onDone, seconds * 1000);
    return () => { clearInterval(tick); clearTimeout(done); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="undo-toast" role="status">
      <span className="undo-ring" style={{ '--p': `${(left / seconds) * 100}%` }}>{left}</span>
      <Icon name="send" size={15} />
      <span className="undo-text">Message envoyé</span>
      <button className="undo-btn" onClick={onUndo}><Icon name="reply" size={14} /> Annuler</button>
    </div>
  );
}
