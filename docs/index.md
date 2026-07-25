---
icon: lucide/house
hide:
  - navigation
  - toc
---

<div class="muxus-hero" markdown>

# ![](assets/muxus.svg){ .muxus-hero-logo } Muxus

<p class="tagline">
A free, open-source SSH, Telnet and serial client. Your OpenSSH config stays the source of
truth, your sessions live in split panes and saved workspaces, and the terminal draws
images. Everything runs on your machine.
</p>

[Get started :material-arrow-right:](install/index.md){ .md-button .md-button--primary }
[Download :simple-github:](https://github.com/FloSch62/muxus/releases){ .md-button }

</div>

![The Muxus window](assets/screenshots/overview.png#only-light){ .shadow }
![The Muxus window](assets/screenshots/overview-dark.png#only-dark){ .shadow }

## Why Muxus?

A plain `ssh` in a terminal emulator is fast, but everything around it is manual. You
remember the jump chain, you re-type the tunnel, you rebuild the same four panes every
morning. Graphical clients that fix this usually invent their own host database, so your
`~/.ssh/config` rots and nothing else on your machine can use what you saved.

Muxus takes the MobaXterm workflow and keeps **OpenSSH as the source of truth**. Every
`Host` block shows up in the sidebar, and adding or editing one writes that block back in
place. Only what OpenSSH has no field for goes into a local database: folders, colours,
workspaces, history. The terminal underneath is a modern one, with kitty graphics, the
kitty keyboard protocol and bundled Nerd Font coverage so remote prompts render correctly.

<div class="grid cards" markdown>

-   :material-file-cog-outline: **Your ssh config, not ours**

    ---

    Every `Host` block appears in the sidebar, including the files pulled in with
    `Include`. Edits are written back in place, atomically, with a `.muxus.bak`.

    [:octicons-arrow-right-24: Your hosts](guide/hosts.md)

-   :material-image-outline: **A terminal that draws**

    ---

    The kitty graphics protocol renders `kitten icat`, yazi previews, matplotlib and timg
    inline, over SSH. Sixel and iTerm2 images work too.

    [:octicons-arrow-right-24: Images in the terminal](guide/graphics.md)

-   :material-view-split-vertical: **Panes without the prefix dance**

    ---

    ++ctrl+shift+left++ / ++ctrl+shift+right++ splits toward that side and reuses the
    connection. ++alt+left++ moves focus. Nothing is taken from the shell.

    [:octicons-arrow-right-24: Tabs & panes](guide/tabs-and-panes.md)

-   :material-transit-connection-variant: **Full connect-through**

    ---

    Nested `ProxyJump` chains dialled hop by hop, `ProxyCommand` transports, and the same
    agent → certificate → key → keyboard-interactive → password order `ssh` uses.

    [:octicons-arrow-right-24: Connecting](guide/connecting.md)

-   :material-folder-network-outline: **Files and an editor, in the session**

    ---

    An SFTP browser per SSH tab on the same transport, and Monaco editing of remote files
    with real language services. No second login.

    [:octicons-arrow-right-24: File browser](guide/files.md)

-   :material-swap-horizontal: **Tunnels that outlive terminals**

    ---

    Saved `-L`, `-R` and `-D` forwards start with one click, without a terminal. Closing a
    tab never tears down a running tunnel.

    [:octicons-arrow-right-24: Tunnels](guide/tunnels.md)

-   :material-view-dashboard-outline: **Workspaces you can come back to**

    ---

    Save a whole layout of local shells, SSH, Telnet and serial sessions in resizable panes
    with tabs. Reopen it, reconnect it, or set it as your startup workspace.

    [:octicons-arrow-right-24: Workspaces](guide/workspaces.md)

-   :material-magnify: **One key for everything**

    ---

    ++ctrl+k++ searches saved hosts, open tabs, editor files, workspaces, commands, tunnels
    and retained session history, and acts on the result.

    [:octicons-arrow-right-24: Quick launcher](guide/quick-launcher.md)

</div>

## Ready?

<div class="grid cards" markdown>

-   :material-download: **Install Muxus**

    ---

    Desktop installers for Windows, macOS and Linux, or run it from source.

    [:octicons-arrow-right-24: Installation](install/index.md)

-   :material-rocket-launch: **Quickstart**

    ---

    From a fresh install to a split-pane session on your own host in five minutes.

    [:octicons-arrow-right-24: Quickstart](quickstart.md)

</div>

!!! info "Muxus is a local tool"

    The server binds `127.0.0.1` only, every request carries a per-run token, and nothing
    is sent anywhere else. Passwords and passphrases live only for the length of an
    authentication attempt, and the persistence layer rejects credential material
    outright. See the [security model](reference/security.md).
