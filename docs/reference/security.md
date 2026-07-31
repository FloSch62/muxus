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

New vaults default to **Never**, using the platform credential store. The vault works as
follows:

- a random 256-bit vault key encrypts each password with AES-256-GCM and a fresh nonce;
- the master password is processed with scrypt (`N=131072`, `r=8`, `p=1`, and a random
  128-bit salt) to wrap the vault key in the database;
- **Never** stores the raw vault key in Windows Credential Manager, macOS Keychain, or
  Linux Secret Service/kernel keyring;
- **When Muxus starts** keeps the unwrapped key only in process memory after one prompt;
- **Whenever a saved credential is needed** unwraps the key for one operation and then
  clears it;
- revealing or editing a saved value and changing the master password always require the
  master password;
- changing the master password re-wraps the random vault key without decrypting and
  rewriting every saved password;
- the master password itself is never stored. It cannot be recovered; resetting the vault
  deliberately requires no master password and deletes every saved password.

There is no application-owned key file. A copied database does not contain a directly
usable vault key and can be unlocked only with the master password. On Linux, **Never**
requires an available OS keyring implementation; desktop environments commonly provide
one through GNOME Keyring, KWallet or another Secret Service-compatible daemon. Muxus does
not fall back to a plaintext or application-owned key file.

!!! warning "Never-prompt use changes the threat model"

    Software running as the same logged-in user may be able to ask the OS credential store
    for the vault key. The master password protects the normal **view and edit** interface;
    it is not a defence against malware controlling the user session or Muxus itself.
    Choose a prompt policy that matches the local-account threat model.

Vault keys are cleared from process memory at shutdown and after each operation under the
per-credential policy. JavaScript strings cannot be reliably erased, so a password may
remain in garbage-collected memory for an unspecified short period after use. Malware
controlling the logged-in session or Muxus can capture credentials while they are used.

Deleting a credential enables SQLite secure deletion, checkpoints and truncates the WAL.
Deleting the whole vault additionally compacts the active database and attempts to remove
its OS credential-store entry. Reset still completes if the credential store is
unavailable, because the orphaned random key has no ciphertext or vault metadata to open.
An existing backup paired with an entry that could not be removed may still be usable;
backups, filesystem snapshots, storage-device remapping and forensic copies are outside
the deletion guarantee.

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

## Terminal clipboard access

Terminal programs may replace the system clipboard through OSC 52 when **Allow terminal
clipboard writes** is enabled in Terminal settings. It is enabled by default for tmux,
Zellij and editor compatibility, and can be disabled at any time. OSC 52 clipboard reads
are always blocked: a local or remote terminal program receives an empty value instead of
the clipboard contents.

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
  password**. A master password protects viewing and editing, and the configured prompt
  policy controls routine SSH use.
- It does not run as a service or accept connections from other machines.

## Reporting a problem

Report security issues privately through the
[repository's security advisories](https://github.com/FloSch62/muxus/security/advisories).
