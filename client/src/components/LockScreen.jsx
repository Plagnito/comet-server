import { useState } from 'react';
import { verifyPIN } from '../lock.js';
import { useAuth } from '../auth.jsx';
import Icon from './Icon.jsx';

export default function LockScreen({ onUnlock }) {
  const { user, logout } = useAuth();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (await verifyPIN(pin)) onUnlock();
    else { setError('Code incorrect.'); setPin(''); }
  }

  return (
    <div className="auth">
      <div className="auth-card" style={{ textAlign: 'center' }}>
        <div className="brand-mark" style={{ margin: '0 auto 14px' }}><Icon name="lock" size={20} /></div>
        <h1 style={{ margin: 0 }}>Comet verrouillé</h1>
        <p className="sub" style={{ marginTop: 4 }}>{user?.displayName} — saisissez votre code</p>
        {error && <div className="alert">{error}</div>}
        <form onSubmit={submit}>
          <input className="input" type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} placeholder="••••" autoFocus style={{ textAlign: 'center', letterSpacing: '8px', fontSize: 22, padding: '12px' }} />
          <button className="btn block" style={{ marginTop: 12 }}>Déverrouiller</button>
        </form>
        <div className="auth-switch"><button onClick={logout}>Se déconnecter</button></div>
      </div>
    </div>
  );
}
