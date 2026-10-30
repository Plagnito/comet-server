import { useEffect, useState } from 'react';
import Icon from '../components/Icon.jsx';
import Login from './Login.jsx';

const REPO = 'https://github.com/Plagnito/comet-server';
const OS_LABEL = { win: 'Windows', mac: 'macOS', linux: 'Linux' };
const fmtSize = (n) => (n >= 1e6 ? `${(n / 1048576).toFixed(0)} Mo` : `${(n / 1024).toFixed(0)} Ko`);

const FEATURES = [
  { icon: 'mail', title: 'Courrier chiffré', desc: 'Messagerie interne chiffrée de bout en bout. Le serveur ne lit jamais vos messages.' },
  { icon: 'chat', title: "Messagerie d'équipe", desc: 'Canaux d\'organisation chiffrés, en temps réel, pour vos échanges quotidiens.' },
  { icon: 'video', title: 'Conférence P2P', desc: 'Visio audio et vidéo jusqu\'à 720p, pair-à-pair : les flux ne passent pas par le serveur.' },
  { icon: 'calendar', title: 'Agenda & rappels', desc: 'Calendrier collaboratif, invitations, disponibilités et rappels automatiques avant chaque événement.' },
  { icon: 'flow', title: 'Pipelines de projet', desc: 'Suivez l\'avancement de vos projets par étapes, avec responsables et permissions.' },
  { icon: 'lock', title: 'Coffre-fort', desc: 'Stockez mots de passe et secrets en zéro-knowledge, déchiffrés uniquement chez vous.' },
];

const SECURITY = [
  { icon: 'shield', title: 'Chiffrement de bout en bout', desc: 'Clés générées dans votre navigateur, clé privée scellée par votre mot de passe. Le serveur ne stocke que du chiffré.' },
  { icon: 'flow', title: 'Pair-à-pair', desc: 'Pièces jointes et conférences transitent directement entre membres — jamais stockées en clair sur le serveur.' },
  { icon: 'badge', title: 'Zéro-knowledge', desc: 'Coffre-fort, alias, 2FA, sessions révocables : la confidentialité par défaut, sans compromis.' },
];

const PLATFORMS = [
  { os: 'Windows', note: '.exe · Windows 10/11' },
  { os: 'macOS', note: '.dmg · Apple Silicon & Intel' },
  { os: 'Linux', note: 'AppImage · .deb' },
];

