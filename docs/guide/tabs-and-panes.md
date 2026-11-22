---
icon: lucide/columns-3
---

# Tabs & panes

Panes split in any direction, tabs move between them, and layout changes do not disturb a
running session.

<figure markdown="span">
  ![Three panes, each with its own tab strip](../assets/screenshots/panes.png#only-light){ .shadow }
  ![Three panes, each with its own tab strip](../assets/screenshots/panes-dark.png#only-dark){ .shadow }
  <figcaption>Three panes in one window, each with its own tab strip.</figcaption>
</figure>

## Splitting

++ctrl+shift+left++ / ++ctrl+shift+right++ / ++ctrl+shift+up++ / ++ctrl+shift+down++ splits
the focused pane toward that side. The new pane **continues the current session**: the SSH
connection is reused, so there is no second login and no second 2FA prompt. This is
configurable in [Settings → Keyboard](settings.md#keyboard); with it off, the new pane asks
what to start. Serial consoles always ask, because a serial port supports one reader.

++alt+shift+equal++ and ++alt+shift+minus++ are alternative chords for the two most common
splits, and the tab strip has split buttons for the mouse.

## Moving around

| Chord | What happens |
| --- | --- |
| ++alt+left++ / ++alt+right++ / ++alt+up++ / ++alt+down++ (++cmd+option++ and an arrow on macOS) | Focus the pane in that direction, geometrically |
| ++ctrl+shift+o++ | Focus the next pane |
| ++alt+shift+left++ … | Send the current tab to the neighbouring pane, splitting one off when there is none |
| ++ctrl+shift+z++ | Zoom the focused pane to the whole canvas, and back |
| ++ctrl+shift+period++ / ++ctrl+shift+comma++ | Grow / shrink the focused pane |
| ++ctrl+shift+x++ | Close the pane |

!!! tip "Focus keys fall through to the shell"

    ++alt+left++ moves focus **only when a pane sits to the left**. When there is none, the
    key is passed to the shell, so ++alt+left++ still moves a word in readline. On macOS,
    where ++option+left++ and ++option+right++ [jump by word](terminal.md#protocols) in
    every pane, focus moves with ++cmd+option+left++ … instead.

Drag a divider to resize it, double-click it to even the split, or give it focus and use
the arrows. **Even out panes** in the pane menu balances the whole layout.

**Arrange tabs**, the button after the split buttons in each tab strip, lays out all the
tabs of the window at once, and keeps them that way. The pane menu offers the same, also in
a pane too narrow for the button. Tiling gives each tab a pane of its own; the panes fill a
column from the top, then the next column, in the order of the tab numbers, so the numbers
stay the same. **Tile tabs vertically** sets them side by side, **Tile tabs horizontally**
stacks them, and both wrap into a grid as tabs are added:

| Open tabs | Tile tabs vertically | Tile tabs horizontally |
| --- | --- | --- |
| 2 or 3 | Side by side | Stacked |
| 4 | 2 columns of 2 | 2 columns of 2 |
| 6 | 3 columns of 2 | 2 columns of 3 |
| 8 | 4 columns of 2 | 2 columns of 4 |
| 10 | 3 columns: 3, 3 and 4 | 3 columns: 3, 3 and 4 |
| 12 | 4 columns of 3 | 3 columns of 4 |

Columns share the width evenly and the panes of a column share its height; when the tabs do
not divide evenly, the last columns take one more.

Tiling stays on, checked in both menus. A session opened from the sidebar, the quick
launcher or ++ctrl+shift+t++ gets a pane of its own at the end and the grid is laid out
again, as it is when a tab or a pane closes; a zoomed pane then goes back into the grid.
Zooming keeps tiling on. Adding a tab to a pane yourself, with the **+** of its strip or by
dropping a host or a tab on it, ends tiling, and so do splitting, moving a tab, dragging a
divider, growing or shrinking a pane, **Even out panes** and launching a host group: new
sessions join the focused pane again. **Tabs** puts all the tabs back in one pane, pinned
tabs first, and ends tiling too. A saved workspace keeps it.

Sessions keep running through all of this, and the focused tab keeps the focus. The three
commands are in the [quick launcher](quick-launcher.md) too; give them a chord in the
keyboard sheet.

## Tabs

Each pane has a browser-style tab strip. A tab is one session: local shell, SSH, Telnet,
serial, a remote desktop, or a remote editor.

<figure markdown="span">
  ![The tab context menu](../assets/screenshots/tab-menu.png#only-light){ .shadow }
  ![The tab context menu](../assets/screenshots/tab-menu-dark.png#only-dark){ .shadow }
  <figcaption>The tab menu: pin, rename, duplicate, colour flag, open in a window, add to multi-exec, and reconnect.</figcaption>
</figure>

- **New tab**: ++ctrl+shift+t++, or the **+** in the strip.
- **Close**: ++ctrl+shift+w++ (++cmd+w++ on macOS). Not ++ctrl+w++, which deletes a word in
  the shell. With **Close the tab when its shell exits** under
  [Settings → Behavior](settings.md#behavior), `exit` or ++ctrl+d++ closes the tab too.
- **Switch**: hold ++alt++ to reveal each tab's window-wide number, then use ++alt+1++ …
  ++alt+9++ to activate that exact tab wherever it lives. **Settings → Keyboard** can keep
  the numbers visible all the time. ++ctrl+pgup++ / ++ctrl+pgdn++ still cycle within the
  focused pane.
- **Reorder or move**: ++ctrl+shift+pgup++ / ++ctrl+shift+pgdn++ reorders in the current
  strip. Drag a tab to an exact position in this strip, another split, or another Muxus
  window. A cross-window drop hands off the live terminal and restores its scrollback.
- **Pin**: choose **Pin tab** from the right-click menu. Pinned tabs stay at the left of the
  strip, keep their own drag order, and are preserved by **Close other tabs**.
- **Rename**: double-click the title.
- **Duplicate**: ++ctrl+shift+d++ opens a second session on the same host.
- **Colour flags**: assigned from the right-click menu.
- **Open in new window**: opens the same profile as a fresh session in its own window.

Each tab shows a status dot: amber while connecting, green when connected, red when the
transport is gone.

### Program status

Programs that report their state with OSC 7501, the Program Status Protocol, mark their
tab next to the title. Coding agents and some build and package tools do this:

| Mark | Meaning |
| --- | --- |
| A blue ring | The program is working; it fills up when the program reports progress |
| An amber question mark | The program is waiting for you: a permission, an answer or a sign-in |
| A green check | The program finished; shown until you switch to the tab |
| A red cross | The program failed; shown until you switch to the tab |

Hover the mark for what the program reported. Working and waiting end at the next shell
prompt or when the session ends. When several programs in one tab report, the tab shows the
most urgent one. Muxus answers the protocol's support query only while the feature is on;
turn it off with **Show program status on tabs** under
[Settings → Behavior](settings.md#behavior).

Tab numbers follow depth-first split-tree order: at every split the left or top branch comes
before the right or bottom branch, then tabs are numbered left-to-right inside each strip.
Splitting, moving, reordering or closing tabs and panes recalculates the sequence immediately.
Every tab displays its sequential number; the first nine have default single-digit shortcuts.

## Interaction between panes and tabs

- Closing the **last tab of a split pane** closes the pane.
- Moving a tab toward a direction where **no pane exists** splits one off.
- Layout changes never remount a terminal, so the shell, scrollback and SSH channel survive
  every split, close and move.
- Dragging a connected tab between **Muxus windows** transfers ownership of its running
  backend session; it does not start a second login.
- Keystrokes typed into a pane that is **still connecting** are delivered once it is ready.

## Default chord selection

Muxus takes as few keys from the shell as possible:

- ++ctrl+w++ deletes a word, and ++ctrl+2++ … ++ctrl+8++ send their control characters.
  Closing is therefore ++ctrl+shift+w++, and window-wide tab selection uses
  ++alt+1++ … ++alt+9++.
- Chords follow the **character printed on the key cap**, so ++ctrl+shift+z++ is the key
  labelled `Z` on QWERTZ and AZERTY. Arrows and keys whose character a modifier mangles use
  their physical position.
- ++ctrl+plus++ / ++ctrl+minus++ / ++ctrl+0++ zoom the **terminal font** only. The interface
  scale is a [preference](settings.md) rather than a chord.

All commands share one keymap. Search it in the [quick launcher](quick-launcher.md), or
review and rebind it in the keyboard sheet (++ctrl+shift+slash++).

[The full list :octicons-arrow-right-24:](../reference/keyboard-shortcuts.md)
