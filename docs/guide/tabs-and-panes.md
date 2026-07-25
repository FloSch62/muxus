---
icon: lucide/columns-3
---

# Tabs & panes

The tmux workflow without the prefix dance. Panes split, tabs move between them, and
nothing you do to the layout disturbs a running session.

<figure markdown="span">
  ![Three panes, each with its own tab strip](../assets/screenshots/panes.png#only-light){ .shadow }
  ![Three panes, each with its own tab strip](../assets/screenshots/panes-dark.png#only-dark){ .shadow }
  <figcaption>Split in any direction; the new pane continues the session you were in.</figcaption>
</figure>

## Splitting

++ctrl+shift+left++ / ++ctrl+shift+right++ / ++ctrl+shift+up++ / ++ctrl+shift+down++
splits the focused pane toward that side. The new pane **continues the current session**:
the SSH connection is reused, so there is no second login and no second 2FA prompt. Turn
that off in [Settings → Keyboard](settings.md#keyboard) and the new pane asks what to
start instead — serial consoles always ask, because a serial port has one reader.

++alt+shift+equal++ and ++alt+shift+minus++ do the same thing for the two splits you
reach for most, and the tab strip's own split buttons are always there for the mouse.

## Moving around

| Chord | What happens |
| --- | --- |
| ++alt+left++ / ++alt+right++ / ++alt+up++ / ++alt+down++ | Focus the pane the eye expects, geometrically |
| ++ctrl+shift+o++ | Focus the next pane |
| ++alt+shift+left++ … | Send the current tab to the neighbouring pane — splitting one off when there is none |
| ++ctrl+shift+z++ | Zoom the focused pane to the whole canvas, and back |
| ++ctrl+shift+period++ / ++ctrl+shift+comma++ | Grow / shrink the focused pane |
| ++ctrl+shift+x++ | Close the pane |

!!! tip "Focus keys fall through to the shell"

    ++alt+left++ moves focus **only when a pane actually sits to the left**. When there is
    none, the key goes to the shell, so ++alt+left++ still moves a word in readline. A
    command that is not applicable right now never steals its key.

Drag a divider to resize, double-click it to even the split out, or give it focus and use
the arrows. **Even out panes** in the pane menu balances everything at once.

## Tabs

Each pane has a browser-style tab strip. A tab is one session — local shell, SSH, Telnet,
serial, or a remote editor.

<figure markdown="span">
  ![The tab context menu](../assets/screenshots/tab-menu.png#only-light){ .shadow }
  ![The tab context menu](../assets/screenshots/tab-menu-dark.png#only-dark){ .shadow }
  <figcaption>Rename, duplicate, flag with a colour, pop out into a window, add to multi-exec — and, once a session has dropped, reconnect.</figcaption>
</figure>

- **New tab** — ++ctrl+shift+t++, or the **+** in the strip.
- **Close** — ++ctrl+shift+w++ (++cmd+w++ on macOS). Not ++ctrl+w++: that deletes a word
  in every shell, and Muxus does not take keys the shell needs.
- **Switch** — ++alt+1++ … ++alt+9++ by position (++alt+9++ is always the last tab), or
  ++ctrl+pgup++ / ++ctrl+pgdn++.
- **Reorder** — ++ctrl+shift+pgup++ / ++ctrl+shift+pgdn++, or drag.
- **Rename** — double-click the title.
- **Duplicate** — ++ctrl+shift+d++ opens a second session on the same host.
- **Colour flags** — right-click → pick a colour, so the production box is never mistaken
  for staging.
- **Open in new window** — the tab moves into its own window, still on the same transport.

Each tab shows a status dot: amber while connecting, green when connected, red when the
transport is gone.

## Panes and tabs are one system

- Closing the **last tab of a split pane** takes the pane with it.
- Moving a tab to a direction where **no pane exists** splits one off.
- Layout changes never remount a terminal, so your shell, scrollback and SSH channel
  survive every split, close and move.
- Keystrokes typed into a pane that is **still connecting** are delivered as soon as it is
  ready — start typing before the prompt arrives and nothing is lost.

## About the chords

Muxus takes as little from the shell as possible:

- ++ctrl+w++ deletes a word; ++ctrl+2++ … ++ctrl+8++ send their control characters. That
  is why closing is ++ctrl+shift+w++ and tabs answer to ++alt+1++ … ++alt+9++.
- Chords follow the **character printed on the key cap**, so QWERTZ and AZERTY keyboards
  press the key they read — ++ctrl+shift+z++ is the key labelled `Z`. Arrows and keys
  whose character a modifier mangles stay on their physical position.
- ++ctrl+plus++ / ++ctrl+minus++ / ++ctrl+0++ zoom the **terminal font** and nothing else.
  The interface scale is a [preference](settings.md), never a chord the shell could trip
  over.

Everything is one keymap: search it in the [quick launcher](quick-launcher.md), or review
and rebind it in the keyboard sheet (++ctrl+shift+slash++).

[The full list :octicons-arrow-right-24:](../reference/keyboard-shortcuts.md)
