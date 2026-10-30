import { useEffect, useRef, useState } from 'react';
import { useAuth } from './auth.jsx';
import Landing from './pages/Landing.jsx';
import AppShell from './components/AppShell.jsx';
import GuestConference from './components/GuestConference.jsx';
import LockScreen from './components/LockScreen.jsx';
import UpdateBanner from './components/UpdateBanner.jsx';
import TitleBar from './components/TitleBar.jsx';
import { hasPIN, isLockedPersisted, persistLocked, getTimeoutMin } from './lock.js';

// Page publique d'invitation à une conférence (sans compte) — hors flux d'auth.
const isGuestConfPath = typeof window !== 'undefined' && window.location.pathname.startsWith('/rejoindre/');
// App de bureau (Electron) → barre de titre custom, look natif Windows.
const isDesktopApp = typeof window !== 'undefined' && !!(window.cometDesktop && window.cometDesktop.isDesktop);
if (isDesktopApp) document.documentElement.classList.add('desktop');

export default function App() {
  const { user, loading } = useAuth();
  const [locked, setLocked] = useState(() => isLockedPersisted());
  const timer = useRef(null);

  // Verrou : inactivité (selon le délai réglé) + verrou manuel (événement 'comet:lock')
  useEffect(() => {
    if (!user) return;
    const lock = () => { if (hasPIN()) { persistLocked(true); setLocked(true); } };
    const reset = () => {
      clearTimeout(timer.current);
      const min = getTimeoutMin();
      if (hasPIN() && min > 0 && !locked) timer.current = setTimeout(lock, min * 60_000);
    };
    const events = ['mousemove', 'keydown', 'click', 'touchstart'];
    window.addEventListener('comet:lock', lock);
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      clearTimeout(timer.current);
      window.removeEventListener('comet:lock', lock);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [user, locked]);

  let content;
  if (isGuestConfPath) content = <GuestConference />;
  else if (loading) content = <div className="center-screen"><div className="spinner" /></div>;
  else if (user && hasPIN() && locked) content = <LockScreen onUnlock={() => { persistLocked(false); setLocked(false); }} />;
  else content = (<><UpdateBanner />{user ? <AppShell /> : <Landing />}</>);

  return (
    <>
      {isDesktopApp && <TitleBar />}
      <div className="app-viewport">{content}</div>
    </>
  );
}
