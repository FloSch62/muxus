---
icon: lucide/server
---

# Your hosts

The sidebar is your host manager. It shows every concrete `Host` block in your OpenSSH
configuration — including the files it pulls in with `Include` — next to the Telnet and
serial hosts Muxus saves itself.

Nothing is imported. Muxus reads `~/.ssh/config` directly and writes edits back into the
same file, in place. Delete Muxus tomorrow and your config is still your config.

<figure markdown="span">
  ![The hosts sidebar with folders and colours](../assets/screenshots/sidebar.png#only-light){ .shadow }
  ![The hosts sidebar with folders and colours](../assets/screenshots/sidebar-dark.png#only-dark){ .shadow }
  <figcaption>Folders, colours, icons and live-session dots are Muxus's; the connection details are OpenSSH's.</figcaption>
</figure>

## What a row shows

A row spends its width on the name — everything else is reference material you read
rather than act on, so it lives in the hover card:

- the **address** it resolves to (`user@hostname:port`),
- the **jump chain**, if the block has `ProxyJump`,
- the **key** that will be offered,
- **password authentication** when the block forces it,
- how many **port forwards** start with the connection.

On the row itself you get the host-kind icon (SSH, Telnet, serial), your colour flag, and
a green dot while a session to that host is live — with a count when there is more than
one.

Click a row to connect. Right-click for the rest: **Connect**, **Open in new window**,
**Move up/down**, **Move to folder…**, **Organize & color…**, **Edit host**,
**Duplicate**, **Copy `ssh …` command**, and **Delete host**.

## Folders

Folders are Muxus's own layer — a host's folder is stored next to its colour in the local
database, never in your `ssh_config`. Hosts without a folder keep the grouping OpenSSH
already gives them: the file they were defined in.

- **Create one** by right-clicking empty space in the sidebar → **New folder**, or nest
  one inside another from a folder's menu.
- **Fill it** by dragging hosts in, or from a host's **Move to folder…**.
- **Style it** with **Rename, move & style…** — a colour and an icon (cloud, servers,
  storage, network, LAN, cluster, lock, lab, site).
- **Reorder** with drag & drop, or ++alt+up++ / ++alt+down++ on the focused row. Hosts keep
  the order you give them; folders sort alphabetically unless you move them.
- **Collapse** a folder and everything nested inside it in one action.

Deleting a folder never deletes hosts — they move up into the parent folder, and no
connection setting changes.

### Launch a whole folder

A folder's menu offers **Launch *n* hosts…**: open every host it contains (including
nested folders) as **tabs**, **columns**, **rows** or a **grid**.

<figure markdown="span">
  ![Launching a folder as a grid](../assets/screenshots/launch-group.png#only-light){ .shadow }
  ![Launching a folder as a grid](../assets/screenshots/launch-group-dark.png#only-dark){ .shadow }
  <figcaption>One click turns a folder into a working layout.</figcaption>
</figure>

## Search and quick connect

The box at the top of the sidebar does both jobs.

**Filtering** is token-based: every whitespace-separated word has to appear somewhere in
the host's searchable text — alias, hostname, user, description, display name or folder.
So `af tail` finds `MyAirframe1Tail` inside the `AF-Tails` folder. Matching folders open
automatically while you type and snap back to your own collapse state when you clear the
box.

**Enter connects.** The best match is highlighted in the tree, and it beats the merely
plausible ones: an exact name wins over a prefix, a prefix over a substring, and a hit in
the name over a hit in the address or folder.

**Quick connect** takes over when nothing matches: type `user@host`, `host:port` or
`user@host:port` and press ++enter++ to dial it straight away.

<figure markdown="span">
  ![Quick connect from the search box](../assets/screenshots/quick-connect.png#only-light){ .shadow }
  ![Quick connect from the search box](../assets/screenshots/quick-connect-dark.png#only-dark){ .shadow }
  <figcaption>Not saved anywhere? Type it and press Enter — or save it as a block with one click.</figcaption>
</figure>

When a search matches nothing, the empty state offers to **add** exactly what you typed,
prefilled into the [host editor](adding-hosts.md).

## Keyboard

The tree is a real `treeview`: ++arrow-down++ from the search box moves into it, arrows
walk and expand rows, ++enter++ connects, ++escape++ returns to the search box, and
++alt+up++ / ++alt+down++ reorder the focused host or folder among its siblings.

++ctrl+b++ hides the sidebar entirely when you want the width — the
[quick launcher](quick-launcher.md) still reaches every host.

## Local terminal

The first row is always **Local terminal**: a real PTY running your login shell, in a new
tab. Which shell it uses is a [setting](settings.md); `auto` lets the server pick.
