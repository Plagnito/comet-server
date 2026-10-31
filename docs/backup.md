# Backing up and restoring a Comet server

## What is saved

`node scripts/sauvegarde.mjs <empty-folder>` writes:

- `comet.db`: a consistent copy of the database made by SQLite itself (`VACUUM INTO`),
  including writes still in the write-ahead log. It works while the server is running.
  Copying the `.db` file by hand can give an incomplete or corrupt database.
- `pieces-jointes/`: encrypted attachments kept by the server for offline recipients
  (`COMET_ATTACHMENTS_DIR`, by default `server/data/attachments`, even when
  `COMET_DATA_DIR` moves the database).
- `pieces-externes/`: attachments of mail received from outside, when the server
  receives any (`COMET_PJ_DIR`).
- `manifeste.json`: date, commit, size and SHA-256 of every file.

The script reads the same settings as the server (`COMET_DB_PATH`, `COMET_DATA_DIR`,
`COMET_ATTACHMENTS_DIR`, `COMET_PJ_DIR`): run it with the server's environment.

## What is NOT saved: the secrets

`server/.env` (or your container's environment) holds `JWT_SECRET` and
`COMET_MAIL_SECRET`. Keep them **separately and safely**. Without the same values, the
passwords of linked mail accounts and the federation identity key, which are sealed in the
database, can no longer be read; sessions are also invalidated by a new `JWT_SECRET`.
End-to-end encrypted content does not depend on these secrets: it can only be read with
each user's password, as before.

The download cache and the one-time installation code are not saved either: the first is
rebuilt on demand, the second is only useful before the first administrator exists.

## Restoring

1. Stop the server.
2. Put back `server/.env` with the original secrets.
3. `node scripts/restauration.mjs <backup-folder>`

The restore checks every file against the manifest first and refuses a backup that was
altered or is incomplete, before writing anything. It refuses to run while a Comet server
answers on its port (`--port`, default `PORT` or 4800), and refuses to overwrite existing
data unless you add `--remplacer`.

## Scheduling

Daily backup at 3 a.m. with cron, keeping 14 days:

```bash
0 3 * * * cd /srv/comet && node scripts/sauvegarde.mjs /srv/sauvegardes/comet-$(date +\%F) && find /srv/sauvegardes -maxdepth 1 -name 'comet-*' -mtime +14 -exec rm -rf {} +
```

Copy backups to another machine as well: a backup on the same disk does not survive the
loss of that disk. Test a restore from time to time on a spare machine.
