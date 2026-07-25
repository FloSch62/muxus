---
icon: lucide/route
---

# Connecting

Muxus dials the way `ssh` does. This page is what actually happens between clicking a host
and getting a prompt — and what it asks you along the way.

## Resolution

Every connection starts by resolving the host through your OpenSSH configuration the way
`ssh` does it: sequential, first-obtained-wins lookup across every matching `Host` pattern
(wildcards and negations included) and every `Include`d file, accumulating `IdentityFile`,
`CertificateFile` and the `*Forward` directives. **Each hop resolves on its own**, so a
jump host uses its own key and its own user, exactly as it would from the command line.

`Match` blocks are the one deliberate omission — their conditions depend on runtime state
Muxus does not have, so their options are skipped rather than guessed at.

[Which keywords are honoured :octicons-arrow-right-24:](../reference/ssh-config.md)

## Host keys

Before any authentication, the server's key is checked against your real
`~/.ssh/known_hosts` — plus the read-only `/etc/ssh/ssh_known_hosts` — including hashed
entries.

<figure markdown="span">
  ![The host-key verification dialog](../assets/screenshots/host-key.png#only-light){ .shadow }
  ![The host-key verification dialog](../assets/screenshots/host-key-dark.png#only-dark){ .shadow }
  <figcaption>Trust on first use, with the fingerprint you can compare.</figcaption>
</figure>

- **Unknown host** — you get the fingerprint and a choice. Accepting appends the key to
  `~/.ssh/known_hosts`, so `ssh` on the command line trusts it too.
- **Changed key** — the loud warning, because that is what a changed key deserves.
  Accepting performs the `ssh-keygen -R`-style replacement of the old entry.

!!! danger "A changed key is not routine"

    If you did not just rebuild that host, stop and find out why the key changed before
    accepting.

## Authentication order

Inside one connection Muxus follows OpenSSH's order, and stops at the first method that
succeeds:

1. **Agent** — every identity in `SSH_AUTH_SOCK`.
2. **Certificates** — a `CertificateFile` together with its matching `IdentityFile`.
3. **Keys** — the `IdentityFile`s in the block, or the default `~/.ssh/id_*` set.
   Passphrase-protected keys prompt you; `IdentitiesOnly yes` is honoured.
4. **Keyboard-interactive** — 2FA codes, challenge/response.
5. **Password**, with retries.

<figure markdown="span">
  ![A keyboard-interactive prompt](../assets/screenshots/auth-prompt.png#only-light){ .shadow }
  ![A keyboard-interactive prompt](../assets/screenshots/auth-prompt-dark.png#only-dark){ .shadow }
  <figcaption>Every prompt says which hop is asking — vital in a jump chain.</figcaption>
</figure>

Passwords and passphrases are transient. They live only as long as the authentication
attempt, and the persistence layer refuses to store them at all — see the
[security model](../reference/security.md).

## Jump chains and ProxyCommand

`ProxyJump` chains — including nested and comma-separated ones — are dialled **hop by
hop**, each with its own resolution, host-key check and authentication. Cycles are
detected rather than dialled forever.

`ProxyCommand` is supported as a transport: Muxus runs the command and speaks SSH over its
stdin/stdout, which is how tools like `cloudflared access ssh` or a corporate
`ProxyCommand` wrapper keep working.

Forwards declared on the block (`LocalForward`, `RemoteForward`, `DynamicForward`) start
with the session, and `ForwardAgent` works when an agent is present.

## One connection, many sessions

Connections are **leased**. Splitting a pane, opening a second tab on the same host, the
file browser, the remote editor and an ad-hoc forward all ride the same SSH transport:

- no second login, no second 2FA prompt;
- closing one tab does not disturb the others;
- a [tunnel](tunnels.md) keeps its own lease, so closing every terminal leaves it running.

## When the network goes away

Muxus does not add its own probe traffic. It watches the keepalives your configuration
already asks for:

| Tab icon | Meaning |
| --- | --- |
| :material-circle:{ style="color:#e7b341" } amber | Existing keepalives are unanswered — the link is suspect |
| :material-circle:{ style="color:#f87171" } red | SSH declared the transport lost; the reason is printed in the terminal |

Nothing reconnects behind your back. Press any key in the tab when you are ready, or use
**Reconnect** from the tab menu. For SSH tabs the menu also offers **Reconnect + tmux** and
**Reconnect + screen**, which dial a fresh transport and then reattach your existing
multiplexer session — so a dropped link costs you the connection, not the work.

A restored [workspace](workspaces.md) reconnects the sessions you select, or all of them,
from its dialog.
