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

Each saved host has a **Terminal appearance** editor section where its colour scheme,
text colour and background colour can override the application defaults. Leave an option
on **Use application default** to keep following the global preference. Host overrides
apply to open terminals immediately, which makes sessions easy to identify when the tab
strip and sidebar are hidden in focus mode.

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
sidebar and the quick launcher.

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

## Keyword highlighting

Highlighting rules colour keywords in every terminal, such as `ERROR` on red and
`WARN` on amber. Each rule is one row: its colours (click the preview to change them), an
optional name saying what it is for, the keyword, and three toggles: **Aa** matches case,
**ab** matches whole words only, and **.\*** treats the keyword as a JavaScript regular
expression, such as `\b(?:up|down)\b`, `^Error:.*` for a whole line, or
`(?<!no )\bshutdown\b` to skip a negated command. An invalid pattern is flagged in the
editor and matches nothing until it is fixed.

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
Muxus release refuses them instead of matching the patterns as literal text.

A host can also carry its own additional rules. It can combine global, profile and host
rules, or disable the global set and use only its profile and host rules. See the
**Highlighting** section of the
[host editor](adding-hosts.md#session-logging-highlighting).

## Command buttons

Frequently used commands can be saved to a one-click bar above the terminal, configured to
run immediately or to be inserted for review.

[More on command buttons :octicons-arrow-right-24:](commands.md)
