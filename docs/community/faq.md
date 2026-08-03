---
icon: lucide/circle-help
---

# FAQ

### Does Muxus change my `~/.ssh/config`?

Only on request. Adding, editing or deleting a host rewrites that block and nothing else,
atomically, leaving a `.muxus.bak` of the previous contents. Folders, colours and
workspaces are stored in Muxus's own database.

### Will `ssh` on the command line still work?

Yes. Muxus writes standard OpenSSH blocks, appends to `known_hosts`, and reads the agent.
Anything added in Muxus is usable by `ssh`, `scp` and `rsync`.

### Do I need to import my hosts?

No. Every concrete `Host` block in the configuration is present in the sidebar on first
launch, including the files it pulls in with `Include`.

### Why do some options in my config seem to be ignored?

`Match` blocks are skipped, because their conditions depend on runtime state Muxus does not
reproduce. Everything in `Host` blocks is resolved, and unmodelled keywords are preserved
verbatim. See [ssh_config support](../reference/ssh-config.md).

### Does it support 2FA / keyboard-interactive?

Yes, as a dialog labelled with the hop that issued the prompt. Agent, certificates, keys
with passphrases, keyboard-interactive and passwords follow the OpenSSH order.

### Can I use it as a web terminal on a server?

No. It binds `127.0.0.1`, checks a per-run token and the `Origin` header, and is designed
as a single-user local tool. Do not put it behind a reverse proxy.

### Where is my data?

The application database is in the platform data directory (`~/.local/share/muxus/`,
`~/Library/Application Support/Muxus/`, `%APPDATA%\Muxus\`). Connection settings are in
`~/.ssh/config`. See the [CLI reference](../reference/cli.md#data-locations).

### Are my passwords stored anywhere?

Not by default. Passwords are transient unless **Remember this password** is selected on
an SSH password prompt. A single hidden keyboard-interactive field explicitly labelled
as a password is treated the same way, which covers network devices that use
keyboard-interactive for password login. Remembering creates the platform-independent
password vault and writes authenticated ciphertext to the local database. The prompt
policy can use the OS credential store (the default), ask once at startup, or ask whenever
a credential is needed. The master password is always required to view or edit the saved
value and is never stored. Private-key passphrases, 2FA codes and all other
keyboard-interactive answers are never remembered. See the
[security model](../reference/security.md#password-vault).

### Why is session logging off by default?

Recording terminal output is opt-in. Enable it globally or per host. Commands that are
typed are echoed back as remote output, so pause logging before displaying secrets. See
[session history](../guide/session-history.md).

### Images do not render. What is wrong?

Check that the remote tool is emitting a supported protocol: kitty graphics, sixel or
iTerm2. Tools usually detect support from `TERM` and terminal queries; Muxus advertises
`xterm-256color` and answers the cell-size queries `icat` uses. A single transmission over
64 MiB is rejected. See [images in the terminal](../guide/graphics.md).

### Why is ++ctrl+w++ not "close tab"?

++ctrl+w++ deletes a word in the shell, and Muxus does not take keys the shell needs.
Closing is ++ctrl+shift+w++ (++cmd+w++ on macOS), and tabs use ++alt+1++ … ++alt+9++. Any
binding can be changed in the
[shortcut sheet](../reference/keyboard-shortcuts.md).

### Does splitting a pane log in twice?

No. A split continues the current session over the same SSH connection, so there is no
second login and no second 2FA prompt. This is configurable in
[Settings → Keyboard](../guide/settings.md#keyboard).

### Can I keep a tunnel open without a terminal?

Yes. Saved [tunnels](../guide/tunnels.md) hold their own transport lease, so closing every
terminal to that host leaves the tunnel running.

### Does it work on Windows?

Yes: SSH, Telnet, local shells and `COM` serial ports. The desktop installer is an NSIS
`.exe`.

### Is there a Wayland/HiDPI/scaling issue?

Interface scale is a setting (**Settings → Appearance**), separate from terminal font zoom,
so the UI and the text are sized independently.
