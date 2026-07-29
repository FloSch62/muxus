---
icon: lucide/route
---

# Connecting

Muxus dials the way `ssh` does. This page describes what happens between selecting a host
and reaching a prompt.

## Resolution

Every connection starts by resolving the host through the OpenSSH configuration: a
sequential, first-obtained-wins lookup across every matching `Host` pattern, wildcards and
negations included, and every `Include`d file, accumulating `IdentityFile`,
`CertificateFile` and the `*Forward` directives. **Each hop resolves independently**, so a
jump host uses its own key and its own user.

`Match` blocks are not applied. Their conditions depend on runtime state Muxus does not
reproduce, so the options inside them are skipped.

[Which keywords are honoured :octicons-arrow-right-24:](../reference/ssh-config.md)

## Host keys

Before authentication, the server's key is checked against `~/.ssh/known_hosts` and the
read-only `/etc/ssh/ssh_known_hosts`, hashed entries included.

<figure markdown="span">
  ![The host-key verification dialog](../assets/screenshots/host-key.png#only-light){ .shadow }
  ![The host-key verification dialog](../assets/screenshots/host-key-dark.png#only-dark){ .shadow }
  <figcaption>Trust on first use, with the fingerprint shown for comparison.</figcaption>
</figure>

- **Unknown host**: the fingerprint is shown for confirmation. Accepting appends the key to
  `~/.ssh/known_hosts`, so `ssh` on the command line trusts it as well.
- **Changed key**: a warning is shown. Accepting performs the `ssh-keygen -R`-style
  replacement of the old entry.

!!! danger "A changed key is not routine"

    If the host was not just rebuilt, determine why the key changed before accepting.

## Authentication order

Within one connection Muxus follows the OpenSSH order and stops at the first method that
succeeds:

1. **Agent**: every identity in `SSH_AUTH_SOCK`.
2. **Certificates**: a `CertificateFile` together with its matching `IdentityFile`.
3. **Keys**: the `IdentityFile`s in the block, or the default `~/.ssh/id_*` set.
   Passphrase-protected keys issue a prompt. `IdentitiesOnly yes` is honoured.
4. **Keyboard-interactive**: 2FA codes, challenge/response.
5. **Password**, with retries.

<figure markdown="span">
  ![A keyboard-interactive prompt](../assets/screenshots/auth-prompt.png#only-light){ .shadow }
  ![A keyboard-interactive prompt](../assets/screenshots/auth-prompt-dark.png#only-dark){ .shadow }
  <figcaption>Each prompt names the hop that issued it, which identifies the hop in a jump chain.</figcaption>
</figure>

An SSH password prompt offers **Remember this password**. The password is saved only after
authentication succeeds. The first save creates a vault and asks for a master password of
at least twelve characters. By default, the vault key is kept in the OS credential store,
so routine SSH use does not prompt for the master password. In **Settings → Passwords**,
the policy can instead ask once when Muxus starts or whenever a saved credential is
needed. The master password is always required to view or edit saved values.

If a never-prompt vault is restored without its OS credential-store entry, automatic use
pauses until **Restore OS access** is completed with the master password. Private-key
passphrases, keyboard-interactive answers and 2FA codes remain transient and are never
remembered. See the
[security model](../reference/security.md#password-vault).

## Jump chains and ProxyCommand

`ProxyJump` chains, including nested and comma-separated ones, are dialled **hop by hop**,
each with its own resolution, host-key check and authentication. Cycles are detected and
rejected.

`ProxyCommand` is supported as a transport. Muxus runs the command and speaks SSH over its
stdin/stdout, which supports tools such as `cloudflared access ssh` and corporate
`ProxyCommand` wrappers.

Forwards declared on the block (`LocalForward`, `RemoteForward`, `DynamicForward`) start
with the session, and `ForwardAgent` applies when an agent is present.

## One connection per host

Connections are multiplexed, the way OpenSSH `ControlMaster` sharing works. A session whose
resolved dial plan — every hop's user, host, port and agent-forwarding policy, plus any
expanded `ProxyCommand` — matches a live connection opens a new channel on it instead of a
new TCP connection. Splitting a pane, opening a second tab on the same host, the file
browser, the remote editor, tunnels and ad-hoc forwards all share one SSH transport:

- no second login and no second 2FA prompt;
- servers that cap connections per user (`MaxStartups`, firewall rules) see one connection,
  no matter how many panes are open;
- sessions started together, such as a restored workspace, collapse into a single dial with
  a single authentication round-trip.

Sharing is safe by construction: a connection whose keepalives have gone quiet is not
reused, and if the server refuses another channel on a shared connection (`MaxSessions`),
Muxus silently dials a dedicated connection for that pane instead.

Each consumer holds its own lease on the transport:

- closing one tab does not affect the others; the connection closes with its last consumer;
- a [tunnel](tunnels.md) holds its own lease, so closing every terminal leaves it running.

## Connection loss

Muxus adds no probe traffic of its own. It observes the keepalives the configuration
already requests:

| Tab icon | Meaning |
| --- | --- |
| :material-circle:{ style="color:#e7b341" } amber | Existing keepalives are unanswered |
| :material-circle:{ style="color:#f87171" } red | SSH declared the transport lost; the reason is printed in the terminal |

Reconnection is never automatic. Press any key in the tab, or use **Reconnect** from the
tab menu. SSH tabs additionally offer **Reconnect + tmux** and **Reconnect + screen**, which
dial a fresh transport and then reattach the existing multiplexer session.

A restored [workspace](workspaces.md) reconnects selected sessions, or all of them, from
its dialog.
