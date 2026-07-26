---
icon: lucide/terminal-square
---

# Command-line flags

The server is `server/dist/index.js`, started by `pnpm start` or embedded in the desktop
app. It always binds `127.0.0.1`.

```bash
node server/dist/index.js [--port <n>] [--no-open] [--history-path <dir>]
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
| `MUXUS_HISTORY_PATH` | Same as `--history-path`; the flag wins. |
| `MUXUS_DEV=1` | Development mode: the API token is the fixed string `dev` instead of a random one. Only honoured when `NODE_ENV` is not `production`. |
| `XDG_DATA_HOME` | Linux: where the application database lives (`$XDG_DATA_HOME/muxus/`). |
| `APPDATA` | Windows: same role (`%APPDATA%\Muxus\`). |

!!! danger "`MUXUS_DEV=1` is for development only"

    It replaces the per-run random token with a well-known one. The server still listens on
    loopback only, but any process on the machine can then reach the API.

## Data locations

The standalone server and the desktop app keep separate databases, because the desktop
build uses Electron's per-app directory:

| Platform | `pnpm start` (server) | Desktop app |
| --- | --- | --- |
| Linux | `$XDG_DATA_HOME/muxus/muxus.sqlite3` (default `~/.local/share/muxus/`) | `~/.config/Muxus/muxus.sqlite3` |
| macOS | `~/Library/Application Support/Muxus/muxus.sqlite3` | `~/Library/Application Support/Muxus/muxus.sqlite3` |
| Windows | `%APPDATA%\Muxus\muxus.sqlite3` | `%APPDATA%\Muxus\muxus.sqlite3` |

Connection settings are not stored there; they remain in `~/.ssh/config`. Moving between
the two builds is done with [backup and restore](../guide/settings.md#backup-data).

## Workspace scripts

From a source checkout:

| Command | What it does |
| --- | --- |
| `pnpm dev` | shared `tsc --watch` + server on `:3002` + Vite client on `:5174` |
| `pnpm build` | Build every package |
| `pnpm start` | Serve the built client from the server |
| `pnpm electron` | Run the desktop shell in dev |
| `pnpm test` | vitest unit tests |
| `pnpm lint` | oxlint |
| `pnpm typecheck` | Types across the workspace |
| `make deb`, `make win`, `make dmg`, `make all` | Desktop installers via electron-builder |

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
node hack/demo-env.mjs     # a sandbox: fake HOME, invented hosts, in-process sshds
node hack/capture.mjs      # light theme
THEME=dark node hack/capture.mjs
node hack/record.mjs       # the landing-page tour, as an mp4 (needs ffmpeg)
```

`hack/demo-env.mjs` builds a throwaway home directory under `/tmp`, generates keys, and
starts a small SSH server per demo host, so every screenshot shows a real session against
hosts that do not exist.
