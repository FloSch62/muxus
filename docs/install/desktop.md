---
icon: lucide/monitor
---

# Desktop app

The desktop build wraps the Muxus server and UI in a native window. The server runs
in-process on a random localhost port, the window is frameless with the top bar serving as
the titlebar, and its size and position persist between launches.

## Download

Installers are published on the
**[releases page](https://github.com/FloSch62/muxus/releases)**:

| Platform | File |
| --- | --- |
| :material-microsoft-windows: Windows | `muxus-<version>-win-x64.exe` |
| :material-apple: macOS (universal) | `muxus-<version>-mac-universal.dmg` |
| :material-linux: Linux | `muxus-<version>-linux-x86_64.AppImage` or `muxus-<version>-linux-amd64.deb` |

## Install & launch

=== ":material-microsoft-windows: Windows"

    1. Run the installer and follow the prompts. The install directory is selectable.
    2. Launch **Muxus** from the Start menu.

    The builds are not code-signed yet, so SmartScreen may report an unrecognised
    publisher. Choose **More info → Run anyway**.

=== ":material-apple: macOS"

    1. Open the `.dmg` and drag **Muxus** into **Applications**.
    2. The builds are not notarised yet, so the first launch requires one extra step:

        - **Right-click** the app → **Open**, then confirm in the dialog, *or*
        - clear the quarantine flag from a terminal:

        ```bash
        xattr -dr com.apple.quarantine /Applications/Muxus.app
        ```

    Subsequent launches work normally from Spotlight or the Dock.

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

    === "Verify the download"

        Each release includes a signed `SHA256SUMS-linux.txt` manifest covering both
        Linux packages. Download these additional files from the same release:

        - `SHA256SUMS-linux.txt`
        - `SHA256SUMS-linux.txt.asc`
        - `muxus-linux-signing-key.asc`

        Import the public key and verify the manifest signature before checking the
        downloaded package:

        ```bash
        gpg --import muxus-linux-signing-key.asc
        gpg --show-keys --fingerprint muxus-linux-signing-key.asc
        gpg --verify SHA256SUMS-linux.txt.asc SHA256SUMS-linux.txt
        sha256sum --ignore-missing --check SHA256SUMS-linux.txt
        ```

        A successful check reports `OK` for the package. Confirm that the key fingerprint
        is `9961 EE0F 767C A411 D2F5 9489 E330 0BC6 4E4A DE67` and matches the public
        key committed in the
        [Muxus source repository](https://github.com/FloSch62/muxus/blob/main/.github/release-keys/linux-signing-key.asc).

## What the desktop build adds

- **A frameless window.** The top bar is the titlebar: it is a drag region, and the native
  window controls sit inside it (traffic lights on the left on macOS, minimise / maximise /
  close on the right elsewhere).
- **Native serial access.** `serialport` and `node-pty` are compiled against Electron's ABI
  in the packaged app, so local shells and COM/TTY consoles work without further setup.
- **A hardened shell.** The renderer receives its bootstrap credentials through an isolated
  preload bridge instead of the URL, and unexpected navigation is blocked. See the
  [security model](../reference/security.md).
- **Extra windows.** The file browser and any tab can be moved into their own window, which
  reuses the same in-process server and the same live SSH transports.

## Where your data lives

The desktop app keeps its data in Electron's per-app directory:

| Platform | Application database (folders, colours, workspaces, tunnels, saved hosts, optional encrypted passwords) |
| --- | --- |
| :material-microsoft-windows: Windows | `%APPDATA%\Muxus\muxus.sqlite3` |
| :material-apple: macOS | `~/Library/Application Support/Muxus/muxus.sqlite3` |
| :material-linux: Linux | `~/.config/Muxus/muxus.sqlite3` |

Session history, when enabled, is stored alongside it or at the location set in
[Settings](../guide/settings.md). SSH connection settings still come from `~/.ssh/config`.
Passwords you explicitly choose to remember are encrypted in the application database by
the password vault. The raw vault key is never stored in this directory; the default
never-prompt policy uses the OS credential store. See the
[security model](../reference/security.md).

Uninstalling the app leaves `~/.ssh` untouched.
