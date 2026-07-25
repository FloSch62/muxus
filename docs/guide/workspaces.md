---
icon: lucide/layout-dashboard
---

# Workspaces

A workspace stores a window's layout under a name: the pane tree, every tab in it, their
titles and colour flags, and the multi-exec groups defined in it.

<figure markdown="span">
  ![The workspace dialog](../assets/screenshots/workspaces.png#only-light){ .shadow }
  ![The workspace dialog](../assets/screenshots/workspaces-dark.png#only-dark){ .shadow }
  <figcaption>The workspace dialog: save, open, rename, delete, and select a startup workspace.</figcaption>
</figure>

## Saving and switching

The workspace control in the top bar shows the active workspace's name and opens the
dialog, which provides:

- **Save** the current layout under a new name;
- **Open** another workspace, with the current one flushed first;
- **Rename** and **delete**;
- selection of the **startup workspace**, restored by a fresh window;
- search and sorting by recent activity, name or creation date.

The active workspace is saved continuously in the background, debounced. A window that
closes with live tabs flushes its layout on exit.

!!! note "Unsaved layouts are still restored"

    The last layout is restored on the next launch even without a saved name. Naming a
    workspace is what allows several of them to coexist.

## What restore does

Restore treats local and remote sessions differently:

- **Local shells start fresh.** A new PTY, in the same pane, in the same position.
- **Remote sessions wait.** SSH, Telnet and serial tabs are restored as tabs, with their
  titles and colours, but are not dialled until requested, so restoring a layout does not
  trigger a set of simultaneous logins and 2FA prompts.

Reconnect them individually from the tab menu, or use the workspace dialog to reconnect
selected sessions or all of them.

## Launching a set at once

Two ways to populate a workspace:

- A folder's **Launch *n* hosts…** in the sidebar opens everything inside it as tabs,
  columns, rows or a grid.
- **Duplicate tab** (++ctrl+shift+d++) opens a second session on the same host, reusing the
  connection.

<figure markdown="span">
  ![Launching a folder of hosts](../assets/screenshots/launch-group.png#only-light){ .shadow }
  ![Launching a folder of hosts](../assets/screenshots/launch-group-dark.png#only-dark){ .shadow }
  <figcaption>Selecting a layout shape when launching a folder.</figcaption>
</figure>

## Multi-exec groups

A saved workspace carries its [multi-execution](commands.md#multi-execution) groups, and
restores each group whose layout still contains at least two of its tabs.

## Storage

Workspaces are stored in the local SQLite database, next to folders, colours and saved
tunnels. They are not written to `ssh_config` and are not sent off the machine.
