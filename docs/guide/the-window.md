---
icon: lucide/app-window
---

# The Muxus window

One window holds the host list, the sessions, the files and the tunnels. This page names
the parts referenced elsewhere in the guide.

<figure markdown="span">
  ![The Muxus window](../assets/screenshots/overview.png#only-light){ .shadow }
  ![The Muxus window](../assets/screenshots/overview-dark.png#only-dark){ .shadow }
  <figcaption>Top bar, hosts sidebar, and a pane canvas with browser-style tab strips.</figcaption>
</figure>

## Top bar

In the desktop app the top bar serves as the titlebar. It is a drag region, and the native
window controls sit inside it. From left to right:

| Control | What it does |
| --- | --- |
| :material-menu: | Show/hide the hosts sidebar (++ctrl+b++) |
| **Workspace name** | Opens the [workspace dialog](workspaces.md): save, lock, open, rename, set a startup workspace |
| :material-checkbox-multiple-marked-outline: **Multi-exec** | Type once into several sessions at once. See [multi-exec](commands.md#multi-execution) |
| :material-flash: | [Saved command buttons](commands.md) |
| :material-folder-outline: | The [file browser](files.md) for the active SSH tab |
| :material-swap-horizontal: | The [forwarding panel](tunnels.md); the badge counts active forwards |
| :material-console: | Terminal actions: find, select all, copy all, export, logging, clear, zoom |
| :material-history: | [Session history](session-history.md) |
| :material-weather-night: | Theme: light → dark → follow system |
| :material-keyboard: | [Keyboard shortcuts](../reference/keyboard-shortcuts.md), searchable and rebindable |
| :material-cog: | [Settings](settings.md) |

Below it, an optional **action bar** appears once [command buttons](commands.md) have been
saved and the bar is enabled. Each button sends its command to the focused terminal.

## Hosts sidebar

The sidebar presents saved hosts as a tree: OpenSSH `Host` blocks grouped by the file they
came from, plus user-defined folders, colours and icons. A green dot marks a host with a
live session, and a hover card shows the address, jump chain, key and auto-started
forwards.

The box at the top both filters and connects. Type an alias to filter, or `user@host:port`
to dial a target that is not saved.

[More on hosts :octicons-arrow-right-24:](hosts.md)

## Pane canvas

The centre of the window is a canvas of resizable panes. Each pane owns a **tab strip**,
and each tab is one session: a local shell, SSH, Telnet, serial, or a remote editor.

- Drag the divider between panes, double-click it to even them out, or move it with the
  keyboard once it has focus.
- Every tab shows a status dot (amber while connecting, green when connected, red when the
  transport is gone), its host-kind icon, and any colour flag assigned to it.
- Double-click a tab to rename it. The right-click menu has close, duplicate, colour flags,
  open in a new window and reconnect.

Panes and tabs form one system: closing the last tab of a split pane closes the pane, and
moving a tab toward a direction with no pane splits one off.

[More on tabs & panes :octicons-arrow-right-24:](tabs-and-panes.md)

!!! note "Layout changes and running sessions"

    Panes, tab contents and dividers are siblings in one absolutely positioned layer.
    Reshaping the tree only moves boxes, so terminals are never unmounted. Splitting,
    closing and moving tabs keep every shell, scrollback and SSH channel alive.

## Side panels

- The **file browser** opens inside the active SSH tab, to the right of the terminal, and
  can be popped out into its own window.
- The **forwarding panel** docks on the right of the window and lists saved tunnels plus
  the forwards running on each live connection.

Both are loaded lazily. Their code is fetched the first time the button is used.

## Empty panes

A pane with no tabs shows the empty state, which offers to add a host or open a local
terminal. The sidebar's **Local terminal** row starts a PTY running the login shell in a
new tab, which is also what a fresh window provides.
