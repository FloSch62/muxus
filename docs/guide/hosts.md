---
icon: lucide/server
---

# Your hosts

The sidebar lists every concrete `Host` block in the OpenSSH configuration, including files
pulled in with `Include`, together with SSH, Telnet, serial, RDP, VNC, gNMI and NETCONF hosts stored by Muxus.

Muxus does not import the configuration. It reads `~/.ssh/config` directly and writes edits
back to the same file in place.

## Import from MobaXterm

Open **Settings → Backup & data → Import sessions** to bring MobaXterm SSH, RDP and VNC
bookmarks into Muxus. On Windows, **Find sessions** reads bookmarks from the current user's local
MobaXterm installation. On every platform, you can choose `MobaXterm.ini`, `.mxtsessions`,
`.mobaconf` or a text export instead.

The review lists every detected session. Choose whether SSH hosts should stay in Muxus
app data only or be written as OpenSSH `Host` blocks, then select which sessions to include
and whether matching hosts should be kept or replaced. Muxus
preserves the display name, host, port, username, private key, SSH gateway (jump host),
execute command and the `SubRep` folder hierarchy. Sessions without a private key ask for a
password. An execute command becomes the host's startup command in a terminal; with **Do not
exit after command ends**, your login shell takes over when it finishes. The command is
imported exactly as written, including anything typed into it.

Each distinct SSH gateway becomes one jump host in a **MobaXterm jump hosts** folder, with
its own user, port and key; multi-hop gateways chain those jump hosts in order. SSH sessions
jump through it, and RDP and VNC sessions use it as their SSH gateway. MobaXterm's
`_ProfileDir_`, `_MyDocuments_` and `_CurrentDrive_` key paths become `~`, `~/Documents` and
`C:`.

Passwords are not copied, and private keys are referenced where they are rather than copied.
Muxus asks for credentials when you connect.

## Import from SecureCRT

In SecureCRT, choose **Tools → Export Settings**, include **Sessions** and **Button Bars**,
and save the XML export. Excluding saved credentials, keys and session passwords there is
recommended, since Muxus does not read them anyway. Then open **Settings → Backup & data →
SecureCRT import** in Muxus and choose that file. The review preserves nested folders,
offers Muxus-only or OpenSSH storage for SSH sessions, and lets you select individual
sessions and button bars, or keep and replace matching hosts and groups.

Muxus imports SSH names, hosts, ports, usernames and password-vs-key authentication intent.
Telnet sessions keep their host and port. Serial sessions include their device path, baud
rate, data bits, stop bits, parity and flow control. SecureCRT's `Default` session templates
are not hosts and are left out. Local-shell sessions, incomplete entries and protocols Muxus
cannot represent are listed as skipped.

### Button bars

