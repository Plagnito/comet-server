// Métadonnées et composants partagés par AppShell ET les modules.
// IMPORTANT : ce fichier n'importe RIEN depuis modules/ → il casse la dépendance
// circulaire (AppShell ↔ modules) qui plaçait `MODULES`/`PRESENCE` (des `const`)
// dans la zone morte temporelle (TDZ) au runtime → « Cannot access before initialization ».

export const MODULES = [
  { key: 'mail', icon: 'mail', label: 'Courrier' },
  { key: 'chat', icon: 'chat', label: 'Équipe' },
  { key: 'conf', icon: 'video', label: 'Conférence' },
  { key: 'calendar', icon: 'calendar', label: 'Calendrier' },
  { key: 'contacts', icon: 'users', label: 'Contacts' },
  { key: 'tasks', icon: 'tasks', label: 'Tâches' },
  { key: 'board', icon: 'board', label: 'Tableau' },
  { key: 'pipelines', icon: 'flow', label: 'Pipelines' },
  { key: 'notes', icon: 'notes', label: 'Notes' },
  { key: 'assistant', icon: 'comet', label: 'Assistant IA' },
  { key: 'vault', icon: 'lock', label: 'Coffre-fort' },
  { key: 'admin', icon: 'sliders', label: 'Administration', adminOnly: true },
  // Modules du mode Gestion
];

// Rail du mode « Gestion » (plateforme de pilotage) — séparé du mode habituel.
export const GESTION_GROUPS = [
  { id: 'pilotage', label: 'Pilotage', keys: ['dashboard', 'reports', 'okr'] },
  { id: 'projets', label: 'Projets', keys: ['projects', 'pipelines', 'time'] },
  { id: 'gouvernance', label: 'Gouvernance', keys: ['protools', 'admin'] },
];

// Regroupement des modules par catégorie pour alléger le rail latéral.
// Chaque groupe liste des clés de MODULES (l'ordre d'affichage suit ces clés).
export const MODULE_GROUPS = [
  { id: 'comm', label: 'Communication', keys: ['mail', 'chat', 'conf'] },
  { id: 'org', label: 'Organisation', keys: ['calendar', 'tasks', 'board', 'pipelines', 'notes'] },
  { id: 'people', label: 'Personnes', keys: ['contacts'] },
  { id: 'tools', label: 'Outils', keys: ['assistant', 'vault'] },
  { id: 'admin', label: 'Administration', keys: ['admin'] },
];

export const initials = (name = '') =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?';

export const PRESENCE = {
  available: { color: '#16a34a', label: 'Disponible' },
  busy: { color: '#e11d48', label: 'Occupé' },
  away: { color: '#f59e0b', label: 'Absent' },
};

export function Avatar({ name, color, size = 36, presence }) {
  const inner = (
    <div className="avatar" style={{ width: size, height: size, background: color || 'var(--accent)', fontSize: size * 0.38 }}>
      {initials(name)}
    </div>
  );
  if (!presence || !PRESENCE[presence]) return inner;
  return (
    <div className="avatar-wrap" style={{ width: size, height: size }}>
      {inner}
      <span className="presence-dot" style={{ background: PRESENCE[presence].color, width: Math.max(8, size * 0.28), height: Math.max(8, size * 0.28) }} />
    </div>
  );
}
