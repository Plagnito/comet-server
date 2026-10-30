import { useEffect, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
import Icon from '../components/Icon.jsx';

export default function Login({ onBack }) {
  const { login, register, verify2fa } = useAuth();
  // Inscription : proposée seulement si CE serveur l'a ouverte (COMET_INSCRIPTION).
  const [inscription, setInscription] = useState(false);
  const [mode, setMode] = useState('login');
  const [name, setName] = useState('');
  useEffect(() => { api.get('/auth/options').then((r) => setInscription(!!r?.inscription)).catch(() => {}); }, []);
  const isRegister = inscription && mode === 'register';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [twoFA, setTwoFA] = useState(null); // { tmpToken }
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false); const notice = '';

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (twoFA) {
        await verify2fa(twoFA.tmpToken, code, password);
      } else if (isRegister) {
        await register(email, name, password);
      } else {
        const r = await login(email, password);
        if (r?.twoFactorRequired) { setTwoFA({ tmpToken: r.tmpToken }); setBusy(false); return; }
      }
    } catch (err) {
      setError(err?.message || 'Connexion impossible. Réessayez.');
      setBusy(false);
    }
  }

  // Étape 2 : code 2FA
  if (twoFA) {
    return (
      <div className="auth">
        <div className="auth-card">
          <div className="brand"><span className="brand-mark"><Icon name="comet" filled size={19} /></span> Comet</div>
          {onBack && <button className="auth-back" onClick={onBack}><Icon name="chevronLeft" size={14} /> Accueil</button>}
          <h1>Vérification en deux étapes</h1>
          <p className="sub">Saisissez le code de votre application d'authentification (ou un code de récupération).</p>
          {error && <div className="alert">{error}</div>}
          <form onSubmit={submit}>
            <div className="field">
              <label>Code à 6 chiffres</label>
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" autoFocus inputMode="numeric" />
            </div>
            <button className="btn block" disabled={busy}>{busy ? '…' : 'Vérifier'}</button>
          </form>
          <div className="auth-switch"><button onClick={() => { setTwoFA(null); setCode(''); setError(''); }}>Retour</button></div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="brand"><span className="brand-mark"><Icon name="comet" filled size={19} /></span> Comet</div>
        {onBack && <button className="auth-back" onClick={onBack}><Icon name="chevronLeft" size={14} /> Accueil</button>}
        <h1>{isRegister ? 'Créer un compte' : 'Bienvenue sur Comet'}</h1>
        <p className="sub">{isRegister ? 'Votre espace mail, agenda, contacts, tâches et notes — chiffré.' : 'Connectez-vous à votre espace Comet.'}</p>

        {error && <div className="alert">{error}</div>}
        {notice && (
          <div className="alert" style={{ background: 'rgba(79,70,229,.12)', borderColor: '#4f46e5' }}>{notice}</div>
        )}


        <form onSubmit={submit}>
          {isRegister && (
            <div className="field">
              <label>Nom affiché</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Camille Martin" autoFocus />
            </div>
          )}
          <div className="field">
            <label>Adresse Comet</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="prenom@comet.mail" />
            {isRegister && <div className="hint">Sans domaine, on ajoute automatiquement « @comet.mail ». Adresse utilisable uniquement dans Comet.</div>}
          </div>
          <div className="field">
            <label>Mot de passe</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            {isRegister && <div className="hint">Il chiffre aussi votre courrier : s'il est perdu, le courrier chiffré l'est aussi.</div>}
          </div>
          <button className="btn block" disabled={busy}>{busy ? '…' : isRegister ? 'Créer mon compte' : 'Se connecter'}</button>
        </form>

        {inscription && (
          <div className="auth-switch">
            {isRegister
              ? <>Déjà un compte ? <button onClick={() => { setMode('login'); setError(''); }}>Se connecter</button></>
              : <>Nouveau ici ? <button onClick={() => { setMode('register'); setError(''); }}>Créer un compte</button></>}
          </div>
        )}
      </div>
    </div>
  );
}
