import { createContext, useContext, useEffect, useState } from 'react';
import { api, getToken, setToken } from './api.js';
import {
  generateKeyPair, exportPublicKey, wrapPrivateKey, unwrapPrivateKey,
} from './crypto.js';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

const PRIV_CACHE = 'comet.privkey';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [privateKey, setPrivateKey] = useState(null);

  useEffect(() => {
    try { localStorage.removeItem(PRIV_CACHE); sessionStorage.removeItem(PRIV_CACHE); } catch {}
    setLoading(false);
    const expired = () => { setUser(null); setPrivateKey(null); };
    window.addEventListener('comet:auth-expired', expired);
    return () => window.removeEventListener('comet:auth-expired', expired);
  }, []);

  // Déverrouille (ou provisionne) la clé privée à partir du mot de passe saisi.
  async function establishKeys(password, encPrivateKey, u) {
    let priv, publicKey = u.publicKey;
    if (encPrivateKey) {
      try {
        priv = await unwrapPrivateKey(encPrivateKey, password);
      } catch {
        // AES-GCM lève un OperationError au message VIDE quand le mot de passe est faux.
        // Sans ce garde, la couche appelante faisait setError(err.message) = '' → aucune
        // alerte affichée → le bouton « Déverrouiller » semblait « ne rien faire ». On
        // remonte donc un message explicite et actionnable.
        throw new Error('Mot de passe incorrect. Saisissez le mot de passe Comet qui chiffre votre courrier.');
      }
    } else {
      const kp = await generateKeyPair();
      publicKey = await exportPublicKey(kp);
      const r = await api.post('/auth/keys', { publicKey, encPrivateKey: await wrapPrivateKey(kp, password), currentPassword: password });
      if (r.token) setToken(r.token);
      priv = kp.privateKey;
    }
    setPrivateKey(priv);
    return { ...u, publicKey };
  }

  const login = async (email, password) => {
    const r = await api.post('/auth/login', { email, password });
    if (r.twoFactorRequired) return { twoFactorRequired: true, tmpToken: r.tmpToken };
    setToken(r.token);
    setUser(await establishKeys(password, r.encPrivateKey, r.user));
    return { ok: true };
  };

  const verify2fa = async (tmpToken, code, password) => {
    const r = await api.post('/auth/2fa/verify', { tmpToken, code });
    setToken(r.token);
    setUser(await establishKeys(password, r.encPrivateKey, r.user));
  };

  const refreshUser = async () => {
    const r = await api.get('/auth/me');
    setUser(r.user);
  };

  const register = async (email, displayName, password, bootstrapToken) => {
    const kp = await generateKeyPair();
    const publicKey = await exportPublicKey(kp);
    const encPrivateKey = await wrapPrivateKey(kp, password);
    const r = await api.post('/auth/register', { email, displayName, password, publicKey, encPrivateKey, bootstrapToken });
    setToken(r.token);
    setPrivateKey(kp.privateKey);
    setUser(r.user);
  };

  // ── Réinitialisation DESTRUCTIVE du mot de passe Comet (E2EE) ──────────────
  // À utiliser quand le mot de passe Comet est OUBLIÉ : sa clé privée (enveloppée par
  // l'ancien mot de passe) est irrécupérable → on génère une clé NEUVE scellée par le
  // nouveau mot de passe. Le serveur purge alors la boîte devenue illisible (les mails
  // sont chiffrés pour l'ancienne clé). Irréversible → l'appelant DOIT avoir recueilli
  // une confirmation explicite avant d'appeler ceci. Voir routes/auth.js.
  const resetPassword = async (newPassword, { currentPassword, currentCode, confirm = false } = {}) => {
    const kp = await generateKeyPair();
    const publicKey = await exportPublicKey(kp);
    const encPrivateKey = await wrapPrivateKey(kp, newPassword);
    const r = await api.post('/auth/reset-password', { newPassword, publicKey, encPrivateKey, currentPassword, currentCode, confirm });
    if (r.token) setToken(r.token);
    setPrivateKey(kp.privateKey);
    if (r.user) setUser(r.user);
    return r; // { ok, purged, user }
  };

  const logout = () => {
    if (getToken()) api.post('/auth/logout').catch(() => {});
    setToken(null);
    try { localStorage.removeItem(PRIV_CACHE); } catch {}
    setUser(null);
    setPrivateKey(null);
  };
  const acceptSession = (r) => { if (r.token) setToken(r.token); if (r.user) setUser(r.user); };

  return (
    <AuthCtx.Provider value={{ user, loading, privateKey, myPublicKey: user?.publicKey || null, login, register, logout, verify2fa, refreshUser, resetPassword, acceptSession }}>
      {children}
    </AuthCtx.Provider>
  );
}
