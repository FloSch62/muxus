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
  <figcaption>Eleven sections, listed on the left. The footer states when changes apply.</figcaption>
</figure>

## Appearance

- **Application theme**: light, dark, or follow the system.
- **Interface scale**: the size of the whole window. Terminal text has a separate zoom
  (++ctrl+shift+equal++ / ++ctrl+shift+minus++ / ++ctrl+wheel++).
- **Split pane focus**: dim inactive panes or add a thin theme-aware outline. Both are off by
  default; dimming starts at 15% and is adjustable. Multi-exec panes stay emphasized. These
  effects are presentation-only and do not alter terminal colours or output.
- **Light terminal theme** and **Dark terminal theme**: separate colour schemes that
  follow the effective application appearance, including system appearance changes.
  Fifteen schemes are grouped into light and dark sets, with optional shared text and
  background colour overrides.
- **Font**: family, size and line height. The desktop selector includes JetBrains Mono,
  which is bundled, plus the font families installed for the current operating-system
  user. Nerd Font symbols remain an automatic bundled fallback.

## Terminal

<figure markdown="span">
  ![Terminal settings](../assets/screenshots/settings-terminal.png#only-light){ .shadow }
  ![Terminal settings](../assets/screenshots/settings-terminal-dark.png#only-dark){ .shadow }
  <figcaption>Cursor, clipboard behaviour and scrollback settings.</figcaption>
</figure>

- **Cursor**: block, underline or bar, blinking or not.
- **Right-click**: copy-selection-otherwise-paste (the terminal convention), always paste,
  or a context menu.
- **Copy on select**, **OSC 52 clipboard writes** from terminal programs such as tmux and
  Zellij, and the **multiline paste confirmation**. OSC 52 reads remain blocked so a
  terminal program cannot retrieve the local clipboard.
- **Scrollback lines** kept per terminal.

## Local shells

The automatic local terminal keeps the previous behaviour: `auto` uses the login shell,
or an executable can override it. Saved profiles make several local environments available
at once. Each profile has a display name, executable, structured argument list, starting
directory and optional startup commands.

Arguments are entered one per line, so a value containing spaces stays one argument. For
example, a Windows profile with executable `wsl.exe` and arguments `-d` and `Ubuntu`
opens that distribution; another profile can select Debian, PowerShell or `cmd.exe`.
Profiles appear below **Local terminal** in the sidebar and in the quick launcher. One can
be selected as the default used by the sidebar, empty-pane shortcut and generic local
terminal action. Startup commands are entered into the interactive shell whenever the
profile starts, including when it is restored in a workspace.

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
live connection, and serial always asks), whether window-wide tab numbers appear **while
Alt is held** or **always**, a summary of the layout keys, and
access to the full shortcut editor.

<figure markdown="span">
  ![The keyboard shortcut sheet](../assets/screenshots/shortcuts.png#only-light){ .shadow }
  ![The keyboard shortcut sheet](../assets/screenshots/shortcuts-dark.png#only-dark){ .shadow }
  <figcaption>The shortcut sheet: search commands, add or replace chords, and view conflicts.</figcaption>
</figure>

All commands share one keymap. A chord is recorded by pressing it, a command can carry a
second chord, and defaults are restored in one click. The sheet is also reachable with
++ctrl+shift+slash++.

[Every default chord :octicons-arrow-right-24:](../reference/keyboard-shortcuts.md)

## Passwords

The password vault is optional. New vaults default to the never-prompt policy, which uses
the operating-system credential store.

- **Create password vault** sets a master password of at least 8 characters.
- **Change prompt policy** chooses when routine SSH use needs the master password:
  **Never for saved credentials** stores the vault key in the OS credential store,
  **When Muxus starts** unlocks it into memory once, and **Whenever a saved credential is
  needed** prompts for each use.
- **View or edit password** asks for the master password before revealing the saved value.
- **Change master password** changes that management password without rewriting every
  credential.
- **Restore OS access** appears if the never-prompt policy is selected but the credential
  store entry is missing.
- Saved-password rows can be forgotten individually. **Delete vault** forgets all of them
  without removing hosts, keys or other settings. Reset intentionally needs no master
  password, so a forgotten password cannot make the vault impossible to remove.

The master password cannot be recovered. Saved-password ciphertext is local to the
application database and is not included in Muxus backups. The raw vault key is never
stored in the application-data directory.

## Backup & data

**Create backup** writes the Muxus-side data to a file: folders, colours, saved
Telnet/serial hosts, workspaces, tunnels and preferences. **Restore a backup** merges a file
back in; items absent from the file are not deleted.

**Export OpenSSH** writes the SSH hosts out as a standard `ssh_config` for use with another
client. Muxus-only settings remain in the backup.

!!! info "What a backup excludes"

    Private key files, passwords and recorded session history are never part of a backup.

## Debug

**Debug mode** raises the app's logging to connection-level detail: every dial, each
authentication method as it is tried, waits on the SSH agent, host key verification, and
the raw error behind a failed connection. Warnings and errors are always captured, even
while debug mode is off — a failure can be inspected after the fact, and turning on debug
mode is only needed for the verbose detail around the next attempt.

**View logs** opens a live viewer with level and text filters; **Export logs** saves
everything as a text file. Logs live in a small, bounded in-memory buffer on this machine
only — they reset when the app quits and are never written to disk or sent anywhere
unless exported.

!!! tip "When the app will not start"

    The desktop shell also writes startup milestones and crashes to `logs/main.log` in
    its application-data directory (for example `~/.config/Muxus` on Linux,
    `~/Library/Application Support/Muxus` on macOS, `%APPDATA%\Muxus` on Windows).
    A failed launch shows a dialog pointing at this file.

## About

Version and platform information, a link to the source repository, and a manual update
check. When a newer release exists, Muxus links to its GitHub release so the appropriate
installer can be downloaded.
