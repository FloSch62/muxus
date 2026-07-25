---
icon: lucide/shield-check
---

# Security model

Muxus is a **local single-user tool**. It runs on your machine, uses credentials you
already have, and sends nothing anywhere else. This page states exactly what that means,
so you can check it rather than take it on faith.

## The boundary

- The server binds **`127.0.0.1` only**. There is no configuration that makes it listen
  anywhere else.
- **Every `/api` request needs the per-run bearer token**, a random value minted at
  startup. The one exception is a native file-drag download, which uses a short-lived,
  path-bound ticket issued inside an already-authenticated SFTP listing.
- **WebSocket upgrades check both the token and the `Origin`** header: only pages served
  from `127.0.0.1`/`localhost` (or non-browser clients with no `Origin` at all) may open a
  terminal socket. That is the DNS-rebinding defence.
- Responses carry a strict **Content-Security-Policy** (`default-src 'self'`,
  `frame-ancestors 'none'`, no `object-src`, no `form-action`), plus `X-Frame-Options`,
  `nosniff`, `no-referrer` and a `Permissions-Policy` that leaves only same-origin
  clipboard access.

## Bootstrap credentials never travel in a URL

| Client | How it gets the token |
| --- | --- |
| Browser | In the URL **fragment**, which browsers never send to servers; the client removes it from the address bar immediately |
| Desktop app | An isolated **preload bridge** — the renderer never sees a URL containing it |
| Terminal sockets | A **WebSocket subprotocol**, not a query parameter |

`?token=…` is deliberately *not* accepted for terminal sockets: query strings end up in
logs and history.

## What is stored, and what is refused

The local SQLite database holds folders, colours, display names, sidebar order, workspaces,
saved tunnels, saved Telnet/serial hosts, per-host highlighting and logging policy, and
connection timestamps. It is created `0600` in a `0700` directory.

**Credential material is rejected at the persistence boundary.** Any object whose field
names include `password`, `passphrase`, `secret`, `token` or `privateKey` is refused before
it can be written — a field may hold a *reference* (`identityFile`, `credentialId`), never
the secret itself. Passwords and passphrases exist only for the duration of an
authentication attempt, in memory.

Your connection settings are not in the database at all: they stay in your
[`~/.ssh/config`](ssh-config.md).

## Host keys

Verification uses your real `~/.ssh/known_hosts` and the read-only
`/etc/ssh/ssh_known_hosts`, hashed entries included — the same files, the same rules as
OpenSSH:

- an unknown host prompts with its fingerprint, and accepting **appends** to
  `known_hosts`;
- a changed key produces the loud warning, and accepting performs the `ssh-keygen -R`-style
  replacement.

Config edits are atomic and leave a `.muxus.bak` of the previous contents.

## Session logging

Off unless you turn it on. When enabled:

- **remote output** is recorded;
- **your input is not**, unless input capture is explicitly enabled for that session;
- logging can be paused and resumed mid-session.

!!! warning "Echoed commands are still remote output"

    A command you type comes back from the remote as output, so it lands in the log even
    with input capture off. **Pause logging before displaying secrets.**

Retention is bounded by a quota with a free-space reserve, and exhausted storage suspends
logging rather than filling your disk. See
[session history](../guide/session-history.md).

## Telnet and serial

Telnet provides **no encryption and no server authentication** — everything, including
what you type at a login prompt, crosses the network in the clear. Use it only on a network
you trust. Serial is a local device; access is governed by your operating system's
permissions (group membership on Linux).

## The desktop shell

The Electron build embeds the server in-process, uses context isolation with a narrow
preload bridge, and blocks unexpected navigation. There is no remote content: everything
the window loads is served from the local server.

## What Muxus does not do

- It does not phone home, check for updates in the background, or collect telemetry.
- It does not proxy your traffic through anything.
- It does not store your passwords "for convenience".
- It does not run as a service or accept connections from other machines.

## Reporting a problem

Security issues are best reported privately through the
[repository's security advisories](https://github.com/FloSch62/muxus/security/advisories).
