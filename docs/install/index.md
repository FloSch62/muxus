---
icon: lucide/download
---

# Installation

There are two ways to run Muxus. Most people want the **desktop app** — download an
installer, double-click, done. If you would rather run it as a local web server (or you
are on a platform without a packaged build), run it **from source**.

<div class="grid cards" markdown>

-   :material-monitor: **Desktop app**

    ---

    A native, frameless window for Windows, macOS and Linux. No Node.js, no terminal —
    install and launch. **Recommended.**

    [:octicons-arrow-right-24: Install the desktop app](desktop.md)

-   :material-console-line: **From source**

    ---

    Run the Muxus server with `pnpm` and open it in your browser. Good for development,
    or for a box you already SSH into.

    [:octicons-arrow-right-24: Run from source](from-source.md)

</div>

## Before you start

Muxus connects with the credentials and configuration you already have:

| It reads | For |
| --- | --- |
| `~/.ssh/config` (and every `Include`) | Hosts, users, ports, keys, jump chains, forwards |
| `~/.ssh/known_hosts`, `/etc/ssh/ssh_known_hosts` | Host-key verification, exactly like OpenSSH |
| `~/.ssh/*` key files | The key picker in the host editor |
| `SSH_AUTH_SOCK` | Agent authentication and `ForwardAgent` |

!!! tip "Already use `ssh`? You're ready."

    If `ssh myhost` works in your terminal, Muxus will find and dial the same host with
    the same key. It does not import your config into a database — see
    [ssh_config support](../reference/ssh-config.md) for exactly which keywords are
    honoured.

Everything Muxus adds on top — folders, colours, workspaces, saved tunnels, session
history — lives in a small local SQLite database next to your other application data.

## Platform notes

=== ":material-linux: Linux"

    Serial devices usually require membership in the distribution's serial-access group,
    commonly `dialout` or `uucp`:

    ```bash
    sudo usermod -aG dialout "$USER"   # log out and back in afterwards
    ```

    Ports appear as `/dev/ttyUSB*` and `/dev/ttyACM*`.

=== ":material-apple: macOS"

    Serial ports appear as `/dev/tty.*` (for example `/dev/tty.usbserial-A50285BI`). No
    extra permissions are needed for SSH, Telnet or serial.

=== ":material-microsoft-windows: Windows"

    Serial ports use `COM` names such as `COM3`. Muxus reads `%USERPROFILE%\.ssh\config`
    and the OpenSSH agent when one is running.

Once you are installed, head to the [Quickstart](../quickstart.md).
