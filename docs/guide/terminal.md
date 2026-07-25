---
icon: lucide/square-terminal
---

# The terminal

Every tab is a full [xterm.js](https://xtermjs.org/) terminal — the modern one, not a
compatibility layer. This page covers what it can do and how to bend it to your taste.

## Protocols

**Kitty keyboard protocol.** Muxus advertises the progressive-enhancement flag stack
(disambiguate escape codes, report event types, report alternate keys, report all keys as
escape codes, report associated text), so modern TUIs — Neovim, Helix, fish — receive full
key fidelity: ++ctrl+enter++, ++shift+enter++, key releases, modifiers on keys that
historically had nowhere to put them.

**`TERM`.** Sessions advertise the broadly supported `TERM=xterm-256color`, so remote
tools behave and `terminfo` lookups never fail on an exotic name.

**Graphics.** Kitty graphics, sixel and iTerm2 inline images all render — see
[Images in the terminal](graphics.md).

**Shell integration.** Local shells (and bash/zsh SSH sessions) report the command
lifecycle with OSC 133/633. Muxus turns that into scrollbar marks: a command that exits
non-zero paints its line red in the overview ruler, the way VS Code does.

**Unicode 11 widths** and a **minimum contrast ratio** are on, so wide glyphs measure
correctly and a remote tool's unfortunate colour choice stays readable.

## Fonts and colours

The bundled stack is JetBrains Mono plus a **Nerd Font / Powerline** symbol face, so
Starship prompts, `lsd`, `eza` icons and TUI box drawing look right with no local font
install. Point `fontFamily` at anything you like; the symbol face stays as a fallback for
the glyphs your font does not have.

<figure markdown="span">
  ![The colour scheme and font settings](../assets/screenshots/settings.png#only-light){ .shadow }
  ![The colour scheme and font settings](../assets/screenshots/settings-dark.png#only-dark){ .shadow }
  <figcaption>Fifteen schemes, applied to open terminals the moment you pick one.</figcaption>
</figure>

Light schemes: **Paper**, **VS Code Light**, **GitHub Light**, **Gruvbox Light**,
**Catppuccin Latte**, **Solarized Light**. Dark: **VS Code Dark**, **Muxus**, **Dracula**,
**One Dark**, **Nord**, **Gruvbox Dark**, **Catppuccin Mocha**, **Monokai**, **Solarized
Dark**.

Scheme, font family, size and line height live in
[Settings → Appearance](settings.md#appearance); cursor style (block, underline, bar),
blink, clipboard behaviour and how many lines of scrollback to keep are in
[Settings → Terminal](settings.md#terminal). Changes apply to every open terminal
immediately.

### Per-tab zoom

++ctrl+plus++, ++ctrl+minus++ and ++ctrl+0++ — or ++ctrl+wheel++ — change the font size of
**that tab only**, and nothing else. The scale of the whole interface is a separate
preference, so a chord can never surprise the shell.

## Search the scrollback

++ctrl+shift+f++ opens incremental search: case sensitivity, whole word and regular
expressions, with every match marked in the scrollbar so you can see where they are.

<figure markdown="span">
  ![Searching the scrollback](../assets/screenshots/terminal-search.png#only-light){ .shadow }
  ![Searching the scrollback](../assets/screenshots/terminal-search-dark.png#only-dark){ .shadow }
  <figcaption>Find, next, previous — and the scrollbar shows the shape of the answer.</figcaption>
</figure>

## Copy, paste and export

- **Copy** ++ctrl+shift+c++, **paste** ++ctrl+shift+v++. Optional *copy on select*.
- **Right-click** is configurable: copy-selection-otherwise-paste (the terminal
  convention), always paste, or a context menu.
- **Select all** ++ctrl+shift+a++, **copy all output**, and **clear scrollback**
  ++ctrl+shift+k++ live in the terminal-actions menu.
- **Export** the buffer as plain text, or as **HTML that keeps the colours** — useful for
  pasting a failure into a ticket exactly as it looked.

!!! warning "Multiline paste is confirmed first"

    Pasting text that would run several shell commands opens a preview first, so a stray
    newline in a copied snippet cannot execute half a script before you can read it. It is
    a [setting](settings.md#terminal), and it is on by default.

## Keyword highlighting

Rules that colour literal keywords in every terminal — `ERROR` on red, `WARN` on amber,
whatever your logs shout at you. Each rule has a foreground, an optional background, and
case-sensitive / whole-word switches.

<figure markdown="span">
  ![Keyword highlighting rules](../assets/screenshots/settings-highlighting.png#only-light){ .shadow }
  ![Keyword highlighting rules](../assets/screenshots/settings-highlighting-dark.png#only-dark){ .shadow }
  <figcaption>Global rules, with per-host rules that add to them or replace them.</figcaption>
</figure>

A host can carry its own rules — see the **Highlighting** section of the
[host editor](adding-hosts.md#session-logging-highlighting) — either *in addition to* the
global set or *instead of* it.

## Command buttons

Commands you run constantly can live in a one-click bar above the terminal, running
immediately or being inserted for review first.

[More on command buttons :octicons-arrow-right-24:](commands.md)
