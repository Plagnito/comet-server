# Comet security model

What end-to-end encryption protects in Comet, what it does not, and the cryptographic
decisions that are deliberately left open. Written for administrators and for anyone
deciding whether Comet fits their threat model.

## The short version

- The server stores and carries encrypted mail, team chat and the password vault **without
  being able to read them**. Keys are generated and used in the browser or the desktop app.
- The server **distributes public keys**, and the "From" line of a message between accounts
  is **asserted by a server**, not signed by the sender. Comparing the safety number with
  your correspondent is what turns "the server says this is Dominique's key" into a
  verified fact.
- Account keys are **static**: someone who later obtains an account's private key can read
  that account's past encrypted mail that is still stored. There is no forward secrecy yet.

## Keys and encryption

| Item | Algorithm | Where the secret lives |
|---|---|---|
| Account key pair | RSA-OAEP 2048, SHA-256 | Generated in the browser. The private key is stored on the server **wrapped** by a key derived from the password (PBKDF2-SHA-256, 250 000 iterations, then AES-GCM). |
| Message | AES-256-GCM, fresh key per message | The message key is wrapped with RSA-OAEP for each reader. |
| Team channel | AES-256-GCM channel key | Wrapped for each member. |
| Shared mailbox | Its own RSA key pair, private key under an AES "box key" | Box key wrapped for each member. |
| Server identity (federation) | Ed25519 | On the server, sealed with the server secret. |

After sign-in, the session token and the unlocked private key are kept **in memory only**:
reloading or closing the window requires signing in again.

## Authenticity of keys and senders (audit finding C-21)

**What a malicious or compromised server could do.** A Comet server hands out the public
keys of its own accounts. It could give you *its* key instead of a colleague's, read what
you send, and re-encrypt it for the real recipient. It could also show a message as coming
from one of its accounts: messages are encrypted *to* the recipient, and anyone can encrypt
to a public key; they are not signed *by* the sender.

**What limits it today.**

- **Safety number.** On a message from another Comet account, "Safety number" shows
  60 digits computed from both addresses and both public keys (SHA-512 iterated). Both
  people see the same number only if neither server swapped a key. This works between
  accounts of the **same server** as well as across servers. Compare it out loud or over
  another channel, then mark the correspondent as verified on your device; the mark is tied
  to that exact key, so a later key change clears it.
- **Federation.** A key coming from another server is vouched for by that server's Ed25519
  signature, which **your app** verifies; your own server relays it but cannot forge it.
  Your device remembers each remote server's key and accepts a new one only through a chain
  of rotations, each signed by the previous key (see below).
- **Between servers,** every request is signed by the sending server, so a third party
  cannot impersonate a server. The sending server itself remains trusted for the "From"
  line of its own accounts.

**Decision.** Sender signatures are **not implemented yet**. The planned design is a
per-account Ed25519 signing key published next to the encryption key, a signature placed
*inside* the encrypted payload, verification on the recipient's device, and a safety number
covering both keys. It needs a key-distribution change and a migration for existing
accounts, and is tracked as future work. Until then, treat the "From" line as asserted by
the server, and compare safety numbers before trusting a correspondent with anything
sensitive.

## Forward secrecy (audit finding C-22)

**The limit.** Account keys do not change on their own. Whoever later obtains an account's
private key — from an unlocked device, or from the server database plus the account
password, since the wrapped key can be attacked offline — can decrypt that account's
encrypted mail **still stored** on the server, past and future.

**What limits it today.**

- A strong password: the wrapped private key is only as strong as the password.
- Disappearing and burn-after-reading messages reduce what is kept.
- "Replace the key and erase my mail" (Settings, Security) creates a new key pair and
  deletes the account's encrypted mail.
- Shared mailboxes rotate their keys when a member is removed: the former member cannot
  read anything that arrives afterwards, but keeps what they already read.

**Decision.** Forward secrecy is **not implemented**. Protocols that provide it (X3DH and
the Double Ratchet, or MLS, RFC 9420, for groups) assume devices that keep per-conversation
state and exchange messages interactively. Comet mail is store-and-forward, an account
signs in from any browser with its password, and team channels and shared mailboxes share
keys between members. The realistic paths are MLS for team chat and shared mailboxes, and
periodic rotation of account keys for mail (a new key pair at intervals, old private keys
erased after a retention period), which bounds what a single stolen key exposes. Neither is
built yet.

## Team channels

A channel key is shared by all members and does not change. Members cannot be removed from
a channel yet; anyone who was a member keeps the key and can read the channel's messages.

## Federation: server key rotation

A server's identity key can be rotated by its administrator. Each rotation is signed by the
previous key, and the server publishes the **whole chain** in `/.well-known/comet`. A peer
that remembers an older key accepts the new one only if it can follow signed steps from the
key it knows; it keeps the proofs it accepted and passes them to devices together with the
keys of that server's accounts, so a device that remembered an older key verifies the path
itself. A key that changes **without** such a chain pauses exchanges with that server until
an administrator compares fingerprints. Protocol details (in French):
[`server/src/federation/PROTOCOLE.md`](../server/src/federation/PROTOCOLE.md).

## What is visible to the server

Who writes to whom, when, and the size of messages; which channels exist and who is in
them; presence and free/busy for people you work with. Notes, contacts, calendar events,
tasks, boards and pipelines are **not** end-to-end encrypted: they are stored in clear text.
