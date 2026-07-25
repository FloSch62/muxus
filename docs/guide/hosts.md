---
icon: lucide/server
---

# Your hosts

The sidebar lists every concrete `Host` block in the OpenSSH configuration, including files
pulled in with `Include`, together with the Telnet and serial hosts stored by Muxus.

Muxus does not import the configuration. It reads `~/.ssh/config` directly and writes edits
back to the same file in place.

<figure markdown="span">
  ![The hosts sidebar with folders and colours](../assets/screenshots/sidebar.png#only-light){ .shadow }
  ![The hosts sidebar with folders and colours](../assets/screenshots/sidebar-dark.png#only-dark){ .shadow }
  <figcaption>Folders, colours, icons and live-session dots are stored by Muxus. The connection details come from OpenSSH.</figcaption>
</figure>

## Host rows

A row shows the host name, a host-kind icon (SSH, Telnet, serial), an optional colour flag,
and a green dot while a session to that host is live, with a count when there is more than
one.

The hover card carries the connection details:

- the **address** it resolves to (`user@hostname:port`),
- the **jump chain**, if the block has `ProxyJump`,
- the **key** that will be offered,
- **password authentication** when the block forces it,
- the number of **port forwards** started with the connection.

Click a row to connect. The right-click menu has **Connect**, **Open in new window**,
**Move up/down**, **Move to folder…**, **Organize & color…**, **Edit host**,
**Duplicate**, **Copy `ssh …` command** and **Delete host**.

## Folders

Folders are stored in the local database next to the host colour, not in `ssh_config`.
Hosts without a folder are grouped by the file they were defined in.

- **Create** a folder by right-clicking empty space in the sidebar → **New folder**, or
  nest one inside another from a folder's menu.
- **Fill** it by dragging hosts in, or from a host's **Move to folder…**.
- **Style** it with **Rename, move & style…**, which sets a colour and an icon (cloud,
  servers, storage, network, LAN, cluster, lock, lab, site).
- **Reorder** with drag & drop, or ++alt+up++ / ++alt+down++ on the focused row. Hosts keep
  the assigned order; folders sort alphabetically until moved.
- **Collapse** a folder and everything nested inside it in one action.

Deleting a folder does not delete hosts. They move up into the parent folder, and no
connection setting changes.

### Launching a folder

A folder's menu offers **Launch *n* hosts…**, which opens every host it contains, including
nested folders, as **tabs**, **columns**, **rows** or a **grid**.

<figure markdown="span">
  ![Launching a folder as a grid](../assets/screenshots/launch-group.png#only-light){ .shadow }
  ![Launching a folder as a grid](../assets/screenshots/launch-group-dark.png#only-dark){ .shadow }
  <figcaption>A folder opened as a grid of sessions.</figcaption>
</figure>

## Search and quick connect

The box at the top of the sidebar both filters and connects.

**Filtering** is token-based: every whitespace-separated word must appear somewhere in the
host's searchable text (alias, hostname, user, description, display name or folder). `af
tail` matches `MyAirframe1Tail` inside the `AF-Tails` folder. Matching folders open while
you type and return to their previous collapse state when the box is cleared.

**Enter connects** to the highest-ranked match, which is highlighted in the tree. Ranking
prefers an exact name over a prefix, a prefix over a substring, and a name match over an
address or folder match.

**Quick connect** applies when nothing matches. Type `user@host`, `host:port` or
`user@host:port` and press ++enter++ to dial it directly.

<figure markdown="span">
  ![Quick connect from the search box](../assets/screenshots/quick-connect.png#only-light){ .shadow }
  ![Quick connect from the search box](../assets/screenshots/quick-connect-dark.png#only-dark){ .shadow }
  <figcaption>An unsaved target dialled from the search box, with the option to save it as a block.</figcaption>
</figure>

When a search matches nothing, the empty state offers to add what was typed, prefilled into
the [host editor](adding-hosts.md).

## Keyboard

The tree is a `treeview`. ++arrow-down++ from the search box moves into it, arrows walk and
expand rows, ++enter++ connects, ++escape++ returns to the search box, and ++alt+up++ /
++alt+down++ reorder the focused host or folder among its siblings.

++ctrl+b++ hides the sidebar. The [quick launcher](quick-launcher.md) still reaches every
host.

## Local terminal

The first row is **Local terminal**, which opens a PTY running the login shell in a new
tab. The shell is configurable in [settings](settings.md); `auto` lets the server pick.
