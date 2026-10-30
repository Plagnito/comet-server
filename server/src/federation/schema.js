// Fédération — tables et colonnes. Importé une fois (par le service) ; idempotent.
import { db } from '../db.js';

db.exec(`
  -- Clé d'identité de CE serveur (Ed25519). Une seule ligne active ; les anciennes sont
  -- gardées pour signer une rotation et tracer l'historique.
  CREATE TABLE IF NOT EXISTS federation_identite (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    cle_publique   TEXT NOT NULL,          -- SPKI DER, base64
    cle_privee     TEXT NOT NULL,          -- PKCS8 DER scellé (services/seal.js)
    rotation       TEXT,                   -- JSON { ancienne, date, signature } si née d'une rotation
    active         INTEGER NOT NULL DEFAULT 1,
    creee_le       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Serveurs distants connus : la clé mémorisée au premier contact (TOFU) et leur état.
  --   actif        : échanges admis
  --   bloque       : refusé par l'admin
  --   cle_changee  : la clé publiée a changé SANS rotation signée → tout est refusé
  --                  jusqu'à ce que l'admin compare l'empreinte et accepte cle_proposee.
  CREATE TABLE IF NOT EXISTS federation_pairs (
    domaine        TEXT PRIMARY KEY,
    cle            TEXT NOT NULL,
    api            TEXT NOT NULL,
    etat           TEXT NOT NULL DEFAULT 'actif',
    cle_proposee   TEXT,
    note           TEXT,
    vu_premier     TEXT NOT NULL DEFAULT (datetime('now')),
    vu_dernier     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Anti-rejeu : nonces déjà acceptés, par serveur émetteur, gardés quelques minutes.
  CREATE TABLE IF NOT EXISTS federation_nonces (
    emetteur  TEXT NOT NULL,
    nonce     TEXT NOT NULL,
    expire    INTEGER NOT NULL,            -- ms epoch
    PRIMARY KEY (emetteur, nonce)
  );

  -- File d'envoi vers les serveurs distants (un envoi = un message × un domaine).
  CREATE TABLE IF NOT EXISTS federation_envois (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id     INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    expediteur_id  INTEGER NOT NULL,
    domaine        TEXT NOT NULL,
    charge         TEXT NOT NULL,          -- corps JSON de la livraison (déjà chiffré)
    etat           TEXT NOT NULL DEFAULT 'attente',  -- attente | livre | echec
    tentatives     INTEGER NOT NULL DEFAULT 0,
    prochain_essai INTEGER NOT NULL,       -- ms epoch
    derniere_erreur TEXT,
    cree_le        INTEGER NOT NULL        -- ms epoch
  );
  CREATE INDEX IF NOT EXISTS idx_federation_envois_attente ON federation_envois(etat, prochain_essai);
`);

const colonnes = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
function assurerColonne(table, col, ddl) {
  if (!colonnes(table).has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

// Correspondant DISTANT : une ligne `users` qui représente « dominique@serveur-b.fr ».
// Elle permet de répondre, trier, filtrer comme avec un collègue. Jamais de connexion
// (hash de mot de passe impossible + refus explicite), jamais dans l'annuaire (listed=0).
assurerColonne('users', 'distant_domaine', 'TEXT');
// Dernier changement de la clé d'un correspondant distant (avertissement côté client).
assurerColonne('users', 'cle_changee_le', 'TEXT');
// En-tête d'un message reçu d'un autre serveur : liste complète À/Cc telle qu'annoncée
// par l'expéditeur (affichage seulement — seuls les destinataires LOCAUX sont des lignes
// `recipients`, pour qu'un serveur distant ne puisse pas fabriquer des comptes ailleurs).
assurerColonne('messages', 'fed_entete', 'TEXT');
