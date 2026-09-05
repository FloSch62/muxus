---
icon: lucide/monitor
---

# Desktop app

The desktop build wraps the Muxus server and UI in a native window. The server runs
in-process in Bun on a random localhost port, the window is frameless with the top bar serving as
the titlebar, and its size and position persist between launches.

## Download

Installers are published on the
**[releases page](https://github.com/FloSch62/muxus/releases)**:

| Platform | File |
| --- | --- |
| :material-microsoft-windows: Windows x64 / ARM64 | `win-x64-Muxus-Setup.zip` / `win-arm64-Muxus-Setup.zip` |
| :material-apple: macOS (Apple Silicon) | `macos-arm64-Muxus.dmg` |
| :material-linux: Linux x64 | `linux-x64-Muxus-Setup.tar.gz` or `muxus-<version>-linux-x64.deb` |

The UI uses the operating system's webview: WebView2 on Windows, WKWebView on macOS,
and WebKitGTK 4.1 on Linux. These packages replace the previous Electron installers;
Intel macOS packages are no longer built.

## Install & launch

=== ":material-microsoft-windows: Windows"

    1. Extract the archive matching your machine and run `installer.exe`.
    2. Follow the installer prompts.
    3. Launch **Muxus** from the Start menu.

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

    The `.deb` installs the required system libraries automatically. For the archive,
    install GTK 3, WebKitGTK 4.1, Ayatana AppIndicator, libsecret, fontconfig and xdg-utils
    through your distribution first.

    === "Installer archive"

        ```bash
        mkdir muxus-setup
        tar -xzf linux-x64-Muxus-Setup.tar.gz -C muxus-setup
        ./muxus-setup/installer
        ```

    === "Debian / Ubuntu (.deb)"

        ```bash
        sudo apt install ./muxus-*-linux-x64.deb
        muxus
        ```

    === "Verify the download"

        Each release includes a signed `SHA256SUMS-linux.txt` manifest covering the
        Linux installers and update payload. Download these additional files from the same release:

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
- **Local shells and serial access.** Bun provides the PTY; the packaged serial binding
  handles COM/TTY consoles, including hardware and software flow control.
- **A hardened shell.** The renderer receives its bootstrap credentials through a typed
  preload RPC bridge instead of the URL, and unexpected navigation is blocked. See the
  [security model](../reference/security.md).
- **Extra windows.** The file browser and any tab can be moved into their own window, which
  reuses the same in-process server and the same live SSH transports.

## Where your data lives

The desktop app keeps the same data directories as previous releases, so existing
databases, preferences, workspaces and password-vault identifiers are retained:

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
