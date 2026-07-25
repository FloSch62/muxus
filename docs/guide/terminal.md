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
install. `fontFamily` accepts any installed family; the symbol face remains as a fallback
for missing glyphs.

<figure markdown="span">
  ![The colour scheme and font settings](../assets/screenshots/settings.png#only-light){ .shadow }
  ![The colour scheme and font settings](../assets/screenshots/settings-dark.png#only-dark){ .shadow }
  <figcaption>Fifteen colour schemes, applied to open terminals on selection.</figcaption>
</figure>

Light schemes: **Paper**, **VS Code Light**, **GitHub Light**, **Gruvbox Light**,
**Catppuccin Latte**, **Solarized Light**. Dark: **VS Code Dark**, **Muxus**, **Dracula**,
**One Dark**, **Nord**, **Gruvbox Dark**, **Catppuccin Mocha**, **Monokai**, **Solarized
Dark**.

Scheme, font family, size and line height are in
[Settings → Appearance](settings.md#appearance). Cursor style (block, underline, bar),
blink, clipboard behaviour and scrollback length are in
[Settings → Terminal](settings.md#terminal). Changes apply to every open terminal
immediately.

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

Highlighting rules colour literal keywords in every terminal, such as `ERROR` on red and
`WARN` on amber. Each rule has a foreground, an optional background, and case-sensitive and
whole-word switches.

<figure markdown="span">
  ![Keyword highlighting rules](../assets/screenshots/settings-highlighting.png#only-light){ .shadow }
  ![Keyword highlighting rules](../assets/screenshots/settings-highlighting-dark.png#only-dark){ .shadow }
  <figcaption>Global rules, with per-host rules that add to them or replace them.</figcaption>
</figure>

A host can carry its own rules, either in addition to the global set or instead of it. See
the **Highlighting** section of the
[host editor](adding-hosts.md#session-logging-highlighting).

## Command buttons

Frequently used commands can be saved to a one-click bar above the terminal, configured to
run immediately or to be inserted for review.

[More on command buttons :octicons-arrow-right-24:](commands.md)
