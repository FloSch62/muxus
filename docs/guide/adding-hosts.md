---
icon: lucide/square-pen
---

# Adding & editing hosts

The host editor is a MobaXterm-style session editor that happens to write plain OpenSSH.
Everything you fill in becomes a `Host` block in your config file; everything Muxus adds
on top (display name, folder, colour, highlighting, logging policy) stays in its own
database.

Open it with **+** at the top of the sidebar, from a host's **Edit host** menu entry, or
by pressing ++enter++ on a search that matched nothing.

<figure markdown="span">
  ![The host editor, General section](../assets/screenshots/host-editor.png#only-light){ .shadow }
  ![The host editor, General section](../assets/screenshots/host-editor-dark.png#only-dark){ .shadow }
  <figcaption>One dialog, seven sections, and a footer that says exactly which file it writes.</figcaption>
</figure>

!!! info "Edits are surgical"

    Saving rewrites **only that block**. Comments, ordering, `Match` blocks and every
    other host in the file are left untouched. The write is atomic, and the previous
    contents are kept next to it as `<file>.muxus.bak`.

## General

| Field | Writes |
| --- | --- |
| **Alias** | The `Host` line. Several aliases separated by spaces are fine — the first one names the session. |
| **HostName** | `HostName`; empty means "the alias is the hostname", exactly like OpenSSH. |
| **Port** | `Port`, omitted when it is 22. |
| **User** | `User`, omitted to use your local username. |
| **Description** | A `#` comment above the block, shown in the sidebar's hover card. |
| **Config file** | Which file the block lands in: your main config, an existing `Include`d file, or a new group file Muxus creates and includes for you. |
| **Display name**, **folder**, **colour** | Muxus's own database — never your config. |

## Authentication

Three modes, matching what OpenSSH actually does:

- **Agent & default keys** — the OpenSSH order: agent first, then `~/.ssh/id_*`. Writes
  nothing, because that is the default.
- **Specific key file** — writes `IdentityFile`. The picker lists the keys found in
  `~/.ssh` with their type and comment, badges the ones **loaded in your agent**, and
  marks the ones that are **passphrase-protected** so you know a prompt is coming.
- **Password / interactive** — writes `PubkeyAuthentication no`, so public keys are
  skipped and you are prompted on connect.

**User certificates** can be added separately (`CertificateFile`), for CA-signed keys.

## Connection route

How the connection is dialled:

<figure markdown="span">
  ![The jump-chain builder](../assets/screenshots/host-editor-route.png#only-light){ .shadow }
  ![The jump-chain builder](../assets/screenshots/host-editor-route-dark.png#only-dark){ .shadow }
  <figcaption>Direct, through a chain of jump hosts, or through a command that provides the transport.</figcaption>
</figure>

- **Direct** — nothing is written.
- **Jump hosts** — a chain, in order, written as `ProxyJump a,b,c`. Each hop can be an
  alias from your config or a bare `user@host:port`. Muxus dials them hop by hop, like
  `ssh` does, and refuses to build a chain that loops back on itself.
- **ProxyCommand** — a command that provides the transport on stdin/stdout, for things
  like `cloudflared access ssh --hostname %h`. The usual `%h`/`%p`/`%r` tokens apply.

[More on how connections are made :octicons-arrow-right-24:](connecting.md)

## Port forwarding

Forwards declared here are written into the block (`LocalForward`, `RemoteForward`,
`DynamicForward`) and start automatically with every session to this host.

<figure markdown="span">
  ![Port forwarding with the live tunnel diagram](../assets/screenshots/host-editor-forwards.png#only-light){ .shadow }
  ![Port forwarding with the live tunnel diagram](../assets/screenshots/host-editor-forwards-dark.png#only-dark){ .shadow }
  <figcaption>The diagram redraws as you type, so the direction is never a guess.</figcaption>
</figure>

If you would rather start a forward on demand — without opening a terminal — save it as a
[tunnel](tunnels.md) instead.

## Session logging & highlighting

Two per-host overrides of the global [settings](settings.md):

- **Session logging** — inherit the global policy, or force retention on or off for this
  host (including whether your keystrokes are recorded).
- **Highlighting** — extra keyword rules for this host's terminals, either *in addition
  to* or *instead of* the global ones. Handy for making `ERROR` red only on the boxes
  where it matters.

## Advanced

Anything else OpenSSH understands goes here as free-form option/value pairs, and the
panel shows the **exact block** that will be written.

<figure markdown="span">
  ![The exact ssh_config block preview](../assets/screenshots/host-editor-preview.png#only-light){ .shadow }
  ![The exact ssh_config block preview](../assets/screenshots/host-editor-preview-dark.png#only-dark){ .shadow }
  <figcaption>Rendered by the same code that writes the file — what you read is what lands on disk.</figcaption>
</figure>

## Save, or save and connect

The footer has both. **Save & connect** writes the block and immediately opens a session
to it — the fastest way from "I have a new box" to "I am on it".

Duplicating a host copies every field into a new block with a fresh alias; deleting one
removes only that block from the file it lives in.
