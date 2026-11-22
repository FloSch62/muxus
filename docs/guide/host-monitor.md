---
icon: lucide/activity
---

# Host monitor

The host monitor is a tab with one row for this computer and for every host Muxus is
connected to: latency, CPU, load, memory, disk, disk I/O, network traffic and uptime,
refreshed every few seconds. Each host is read over the SSH connection that is already
open. Nothing is installed on it and no password is asked for again.

Open it with the :material-pulse: icon in the sidebar rail, or with **Open host monitor** in
the [quick launcher](quick-launcher.md); the command can be
[bound to a key](../reference/keyboard-shortcuts.md). A window has one monitor tab: opening
it again goes to the one that is there. It is an ordinary tab otherwise. It can be pinned,
moved to a split pane, and comes back with the [workspace](workspaces.md).

<figure markdown="span">
  ![The host monitor tab with this computer and four connected hosts](../assets/screenshots/host-monitor.png#only-light){ .shadow }
  ![The host monitor tab with this computer and four connected hosts](../assets/screenshots/host-monitor-dark.png#only-dark){ .shadow }
  <figcaption>One row per connected host, read over the connection that is already open.</figcaption>
</figure>

## The table

| Column | Shows |
| --- | --- |
| **Host** | The name the sidebar gives the host, and the user and address it is connected with |
| **Latency** | How long the host takes to start answering a reading |
| **CPU** | Usage across all cores since the last reading; the core count in its tooltip |
| **Load** | The load average over one minute; five and fifteen minutes in its tooltip |
| **Memory** | Memory in use; the amounts in its tooltip |
| **Swap** | Swap in use |
| **Disk** | How full the filesystem holding `/` is |
| **Disk I/O** | Bytes read and written per second, summed over the whole disks |
| **Network** | Traffic received and sent per second on the interface of the default route |
| **GPU** | Load of the busiest NVIDIA card; every card with its memory and temperature in its tooltip |
| **Uptime** | Time since the host booted |
| **Users** | Login sessions, as `who` lists them; the names in its tooltip |
| **System** | Distribution and version |
| **Kernel** | Kernel name and release |

**Columns** chooses which of them are shown. Swap, GPU, Users, System and Kernel start
hidden. Click a column's header to sort by it, busiest host first, and click again to turn
the order around; **This computer** stays on top. **Filter hosts** matches names, addresses
and the name a host gives itself. Columns, order and interval are remembered.

The meters turn amber at 80% and red at 95%. Latency turns amber from 400 ms and red from
1.5 s.

Clicking a host's name goes to its tab, or opens a terminal on it when it has none.
Double-clicking the row does the same. At the end of each row, :material-console: opens
another terminal on the host, :material-pin-outline: keeps it connected, and
:material-dots-horizontal: has **Containers & VMs**, which opens the
[panel](environments.md) on that host, and **Copy address**.

## Which hosts are read

**Connected hosts.** A host has a row while Muxus is connected to it, whichever window the
session is in. Several tabs or split panes on one host are one row. When the last
connection to a host closes, its row goes.

**Kept hosts.** To watch a host without a session, click :material-pin-outline: in its row,
or tick it under **Keep connected**. While a monitor tab is open, Muxus connects to the
hosts on that list without opening a terminal. It connects to no other host for the
monitor, so opening the monitor never dials every host you have saved.

- A kept host that needs a password, a code or a host key answer is not asked by itself.
  Its row says **Sign-in needed**, and **Connect** dials it with the usual prompts.
- A connection that fails or drops is tried again, after 15 seconds at first and at most
  every 5 minutes.
- Closing the monitor tab, or unpinning the host, lets go of the connection. A host that
  also has a session open keeps that.

**Hosts that run no commands.** A reading runs a command on the host. Muxus only does that
on a connection where a shell session already ran one, because some network devices drop
the whole connection when a second channel asks for it. A host connected for a tunnel or
a remote desktop alone therefore says **Not read**, and **Read anyway** asks it once. A
router or console server whose session already showed that it runs no commands is never
asked, and a host that could not answer is not asked again until you choose **Try again**.

Hosts using [system OpenSSH](../reference/ssh-config.md#system-openssh) are read while a
terminal to them is open. They cannot be kept connected.

## How a reading works

Muxus runs a short, read-only `sh` script on an extra channel of the connection, the same
one the [status bar](the-window.md#status-bar) uses, with `/proc/diskstats` added for disk
I/O. A status bar and a monitor asking about a host at the same moment share one run.
Every host is read on its own, so a slow one holds no other up, and a reading that fails
leaves the last values on screen, dimmed, until the next one succeeds.

- **How often.** Every 2, 5, 10 or 30 seconds, or every minute; 5 seconds to begin with. A
  host's second reading comes a second after its first, since rates need two.
- **Only while it shows.** Nothing is read while the monitor tab is behind another tab or
  the window is hidden. Kept hosts stay connected meanwhile.
- **Latency** is the time from asking until the host starts to answer: opening a channel,
  starting a shell, and the way there and back. It is higher than a ping.
- **GPU** runs `nvidia-smi` on hosts that have it, and only while the column is shown.
- Each reading opens and closes one channel. A server logging at `LogLevel VERBOSE` writes
  a line for each.

Linux hosts report every column. macOS and BSD hosts report no CPU usage or disk I/O, and
BSD hosts leave out memory.
