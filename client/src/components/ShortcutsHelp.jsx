import Icon from './Icon.jsx';

// Liste des raccourcis — réutilisée par le gestionnaire clavier (AppShell) et l'aide.
export const SHORTCUTS = [
  { keys: ['Ctrl', 'K'], label: 'Recherche & commandes' },
  { keys: ['c'], label: 'Nouveau message' },
  { keys: ['/'], label: 'Recherche du module' },
  { keys: ['g', 'm'], label: 'Aller au Courrier' },
  { keys: ['g', 'e'], label: 'Aller à l’Équipe' },
  { keys: ['g', 'v'], label: 'Aller à la Conférence' },
  { keys: ['g', 'a'], label: 'Aller à l’Agenda' },
  { keys: ['g', 't'], label: 'Aller aux Tâches' },
  { keys: ['g', 'b'], label: 'Aller au Tableau' },
  { keys: ['g', 'p'], label: 'Aller aux Pipelines' },
  { keys: ['g', 'n'], label: 'Aller aux Notes' },
  { keys: ['g', 'c'], label: 'Aller aux Contacts' },
  { keys: ['g', 'd'], label: 'Aller à l’Annuaire' },
  { keys: ['?'], label: 'Afficher cette aide' },
];

export default function ShortcutsHelp({ onClose }) {
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="shortcuts-modal">
        <div className="compose-bar">
          Raccourcis clavier
          <button onClick={onClose} title="Fermer"><Icon name="close" size={18} /></button>
        </div>
        <div className="shortcuts-list">
          {SHORTCUTS.map((s) => (
            <div className="shortcut-row" key={s.label}>
              <span className="shortcut-keys">
                {s.keys.map((k, i) => (
                  <span key={i}>{i > 0 && <span className="shortcut-then">puis</span>}<kbd>{k}</kbd></span>
                ))}
              </span>
              <span className="shortcut-label">{s.label}</span>
            </div>
          ))}
        </div>
        <div className="shortcuts-foot">Les raccourcis sont inactifs pendant la saisie dans un champ.</div>
      </div>
    </div>
  );
}