export default function Landing() {
  const [showAuth, setShowAuth] = useState(false);
  const [dl, setDl] = useState(null); // { version, assets:[{os,name,size}] }
  useEffect(() => { fetch('/api/download/releases').then((r) => r.json()).then(setDl).catch(() => setDl({ version: null, assets: [] })); }, []);
  if (showAuth) return <Login onBack={() => setShowAuth(false)} />;
  const hasBuilds = dl && dl.assets && dl.assets.length > 0;

  return (
    <div className="lp">
      <header className="lp-nav">
        <div className="lp-brand"><span className="brand-mark"><Icon name="comet" filled size={18} /></span> Comet</div>
        <nav className="lp-links">
          <a href="#features">Fonctionnalités</a>
          <a href="#security">Sécurité</a>
          <a href="#download">Télécharger</a>
        </nav>
        <button className="btn" onClick={() => setShowAuth(true)}>Se connecter</button>
      </header>

      <section className="lp-hero">
        <div className="lp-hero-text">
          <span className="lp-badge"><Icon name="shield" size={13} /> Chiffré de bout en bout</span>
          <h1>Votre suite de productivité,<br /><span className="grad">privée par conception.</span></h1>
          <p>Courrier, messagerie d'équipe, conférence, agenda, pipelines, coffre-fort — réunis dans une application native chiffrée. Sans publicité, sans traçage, hébergeable chez vous.</p>
          <div className="lp-cta">
            <button className="btn lg" onClick={() => setShowAuth(true)}>Commencer gratuitement</button>
            <a className="btn lg ghost" href="#download"><Icon name="video" size={16} style={{ display: 'none' }} />Télécharger l'application</a>
          </div>
          <div className="lp-trust"><Icon name="lock" size={13} /> Aucune donnée vendue · Chiffrement WebCrypto · Code ouvert</div>
        </div>
        <div className="lp-hero-art" aria-hidden="true">
          <div className="lp-orb"><Icon name="comet" filled size={120} /></div>
          <div className="lp-chip c1"><Icon name="mail" size={16} /> Message chiffré</div>
          <div className="lp-chip c2"><Icon name="video" size={16} /> Visio P2P · 720p</div>
          <div className="lp-chip c3"><Icon name="flow" size={16} /> Pipeline · 3/4</div>
        </div>
      </section>

      <section id="features" className="lp-section">
        <div className="lp-head"><h2>Tout ce qu'il vous faut, au même endroit</h2><p>Une suite complète façon Outlook, repensée autour de la confidentialité.</p></div>
        <div className="lp-grid">
          {FEATURES.map((f) => (
            <div key={f.title} className="lp-card">
              <div className="lp-ico"><Icon name={f.icon} size={22} /></div>
              <h3>{f.title}</h3>
              <p>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="security" className="lp-section lp-security">
        <div className="lp-head"><h2>La confidentialité n'est pas une option</h2><p>Conçu pour que personne — pas même le serveur — ne puisse lire vos données.</p></div>
        <div className="lp-grid g3">
          {SECURITY.map((s) => (
            <div key={s.title} className="lp-card sec">
              <div className="lp-ico"><Icon name={s.icon} size={22} /></div>
              <h3>{s.title}</h3>
              <p>{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="download" className="lp-section lp-download">
        <div className="lp-head"><h2>Application de bureau native</h2><p>Installez Comet sur votre ordinateur : démarrage au boot, mises à jour silencieuses, pièces jointes pair-à-pair même hors ligne.</p></div>
        <div className="lp-dl-row">
          {hasBuilds
            ? dl.assets.map((a) => (
              <a key={a.os} className="lp-dl" href={`/api/download/desktop/${a.os}`}>
                <Icon name="logout" size={20} style={{ transform: 'rotate(90deg)' }} />
                <span className="dl-os">{OS_LABEL[a.os] || a.os}</span>
                <span className="dl-note">{fmtSize(a.size)}</span>
              </a>
            ))
            // Dépôt privé : aucun lien vers GitHub (inaccessible aux visiteurs). Les
            // installateurs sont TOUJOURS servis par l'instance via /api/download/desktop/:os.
            : PLATFORMS.map((p) => (
              <div key={p.os} className="lp-dl disabled" aria-disabled="true">
                <Icon name="logout" size={20} style={{ transform: 'rotate(90deg)' }} />
                <span className="dl-os">{p.os}</span>
                <span className="dl-note">{p.note}</span>
              </div>
            ))}
        </div>
        {hasBuilds
          ? <div className="lp-or" style={{ marginTop: 12 }}>Version {dl.version} · téléchargement servi par votre instance</div>
          : <div className="lp-or" style={{ marginTop: 12 }}>Installateurs en préparation — ils seront servis directement par cette instance dès la première version publiée.</div>}
        <div className="lp-or">ou <button className="linklike" onClick={() => setShowAuth(true)}>utilisez Comet directement dans votre navigateur</button></div>
      </section>

      <footer className="lp-foot">
        <div className="lp-brand"><span className="brand-mark"><Icon name="comet" filled size={16} /></span> Comet</div>
        {/* ⚠️ Ce pied de page disait « © 2026 Comet. » — c'est-à-dire qu'il ne nommait
            PERSONNE. Sur la seule page publique du produit, l'éditeur restait introuvable
            même pour un lecteur humain attentif ; le <head> a beau porter l'attribution
            depuis le 30/08, une page qui ne se réclame de personne à l'écran continue de
            se faire attribuer à quelqu'un d'autre. */}
        <p>Suite de productivité chiffrée, autonome et hébergeable. Créée et éditée par Plagnito. © 2026.</p>
        <div className="lp-foot-links">
          <a href="#features">Fonctionnalités</a>
          <a href="#security">Sécurité</a>
          <a href={REPO} target="_blank" rel="noreferrer">Code source</a>
          <button className="linklike" onClick={() => setShowAuth(true)}>Se connecter</button>
        </div>
      </footer>
    </div>
  );
}
