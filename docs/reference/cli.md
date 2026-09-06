---
icon: lucide/terminal-square
---

# Command-line flags

## Desktop launch targets

The desktop executable can open a saved host, a folder of hosts, or a workspace directly:

```bash
muxus --host edge-router
muxus --folder "Production/EU"
muxus --workspace "Night shift"
```

Names are matched case-insensitively. A host accepts an OpenSSH alias, a saved-host name or
ID, or an unambiguous display name. A folder accepts its full path, an unambiguous leaf
name, or an `ssh_config` file-group label or filename. Folder launches use tabs and replace
the current pane layout, matching the sidebar's default **Launch hosts** action. A workspace
accepts its name or ID.

Only one launch target may be supplied at a time. If Muxus is already running, the new
invocation is forwarded to its existing process. A workspace that is not already open uses
a new window, preserving live sessions in the current one. Windows installations are not
added to `PATH`; AutoHotkey, Stream Deck, PowerShell, and shortcuts can invoke `bin\launcher.exe`
by its full installation path.

Flags accept both `--host edge-router` and `--host=edge-router`.

## Server flags

The server is `server/dist/index.js`, started by `pnpm start` or embedded in the desktop
app. It always binds `127.0.0.1`.

```bash
pnpm exec bun server/dist/index.js [--port <n>] [--no-open] [--history-path <dir>]
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--port <n>` | `3002` | Port on `127.0.0.1`. Must be 1-65535. |
| `--no-open` | off | Do not open a browser after starting. |
| `--history-path <dir>` | platform data dir | Where [session history](../guide/session-history.md) segments and index are written. Also settable in Settings. |

Flags accept both `--port 3010` and `--port=3010`.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `PORT` | Same as `--port`; the flag wins. |
| `MUXUS_NO_OPEN=1` | Same as `--no-open`. |
| `MUXUS_DESKTOP_DATA` | Override the desktop data directory, including history; useful for isolated testing. |
| `MUXUS_SSH_CONFIG` | Override the root OpenSSH configuration file (default `~/.ssh/config`). |
| `MUXUS_HISTORY_PATH` | Same as `--history-path`; the flag wins. |
| `MUXUS_DEV=1` | Development mode: the API token is the fixed string `dev` instead of a random one. Only honoured when `NODE_ENV` is not `production`. |
| `XDG_DATA_HOME` | Linux: where the application database lives (`$XDG_DATA_HOME/muxus/`). |
| `APPDATA` | Windows: same role (`%APPDATA%\Muxus\`). |

!!! danger "`MUXUS_DEV=1` is for development only"

    It replaces the per-run random token with a well-known one. The server still listens on
    loopback only, but any process on the machine can then reach the API.

## Data locations

The standalone server and the desktop app keep separate databases, because the desktop
build preserves its established per-app directory:

| Platform | `pnpm start` (server) | Desktop app |
| --- | --- | --- |
| Linux | `$XDG_DATA_HOME/muxus/muxus.sqlite3` (default `~/.local/share/muxus/`) | `~/.config/Muxus/muxus.sqlite3` |
| macOS | `~/Library/Application Support/Muxus/muxus.sqlite3` | `~/Library/Application Support/Muxus/muxus.sqlite3` |
| Windows | `%APPDATA%\Muxus\muxus.sqlite3` | `%APPDATA%\Muxus\muxus.sqlite3` |

Muxus-only SSH, Telnet and serial connection settings are stored there; OpenSSH-backed
hosts remain in `~/.ssh/config`. Moving between the two builds is done with
[backup and restore](../guide/settings.md#backup-data).

## Workspace scripts

From a source checkout:

| Command | What it does |
| --- | --- |
| `pnpm dev` | shared `tsc --watch` + server on `:3002` + Vite client on `:5174` |
| `pnpm build` | Build every package |
| `pnpm start` | Serve the built client from the server |
| `pnpm desktop` | Run the desktop shell in dev |
| `pnpm test` | vitest unit tests |
| `pnpm lint` | oxlint |
| `pnpm typecheck` | Types across the workspace |
| `make deb`, `make win`, `make dmg`, `make all` | Desktop installers via Electrobun (build on the target platform) |

## Documentation tooling

The docs in this site are built with [Zensical](https://zensical.org):

| Command | What it does |
| --- | --- |
| `pnpm serve-docs` | Live preview on <http://localhost:8000>, opens a browser |
| `pnpm build-docs` | Writes the static site to `site/` |
| `pnpm capture-docs` | Regenerates every screenshot, light and dark |
| `pnpm record-docs` | Re-records the animated tour on the landing page |

Screenshots are generated rather than taken by hand:

```bash
pnpm build
pnpm exec bun hack/demo-env.mjs     # a sandbox: fake HOME, invented hosts, in-process sshds
pnpm exec bun hack/capture.mjs      # light theme
THEME=dark pnpm exec bun hack/capture.mjs
pnpm exec bun hack/record.mjs       # the landing-page tour, as an mp4 (needs ffmpeg)
```

`hack/demo-env.mjs` builds a throwaway home directory under `/tmp`, generates keys, and
starts a small SSH server per demo host, so every screenshot shows a real session against
hosts that do not exist.
