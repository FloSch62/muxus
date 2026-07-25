---
icon: lucide/rocket
---

# Quickstart

From a fresh install to a split-pane session on a host you already have, in about five
minutes. Muxus reads the `~/.ssh/config` you already use, so if `ssh myhost` works in a
terminal, it works here.

## 1. Launch Muxus

Open the **desktop app**, or start it from source:

```bash
pnpm start
```

The window opens on an empty pane with your hosts in the sidebar on the left.

## 2. Find your hosts

Every concrete `Host` block in `~/.ssh/config` is already there, grouped by the file it
came from, including the files pulled in with `Include`. Nothing was imported and nothing
was copied: the sidebar *is* your config.

<figure markdown="span">
  ![The hosts sidebar](assets/screenshots/sidebar.png#only-light){ .shadow }
  ![The hosts sidebar](assets/screenshots/sidebar-dark.png#only-dark){ .shadow }
  <figcaption>Folders, colours and live-connection dots are Muxus's; the connection details are OpenSSH's.</figcaption>
</figure>

Click a host to connect. The first connection to an unknown host asks you to verify its
key, the same way `ssh` does. Accepting appends it to your real `~/.ssh/known_hosts`.

!!! tip "Nothing saved yet?"

    The search box doubles as quick connect. Type `user@host` (a `:port` suffix works too)
    and press ++enter++. Muxus dials it straight away, and offers to save it as a `Host`
    block afterwards. See [Your hosts](guide/hosts.md#search-and-quick-connect).

## 3. Split the window

With a session open, press ++ctrl+shift+right++. The pane splits, and the new pane
**continues the same session**. The SSH connection is reused, so there is no second login
and no second password prompt.

<figure markdown="span">
  ![Three panes in one window](assets/screenshots/panes.png#only-light){ .shadow }
  ![Three panes in one window](assets/screenshots/panes-dark.png#only-dark){ .shadow }
  <figcaption>Split in any direction; every pane keeps its own tab strip.</figcaption>
</figure>

Move around with ++alt+left++ / ++alt+right++ / ++alt+up++ / ++alt+down++, zoom a pane to
the whole window with ++ctrl+shift+z++, and close one with ++ctrl+shift+x++. Nothing is
taken from the shell: ++ctrl+w++ still deletes a word, so closing a tab is
++ctrl+shift+w++.

[More on tabs & panes :octicons-arrow-right-24:](guide/tabs-and-panes.md)

## 4. Open the files next to the session

Click the folder icon in the top bar to open the **file browser** on the current SSH tab.
It rides the session's existing SSH transport, so there is no new connection and no new
authentication.

<figure markdown="span">
  ![The SFTP file browser beside a terminal](assets/screenshots/sftp.png#only-light){ .shadow }
  ![The SFTP file browser beside a terminal](assets/screenshots/sftp-dark.png#only-dark){ .shadow }
  <figcaption>Drag files in to upload; double-click one to open it in the remote editor.</figcaption>
</figure>

[More on the file browser :octicons-arrow-right-24:](guide/files.md)

## 5. Drive it from the keyboard

Press ++ctrl+k++ to open the **quick launcher**. One box searches saved hosts, open tabs,
editor files, workspaces, commands, tunnels and retained session history, and acts on what
you pick: connect, switch, reconnect, open, run, toggle.

<figure markdown="span">
  ![The quick launcher](assets/screenshots/quick-launcher.png#only-light){ .shadow }
  ![The quick launcher](assets/screenshots/quick-launcher-dark.png#only-dark){ .shadow }
  <figcaption>++ctrl+k++ reaches anything Muxus knows about.</figcaption>
</figure>

Every command lives in one keymap. Press ++ctrl+shift+slash++ to see it, search it, and
rebind anything; conflicts are flagged and defaults restore in one click.

## 6. Keep the layout

Once the window looks the way you work, open the **workspace** menu in the top bar and save
it. A workspace remembers panes, tabs, colours and multi-exec groups. Reopen it tomorrow
and your local shells start fresh while remote sessions wait for an explicit **Reconnect**.

[More on workspaces :octicons-arrow-right-24:](guide/workspaces.md)

## Where to next

<div class="grid cards" markdown>

-   :material-book-open-variant: **User guide**

    ---

    A feature-by-feature tour: hosts, panes, the terminal, tunnels, SFTP, history.

    [:octicons-arrow-right-24: Read the guide](guide/index.md)

-   :material-keyboard: **Keyboard shortcuts**

    ---

    Every default chord, and the rules behind which keys Muxus is allowed to take.

    [:octicons-arrow-right-24: Shortcuts](reference/keyboard-shortcuts.md)

-   :material-shield-lock: **Security model**

    ---

    What binds where, what is stored, what is never stored.

    [:octicons-arrow-right-24: Security](reference/security.md)

</div>
