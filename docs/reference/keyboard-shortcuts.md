---
icon: lucide/keyboard
---

# Keyboard shortcuts

All commands share one keymap. This page lists the defaults. The in-app sheet
(++ctrl+shift+slash++, or **Settings → Keyboard**) supports searching, rebinding and
resetting them.

<figure markdown="span">
  ![The keyboard shortcut sheet](../assets/screenshots/shortcuts.png#only-light){ .shadow }
  ![The keyboard shortcut sheet](../assets/screenshots/shortcuts-dark.png#only-dark){ .shadow }
  <figcaption>A chord is recorded by pressing it. Conflicts are flagged, and defaults are restored in one click.</figcaption>
</figure>

!!! info "`Mod` is Ctrl, or Command on macOS"

    Chords marked ++ctrl++ below are ++cmd++ on macOS. A few extra Command-only chords
    exist on macOS where Ctrl belongs to the shell: ++cmd+w++ closes a tab, and
    ++cmd+1++ … ++cmd+9++ select one.

## Panes

| Command | Chord |
| --- | --- |
| Split pane right | ++ctrl+shift+right++, ++alt+shift+equal++ |
| Split pane down | ++ctrl+shift+down++, ++alt+shift+minus++ |
| Split pane left / up | ++ctrl+shift+left++, ++ctrl+shift+up++ |
| Focus pane left / right / up / down | ++alt+left++, ++alt+right++, ++alt+up++, ++alt+down++ |
| Focus next pane | ++ctrl+shift+o++ |
| Zoom pane / restore layout | ++ctrl+shift+z++ |
| Grow / shrink pane | ++ctrl+shift+period++, ++ctrl+shift+comma++ |
| Even out panes | *(unbound by default)* |
| Close pane | ++ctrl+shift+x++ |

## Tabs

| Command | Chord |
| --- | --- |
| New tab | ++ctrl+shift+t++ |
| Duplicate tab | ++ctrl+shift+d++ |
| Close tab | ++ctrl+shift+w++ |
| Next / previous tab | ++ctrl+pgdn++, ++ctrl+pgup++ (also ++ctrl+shift+bracket-right++ / ++ctrl+shift+bracket-left++) |
| Move tab left / right in the strip | ++ctrl+shift+pgup++, ++ctrl+shift+pgdn++ |
| Move tab to pane left / right / up / down | ++alt+shift+left++, ++alt+shift+right++, ++alt+shift+up++, ++alt+shift+down++ |
| Go to window-wide tab 1 … 9 | ++alt+1++ … ++alt+9++ |

## Terminal

| Command | Chord |
| --- | --- |
| Copy selection | ++ctrl+shift+c++ |
| Paste | ++ctrl+v++, ++ctrl+shift+v++ |
| Show [saved command menu](../guide/commands.md#keyboard-menu) | ++ctrl+space++ |
| Find in terminal | ++ctrl+shift+f++ |
| Select all output | ++ctrl+shift+a++ |
| Clear scrollback | ++ctrl+shift+k++ |
| Toggle [multi-execution](../guide/commands.md#multi-execution) | ++ctrl+shift+m++ |
| Increase / decrease font size | ++ctrl+shift+equal++, ++ctrl+shift+minus++ (also ++ctrl+equal++ / ++ctrl+minus++) |
| Reset font size | ++ctrl+shift+0++, ++ctrl+0++ |

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
| Open a terminal path in the editor | Hover for an underline, then left-click |
| Resize a split, reset it to half | Drag the divider, double-click it |
| Pane actions (split, zoom, close) | Right-click the tab strip |
| Rename a tab, close a tab | Double-click it, middle-click it |
| Search next / previous match | ++enter++, ++shift+enter++ |

## File editor

Monaco's own bindings apply inside the [file editor](../guide/editor.md):

| Action | Chord |
| --- | --- |
| Save file, save all | ++ctrl+s++, ++ctrl+k++ then ++s++ |
| Find, replace | ++ctrl+f++, ++ctrl+h++ |
| Command palette | ++f1++, ++ctrl+shift+p++ |
| Go to line | ++ctrl+g++ |
| Format document | ++shift+alt+f++ |

## Default binding rules

- **The shell keeps its keys.** ++ctrl+w++ deletes a word and ++ctrl+2++ … ++ctrl+8++ send
  their control characters, so Muxus uses ++ctrl+shift+w++ and the ++alt++ number row.
- **Numbered tabs are window-wide.** Hold ++alt++ to reveal the number on every tab;
  ++alt+1++ … ++alt+9++ activate those exact tabs across all panes.
- **Keys fall through when they do not apply.** ++alt+left++ moves focus only when a pane
  is to the left; otherwise the shell receives it.
- **Chords follow the printed key cap.** ++ctrl+shift+z++ is the key labelled `Z` on QWERTZ
  and AZERTY. Arrows and keys whose character a modifier mangles use their physical
  position.
- **Rebinding is supported.** A command can take a second chord, replace one, or be
  unbound. Conflicts are flagged during recording.
