# Initial administration and trusted proxies

A fresh server creates a random installation code in `server/data/.bootstrap_token`
(or the directory selected by `COMET_DATA_DIR`). The file is created exclusively
with owner-only POSIX permissions and preserved on restart. Alternatively provide
`COMET_BOOTSTRAP_TOKEN` explicitly as a strong random string of 32–256 characters.
An invalid existing file or explicit value stops startup rather than being replaced.

With Docker, an operator reads the code using:

```sh
docker compose exec comet cat /comet/server/data/.bootstrap_token
```

Open `http://localhost:4800` on the server and enter that code when creating the
first administrator. From another computer, use an SSH forward or an HTTPS reverse
proxy; Docker's published port is loopback-only by default. Do not put the code in
a URL, public message or shared log. The public options endpoint returns only a
flag indicating whether setup is required, never the code itself.

The role assignment and one-time setup marker are committed in one SQLite
transaction. Concurrent sign-ups cannot produce multiple first administrators.
After setup, ordinary registrations never gain administration, even if the last
administrator is later removed. Setup with the code is available when public
registrations are closed; afterward `COMET_INSCRIPTION=fermee` closes sign-ups.

Existing administrators are retained on upgrade and setup is marked complete.
`COMET_ADMIN_EMAIL` no longer promotes accounts on restart: a self-selected email
address is not proof of identity. An existing installation without an administrator
can create its first one using the local installation code. If administration is
lost after completed setup, recover a known administrator through a trusted local
administrative procedure or consistent backup; public sign-up does not reopen it.
Keep the database, secrets and attachments together in backups. A rollback to older
code loses these protections and requires an explicit operator decision.

## Reverse proxy configuration

`COMET_TRUST_PROXY` defaults to `false`. Supply a comma-separated list of immediate
proxy IP addresses or CIDRs, for example `127.0.0.1/32,::1/128` for a local host
proxy. `loopback` is also accepted. Inspect the actual peer address for your
deployment, especially with container networking. Do not assume the proxy's address
is the client's address or trust every client-facing network.

Hop counts (`1`) and universal trust (`true`, `/0`) are refused. Only a trusted
direct peer may provide `X-Forwarded-Host` for same-origin CORS. Express applies the
same trust configuration to client IPs and forwarded protocol; session records use
that resolved client IP instead of the raw forwarded header. Keep the backend port
restricted to the proxy whenever possible. `COMET_BASE_URL` remains the explicit
public URL for links and callbacks.

## Instance files and fatal errors

All of `server/data/` is excluded from Git, including `.jwt_secret`,
`.bootstrap_token`, database files and attachments. The existing Docker ignore also
excludes that directory. The runtime volume remains required for persistence.

An uncaught exception or unhandled promise rejection is logged and terminates with
exit code 1. Use the existing container restart policy or another supervisor for
recovery; the process does not continue serving requests in an uncertain state.
