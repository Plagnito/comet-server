# Attachment storage limits

Both binary upload routes share storage admission and quotas. The default maximum
upload is 1 GiB (the encrypted fallback also keeps its former 80 MiB ceiling).
The defaults allow 5 GiB per sender, 20 GiB in total, two active uploads per sender
and eight in total. An upload has a ten minute absolute deadline. The server checks
actual stream bytes; `X-Size` is display metadata, not a storage allowance.

See the `COMET_UPLOAD_*` settings in `server/.env.example`. Values must be finite,
safe positive integers; the free disk margin alone may be zero. Defaults preserve
256 MiB of free space at admission. These application limits cannot reserve disk
space against other programs; deploy filesystem quotas and monitor free space too.
Torrent metadata, SQLite and logs need space in addition to the blob quotas.

An upload without `Content-Length` reserves its maximum possible size until it
finishes. Concurrent reservations count toward both quotas. Completed transfers
are charged their actual stored bytes. Responses use 413 for size/quota refusal,
429 for concurrent upload limits, 408 for the deadline and 507 for insufficient
free space. The composer displays upload errors instead of sending a broken fallback.

Transfer IDs must contain 1–128 ASCII letters, digits, underscores or hyphens.
They are never rewritten. Both upload routes use the same namespace. A duplicate
returns 409 and never replaces an existing blob or adds recipients to it. Published
IDs remain consumed after removal so an old capability URL cannot be reassigned to
new content. A fresh upload needs a fresh random ID. Failed uploads can be retried
once their partial file and reservation have been cleaned up.
The composer generates fresh IDs for a new send attempt, including after a message
submission failed, so a retry does not need to overwrite a previous upload.

## Download counts and expiry

`maxDownloads` counts completed full HTTP responses. Range responses (206) and
peer-to-peer BitTorrent transfers are outside that counter. It is not a limit on
recipients or total copies. `/attachments/config` returns
`downloadLimitScope: "full-responses-only"`. Choose a finite retention time to
bound availability on this server; expired torrent, webseed and authenticated
downloads are refused even before the periodic disk cleanup. Data already copied
by recipients or peers cannot be revoked.

## Existing data and recovery

Back up the database and attachment directory together before upgrading. The
default directory remains `server/data/attachments`, including when the database
uses a custom location. Set `COMET_ATTACHMENTS_DIR` explicitly only after moving
the files; changing the database path alone does not relocate attachments. The
`attachment_storage` table is additive. At startup, existing blobs and orphaned
partial files count in the global quota using their actual on-disk lengths.
Existing large transfers retain their known sender; historical encrypted blobs
have no stored sender and count globally without invented ownership. Published
legacy blobs retain their filenames and torrent URLs. Existing invalid transfer
IDs are refused rather than aliased; inspect such data separately before migration.

On normal errors, disconnects and deadlines, the server removes its partial file
and releases its reservation. A failed deletion keeps storage charged. After a
process crash, an uncertain reservation remains charged and can block its ID or
an upload slot. This conservative behavior also avoids deleting another process's
active upload. For recovery, stop **all** processes using that database, take a
backup, reconcile incomplete rows with their `.bin.part`, `.bin` and `.torrent`
files, and remove only confirmed abandoned uploads before releasing the matching
incomplete reservations. Do not clear the entire ledger or delete published-ID
tombstones. Do not perform this maintenance against an active instance.

For rollback, retain the database and directory backup. Older code ignores the new
ledger and does not enforce these limits; rollback needs an explicit operational
decision. Never restore only the database while keeping unrelated blob files.
