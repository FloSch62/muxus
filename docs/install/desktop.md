---
icon: lucide/monitor
---

# Desktop app

The desktop build wraps the Muxus server and UI in a native window. The server runs
**in-process** on a random localhost port, the window is frameless (the top bar doubles as
the titlebar), and its size and position are remembered between launches.

## Download

Grab the installer for your platform from the
**[releases page](https://github.com/FloSch62/muxus/releases)**:

| Platform | File |
| --- | --- |
| :material-microsoft-windows: Windows | `muxus-<version>-win-x64.exe` |
| :material-apple: macOS (universal) | `muxus-<version>-mac-universal.dmg` |
| :material-linux: Linux | `muxus-<version>-linux-x86_64.AppImage` or `muxus-<version>-linux-amd64.deb` |

## Install & launch

=== ":material-microsoft-windows: Windows"

    1. Run the installer and follow the prompts — it lets you choose the install
       directory.
    2. Launch **Muxus** from the Start menu.

    The builds are not code-signed yet, so SmartScreen may warn that the publisher is
    unrecognised. Choose **More info → Run anyway**.

=== ":material-apple: macOS"

    1. Open the `.dmg` and drag **Muxus** into **Applications**.
    2. The builds are not notarised yet, so the first launch needs one extra step:

        - **Right-click** the app → **Open**, then confirm in the dialog, *or*
        - clear the quarantine flag from a terminal:

        ```bash
        xattr -dr com.apple.quarantine /Applications/Muxus.app
        ```

    After the first launch, open it normally from Spotlight or the Dock.

=== ":material-linux: Linux"

    === "AppImage"

        ```bash
        chmod +x muxus-*-linux-x86_64.AppImage
        ./muxus-*-linux-x86_64.AppImage
        ```

    === "Debian / Ubuntu (.deb)"

        ```bash
        sudo apt install ./muxus-*-linux-amd64.deb
        muxus
        ```

## What the desktop build adds

- **A frameless window.** The top bar is the titlebar: it is a drag region, and the
  native window controls sit inside it (traffic lights on the left on macOS, minimise /
  maximise / close on the right elsewhere).
- **Native serial access.** `serialport` and `node-pty` are compiled against Electron's
  ABI in the packaged app, so local shells and COM/TTY consoles work out of the box.
- **A hardened shell.** The renderer gets its bootstrap credentials through an isolated
  preload bridge instead of the URL, and unexpected navigation is blocked. See the
  [security model](../reference/security.md).
- **Extra windows.** The file browser and any tab can be popped out into their own
  window, which reuses the same in-process server and the same live SSH transports.

## Where your data lives

The desktop app keeps its data in Electron's per-app directory:

| Platform | Application database (folders, colours, workspaces, tunnels, saved Telnet/serial hosts) |
| --- | --- |
| :material-microsoft-windows: Windows | `%APPDATA%\Muxus\muxus.sqlite3` |
| :material-apple: macOS | `~/Library/Application Support/Muxus/muxus.sqlite3` |
| :material-linux: Linux | `~/.config/Muxus/muxus.sqlite3` |

Session history (opt-in) sits alongside it, or wherever you point it in
[Settings](../guide/settings.md). Connection settings are **not** in there — they stay in
your own `~/.ssh/config`.

Uninstalling the app leaves your `~/.ssh` untouched.
