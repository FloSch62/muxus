---
icon: lucide/scroll-text
---

# Scripts on many hosts

**Scripts** runs a script on several SSH hosts and shows what each one printed. Open it with
the hosts already picked:

- **One host:** right-click it and choose **Run script…**.
- **Several hosts:** [select them](hosts.md#editing-several-hosts-at-once), then right-click one
  of them and choose **Run script on *n* selected hosts…**, or click
  :material-console: in the selection bar.
- **A folder:** right-click it and choose **Run script on hosts in this folder…**. Hosts in its
  subfolders are included.

Only SSH hosts run scripts; Telnet, serial, remote desktop, web and share hosts in a selection
or folder are left out, and Muxus says how many. The [quick launcher](quick-launcher.md)
(**Run a script on hosts**) opens Scripts without any hosts picked.

## The script

Scripts are kept in Muxus, listed on the left. **New** starts an empty one, and **From file…**
loads a script file from this computer into the editor. **Save** keeps it for next time; a
script can also be run without saving it.

On each host the script is copied into a temporary file and run from there, then removed:

- A first line such as `#!/bin/bash` or `#!/usr/bin/env python3` picks the interpreter, as
  running the file would. Without one the script runs with `sh`.
- The script's standard input is empty, so a command that waits for input ends instead of
  hanging. Use `sudo -n` rather than a `sudo` that would ask for a password.
- Standard output and standard error are shown together, in the order they arrived.
- A script can be up to 1 MB.

## Hosts and how they run

**Run on** picks the hosts: SSH hosts from your configuration and SSH hosts saved in Muxus.
**All SSH hosts** picks every one.

| Mode | |
|---|---|
| **All at once** | Every host starts together |
| **In batches of *n*** | *n* hosts at a time; the next batch starts when the whole batch is done |
| **One by one** | Each host after the one before has finished |

**Stop at the first host that fails** (batches and one by one) lets the current batch finish
and then runs no more hosts; the rest are listed as not run. A host fails when the script exits
with a code other than 0, cannot connect, or runs past the time limit.

**Stop a host's run after** ends a host's script after that many minutes; 0 lets it run.

Each host connects the way its terminal tab would: jump hosts, keys and saved passwords all
apply, and an open connection to the host is reused. When hosts need a password or a host key
confirmation, the questions appear one at a time.

## Results

**Results** lists each host with its state (waiting, connecting, running, succeeded, failed,
not run) and how long it took, and shows the selected host's output as it arrives. The summary
at the top counts successes and failures.

- **Cancel** stops the scripts still running and starts no more hosts.
- **Run again on failed hosts** repeats the run on just the hosts that failed.
- The copy button copies a host's output.

Closing the dialog does not stop a run. Open **Scripts** again to see it.
