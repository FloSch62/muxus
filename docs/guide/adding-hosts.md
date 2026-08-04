---
icon: lucide/square-pen
---

# Adding & editing hosts

The host editor writes plain OpenSSH. Every field it exposes becomes part of a `Host` block
in the configuration file. The attributes Muxus adds on top (display name, folder, colour,
highlighting, logging policy) are stored in its own database.

Open the editor with **+** at the top of the sidebar, from a host's **Edit host** menu
entry, or by pressing ++enter++ on a search that matched nothing.

<figure markdown="span">
  ![The host editor, General section](../assets/screenshots/host-editor.png#only-light){ .shadow }
  ![The host editor, General section](../assets/screenshots/host-editor-dark.png#only-dark){ .shadow }
  <figcaption>The editor has seven sections, and the footer names the file it writes to.</figcaption>
</figure>

!!! info "What a save rewrites"

    Saving rewrites **only that block**. Comments, ordering, `Match` blocks and every other
    host in the file are left untouched. The write is atomic, and the previous contents are
    kept next to it as `<file>.muxus.bak`.

## General

| Field | Writes |
| --- | --- |
| **Alias** | The `Host` line. Several aliases separated by spaces are accepted; the first one names the session. |
| **HostName** | `HostName`. Empty means the alias is used as the hostname, as in OpenSSH. |
| **Port** | `Port`, omitted when it is 22. |
| **User** | `User`, omitted to use the local username. |
| **Description** | A `#` comment above the block, shown in the sidebar's hover card. |
| **Config file** | Which file the block lands in: the main config, an existing `Include`d file, or a new group file that Muxus creates and includes. |
| **Display name**, **folder**, **colour** | Muxus's own database, not the configuration file. |

## Authentication

Three modes, matching OpenSSH behaviour:

- **Agent & default keys** uses the OpenSSH order: agent first, then `~/.ssh/id_*`. Writes
  nothing, since this is the default.
- **Specific key file** writes `IdentityFile` and `IdentitiesOnly yes`, so login uses only
  the selected files and never waits on the agent. The picker lists the keys found in
  `~/.ssh` with their type and comment, badges the ones **loaded in the agent**, and marks
  the ones that are **passphrase-protected**.
- **Password / interactive** writes `PubkeyAuthentication no`, so public keys are skipped
  and a prompt is issued on connect.

**User certificates** can be added separately as `CertificateFile`, for CA-signed keys.

## Connection route

The route determines how the connection is dialled.

<figure markdown="span">
  ![The jump-chain builder](../assets/screenshots/host-editor-route.png#only-light){ .shadow }
  ![The jump-chain builder](../assets/screenshots/host-editor-route-dark.png#only-dark){ .shadow }
  <figcaption>Direct, through a chain of jump hosts, or through a command that provides the transport.</figcaption>
</figure>

- **Direct** writes nothing.
- **Jump hosts** writes the chain, in order, as `ProxyJump a,b,c`. Each hop is either an
  alias from the configuration or a bare `user@host:port`. Muxus dials the hops in sequence
  and rejects a chain that loops back on itself.
- **ProxyCommand** takes a command that provides the transport on stdin/stdout, such as
  `cloudflared access ssh --hostname %h`. The `%h`, `%p` and `%r` tokens are expanded at
  dial time.

[More on how connections are made :octicons-arrow-right-24:](connecting.md)

## Port forwarding

Forwards declared here are written into the block as `LocalForward`, `RemoteForward` or
`DynamicForward`, and start with every session to this host.

<figure markdown="span">
  ![Port forwarding with the live tunnel diagram](../assets/screenshots/host-editor-forwards.png#only-light){ .shadow }
  ![Port forwarding with the live tunnel diagram](../assets/screenshots/host-editor-forwards-dark.png#only-dark){ .shadow }
  <figcaption>The diagram redraws as the fields change, showing the direction of the forward.</figcaption>
</figure>

To start a forward on demand instead, without opening a terminal, save it as a
[tunnel](tunnels.md).

## Session logging & highlighting

Two per-host overrides of the global [settings](settings.md):

- **Session logging** inherits the global policy, or forces retention on or off for this
  host, including whether keystrokes are recorded.
- **Highlighting** adds keyword rules for this host's terminals, either in addition to or
  instead of the global rules.

## Advanced

Muxus does not request SFTP unless its initial probe identifies a supported Unix shell. If a
console server disconnects when it sees even that probe, Muxus reconnects once in plain-console
mode and remembers the compatibility choice until the app restarts. No manual setting is required
for the session to connect.

For known-sensitive SSH console servers and network appliances, **Enable console compatibility
mode** skips the initial probe as well, and stops sending `SendEnv`/`SetEnv` values that these
devices have no environment for. This persistent override avoids the first reconnect entirely.
Terminal allocation follows the host's TTY setting either way: Muxus asks for a terminal and
continues without one when the device rejects `pty-req`. The file-browser controls are unavailable
for plain-console sessions.

Any other keyword OpenSSH understands is entered here as free-form option/value pairs. The
panel shows the **exact block** that will be written.

<figure markdown="span">
  ![The exact ssh_config block preview](../assets/screenshots/host-editor-preview.png#only-light){ .shadow }
  ![The exact ssh_config block preview](../assets/screenshots/host-editor-preview-dark.png#only-dark){ .shadow }
  <figcaption>Free-form keywords, with a preview of the resulting block.</figcaption>
</figure>

## Saving

The footer offers **Save** and **Save & connect**. The second writes the block and opens a
session to it immediately.

Duplicating a host copies every field into a new block with a fresh alias. Deleting a host
removes only its block from the file it lives in.
