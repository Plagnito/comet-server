import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BAC_A_SABLE, avecExpediteur, documentCourriel, estExpediteurDeConfiance,
  normaliserExpediteur, phraseImagesBloquees, ressourcesDistantes, sansExpediteur,
} from '../mailhtml.js';
import Icon from './Icon.jsx';

// « Charger les images automatiquement » — désactivé par défaut, et ce défaut est le
// cœur du dispositif : un courrier commercial porte souvent une image invisible d'un
// pixel qui, chargée, apprend à son expéditeur que le message a été ouvert, quand, et
// combien de fois. Le réglage vit dans le navigateur (il ne regarde que cet appareil).
const IMAGES_AUTO = 'comet.mail.imagesAuto';
export const imagesAutoActif = () => localStorage.getItem(IMAGES_AUTO) === '1';
export const setImagesAuto = (v) => (v ? localStorage.setItem(IMAGES_AUTO, '1') : localStorage.removeItem(IMAGES_AUTO));

// Les expéditeurs dont on affiche les images sans redemander. Entre « tout bloquer » et
// « tout charger », c'est le réglage qui manquait : on garde la protection face aux
// inconnus tout en cessant d'interroger le lecteur sur la lettre qu'il attend chaque
// semaine. Même portée que le réglage global : ce navigateur, et lui seul.
const EXPEDITEURS = 'comet.mail.expediteursImages';
export function expediteursDeConfiance() {
  try { const l = JSON.parse(localStorage.getItem(EXPEDITEURS) || '[]'); return Array.isArray(l) ? l : []; }
  catch { return []; }
}
const ecrire = (l) => { try { localStorage.setItem(EXPEDITEURS, JSON.stringify(l)); } catch { /* stockage refusé */ } return l; };
export const faireConfiance = (email) => ecrire(avecExpediteur(expediteursDeConfiance(), email));
export const retirerConfiance = (email) => ecrire(sansExpediteur(expediteursDeConfiance(), email));

// Les couleurs du thème courant, à injecter dans le document : le cadre d'affichage a sa
// propre feuille de style et n'hérite d'aucune variable CSS de la page hôte.
function couleursDuTheme() {
  try {
    const s = getComputedStyle(document.documentElement);
    const v = (n, def) => (s.getPropertyValue(n) || '').trim() || def;
    return { fond: v('--surface', '#ffffff'), texte: v('--text-2', '#334155'), lien: v('--accent', '#4f46e5') };
  } catch { return {}; }
}

/**
 * Affiche le HTML d'un courrier **sans trahir son lecteur**.
 *
 * Trois verrous, les mêmes que la visionneuse de Comet Entreprise et celle de Comet Mail
 * Android :
 *
 *  1. **aucun script** — le cadre est en bac à sable SANS `allow-scripts`, doublé d'une
 *     politique de sécurité `script-src 'none'` posée dans le document. Deux verrous
 *     indépendants pour une règle dont la panne est invisible, ce n'est pas de trop ;
 *  2. **aucune sortie réseau** avant un oui explicite — et après ce oui, uniquement vers
 *     les origines qui ont été NOMMÉES dans le bandeau ;
 *  3. **aucune navigation** — les liens s'ouvrent dans un onglet ordinaire, qui montre
 *     l'adresse où l'on va.
 *
 * @param cle identifiant du message. Elle réinitialise le consentement : un « oui » donné
 *   sur un message ne doit jamais valoir pour le suivant, qui peut venir de n'importe qui.
 *   La SEULE exception est explicite : un expéditeur que le lecteur a désigné.
 * @param expediteur adresse affichée en « De ». Sans elle, le bouton « toujours pour cet
 *   expéditeur » n'apparaît pas — on ne propose pas de faire confiance à personne.
 */
export default function MailHtmlView({ html, cle, expediteur }) {
  const cadre = useRef(null);
  const [autorise, setAutorise] = useState(false);
  const [hauteur, setHauteur] = useState(0);
  // `null` tant qu'on n'a pas essayé de mesurer ; `false` si le navigateur nous refuse
  // l'accès au document (le cadre défile alors lui-même — dégradation, pas panne).
  const [mesurable, setMesurable] = useState(true);

  const { hotes, origines } = useMemo(() => ressourcesDistantes(html), [html]);

  const adresse = normaliserExpediteur(expediteur);

  // Consentement remis à zéro à CHAQUE message. Deux choses seulement le pré-accordent,
  // et ce sont deux décisions que le lecteur a prises lui-même : le réglage global, ou
  // cet expéditeur-là inscrit dans sa liste.
  useEffect(() => {
    setAutorise(imagesAutoActif() || estExpediteurDeConfiance(expediteursDeConfiance(), adresse));
    setHauteur(0);
  }, [cle, html, adresse]);

  // Le thème est lu à chaque rendu : l'application redessine son arbre quand il change,
  // ce qui suffit à reconstruire le document avec les bonnes couleurs.
  const theme = typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') || 'light' : 'light';
  const doc = useMemo(
    () => documentCourriel(html, { origines: autorise ? origines : [], couleurs: couleursDuTheme() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [html, autorise, origines, theme],
  );

  // Sans script dans le document, sa hauteur ne peut être mesurée que d'ici. C'est la
  // seule raison d'être de `allow-same-origin` : sans elle, on lirait un courrier par un
  // hublot à défilement imbriqué.
  const mesurer = useCallback(() => {
    const f = cadre.current;
    if (!f) return;
    try {
      const d = f.contentDocument;
      if (!d || !d.body) return;
      const h = Math.max(d.body.scrollHeight || 0, d.documentElement ? d.documentElement.scrollHeight : 0);
      if (h > 0) setHauteur(h);
    } catch { setMesurable(false); }
  }, []);

  // Une image qui arrive (après un « oui ») change la hauteur du document : sans cet
  // observateur, le message resterait coupé à la taille qu'il avait sans ses images.
  useEffect(() => {
    const f = cadre.current;
    if (!f) return undefined;
    let obs = null;
    const brancher = () => {
      mesurer();
      try {
        const d = f.contentDocument;
        if (!d || !d.body || typeof ResizeObserver === 'undefined') return;
        obs = new ResizeObserver(() => mesurer());
        obs.observe(d.body);
      } catch { setMesurable(false); }
    };
    f.addEventListener('load', brancher);
    brancher();
    return () => { f.removeEventListener('load', brancher); if (obs) obs.disconnect(); };
  }, [doc, mesurer]);

  const bloque = hotes.length > 0 && !autorise;

  return (
    <div className="mail-html-wrap">
      {bloque && (
        <div className="remote-banner">
          <Icon name="shield" size={15} />
          <span className="txt">{phraseImagesBloquees(hotes)}</span>
          <button className="btn subtle" onClick={() => setAutorise(true)}>Afficher les images</button>
          {adresse && (
            <button
              className="btn subtle"
              title={`Les images de ${adresse} s'afficheront sans vous redemander, sur cet appareil. Réversible dans Paramètres → Confidentialité.`}
              onClick={() => { faireConfiance(adresse); setAutorise(true); }}
            >
              Toujours afficher les images de cet expéditeur
            </button>
          )}
        </div>
      )}
      <iframe
        ref={cadre}
        className="mail-html"
        title="Contenu du message"
        sandbox={BAC_A_SABLE}
        referrerPolicy="no-referrer"
        srcDoc={doc}
        onLoad={mesurer}
        style={mesurable && hauteur > 0 ? { height: hauteur + 'px' } : { height: '60vh' }}
      />
    </div>
  );
}