Each SecureCRT button bar becomes a [command button group](commands.md#groups) with the
same name; if a group of that name already exists, the import is named *Name (SecureCRT)*.
SecureCRT's own **Default** bar is the exception: while the Muxus **Default** group has no
buttons of yours, its commands go straight into that group. Otherwise it becomes a
*Default (SecureCRT)* group, so your commands and the imported ones stay apart.
A host whose session used a bar other than **Default** shows that group in the command bar,
as if [a group per host](commands.md#a-group-per-host) had been set.

**Send String** buttons are converted to the literal text they type:

| SecureCRT | Muxus |
| --- | --- |
| `\r`, `\n`, `\r\n` | A line break, sent as Enter. A final one turns on **Run immediately**; without it the command is only inserted at the prompt. |
| `\t`, `\b`, `\e`, `\\`, `\nnn` (octal) | The tab, backspace, escape, backslash or octal character itself |
| `\p` (pause), `\v` (clipboard), `\u`, `\c`, `\i`, `\a`, `\m`, `\l` (client values) | Removed, with a note in the review |

Menu functions, scripts, applications and other button types have no Muxus equivalent and
are listed as skipped under their bar. Importing the same bar again keeps or replaces its
commands as a whole; replacing removes only commands that came from that bar, so buttons you
added to the Default group yourself stay.

Only connection metadata under the XML export's `Sessions` section and the `ButtonBarV5`
bars are read. Encrypted password fields and logon actions, private-key paths, embedded
files, scripts, terminal appearance and global SecureCRT settings are never imported.

<figure markdown="span">
  ![The hosts sidebar with folders and colours](../assets/screenshots/sidebar.png#only-light){ .shadow }
  ![The hosts sidebar with folders and colours](../assets/screenshots/sidebar-dark.png#only-dark){ .shadow }
  <figcaption>Folders, colours, icons and live-session dots are stored by Muxus. SSH connection details can come from OpenSSH or a Muxus-only profile.</figcaption>
</figure>

## Shared sessions

A team can keep one list of hosts that everyone follows. Each person gets the hosts of the
list in a folder of their own, and as the list changes Muxus adds, changes and removes them.
The list is a file at a web address or on a shared drive: one that a colleague
[shared from Muxus](#share-a-folder), or a MobaXterm shared sessions file from a lab portal.

### Follow a list

Choose **+** at the top of the sidebar → **Shared sessions link…**, enter where the list is,
and choose a name, the folder and how often Muxus checks: every 15 minutes, every hour,
every day, or only when you refresh it. Muxus also checks when it starts. The same dialog
opens from the [quick launcher](quick-launcher.md) as **Follow shared sessions**.

The list can be at:

- a **web address** starting with `https://` or `http://`, such as a self-service portal's
  personal link or the raw file link of a Git repository, or
- a **file** on this computer or a shared drive: a full path, `~/…`, a `\\server\share\…` path
  or a `file://` address. The desktop app has a button to browse for it.

The folder shows that it follows a list with its own icon, and its tooltip says where the
list comes from and when it was last read. A red mark appears on it when the last check
failed. Its right-click menu has **Refresh shared sessions**, **Edit shared sessions link…**
and **Stop following…**, which deletes the hosts or keeps them as hosts of your own.
**Settings → Backup & data → Shared sessions** lists every link with the same actions.

The hosts are saved in Muxus app data, never in `ssh_config`, and you can edit them like
any other. What you set on a host yourself stays: when its entry in the list changes, only
the settings the list changed are brought over. Your own user name or key on a host survives
the list changing its port, and is replaced only when the list changes the user name or key
itself. The same goes for the host's name, folder, colour and icon. Passwords you save are
kept by user, host and port, so they survive every update. A host that leaves the list is
deleted, and one you delete yourself comes back at the next check. A check that fails, or a
list that is empty or cannot be read, changes nothing.

A user name or key that should apply to every host of a list is best set once, in the
folder's [shared credentials](#shared-credentials).

Renaming or moving the folder, or choosing another folder for the link, takes its hosts
along. A host you move out of that folder stays where you put it unless the list moves it.
Links are part of a [backup](settings.md#backup-data), so restoring one on another computer
goes on following the same lists.

!!! info "What a list cannot set"

    A list changes without you looking at it again, so Muxus ignores the settings in it that
    run something on your computer or weaken a check: `ProxyCommand`, agent forwarding,
    remote port forwards, host key checking and the algorithm lists (`KexAlgorithms`,
    `HostKeyAlgorithms`, `Ciphers`, `MACs`). Passwords are never part of a list; Muxus
    asks when you connect. A web address with a user name or password in it is refused.

### Share a folder

Right-click a folder → **Share folder…** writes its hosts, subfolders included, as a session
list. Then:

1. Put the file where the others can read it: a web server, a Git repository, or a shared
   drive.
2. They follow its address or path as described above.
3. To change the list later, share the folder again and replace the file. Everyone's hosts
   follow at their next check.

The list keeps each host's name, folder, colour, icon and connection settings. `ssh_config`
hosts are written with the settings they resolve to, and what a host inherits from its
folder's [shared credentials](#shared-credentials) is filled in. A host outside the folder
that one of its hosts connects through comes along in a **Jump hosts** folder, so the list
still connects. **Include user names** is on by default; turn it off when everyone logs in as
themselves. **Include key file paths** is off by default, because keys rarely sit in the same
place on every computer. Passwords and private keys are never written.

### List formats

Muxus reads three kinds of list:

- **A Muxus session list**, as **Share folder…** writes it. A portal can generate one:

    ```json
    {
      "format": "muxus-shared-sessions",
      "version": 1,
      "hosts": [
        {
          "id": "node0",
          "name": "node0",
          "folder": "clab",
          "profile": { "kind": "ssh", "target": "node0.lab.example.net", "user": "alice" }
        },
        {
          "name": "node0 console",
          "folder": "clab/consoles",
          "color": "#a855f7",
          "profile": { "kind": "telnet", "host": "console.lab.example.net", "port": 2001 }
        }
      ]
    }
    ```

    Every kind of host Muxus saves can be listed. `id` is optional; give one that stays the
    same when a host's name may change, and to name the host as a jump host of another:
    `"proxyJump": ["muxus-host:node0"]`. `color` and `icon` are optional too. `icon` is the
    id of a [host icon](#host-icons), such as `ubuntu`, `windows`, `router` or `database`;
    a list written by **Share folder…** shows the id of every icon you picked.

- **A MobaXterm session file** (`.mxtsessions`), as MobaXterm's own shared sessions use. A
  personal link from a self-service portal works as it is, with your user name already in
  every session. SSH, RDP and VNC sessions are read as in the
  [MobaXterm import](#import-from-mobaxterm); SSH gateways become jump hosts in a
  **Jump hosts** folder. A session is told apart by its folder and name, so one that is
  renamed or moved in the file arrives as a new host.
- **A Muxus backup**, as **Create backup** writes it. Only its hosts are used.

## Host rows

A row shows the host name, an icon, an optional colour flag, and a green dot while a session
to that host is live, with a count when there is more than one. The icon says how the host
connects (SSH, Telnet, serial, RDP, VNC, gNMI, NETCONF, web) until you
[give the host one of its own](#host-icons).

The hover card carries the connection details:

- the **address** it resolves to (`user@hostname:port`),
- the **jump chain**, if the block has `ProxyJump`,
- the **key** that will be offered,
- **password authentication** when the block forces it,
- the number of **port forwards** started with the connection.

Click a row to connect. If the host already has tabs in the window, the click lists them
instead, the way a taskbar button lists an app's open windows. Each entry shows the tab's
title and number, its state, the remote working directory and the last lines of output, so
sessions with the same name can be told apart. Pick one to jump to it (an ended session
reconnects in place), or choose **New session**. A middle-click skips the list and opens
another session straight away. ++shift++ + click [selects](#editing-several-hosts-at-once)
every host from the last one clicked to this one, without connecting.

### Host icons

A host can show an icon of your choosing instead of the one for its connection kind: pick
it under **Icon** in the host editor's **General** section, or from a row's
**Organize, color & icon…**. The picker lists general icons (server, database, router,
switch, firewall, container and more) and the marks of what a host runs: operating systems
such as Linux, Windows, macOS, Ubuntu, Debian, Arch and Fedora, platforms such as Docker,
Kubernetes and Proxmox, network vendors and cloud providers. Type in its search box to
narrow the list, and press ++enter++ to take the first match. **Default** goes back to the
icon of the connection kind.

The icon is drawn in the host's colour and follows the host everywhere: the sidebar, the
hosts tab, the host's tabs and the quick launcher. Like the colour it is stored by Muxus,
never in `ssh_config`, and it travels with [backups](settings.md#backup-data) and
[shared session lists](#shared-sessions). To give several hosts the same icon, use the
[bulk editor](#editing-several-hosts-at-once).

### Opening with a double-click

To open hosts with a double-click instead, set **Open hosts with** to **Double-click** under
**Settings → Behavior**. A single click then selects the host, as in a file manager:
++ctrl++ + click (++cmd++ + click on macOS) adds or removes one, ++shift++ + click selects
the range from the last host clicked, and clicking empty space below the list clears the
selection. A double-click connects, or lists the host's open tabs as above, and ++shift++ +
double-click opens another session. ++enter++ and middle-click still open straight away.
Folders keep opening and closing on a single click, so a double-click toggles them only once,
and the **Local terminal** rows wait for a double-click as well.

The right-click menu has **Connect**, **Open in new window**,
**Move up/down**, **Move to folder…**, **Organize, color & icon…**, **Edit host**,
**Duplicate**, **Copy `ssh …` command** and **Delete host**. **Connect** always opens a
new session. On a host that is part of a selection, moving and deleting apply to the whole
selection (**Move *n* selected hosts…**, **Delete *n* selected hosts**), and the menu also
offers **Edit *n* selected hosts…**.

**Duplicate** can create a whole series at once: write a number range in the alias, such as
`grvdgmapp[2-10]`, and saving creates one host per number with the same settings. A leading
zero keeps the width (`db[01-12]`), and `..` or `:` work in place of `-`. The HostName
follows along: if it contains the duplicated host's name (`grvdgmapp1.corp.local`), each copy
gets its own (`grvdgmapp2.corp.local` …); otherwise give it a range of its own, such as
`10.0.0.[12-20]`, with as many values as the alias range. A display name either stays empty
or takes a range too (`Web [2-10]`), so the copies can be told apart. The line under the alias
shows what will be created before you save, and a range that names an existing host is refused.
Hosts for `ssh_config` are written in one go, so `config.muxus.bak` holds the file from before
the whole range. If a host is created but its folder, colour or logging settings cannot be
saved, Muxus names it so you can set them by editing it. The same works in **Add host**.

## Other layouts

The strip under the search box chooses how the hosts are laid out. The choice is kept, and
search, selection, the hover card and the right-click menu work the same in all three.

- **Folder tree** is the layout described above: folders nest, and hosts keep the order
  you gave them.
- **Flat list** shows every host without unfolding anything, with the folder it is filed in
  at the end of its row. Group it by **Recent** (open sessions first, then today, this
  week, this month, earlier, and hosts never connected), **A–Z**, or **Kind** (SSH, Telnet,
  serial, RDP, VNC, gNMI, NETCONF, web). A group's heading folds it away.
- **One folder at a time** shows the folders directly inside the current one, then every
  host anywhere below it in one alphabetical run, each with the subfolder it is in. Click
  a folder to step into it; the breadcrumb, the arrow beside it and ++backspace++ lead back
  out. It keeps the whole width for names however deep the folders go. Searching looks at
  every host, wherever you are.

Dragging to reorder belongs to the folder tree, where the order on screen is the hosts'
own. In one folder at a time, a host can still be dropped onto a folder to file it there.

## The hosts tab

The last button of that strip, or **Open hosts tab** in the
[quick launcher](quick-launcher.md), opens every saved host as a tab of its own. It is the
same list with room to spread out, and it needs no sidebar: connect, select, right-click
and search as in the sidebar.

- **Cards** file the hosts under their folders, each card with the host's name and address.
- **Table** adds the folder, the jump host, the kind and when the host was last used. Click
  a column heading to sort by it, again to reverse, and a third time (or **Arrange by
  folder**) to go back to the folders in the sidebar's order.
- The chips beside the search box narrow the list to one kind of host.

<figure markdown="span">
  ![The hosts tab showing every saved host as cards, one section per folder](../assets/screenshots/hosts-tab.png#only-light){ .shadow }
  ![The hosts tab showing every saved host as cards, one section per folder](../assets/screenshots/hosts-tab-dark.png#only-dark){ .shadow }
  <figcaption>The hosts tab as cards, filed under their folders, with filters by kind beside the search.</figcaption>
</figure>

Arranging hosts is what the tab is for:

- Drag a card or a row to another spot in its folder to reorder it, or into another folder
  to file it there. A line shows where it will land and the folder it moves to lights up;
  empty folders appear as places to drop while something is being dragged.
- Drag one host of a selection and the whole selection comes along.
- Drag between the tab and the sidebar in either direction: a card onto a folder of the
  tree, or a row of the tree into a folder of the tab.
- Drop hosts on the tab strip of any pane to open a session for each one there.

Reordering needs the hosts' own order on screen, so it is off while a search or a kind
filter is narrowing the list and while the table is sorted by a column. Hosts can still be
dragged to the sidebar or onto a pane then.

The arrow keys move between cards or rows, ++enter++ connects, ++shift++ + arrows extend a
selection, ++ctrl+a++ selects everything shown, ++delete++ deletes the selection after
asking, and ++escape++ clears it. The tab is saved with the [workspace](workspaces.md) like
any other.

## Folders

Folders are stored in the local database next to the host colour, not in `ssh_config`.
Hosts without a folder are grouped by the file they were defined in.

- **Create** a folder with **+** at the top of the sidebar → **New folder…**, by
  right-clicking empty space in the sidebar → **New folder**, or
  nest one inside another from a folder's menu.
- **Fill** it by dragging hosts in, or from a host's **Move to folder…**. Dragging one
  [selected](#editing-several-hosts-at-once) host brings every selected host along.
- **Style** it with **Rename, move & style…**, which sets a colour and an icon (cloud,
  servers, storage, network, LAN, cluster, lock, lab, site).
- **Reorder** with drag & drop, or ++alt+up++ / ++alt+down++ on the focused row. Hosts keep
  the assigned order; folders sort alphabetically until moved.
- **Collapse** a folder and everything nested inside it in one action.

Deleting a folder does not delete hosts. They move up into the parent folder, and no
connection setting changes.

### Shared credentials

A folder can provide a default username, port, private key and password for every host
inside it. Open **Rename, move & style…** and fill in the
**Shared SSH credentials** section.

Precedence is always: the host's own settings first, then the nearest folder, then its
parents. OpenSSH-backed hosts also use anything resolved from `ssh_config` (including
`Host *` blocks) before consulting the folder. Muxus-only hosts do not read final-host
settings from `ssh_config`; only named `ProxyJump` hops can still resolve there. A folder
therefore fills gaps without replacing a value configured directly on the host.

The shared password is kept in the encrypted [password vault](settings.md) and is tried
automatically when a host falls back to password login; a password remembered for the
host itself still wins. Folder credentials move with the folder when it is renamed or
dragged, and deleting the folder deletes them.

Instead of a password typed here, the folder can point at a
[password-manager entry](connecting.md#passwords-from-a-password-manager) with **Choose
from a password manager…**. The entry is then used as the shared password, ahead of one
saved in the vault.

### Shared login sequence

The same dialog's **Login sequence** section sets a
[login sequence](adding-hosts.md#login-sequence) for every SSH, Telnet and serial host in
the folder, nested folders included. A host that sets its own sequence, or **No login
sequence**, keeps it; otherwise the nearest folder with a sequence wins, and a subfolder can
choose **No login sequence** to switch its parent's off. The sequence moves with the folder
like its credentials.

### Launching a folder

A folder's menu offers **Launch *n* hosts…**, which opens every host it contains, including
nested folders, as **tabs**, **columns**, **rows** or a **grid**.

<figure markdown="span">
  ![Launching a folder as a grid](../assets/screenshots/launch-group.png#only-light){ .shadow }
  ![Launching a folder as a grid](../assets/screenshots/launch-group-dark.png#only-dark){ .shadow }
  <figcaption>A folder opened as a grid of sessions.</figcaption>
</figure>

## Editing several hosts at once

++ctrl++ + click a host (++cmd++ + click on macOS) to select it without connecting, and
++shift++ + click selects every host between the last one clicked and this one. The host a
plain click connected counts as clicked, so click one host and ++shift++ + click another to
select the whole range. When hosts [open with a double-click](#opening-with-a-double-click),
a plain click selects too. A bar under the list counts the selected hosts; **Edit…** opens the bulk
editor, the folder button moves them all to a folder, the bin deletes them, and ++escape++ or
the bar's close button clears the selection. The selection stays while you search, so it can
gather hosts from several queries.

A folder's menu offers **Edit *n* hosts…** for everything inside it, nested folders
included, and a selected host's right-click menu offers **Edit *n* selected hosts…**,
**Move *n* selected hosts…** and **Delete *n* selected hosts**.

Dragging a selected host drags the whole selection, including hosts inside collapsed
folders, and they land together, in the order they had in the list. A host that is not
selected drags on its own.

Deleting several hosts asks once and names them. `ssh_config` hosts are removed with each
config file written once, so its `.muxus.bak` holds the contents from before the whole
delete; hosts stored in Muxus are removed from Muxus.

The bulk editor shows each setting the hosts share. Where they differ, the field reads
**Multiple values**, and each host keeps its own value unless you choose one for all of
them. Only the settings you change are written; everything else about every host stays as it
was. Each changed setting says how many hosts it changes, with **Undo** to take it back, and
hosts that already have every new value are skipped.

| Section | Settings | Applies to |
| --- | --- | --- |
| Folder, color & icon | Folder, colour, icon | Every host |
| SSH connection | User, port, host verification, agent forwarding, X11 forwarding, system OpenSSH, console compatibility, SFTP | SSH hosts |
| Terminal appearance | Colour scheme, text and background colour, command button group, paste delays, waiting for the prompt, anti-idle, keys and echo | SSH, Telnet and serial hosts |
| Highlighting | Highlighting profile, global rules | SSH, Telnet and serial hosts |
| Session logging | Logging policy for new sessions | SSH, Telnet and serial hosts |
| Login sequence | One sequence for every host, none, or each host's folder sequence again | SSH, Telnet and serial hosts |

In `ssh_config`, a bulk edit rewrites only the lines of the options it changes. Comments,
formatting and every other option in each `Host` block stay exactly as they were, and each
file is written once, so its `.muxus.bak` holds the contents from before the whole edit.
Emptying the user or port removes it from each host, which then falls back to `Host *` blocks
and [folder credentials](#shared-credentials). A new highlighting profile keeps each host's
own keyword rules.

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

## Opening ssh:// and telnet:// links

The desktop app can open links such as `ssh://admin@10.0.0.1:2222` or `telnet://switch-01`
from a browser, wiki, ticket or monitoring dashboard. Because this changes a system-wide
default, it is opt-in: open **Settings → Behavior** and press **Use Muxus for ssh:// links**
or **Use Muxus for telnet:// links**. Each row shows which program opens those links now.
To hand them back, choose another program in the system's default-application settings.

A link opens as a new tab in the Muxus window you used last, or starts Muxus first. When it
names a host you already have, that host's settings are used:

- an `ssh://` link whose host is an OpenSSH alias connects through that `Host` block, with
  a user or port in the link taking the place of the configured ones, like
  `ssh -p 2222 admin@alias`;
- otherwise a host whose host name and port (22, or 23 for Telnet, when the link has none)
  match is used. If several match, the link's user decides; if that still leaves more than
  one, Muxus does not guess;
- a Muxus-only host is used by its name or address only when the link's user and port fit
  it, because it always connects with its own saved fields.

Anything else connects like [quick connect](#search-and-quick-connect): `ssh://` dials
`[user@]host[:port]` through the OpenSSH configuration, and `telnet://` opens a Telnet
session to the host, on port 23 unless the link says otherwise.

| Link | Opens |
| --- | --- |
| `ssh://admin@10.0.0.1:2222` | SSH to port 2222 as `admin` |
| `ssh://edge-router` | The `edge-router` host from `~/.ssh/config` |
| `ssh://[2001:db8::1]:830` | SSH to an IPv6 address |
| `ssh://admin;fingerprint=SHA256:…@10.0.0.1` | SSH that only proceeds with that host key, see [Host keys](connecting.md#fingerprints-in-ssh-links) |
| `telnet://switch-01:2323` | Telnet to port 2323 |

Links are checked before anything is dialed. Hosts and users are limited to the same plain
names as [`--connect`](../reference/cli.md#ad-hoc-ssh-connections), so a link cannot pass
options such as `-oProxyCommand=…` or reach a shell. A link with a password
(`ssh://user:secret@host`) is refused, since Muxus asks for passwords itself and links end
up in browser history. A path, query or fragment after the host is ignored, as are
connection parameters other than `fingerprint`. A malformed link, or one for another
scheme, shows an error notification instead of connecting.

On Linux, a Muxus installed from the `.deb` package registers its own desktop file. The
AppImage and a source checkout have no installed desktop file, so pressing the button
writes a hidden `muxus-url-handler.desktop` to `~/.local/share/applications` that starts
that copy, and sets it as the default with `xdg-mime`. An AppImage whose path contains
spaces is started through a `muxus-link-handler` link in `~/.config/Muxus`, since
`xdg-open` cannot read such a path. If the AppImage is moved, press the button again. On
Windows, the installer lists Muxus under **Default apps**; when Windows
keeps another choice, or for the Microsoft Store version, the button opens those settings
so you can pick Muxus there.

## Keyboard

The tree is a `treeview`. ++arrow-down++ from the search box moves into it, arrows walk and
expand rows, ++enter++ connects, ++escape++ returns to the search box, and ++alt+up++ /
++alt+down++ reorder the focused host or folder among its siblings.

To select hosts from the keyboard, ++shift+space++ selects or deselects the focused host,
++shift+up++ / ++shift+down++ extend the selection, and ++ctrl+a++ selects every visible host.
++escape++ clears a selection before it returns to the search box.

++ctrl+b++ hides the sidebar. The [quick launcher](quick-launcher.md) still reaches every
host, and so does the [hosts tab](#the-hosts-tab).

## Local terminal

The first row is **Local terminal**, which opens a PTY running the login shell in a new
tab. The shell is configurable in [settings](settings.md); `auto` lets the server pick.
