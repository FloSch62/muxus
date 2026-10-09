---
icon: lucide/square-terminal
---

# The terminal

Every tab is a full [xterm.js](https://xtermjs.org/) terminal. This page covers the
protocols it implements and the settings that control it.

## Protocols

**Kitty keyboard protocol.** Muxus advertises the progressive-enhancement flag stack
(disambiguate escape codes, report event types, report alternate keys, report all keys as
escape codes, report associated text), so TUIs such as Neovim, Helix and fish receive full
key fidelity: ++ctrl+enter++, ++shift+enter++, key releases, and modifiers on keys that
otherwise have no encoding.

**`TERM`.** Sessions advertise `TERM=xterm-256color`, which is broadly supported, so remote
`terminfo` lookups resolve.

**Graphics.** Kitty graphics, sixel and iTerm2 inline images all render. See
[Images in the terminal](graphics.md).

**Shell integration.** Local shells, and bash/zsh SSH sessions, report the command
lifecycle with OSC 133/633. Muxus renders that as scrollbar marks: a command that exits
non-zero paints its line red in the overview ruler.

**Unicode 11 widths** and a **minimum contrast ratio** are enabled, so wide glyphs measure
correctly and low-contrast remote colour choices stay readable.

## Fonts and colours

The bundled stack is JetBrains Mono plus a **Nerd Font / Powerline** symbol face, so
Starship prompts, `lsd`, `eza` icons and TUI box drawing render without a local font
install. In the desktop app, the font selector reads the families installed for the
current operating-system user. `fontFamily` also accepts a custom family name; the
bundled text and symbol faces remain as fallbacks when it is unavailable or lacks a
glyph.

<figure markdown="span">
  ![The colour scheme and font settings](../assets/screenshots/settings.png#only-light){ .shadow }
  ![The colour scheme and font settings](../assets/screenshots/settings-dark.png#only-dark){ .shadow }
  <figcaption>Fifteen colour schemes, applied to open terminals on selection.</figcaption>
</figure>

Light schemes: **Paper**, **VS Code Light**, **GitHub Light**, **Gruvbox Light**,
**Catppuccin Latte**, **Solarized Light**. Dark: **VS Code Dark**, **Muxus**, **Dracula**,
**One Dark**, **Nord**, **Gruvbox Dark**, **Catppuccin Mocha**, **Monokai**, **Solarized
Dark**.

### Custom colour schemes

**Settings → Appearance → Custom color schemes** holds schemes of your own. **New** starts
one as a copy of any built-in or custom scheme; **Import** reads a colour scheme file in
one of three formats:

- a **Windows Terminal** colour scheme, as a single JSON object, a list of them, or a
  `settings.json` with a `schemes` list;
- an **iTerm2** `.itermcolors` preset, named after its file;
- a scheme file **exported** from Muxus.

Most published themes ship in at least one of these, so a palette such as Catppuccin
Frappé is one import away. The editor shows the scheme on a sample of terminal output
and edits the background, text, cursor and selection colours and the sixteen ANSI
colours; changes reach open terminals as you make them.

Custom schemes are listed first in the light and dark terminal theme pickers and in each
host's terminal appearance, and they are part of a [backup](settings.md#backup-data).
**Export scheme** writes a file to share with another Muxus installation; importing it
again updates the scheme in place. Deleting a scheme returns a terminal theme that used
it to its default, and hosts assigned to it follow the application setting again.

Each saved host has a **Terminal appearance** editor section where its colour scheme,
text colour and background colour can override the application defaults. Leave an option
on **Use application default** to keep following the global preference. Host overrides
apply to open terminals immediately, which makes sessions easy to identify when the tab
strip and sidebar are hidden in focus mode. The same section chooses the
[command button group](commands.md#a-group-per-host) the bar shows for the host and its
[paste pacing](#pasting-into-slow-consoles).

Scheme, font family, size and line height are in
[Settings → Appearance](settings.md#appearance). Cursor style (block, underline, bar),
blink, clipboard behaviour and scrollback length are in
[Settings → Terminal](settings.md#terminal). Changes apply to every open terminal
immediately.

## Local shell profiles

[Settings → Local shells](settings.md#local-shells) can save several local launch
configurations side by side, such as PowerShell, Command Prompt and individual WSL
distributions. A profile can supply executable arguments, a starting directory and commands
to run when its interactive shell starts. Saved profiles are launchable from both the hosts
sidebar and the quick launcher. On Windows, installed WSL distributions are listed there
automatically, next to the saved profiles, with the icon each distribution ships. Right-click
any of these sidebar rows to open it, save a distribution as a profile, or jump to its
settings.

### Per-tab zoom

++ctrl+plus++, ++ctrl+minus++ and ++ctrl+0++, or ++ctrl+wheel++, change the font size of
that tab only. The interface scale is a separate preference.

## Search the scrollback

++ctrl+shift+f++ opens incremental search with case sensitivity, whole word and regular
expression options. Every match is marked in the scrollbar.

<figure markdown="span">
  ![Searching the scrollback](../assets/screenshots/terminal-search.png#only-light){ .shadow }
  ![Searching the scrollback](../assets/screenshots/terminal-search-dark.png#only-dark){ .shadow }
  <figcaption>Incremental search with match positions marked in the scrollbar.</figcaption>
</figure>

## Copy, paste and export

- **Copy** ++ctrl+shift+c++, **paste** ++ctrl+shift+v++. *Copy on select* is optional.
- **Right-click** is configurable: copy-selection-otherwise-paste (the terminal
  convention), always paste, or a context menu.
- **Select all** ++ctrl+shift+a++, **copy all output** and **clear scrollback**
  ++ctrl+shift+k++ are in the terminal-actions menu.
- **Export** writes the buffer as plain text, or as **HTML that preserves the colours**.

!!! warning "Multiline paste is confirmed first"

    Pasting text that would run several shell commands opens a preview first, so a stray
    newline in a copied snippet cannot execute part of a script before it is read. It is a
    [setting](settings.md#terminal), and it is on by default.

### Pasting into slow consoles

Serial consoles and older network devices often have small input buffers and no flow
control, and their command line finishes one line before it reads the next. A long
configuration pasted all at once then loses characters or whole lines. Muxus can type a
paste in at a set pace instead:

- **Delay after each line**, in milliseconds.
- **Delay after each character**, optional, for devices that cannot keep up within a line.

Both are 0 by default, which sends a paste at once. The defaults are under
[Settings → Terminal](settings.md#terminal), and a host can set its own under **Terminal
appearance** in its editor: an empty field follows the settings, and 0 turns pacing off for
that host. The [bulk editor](hosts.md#editing-several-hosts-at-once) sets them on many hosts
at once. Local terminals use the settings.

The multiline paste preview shows the host's line delay and how long the paste will take;
a delay changed there applies to that paste only. While a paced paste runs, its progress
shows over the terminal and as a ring on the tab. **Cancel**, or a click on the ring, stops
it, and so do closing the tab and losing the connection. A paste made while another is
running waits for it to finish.

A paste sends each line break as a carriage return, the Enter key, as terminals do: CRLF
and LF in the copied text both become one CR, and every CR ends a line. The line delay
follows each one but the last. With a character delay, every character waits that long,
and a line break waits the line delay on top. Each wait starts once the connection has
taken the text before it, so on a serial port the delay begins when the line has actually
been transmitted.

The pacing runs in the Muxus backend, not in the window, so the rate stays steady while
the window is minimized or in the background, where timers in the window are slowed down.
When the program reading the paste has turned on bracketed paste mode, as bash and zsh do,
one pair of markers encloses the whole paste rather than each line, and cancelling closes
it. With [multi-execution](commands.md#multi-execution), each mirrored terminal gets the
paste at its own host's pace, independently of the others.

## Sending and receiving files

Serial, Telnet and SSH terminals can move files over the session itself with XMODEM,
YMODEM or ZMODEM. That is how an image reaches a bootloader (U-Boot `loady`, Cisco ROMMON
`xmodem`), and how files reach hosts without SFTP, such as those behind a console server
or several shells deep.

### ZMODEM starts by itself

Run `sz` or `rz` from lrzsz on the remote side and Muxus takes over:

- `sz report.tar.gz` asks whether to receive the files, naming the first one and the size
  of the batch. Each file is saved as soon as it is complete: as a browser download, or
  through the save dialog in the desktop app.
- `rz` asks for the files to send and opens a file picker. `rz` does not overwrite a file
  that already exists on its side; Muxus says which files were skipped.

Only a complete ZMODEM header with a valid checksum starts a transfer, so ordinary output,
binary output included, never does.

### Sending and receiving by hand

**Send file…** and **Receive file…** are in the terminal-actions menu, the right-click
menu and the command palette. Choose the protocol the other side speaks:

| Protocol | Typical use |
| --- | --- |
| XMODEM (checksum) | The oldest receivers; 128-byte blocks |
| XMODEM-CRC | U-Boot `loadx`, Cisco ROMMON `xmodem` |
| XMODEM-1K | Receivers that take 1024-byte blocks |
| YMODEM | U-Boot `loady`, `rb` and `sb`; batches with names and exact sizes |
| ZMODEM | `rz` and `sz`; streaming with error recovery |

Start the receiving side first: type `loady` at the U-Boot prompt, wait for it to print
`C`, then **Send file…**. To receive, start the sender (`sx file`, `sb file`), then
**Receive file…**. XMODEM carries no file name, so receiving asks for one, and the file
keeps the sender's padding up to a whole block. Sending with ZMODEM types `rz` for you, as
`sz` does.

### While a transfer runs

Terminal output pauses and keystrokes are held back until the transfer ends. A panel over
the terminal shows the file, the progress, the transfer rate and **Cancel**. Cancel sends
the CAN sequence, which stops `sz`, `rz`, `loady` and the like, and then lets the remote
side's message and prompt through again.

The transferred bytes are kept out of [session history](session-history.md) and log
files; a line such as `ZMODEM: received report.tar.gz (12 MiB)` records the transfer
instead. On Telnet, Muxus switches the connection to TRANSMIT-BINARY for the transfer and
back afterwards, and escapes IAC bytes, so every byte value arrives intact.

!!! note "Software flow control"

    XMODEM and YMODEM send raw bytes, so a serial port set to XON/XOFF flow control can
    swallow parts of a block. Use RTS/CTS or no flow control for them; ZMODEM escapes
    XON and XOFF and works either way.

## Keyword highlighting

Highlighting rules colour keywords in every terminal, such as `ERROR` on red and
`WARN` on amber. Each rule is one row: its colours (click the preview to change them), an
optional name saying what it is for, the keyword, and three toggles: **Aa** matches case,
**ab** matches whole words only, and **.\*** treats the keyword as a JavaScript regular
expression, such as `\b(?:up|down)\b`, `^Error:.*` for a whole line, or
`(?<!no )\bshutdown\b` to skip a negated command. An invalid pattern is flagged in the
editor and matches nothing until it is fixed.

Regular expressions are matched in a background worker, so a pattern that backtracks for
too long cannot freeze the terminal. If one pattern keeps the worker busy for more than a
quarter of a second, Muxus pauses it for the rest of the session, shows a notice, and
marks it in the editor; the other rules keep working, and changing the pattern tries it
again.

**Edit as JSON** opens any rule list as text, which is quicker for bulk changes or for
pasting rules from elsewhere. `keyword` and `foreground` are required; `name`, `background`,
`regex`, `caseSensitive` and `wholeWord` are optional. **Apply** checks the whole list and
names the first rule with a problem; nothing changes until it applies cleanly.

<figure markdown="span">
  ![Keyword highlighting rules](../assets/screenshots/settings-highlighting.png#only-light){ .shadow }
  ![Keyword highlighting rules](../assets/screenshots/settings-highlighting-dark.png#only-dark){ .shadow }
  <figcaption>Global rules, with per-host rules that add to them or replace them.</figcaption>
</figure>

A named highlighting profile can hold a platform-specific rule set and be assigned to any
number of SSH, Telnet or serial hosts. Profiles can be imported and exported as JSON files
from **Settings → Highlighting**, one at a time or with **Export all**, so a rule set can be
shared without recreating it. Editing a profile updates every assigned open terminal.

Muxus ships two profiles, **Nokia SR OS** and **Nokia SR Linux**. They colour operational
and administrative states, BGP session states, alarm severities, CLI errors, IPv4/IPv6 and
MAC addresses, ports or interfaces, and the configuration-mode context of the MD-CLI and
SR Linux prompts. They are ordinary profiles: assign them to your routers, edit them, and
export them like any other. **Built-in** adds one back after it was deleted, or resets it to
the shipped rules; hosts assigned to it keep the assignment.

Files exported from a profile that uses regex rules are marked as version 2, so an older
Muxus release refuses them instead of matching the patterns as literal text. For the same
reason, a version 1 file that contains regex rules is rejected on import.

A host can also carry its own additional rules. It can combine global, profile and host
rules, or disable the global set and use only its profile and host rules. See the
**Highlighting** section of the
[host editor](adding-hosts.md#session-logging-highlighting).

## Command buttons

Frequently used commands can be saved to a one-click bar above the terminal, configured to
run immediately or to be inserted for review. They can be colour-coded and sorted into
groups, such as one per vendor, and a host can switch the bar to its own group.

[More on command buttons :octicons-arrow-right-24:](commands.md)
