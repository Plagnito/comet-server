// Où le serveur Comet range ses données, avec EXACTEMENT les mêmes règles que lui
// (server/src/db.js, server/src/services/attachment-storage.js, piecesjointes.js).
// Partagé par scripts/sauvegarde.mjs et scripts/restauration.mjs.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVEUR = join(dirname(fileURLToPath(import.meta.url)), '..', 'server');

export function emplacements(env = process.env) {
  const dossierDonnees = env.COMET_DATA_DIR || join(SERVEUR, 'data');
  return {
    base: env.COMET_DB_PATH || join(dossierDonnees, 'comet.db'),
    // Les pièces jointes chiffrées gardent leur dossier historique, même si COMET_DATA_DIR
    // déplace la base (voir attachment-storage.js).
    piecesJointes: env.COMET_ATTACHMENTS_DIR || join(SERVEUR, 'data', 'attachments'),
    // Pièces jointes du courrier reçu de l'extérieur, quand cette édition en reçoit.
    piecesExternes: env.COMET_PJ_DIR || join(dossierDonnees, 'pj'),
  };
}
