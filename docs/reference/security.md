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
saved tunnels, saved Telnet/serial hosts, per-host highlighting and logging policy, and
connection timestamps. It is created `0600` in a `0700` directory.

**Credential material is rejected at the persistence boundary.** Any object whose field
names include `password`, `passphrase`, `secret`, `token` or `privateKey` is refused before
it can be written. A field may hold a reference such as `identityFile` or `credentialId`,
but not the secret itself. Passwords and passphrases exist in memory only for the duration
of an authentication attempt.

Connection settings are not in the database. They remain in
[`~/.ssh/config`](ssh-config.md).

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
- It does not store passwords.
- It does not run as a service or accept connections from other machines.

## Reporting a problem

Report security issues privately through the
[repository's security advisories](https://github.com/FloSch62/muxus/security/advisories).
