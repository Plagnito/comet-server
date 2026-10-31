import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import bcrypt from 'bcryptjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Emplacement de la base configurable (isolation des tests / data dir personnalisé) :
// COMET_DB_PATH = chemin complet du fichier ; sinon COMET_DATA_DIR ; sinon ../data.
const dataDir = process.env.COMET_DATA_DIR || join(__dirname, '..', 'data');
const dbPath = process.env.COMET_DB_PATH || join(dataDir, 'comet.db');
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    email           TEXT UNIQUE NOT NULL,
    display_name    TEXT NOT NULL,
    password_hash   TEXT NOT NULL,
    avatar_color    TEXT NOT NULL DEFAULT '#4f46e5',
    is_system       INTEGER NOT NULL DEFAULT 0,
    public_key      TEXT,
    enc_private_key TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id    TEXT NOT NULL,
    sender_id    INTEGER NOT NULL REFERENCES users(id),
    subject      TEXT NOT NULL DEFAULT '',
    body         TEXT NOT NULL DEFAULT '',
    in_reply_to  INTEGER REFERENCES messages(id),
    is_sent      INTEGER NOT NULL DEFAULT 1,
    is_encrypted INTEGER NOT NULL DEFAULT 0,
    ciphertext   TEXT,
    iv           TEXT,
    expires_at      TEXT,
    burn_after_read INTEGER NOT NULL DEFAULT 0,
    sent_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS recipients (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    kind       TEXT NOT NULL DEFAULT 'to'
  );

  CREATE TABLE IF NOT EXISTS mail_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    folder     TEXT NOT NULL DEFAULT 'inbox',
    is_read    INTEGER NOT NULL DEFAULT 0,
    is_starred INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Clé symétrique du message, chiffrée pour chaque lecteur avec SA clé publique (E2EE)
  CREATE TABLE IF NOT EXISTS message_keys (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    enc_key    TEXT NOT NULL,
    UNIQUE(message_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS templates (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    subject    TEXT NOT NULL DEFAULT '',
    body       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    group_email TEXT UNIQUE NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS group_members (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id  INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(group_id, member_id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_agent TEXT NOT NULL DEFAULT '',
    ip         TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS aliases (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    alias_email TEXT UNIQUE NOT NULL,
    label       TEXT NOT NULL DEFAULT '',
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Repli serveur des pièces jointes quand le destinataire est hors ligne.
  -- Le serveur ne stocke que du chiffré opaque (la clé reste dans le message E2EE).
  CREATE TABLE IF NOT EXISTS attachments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_id  TEXT NOT NULL,
    recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename     TEXT NOT NULL DEFAULT '',
    mimetype     TEXT NOT NULL DEFAULT 'application/octet-stream',
    size         INTEGER NOT NULL DEFAULT 0,
    iv           TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(transfer_id, recipient_id)
  );

  CREATE TABLE IF NOT EXISTS vault_entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ciphertext TEXT NOT NULL,
    iv         TEXT NOT NULL,
    enc_key    TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Messagerie d'équipe (chat). Chiffré : clé de canal AES enveloppée par membre ;
  -- messages = ciphertext opaque pour le serveur.
  CREATE TABLE IF NOT EXISTS channels (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS channel_members (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    enc_key    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(channel_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    sender_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ciphertext TEXT NOT NULL,
    iv         TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_chat_channel ON chat_messages(channel_id, id);

  -- Boîtes aux lettres partagées : la « boîte » est un compte users (is_box=1) sans
  -- mot de passe ; sa clé privée (enc_private_key) est chiffrée sous la clé de boîte AES.
  -- Cette table distribue la clé de boîte, enveloppée (RSA) pour chaque membre.
  CREATE TABLE IF NOT EXISTS shared_mailbox_members (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    box_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    enc_key    TEXT NOT NULL,                          -- clé de boîte enveloppée pour ce membre
    role       TEXT NOT NULL DEFAULT 'member',         -- 'owner' | 'member'
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(box_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_shared_members ON shared_mailbox_members(user_id);

  -- « Compte de reçu » : règles de routage d'une boîte partagée. Le serveur ne voit
  -- que l'expéditeur (métadonnée) → il ASSIGNE le message entrant à un membre cible
  -- (qui lit dans la boîte via la clé de boîte). 100% E2EE : aucun contenu déchiffré.
  CREATE TABLE IF NOT EXISTS box_routes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    box_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    match_from  TEXT NOT NULL,                          -- email exact, « @domaine », ou « * » (tout)
    assignee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    enabled     INTEGER NOT NULL DEFAULT 1,
    sort        INTEGER NOT NULL DEFAULT 0,             -- ordre d'évaluation (1ère règle qui matche gagne)
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_box_routes ON box_routes(box_id, sort, id);

  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    location    TEXT NOT NULL DEFAULT '',
    starts_at   TEXT NOT NULL,
    ends_at     TEXT NOT NULL,
    all_day     INTEGER NOT NULL DEFAULT 0,
    color       TEXT NOT NULL DEFAULT '#4f46e5',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Salles de réunion (ressources réservables, gérées par un admin)
  CREATE TABLE IF NOT EXISTS rooms (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    location   TEXT NOT NULL DEFAULT '',
    capacity   INTEGER NOT NULL DEFAULT 0,
    color      TEXT NOT NULL DEFAULT '#0d9488',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Exceptions par occurrence (récurrence) : annuler/modifier une seule répétition.
  CREATE TABLE IF NOT EXISTS event_exceptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    occ_date    TEXT NOT NULL,            -- date d'origine de l'occurrence ciblée (YYYY-MM-DD)
    cancelled   INTEGER NOT NULL DEFAULT 0,
    title       TEXT, description TEXT, location TEXT,
    starts_at   TEXT, ends_at TEXT, color TEXT,
    UNIQUE(event_id, occ_date)
  );

  CREATE TABLE IF NOT EXISTS event_invites (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status   TEXT NOT NULL DEFAULT 'pending',
    UNIQUE(event_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL DEFAULT '',
    phone      TEXT NOT NULL DEFAULT '',
    company    TEXT NOT NULL DEFAULT '',
    notes      TEXT NOT NULL DEFAULT '',
    favorite   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    notes      TEXT NOT NULL DEFAULT '',
    due_at     TEXT,
    completed  INTEGER NOT NULL DEFAULT 0,
    priority   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS board_cards (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'todo',
    sort       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL DEFAULT '',
    body       TEXT NOT NULL DEFAULT '',
    color      TEXT NOT NULL DEFAULT '#fff3b0',
    pinned     INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Pipelines de projet : étapes (JSON) + projets positionnés sur une étape
  CREATE TABLE IF NOT EXISTS pipelines (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    stages      TEXT NOT NULL DEFAULT '[]',
    created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS pipeline_projects (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    pipeline_id    INTEGER NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
    title          TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    stage_index    INTEGER NOT NULL DEFAULT 0,
    responsable_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    color          TEXT NOT NULL DEFAULT '#4f46e5',
    created_by     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_pipeline_projects ON pipeline_projects(pipeline_id, stage_index);

  -- Règles de courrier (filtres). E2EE oblige : on ne matche que sur l'expéditeur
  -- (métadonnée visible du serveur) ; le contenu reste chiffré.
  CREATE TABLE IF NOT EXISTS mail_rules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    match_from  TEXT NOT NULL,                 -- email exact ou domaine « @exemple.com »
    action_folder TEXT,                         -- 'archive' | 'trash' | NULL (laisser en boîte)
    action_star INTEGER NOT NULL DEFAULT 0,
    action_read INTEGER NOT NULL DEFAULT 0,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_mail_rules_user ON mail_rules(user_id);

  -- Réglages clé/valeur (config du connecteur, stockage partagé, etc.)
  CREATE TABLE IF NOT EXISTS settings (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL DEFAULT ''
  );

  -- Assistant IA via le connecteur (file de travaux). Comet met en file, le
  -- connecteur récupère, appelle l'IA locale de l'org, puis renvoie la réponse.
  -- Désactivé par défaut (réglage ai_enabled). L'IA tourne CHEZ l'organisation.
  CREATE TABLE IF NOT EXISTS ai_jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    prompt      TEXT NOT NULL,
    answer      TEXT,
    status      TEXT NOT NULL DEFAULT 'pending',  -- pending | claimed | done | error
    error       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    claimed_at  TEXT,
    answered_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ai_jobs_status ON ai_jobs(status, id);
  CREATE INDEX IF NOT EXISTS idx_ai_jobs_user ON ai_jobs(user_id, id);

  -- Comptes mail EXTERNES (IMAP/SMTP). Voie totalement séparée du courrier interne
  -- E2EE : ces messages ne sont PAS chiffrés de bout en bout (impossible côté externe).
  -- Le mot de passe est scellé par une clé serveur (chiffré au repos).
  CREATE TABLE IF NOT EXISTS mail_accounts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    label       TEXT NOT NULL DEFAULT '',
    imap_host   TEXT NOT NULL,
    imap_port   INTEGER NOT NULL DEFAULT 993,
    smtp_host   TEXT NOT NULL,
    smtp_port   INTEGER NOT NULL DEFAULT 465,
    username    TEXT NOT NULL,
    sealed_pass TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    last_uid    INTEGER NOT NULL DEFAULT 0,
    last_sync   TEXT,
    last_error  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS ext_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id  INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
    direction   TEXT NOT NULL DEFAULT 'in',         -- 'in' | 'out'
    uid         INTEGER,                              -- UID IMAP (entrants)
    message_id  TEXT,
    from_addr   TEXT NOT NULL DEFAULT '',
    from_name   TEXT NOT NULL DEFAULT '',
    to_addr     TEXT NOT NULL DEFAULT '',
    subject     TEXT NOT NULL DEFAULT '',
    body_text   TEXT NOT NULL DEFAULT '',
    body_html   TEXT NOT NULL DEFAULT '',
    date        TEXT,
    folder      TEXT NOT NULL DEFAULT 'inbox',        -- 'inbox' | 'sent'
    is_read     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(account_id, uid)
  );
  CREATE INDEX IF NOT EXISTS idx_ext_messages ON ext_messages(account_id, folder, id);

  -- Extension navigateur : capture de mots de passe → coffre (zéro-knowledge).
  -- L'extension chiffre vers la clé publique de l'utilisateur ; le serveur ne voit
  -- que du chiffré et se contente de déplacer les entrées en attente vers le coffre.
  CREATE TABLE IF NOT EXISTS vault_pending (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ciphertext TEXT NOT NULL,
    iv         TEXT NOT NULL,
    enc_key    TEXT NOT NULL,
    host       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS extension_pairings (
    code_hash  TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS extension_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_mail_items_user_folder ON mail_items(user_id, folder);
  CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
  CREATE INDEX IF NOT EXISTS idx_recipients_message ON recipients(message_id);
  CREATE INDEX IF NOT EXISTS idx_message_keys ON message_keys(message_id, user_id);
  CREATE INDEX IF NOT EXISTS idx_events_owner ON events(owner_id, starts_at);
`);

// File d'attente d'envoi SMTP (« outbox ») : découple la requête HTTP de l'envoi
// réel. POST /accounts/:id/send écrit ici et rend la main tout de suite ; un worker
// draine la file via un transport SMTP poolé, avec retries à back-off. Voir
// services/outbox.js. (mail_accounts / users existent déjà → FK valides.)
db.exec(`
  CREATE TABLE IF NOT EXISTS mail_outbox (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id   INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    payload      TEXT NOT NULL,                       -- JSON { to, cc, subject, text, html, inReplyTo }
    status       TEXT NOT NULL DEFAULT 'pending',     -- pending | sent | failed
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT,
    next_attempt TEXT,                                -- ISO ; NULL = dès que possible
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_outbox_pending ON mail_outbox(status, next_attempt);
`);

// ── Remise directe : le serveur oublie un message dès que les appareils l'ont ──
// Voir services/remisedirecte.js pour le pourquoi et les limites exactes.
// Attention : pas de caractère accent-grave dans ces commentaires SQL, il fermerait
// le littéral gabarit JavaScript qui les entoure.
db.exec(`
  CREATE TABLE IF NOT EXISTS appareils (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cle        TEXT NOT NULL,                 -- identifiant stable fourni par l'appareil
    nom        TEXT NOT NULL DEFAULT '',
    plateforme TEXT NOT NULL DEFAULT '',
    vu_a       TEXT NOT NULL DEFAULT (datetime('now')),
    cree_a     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, cle)
  );

  -- Un accuse de reception attendu, par (message, appareil). La ligne disparait
  -- avec le message : c'est ce qui garantit qu'aucune trace ne survit a la purge.
  CREATE TABLE IF NOT EXISTS remises (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id     INTEGER NOT NULL REFERENCES mail_items(id) ON DELETE CASCADE,
    appareil_id INTEGER NOT NULL REFERENCES appareils(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cree_a      TEXT NOT NULL DEFAULT (datetime('now')),
    recu_a      TEXT,
    UNIQUE(item_id, appareil_id)
  );
  CREATE INDEX IF NOT EXISTS idx_remises_attente ON remises(user_id, recu_a);

  -- Pièces jointes du courrier venu du DEHORS.
  --
  -- À ne pas confondre avec la table "attachments" ci-dessus, qui est le repli chiffré
  -- d'un transfert entre deux comptes Comet. Ici les octets arrivent en clair du réseau
  -- (ils l'ont déjà traversé), et ils sont conservés parce qu'un courrier dont on ne
  -- garde que le nom des pièces jointes n'est pas un courrier reçu.
  --
  -- Les octets vivent dans des FICHIERS ("data/pj/<message>/<index>"), pas dans SQLite :
  -- une base qui grossit de 20 Mo par message rend chaque sauvegarde et chaque "VACUUM"
  -- proportionnels au poids des pièces jointes, pour une donnée qu'on ne lit qu'entière.
  --
  -- "etat" : 'attendue'  métadonnées connues, octets pas encore reçus
  --          'presente'  le fichier est là
  --          'absente'   la source ne l'avait pas (trop vieux, ou jamais incluse)
  --          'refusee'   le quota de la boîte était atteint : rien n'a été écrit
  CREATE TABLE IF NOT EXISTS mail_attachments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    idx         INTEGER NOT NULL,
    filename    TEXT NOT NULL DEFAULT 'piece-jointe',
    mimetype    TEXT NOT NULL DEFAULT 'application/octet-stream',
    size        INTEGER NOT NULL DEFAULT 0,
    etat        TEXT NOT NULL DEFAULT 'attendue',
    source_id   TEXT,
    chemin      TEXT,
    essais      INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(message_id, idx)
  );
  CREATE INDEX IF NOT EXISTS idx_pj_attendues ON mail_attachments(etat, essais);
`);

// ── Migrations idempotentes pour bases existantes ───────────────────────────
function ensureColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
ensureColumn('users', 'can_pipelines', 'INTEGER NOT NULL DEFAULT 0');
// Horodatage de PRISE en charge d'un travail IA (distinct de sa création) : sans lui,
// la remise en file des travaux bloqués se déclenchait sur l'âge du travail et le
// connecteur pouvait retraiter un travail qu'il était encore en train de traiter.
ensureColumn('ai_jobs', 'claimed_at', 'TEXT');
ensureColumn('messages', 'scheduled_at', 'TEXT');
ensureColumn('mail_items', 'snoozed_until', 'TEXT');
ensureColumn('mail_items', 'assigned_to', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'); // compte de reçu : membre assigné
ensureColumn('tasks', 'recurrence', 'TEXT');
ensureColumn('tasks', 'parent_id', 'INTEGER');
ensureColumn('contacts', 'labels', 'TEXT');
ensureColumn('events', 'reminder_minutes', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('events', 'reminder_sent', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('events', 'is_conference', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('events', 'room_id', 'INTEGER REFERENCES rooms(id) ON DELETE SET NULL');
ensureColumn('events', 'recurrence', 'TEXT');
ensureColumn('events', 'recurrence_until', 'TEXT');
ensureColumn('events', 'room_announced', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'public_key', 'TEXT');
ensureColumn('users', 'enc_private_key', 'TEXT');
ensureColumn('users', 'totp_secret', 'TEXT');
ensureColumn('users', 'pending_totp_secret', 'TEXT');
ensureColumn('users', 'pending_totp_until', 'INTEGER');
ensureColumn('users', 'auth_version', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'recovery_codes', 'TEXT');
ensureColumn('users', 'signature', 'TEXT');
ensureColumn('users', 'away_enabled', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'away_message', 'TEXT');
ensureColumn('users', 'away_until', 'TEXT');
ensureColumn('users', 'presence', "TEXT NOT NULL DEFAULT 'available'");
ensureColumn('users', 'job_title', 'TEXT');
ensureColumn('users', 'department', 'TEXT');
ensureColumn('users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'is_box', 'INTEGER NOT NULL DEFAULT 0'); // compte = boîte partagée
// Rotation des clés d'une boîte partagée au retrait d'un membre : version des clés
// (verrou optimiste contre un ajout de membre concurrent) et anciennes clés privées de
// la boîte, chiffrées sous la clé de boîte ACTUELLE (JSON, la plus récente d'abord) pour
// que les membres restants lisent encore l'historique.
ensureColumn('users', 'box_key_version', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('users', 'box_old_keys', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('users', 'listed', 'INTEGER NOT NULL DEFAULT 1'); // annuaire : comptes existants listés ; nouveaux comptes = 0 (opt-in)
// Remise directe : DÉSACTIVÉE par défaut, et ce défaut compte. Une fois active, il
// n'existe plus aucune copie en ligne du courrier reçu — c'est un choix que
// l'utilisateur doit poser lui-même, en connaissance de la contrepartie.
ensureColumn('users', 'remise_directe', 'INTEGER NOT NULL DEFAULT 0');
// Organisation : un utilisateur Comet appartient à 0 ou 1 organisation.
// Sans org : Comet personnel uniquement (annuaire/partage d'org masqués).
ensureColumn('users', 'org_id', 'INTEGER');     // id d'organisation (NULL = sans org)
ensureColumn('users', 'org_name', 'TEXT');      // nom de l'org (affichage)
ensureColumn('users', 'org_role', 'TEXT');      // 'manager' | 'member'
// Présence d'un VRAI mot de passe choisi par l'utilisateur. Compte créé sans mot de
// passe choisi → mot de passe aléatoire inconnu (password_set=0) : on lui
// propose d'EN DÉFINIR un (active aussi le chiffrement E2EE). Comptes existants = 1.
ensureColumn('users', 'password_set', 'INTEGER NOT NULL DEFAULT 1');
// Adresse provisoire : compte créé sans adresse Comet choisie → l'email
// est temporaire et l'utilisateur doit en choisir un (identité unifiée). 0 = définitif.
ensureColumn('users', 'email_provisional', 'INTEGER NOT NULL DEFAULT 0');
// Adresses e-mail PRO par organisation : <user>@<org>.mail, gérées par le responsable.
// Implémentées comme des ALIAS Comet (alias_email → owner_id) ; on marque l'alias avec
// l'org (aliases.org_id) pour les lister/retirer. Le domaine pro de chaque org :
ensureColumn('aliases', 'org_id', 'INTEGER'); // alias provisionné par une org (NULL = perso)
db.exec(`
  CREATE TABLE IF NOT EXISTS org_mail_domains (
    org_id     INTEGER PRIMARY KEY,
    domain     TEXT UNIQUE NOT NULL,           -- ex. « acme.mail »
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_aliases_org ON aliases(org_id);
`);
// Invitations à rejoindre une ORGANISATION.
db.exec(`
  CREATE TABLE IF NOT EXISTS org_invites (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id            INTEGER NOT NULL,
    org_name          TEXT NOT NULL DEFAULT '',
    inviter_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    inviter_player_id INTEGER,
    invitee_email     TEXT NOT NULL,
    invitee_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
    token             TEXT NOT NULL UNIQUE,
    role              TEXT NOT NULL DEFAULT 'member',
    status            TEXT NOT NULL DEFAULT 'pending',
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_orginvites_invitee ON org_invites(invitee_id, status);
  CREATE INDEX IF NOT EXISTS idx_orginvites_org ON org_invites(org_id, status);
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);');
// ── Boîtes AGENT d'organisation (<id>@agent.mail) ───────────────────────────
// Des boîtes de dépôt pour du courrier de MACHINE (alertes GitHub, accusés, dossiers
// client mis de côté) qu'un programme relève ensuite sur un poste. Trois choix portent
// la sécurité de tout le dispositif :
//
//  • l'identifiant est une suite de 20 CHIFFRES tirés au hasard, et il EST l'adresse
//    publique (<id>@<domaine>). Personne ne devine une boîte agent, et aucun nom
//    lisible n'entre en concurrence avec les adresses des comptes Comet ;
//  • la boîte est un compte `users` ordinaire avec is_box = 1 et un mot de passe vide
//    (comme les boîtes partagées) : on ne peut PAS s'y connecter, seul le relais
//    entrant y dépose et seule la clé de collecte en sort ;
//  • ce courrier n'est PAS chiffré de bout en bout — il ne peut pas l'être, il arrive
//    en clair du réseau et le programme qui le relève n'a aucune clé. Le dire est la
//    condition pour que la loi E2EE-COMPUTE reste vraie ailleurs.
//
// La CLÉ DE COLLECTE est par organisation et n'est stockée que hachée : la perdre
// oblige à en poser une neuve, ce qui est le comportement voulu.
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_mailboxes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id      INTEGER NOT NULL,
    agent_id    TEXT NOT NULL UNIQUE,          -- 20 chiffres, = la partie locale publique
    box_user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    label       TEXT NOT NULL DEFAULT '',
    active      INTEGER NOT NULL DEFAULT 1,
    created_by  INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_agent_mailboxes_org ON agent_mailboxes(org_id);

  CREATE TABLE IF NOT EXISTS agent_mail_keys (
    org_id     INTEGER PRIMARY KEY,
    key_hash   TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen  TEXT
  );
`);

ensureColumn('channels', 'is_dm', 'INTEGER NOT NULL DEFAULT 0'); // canal = message direct 1-à-1
ensureColumn('channels', 'dm_pair', 'TEXT'); // paire canonique 'minId-maxId' pour dédupliquer les DM
// Canal d'ÉQUIPE rattaché à une organisation. kind = 'general' → le canal « Général »
// par défaut de l'org : UN SEUL par organisation (index unique partiel = garde-fou de
// l'idempotence, même si deux clients le créent en même temps). Le serveur ne crée
// JAMAIS ce canal lui-même : la clé AES du canal naît côté client (E2EE), cf. routes/chat.js.
ensureColumn('channels', 'org_id', 'INTEGER');
ensureColumn('channels', 'kind', "TEXT NOT NULL DEFAULT 'channel'"); // 'channel' | 'general'
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_general ON channels(org_id) WHERE kind = 'general';");
db.exec('CREATE INDEX IF NOT EXISTS idx_channels_org ON channels(org_id);');

// ── Mode Gestion : espaces de projet, OKR, suivi du temps ───────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color       TEXT NOT NULL DEFAULT '#4f46e5',
    status      TEXT NOT NULL DEFAULT 'active',
    owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS objectives (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    period     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS key_results (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    objective_id INTEGER NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    progress     INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS time_entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    label      TEXT NOT NULL DEFAULT '',
    minutes    INTEGER NOT NULL DEFAULT 0,
    day        TEXT NOT NULL DEFAULT (date('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
ensureColumn('tasks', 'project_id', 'INTEGER REFERENCES projects(id) ON DELETE SET NULL'); // tâche rattachée à un espace de projet
// Espaces de projet & OKR rattachés à une ORGANISATION (identité unifiée) : un
// utilisateur sans org n'a ni projets ni OKR partagés. Scopé par org dans gestion.js.
ensureColumn('projects', 'org_id', 'INTEGER');
ensureColumn('objectives', 'org_id', 'INTEGER');
db.exec('CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id); CREATE INDEX IF NOT EXISTS idx_objectives_org ON objectives(org_id);');
// Pipelines rattachés à une ORGANISATION : tout le monde peut en créer, mais un
// pipeline reste dans l'org où il a été créé (org_id NULL = perso au créateur, sans
// org). Backfill unique : les pipelines existants (globaux) sont rattachés à l'org
// courante de leur créateur pour rester visibles côté org après migration.
ensureColumn('pipelines', 'org_id', 'INTEGER');
db.exec('CREATE INDEX IF NOT EXISTS idx_pipelines_org ON pipelines(org_id);');
db.exec("UPDATE pipelines SET org_id = (SELECT u.org_id FROM users u WHERE u.id = pipelines.created_by) WHERE org_id IS NULL AND EXISTS (SELECT 1 FROM users u WHERE u.id = pipelines.created_by AND u.org_id IS NOT NULL)");
// Comptes mail externes : OAuth2 (Gmail/Outlook) en plus du mot de passe d'application
ensureColumn('mail_accounts', 'provider', "TEXT NOT NULL DEFAULT 'imap'"); // 'imap' | 'gmail' | 'outlook'
ensureColumn('mail_accounts', 'oauth_refresh', 'TEXT'); // jeton de rafraîchissement (scellé)
ensureColumn('mail_accounts', 'oauth_access', 'TEXT');   // jeton d'accès courant (scellé)
ensureColumn('mail_accounts', 'oauth_expiry', 'TEXT');   // expiration du jeton d'accès (UTC)
ensureColumn('tasks', 'assignee_id', 'INTEGER REFERENCES users(id)');
ensureColumn('messages', 'is_encrypted', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('messages', 'ciphertext', 'TEXT');
ensureColumn('messages', 'iv', 'TEXT');
ensureColumn('messages', 'expires_at', 'TEXT');
ensureColumn('messages', 'burn_after_read', 'INTEGER NOT NULL DEFAULT 0');
// Adresse d'émission choisie (alias / adresse pro <user>@<org>.mail). NULL = email
// principal du compte. Affichée comme « De » chez le destinataire. Voir routes/mail.js.
ensureColumn('messages', 'from_email', 'TEXT');

// ── Courrier EXTERNE livré dans la boîte native (passerelle entrante) ────────
// Un message venu du dehors (passerelle entrante → boîte native) n'a PAS de compte
// Comet derrière lui, alors que `messages.sender_id` est NOT NULL et référence `users`.
// On l'ancre donc sur un compte technique — le « facteur » — et on porte la vraie
// identité de l'expéditeur ici : `from_email` (déjà en place) pour l'adresse,
// `ext_from_name` pour le nom affiché. Sans ce second champ, toute la boîte afficherait
// « Facteur » et l'admin ne pourrait pas balayer sa liste du regard.
ensureColumn('messages', 'ext_from_name', 'TEXT');
// HTML D'ORIGINE du courrier externe, conservé TEL QUEL. La passerelle en dégrade déjà
// une version texte dans `body` (c'est elle qu'on affiche par défaut, et la seule que la
// recherche indexe) ; sans cette colonne, la mise en forme et les images étaient perdues
// à l'arrivée, définitivement — un message illustré arrivait comme un pavé de texte.
//
// ⚠️ Ce champ contient du HTML VENU DU DEHORS : il n'est ni nettoyé ni interprété ici.
// Tout client qui l'affiche doit le rendre ISOLÉ, sans exécution de script et sans
// chargement de ressource distante tant que le lecteur ne l'a pas demandé — c'est ce qui
// neutralise les pixels espions. Le servir à un client qui l'injecte tel quel dans sa
// page serait un XSS offert à quiconque sait écrire un e-mail.
ensureColumn('messages', 'body_html', 'TEXT');
// Message-ID d'origine. La passerelle peut RÉESSAYER (Comet redémarré, réseau coupé) :
// sans garde, un même courrier se livrerait plusieurs fois. L'index unique PARTIEL
// (uniquement sur les valeurs non NULL) laisse tout le courrier interne intact.
ensureColumn('messages', 'ext_message_id', 'TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_ext_msgid ON messages(ext_message_id) WHERE ext_message_id IS NOT NULL');

// ── Journal des changements de boîte (synchronisation d'un client hors ligne) ──
//
// Un client de bureau qui garde un cache local doit pouvoir demander « qu'est-ce qui a
// changé depuis la dernière fois ? ». `mail_items` ne permettait pas d'y répondre : il
// n'a qu'un `id` auto-incrémenté et un `created_at`. Une synchro fondée là-dessus voit
// les NOUVEAUX messages et rate TOUS les changements d'état — un message lu sur le web
// resterait non lu dans l'application, sans erreur, indéfiniment.
//
// Trois raisons de tenir un journal plutôt que d'ajouter un simple `updated_at` :
//
//   1. `datetime('now')` a une résolution à la SECONDE. Deux modifications dans la même
//      seconde, et un curseur temporel en rate une — silencieusement.
//   2. Un `updated_at` ne capture pas les SUPPRESSIONS : une ligne effacée n'a plus de
//      colonne à lire, donc le cache local garderait un message disparu pour toujours.
//   3. `AUTOINCREMENT` garantit une séquence STRICTEMENT croissante. Sans lui, SQLite
//      réutilise les identifiants libérés et un curseur peut sauter des changements.
//
// Le journal reste petit : `compacterJournalMail()` ne garde que le dernier changement
// par élément (voir plus bas).
db.exec(`
  CREATE TABLE IF NOT EXISTS mail_changes (
    seq     INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    kind    TEXT NOT NULL,
    at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_mail_changes_user_seq ON mail_changes(user_id, seq);
  CREATE INDEX IF NOT EXISTS idx_mail_changes_item     ON mail_changes(item_id);

  -- Déclencheurs plutôt qu'écritures dans le code : mail_items est modifié depuis une
  -- dizaine d'endroits (règles de tri, report, boîtes partagées, assignation…). Un
  -- journal alimenté à la main y laisserait forcément un trou, et un trou de journal
  -- ne se voit pas — il se traduit par un cache client qui dérive en silence.
  CREATE TRIGGER IF NOT EXISTS trg_mail_items_insere AFTER INSERT ON mail_items
  BEGIN
    INSERT INTO mail_changes (item_id, user_id, kind) VALUES (NEW.id, NEW.user_id, 'upsert');
  END;

  CREATE TRIGGER IF NOT EXISTS trg_mail_items_modifie AFTER UPDATE ON mail_items
  BEGIN
    INSERT INTO mail_changes (item_id, user_id, kind) VALUES (NEW.id, NEW.user_id, 'upsert');
  END;

  CREATE TRIGGER IF NOT EXISTS trg_mail_items_supprime AFTER DELETE ON mail_items
  BEGIN
    INSERT INTO mail_changes (item_id, user_id, kind) VALUES (OLD.id, OLD.user_id, 'delete');
  END;
`);

// Ne conserver que le DERNIER changement par élément. Sûr sans seuil de
// resynchronisation : un client au curseur C veut les éléments dont le dernier
// changement est postérieur à C — les états intermédiaires ne lui apprennent rien.
export function compacterJournalMail() {
  const avant = db.prepare('SELECT COUNT(*) AS n FROM mail_changes').get().n;
  db.exec(`
    DELETE FROM mail_changes
     WHERE seq NOT IN (SELECT MAX(seq) FROM mail_changes GROUP BY item_id);
  `);
  const apres = db.prepare('SELECT COUNT(*) AS n FROM mail_changes').get().n;
  return { avant, apres };
}

// ── Index sur les colonnes chaudes (idempotent ; après toutes les migrations) ──
// Complète les index déclarés dans le schéma initial. Cible les filtres/jointures
// fréquents non encore couverts : listes par propriétaire, jointures mail, cascades.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sessions_user        ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_messages_sender      ON messages(sender_id);
  CREATE INDEX IF NOT EXISTS idx_recipients_user      ON recipients(user_id);
  CREATE INDEX IF NOT EXISTS idx_mail_items_message   ON mail_items(message_id);
  CREATE INDEX IF NOT EXISTS idx_message_keys_user    ON message_keys(user_id);
  CREATE INDEX IF NOT EXISTS idx_mail_accounts_user   ON mail_accounts(user_id);
  CREATE INDEX IF NOT EXISTS idx_event_invites_user   ON event_invites(user_id);
  CREATE INDEX IF NOT EXISTS idx_contacts_owner       ON contacts(owner_id);
  CREATE INDEX IF NOT EXISTS idx_notes_owner          ON notes(owner_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_owner          ON tasks(owner_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_assignee       ON tasks(assignee_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_parent         ON tasks(parent_id);
  CREATE INDEX IF NOT EXISTS idx_vault_owner          ON vault_entries(owner_id);
  CREATE INDEX IF NOT EXISTS idx_aliases_owner        ON aliases(owner_id);
  CREATE INDEX IF NOT EXISTS idx_templates_owner      ON templates(owner_id);
  CREATE INDEX IF NOT EXISTS idx_groups_owner         ON groups(owner_id);
  CREATE INDEX IF NOT EXISTS idx_board_owner          ON board_cards(owner_id);
  CREATE INDEX IF NOT EXISTS idx_objectives_owner     ON objectives(owner_id);
  CREATE INDEX IF NOT EXISTS idx_time_entries_user    ON time_entries(user_id);
  CREATE INDEX IF NOT EXISTS idx_time_entries_project ON time_entries(project_id);
`);

// Bascule du domaine historique @comet.local → @comet.mail (adresse sûre, app-only)
db.exec("UPDATE users SET email = replace(email, '@comet.local', '@comet.mail') WHERE email LIKE '%@comet.local'");

// ── Seed : système + comptes de démo ────────────────────────────────────────
function ensureUser({ email, name, password, color, system = 0 }) {
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (existing) return existing;
  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare('INSERT INTO users (email, display_name, password_hash, avatar_color, is_system) VALUES (?, ?, ?, ?, ?)')
    .run(email, name, hash, color, system);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

export const SYSTEM_EMAIL = 'equipe@comet.mail';
// Compte technique d'ancrage du courrier venu du dehors (cf. ext_from_name plus haut).
// Volontairement DISTINCT de l'équipe Comet : un e-mail externe ne doit jamais avoir
// l'air d'un message officiel de l'app. Il n'est le « De » de personne — l'affichage
// montre l'expéditeur réel (nom + adresse) porté par le message.
export const INBOUND_SENDER_EMAIL = 'facteur@comet.mail';

export function seed() {
  ensureUser({ email: SYSTEM_EMAIL, name: 'Équipe Comet', password: Math.random().toString(36).slice(2), color: '#7c3aed', system: 1 });
  ensureUser({ email: INBOUND_SENDER_EMAIL, name: 'Courrier externe', password: Math.random().toString(36).slice(2), color: '#64748b', system: 1 });
  // Comptes de démo (« entreprise par défaut ») : DÉSACTIVÉS — chaque utilisateur
  // arrive sans org (Comet personnel), et ne voit des collègues qu'après avoir
  // rejoint une organisation. Réactivables pour une démo via COMET_SEED_DEMO=1.
  if (process.env.COMET_SEED_DEMO === '1') {
    ensureUser({ email: 'lea@comet.mail', name: 'Léa Martin', password: 'comet1234', color: '#db2777' });
    ensureUser({ email: 'marc@comet.mail', name: 'Marc Dubois', password: 'comet1234', color: '#0d9488' });
    ensureUser({ email: 'sophie@comet.mail', name: 'Sophie Bernard', password: 'comet1234', color: '#ea580c' });
  }
}

seed();

// Les inscriptions ne prouvent pas la possession d'une adresse. Ne jamais
// attribuer un rôle au redémarrage à partir du seul COMET_ADMIN_EMAIL.
// L'installation authentifiée est effectuée par routes/auth.js.

// Purge périodique : messages éphémères expirés (cascade vers mail_items/recipients/
// message_keys), codes d'appairage d'extension expirés, et jetons d'extension
// inactifs depuis > 90 jours (rotation forcée des jetons oubliés).
export function purgeExpired() {
  const changes = db.prepare("DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')").run().changes;
  db.prepare("DELETE FROM extension_pairings WHERE expires_at <= datetime('now')").run();
  db.prepare("DELETE FROM extension_tokens WHERE COALESCE(last_seen, created_at) <= datetime('now', '-90 days')").run();
  return changes;
}
