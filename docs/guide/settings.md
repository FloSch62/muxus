---
icon: lucide/settings
---

# Settings

++ctrl+comma++, or the gear in the top bar. Everything here applies **immediately** to
open terminals — except session logging, which saves explicitly, because storage policy
should not change under a running recorder.

<figure markdown="span">
  ![The settings dialog](../assets/screenshots/settings.png#only-light){ .shadow }
  ![The settings dialog](../assets/screenshots/settings-dark.png#only-dark){ .shadow }
  <figcaption>Eight sections down the left; the footer says what applies when. Appearance covers the theme, the interface scale and the terminal's colours and font.</figcaption>
</figure>

## Appearance

Everything about how Muxus looks:

- **Application theme** — light, dark, or follow the system.
- **Interface scale** — the size of the whole window. Terminal text has its own zoom
  (++ctrl+shift+equal++ / ++ctrl+shift+minus++ / ++ctrl+wheel++), which this does not touch.
- **Terminal colour scheme** — fifteen, grouped into light and dark sets.
- **Font** — family, size and line height. JetBrains Mono and the Nerd Font symbols ship
  with Muxus; any other family has to be installed on the machine.

## Terminal

<figure markdown="span">
  ![Terminal settings](../assets/screenshots/settings-terminal.png#only-light){ .shadow }
  ![Terminal settings](../assets/screenshots/settings-terminal-dark.png#only-dark){ .shadow }
  <figcaption>Cursor, clipboard behaviour, scrollback — how the terminal acts, rather than how it looks.</figcaption>
</figure>

- **Cursor** — block, underline or bar, blinking or not.
- **Right-click** — copy-selection-otherwise-paste (the terminal convention), always
  paste, or a context menu.
- **Copy on select** and the **multiline paste confirmation**.
- **Scrollback lines** kept per terminal.
- **Local shell** — which shell a local terminal starts; `auto` uses your login shell.

## Session logging

Off by default. This is where you turn retention on globally, decide whether input is
captured, and set the storage policy: **location**, **maximum total size**, **minimum free
space** (absolute and percentage), **maximum age**, and how many parts each session keeps.
The section also shows current usage against the quota.

<figure markdown="span">
  ![Session logging settings](../assets/screenshots/settings-logging.png#only-light){ .shadow }
  ![Session logging settings](../assets/screenshots/settings-logging-dark.png#only-dark){ .shadow }
  <figcaption>The only section with explicit Save buttons — and a dot in the nav when it has unsaved edits.</figcaption>
</figure>

[More on session history :octicons-arrow-right-24:](session-history.md)

## Highlighting

Global keyword rules applied to every terminal — keyword, foreground, optional background,
case sensitivity and whole-word matching. Hosts can add their own rules or replace the
global set entirely.

<figure markdown="span">
  ![Keyword highlighting rules](../assets/screenshots/settings-highlighting.png#only-light){ .shadow }
  ![Keyword highlighting rules](../assets/screenshots/settings-highlighting-dark.png#only-dark){ .shadow }
</figure>

## Behavior

Tab behaviour, including **confirm before closing a live session** — on by default,
because closing a connected tab ends its shell.

## Keyboard

Whether **new splits continue the current session** (on by default; SSH reuses the live
connection, and serial always asks), a summary of the layout keys, and the way into the
full shortcut editor.

<figure markdown="span">
  ![The keyboard shortcut sheet](../assets/screenshots/shortcuts.png#only-light){ .shadow }
  ![The keyboard shortcut sheet](../assets/screenshots/shortcuts-dark.png#only-dark){ .shadow }
  <figcaption>Search commands, add or replace chords, and see conflicts flagged as you type.</figcaption>
</figure>

Every command lives in one keymap. Record a chord by pressing it, add a second chord to a
command, or restore the defaults in one click. Also reachable with ++ctrl+shift+slash++.

[Every default chord :octicons-arrow-right-24:](../reference/keyboard-shortcuts.md)

## Backup & data

**Create backup** writes your Muxus-side data — folders, colours, saved Telnet/serial
hosts, workspaces, tunnels, preferences — to a file, and **Restore a backup** merges one
back in: items missing from the file are never deleted.

**Export OpenSSH** writes your SSH hosts out as a standard `ssh_config`, for handing to
another SSH client. The Muxus-only settings stay in the backup.

!!! info "Backups never include secrets"

    Private key files, passwords and recorded session history are never part of a backup.

## About

Version and build information, and where the application data lives on this machine.
