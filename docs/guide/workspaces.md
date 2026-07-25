---
icon: lucide/layout-dashboard
---

# Workspaces

A workspace is a whole window's worth of work, saved by name: the pane tree, every tab in
it, their titles and colour flags, and the multi-exec groups you built. Reopen it tomorrow
and the layout is exactly where you left it.

<figure markdown="span">
  ![The workspace dialog](../assets/screenshots/workspaces.png#only-light){ .shadow }
  ![The workspace dialog](../assets/screenshots/workspaces-dark.png#only-dark){ .shadow }
  <figcaption>Save, open, rename, delete — and mark one as the workspace to start with.</figcaption>
</figure>

## Saving and switching

The workspace button in the top bar shows the active workspace's name and opens the
dialog. From there you can:

- **Save** the current layout under a new name;
- **Open** another workspace — the current one is flushed first, so nothing is lost;
- **Rename** or **delete**;
- pick one as the **startup workspace**, which is what a fresh window restores;
- search and sort the list by recent activity, name or creation date.

The active workspace is saved continuously in the background, debounced, so you never have
to remember to. A window that closes with live tabs flushes its layout on the way out.

!!! note "Unsaved is still remembered"

    Even without saving a name, the last layout is restored the next time you open Muxus.
    Naming a workspace is about having *several*, not about persistence.

## What restore does

Restoring is deliberately asymmetric:

- **Local shells start fresh.** A new PTY, in the same pane, in the same position.
- **Remote sessions wait.** SSH, Telnet and serial tabs come back as tabs, with their
  titles and colours, but they are not dialled until you say so — because reopening a
  saved layout should never fire off eight logins and three 2FA prompts on its own.

Reconnect them one at a time from the tab menu, or use the workspace dialog to reconnect
the ones you select, or all of them.

## Launching a set at once

Two ways to fill a workspace quickly:

- A folder's **Launch *n* hosts…** in the sidebar opens everything inside it as tabs,
  columns, rows or a grid.
- **Duplicate tab** (++ctrl+shift+d++) opens a second session on the same host, reusing the
  connection.

<figure markdown="span">
  ![Launching a folder of hosts](../assets/screenshots/launch-group.png#only-light){ .shadow }
  ![Launching a folder of hosts](../assets/screenshots/launch-group-dark.png#only-dark){ .shadow }
  <figcaption>Pick the shape; Muxus builds the panes.</figcaption>
</figure>

## Multi-exec groups travel with the workspace

A saved workspace carries its [multi-execution](commands.md#multi-execution) groups, so
"all four web nodes" is still a group tomorrow — as long as at least two of its tabs are
part of the layout.

## Where it is stored

In the local SQLite database, next to your folders, colours and saved tunnels — never in
your `ssh_config`, and never anywhere off your machine.
