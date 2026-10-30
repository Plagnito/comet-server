// Configuration & validation des secrets serveur.
// Source unique de vérité pour JWT_SECRET : valide au démarrage et refuse de
// démarrer en production si le secret est absent, par défaut ou trop faible.
// Faire tourner les sessions = changer JWT_SECRET (tous les jetons émis deviennent
// invalides puisqu'ils ne se vérifient plus).

import { randomBytes } from 'node:crypto';

const PROD = process.env.NODE_ENV === 'production';

// Valeurs interdites : anciens défauts codés en dur et placeholders du .env.example.
const FORBIDDEN_SECRETS = new Set([
  'comet-dev-secret-change-me',
  'CHANGEZ-MOI-secret-long-et-aleatoire',
  'changeme',
  'secret',
]);

const MIN_LEN = 32;

function resolveJwtSecret() {
  const raw = process.env.JWT_SECRET;

  const tooShort = !raw || raw.trim().length < MIN_LEN;
  const forbidden = raw && FORBIDDEN_SECRETS.has(raw.trim());

  if (tooShort || forbidden) {
    const reason = !raw
      ? 'JWT_SECRET est absent'
      : forbidden
        ? 'JWT_SECRET utilise une valeur par défaut/prévisible'
        : `JWT_SECRET est trop court (< ${MIN_LEN} caractères)`;

    const help =
      `\n\n  ✦ Sécurité : ${reason}.\n` +
      `  Générez un secret fort puis placez-le dans server/.env :\n` +
      `      node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"\n` +
      `      JWT_SECRET=<le secret généré>\n` +
      `  ⚠️  Changer JWT_SECRET déconnecte toutes les sessions existantes (rotation).\n` +
      `      Pour préserver le déchiffrement des mots de passe des comptes mail externes,\n` +
      `      fixez COMET_MAIL_SECRET à l'ANCIEN JWT_SECRET avant de changer ce dernier.\n`;

    if (PROD) {
      // En production : on refuse catégoriquement de démarrer.
      throw new Error(`Démarrage refusé.${help}`);
    }
    // Hors production : on tolère mais on AVERTIT bruyamment, et on n'utilise jamais
    // un secret prévisible — on en génère un éphémère (sessions non persistées au reboot).
    console.warn(`\x1b[33m[config] AVERTISSEMENT${help}\x1b[0m`);
    const ephemeral = randomBytes(48).toString('hex');
    console.warn('\x1b[33m[config] Secret éphémère généré pour cette session de dev uniquement.\x1b[0m');
    return ephemeral;
  }

  return raw.trim();
}

export const JWT_SECRET = resolveJwtSecret();
export const JWT_EXPIRE = process.env.JWT_EXPIRE || '30d';

// Inscription libre (e-mail + mot de passe) : COMET_INSCRIPTION=ouverte | fermee.
// Fermée, seuls les comptes déjà existants (ou créés autrement) peuvent se connecter.
export const INSCRIPTION_OUVERTE = (process.env.COMET_INSCRIPTION || 'ouverte') === 'ouverte';

// Clé de scellement des identifiants mail au repos. Dérive de COMET_MAIL_SECRET
// si fournie, sinon de JWT_SECRET (validé ci-dessus). Plus de fallback prévisible.
export const MAIL_SECRET = process.env.COMET_MAIL_SECRET || JWT_SECRET;
