// Administration — serveurs Comet distants : leurs empreintes, leur état, le blocage, et
// l'acceptation d'une nouvelle clé (après l'avoir comparée avec l'administrateur d'en face).
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Icon from './Icon.jsx';

const ETATS = { actif: 'actif', bloque: 'bloqué', cle_changee: 'clé changée — en attente' };

export default function AdminFederation() {
  const [etat, setEtat] = useState(null);
  const [donnees, setDonnees] = useState(null);
  const [aBloquer, setABloquer] = useState('');
  const [msg, setMsg] = useState('');

  const charger = () => {
    api.get('/federation/etat').then(setEtat).catch(() => {});
    api.get('/federation/serveurs').then(setDonnees).catch(() => {});
  };
  useEffect(charger, []);
  if (!etat?.active && !etat?.erreur) return null;

  const agir = async (fn) => { setMsg(''); try { await fn(); charger(); } catch (e) { setMsg(e.message); } };
  const accepter = (s) => {
    const saisie = window.prompt(`Nouvelle empreinte annoncée par ${s.domaine} :\n${s.empreinteProposee}\n\nComparez-la avec l'administrateur de ${s.domaine} (par un autre canal), puis recopiez-la ici pour l'accepter.`);
    if (saisie) agir(() => api.post(`/federation/serveurs/${encodeURIComponent(s.domaine)}/accepter-cle`, { empreinte: saisie }));
  };
  const tourner = () => {
    if (window.confirm('Changer la clé de ce serveur ? Les serveurs qui connaissent l\'ancienne accepteront la nouvelle (elle est signée par l\'ancienne).')) {
      agir(() => api.post('/federation/identite/rotation'));
    }
  };

  return (
    <>
      <div className="setting-title" style={{ marginTop: 24, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="mail" size={16} /> Autres serveurs Comet</div>
      <div className="setting-desc" style={{ marginBottom: 10 }}>
        {etat.erreur ? <span style={{ color: 'var(--danger)' }}>{etat.erreur}</span>
          : <>Domaine <b>{etat.domaine}</b> · mode <b>{donnees?.mode || '…'}</b> · empreinte de ce serveur <code>{etat.empreinteServeur}</code> <button className="btn ghost" style={{ padding: '2px 8px', fontSize: 12 }} onClick={tourner}>Changer de clé</button></>}
      </div>
      <div className="card">
        {(donnees?.serveurs || []).length === 0 && <div className="empty" style={{ padding: 16 }}>Aucun serveur distant encore contacté.</div>}
        {(donnees?.serveurs || []).map((s) => (
          <div key={s.domaine} className="admin-row">
            <div className="ar-info">
              <div className="ar-name">{s.domaine} <span className="tag" style={s.etat === 'actif' ? {} : { color: 'var(--danger)' }}>{ETATS[s.etat] || s.etat}</span></div>
              <div className="ar-mail">
                {s.empreinte && s.etat !== 'bloque' ? <>empreinte <code>{s.empreinte}</code> · </> : null}
                vu le {s.vuDernier}{s.envois?.attente ? ` · ${s.envois.attente} en attente` : ''}{s.envois?.echec ? ` · ${s.envois.echec} non remis` : ''}
                {s.empreinteProposee && <div style={{ color: 'var(--danger)' }}>nouvelle clé proposée : <code>{s.empreinteProposee}</code></div>}
                {s.note && <div>{s.note}</div>}
              </div>
            </div>
            {s.etat === 'cle_changee' && <button className="icon-btn" onClick={() => accepter(s)}>Accepter la clé</button>}
            {s.etat === 'bloque'
              ? <button className="icon-btn" onClick={() => agir(() => api.post(`/federation/serveurs/${encodeURIComponent(s.domaine)}/debloquer`))}>Débloquer</button>
              : <button className="icon-btn" onClick={() => agir(() => api.post(`/federation/serveurs/${encodeURIComponent(s.domaine)}/bloquer`))}>Bloquer</button>}
          </div>
        ))}
      </div>
      <form className="add-row" style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); const d = aBloquer.trim(); if (d) agir(() => api.post(`/federation/serveurs/${encodeURIComponent(d)}/bloquer`)).then(() => setABloquer('')); }}>
        <input placeholder="Bloquer un domaine (ex. indesirable.fr)" value={aBloquer} onChange={(e) => setABloquer(e.target.value)} style={{ flex: 1 }} />
        <button className="btn"><Icon name="close" size={16} /> Bloquer</button>
      </form>
      {msg && <div className="hint" style={{ color: 'var(--danger)', marginTop: 6 }}>{msg}</div>}
    </>
  );
}
