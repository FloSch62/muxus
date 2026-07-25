---
icon: lucide/circle-help
---

# FAQ

### Does Muxus change my `~/.ssh/config`?

Only when you ask it to. Adding, editing or deleting a host rewrites **that block** and
nothing else, atomically, leaving a `.muxus.bak` of the previous contents. Everything else
— folders, colours, workspaces — lives in Muxus's own database.

### Will `ssh` on the command line still work?

Yes, and that is the point. Muxus writes normal OpenSSH blocks, appends to your real
`known_hosts`, and reads your agent. Anything you add in Muxus is usable by `ssh`, `scp`,
`rsync` and everything else.

### Do I need to import my hosts?

No. Every concrete `Host` block in your config — and in every file it `Include`s — is
already in the sidebar the first time you launch.

### Why do some options in my config seem to be ignored?

`Match` blocks are skipped: their conditions depend on runtime state Muxus does not
reproduce, so guessing would be worse than not applying them. Everything in `Host` blocks
is resolved, and unmodelled keywords are preserved verbatim. See
[ssh_config support](../reference/ssh-config.md).

### Does it support 2FA / keyboard-interactive?

Yes — as a dialog, labelled with the hop that is asking, which matters in a jump chain.
Agent, certificates, keys with passphrases, keyboard-interactive and passwords all follow
the OpenSSH order.

### Can I use it as a web terminal on a server?

No. It binds `127.0.0.1`, checks a per-run token and the `Origin` header, and is designed
as a single-user local tool. Do not put it behind a reverse proxy.

### Where is my data?

The application database is in your platform's data directory
(`~/.local/share/muxus/`, `~/Library/Application Support/Muxus/`, `%APPDATA%\Muxus\`).
Connection settings are in `~/.ssh/config`. See the
[CLI reference](../reference/cli.md#data-locations).

### Are my passwords stored anywhere?

No. They exist only for the duration of an authentication attempt. The persistence layer
actively **rejects** fields that look like credentials, so a password cannot be written to
the database even by accident.

### Why is session logging off by default?

Because recording terminal output is a decision, not a default. Turn it on globally or per
host — and remember that commands you type are echoed back as remote output, so pause
logging before displaying secrets. See [session history](../guide/session-history.md).

### Images do not render — what is wrong?

Check that the remote tool is actually emitting a supported protocol (kitty graphics,
sixel or iTerm2). Tools usually detect support from `TERM` and terminal queries; Muxus
advertises `xterm-256color` and answers the cell-size queries `icat` uses. A single
transmission over 64 MiB is rejected. See
[images in the terminal](../guide/graphics.md).

### Why is ++ctrl+w++ not "close tab"?

Because ++ctrl+w++ deletes a word in every shell. Muxus refuses to take keys the shell
needs: closing is ++ctrl+shift+w++ (++cmd+w++ on macOS), and tabs answer to
++alt+1++ … ++alt+9++. Rebind anything you like in the
[shortcut sheet](../reference/keyboard-shortcuts.md).

### Does splitting a pane log in twice?

No. A split continues the current session over the same SSH connection, so there is no
second login and no second 2FA prompt. You can turn that off in
[Settings → Keyboard](../guide/settings.md#keyboard).

### Can I keep a tunnel open without a terminal?

Yes — that is what saved [tunnels](../guide/tunnels.md) are for. They hold their own
transport lease, so closing every terminal to that host leaves the tunnel running.

### Does it work on Windows?

Yes: SSH, Telnet, local shells and `COM` serial ports. The desktop installer is an NSIS
`.exe`.

### Is there a Wayland/HiDPI/scaling issue?

Interface scale is a setting (**Settings → Appearance**), deliberately separate from
terminal font zoom, so you can size the UI and the text independently.
