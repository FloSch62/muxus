---
icon: lucide/app-window
---

# The Muxus window

One window holds the host list, the sessions, the files and the tunnels. This page names
the parts referenced elsewhere in the guide.

<figure markdown="span">
  ![The Muxus window](../assets/screenshots/overview.png#only-light){ .shadow }
  ![The Muxus window](../assets/screenshots/overview-dark.png#only-dark){ .shadow }
  <figcaption>Top bar, sidebar, and a pane canvas with browser-style tab strips.</figcaption>
</figure>

## Top bar

In the desktop app the top bar serves as the titlebar. It is a drag region, and the native
window controls sit inside it. It holds what belongs to the window and to the session in
front; everything else lives in the [sidebar](#sidebar). From left to right:

| Control | What it does |
| --- | --- |
| :material-menu: | Show/hide the sidebar, rail included (++ctrl+b++) |
| **Workspace name** | Opens the [workspace dialog](workspaces.md): save, lock, open, rename, set a startup workspace |
| :material-checkbox-multiple-marked-outline: **Multi-exec** | Type once into several sessions at once. See [multi-exec](commands.md#multi-execution) |
| :material-flash: | [Saved command buttons](commands.md) |
| :material-console: | Terminal actions: find, select all, copy all, export, logging, [Send BREAK](telnet-serial.md#send-break), [send text file](terminal.md#sending-a-text-file), clear, zoom |
| :material-image-filter-center-focus: | Focus mode: hide everything but the panes |

Below it, an optional **action bar** appears once [command buttons](commands.md) have been
saved and the bar is enabled. Each button sends its command to the focused terminal; with
several command groups, a selector at its left end switches between them. The bar can also
sit at the bottom of the window, below the panes.

## Sidebar

The sidebar is a **rail** of icons along the window edge and, beside it, one **panel** at a
time. The panel is a card that grows out of the rail icon it belongs to. Click another
icon to switch, and click the one in front again to close the panel and keep only the
rail. ++ctrl+b++ and the menu button in the top bar hide the whole sidebar.

| Rail | What it does |
| --- | --- |
| :material-server-outline: **Hosts** | The saved hosts, described below |
| :material-folder-outline: **File browser** | The [file browser](files.md) of the active SSH session, which can also [fill the window](files.md#full-size) |
| :material-cube-outline: **Containers & VMs** | The [containers and VMs](environments.md) of this computer and every connected host, with each host's listening ports |
| :material-swap-horizontal: **Port forwarding** | Saved [tunnels](tunnels.md) and the forwards on live connections; the badge counts forwards and turns amber while a tunnel [reconnects or could not start](tunnels.md#starting-with-muxus-and-reconnecting) |
| :material-pulse: **Host monitor** | The [host monitor](host-monitor.md): statistics of every connected host in one tab |
| :material-history: **Session history** | [Session history](session-history.md) |
| :material-weather-night: **Appearance** | Theme: light, dark, or follow the system |
| :material-keyboard: **Keyboard shortcuts** | [Keyboard shortcuts](../reference/keyboard-shortcuts.md), searchable and rebindable |
| :material-cog: **Settings** | [Settings](settings.md) |
| :material-pin-outline: **Pin labels** | Widen the rail so every icon keeps its label beside it |

While the rail is not pinned, pointing at an icon shows its label. The arrow keys move
between the four panels once one of their icons has focus.

The hosts panel presents saved hosts as a tree: OpenSSH `Host` blocks grouped by the file
they came from, plus user-defined folders, colours and icons. A green dot marks a host with
a live session, and a hover card shows the address, jump chain, key and auto-started
forwards. Clicking a host that already has tabs open lists them so you can jump back to
one or start another ([host rows](hosts.md#host-rows)). Hosts can also
[open with a double-click](hosts.md#opening-with-a-double-click), leaving a single click to
select them. The strip under the search box switches the tree for a
[flat list or one folder at a time](hosts.md#other-layouts), and opens the hosts as a
[tab of their own](hosts.md#the-hosts-tab).

The box at the top both filters and connects. Type an alias to filter, or `user@host:port`
to dial a target that is not saved.

The sidebar docks on the left by default. To dock it on the right, right-click empty space
in the hosts panel and choose **Move sidebar to the right**, or use **Settings → Appearance
→ Layout**. The widths and the hidden state carry over, and ++ctrl+b++ toggles it on either
side.

The hosts and the [file browser](files.md#in-the-sidebar) share one
width, so switching between them never resizes the terminals; drag the panel's edge to
change it. Containers & VMs keeps a width of its own, and port forwarding is never narrower
than its rules need. Each panel keeps its place while another is in front.

[More on hosts :octicons-arrow-right-24:](hosts.md)

## Pane canvas

The centre of the window is a canvas of resizable panes. Each pane owns a **tab strip**,
and each tab is one session: a local shell, SSH, Telnet, serial, a remote desktop, or a
remote editor.

- Drag the gap between two panes, double-click it to even them out, or move it with the
  keyboard once it has focus. The gap shows a line while the pointer is on it.
- Every tab shows a status dot (amber while connecting, green when connected, red when the
  transport is gone), its host's icon, and any colour flag assigned to it.
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

The **file browser** is a panel of the sidebar that follows the active SSH session. It can
spread over the panes to fill the window, or be popped out into its own window. Like the
other sidebar panels it is loaded lazily: its code is fetched the first time it is opened.

## Status bar

A bar along the bottom of the window describes the host of the active tab and refreshes
every few seconds:

| Item | Shows |
| --- | --- |
| **Host name** | The name the host gives itself |
| **Operating system** | Distribution and version, such as Ubuntu 24.04.1 LTS; the kernel in its tooltip |
| **CPU** | Usage across all cores since the last refresh; the core count and load average in its tooltip |
| **RAM** | Memory in use out of the total; available memory and swap in its tooltip |
| **Disk** | How full the filesystem holding `/` is (the system drive on Windows) |
| **↓ ↑** | Traffic received and sent per second on the interface of the default route |
| **Up** | Time since the host booted |
| **Users** | Login sessions, as `who` lists them; the names in its tooltip |

The meters for CPU, memory and disk turn amber at 80% and red at 95%. Right-click the bar,
or use the button at its right end, to choose the items or hide the bar; **Settings →
Appearance → Status bar** has the same choices and brings a hidden bar back. **Toggle status
bar** in the [keyboard shortcuts](../reference/keyboard-shortcuts.md) can be bound to a key.

**SSH sessions** are read over the connection that is already open: Muxus runs a short,
read-only `sh` script on an extra channel, without asking for a password again and without
installing anything. Linux hosts report every item. macOS and BSD hosts report the load
average in place of CPU usage, and BSD hosts leave out memory. A host that cannot run the
script, such as a network device or a Windows server, shows **This host does not report
statistics** and is not asked again on that connection.

The [host monitor](host-monitor.md) shows the same numbers for every connected host at once.

Muxus only opens that extra channel when the server already ran a command for it while the
session opened. Routers and console servers that offer just their CLI are never asked, and
neither are hosts with **Disable SFTP and shell integration only** or console compatibility
mode turned on: some of them drop the whole connection when a second channel asks to run a
command.

**Local terminals** show the computer they run on. Windows reports neither logged-in users
nor network traffic.

Only the tab in front is read, and nothing is read while the window is minimised or the bar
is hidden. Telnet, serial and remote desktop tabs show no statistics.

## Empty panes

A pane with no tabs shows the empty state, which offers to add a host or open a local
terminal. The sidebar's **Local terminal** row starts a PTY running the login shell in a
new tab, which is also what a fresh window provides.

## Taskbar and Dock

The Muxus icon in the taskbar or the Dock opens another window, a recent host or a recent
workspace without going through a window first.

=== ":material-microsoft-windows: Windows"

    Right-click Muxus in the taskbar:

    - **New window** opens another, empty window, or starts Muxus.
    - **Recent hosts** lists the five hosts connected most recently, and **Recent
      workspaces** the three workspaces opened most recently.

    To keep an entry at the top under **Pinned**, hover it and click the pin, or right-click
    it and choose **Pin to this list**. **Remove from this list** takes an entry out until
    Muxus restarts. The entries also work while Muxus is closed. The Microsoft Store version
    does not add them.

=== ":material-apple: macOS"

    Right-click or Control-click Muxus in the Dock. **New Window** opens another, empty
    window; **Recent Hosts** and **Recent Workspaces** list the five hosts connected and the
    three workspaces opened most recently.

=== ":material-linux: Linux"

    The launcher's menu for Muxus, in GNOME and KDE for example, offers **New Window**.

A recent host opens as a new tab in the window used last. A recent workspace opens in a
window of its own, or brings forward the window that already shows it, as the
[`--host` and `--workspace` flags](../reference/cli.md#desktop-launch-targets) do. The
lists follow new connections, renames and deletions within fifteen seconds. Saved hosts
and workspaces are opened by ID, so their entries, pinned ones included, keep working after
a rename. An entry whose host or workspace no longer exists shows a notification instead.
