---
icon: lucide/file-cog
---

# ssh_config support

Muxus does not import your OpenSSH configuration — it reads it, resolves it the way `ssh`
does, and writes edits back into the same file. This page is the exact contract.

## Files

| What | Where |
| --- | --- |
| Main config | `~/.ssh/config` (`%USERPROFILE%\.ssh\config` on Windows) |
| Included files | Anything an `Include` directive pulls in, up to 8 levels deep |
| Known hosts | `~/.ssh/known_hosts`, plus read-only `/etc/ssh/ssh_known_hosts` |
| Keys offered to the picker | Everything in `~/.ssh` that looks like a key |

Hosts are grouped in the sidebar by the file they came from, until you give them a
[folder](../guide/hosts.md#folders) of your own.

## Resolution

Resolution follows `ssh_config(5)`: **first obtained value wins**, scanning `Host` blocks
in file order, with `IdentityFile`, `CertificateFile` and the `*Forward` directives
**accumulating** across every matching block. Patterns support `*`, `?` and `!` negation.

Every hop of a `ProxyJump` chain resolves independently.

!!! warning "`Match` blocks are skipped"

    Their conditions (`exec`, `host`, `originalhost`, `user`, `localuser`, `canonical`)
    depend on runtime state Muxus does not reproduce, so rather than guessing, options
    inside a `Match` block are ignored. Keep anything Muxus needs in `Host` blocks.

    An `Include` **inside** a `Host` block is preserved verbatim rather than expanded.

## Keywords Muxus understands

These are modelled as fields — they appear as controls in the
[host editor](../guide/adding-hosts.md) and drive the connection:

| Keyword | Used for |
| --- | --- |
| `HostName` | The address dialled; defaults to the alias |
| `User` | Login user |
| `Port` | TCP port; omitted when 22 |
| `IdentityFile` | Keys offered, in order |
| `CertificateFile` | User certificates, paired with their key |
| `IdentitiesOnly` | Restricts authentication to the listed identities |
| `ForwardAgent` | Agent forwarding, when an agent is present |
| `ProxyJump` | Jump chain, comma-separated and nestable |
| `ProxyCommand` | External transport command (`%h`, `%p`, `%r` expand at dial time) |
| `LocalForward` · `RemoteForward` · `DynamicForward` | Forwards started with the session |
| `PubkeyAuthentication no` | The editor's "password / interactive" mode |
| `PreferredAuthentications keyboard-interactive,password` | Written alongside the above |

**Everything else is preserved.** Unmodelled keywords are kept verbatim and shown in the
editor's **Advanced** section, so options Muxus has no opinion about — `Compression`,
`ServerAliveInterval`, `StrictHostKeyChecking`, anything your organisation ships — survive
an edit untouched.

## How edits are written

The parser keeps the document **line-preserving**: every block remembers exactly which
lines in which file it occupies, including the comment lines above it.

When you save a host:

1. Only that block's lines are replaced.
2. The file is written **atomically** (write, then rename into place).
3. The previous contents are kept next to it as `<file>.muxus.bak`.

Comments, blank lines, ordering, `Match` blocks and every other host are left exactly as
they were. Deleting a host removes only its block.

New hosts can go into your main config, into any file you already `Include`, or into a new
group file that Muxus creates and adds an `Include` for.

## What Muxus stores separately

Its own database holds only what OpenSSH has no field for:

- display name, folder, colour and sidebar order;
- per-host keyword-highlighting rules and session-logging policy;
- last-connected timestamps and connection counts;
- workspaces, saved tunnels, and saved Telnet/serial hosts.

Passwords, passphrases and private keys are **never** stored — the persistence layer
rejects them outright. See the [security model](security.md).
