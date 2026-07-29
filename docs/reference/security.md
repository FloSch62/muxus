---
icon: lucide/shield-check
---

# Security model

Muxus is a local single-user tool. It runs on the local machine, uses existing credentials,
and sends nothing elsewhere. This page states what that means in detail.

## The boundary

- The server binds **`127.0.0.1` only**. No configuration makes it listen elsewhere.
- **Every `/api` request requires the per-run bearer token**, a random value minted at
  startup. The one exception is a native file-drag download, which uses a short-lived,
  path-bound ticket issued inside an already-authenticated SFTP listing.
- **WebSocket upgrades check both the token and the `Origin`** header. Only pages served
  from `127.0.0.1`/`localhost`, or non-browser clients with no `Origin`, may open a
  terminal socket. This is the DNS-rebinding defence.
- Responses carry a strict **Content-Security-Policy** (`default-src 'self'`,
  `frame-ancestors 'none'`, no `object-src`, no `form-action`), plus `X-Frame-Options`,
  `nosniff`, `no-referrer` and a `Permissions-Policy` that leaves only same-origin
  clipboard access.

## Bootstrap credentials never travel in a URL

| Client | How it gets the token |
| --- | --- |
| Browser | In the URL **fragment**, which browsers never send to servers; the client removes it from the address bar immediately |
| Desktop app | An isolated **preload bridge**, so the renderer never sees a URL containing it |
| Terminal sockets | A **WebSocket subprotocol**, not a query parameter |

`?token=…` is not accepted for terminal sockets, because query strings are recorded in logs
and history.

## What is stored, and what is refused

The local SQLite database holds folders, colours, display names, sidebar order, workspaces,
saved tunnels, saved Telnet/serial hosts, per-host highlighting and logging policy,
connection timestamps, and—only when the user opts in—encrypted SSH passwords. It is
created `0600` in a `0700` directory.

**Credential material is rejected from ordinary profile, tunnel and workspace data.**
Objects whose field names include `password`, `passphrase`, `secret`, `token` or
`privateKey` are refused at those persistence boundaries. The dedicated password-vault
tables are the only place credential ciphertext can be written.

Connection settings are not in the database. They remain in
[`~/.ssh/config`](ssh-config.md).

## Password vault

Password saving is off until a vault is created. On a normal SSH password
prompt, **Remember this password** saves the password only after the server accepts it.
Private-key passphrases, keyboard-interactive answers and 2FA codes are never remembered.

The vault is platform-independent:

- a random 256-bit vault key encrypts each password with AES-256-GCM and a fresh nonce;
- a random local device key wraps the vault key so SSH connections can use saved passwords
  automatically, without a master-password prompt;
- the master password is processed with scrypt (`N=32768`, `r=8`, `p=1`, and a random
  128-bit salt) to create a second, independent wrap of the vault key;
- revealing or editing a saved value, changing the master password, or repairing a missing
  device-key association requires the master password;
- changing the master password re-wraps the random vault key without decrypting and
  rewriting every saved password;
- the master password itself is never stored. It cannot be recovered; resetting the vault
  deletes every saved password.

The device key is stored in `muxus-vault-device.key` beside the database. On Unix it is
created with mode `0600`; on Windows it inherits the protection of the user's application
data directory. A copied database **without** that companion file does not provide
automatic decryption and can be relinked only with the master password.

!!! warning "Automatic use changes the threat model"

    Someone who obtains the complete Muxus application-data directory—including both the
    database and device-key file—can decrypt saved passwords without the master password.
    The master password protects the normal **view and edit** interface; it is not a defence
    against full local-account or application-data compromise. Protect the operating-system
    account and disk accordingly.

Vault and device keys are cleared from process memory at shutdown. JavaScript strings
cannot be reliably erased, so a password may remain in garbage-collected memory for an
unspecified short period after use. Malware controlling the logged-in session or Muxus can
capture automatically used credentials.

The portable Muxus backup format deliberately excludes the vault and all password
ciphertext.

## Host keys

Verification uses `~/.ssh/known_hosts` and the read-only `/etc/ssh/ssh_known_hosts`, hashed
entries included, applying the same rules as OpenSSH:

- an unknown host prompts with its fingerprint, and accepting **appends** to
  `known_hosts`;
- a changed key produces a warning, and accepting performs the `ssh-keygen -R`-style
  replacement.

Config edits are atomic and leave a `.muxus.bak` of the previous contents.

## Session logging

Off unless enabled. When enabled:

- **remote output** is recorded;
- **input is not recorded**, unless input capture is explicitly enabled for that session;
- logging can be paused and resumed mid-session.

!!! warning "Echoed commands are still remote output"

    Typed text returns from the remote as output, so it is recorded even with input capture
    off. **Pause logging before displaying secrets.**

Retention is bounded by a quota with a free-space reserve, and exhausted storage suspends
logging rather than filling the disk. See
[session history](../guide/session-history.md).

## Telnet and serial

Telnet provides **no encryption and no server authentication**. All traffic, including what
is typed at a login prompt, crosses the network in the clear. Use it only on a trusted
network. Serial is a local device, and access is governed by operating system permissions,
which on Linux means group membership.

## The desktop shell

The Electron build embeds the server in-process, uses context isolation with a narrow
preload bridge, and blocks unexpected navigation. There is no remote content: everything
the window loads is served from the local server.

## What Muxus does not do

- It does not collect telemetry. Its only background request is a version check against
  the static `latest.json` on the Muxus documentation site; the request contains the
  installed version in its user agent and can only direct downloads to the Muxus GitHub
  releases page.
- It does not proxy traffic through anything.
- It does not store a password unless the user explicitly selects **Remember this
  password**. A master password protects viewing and editing; a local device key permits
  automatic SSH use.
- It does not run as a service or accept connections from other machines.

## Reporting a problem

Report security issues privately through the
[repository's security advisories](https://github.com/FloSch62/muxus/security/advisories).
