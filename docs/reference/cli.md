---
icon: lucide/terminal-square
---

# Command-line flags

Running `muxus` with no subcommand launches the Wails desktop shell. Browser
mode is explicit and always binds `127.0.0.1`:

```bash
muxus
muxus serve [--port <n>] [--no-open] [--history-path <dir>]
```

| Flag | Mode | Default | Meaning |
| --- | --- | --- | --- |
| `--port <n>` | `serve` | `3002` | Port on `127.0.0.1`; must be 1–65535. |
| `--no-open` | `serve` | off | Do not open a browser after starting. |
| `--history-path <dir>` | both | platform data dir | Session-history segments and FTS index. |
| `--static-root <dir>` | desktop | embedded client | Development override for client assets. |

Flags accept both `--port 3010` and `--port=3010`.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `PORT` | Browser-mode port; the flag wins. |
| `MUXUS_NO_OPEN=1` | Same as `--no-open`. |
| `MUXUS_HISTORY_PATH` | Same as `--history-path`; the flag wins. |
| `MUXUS_STATIC_ROOT` | Desktop development asset override. |
| `MUXUS_DEV=1` | Browser development uses the fixed API token `dev`; desktop also enables readable logs. |
| `XDG_DATA_HOME` | Linux browser-mode application data root. |
| `XDG_CONFIG_HOME` | Linux desktop data root, preserving the former desktop location. |
| `APPDATA` | Windows application data root. |

!!! danger "`MUXUS_DEV=1` is for development only"

    It replaces browser mode's random token with a well-known one. The server
    remains loopback-only, but any local process can then reach its API.

## Data locations

The historical browser and desktop locations remain distinct on Linux so
existing installations open the same data without migration:

| Platform | `muxus serve` | Desktop |
| --- | --- | --- |
| Linux | `$XDG_DATA_HOME/muxus/muxus.sqlite3` (default `~/.local/share/muxus/`) | `$XDG_CONFIG_HOME/Muxus/muxus.sqlite3` (default `~/.config/Muxus/`) |
| macOS | `~/Library/Application Support/Muxus/muxus.sqlite3` | same |
| Windows | `%APPDATA%\Muxus\muxus.sqlite3` | same |

Desktop `client-state.json` and `window-state.json` stay beside its database.
Connection settings remain in `~/.ssh/config`.

## Workspace scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Go server on `:3002`, Vite on `:5174`, shared watcher |
| `pnpm start` | Run browser mode from source |
| `pnpm desktop` | Run the Wails desktop shell from source |
| `pnpm build` | Produce the embedded single binary |
| `pnpm package` | Produce the current platform's release packages |
| `pnpm test`, `pnpm test:go` | TypeScript and Go suites |
| `pnpm lint`, `pnpm typecheck` | Static checks |

## Documentation tooling

| Command | What it does |
| --- | --- |
| `pnpm serve-docs` | Preview on <http://localhost:8000> |
| `pnpm build-docs` | Write `site/` |
| `pnpm capture-docs` | Regenerate screenshots in both themes |
| `pnpm record-docs` | Re-record the animated tour |
