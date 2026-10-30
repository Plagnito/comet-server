import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { AuthProvider } from './auth.jsx';
import './styles.css';

// Plus de BrowserRouter : il enveloppait l'application sans qu'AUCUNE route, aucun
// <Link> ni aucun useNavigate n'existe nulle part — la navigation entre modules se fait
// par l'état du shell. La dépendance ne servait donc à rien, et portait deux alertes de
// sécurité (redirection ouverte) dont le correctif imposait un passage en version
// majeure. Retirer valait mieux que migrer ce qui n'était pas utilisé.
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>
);

// PWA : enregistre le service worker uniquement sur le build de prod (pas en dev → pas d'interférence HMR).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}
