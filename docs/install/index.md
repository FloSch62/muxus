---
icon: lucide/download
---

# Desktop app

The desktop build wraps the Muxus server and UI in a native window for Windows, macOS and
Linux, with no Node.js installation required. The server runs in-process on a random
localhost port, the window is frameless with the top bar serving as the titlebar, and its
size and position persist between launches.

To serve the UI to a browser from a local server instead, or on a platform without a
packaged build, run Muxus [from source](from-source.md).

## Download

Installers are published on the
**[releases page](https://github.com/FloSch62/muxus/releases)**:

| Platform | File |
| --- | --- |
| :material-microsoft-windows: Windows | `muxus-<version>-win-x64.exe` or `muxus-<version>-win-arm64.exe` |
| :material-apple: macOS (universal) | `muxus-<version>-mac-universal.dmg` |
| :material-linux: Linux | `muxus-<version>-linux-x86_64.AppImage` or `muxus-<version>-linux-amd64.deb` |

On Windows, Muxus is also available from the
**[Microsoft Store](https://apps.microsoft.com/detail/9PCGP101LFPL)**, which installs and
updates it for you.

## Install & launch

=== ":material-microsoft-windows: Windows"

    1. Run the installer and follow the prompts. The install directory is selectable.
    2. Launch **Muxus** from the Start menu.

    GitHub installers are unsigned by default, so SmartScreen may report an
    unrecognised publisher. The
    [Microsoft Store version](https://apps.microsoft.com/detail/9PCGP101LFPL) is signed
    by Microsoft and avoids that warning.

=== ":material-apple: macOS"

    1. Open the `.dmg` and drag **Muxus** into **Applications**.
    2. Launch **Muxus** from Applications, Spotlight or the Dock.

    Releases are Developer ID signed and notarized, with support for both Intel and
    Apple Silicon. Older releases and unsigned development builds can still trigger
    Gatekeeper. Replace an older unsigned build with a signed release when available.

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

## Updating Muxus

Muxus checks for a new version at startup and every four hours, and tells you when one
is available. Nothing downloads until you choose **Download update**, and nothing installs
until you choose **Restart to update**. Quitting Muxus normally never installs an update.
The same controls are in **Settings → About**.

| Installation | How it updates |
| --- | --- |
| :material-microsoft-windows: Windows installer | In the app; the matching x64 or ARM64 installer is downloaded |
| :material-microsoft-windows: Microsoft Store | Through the Store: **Update now** asks Windows to install it |
| :material-apple: macOS | In the app, for both Intel and Apple Silicon |
| :material-linux: Linux AppImage | In the app; the AppImage file is replaced |
| :material-linux: Linux `.deb` | With your package manager; Muxus links to the new release |

Every download is checked against the SHA-512 checksum published with the release, and
macOS also checks Apple's code signature before installing. To stop the background
checks, turn off **Notify me when a new version is available** in
[Settings → About](../guide/settings.md#about); **Check for updates** still works.

Versions before 0.8 cannot update themselves: download 0.8 once from
[the releases page](https://github.com/FloSch62/muxus/releases), and later versions can
be installed from inside Muxus.

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
    extra permissions are required for SSH, Telnet or serial. The desktop app reads
    `SSH_AUTH_SOCK` from the login shell, so agents selected there (including 1Password
    and Secretive) work when Muxus is opened from Finder.

=== ":material-microsoft-windows: Windows"

    Serial ports use `COM` names such as `COM3`. Muxus reads `%USERPROFILE%\.ssh\config`
    and the OpenSSH agent when one is running.

## Your SSH setup

Muxus uses the existing SSH credentials and configuration on the machine:

| It reads | For |
| --- | --- |
| `~/.ssh/config` (and every `Include`) | Hosts, users, ports, keys, jump chains, forwards |
| `~/.ssh/known_hosts`, `/etc/ssh/ssh_known_hosts` | Host-key verification |
| `~/.ssh/*` key files | The key picker in the host editor |
| `SSH_AUTH_SOCK` | Default agent authentication and `ForwardAgent` |

!!! tip "No import step"

    If `ssh myhost` works in a terminal, Muxus resolves and dials the same host with the
    same key. The configuration is not imported into a database. See
    [ssh_config support](../reference/ssh-config.md) for the keywords that are honoured.

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
[Settings](../guide/settings.md). OpenSSH-backed settings still come from
`~/.ssh/config`; hosts saved as **Muxus app data only** live in this database.
Passwords you explicitly choose to remember are encrypted in the application database by
the password vault. The raw vault key is never stored in this directory; the default
never-prompt policy uses the OS credential store. See the
[security model](../reference/security.md).

Uninstalling the app leaves `~/.ssh` untouched.

After installation, continue with the [Quickstart](../quickstart.md).
