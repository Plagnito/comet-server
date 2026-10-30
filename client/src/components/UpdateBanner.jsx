import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

// Deux mises à jour cohabitent :
//  1. CONTENU WEB (web + bureau) : surveille la version déployée (commit) et recharge
//     en arrière-plan quand c'est SANS RISQUE (aucune saisie en cours).
//  2. SHELL NATIF (bureau uniquement) : electron-updater télécharge la nouvelle version
//     de l'app en tâche de fond ; on propose alors un redémarrage immédiat (sinon elle
//     s'installe toute seule au prochain quit).
export default function UpdateBanner() {
  const initial = useRef(null);
  const [nativeReady, setNativeReady] = useState(null); // { version } quand une MAJ shell est prête

  // 1. Contenu web — rechargement discret quand rien n'est en cours.
  useEffect(() => {
    let active = true;
    const isBusy = () => !!document.querySelector('.compose, .modal-back, .palette');
    const check = async () => {
      try {
        const { commit } = await api.get('/version');
        if (!active || !commit) return;
        if (initial.current == null) { initial.current = commit; return; }
        if (commit !== initial.current && !isBusy()) window.location.reload();
      } catch { /* hors-ligne : on réessaiera */ }
    };
    check();
    const id = setInterval(check, 60_000);
    return () => { active = false; clearInterval(id); };
  }, []);

  // 2. Shell natif — écoute l'événement « mise à jour téléchargée » du process principal.
  useEffect(() => {
    const off = window.cometDesktop?.update?.onDownloaded?.((info) => setNativeReady(info || {}));
    return () => { try { off && off(); } catch { /* ignore */ } };
  }, []);

  if (!nativeReady) return null;

  const restart = () => { try { window.cometDesktop?.update?.install?.(); } catch { /* ignore */ } };
  return (
    <div style={{
      position: 'fixed', left: '50%', bottom: 18, transform: 'translateX(-50%)', zIndex: 9999,
      display: 'flex', alignItems: 'center', gap: 12, maxWidth: 460,
      padding: '10px 14px', borderRadius: 10, background: '#1b2140', color: '#e7e9f7',
      border: '1px solid #33407a', boxShadow: '0 8px 30px rgba(0,0,0,.35)', fontSize: 13.5,
    }}>
      <span style={{ flex: 1 }}>
        Une nouvelle version de Comet{nativeReady.version ? ` (${nativeReady.version})` : ''} est prête.
      </span>
      <button onClick={restart} style={{
        background: '#5b6cff', color: '#fff', border: 0, borderRadius: 8,
        padding: '6px 12px', fontWeight: 600, cursor: 'pointer',
      }}>Redémarrer</button>
      <button onClick={() => setNativeReady(null)} aria-label="Plus tard" style={{
        background: 'transparent', color: '#9aa3c7', border: 0, cursor: 'pointer', fontSize: 18, lineHeight: 1,
      }}>×</button>
    </div>
  );
}
