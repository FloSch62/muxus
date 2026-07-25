---
icon: lucide/keyboard
---

# Keyboard shortcuts

Every command lives in one keymap. This page lists the defaults; the in-app sheet
(++ctrl+shift+slash++, or **Settings → Keyboard**) lets you search, rebind and reset them.

<figure markdown="span">
  ![The keyboard shortcut sheet](../assets/screenshots/shortcuts.png#only-light){ .shadow }
  ![The keyboard shortcut sheet](../assets/screenshots/shortcuts-dark.png#only-dark){ .shadow }
  <figcaption>Record a chord by pressing it; conflicts are flagged, defaults restore in one click.</figcaption>
</figure>

!!! info "`Mod` is Ctrl, or Command on macOS"

    One default table serves every platform. Chords marked ++ctrl++ below are ++cmd++ on
    macOS. A few extra Command-only chords exist on macOS where Ctrl belongs to the shell —
    ++cmd+w++ closes a tab, ++cmd+1++ … ++cmd+9++ select one.

## Panes

| Command | Chord |
| --- | --- |
| Split pane right | ++ctrl+shift+right++ · ++alt+shift+equal++ |
| Split pane down | ++ctrl+shift+down++ · ++alt+shift+minus++ |
| Split pane left / up | ++ctrl+shift+left++ · ++ctrl+shift+up++ |
| Focus pane left / right / up / down | ++alt+left++ · ++alt+right++ · ++alt+up++ · ++alt+down++ |
| Focus next pane | ++ctrl+shift+o++ |
| Zoom pane / restore layout | ++ctrl+shift+z++ |
| Grow / shrink pane | ++ctrl+shift+period++ · ++ctrl+shift+comma++ |
| Even out panes | *(unbound by default)* |
| Close pane | ++ctrl+shift+x++ |

## Tabs

| Command | Chord |
| --- | --- |
| New tab | ++ctrl+shift+t++ |
| Duplicate tab | ++ctrl+shift+d++ |
| Close tab | ++ctrl+shift+w++ |
| Next / previous tab | ++ctrl+pgdn++ · ++ctrl+pgup++ (also ++ctrl+shift+bracket-right++ / ++ctrl+shift+bracket-left++) |
| Move tab left / right in the strip | ++ctrl+shift+pgup++ · ++ctrl+shift+pgdn++ |
| Move tab to pane left / right / up / down | ++alt+shift+left++ · ++alt+shift+right++ · ++alt+shift+up++ · ++alt+shift+down++ |
| Go to tab 1 … 8 | ++alt+1++ … ++alt+8++ |
| Go to last tab | ++alt+9++ |

## Terminal

| Command | Chord |
| --- | --- |
| Copy selection | ++ctrl+shift+c++ |
| Paste | ++ctrl+shift+v++ |
| Find in terminal | ++ctrl+shift+f++ |
| Select all output | ++ctrl+shift+a++ |
| Clear scrollback | ++ctrl+shift+k++ |
| Increase / decrease font size | ++ctrl+shift+equal++ · ++ctrl+shift+minus++ (also ++ctrl+equal++ / ++ctrl+minus++) |
| Reset font size | ++ctrl+shift+0++ · ++ctrl+0++ |

## Application

| Command | Chord |
| --- | --- |
| Quick launcher | ++ctrl+k++ |
| Toggle hosts sidebar | ++ctrl+b++ |
| Settings | ++ctrl+comma++ |
| Keyboard shortcuts | ++ctrl+shift+slash++ |

## Mouse and other gestures

| Action | Gesture |
| --- | --- |
| Zoom the terminal | ++ctrl++ + scroll wheel |
| Resize a split · reset it to half | Drag the divider · double-click it |
| Pane actions (split, zoom, close) | Right-click the tab strip |
| Rename a tab · close a tab | Double-click it · middle-click it |
| Search next / previous match | ++enter++ · ++shift+enter++ |

## Remote editor

Monaco's own bindings apply inside the [remote editor](../guide/editor.md):

| Action | Chord |
| --- | --- |
| Save file · save all | ++ctrl+s++ · ++ctrl+k++ then ++s++ |
| Find · replace | ++ctrl+f++ · ++ctrl+h++ |
| Command palette | ++f1++ · ++ctrl+shift+p++ |
| Go to line | ++ctrl+g++ |
| Format document | ++shift+alt+f++ |

## The rules behind the defaults

- **The shell keeps its keys.** ++ctrl+w++ deletes a word and ++ctrl+2++ … ++ctrl+8++ send
  their control characters, so Muxus takes ++ctrl+shift+w++ and the ++alt++ number row
  instead.
- **Keys fall through when they do not apply.** ++alt+left++ moves focus only when a pane
  is actually to the left; otherwise the shell gets it.
- **Chords follow the printed key cap.** ++ctrl+shift+z++ is the key labelled `Z` on
  QWERTZ and AZERTY too. Arrows and keys whose character a modifier mangles stay on their
  physical position.
- **Rebinding is first-class.** Add a second chord to a command, replace one, or unbind it;
  conflicts are flagged as you record.
