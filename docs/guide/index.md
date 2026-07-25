---
icon: lucide/book-open
---

# User guide

Each page here covers one part of Muxus, with screenshots and the reasoning behind how it
behaves. You do not have to read it in order — jump to whatever you are trying to do.

## Connect, arrange, keep

The whole app in three moves:

=== "Connect"

    Your `~/.ssh/config` is the host list. Click a host, type `user@host` in the search
    box, or press ++ctrl+k++ and search everything at once.

    ![The hosts sidebar](../assets/screenshots/sidebar.png#only-light){ .shadow }
    ![The hosts sidebar](../assets/screenshots/sidebar-dark.png#only-dark){ .shadow }

=== "Arrange"

    Split panes in any direction, move tabs between them, zoom one to the whole window.
    Layout changes never disturb a running session.

    ![Split panes](../assets/screenshots/panes.png#only-light){ .shadow }
    ![Split panes](../assets/screenshots/panes-dark.png#only-dark){ .shadow }

=== "Keep"

    Save the layout as a workspace, save the tunnel you keep re-typing, and let session
    history remember the output your scrollback dropped.

    ![Saved tunnels](../assets/screenshots/tunnels.png#only-light){ .shadow }
    ![Saved tunnels](../assets/screenshots/tunnels-dark.png#only-dark){ .shadow }

## Start here

<div class="grid cards" markdown>

-   :material-application-outline: **The Muxus window**

    ---

    Top bar, sidebar, pane canvas, tab strips and side panels — what is where and why.

    [:octicons-arrow-right-24: The window](the-window.md)

-   :material-server-network: **Your hosts**

    ---

    The sidebar: OpenSSH blocks, folders, colours, live dots, search and quick connect.

    [:octicons-arrow-right-24: Hosts](hosts.md)

</div>

## Hosts & connections

<div class="grid cards" markdown>

-   :material-playlist-edit: **[Adding & editing hosts](adding-hosts.md)** — the session editor that writes real `Host` blocks
-   :material-serial-port: **[Telnet & serial](telnet-serial.md)** — consoles that are not SSH, in the same list
-   :material-transit-connection-variant: **[Connecting](connecting.md)** — auth order, host keys, jump chains, recovery

</div>

## Working in the terminal

<div class="grid cards" markdown>

-   :material-view-split-vertical: **[Tabs & panes](tabs-and-panes.md)** — the tmux workflow without the prefix
-   :material-console: **[The terminal](terminal.md)** — colours, search, export, zoom, paste safety, highlighting
-   :material-image-outline: **[Images in the terminal](graphics.md)** — kitty graphics, sixel, iTerm2
-   :material-lightning-bolt: **[Command buttons & multi-exec](commands.md)** — one click, or every pane at once

</div>

## Files, tunnels, memory

<div class="grid cards" markdown>

-   :material-folder-network-outline: **[File browser (SFTP)](files.md)** — upload, download, rename, delete
-   :material-file-document-edit-outline: **[Remote editor](editor.md)** — Monaco over the live SSH transport
-   :material-swap-horizontal: **[Tunnels & port forwarding](tunnels.md)** — saved `-L`, `-R`, `-D` without a terminal
-   :material-view-dashboard-outline: **[Workspaces](workspaces.md)** — save, reopen, reconnect a whole layout
-   :material-history: **[Session history](session-history.md)** — opt-in retention, search, replay
-   :material-magnify: **[Quick launcher](quick-launcher.md)** — ++ctrl+k++ for everything
-   :material-cog: **[Settings](settings.md)** — appearance, terminal, logging, highlighting, behaviour, keyboard

</div>
