---
icon: lucide/file-cog
---

# ssh_config support

Muxus does not import the OpenSSH configuration. It reads it, resolves it the way `ssh`
does, and writes edits back into the same file. This page states the contract.

## Files

| What | Where |
| --- | --- |
| Main config | `~/.ssh/config` (`%USERPROFILE%\.ssh\config` on Windows) |
| Included files | Anything an `Include` directive pulls in, up to 8 levels deep |
| Known hosts | `~/.ssh/known_hosts`, plus read-only `/etc/ssh/ssh_known_hosts` |
| Keys offered to the picker | Everything in `~/.ssh` that looks like a key |

Hosts are grouped in the sidebar by the file they came from until they are assigned a
[folder](../guide/hosts.md#folders).

## Resolution

Resolution follows `ssh_config(5)`: **first obtained value wins**, scanning `Host` blocks in
file order, with `IdentityFile`, `CertificateFile` and the `*Forward` directives
**accumulating** across every matching block. Patterns support `*`, `?` and `!` negation.

Every hop of a `ProxyJump` chain resolves independently.

!!! warning "`Match` blocks are skipped"

    Their conditions (`exec`, `host`, `originalhost`, `user`, `localuser`, `canonical`)
    depend on runtime state Muxus does not reproduce, so options inside a `Match` block are
    ignored. Keep anything Muxus needs in `Host` blocks.

    An `Include` **inside** a `Host` block is preserved verbatim rather than expanded.

## Keywords Muxus understands

These keywords are modelled as fields. They appear as controls in the
[host editor](../guide/adding-hosts.md) and drive the connection:

| Keyword | Used for |
| --- | --- |
| `HostName` | The address dialled; defaults to the alias |
| `User` | Login user |
| `Port` | TCP port; omitted when 22 |
| `IdentityFile` | Keys offered, in order |
| `CertificateFile` | User certificates, paired with their key |
| `IdentitiesOnly` | Restricts authentication to the listed identities |
| `IdentityAgent` | Agent source: inherited, `SSH_AUTH_SOCK`, custom socket/variable, or disabled |
| `ForwardAgent` | Agent forwarding, when an agent is present |
| `ForwardX11` | [X11 forwarding](../guide/x11.md); unset follows the platform default (on with the built-in Windows X server) |
| `ProxyJump` | Jump chain, comma-separated and nestable |
| `ProxyCommand` | External transport command (`%h`, `%p`, `%r` expand at dial time) |
| `LocalForward`, `RemoteForward`, `DynamicForward` | Forwards started with the session |
| `PubkeyAuthentication no` | The editor's "password / interactive" mode |
| `PreferredAuthentications keyboard-interactive,password` | Written alongside the above |
| `StrictHostKeyChecking` | Host-key verification policy |
| `RemoteCommand` | Login shell or a command to run after connecting |
| `RequestTTY` | Terminal allocation for shells and startup commands |

These expert policies remain under **Advanced**, where the editor badges them **applied**,
but the dialler still applies them the way `ssh` would:

| Keyword | Used for |
| --- | --- |
| `Ciphers`, `KexAlgorithms`, `HostKeyAlgorithms`, `MACs` | Algorithm negotiation, including the `+`/`^`/`-` list syntax and `*` patterns. Entries the SSH engine does not implement are skipped with a notice, so a config shared with OpenSSH keeps working. The editor flags them while you type. |
| `Compression` | `yes` prefers zlib like `ssh -C` |
| `ConnectTimeout` | Dial timeout; defaults to 20 seconds |
| `ServerAliveInterval`, `ServerAliveCountMax` | Keepalives; OpenSSH defaults to disabled / 3 missed replies. Muxus supplies the interval selected in Settings (30 seconds by default) when the config leaves it unset. |
| `PasswordAuthentication no`, `KbdInteractiveAuthentication no` | Removes that rung from the auth ladder (the legacy `ChallengeResponseAuthentication` spelling works too) |
| `UserKnownHostsFile`, `GlobalKnownHostsFile` | Host keys verify against these files instead; new keys are recorded into the first user file, `none` disables, and user-file path tokens such as `%h`, `%n`, and `%p` expand per connection |
| `SetEnv`, `SendEnv` | Session environment, with `-pattern` removals and SetEnv overriding |
| `SecurityKeyProvider` | FIDO middleware for [security key](../guide/connecting.md#security-keys) files: a library path or `$VARIABLE`; unset follows `$SSH_SK_PROVIDER`, then OpenSSH's built-in support |

The editor's **Advanced** section shows a badge per row: **applied** for the keywords above,
**kept** for everything Muxus preserves but does not use. A one-click **Legacy device
algorithms** button adds the `KexAlgorithms`/`HostKeyAlgorithms`/`Ciphers` lines old console
servers and network appliances need, merging them into any algorithm lists already present.

**Everything else is preserved.** Unmodelled keywords are kept verbatim and shown in the
editor's **Advanced** section, so keywords Muxus does not model survive an edit untouched:
`HashKnownHosts`, `ControlMaster`, `ForwardX11`, and any site-specific options.

## System OpenSSH

The built-in SSH client ignores `GSSAPIAuthentication`, and everything else listed as **kept**
above. For a host that needs them, turn on **Use system OpenSSH** in the host's
[**Advanced** section](../guide/adding-hosts.md#advanced). Muxus then runs `ssh <alias>` in the
terminal, so `ssh` reads its own config, including `Match` blocks, and shows its own prompts.

For Kerberos, get a ticket with `kinit` (or your domain login) and set the options in the host's
block:

```ssh-config
Host build-box
    HostName build.example.com
    GSSAPIAuthentication yes
    GSSAPIDelegateCredentials yes
```

A [saved host](../guide/hosts.md) has no block of its own, so Muxus passes its settings to `ssh`
on the command line and turns `GSSAPIAuthentication` on, unless the host is password-only. Other
options still come from `Host *` blocks. Your `ssh` program must itself support the option: if it
prints `Unsupported option "gssapiauthentication"`, install a build with GSSAPI, such as
`openssh_gssapi` on Nix.

The program is found on `PATH`, then at `/usr/bin/ssh`, or
`%SystemRoot%\System32\OpenSSH\ssh.exe` on Windows.

| Feature | With system OpenSSH |
| --- | --- |
| Terminal, session logging, login sequences, anti-idle | Available |
| File browser and file drops | Linux and macOS, over the terminal's own connection. Not on Windows, whose OpenSSH cannot share a connection |
| Status bar statistics, listing containers and VMs | Linux and macOS, while a terminal to the host is open. Automatic readings first log in once on a separate connection to check that the host runs commands; if that login would need a password, they stay off |
| Entering a container, pod or VM console | Available; a new `ssh` logs in for each one |
| `*Forward` lines and `ProxyJump` | Applied by `ssh` |
| Tunnels started in Muxus, opening a container's port | Not available |
| Running scripts, fallback jump routes | Not available |
| Folder credentials, password vault, BREAK, `ssh://` links that pin a host key | Not available |
| New tabs and split panes | Each logs in on its own instead of sharing a connection |

What such a host cannot do is greyed out wherever it is offered: **Send BREAK**, **Follow
terminal folder**, starting a tunnel through it, choosing it as a gateway, running a script on it, adding fallback
jump routes, and the container actions that open a port or jump through it. So is **console compatibility**, which shapes the
built-in client's session and has no effect here. A host set to use the built-in client cannot
jump through one that uses system OpenSSH, and system OpenSSH cannot jump through a saved host.

## How edits are written

The parser keeps the document line-preserving: every block records which lines in which
file it occupies, including the comment lines above it.

When a host is saved:

1. Only that block's lines are replaced.
2. The file is written **atomically**, by writing and then renaming into place.
3. The previous contents are kept next to it as `<file>.muxus.bak`.

If a config file is a symbolic link, Muxus writes the link target atomically and
leaves the symbolic link itself intact.

Comments, blank lines, ordering, `Match` blocks and every other host are left as they were.
Deleting a host removes only its block. Deleting several hosts at once writes each file once,
so its `.muxus.bak` holds the contents from before the whole delete.

A [bulk edit](../guide/hosts.md#editing-several-hosts-at-once) of many hosts goes further:
it rewrites only the lines of the options it changes, appending an option a block does not
have yet, so the rest of each block stays byte-identical. Each file is written once, and its
`.muxus.bak` holds the contents from before the whole edit.

New hosts can be written to the main config, to any file already pulled in with `Include`,
or to a new group file that Muxus creates and adds an `Include` for.

## What Muxus stores separately

Its own database holds only what OpenSSH has no field for:

- display name, folder, colour and sidebar order;
- separate per-host SFTP and console-compatibility overrides (Muxus also falls back to
  plain-console mode automatically when optional shell-integration setup disconnects a transport);
- per-host keyword-highlighting rules and session-logging policy;
- last-connected timestamps and connection counts;
- workspaces, saved tunnels, and saved Telnet/serial hosts;
- opt-in SSH password ciphertext in the password vault.

Unencrypted passwords, passphrases and private keys are never stored. Private-key
passphrases and 2FA answers are always transient; an SSH password is persisted only when
**Remember this password** is selected. See the
[security model](security.md#password-vault).
