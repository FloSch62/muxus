---
icon: lucide/monitor
---

# Desktop app

The desktop build is one Go executable wrapped by Wails v3. It uses WebView2
on Windows, WKWebView on macOS and WebKitGTK on Linux. The React UI is the
same build used by browser mode.

## Download

Portable archives are published on the
**[releases page](https://github.com/FloSch62/muxus/releases)**:

| Platform | File |
| --- | --- |
| :material-microsoft-windows: Windows | `muxus-v<version>-windows-<arch>.zip` |
| :material-apple: macOS | `muxus-v<version>-macos-<arch>.zip` |
| :material-linux: Linux | `muxus_<version>_<arch>.deb` or `muxus-v<version>-linux-<arch>.tar.gz` |

The uncompressed application executable is capped at 30 MB during packaging.
Node.js and a bundled Chromium are not required.

## Install and launch

=== ":material-microsoft-windows: Windows"

    Extract the archive and run `muxus.exe`.

    Muxus uses the installed Microsoft Edge WebView2 runtime. Current Windows
    releases normally include it. Builds are not code-signed yet, so
    SmartScreen may require **More info → Run anyway**.

=== ":material-apple: macOS"

    Extract `Muxus.app`, move it to **Applications**, then launch it.

    Builds are ad-hoc signed but not notarised. On first launch, right-click
    the app and choose **Open**, or clear quarantine:

    ```bash
    xattr -dr com.apple.quarantine /Applications/Muxus.app
    ```

=== ":material-linux: Linux"

    On Debian or Ubuntu, install the `.deb`; APT also installs the GTK 3 and
    WebKitGTK 4.1 runtime dependencies:

    ```bash
    sudo apt install ./muxus_*_*.deb
    muxus
    ```

    For other distributions, install GTK 3 and WebKitGTK 4.1, then use the
    portable archive:

    ```bash
    tar -xzf muxus-v*-linux-*.tar.gz
    chmod +x muxus
    ./muxus
    ```

    The Debian package accepts both the current `libgtk-3-0t64` name and the
    older `libgtk-3-0` name.

## What desktop mode adds

- A frameless native window whose web toolbar is the drag region and titlebar
- Native macOS menu, keyboard chords, file picker and window controls
- Secondary terminal and SFTP windows sharing live SSH transports
- Single-instance focus and ordered shutdown
- Stable `client-state.json` storage despite the random localhost port

Local PTY and serial support are implemented in Go and use the operating
system directly.

## Where your data lives

The Wails cutover deliberately keeps the previous desktop data paths:

| Platform | Application database |
| --- | --- |
| :material-microsoft-windows: Windows | `%APPDATA%\Muxus\muxus.sqlite3` |
| :material-apple: macOS | `~/Library/Application Support/Muxus/muxus.sqlite3` |
| :material-linux: Linux | `$XDG_CONFIG_HOME/Muxus/muxus.sqlite3` (default `~/.config/Muxus/`) |

`client-state.json` and `window-state.json` stay in the same directory.
Session history is stored alongside it or at the location selected in
Settings. SSH configuration and keys remain in `~/.ssh`.
