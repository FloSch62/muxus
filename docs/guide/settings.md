---
icon: lucide/settings
---

# Settings

Settings are opened with ++ctrl+comma++ or the gear control in the top bar. Changes apply
immediately to open terminals. Session logging is the exception and saves explicitly,
because storage policy should not change under a running recorder.

<figure markdown="span">
  ![The settings dialog](../assets/screenshots/settings.png#only-light){ .shadow }
  ![The settings dialog](../assets/screenshots/settings-dark.png#only-dark){ .shadow }
  <figcaption>Eight sections, listed on the left. The footer states when changes apply.</figcaption>
</figure>

## Appearance

- **Application theme**: light, dark, or follow the system.
- **Interface scale**: the size of the whole window. Terminal text has a separate zoom
  (++ctrl+shift+equal++ / ++ctrl+shift+minus++ / ++ctrl+wheel++).
- **Terminal colour scheme**: fifteen schemes, grouped into light and dark sets.
- **Font**: family, size and line height. JetBrains Mono and the Nerd Font symbols are
  bundled; any other family must be installed on the machine.

## Terminal

<figure markdown="span">
  ![Terminal settings](../assets/screenshots/settings-terminal.png#only-light){ .shadow }
  ![Terminal settings](../assets/screenshots/settings-terminal-dark.png#only-dark){ .shadow }
  <figcaption>Cursor, clipboard behaviour and scrollback settings.</figcaption>
</figure>

- **Cursor**: block, underline or bar, blinking or not.
- **Right-click**: copy-selection-otherwise-paste (the terminal convention), always paste,
  or a context menu.
- **Copy on select** and the **multiline paste confirmation**.
- **Scrollback lines** kept per terminal.
- **Local shell**: the shell a local terminal starts; `auto` uses the login shell.

## Session logging

Off by default. This section enables retention globally, controls whether input is
captured, and sets the storage policy: **location**, **maximum total size**, **minimum free
space** (absolute and percentage), **maximum age**, and the number of parts each session
keeps. Current usage against the quota is displayed here.

<figure markdown="span">
  ![Session logging settings](../assets/screenshots/settings-logging.png#only-light){ .shadow }
  ![Session logging settings](../assets/screenshots/settings-logging-dark.png#only-dark){ .shadow }
  <figcaption>The only section with explicit Save buttons, marked with a dot in the nav when it has unsaved edits.</figcaption>
</figure>

[More on session history :octicons-arrow-right-24:](session-history.md)

## Highlighting

Global keyword rules applied to every terminal: keyword, foreground, optional background,
case sensitivity and whole-word matching. Hosts can add their own rules or replace the
global set.

<figure markdown="span">
  ![Keyword highlighting rules](../assets/screenshots/settings-highlighting.png#only-light){ .shadow }
  ![Keyword highlighting rules](../assets/screenshots/settings-highlighting-dark.png#only-dark){ .shadow }
</figure>

## Behavior

Tab behaviour, including **confirm before closing a live session**, which is on by default
because closing a connected tab ends its shell, and the restore switches, both on by
default: **automatically reconnect remote sessions** — restoring a workspace dials its
remote tabs, and a dropped connection redials a few times on its own; turn it off to
restore remote tabs without logging in — and **restore terminal history**, which saves
recent output locally every few seconds and replays it above the new session after a
restore or reconnect.

## Keyboard

Controls whether **new splits continue the current session** (on by default; SSH reuses the
live connection, and serial always asks), a summary of the layout keys, and access to the
full shortcut editor.

<figure markdown="span">
  ![The keyboard shortcut sheet](../assets/screenshots/shortcuts.png#only-light){ .shadow }
  ![The keyboard shortcut sheet](../assets/screenshots/shortcuts-dark.png#only-dark){ .shadow }
  <figcaption>The shortcut sheet: search commands, add or replace chords, and view conflicts.</figcaption>
</figure>

All commands share one keymap. A chord is recorded by pressing it, a command can carry a
second chord, and defaults are restored in one click. The sheet is also reachable with
++ctrl+shift+slash++.

[Every default chord :octicons-arrow-right-24:](../reference/keyboard-shortcuts.md)

## Backup & data

**Create backup** writes the Muxus-side data to a file: folders, colours, saved
Telnet/serial hosts, workspaces, tunnels and preferences. **Restore a backup** merges a file
back in; items absent from the file are not deleted.

**Export OpenSSH** writes the SSH hosts out as a standard `ssh_config` for use with another
client. Muxus-only settings remain in the backup.

!!! info "What a backup excludes"

    Private key files, passwords and recorded session history are never part of a backup.

## About

Version and platform information, a link to the source repository, and a manual update
check. When a newer release exists, Muxus links to its GitHub release so the appropriate
portable package can be downloaded.
