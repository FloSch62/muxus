---
icon: lucide/terminal
---

# From source

Muxus is a pnpm workspace of TypeScript packages. Running it from source gives you the
same UI in your browser, served by a local Fastify server.

## Requirements

- **Node.js ≥ 24.17** (the CI builds on 24.18)
- **pnpm** (the repository pins its version through `packageManager`)
- A C/C++ toolchain for the two native modules (`node-pty`, `serialport`) — on Debian and
  Ubuntu `build-essential` and `python3` are enough

## Build and run

```bash
git clone https://github.com/FloSch62/muxus.git
cd muxus
pnpm install
pnpm build
pnpm start
```

`pnpm start` serves the built client from the server and opens your browser. The server
binds `127.0.0.1` only and mints a **random bearer token for that run**; the browser
receives it in the URL fragment, which the client removes immediately.

!!! warning "Not a shared service"

    Muxus is a single-user local tool, not a hosted terminal. Do not put it behind a
    reverse proxy or expose the port. See the
    [security model](../reference/security.md).

## Development mode

```bash
pnpm dev        # shared tsc --watch + server on :3002 + Vite client on :5174
```

Open <http://localhost:5174>. In dev the token is the fixed string `dev` (the Vite client
cannot learn a random one at startup); the server still listens on loopback only.

```bash
pnpm build      # build every package
pnpm start      # serve the built client from the server
pnpm electron   # run the desktop shell in dev
pnpm test       # vitest unit tests
pnpm lint       # oxlint
pnpm typecheck
```

!!! note "Native modules and Electron"

    `pnpm electron` runs against Electron's ABI, so the native bindings have to be
    rebuilt for it once:

    ```bash
    pnpm --filter @muxus/electron rebuild
    ```

## Desktop installers

```bash
make deb    # Linux .deb
make win    # Windows NSIS installer
make dmg    # macOS .dmg
make all    # everything electron-builder is configured for
```

Artifacts land in `electron/release/`.

## Command-line flags

| Flag | Meaning |
| --- | --- |
| `--port <n>` | Port to bind on `127.0.0.1` (default `3002`, or `$PORT`) |
| `--no-open` | Do not open a browser on start (also `MUXUS_NO_OPEN=1`) |
| `--history-path <dir>` | Where session history is written (also `MUXUS_HISTORY_PATH`) |

The full list, including environment variables, is in the
[command-line reference](../reference/cli.md).
