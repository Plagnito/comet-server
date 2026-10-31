# Dependency vulnerabilities

State after the October 2026 audit (finding C-28). `npm audit` runs in the **Tests**
workflow for `server/` and `client/` and fails the run on any high or critical
vulnerability in production dependencies.

## Server and client: none left

`npm audit fix` (non-breaking updates) cleared the server and client, except
**nodemailer**, which needed a major version: it moved from 9 to **10.1.x** (`~10.1.7`).
Version 10 only drops Node.js below 20 (Comet requires Node 22.5 or newer). The upgrade
fixes, among others, a process-wide DNS cache that could reuse one SMTP account's TLS
server name for another account's connection — relevant for a server that sends mail on
behalf of several linked accounts — and several remote denial-of-service and
address-parsing issues. The newest release (10.3.x) was two days old at the time; 10.1.7
already contains every listed fix.

## Desktop app (repository root): what remains, and why

| Package | Severity | Path | Shipped in the app? | Why it stays |
|---|---|---|---|---|
| `minimatch`, `glob`, `rimraf`, `temp`, `jake`, `filelist`, `ejs`, `dir-compare`, `@electron/asar`, `@electron/universal`, `app-builder-lib`, `dmg-builder`, `electron-winstaller`, `electron-builder-squirrel-windows`, `electron-builder` | moderate | `electron-builder` (dev dependency) | **No** — build tools that produce the installers | The only "fix" npm offers is a downgrade to electron-builder 20, which is years old and would break the build. Exposure is limited to building the app, from this repository's own files. |
| `ip` (via `bittorrent-tracker`, `torrent-discovery`, `webtorrent`) | high | `webtorrent` (large-file transfers) | The package is, the vulnerable code path is not | The advisory concerns `ip.isPublic()`. `bittorrent-tracker` uses `ip` only in its **tracker server** code (`lib/server/parse-udp.js`); Comet runs the torrent **client** only. The offered fix is a downgrade of webtorrent to 0.7.3 (2014). Re-check when webtorrent drops `ip`. |

Electron itself moved from 42.5 to 42.11 (same major version) with the non-breaking fixes.

## Keeping it that way

- After any dependency change, check that `npm ci --dry-run` reports nothing in
  `server/`, `client/` and the root: the workflow installs with `npm ci`, which refuses an
  incomplete lock file (the production server uses `npm install`, which repairs it
  silently, so a broken lock file does not show there).
- Do not run `npm audit fix --force`: it downgrades the desktop build tools.
