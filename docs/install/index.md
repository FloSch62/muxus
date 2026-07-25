---
icon: lucide/download
---

# Installation

Muxus can be run in two ways. The **desktop app** is a packaged installer for Windows,
macOS and Linux. Running **from source** starts the server locally and serves the UI to a
browser, which also covers platforms without a packaged build.

<div class="grid cards" markdown>

-   :material-monitor: **Desktop app**

    ---

    A native, frameless window for Windows, macOS and Linux. Requires no Node.js
    installation. **Recommended.**

    [:octicons-arrow-right-24: Install the desktop app](desktop.md)

-   :material-console-line: **From source**

    ---

    Run the Muxus server with `pnpm` and open it in a browser. Suitable for development.

    [:octicons-arrow-right-24: Run from source](from-source.md)

</div>

## Before you start

Muxus uses the existing SSH credentials and configuration on the machine:

| It reads | For |
| --- | --- |
| `~/.ssh/config` (and every `Include`) | Hosts, users, ports, keys, jump chains, forwards |
| `~/.ssh/known_hosts`, `/etc/ssh/ssh_known_hosts` | Host-key verification |
| `~/.ssh/*` key files | The key picker in the host editor |
| `SSH_AUTH_SOCK` | Agent authentication and `ForwardAgent` |

!!! tip "Already use `ssh`? You're ready."

    If `ssh myhost` works in a terminal, Muxus resolves and dials the same host with the
    same key. The configuration is not imported into a database. See
    [ssh_config support](../reference/ssh-config.md) for the keywords that are honoured.

The attributes Muxus adds (folders, colours, workspaces, saved tunnels, session history)
are stored in a local SQLite database alongside the other application data.

## Platform notes

=== ":material-linux: Linux"

    Serial devices usually require membership in the distribution's serial-access group,
    commonly `dialout` or `uucp`:

    ```bash
    sudo usermod -aG dialout "$USER"   # log out and back in afterwards
    ```

    Ports appear as `/dev/ttyUSB*` and `/dev/ttyACM*`.

=== ":material-apple: macOS"

    Serial ports appear as `/dev/tty.*`, for example `/dev/tty.usbserial-A50285BI`. No
    extra permissions are required for SSH, Telnet or serial.

=== ":material-microsoft-windows: Windows"

    Serial ports use `COM` names such as `COM3`. Muxus reads `%USERPROFILE%\.ssh\config`
    and the OpenSSH agent when one is running.

After installation, continue with the [Quickstart](../quickstart.md).
